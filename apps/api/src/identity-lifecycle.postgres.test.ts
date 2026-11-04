import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@rakazo/db";
import {
  asSystem,
  createDb,
  createThreadEvents,
  installSecurityEventStore,
  provisionMessagingIdentity,
  reconcileEmployeeEntitlements,
  runAsSystem,
} from "@rakazo/db";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { deprovisionUser, reactivateUser } from "./identity-lifecycle.js";

const databaseUrl = process.env.DATABASE_URL;
const enabled = process.env.VERIFY_DATABASE === "1" && Boolean(databaseUrl);

describe.skipIf(!enabled)("deprovisioning an account (PostgreSQL)", () => {
  let prisma: PrismaClient;
  let system: PrismaClient;
  let close: () => Promise<void>;
  let identity: Awaited<ReturnType<typeof provisionMessagingIdentity>>;
  let other: Awaited<ReturnType<typeof provisionMessagingIdentity>>;
  let employeeId: string;
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
      auth: {
        $context: Promise.resolve({
          internalAdapter: {
            listSessions: (userId: string) => system.session.findMany({ where: { userId } }),
            deleteSessions: (tokens: string[]) =>
              system.session.deleteMany({ where: { token: { in: tokens } } }),
          },
        }),
      },
    }) as unknown as Parameters<typeof deprovisionUser>[0];

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
    const provision = () =>
      runAsSystem("test fixture", () =>
        provisionMessagingIdentity(
          prisma,
          { provider: "test", address: `lifecycle-${randomUUID()}` },
          { signupsEnabled: undefined, signupAllowlist: undefined },
        ),
      );
    identity = await provision();
    other = await provision();
    employeeId = `emp-${randomUUID()}`;
    await system.employee.create({
      data: { id: employeeId, name: "Shared", createdByUserId: other.userId, status: "published" },
    });
    cancel.mockClear();
  });
  afterEach(async () => {
    const ids = [identity.userId, other.userId];
    await system.employee.deleteMany({ where: { id: employeeId } });
    await system.securityEvent.deleteMany({ where: { userId: { in: ids } } });
    await system.messagingIdentity.deleteMany({ where: { userId: { in: ids } } });
    await system.organization.deleteMany({
      where: { id: { in: [identity.spaceId, other.spaceId] } },
    });
    await system.user.deleteMany({ where: { id: { in: ids } } });
  });
  afterAll(async () => {
    await close?.();
  });

  const work = async (who: typeof identity, userId = who.userId, status = "running") => {
    const owner = { spaceId: who.spaceId, botId: who.botId, threadId: who.threadId, userId };
    const task = await system.task.create({ data: { ...owner, prompt: "work", status: "queued" } });
    return system.run.create({ data: { ...owner, taskId: task.id, status, trigger: "user" } });
  };
  const runStatus = async (id: string) =>
    (await system.run.findUniqueOrThrow({ where: { id } })).status;
  const grant = (data: Record<string, unknown>) =>
    system.capabilityGrant.create({
      data: {
        kind: "bot",
        scope: "calendar.read",
        createdByUserId: identity.userId,
        createdVia: "owner",
        ...data,
      } as never,
    });
  const user = () => system.user.findUniqueOrThrow({ where: { id: identity.userId } });

  async function setUp() {
    await system.session.createMany({
      data: Array.from({ length: 2 }, () => ({
        id: randomUUID(),
        token: randomUUID(),
        userId: identity.userId,
        expiresAt: new Date(Date.now() + 60_000),
      })),
    });
    await system.employeeGrant.create({
      data: {
        employeeId,
        subjectKind: "user",
        subjectValue: identity.userId,
        role: "collaborator",
        grantedBy: other.userId,
      },
    });
    await system.employeeEntitlement.create({
      data: { employeeId, userId: identity.userId, role: "collaborator", source: "grant" },
    });
    return {
      own: await work(identity),
      queued: await work(identity, identity.userId, "queued"),
      onOthersBot: await work(other, identity.userId),
      othersRun: await work(other),
      botGrant: await grant({ botId: identity.botId, spaceId: identity.spaceId }),
      delegation: await grant({
        botId: other.botId,
        spaceId: other.spaceId,
        kind: "delegation",
        principalUserId: identity.userId,
        createdByUserId: other.userId,
        createdVia: "admin",
      }),
      deny: await grant({
        botId: identity.botId,
        spaceId: identity.spaceId,
        effect: "deny",
        createdVia: "admin",
      }),
      othersGrant: await grant({
        botId: other.botId,
        spaceId: other.spaceId,
        createdByUserId: other.userId,
      }),
    };
  }

  it("ends sessions, suspends bots, stops runs, revokes grants and entitlements, and keeps data", async () => {
    const rows = await setUp();

    const result = await deprovisionUser(
      deps(),
      { via: "admin", adminId: other.userId },
      { userId: identity.userId, reason: "left the company" },
    );

    expect(result).toEqual({
      endedSessions: 2,
      suspendedBots: 1,
      cancelledRuns: 3,
      revokedGrants: 2,
    });
    expect(await system.session.count({ where: { userId: identity.userId } })).toBe(0);
    const row = await user();
    expect(row.deprovisionedAt).toBeInstanceOf(Date);
    expect(row.deprovisionedVia).toBe("admin");
    const bot = await system.bot.findUniqueOrThrow({ where: { id: identity.botId } });
    expect(bot.suspendedAt).toBeInstanceOf(Date);
    expect(bot.suspendedByUserId).toBe(other.userId);
    expect(await runStatus(rows.own.id)).toBe("cancelled");
    expect(await runStatus(rows.queued.id)).toBe("cancelled");
    expect(await runStatus(rows.onOthersBot.id)).toBe("cancelled");
    expect(await runStatus(rows.othersRun.id)).toBe("running");
    const revoked = async (id: string) =>
      (await system.capabilityGrant.findUniqueOrThrow({ where: { id } })).revokedAt;
    expect(await revoked(rows.botGrant.id)).toBeInstanceOf(Date);
    expect(await revoked(rows.delegation.id)).toBeInstanceOf(Date);
    expect(await revoked(rows.deny.id)).toBeNull();
    expect(await revoked(rows.othersGrant.id)).toBeNull();
    expect(await system.employeeEntitlement.count({ where: { userId: identity.userId } })).toBe(0);
    // Nothing is deleted: the grant that names the person is still there for a reactivation.
    expect(await system.employeeGrant.count({ where: { subjectValue: identity.userId } })).toBe(1);
    expect(await system.thread.count({ where: { id: identity.threadId } })).toBe(1);
    const events = await system.securityEvent.findMany({
      where: { userId: identity.userId, type: "user.deprovisioned" },
    });
    expect(events).toHaveLength(1);
    expect(events[0]?.metadata).toMatchObject({
      via: "admin",
      adminId: other.userId,
      reason: "left the company",
      cancelledRuns: 3,
    });
  });

  it("is safe to repeat and keeps the first time", async () => {
    await setUp();
    await deprovisionUser(deps(), { via: "provisioning" }, { userId: identity.userId });
    const first = (await user()).deprovisionedAt;
    const again = await deprovisionUser(
      deps(),
      { via: "admin", adminId: other.userId },
      {
        userId: identity.userId,
      },
    );
    expect(again).toEqual({
      endedSessions: 0,
      suspendedBots: 1,
      cancelledRuns: 0,
      revokedGrants: 0,
    });
    expect((await user()).deprovisionedAt).toEqual(first);
    expect((await user()).deprovisionedVia).toBe("provisioning");
  });

  it("reactivation restores entitlements but not suspended bots or revoked grants", async () => {
    const rows = await setUp();
    await deprovisionUser(deps(), { via: "provisioning" }, { userId: identity.userId });
    // A grant change while deactivated must not give the account access either.
    await reconcileEmployeeEntitlements(prisma, employeeId);
    expect(await system.employeeEntitlement.count({ where: { userId: identity.userId } })).toBe(0);

    expect(await reactivateUser(deps(), { via: "provisioning" }, identity.userId)).toBe(true);

    expect((await user()).deprovisionedAt).toBeNull();
    expect(await system.employeeEntitlement.count({ where: { userId: identity.userId } })).toBe(1);
    const bot = await system.bot.findUniqueOrThrow({ where: { id: identity.botId } });
    expect(bot.suspendedAt).toBeInstanceOf(Date);
    const grantRow = await system.capabilityGrant.findUniqueOrThrow({
      where: { id: rows.botGrant.id },
    });
    expect(grantRow.revokedAt).toBeInstanceOf(Date);
    const types = (await system.securityEvent.findMany({ where: { userId: identity.userId } })).map(
      (event) => event.type,
    );
    expect(types).toEqual(expect.arrayContaining(["user.deprovisioned", "user.reactivated"]));
  });

  it("lets the directory undo only what the directory did", async () => {
    await deprovisionUser(
      deps(),
      { via: "admin", adminId: other.userId },
      {
        userId: identity.userId,
      },
    );
    expect(await reactivateUser(deps(), { via: "provisioning" }, identity.userId)).toBe(false);
    expect((await user()).deprovisionedAt).toBeInstanceOf(Date);
    expect(
      await reactivateUser(deps(), { via: "admin", adminId: other.userId }, identity.userId),
    ).toBe(true);
    expect((await user()).deprovisionedAt).toBeNull();
  });

  it("answers NOT_FOUND for an unknown account", async () => {
    await expect(
      deprovisionUser(deps(), { via: "provisioning" }, { userId: "missing" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(reactivateUser(deps(), { via: "provisioning" }, "missing")).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });
});
