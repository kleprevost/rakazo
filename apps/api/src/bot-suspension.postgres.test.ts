import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@rakazo/db";
import {
  asSystem,
  createDb,
  createThreadEvents,
  installSecurityEventStore,
  provisionMessagingIdentity,
  runAsSystem,
} from "@rakazo/db";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { assertBotNotSuspended, resumeBot, suspendBot } from "./bot-suspension.js";

const databaseUrl = process.env.DATABASE_URL;
const enabled = process.env.VERIFY_DATABASE === "1" && Boolean(databaseUrl);

describe.skipIf(!enabled)("suspending an AI employee (PostgreSQL)", () => {
  let prisma: PrismaClient;
  let system: PrismaClient;
  let close: () => Promise<void>;
  let identity: Awaited<ReturnType<typeof provisionMessagingIdentity>>;
  let adminId: string;
  let adminEmail: string;
  const sandbox = {
    execute: vi.fn(async function* () {
      yield { type: "exit", code: 0 };
    }),
    releaseScreen: vi.fn().mockResolvedValue(undefined),
  };
  const cancel = vi.fn().mockResolvedValue(undefined);
  const deps = () =>
    ({
      prisma,
      events: createThreadEvents(prisma),
      jobs: { enqueue: vi.fn(), cancel },
      sandbox,
      env: { adminEmails: [adminEmail], ssoAdminEnabled: false },
      auth: { isSsoAdmin: async () => false },
    }) as unknown as Parameters<typeof suspendBot>[0];

  beforeAll(() => {
    const db = createDb(databaseUrl!);
    prisma = db.prisma;
    system = asSystem(prisma);
    installSecurityEventStore(prisma);
    close = async () => {
      installSecurityEventStore(undefined);
      await prisma.$disconnect();
      await db.pool.end();
    };
  });
  beforeEach(async () => {
    identity = await runAsSystem("test fixture", () =>
      provisionMessagingIdentity(
        prisma,
        { provider: "test", address: `suspend-${randomUUID()}` },
        { signupsEnabled: undefined, signupAllowlist: undefined },
      ),
    );
    adminId = `admin-${randomUUID()}`;
    adminEmail = `${adminId}@example.test`;
    await system.user.create({
      data: { id: adminId, name: "Admin", email: adminEmail, emailVerified: true },
    });
    cancel.mockClear();
    sandbox.releaseScreen.mockClear();
  });
  afterEach(async () => {
    await system.securityEvent.deleteMany({ where: { userId: adminId } });
    await system.messagingIdentity.deleteMany({ where: { userId: identity.userId } });
    await system.organization.deleteMany({ where: { id: identity.spaceId } });
    await system.user.deleteMany({ where: { id: { in: [identity.userId, adminId] } } });
  });
  afterAll(async () => {
    await close?.();
  });

  const work = async (status: string) => {
    const owner = {
      spaceId: identity.spaceId,
      botId: identity.botId,
      threadId: identity.threadId,
      userId: identity.userId,
    };
    const task = await system.task.create({ data: { ...owner, prompt: "work", status: "queued" } });
    return system.run.create({ data: { ...owner, taskId: task.id, status, trigger: "user" } });
  };
  const runStatus = async (id: string) =>
    (await system.run.findUniqueOrThrow({ where: { id } })).status;
  const bot = () => system.bot.findUniqueOrThrow({ where: { id: identity.botId } });

  it("stops running and queued work, releases the computer and records who did it", async () => {
    const running = await work("running");
    const queued = await work("queued");
    const done = await work("completed");
    const computer = await system.computer.create({
      data: {
        spaceId: identity.spaceId,
        userId: identity.userId,
        scopeKey: `suspend-${running.id}`,
        homeKey: `suspend-${running.id}`,
        kind: "fake",
        state: "running",
        providerRef: `ref-${running.id}`,
      },
    });
    await system.computerExecutionLease.create({
      data: {
        computerId: computer.id,
        botId: identity.botId,
        runId: running.id,
        fence: 2,
        expiresAt: new Date(Date.now() + 60_000),
      },
    });

    const result = await suspendBot(deps(), adminId, { botId: identity.botId, reason: "audit" });

    expect(result).toEqual({ cancelledRuns: 2 });
    expect(await runStatus(running.id)).toBe("cancelled");
    expect(await runStatus(queued.id)).toBe("cancelled");
    expect(await runStatus(done.id)).toBe("completed");
    expect(cancel).toHaveBeenCalledWith(expect.stringContaining(running.id));
    expect(sandbox.releaseScreen).toHaveBeenCalledWith(
      expect.objectContaining({ providerRef: `ref-${running.id}` }),
      expect.objectContaining({ runId: running.id }),
    );
    const row = await bot();
    expect(row.suspendedAt).toBeInstanceOf(Date);
    expect(row.suspendedByUserId).toBe(adminId);
    const events = await system.securityEvent.findMany({ where: { userId: adminId } });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "bot.suspended",
      spaceId: identity.spaceId,
      metadata: { botId: identity.botId, reason: "audit", cancelledRuns: 2 },
    });
  });

  it("is idempotent and keeps the first suspension time", async () => {
    await suspendBot(deps(), adminId, { botId: identity.botId });
    const first = (await bot()).suspendedAt;
    await suspendBot(deps(), adminId, { botId: identity.botId });
    expect((await bot()).suspendedAt).toEqual(first);
  });

  it("refuses a user's message while suspended and accepts it after resume", async () => {
    await suspendBot(deps(), adminId, { botId: identity.botId });
    await expect(
      runAsSystem("test", () => assertBotNotSuspended(prisma, identity.botId)),
    ).rejects.toMatchObject({ code: "FORBIDDEN", message: "Suspended by your organization" });

    await resumeBot(deps(), adminId, identity.botId);
    const row = await bot();
    expect([row.suspendedAt, row.suspendedByUserId]).toEqual([null, null]);
    await expect(
      runAsSystem("test", () => assertBotNotSuspended(prisma, identity.botId)),
    ).resolves.toBeUndefined();
    const types = (await system.securityEvent.findMany({ where: { userId: adminId } })).map(
      (event) => event.type,
    );
    expect(types.sort()).toEqual(["bot.resumed", "bot.suspended"]);
  });

  it("is admin only: the owner and other members get FORBIDDEN and nothing changes", async () => {
    const running = await work("running");
    const owner = deps();
    await expect(
      suspendBot(owner, identity.userId, { botId: identity.botId }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(await runStatus(running.id)).toBe("running");
    expect((await bot()).suspendedAt).toBeNull();

    await suspendBot(deps(), adminId, { botId: identity.botId });
    await expect(resumeBot(owner, identity.userId, identity.botId)).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    expect((await bot()).suspendedAt).not.toBeNull();
  });

  it("answers NOT_FOUND for an unknown bot", async () => {
    await expect(suspendBot(deps(), adminId, { botId: "missing" })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });

  it("added the columns as nullable, so the previous release keeps working", async () => {
    const columns = await system.$queryRaw<
      Array<{ column_name: string; is_nullable: string; column_default: string | null }>
    >`SELECT column_name, is_nullable, column_default FROM information_schema.columns
      WHERE table_name = 'bots' AND column_name IN ('suspendedAt', 'suspendedByUserId')
      ORDER BY column_name`;
    expect(columns).toEqual([
      { column_name: "suspendedAt", is_nullable: "YES", column_default: null },
      { column_name: "suspendedByUserId", is_nullable: "YES", column_default: null },
    ]);
  });
});
