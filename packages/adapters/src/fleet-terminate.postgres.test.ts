import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AdapterContext, BackgroundJob, JobPublisher } from "@rakazo/adapter-kit";
import type { PrismaClient, ThreadEvents } from "@rakazo/db";
import { asSystem, createDb, installSecurityEventStore, runAsTenant } from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { provisionComputer } from "./computer-lifecycle.js";
import { performComputerUpdate, queueComputerUpdate } from "./computer-update.js";
import { checkpointComputerWorkspace } from "./computer-workspace.js";
import { FakeSandboxProvider } from "./fake-sandbox.js";
import { createFleetOperation, runFleetItem } from "./fleet-operations.js";
import { LocalAgentHomeStore } from "./home.js";
import { setActivePolicy } from "./policy-runtime.js";

const url = process.env.DATABASE_URL;
const describePostgres =
  process.env.VERIFY_DATABASE === "1" && url ? describe.sequential : describe.skip;

/** Counts teardowns and can fail the home save, so the tests can see what was and was not touched. */
class TrackingSandbox extends FakeSandboxProvider {
  destroys = 0;
  failExport = false;
  override async destroy(...args: Parameters<FakeSandboxProvider["destroy"]>) {
    this.destroys += 1;
    return super.destroy(...args);
  }
  override exportWorkspace(...args: Parameters<FakeSandboxProvider["exportWorkspace"]>) {
    if (this.failExport) throw new Error("export failed");
    return super.exportWorkspace(...args);
  }
}

const digestA = `sha256:${"a".repeat(64)}`;
const imageA = { ref: `registry.example/computer@${digestA}`, digest: digestA };

describePostgres("fleet terminate (PostgreSQL)", () => {
  const stamp = randomUUID();
  let db: ReturnType<typeof createDb>;
  let system: PrismaClient;
  let dataDir: string;
  let sequence = 0;
  const sandbox = new TrackingSandbox();
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
    sandbox: TrackingSandbox;
    home: LocalAgentHomeStore;
    jobs: JobPublisher;
    events: ThreadEvents;
    dataDir: string;
    pollMs: number;
  };
  let actor: string;
  let space: string;

  beforeAll(async () => {
    db = createDb(url!);
    system = asSystem(db.prisma);
    installSecurityEventStore(db.prisma);
    dataDir = await mkdtemp(path.join(tmpdir(), "rakazo-fleet-terminate-"));
    deps = {
      prisma: db.prisma,
      sandbox,
      home: new LocalAgentHomeStore(dataDir),
      jobs,
      events: { append: vi.fn().mockResolvedValue({}) } as unknown as ThreadEvents,
      dataDir,
      pollMs: 10,
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
    setActivePolicy(undefined);
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

  const tenant = () => ({ spaceId: space, userId: actor });
  const allow = (...digests: string[]) =>
    setActivePolicy({
      version: 1,
      computers: { images: { allow: digests.map((digest) => ({ digest })) } },
    });

  /** A running computer on image A whose saved home holds a file and a browser profile. */
  async function seeded() {
    sequence += 1;
    const id = `${stamp}-c${sequence}`;
    await system.computer.create({
      data: { id, spaceId: space, userId: actor, scopeKey: id, homeKey: id, kind: "fake" },
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
      operationId: "terminate-test",
      traceId: "terminate-test",
      ...tenant(),
      botId: bot.id,
      signal: new AbortController().signal,
    };
    allow(digestA);
    const ref = await runAsTenant(tenant(), () =>
      provisionComputer(deps, id, context, "none", undefined, imageA),
    );
    const write = (file: string, text: string) =>
      sandbox.writeFile(ref, { path: file, content: new TextEncoder().encode(text) }, context);
    await write("marker.txt", "kept");
    await write(".browser-profiles/work/state.json", "{}");
    const revision = await checkpointComputerWorkspace(deps.home, sandbox, id, ref, context);
    await system.computer.update({ where: { id }, data: { homeRevision: revision ?? "empty" } });
    return { id, bot, context, ref };
  }

  /** Plays the job queue: items and the computer updates they queue run side by side. */
  async function drain() {
    const inflight = new Set<Promise<unknown>>();
    for (;;) {
      for (const job of published.splice(0)) {
        const work =
          job.name === "computer.fleet-item"
            ? runFleetItem(deps, job.payload.itemId)
            : job.name === "computer.update"
              ? runAsTenant(tenant(), () => performComputerUpdate(deps, job.payload.updateId))
              : undefined;
        if (!work) continue;
        const tracked = work.finally(() => inflight.delete(tracked));
        inflight.add(tracked);
      }
      if (inflight.size === 0 && published.length === 0) return;
      await Promise.race([...inflight, new Promise((resolve) => setTimeout(resolve, 20))]);
    }
  }
  const terminate = (computerIds: string[]) =>
    createFleetOperation(deps, { actorUserId: actor, kind: "terminate", computerIds });
  const items = (operationId: string) =>
    system.computerFleetItem.findMany({ where: { operationId } });
  const events = (type: string, computerId: string) =>
    system.securityEvent
      .findMany({ where: { userId: actor, type } })
      .then((rows) =>
        rows.filter((row) => (row.metadata as { computerId?: string }).computerId === computerId),
      );

  it("destroys the machine, keeps the home and brings it back on the next start", async () => {
    published.length = 0;
    const { id, bot, context, ref } = await seeded();
    const before = await system.computer.findUniqueOrThrow({ where: { id } });
    const oldBox = sandbox.boxes.get(ref.id);
    const destroysBefore = sandbox.destroys;

    const { id: operationId } = await terminate([id]);
    await drain();

    const [item] = await items(operationId);
    expect(item).toMatchObject({
      status: "succeeded",
      outcome: "terminated",
      homeRevisionBefore: before.homeRevision,
    });
    expect(item?.homeRevisionAfter).not.toBe("empty");
    expect(
      await system.computerFleetOperation.findUniqueOrThrow({ where: { id: operationId } }),
    ).toMatchObject({ status: "completed" });
    expect(sandbox.destroys - destroysBefore).toBe(1);
    expect(sandbox.boxes.has(ref.id)).toBe(false);
    expect(await system.computer.findUniqueOrThrow({ where: { id } })).toMatchObject({
      state: "stopped",
      providerRef: null,
      maintenanceId: null,
    });

    // The next start restores the saved home: the marker and the browser profile are back.
    const woken = await runAsTenant(tenant(), () =>
      provisionComputer(deps, id, { ...context, botId: bot.id }, "none", undefined, imageA),
    );
    expect(sandbox.boxes.get(woken.id)).not.toBe(oldBox);
    expect(new TextDecoder().decode(await sandbox.readFile(woken, "marker.txt", context))).toBe(
      "kept",
    );
    expect(
      (await sandbox.listFiles(woken, ".browser-profiles", context)).map((e) => e.path),
    ).toEqual([".browser-profiles/work"]);

    const terminated = await events("computer.terminated", id);
    expect(terminated).toHaveLength(1);
    expect(terminated[0]?.metadata).toMatchObject({
      operationId,
      homeRevisionBefore: before.homeRevision,
    });
    expect(await events("computer.fleet.item.succeeded", id)).toHaveLength(1);
  });

  it("destroys nothing when the home cannot be saved", async () => {
    published.length = 0;
    const { id, ref } = await seeded();
    const destroysBefore = sandbox.destroys;
    sandbox.failExport = true;
    try {
      const { id: operationId } = await terminate([id]);
      await drain();
      expect(await items(operationId)).toEqual([
        expect.objectContaining({ status: "failed", outcome: "failed_checkpoint" }),
      ]);
    } finally {
      sandbox.failExport = false;
    }
    expect(sandbox.destroys).toBe(destroysBefore);
    expect(sandbox.boxes.has(ref.id)).toBe(true);
    expect(await system.computer.findUniqueOrThrow({ where: { id } })).toMatchObject({
      state: "running",
      maintenanceId: null,
    });
    expect(await events("computer.terminated", id)).toHaveLength(0);
    expect(await events("computer.fleet.item.failed", id)).toHaveLength(1);
  });

  it("skips a busy computer and never touches it", async () => {
    published.length = 0;
    const { id, bot, ref } = await seeded();
    const task = await system.task.create({
      data: {
        spaceId: space,
        userId: actor,
        botId: bot.id,
        threadId: bot.thread!.id,
        prompt: "Work",
        status: "running",
      },
    });
    await system.run.create({
      data: {
        spaceId: space,
        userId: actor,
        botId: bot.id,
        threadId: bot.thread!.id,
        taskId: task.id,
        status: "running",
        trigger: "user_message",
      },
    });
    const destroysBefore = sandbox.destroys;
    const { id: operationId } = await terminate([id]);
    await drain();
    expect(await items(operationId)).toEqual([
      expect.objectContaining({ status: "skipped_busy", outcome: "busy" }),
    ]);
    expect(sandbox.destroys).toBe(destroysBefore);
    expect(sandbox.boxes.has(ref.id)).toBe(true);
    expect(await system.computerUpdate.count({ where: { computerId: id } })).toBe(0);
    expect(await system.run.count({ where: { botId: bot.id, status: "running" } })).toBe(1);
    expect(await events("computer.terminated", id)).toHaveLength(0);
    expect(await events("computer.fleet.item.skipped", id)).toHaveLength(1);
  });

  it("leaves a computer that is already stopped or hibernated alone", async () => {
    published.length = 0;
    const stopped = await seeded();
    await system.computer.update({
      where: { id: stopped.id },
      data: { state: "stopped", providerRef: null },
    });
    const hibernated = await seeded();
    await system.computer.update({ where: { id: hibernated.id }, data: { state: "suspended" } });
    const destroysBefore = sandbox.destroys;
    const { id: operationId } = await terminate([stopped.id, hibernated.id]);
    await drain();
    const byComputer = new Map((await items(operationId)).map((i) => [i.computerId, i]));
    expect(byComputer.get(stopped.id)).toMatchObject({
      status: "succeeded",
      outcome: "already_terminated",
    });
    expect(byComputer.get(hibernated.id)).toMatchObject({
      status: "skipped_unsupported",
      outcome: "not_running",
    });
    expect(sandbox.destroys).toBe(destroysBefore);
    expect(await events("computer.terminated", stopped.id)).toHaveLength(0);
  });

  it("follows the same update when an item is replayed instead of destroying twice", async () => {
    published.length = 0;
    const { id, bot } = await seeded();
    const destroysBefore = sandbox.destroys;
    const { id: operationId } = await terminate([id]);
    await drain();
    const [item] = await items(operationId);
    expect(item?.status).toBe("succeeded");
    expect(sandbox.destroys - destroysBefore).toBe(1);

    // A second claimant asking for the same key gets the first update back.
    const again = await runAsTenant(tenant(), () =>
      queueComputerUpdate(deps, id, bot.id, "update", {
        idempotencyKey: item!.id,
        stopOnly: true,
      }),
    );
    expect(again.id).toBe(item?.computerUpdateId);
    expect(await system.computerUpdate.count({ where: { computerId: id } })).toBe(1);

    // The worker died before it recorded the result: the item runs again and finds that update.
    await system.computerFleetItem.update({
      where: { id: item!.id },
      data: { status: "queued", finishedAt: null, claimId: null, claimExpiresAt: null },
    });
    await system.computerFleetOperation.update({
      where: { id: operationId },
      data: { status: "running", finishedAt: null },
    });
    await runFleetItem(deps, item!.id);
    expect(sandbox.destroys - destroysBefore).toBe(1);
    expect(await system.computerUpdate.count({ where: { computerId: id } })).toBe(1);
    expect((await items(operationId))[0]).toMatchObject({
      status: "succeeded",
      outcome: "terminated",
    });
  });

  it("refuses a second operation on a computer that already has one open", async () => {
    published.length = 0;
    const { id } = await seeded();
    const first = await terminate([id]);
    const second = await terminate([id]);
    expect(await items(second.id)).toEqual([
      expect.objectContaining({ status: "skipped_busy", outcome: "operation_in_progress" }),
    ]);
    await drain();
    expect((await items(first.id))[0]?.status).toBe("succeeded");
  });
});
