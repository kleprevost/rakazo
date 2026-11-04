import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AdapterContext, BackgroundJob, JobPublisher } from "@rakazo/adapter-kit";
import type { PrismaClient, ThreadEvents } from "@rakazo/db";
import { asSystem, createDb, installSecurityEventStore, runAsTenant } from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { provisionComputer } from "./computer-lifecycle.js";
import { FakeSandboxProvider } from "./fake-sandbox.js";
import {
  createFleetOperation,
  FLEET_MAX_ATTEMPTS,
  reconcileFleetOperations,
  runFleetItem,
} from "./fleet-operations.js";
import { LocalAgentHomeStore } from "./home.js";

const url = process.env.DATABASE_URL;
const describePostgres =
  process.env.VERIFY_DATABASE === "1" && url ? describe.sequential : describe.skip;

/** Counts stops in flight, so the tests can see how many items ran at once. */
class GatedSandbox extends FakeSandboxProvider {
  stops = 0;
  inFlight = 0;
  peak = 0;
  override async stop(...args: Parameters<FakeSandboxProvider["stop"]>) {
    this.stops += 1;
    this.inFlight += 1;
    this.peak = Math.max(this.peak, this.inFlight);
    await new Promise((resolve) => setTimeout(resolve, 25));
    try {
      return await super.stop(...args);
    } finally {
      this.inFlight -= 1;
    }
  }
}

describePostgres("fleet operations (PostgreSQL)", () => {
  const stamp = randomUUID();
  let db: ReturnType<typeof createDb>;
  let system: PrismaClient;
  let dataDir: string;
  let sequence = 0;
  const sandbox = new GatedSandbox();
  const published: BackgroundJob[] = [];
  const jobs = {
    enqueue: vi.fn(async (job: BackgroundJob) => {
      published.push(job);
    }),
    cancel: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
  } as unknown as JobPublisher;
  let deps: {
    prisma: PrismaClient;
    sandbox: GatedSandbox;
    home: LocalAgentHomeStore;
    jobs: JobPublisher;
    events: ThreadEvents;
    dataDir: string;
  };
  let actor: string;
  let space: string;

  beforeAll(async () => {
    db = createDb(url!);
    system = asSystem(db.prisma);
    installSecurityEventStore(db.prisma);
    dataDir = await mkdtemp(path.join(tmpdir(), "rakazo-fleet-ops-"));
    deps = {
      prisma: db.prisma,
      sandbox,
      home: new LocalAgentHomeStore(dataDir),
      jobs,
      events: { append: vi.fn().mockResolvedValue({}) } as unknown as ThreadEvents,
      dataDir,
    };
    actor = `${stamp}-actor`;
    space = `${stamp}-space`;
    await system.user.create({
      data: {
        id: actor,
        name: "Fleet Admin",
        email: `${actor}@example.test`,
        emailVerified: false,
      },
    });
    await system.organization.create({
      data: { id: space, name: "Fleet", slug: space, createdAt: new Date() },
    });
    await system.space.create({ data: { id: space, organizationId: space, name: "Fleet" } });
  });

  afterAll(async () => {
    installSecurityEventStore(undefined);
    if (db) {
      await system.computerFleetOperation.deleteMany({ where: { actorUserId: actor } });
      await system.securityEvent.deleteMany({ where: { userId: actor } });
      await system.organization.deleteMany({ where: { id: space } });
      await system.user.deleteMany({ where: { id: actor } });
      await db.prisma.$disconnect();
      await db.pool.end();
    }
    if (dataDir) await rm(dataDir, { recursive: true, force: true });
  });

  /** A computer with one bot; `running` starts it on the fake provider. */
  async function computer(
    state: "running" | "suspended" | "error",
    options: { kind?: string } = {},
  ) {
    sequence += 1;
    const id = `${stamp}-c${sequence}`;
    await system.computer.create({
      data: {
        id,
        spaceId: space,
        userId: actor,
        scopeKey: id,
        homeKey: id,
        kind: options.kind ?? "fake",
        ...(state === "error" ? { state: "error", providerRef: id } : {}),
      },
    });
    const bot = await system.bot.create({
      data: {
        spaceId: space,
        userId: actor,
        name: `Bot ${sequence}`,
        color: "ink",
        computerId: id,
        thread: { create: { spaceId: space, userId: actor } },
      },
      include: { thread: true },
    });
    const context: AdapterContext = {
      operationId: "fleet-test",
      traceId: "fleet-test",
      spaceId: space,
      userId: actor,
      botId: bot.id,
      signal: new AbortController().signal,
    };
    if (state !== "error" && !options.kind) {
      await runAsTenant({ spaceId: space, userId: actor }, () =>
        provisionComputer(deps, id, context),
      );
      if (state === "suspended")
        await system.computer.update({ where: { id }, data: { state: "suspended" } });
    }
    return { id, bot };
  }

  const state = async (id: string) =>
    (await system.computer.findUniqueOrThrow({ where: { id } })).state;
  const items = (operationId: string) =>
    system.computerFleetItem.findMany({ where: { operationId }, orderBy: { createdAt: "asc" } });
  const operation = (id: string) =>
    system.computerFleetOperation.findUniqueOrThrow({ where: { id } });

  /** Plays the job queue: runs every published item job, all at once per round, until none is left. */
  async function drain() {
    for (let done = 0; ; ) {
      const batch = published.splice(0).filter((job) => job.name === "computer.fleet-item");
      if (batch.length === 0) return done;
      done += batch.length;
      await Promise.all(batch.map((job) => runFleetItem(deps, job.payload.itemId)));
    }
  }
  const create = (
    kind: "hibernate" | "wake",
    computerIds: string[],
    options: { maxParallel?: number; haltAfterFailures?: number } = {},
  ) => createFleetOperation(deps, { actorUserId: actor, kind, computerIds, ...options });
  const events = (type: string) =>
    system.securityEvent.findMany({ where: { userId: actor, type } });

  it("hibernates idle computers, saves nothing twice and finishes the operation with audit events", async () => {
    published.length = 0;
    const a = await computer("running");
    const b = await computer("suspended");
    const stopsBefore = sandbox.stops;
    const { id } = await create("hibernate", [a.id, b.id]);
    await drain();

    expect(await state(a.id)).toBe("suspended");
    expect(sandbox.stops - stopsBefore).toBe(1);
    expect((await items(id)).map((item) => [item.status, item.outcome])).toEqual([
      ["succeeded", "hibernated"],
      ["succeeded", "already_hibernated"],
    ]);
    expect(await operation(id)).toMatchObject({
      status: "completed",
      finishedAt: expect.any(Date),
    });
    const created = await events("computer.fleet.operation.created");
    expect(
      created.some((event) => (event.metadata as { operationId: string }).operationId === id),
    ).toBe(true);
    const hibernated = await events("computer.hibernated");
    expect(
      hibernated.filter((event) => (event.metadata as { computerId: string }).computerId === a.id),
    ).toHaveLength(1);
    expect(
      hibernated.some((event) => (event.metadata as { computerId: string }).computerId === b.id),
    ).toBe(false);
    expect(
      (await events("computer.fleet.item.succeeded")).filter(
        (event) => (event.metadata as { operationId: string }).operationId === id,
      ),
    ).toHaveLength(2);
    const completed = await events("computer.fleet.operation.completed");
    expect(
      completed.filter((event) => (event.metadata as { operationId: string }).operationId === id),
    ).toHaveLength(1);
  });

  it("wakes a hibernated computer and leaves a running one alone", async () => {
    published.length = 0;
    const asleep = await computer("suspended");
    const up = await computer("running");
    const { id } = await create("wake", [asleep.id, up.id]);
    await drain();
    expect(await state(asleep.id)).toBe("running");
    expect((await items(id)).map((item) => item.outcome)).toEqual(["woken", "already_running"]);
    expect(
      (await events("computer.woken")).filter(
        (e) => (e.metadata as { computerId: string }).computerId === asleep.id,
      ),
    ).toHaveLength(1);
  });

  it("skips a computer that is busy and never stops it", async () => {
    published.length = 0;
    const busy = await computer("running");
    const task = await system.task.create({
      data: {
        spaceId: space,
        userId: actor,
        botId: busy.bot.id,
        threadId: busy.bot.thread!.id,
        prompt: "Work",
        status: "running",
      },
    });
    const run = await system.run.create({
      data: {
        spaceId: space,
        userId: actor,
        botId: busy.bot.id,
        threadId: busy.bot.thread!.id,
        taskId: task.id,
        status: "running",
        trigger: "user_message",
      },
    });
    await system.computerExecutionLease.create({
      data: {
        computerId: busy.id,
        botId: busy.bot.id,
        runId: run.id,
        fence: 1,
        expiresAt: new Date(Date.now() + 60 * 60_000),
      },
    });
    const stopsBefore = sandbox.stops;
    const { id } = await create("hibernate", [busy.id]);
    await drain();
    expect(await state(busy.id)).toBe("running");
    expect(sandbox.stops).toBe(stopsBefore);
    expect(await items(id)).toEqual([
      expect.objectContaining({ status: "skipped_busy", outcome: "busy" }),
    ]);
    expect(await operation(id)).toMatchObject({ status: "completed" });
  });

  it("reports a computer on a provider it cannot reach as unsupported, without acting", async () => {
    published.length = 0;
    const elsewhere = await computer("suspended", { kind: "other-provider" });
    const native = await computer("suspended", { kind: "desktop" });
    const { id } = await create("wake", [elsewhere.id, native.id]);
    await drain();
    expect((await items(id)).map((item) => [item.status, item.outcome])).toEqual([
      ["skipped_unsupported", "provider_unavailable"],
      ["skipped_unsupported", "provider_unsupported"],
    ]);
    expect(await state(elsewhere.id)).toBe("stopped");
    expect((await events("computer.fleet.item.skipped")).length).toBeGreaterThanOrEqual(2);
  });

  it("lets two workers race for one item and acts once", async () => {
    published.length = 0;
    const c = await computer("running");
    const stopsBefore = sandbox.stops;
    const { id } = await create("hibernate", [c.id]);
    const [item] = await items(id);
    await Promise.all([
      runFleetItem(deps, item!.id),
      runFleetItem(deps, item!.id),
      runFleetItem(deps, item!.id),
    ]);
    expect(sandbox.stops - stopsBefore).toBe(1);
    expect((await items(id))[0]).toMatchObject({ status: "succeeded", attempt: 1 });
    // A redelivery after the fact does nothing either.
    await runFleetItem(deps, item!.id);
    expect(sandbox.stops - stopsBefore).toBe(1);
    expect(
      (await events("computer.fleet.item.succeeded")).filter(
        (event) => (event.metadata as { operationId: string }).operationId === id,
      ),
    ).toHaveLength(1);
  });

  it("runs the first item alone, then never more than maxParallel at once", async () => {
    published.length = 0;
    const fleet = await Promise.all(Array.from({ length: 6 }, () => computer("running")));
    sandbox.peak = 0;
    const { id } = await create(
      "hibernate",
      fleet.map((c) => c.id),
      { maxParallel: 2 },
    );
    // Only the canary is started before it has finished.
    expect(published.filter((job) => job.name === "computer.fleet-item")).toHaveLength(1);
    await drain();
    expect(sandbox.peak).toBe(2);
    expect((await items(id)).every((item) => item.status === "succeeded")).toBe(true);
    expect(await operation(id)).toMatchObject({ status: "completed" });
  });

  it("claims distinct items for concurrent workers while the window has room", async () => {
    published.length = 0;
    const fleet = await Promise.all(Array.from({ length: 4 }, () => computer("running")));
    const { id } = await create(
      "hibernate",
      fleet.map((c) => c.id),
      { maxParallel: 4 },
    );
    await drain();
    // The window is wide open after the canary, so the rest started together.
    expect(sandbox.peak).toBeGreaterThanOrEqual(2);
    const finished = await items(id);
    expect(new Set(finished.map((item) => item.computerId)).size).toBe(4);
    expect(finished.every((item) => item.attempt === 1 && item.status === "succeeded")).toBe(true);
  });

  it("halts the rest after enough failures", async () => {
    published.length = 0;
    const fleet = await Promise.all(Array.from({ length: 5 }, () => computer("error")));
    const { id } = await create(
      "hibernate",
      fleet.map((c) => c.id),
      {
        maxParallel: 3,
        haltAfterFailures: 2,
      },
    );
    await drain();
    const finished = await items(id);
    const failed = finished.filter((item) => item.status === "failed");
    const halted = finished.filter((item) => item.status === "halted");
    expect(failed.length).toBeGreaterThanOrEqual(2);
    expect(halted.length).toBeGreaterThanOrEqual(1);
    expect(halted.every((item) => item.startedAt === null && item.outcome === "halted")).toBe(true);
    expect(finished.length).toBe(failed.length + halted.length);
    expect(await operation(id)).toMatchObject({ status: "completed_with_failures" });
  });

  it("does not let a second operation take a computer an unfinished item holds", async () => {
    published.length = 0;
    const c = await computer("running");
    const first = await create("hibernate", [c.id]);
    const second = await create("hibernate", [c.id]);
    expect(await items(second.id)).toEqual([
      expect.objectContaining({ status: "skipped_busy", outcome: "operation_in_progress" }),
    ]);
    expect(await operation(second.id)).toMatchObject({ status: "completed" });
    await drain();
    expect((await items(first.id))[0]?.status).toBe("succeeded");
    // Once the first has finished, the computer can be targeted again.
    const third = await create("wake", [c.id]);
    expect((await items(third.id))[0]?.status).toBe("queued");
    await drain();
  });

  it("puts an item back after its worker died, and gives up after repeated deaths", async () => {
    published.length = 0;
    const c = await computer("running");
    const { id } = await create("hibernate", [c.id]);
    const [item] = await items(id);
    const stopsBefore = sandbox.stops;
    // A worker claimed it, did the work and died before recording it.
    await sandbox.stop(
      { id: c.id, botId: c.id, kind: "fake", providerRef: c.id, fresh: false },
      {
        operationId: "x",
        traceId: "x",
        spaceId: space,
        userId: actor,
        signal: new AbortController().signal,
      },
    );
    await system.computer.update({ where: { id: c.id }, data: { state: "suspended" } });
    await system.computerFleetItem.update({
      where: { id: item!.id },
      data: {
        status: "running",
        claimId: "dead",
        claimExpiresAt: new Date(Date.now() - 1_000),
        attempt: 1,
        startedAt: new Date(),
      },
    });
    published.length = 0;
    await reconcileFleetOperations(deps);
    expect((await items(id))[0]?.status).toBe("queued");
    await drain();
    // The replay found it already hibernated and did not stop it again.
    expect((await items(id))[0]).toMatchObject({
      status: "succeeded",
      outcome: "already_hibernated",
    });
    expect(sandbox.stops - stopsBefore).toBe(1);

    const d = await computer("running");
    const worn = await create("hibernate", [d.id]);
    const [wornItem] = await items(worn.id);
    await system.computerFleetItem.update({
      where: { id: wornItem!.id },
      data: {
        status: "running",
        claimId: "dead",
        claimExpiresAt: new Date(Date.now() - 1_000),
        attempt: FLEET_MAX_ATTEMPTS,
        startedAt: new Date(),
      },
    });
    await reconcileFleetOperations(deps);
    expect((await items(worn.id))[0]).toMatchObject({ status: "interrupted" });
    expect(await operation(worn.id)).toMatchObject({ status: "completed_with_failures" });
    expect(await state(d.id)).toBe("running");
  });
});
