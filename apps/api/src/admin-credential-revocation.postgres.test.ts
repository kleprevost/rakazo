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
import { revokeCredentials } from "./admin-credential-revocation.js";
import { startQuarantine } from "./bot-quarantine.js";

const databaseUrl = process.env.DATABASE_URL;
const enabled = process.env.VERIFY_DATABASE === "1" && Boolean(databaseUrl);

describe.skipIf(!enabled)("admin credential revocation (PostgreSQL)", () => {
  let prisma: PrismaClient;
  let system: PrismaClient;
  let close: () => Promise<void>;
  let target: Awaited<ReturnType<typeof provisionMessagingIdentity>>;
  let adminId: string;
  let adminEmail: string;
  const providerRevoke = vi.fn().mockResolvedValue(undefined);
  const cancelProvider = vi.fn().mockResolvedValue(undefined);
  const deps = () =>
    ({
      prisma,
      events: createThreadEvents(prisma),
      jobs: { enqueue: vi.fn(), cancel: vi.fn() },
      sandbox: { describe: () => ({ id: "fake", capabilities: {} }) },
      connectors: { managed: () => ({ revoke: providerRevoke }) },
      oauthLogins: { cancelProvider },
      env: { adminEmails: [adminEmail], ssoAdminEnabled: false },
      auth: { isSsoAdmin: async () => false },
    }) as unknown as Parameters<typeof revokeCredentials>[0];

  async function seed() {
    const { userId, spaceId, botId } = target;
    const secret = await system.secret.create({
      data: { userId, spaceId, kind: "mcp", ciphertext: `c-${randomUUID()}` },
    });
    const modelSecret = await system.secret.create({
      data: { userId, kind: "model", ciphertext: `c-${randomUUID()}` },
    });
    const server = await system.mcpServer.create({
      data: {
        spaceId,
        userId,
        slug: "srv",
        name: "Server",
        transport: "http",
        secretId: secret.id,
      },
    });
    await system.botMcpServer.create({ data: { spaceId, botId, serverId: server.id, userId } });
    const connection = await system.connection.create({
      data: { spaceId, userId, provider: "calendar", displayName: "Calendar", status: "connected" },
    });
    await system.vaultCredential.create({
      data: {
        id: randomUUID(),
        userId,
        spaceId,
        name: "site",
        origin: "https://example.test",
        auth: { type: "bearer" },
        ciphertext: `c-${randomUUID()}`,
      },
    });
    await system.botSecret.create({
      data: {
        id: randomUUID(),
        userId,
        spaceId,
        botId,
        name: "key",
        origin: "https://example.test",
        auth: { type: "bearer" },
        ciphertext: `c-${randomUUID()}`,
      },
    });
    await system.userModelCredential.create({
      data: { userId, provider: "openai", label: "work", secretId: modelSecret.id },
    });
    return { server, connection, secret };
  }

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
    target = await runAsSystem("test fixture", () =>
      provisionMessagingIdentity(
        prisma,
        { provider: "test", address: `revoke-${randomUUID()}` },
        { signupsEnabled: undefined, signupAllowlist: undefined },
      ),
    );
    adminId = `admin-${randomUUID()}`;
    adminEmail = `${adminId}@example.test`;
    await system.user.create({
      data: { id: adminId, name: "Admin", email: adminEmail, emailVerified: true },
    });
    providerRevoke.mockClear();
    cancelProvider.mockClear();
  });
  afterEach(async () => {
    await system.securityEvent.deleteMany({
      where: { userId: { in: [adminId, target.userId] } },
    });
    await system.quarantine.deleteMany({ where: { createdByUserId: adminId } });
    await system.user.deleteMany({ where: { id: adminId } });
  });
  afterAll(async () => {
    await close?.();
  });

  it("revokes an account's credentials, audits it with counts only, and the next lookup finds none", async () => {
    const { server, connection, secret } = await seed();

    const result = await revokeCredentials(deps(), adminId, { userId: target.userId });

    expect(result).toEqual({
      connections: 1,
      providerUnconfirmed: 0,
      mcpServers: 1,
      mcpAssignments: 0,
      vaultItems: 1,
      botSecrets: 1,
      modelConnections: 1,
      voiceConnections: 0,
    });
    expect(providerRevoke).toHaveBeenCalledOnce();
    expect(cancelProvider).toHaveBeenCalledWith({ userId: target.userId, provider: "openai" });
    expect(
      (await system.connection.findUniqueOrThrow({ where: { id: connection.id } })).status,
    ).toBe("revoked");
    const after = await system.mcpServer.findUniqueOrThrow({ where: { id: server.id } });
    expect(after.secretId).toBeNull();
    expect(after.revision).toBe(server.revision + 1);
    expect(await system.secret.count({ where: { id: secret.id } })).toBe(0);
    expect(await system.vaultCredential.count({ where: { userId: target.userId } })).toBe(0);
    expect(await system.botSecret.count({ where: { userId: target.userId } })).toBe(0);
    expect(await system.userModelCredential.count({ where: { userId: target.userId } })).toBe(0);

    const events = await system.securityEvent.findMany({
      where: { type: "credential.revoked", userId: target.userId },
    });
    expect(events).toHaveLength(1);
    expect(events[0]?.metadata).toMatchObject({ via: "admin", adminId, connections: 1 });
  });

  it("reports a provider that could not confirm, and still revokes the connection here", async () => {
    const { connection } = await seed();
    providerRevoke.mockRejectedValueOnce(new Error("provider down"));

    const result = await revokeCredentials(deps(), adminId, { userId: target.userId });

    expect(result.providerUnconfirmed).toBe(1);
    expect(
      (await system.connection.findUniqueOrThrow({ where: { id: connection.id } })).status,
    ).toBe("revoked");
  });

  it("revokes only a bot's own secrets and assignments, leaving the owner's connections", async () => {
    const { server, connection } = await seed();

    const result = await revokeCredentials(deps(), adminId, { botId: target.botId });

    expect(result).toMatchObject({ botSecrets: 1, mcpAssignments: 1, connections: 0 });
    expect(await system.botMcpServer.count({ where: { botId: target.botId } })).toBe(0);
    expect(await system.mcpServer.count({ where: { id: server.id } })).toBe(1);
    expect(
      (await system.connection.findUniqueOrThrow({ where: { id: connection.id } })).status,
    ).toBe("connected");
    expect(await system.vaultCredential.count({ where: { userId: target.userId } })).toBe(1);
  });

  it("refuses an account that is not an admin, and your own account", async () => {
    await seed();
    const other = `other-${randomUUID()}`;
    await system.user.create({
      data: { id: other, name: "Other", email: `${other}@example.test`, emailVerified: true },
    });
    try {
      await expect(revokeCredentials(deps(), other, { userId: target.userId })).rejects.toThrow(
        "Admins only",
      );
      await expect(revokeCredentials(deps(), adminId, { userId: adminId })).rejects.toThrow(
        "Not available on your own account",
      );
      expect(await system.vaultCredential.count({ where: { userId: target.userId } })).toBe(1);
    } finally {
      await system.user.deleteMany({ where: { id: other } });
    }
  });

  it("is not done by quarantine: a quarantined bot's owner keeps every connection and secret", async () => {
    const { connection } = await seed();

    await startQuarantine(deps() as unknown as Parameters<typeof startQuarantine>[0], adminId, {
      scopeKind: "bot",
      scopeId: target.botId,
    });

    expect(
      (await system.connection.findUniqueOrThrow({ where: { id: connection.id } })).status,
    ).toBe("connected");
    expect(await system.vaultCredential.count({ where: { userId: target.userId } })).toBe(1);
    expect(await system.botSecret.count({ where: { userId: target.userId } })).toBe(1);
    expect(providerRevoke).not.toHaveBeenCalled();
  });
});
