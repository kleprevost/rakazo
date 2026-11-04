import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@rakazo/db";
import { asSystem, createDb } from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  adminCreateFleetOperation,
  adminFleetOperation,
  adminFleetOperations,
} from "./admin-fleet-operations.js";

const dbTests =
  process.env.VERIFY_DATABASE && process.env.DATABASE_URL ? describe.sequential : describe.skip;

dbTests("admin fleet operations (PostgreSQL)", () => {
  const stamp = randomUUID();
  let db: ReturnType<typeof createDb>;
  let system: PrismaClient;
  let deps: Parameters<typeof adminCreateFleetOperation>[0];
  const enqueue = vi.fn().mockResolvedValue(undefined);

  beforeAll(async () => {
    db = createDb(process.env.DATABASE_URL!);
    system = asSystem(db.prisma);
    for (const [id, verified] of [
      [stamp, true],
      [`${stamp}-user`, true],
    ] as const)
      await system.user.create({
        data: { id, name: "Person", email: `${id}@example.test`, emailVerified: verified },
      });
    await system.organization.create({
      data: { id: stamp, name: "Fleet", slug: stamp, createdAt: new Date() },
    });
    await system.space.create({ data: { id: stamp, organizationId: stamp, name: "Fleet" } });
    await system.computer.create({
      data: {
        id: stamp,
        spaceId: stamp,
        userId: stamp,
        scopeKey: stamp,
        homeKey: stamp,
        kind: "fake",
        state: "suspended",
      },
    });
    await system.bot.create({
      data: {
        spaceId: stamp,
        userId: stamp,
        name: "Reporter",
        color: "ink",
        computerId: stamp,
        thread: { create: { spaceId: stamp, userId: stamp } },
      },
    });
    deps = {
      prisma: db.prisma,
      jobs: { enqueue },
      env: { adminEmails: [`${stamp}@example.test`], ssoAdminEnabled: false },
      auth: { isSsoAdmin: async () => false },
    } as unknown as typeof deps;
  });

  afterAll(async () => {
    if (db) {
      await system.computerFleetOperation.deleteMany({ where: { actorUserId: stamp } });
      await system.securityEvent.deleteMany({ where: { userId: stamp } });
      await system.organization.deleteMany({ where: { id: stamp } });
      await system.user.deleteMany({ where: { id: { startsWith: stamp } } });
      await db.prisma.$disconnect();
      await db.pool.end();
    }
  });

  it("creates, lists and reads an operation with names and counts, and only for admins", async () => {
    const { id } = await adminCreateFleetOperation(deps, stamp, {
      kind: "wake",
      computerIds: [stamp],
      maxParallel: 3,
      haltAfterFailures: 2,
    });
    expect(enqueue).toHaveBeenCalledWith(expect.objectContaining({ name: "computer.fleet-item" }));

    const { operations } = await adminFleetOperations(deps, stamp, { limit: 20 });
    expect(operations[0]).toMatchObject({
      id,
      kind: "wake",
      status: "queued",
      counts: { queued: 1 },
    });

    const detail = await adminFleetOperation(deps, stamp, id);
    expect(detail.items).toEqual([
      {
        computerId: stamp,
        spaceName: "Fleet",
        bots: ["Reporter"],
        status: "queued",
        outcome: null,
        finishedAt: null,
      },
    ]);
    // Metadata only: no path, token, provider reference or claim leaves the API.
    expect(Object.keys(detail.items[0] as object).sort()).toEqual([
      "bots",
      "computerId",
      "finishedAt",
      "outcome",
      "spaceName",
      "status",
    ]);

    const outsider = `${stamp}-user`;
    await expect(
      adminCreateFleetOperation(deps, outsider, {
        kind: "wake",
        computerIds: [stamp],
        maxParallel: 3,
        haltAfterFailures: 2,
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(adminFleetOperations(deps, outsider, { limit: 20 })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    await expect(adminFleetOperation(deps, outsider, id)).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
  });

  it("refuses an unknown computer and an unknown operation", async () => {
    await expect(
      adminCreateFleetOperation(deps, stamp, {
        kind: "hibernate",
        computerIds: ["missing"],
        maxParallel: 3,
        haltAfterFailures: 2,
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(adminFleetOperation(deps, stamp, "missing")).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });
});
