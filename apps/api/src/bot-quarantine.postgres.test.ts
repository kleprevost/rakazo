import { randomUUID } from "node:crypto";
import { botBlockedNow } from "@rakazo/adapters";
import type { PrismaClient } from "@rakazo/db";
import {
  activeQuarantineFor,
  asSystem,
  createDb,
  createThreadEvents,
  installSecurityEventStore,
  provisionMessagingIdentity,
  runAsSystem,
} from "@rakazo/db";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { liftQuarantine, listQuarantines, startQuarantine } from "./bot-quarantine.js";
import { assertBotNotSuspended } from "./bot-suspension.js";
import type * as ComputerQuarantine from "./computer-quarantine.js";
import { loadWebhookTarget } from "./webhook-inbound.js";

// A quarantine of every bot reaches every computer in the database, including the ones other test
// files are using at the same moment. These tests are about the bots, so keep containment to the
// fixture's own Space.
const own = vi.hoisted(() => ({ spaceId: "" }));
vi.mock("./computer-quarantine.js", async (importOriginal) => {
  const actual = await importOriginal<typeof ComputerQuarantine>();
  return {
    ...actual,
    computersCoveredBy: async (...args: Parameters<typeof actual.computersCoveredBy>) => {
      const ids = await actual.computersCoveredBy(...args);
      const mine = await runAsSystem("test: own computers", () =>
        args[0].prisma.computer.findMany({
          where: { id: { in: ids }, spaceId: own.spaceId },
          select: { id: true },
        }),
      );
      return mine.map((computer) => computer.id);
    },
  };
});

const databaseUrl = process.env.DATABASE_URL;
const enabled = process.env.VERIFY_DATABASE === "1" && Boolean(databaseUrl);

describe.skipIf(!enabled)("quarantining AI employees (PostgreSQL)", () => {
  let prisma: PrismaClient;
  let system: PrismaClient;
  let close: () => Promise<void>;
  let identity: Awaited<ReturnType<typeof provisionMessagingIdentity>>;
  let adminId: string;
  let adminEmail: string;
  const extraBots: string[] = [];
  const quarantineIds: string[] = [];
  const sandbox = {
    describe: () => ({ id: "fake", capabilities: {} }),
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
    }) as unknown as Parameters<typeof startQuarantine>[0];

  // The list is global and other files quarantine at the same time, so look only at this bot's.
  const ownQuarantines = async () =>
    (await listQuarantines(deps(), adminId)).quarantines.filter(
      (item) => item.scopeId === identity.botId,
    );

  const webhookDeps = () =>
    ({
      prisma,
      secrets: { load: async () => "hook-secret" },
    }) as unknown as Parameters<typeof loadWebhookTarget>[0];

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
        { provider: "test", address: `quarantine-${randomUUID()}` },
        { signupsEnabled: undefined, signupAllowlist: undefined },
      ),
    );
    own.spaceId = identity.spaceId;
    adminId = `admin-${randomUUID()}`;
    adminEmail = `${adminId}@example.test`;
    await system.user.create({
      data: { id: adminId, name: "Admin", email: adminEmail, emailVerified: true },
    });
    cancel.mockClear();
  });
  afterEach(async () => {
    // Quarantines are deleted below without being lifted, so the computers they contained would
    // stay flagged for every other test sharing this database.
    await system.computer.updateMany({
      where: { adminQuarantineId: { in: quarantineIds } },
      data: { adminQuarantinedAt: null, adminQuarantinedByUserId: null, adminQuarantineId: null },
    });
    await system.quarantine.deleteMany({
      where: { OR: [{ id: { in: quarantineIds } }, { createdByUserId: adminId }] },
    });
    quarantineIds.length = 0;
    await system.securityEvent.deleteMany({ where: { userId: adminId } });
    await system.chatGroup.deleteMany({ where: { spaceId: identity.spaceId } });
    await system.bot.deleteMany({ where: { id: { in: extraBots } } });
    extraBots.length = 0;
    await system.messagingIdentity.deleteMany({ where: { userId: identity.userId } });
    await system.organization.deleteMany({ where: { id: identity.spaceId } });
    await system.user.deleteMany({ where: { id: { in: [identity.userId, adminId] } } });
  });
  afterAll(async () => {
    await close?.();
  });

  const start = async (input: Parameters<typeof startQuarantine>[2]) => {
    const result = await startQuarantine(deps(), adminId, input);
    quarantineIds.push(result.id);
    return result;
  };
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
  const newBot = async () => {
    const bot = await system.bot.create({
      data: { spaceId: identity.spaceId, userId: identity.userId, name: "Second", color: "blue" },
    });
    extraBots.push(bot.id);
    return bot;
  };
  const blocked = (botId: string) => runAsSystem("test", () => botBlockedNow(prisma, botId));

  it("stops a bot mid-assignment, blocks all use of its credentials and restores them on release", async () => {
    const running = await work("running");
    const queued = await work("queued");
    const server = await system.mcpServer.create({
      data: {
        spaceId: identity.spaceId,
        userId: identity.userId,
        slug: `srv-${randomUUID().slice(0, 8)}`,
        name: "Personal server",
        transport: "http",
        endpoint: "https://mcp.example.test",
      },
    });
    await system.botMcpServer.create({
      data: {
        spaceId: identity.spaceId,
        botId: identity.botId,
        serverId: server.id,
        userId: identity.userId,
      },
    });
    await system.botSecret.create({
      data: {
        id: randomUUID(),
        userId: identity.userId,
        spaceId: identity.spaceId,
        botId: identity.botId,
        name: "TOKEN",
        origin: "https://api.example.test",
        auth: {},
        ciphertext: "secret-ciphertext",
      },
    });
    const vault = await system.vaultCredential.create({
      data: {
        id: randomUUID(),
        userId: identity.userId,
        spaceId: identity.spaceId,
        name: "personal",
        origin: "https://login.example.test",
        auth: {},
        ciphertext: "secret-ciphertext",
      },
    });
    const webhook = await system.secret.create({
      data: {
        userId: identity.userId,
        spaceId: identity.spaceId,
        kind: "webhook",
        ciphertext: "cipher",
      },
    });
    await system.bot.update({
      where: { id: identity.botId },
      data: { webhookSecretId: webhook.id },
    });
    expect((await blocked(identity.botId)).blocked).toBeNull();

    const result = await start({
      scopeKind: "bot",
      scopeId: identity.botId,
      reason: "suspected leak",
    });

    expect(result).toMatchObject({
      bots: 1,
      cancelledRuns: 2,
    });
    expect(await runStatus(running.id)).toBe("cancelled");
    expect(await runStatus(queued.id)).toBe("cancelled");
    expect(cancel).toHaveBeenCalledWith(expect.stringContaining(running.id));
    expect((await blocked(identity.botId)).blocked).toBe("quarantined");
    await expect(
      runAsSystem("test", () => assertBotNotSuspended(prisma, identity.botId)),
    ).rejects.toMatchObject({ code: "FORBIDDEN", message: "Quarantined by your organization" });
    // Nothing is deleted: the bot's secret, MCP assignment and webhook secret stay as configured.
    expect(await system.botSecret.count({ where: { botId: identity.botId } })).toBe(1);
    expect(await system.botMcpServer.count({ where: { botId: identity.botId } })).toBe(1);
    expect(await system.mcpServer.count({ where: { id: server.id } })).toBe(1);
    expect(await system.vaultCredential.count({ where: { id: vault.id } })).toBe(1);
    expect(
      (await system.bot.findUniqueOrThrow({ where: { id: identity.botId } })).webhookSecretId,
    ).toBe(webhook.id);
    expect(
      await runAsSystem("test", () => loadWebhookTarget(webhookDeps(), new Map(), identity.botId)),
    ).toBeNull();

    await liftQuarantine(deps(), adminId, result.id);

    expect((await blocked(identity.botId)).blocked).toBeNull();
    expect(await system.botSecret.count({ where: { botId: identity.botId } })).toBe(1);
    expect(await system.botMcpServer.count({ where: { botId: identity.botId } })).toBe(1);
    expect(
      (await runAsSystem("test", () => loadWebhookTarget(webhookDeps(), new Map(), identity.botId)))
        ?.expected,
    ).toBe("hook-secret");
    await expect(
      runAsSystem("test", () => assertBotNotSuspended(prisma, identity.botId)),
    ).resolves.toBeUndefined();
    const events = await system.securityEvent.findMany({ where: { userId: adminId } });
    expect(events.map((event) => event.type).sort()).toEqual([
      "bot.quarantined",
      "bot.released",
      "computer.quarantined",
      "computer.released",
    ]);
    expect(events.find((event) => event.type === "bot.quarantined")).toMatchObject({
      type: "bot.quarantined",
      metadata: { scopeKind: "bot", scopeId: identity.botId, reason: "suspected leak" },
    });
    expect(JSON.stringify(events.map((event) => event.metadata))).not.toContain(
      "secret-ciphertext",
    );
  });

  it("covers a Space by membership at use time, including a bot added afterwards", async () => {
    const outsider = await runAsSystem("test fixture", () =>
      provisionMessagingIdentity(
        prisma,
        { provider: "test", address: `outsider-${randomUUID()}` },
        { signupsEnabled: undefined, signupAllowlist: undefined },
      ),
    );
    try {
      await start({ scopeKind: "space", scopeId: identity.spaceId });
      const later = await newBot();
      expect((await blocked(identity.botId)).blocked).toBe("quarantined");
      expect((await blocked(later.id)).blocked).toBe("quarantined");
      expect((await blocked(outsider.botId)).blocked).toBeNull();
    } finally {
      await system.messagingIdentity.deleteMany({ where: { userId: outsider.userId } });
      await system.organization.deleteMany({ where: { id: outsider.spaceId } });
      await system.user.deleteMany({ where: { id: outsider.userId } });
    }
  });

  it("covers the members of a chat group and no other bot", async () => {
    const member = await newBot();
    const bystander = await newBot();
    const group = await system.chatGroup.create({
      data: {
        spaceId: identity.spaceId,
        userId: identity.userId,
        name: "Planning",
        members: { create: [{ botId: member.id }] },
      },
    });
    await start({ scopeKind: "group", scopeId: group.id });
    expect((await blocked(member.id)).blocked).toBe("quarantined");
    expect((await blocked(bystander.id)).blocked).toBeNull();
    expect((await blocked(identity.botId)).blocked).toBeNull();
  });

  it("covers every bot with the all scope", async () => {
    const { id } = await start({ scopeKind: "all" });
    expect((await blocked(identity.botId)).blocked).toBe("quarantined");
    expect((await blocked((await newBot()).id)).blocked).toBe("quarantined");
    // It reaches every computer in the database; let go of them straight away.
    await liftQuarantine(deps(), adminId, id);
  });

  it("releases on lift, idempotently", async () => {
    await system.botSecret.create({
      data: {
        id: randomUUID(),
        userId: identity.userId,
        spaceId: identity.spaceId,
        botId: identity.botId,
        name: "TOKEN",
        origin: "https://api.example.test",
        auth: {},
        ciphertext: "secret-ciphertext",
      },
    });
    const { id } = await start({ scopeKind: "bot", scopeId: identity.botId });
    expect(await ownQuarantines()).toEqual([
      expect.objectContaining({ id, scopeKind: "bot", scopeName: "Assistant" }),
    ]);
    await liftQuarantine(deps(), adminId, id);
    await liftQuarantine(deps(), adminId, id);
    expect(await activeQuarantineFor(system, identity.botId)).toBeNull();
    expect((await blocked(identity.botId)).blocked).toBeNull();
    await expect(
      runAsSystem("test", () => assertBotNotSuspended(prisma, identity.botId)),
    ).resolves.toBeUndefined();
    expect(await system.botSecret.count({ where: { botId: identity.botId } })).toBe(1);
    expect(await ownQuarantines()).toEqual([]);
    const types = (await system.securityEvent.findMany({ where: { userId: adminId } })).map(
      (event) => event.type,
    );
    expect(types.sort()).toEqual([
      "bot.quarantined",
      "bot.released",
      "computer.quarantined",
      "computer.released",
    ]);
  });

  it("is admin only and answers NOT_FOUND for an unknown target", async () => {
    const running = await work("running");
    await expect(
      startQuarantine(deps(), identity.userId, { scopeKind: "bot", scopeId: identity.botId }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(await runStatus(running.id)).toBe("running");
    expect((await blocked(identity.botId)).blocked).toBeNull();
    await expect(
      startQuarantine(deps(), adminId, { scopeKind: "bot", scopeId: "missing" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    const { id } = await start({ scopeKind: "bot", scopeId: identity.botId });
    await expect(liftQuarantine(deps(), identity.userId, id)).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    expect((await blocked(identity.botId)).blocked).toBe("quarantined");
  });

  it("added only a new table, so the previous release keeps working", async () => {
    const columns = await system.$queryRaw<Array<{ column_name: string }>>`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'quarantines' ORDER BY column_name`;
    expect(columns.map((column) => column.column_name)).toEqual([
      "createdAt",
      "createdByUserId",
      "id",
      "liftedAt",
      "liftedByUserId",
      "reason",
      "scopeId",
      "scopeKind",
      "summary",
    ]);
  });
});
