import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AdapterContext, BackgroundJob, JobPublisher } from "@rakazo/adapter-kit";
import {
  acquireComputerExecutionLease,
  ComputerQuarantinedError,
  checkpointComputerWorkspace,
  createFleetOperation,
  FakeSandboxProvider,
  LocalAgentHomeStore,
  performComputerUpdate,
  provisionComputer,
  runFleetItem,
  setActivePolicy,
} from "@rakazo/adapters";
import type { PrismaClient, ThreadEvents } from "@rakazo/db";
import { asSystem, createDb, installSecurityEventStore, runAsTenant } from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { liftQuarantine, startQuarantine } from "./bot-quarantine.js";
import { containComputers, quarantineComputers, releaseComputers } from "./computer-quarantine.js";

const url = process.env.DATABASE_URL;
const describePostgres =
  process.env.VERIFY_DATABASE === "1" && url ? describe.sequential : describe.skip;

/** Records every network change and every teardown, so the tests can see what was and was not touched. */
class TrackingSandbox extends FakeSandboxProvider {
  destroys = 0;
  network: Array<{ id: string; isolated: boolean }> = [];
  override async destroy(...args: Parameters<FakeSandboxProvider["destroy"]>) {
    this.destroys += 1;
    return super.destroy(...args);
  }
  override async isolateNetwork(...args: Parameters<FakeSandboxProvider["isolateNetwork"]>) {
    this.network.push({ id: args[0].id, isolated: args[1] });
    return super.isolateNetwork(...args);
  }
}

/** A provider that cannot cut a network, like every provider but the Docker supervisor today. */
class NoIsolationSandbox extends TrackingSandbox {
  override describe() {
    const description = super.describe();
    const { networkIsolation: _removed, ...fleet } = description.capabilities.fleet;
    return {
      ...description,
      capabilities: { ...description.capabilities, fleet: { ...fleet, networkIsolation: false } },
    };
  }
}

describePostgres("computer quarantine (PostgreSQL)", () => {
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
  let actor: string;
  let outsider: string;
  let space: string;
  const base = () => ({
    prisma: db.prisma,
    events: {
      append: vi.fn().mockResolvedValue({}),
      notify: vi.fn().mockResolvedValue(undefined),
    } as unknown as ThreadEvents,
    jobs,
    sandbox: sandbox as unknown as FakeSandboxProvider,
    env: { adminEmails: [`${actor}@example.test`], ssoAdminEnabled: false },
    auth: { isSsoAdmin: async () => false },
  });
  const suspensionDeps = (provider: FakeSandboxProvider = sandbox) =>
    ({ ...base(), sandbox: provider }) as unknown as Parameters<typeof containComputers>[0];
  const fleetDeps = (provider: FakeSandboxProvider = sandbox) => ({
    prisma: db.prisma,
    sandbox: provider,
    home: new LocalAgentHomeStore(dataDir),
    jobs,
    events: base().events,
    dataDir,
    pollMs: 10,
  });

  beforeAll(async () => {
    db = createDb(url!);
    system = asSystem(db.prisma);
    installSecurityEventStore(db.prisma);
    dataDir = await mkdtemp(path.join(tmpdir(), "rakazo-computer-quarantine-"));
    actor = `${stamp}-actor`;
    outsider = `${stamp}-outsider`;
    space = `${stamp}-space`;
    await system.user.createMany({
      data: [
        { id: actor, name: "Admin", email: `${actor}@example.test`, emailVerified: true },
        { id: outsider, name: "Other", email: `${outsider}@example.test`, emailVerified: true },
      ],
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
      await system.quarantine.deleteMany({ where: { createdByUserId: actor } });
      await system.computerFleetOperation.deleteMany({ where: { actorUserId: actor } });
      await system.securityEvent.deleteMany({ where: { userId: actor } });
      await system.organization.deleteMany({ where: { id: space } });
      await system.user.deleteMany({ where: { id: { in: [actor, outsider] } } });
      await db.prisma.$disconnect();
      await db.pool.end();
    }
    if (dataDir) await rm(dataDir, { recursive: true, force: true });
  });

  const tenant = () => ({ spaceId: space, userId: actor });

  /** A running computer whose saved home holds a marker file, with one bot on it. */
  async function seeded(provider: FakeSandboxProvider = sandbox) {
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
      operationId: "quarantine-test",
      traceId: "quarantine-test",
      ...tenant(),
      botId: bot.id,
      signal: new AbortController().signal,
    };
    const deps = fleetDeps(provider);
    const ref = await runAsTenant(tenant(), () => provisionComputer(deps, id, context, "none"));
    await provider.writeFile(
      ref,
      { path: "marker.txt", content: new TextEncoder().encode("kept") },
      context,
    );
    const revision = await checkpointComputerWorkspace(deps.home, provider, id, ref, context);
    await system.computer.update({ where: { id }, data: { homeRevision: revision ?? "empty" } });
    return { id, bot, context, ref, deps };
  }

  const startRun = async (bot: { id: string; thread: { id: string } | null }) => {
    const owner = { spaceId: space, userId: actor, botId: bot.id, threadId: bot.thread!.id };
    const task = await system.task.create({
      data: { ...owner, prompt: "Work", status: "running" },
    });
    return system.run.create({
      data: { ...owner, taskId: task.id, status: "running", trigger: "user_message" },
    });
  };

  /** Plays the job queue: items and the computer updates they queue run side by side. */
  async function drain(provider: FakeSandboxProvider = sandbox) {
    const deps = fleetDeps(provider);
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
  const items = (operationId: string) =>
    system.computerFleetItem.findMany({ where: { operationId } });
  const events = (type: string, computerId: string) =>
    system.securityEvent
      .findMany({ where: { userId: actor, type } })
      .then((rows) =>
        rows.filter((row) => (row.metadata as { computerId?: string }).computerId === computerId),
      );
  const row = (id: string) => system.computer.findUniqueOrThrow({ where: { id } });

  it("contains an idle computer: flag, network cut, stopped with its home kept, refuses to start", async () => {
    published.length = 0;
    const { id, bot, context, ref } = await seeded();
    const destroysBefore = sandbox.destroys;

    const summary = await quarantineComputers(suspensionDeps(), actor, {
      computerIds: [id],
      reason: "incident",
    });
    expect(summary).toMatchObject({
      quarantined: 1,
      cancelledRuns: 0,
      networkIsolation: { applied: 1 },
    });
    expect(sandbox.network).toContainEqual({ id: ref.id, isolated: true });
    expect(await row(id)).toMatchObject({
      adminQuarantinedByUserId: actor,
      adminQuarantineReason: "incident",
      adminQuarantineId: null,
    });
    expect((await row(id)).adminQuarantinedAt).toBeInstanceOf(Date);

    await drain();
    const [item] = await items(summary.operationId!);
    expect(item).toMatchObject({ status: "succeeded", outcome: "terminated" });
    expect(sandbox.destroys - destroysBefore).toBe(1);
    expect(await row(id)).toMatchObject({ state: "stopped", providerRef: null });

    // Start, wake and any execution lease are refused while the flag stands.
    const deps = fleetDeps();
    await expect(
      runAsTenant(tenant(), () => provisionComputer(deps, id, context, "none")),
    ).rejects.toBeInstanceOf(ComputerQuarantinedError);
    await expect(
      runAsTenant(tenant(), () =>
        acquireComputerExecutionLease(db.prisma, { computerId: id, runId: "run", botId: bot.id }),
      ),
    ).rejects.toBeInstanceOf(ComputerQuarantinedError);

    const metadata = (await events("computer.quarantined", id))[0]?.metadata;
    expect(metadata).toMatchObject({
      networkIsolation: "applied",
      operationId: summary.operationId,
      reason: "incident",
    });

    // Release clears the flag and starts nothing; the next start finds the home as it was.
    expect(await releaseComputers(suspensionDeps(), actor, { computerIds: [id] })).toEqual({
      released: 1,
    });
    expect(await row(id)).toMatchObject({
      adminQuarantinedAt: null,
      adminQuarantinedByUserId: null,
      adminQuarantineReason: null,
      state: "stopped",
      providerRef: null,
    });
    expect((await events("computer.released", id)).length).toBe(1);
    const woken = await runAsTenant(tenant(), () => provisionComputer(deps, id, context, "none"));
    expect(new TextDecoder().decode(await sandbox.readFile(woken, "marker.txt", context))).toBe(
      "kept",
    );
  });

  it("cancels the runs of the bots on it and never revokes a personal connection", async () => {
    published.length = 0;
    const { id, bot } = await seeded();
    const run = await startRun(bot);
    const connection = await system.connection.create({
      data: {
        spaceId: space,
        userId: actor,
        provider: "test",
        displayName: "Personal",
        status: "active",
      },
    });
    try {
      const summary = await containComputers(suspensionDeps(), actor, [id]);
      expect(summary.cancelledRuns).toBe(1);
      expect((await system.run.findUniqueOrThrow({ where: { id: run.id } })).status).toBe(
        "cancelled",
      );
      expect(
        await system.connection.findUniqueOrThrow({ where: { id: connection.id } }),
      ).toMatchObject({ status: "active" });
      await drain();
      expect((await items(summary.operationId!))[0]?.status).toBe("succeeded");
    } finally {
      await system.connection.delete({ where: { id: connection.id } });
    }
  });

  it("never destroys a busy computer: it stays flagged, cut off and running until released", async () => {
    published.length = 0;
    const { id, ref } = await seeded();
    // A person is driving the screen: containing the computer must not take it from them by force.
    await system.computer.update({
      where: { id },
      data: {
        controlHolder: "user",
        controlLeaseId: randomUUID(),
        controlLeaseExpiresAt: new Date(Date.now() + 10 * 60_000),
      },
    });
    const destroysBefore = sandbox.destroys;
    const summary = await containComputers(suspensionDeps(), actor, [id]);
    await drain();
    expect(await items(summary.operationId!)).toEqual([
      expect.objectContaining({ status: "skipped_busy", outcome: "busy" }),
    ]);
    expect(sandbox.destroys).toBe(destroysBefore);
    expect(sandbox.boxes.get(ref.id)).toMatchObject({ running: true, isolated: true });
    expect(await row(id)).toMatchObject({ state: "running" });
    expect((await row(id)).adminQuarantinedAt).not.toBeNull();

    await releaseComputers(suspensionDeps(), actor, { computerIds: [id] });
    expect(sandbox.boxes.get(ref.id)).toMatchObject({ running: true, isolated: false });
    expect((await row(id)).adminQuarantinedAt).toBeNull();
    expect((await events("computer.released", id))[0]?.metadata).toMatchObject({
      networkIsolation: "applied",
    });
  });

  it("reports isolation unsupported where the provider cannot cut a network, and still stops it", async () => {
    published.length = 0;
    const plain = new NoIsolationSandbox();
    const { id } = await seeded(plain);
    const summary = await containComputers(suspensionDeps(plain), actor, [id]);
    expect(summary.networkIsolation).toEqual({ unsupported: 1 });
    expect(plain.network).toEqual([]);
    expect((await events("computer.quarantined", id))[0]?.metadata).toMatchObject({
      networkIsolation: "unsupported",
    });
    await drain(plain);
    expect((await items(summary.operationId!))[0]?.status).toBe("succeeded");
    expect(plain.boxes.size).toBe(0);
  });

  it("refuses wake and recreate fleet items on a quarantined computer", async () => {
    published.length = 0;
    const { id } = await seeded();
    await system.computer.update({ where: { id }, data: { adminQuarantinedAt: new Date() } });
    const deps = fleetDeps();
    for (const kind of ["wake", "recreate"] as const) {
      const { id: operationId } = await createFleetOperation(deps, {
        actorUserId: actor,
        kind,
        computerIds: [id],
      });
      await drain();
      expect(await items(operationId)).toEqual([
        expect.objectContaining({ status: "skipped_unsupported", outcome: "quarantined" }),
      ]);
    }
    expect(await row(id)).toMatchObject({ state: "running" });
  });

  it("is repeatable, audits once and needs an admin", async () => {
    published.length = 0;
    const { id } = await seeded();
    await containComputers(suspensionDeps(), actor, [id]);
    await drain();
    const again = await containComputers(suspensionDeps(), actor, [id]);
    expect(again.quarantined).toBe(0);
    expect(await events("computer.quarantined", id)).toHaveLength(1);
    await expect(
      quarantineComputers(suspensionDeps(), outsider, { computerIds: [id] }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      quarantineComputers(suspensionDeps(), actor, { computerIds: ["missing"] }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      releaseComputers(suspensionDeps(), outsider, { computerIds: [id] }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("contains the computers of a quarantined bot, releases them with it, and spares shared ones", async () => {
    published.length = 0;
    const alone = await seeded();
    const shared = await seeded();
    // A second bot outside the quarantine keeps using the shared computer.
    const neighbour = await system.bot.create({
      data: {
        spaceId: space,
        userId: actor,
        name: "Neighbour",
        color: "ink",
        computerId: shared.id,
        thread: { create: { spaceId: space, userId: actor } },
      },
    });
    const sharedBox = sandbox.boxes.get(shared.ref.id);

    const first = await startQuarantine(suspensionDeps(), actor, {
      scopeKind: "bot",
      scopeId: alone.bot.id,
    });
    const second = await startQuarantine(suspensionDeps(), actor, {
      scopeKind: "bot",
      scopeId: shared.bot.id,
    });
    expect(first.computers).toBe(1);
    expect(second.computers).toBe(0);
    await drain();
    expect(await row(alone.id)).toMatchObject({
      adminQuarantineId: first.id,
      state: "stopped",
      providerRef: null,
    });
    expect((await row(shared.id)).adminQuarantinedAt).toBeNull();
    expect(sandbox.boxes.get(shared.ref.id)).toBe(sharedBox);
    expect(sharedBox?.running).toBe(true);

    await liftQuarantine(suspensionDeps(), actor, first.id);
    await liftQuarantine(suspensionDeps(), actor, second.id);
    // Released, not restarted.
    expect(await row(alone.id)).toMatchObject({
      adminQuarantinedAt: null,
      adminQuarantineId: null,
      state: "stopped",
      providerRef: null,
    });
    await system.bot.delete({ where: { id: neighbour.id } });
  });

  it("keeps a computer an admin quarantined directly when the bot quarantine on it is lifted", async () => {
    published.length = 0;
    const { id, bot } = await seeded();
    const quarantine = await startQuarantine(suspensionDeps(), actor, {
      scopeKind: "bot",
      scopeId: bot.id,
    });
    expect((await row(id)).adminQuarantineId).toBe(quarantine.id);
    await drain();
    await containComputers(suspensionDeps(), actor, [id]);
    expect((await row(id)).adminQuarantineId).toBeNull();
    await liftQuarantine(suspensionDeps(), actor, quarantine.id);
    expect((await row(id)).adminQuarantinedAt).not.toBeNull();
  });
});
