import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@rakazo/db";
import { asSystem, createDb } from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { FakeSandboxProvider } from "./fake-sandbox.js";
import { createFleetObserver } from "./fleet-observer.js";

const url = process.env.DATABASE_URL;
const describePostgres =
  process.env.VERIFY_DATABASE === "1" && url ? describe.sequential : describe.skip;

describePostgres("fleet observer (PostgreSQL)", () => {
  const stamp = randomUUID();
  let db: ReturnType<typeof createDb>;
  let system: PrismaClient;

  beforeAll(async () => {
    db = createDb(url!);
    system = asSystem(db.prisma);
    await system.user.create({
      data: {
        id: stamp,
        name: "Fleet Owner",
        email: `${stamp}@example.test`,
        emailVerified: false,
      },
    });
    await system.organization.create({
      data: { id: stamp, name: "Fleet", slug: stamp, createdAt: new Date() },
    });
    await system.space.create({ data: { id: stamp, organizationId: stamp, name: "Fleet" } });
  });

  afterAll(async () => {
    if (db) {
      await system.computer.deleteMany({ where: { spaceId: stamp } });
      await system.organization.deleteMany({ where: { id: stamp } });
      await system.user.deleteMany({ where: { id: stamp } });
      await db.prisma.$disconnect();
      await db.pool.end();
    }
  });

  it("stores a running computer's report, refreshes it in place and cascades on delete", async () => {
    const sandbox = new FakeSandboxProvider();
    const context = {
      operationId: "t",
      traceId: "t",
      spaceId: stamp,
      userId: stamp,
      signal: new AbortController().signal,
    };
    const ref = await sandbox.provision({ botId: stamp, homePath: "/tmp/unused" }, context);
    const computer = await system.computer.create({
      data: {
        id: stamp,
        spaceId: stamp,
        userId: stamp,
        scopeKey: stamp,
        homeKey: stamp,
        kind: "fake",
        providerRef: ref.providerRef,
        state: "running",
      },
    });
    // A stopped computer is not asked.
    const stopped = await system.computer.create({
      data: {
        id: `${stamp}-s`,
        spaceId: stamp,
        userId: stamp,
        scopeKey: `${stamp}-s`,
        homeKey: `${stamp}-s`,
        kind: "fake",
        providerRef: "fake-stopped",
        state: "stopped",
      },
    });

    await system.computerObserverLease.deleteMany({});
    await createFleetObserver({ prisma: db.prisma, sandbox })();
    const first = await system.computerObservation.findUnique({
      where: { computerId: computer.id },
    });
    expect(first).toMatchObject({
      runtime: "running",
      isolation: "container",
      imageRef: "fake/computer:test",
      cpuMillis: 10,
      memoryBytes: 1024n,
      health: "ok",
      restartCount: 0,
    });
    expect(first?.imageDigest).toMatch(/^sha256:/);
    expect(
      await system.computerObservation.findUnique({ where: { computerId: stopped.id } }),
    ).toBeNull();

    await system.computerObserverLease.deleteMany({});
    await createFleetObserver({ prisma: db.prisma, sandbox })();
    expect(await system.computerObservation.count({ where: { computerId: computer.id } })).toBe(1);
    const second = await system.computerObservation.findUniqueOrThrow({
      where: { computerId: computer.id },
    });
    expect(second.observedAt.getTime()).toBeGreaterThanOrEqual(first!.observedAt.getTime());

    // Two instances ticking together: one lease, so the provider sees one batch per interval.
    await system.computerObserverLease.deleteMany({});
    const inspectMany = vi.fn(async () => new Map());
    const counted = Object.assign(Object.create(sandbox), { inspectMany });
    const sweepers = [
      createFleetObserver({ prisma: db.prisma, sandbox: counted }),
      createFleetObserver({ prisma: db.prisma, sandbox: counted }),
    ];
    await Promise.all(sweepers.map((sweep) => sweep()));
    expect(inspectMany).toHaveBeenCalledTimes(1);
    // An expired lease (a crashed holder) is taken over by the next tick.
    await system.computerObserverLease.updateMany({
      data: { claimedUntil: new Date(Date.now() - 1000) },
    });
    await createFleetObserver({ prisma: db.prisma, sandbox: counted })();
    expect(inspectMany).toHaveBeenCalledTimes(2);

    await system.computer.delete({ where: { id: computer.id } });
    expect(await system.computerObservation.count({ where: { computerId: computer.id } })).toBe(0);
  });
});
