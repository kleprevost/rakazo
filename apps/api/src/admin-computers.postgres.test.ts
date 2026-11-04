import { randomUUID } from "node:crypto";
import { setActivePolicy } from "@rakazo/adapters";
import type { PrismaClient } from "@rakazo/db";
import { asSystem, createDb } from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { adminComputers } from "./admin-computers.js";
import type { RouterDeps } from "./router.js";

const dbTests =
  process.env.VERIFY_DATABASE && process.env.DATABASE_URL ? describe.sequential : describe.skip;

dbTests("admin computers image filter (PostgreSQL)", () => {
  const stamp = randomUUID();
  const digest = (char: string) => `sha256:${char.repeat(64)}`;
  let db: ReturnType<typeof createDb>;
  let system: PrismaClient;
  let deps: Parameters<typeof adminComputers>[0];

  async function computer(
    name: string,
    recorded: { imageRef?: string; imageDigest?: string },
    observed?: { imageRef: string | null; imageDigest: string | null },
  ) {
    const id = `${stamp}-${name}`;
    await system.computer.create({
      data: {
        id,
        spaceId: stamp,
        userId: stamp,
        scopeKey: id,
        homeKey: id,
        kind: "fake",
        state: "stopped",
        ...recorded,
      },
    });
    if (observed)
      await system.computerObservation.create({
        data: {
          computerId: id,
          observedAt: new Date(),
          runtime: "running",
          isolation: "container",
          ...observed,
        },
      });
    return id;
  }

  beforeAll(async () => {
    db = createDb(process.env.DATABASE_URL!);
    system = asSystem(db.prisma);
    await system.user.create({
      data: { id: stamp, name: "Admin", email: `${stamp}@example.test`, emailVerified: true },
    });
    await system.organization.create({
      data: { id: stamp, name: "Fleet", slug: stamp, createdAt: new Date() },
    });
    await system.space.create({ data: { id: stamp, organizationId: stamp, name: "Fleet" } });
    deps = {
      prisma: db.prisma,
      sandbox: { describe: () => ({ id: "fake", capabilities: {} }) },
      env: { adminEmails: [`${stamp}@example.test`], ssoAdminEnabled: false },
      auth: { isSsoAdmin: async () => false },
    } as unknown as Parameters<typeof adminComputers>[0] & Pick<RouterDeps, "prisma">;
  });

  afterAll(async () => {
    setActivePolicy(undefined);
    if (db) {
      await system.organization.deleteMany({ where: { id: stamp } });
      await system.user.deleteMany({ where: { id: stamp } });
      await db.prisma.$disconnect();
      await db.pool.end();
    }
  });

  it("lists exactly the computers whose last known image the policy does not approve", async () => {
    const ok = await computer("ok", {}, { imageRef: "r/c@x", imageDigest: digest("a") });
    const off = await computer("off", {}, { imageRef: "r/c@y", imageDigest: digest("b") });
    const tagOnly = await computer("tag", {}, { imageRef: "r/c:latest", imageDigest: null });
    const nothing = await computer("none", {}, { imageRef: null, imageDigest: null });
    const recordedOk = await computer("rec-ok", { imageRef: "r/c@x", imageDigest: digest("a") });
    const recordedOff = await computer("rec-off", { imageRef: "r/c@y", imageDigest: digest("b") });
    const unknown = await computer("unknown", {});
    // The observation is what runs now, so it wins over what the start once asked for.
    const drifted = await computer(
      "drift",
      { imageRef: "r/c@x", imageDigest: digest("a") },
      { imageRef: "r/c@y", imageDigest: digest("b") },
    );

    setActivePolicy({ version: 1, computers: { images: { allow: [{ digest: digest("a") }] } } });
    const page = await adminComputers(deps, stamp, { limit: 100 });
    const standing = Object.fromEntries(
      page.computers.map((entry) => [entry.id, entry.imageCompliance]),
    );
    expect(standing).toMatchObject({
      [ok]: "approved",
      [off]: "not_approved",
      [tagOnly]: "not_approved",
      [nothing]: "unknown",
      [recordedOk]: "approved",
      [recordedOff]: "not_approved",
      [unknown]: "unknown",
      [drifted]: "not_approved",
    });

    const flagged = await adminComputers(deps, stamp, {
      limit: 100,
      imageCompliance: "not_approved",
    });
    expect(flagged.computers.map((entry) => entry.id).sort()).toEqual(
      [off, tagOnly, recordedOff, drifted].sort(),
    );

    // Without a list nothing is checked, and the filter has nothing to show.
    setActivePolicy({ version: 1 });
    expect(
      (await adminComputers(deps, stamp, { limit: 100 })).computers[0]?.imageCompliance,
    ).toBeNull();
    expect(
      (await adminComputers(deps, stamp, { limit: 100, imageCompliance: "not_approved" }))
        .computers,
    ).toEqual([]);
  });
});
