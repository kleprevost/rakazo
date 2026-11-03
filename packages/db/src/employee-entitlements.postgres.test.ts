import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PrismaClient } from "./client.js";
import { createDb } from "./client.js";
import {
  reconcileEmployeeEntitlements,
  reconcileUserEntitlements,
  recordDirectoryClaims,
  sweepExpiredEmployeeGrants,
} from "./employee-entitlements.js";
import { asSystem, runAsTenant } from "./row-security.js";
import { installSecurityEventStore } from "./security-events.js";

// Needs DATABASE_URL as the runtime login and DATABASE_MIGRATION_URL as the owner, as
// `pnpm test:integration` provides after `pnpm db:migrate`.
const runtimeUrl = process.env.DATABASE_URL;
const migrationUrl = process.env.DATABASE_MIGRATION_URL;
const describePostgres =
  process.env.VERIFY_DATABASE && runtimeUrl && migrationUrl && runtimeUrl !== migrationUrl
    ? describe.sequential
    : describe.skip;

describePostgres("employee entitlement reconcile (PostgreSQL)", () => {
  const suffix = `${process.pid}-${Date.now()}`;
  const organizationId = `ent-org-${suffix}`;
  const employeeId = `ent-emp-${suffix}`;
  const secondEmployeeId = `ent-emp2-${suffix}`;
  const names = ["alice", "bob", "carol"] as const;
  const user = (name: string) => `ent-user-${name}-${suffix}`;
  const space = (name: string) => `ent-space-${name}-${suffix}`;
  let owner: ReturnType<typeof createDb>;
  let app: ReturnType<typeof createDb>;
  let db: PrismaClient;
  let sys: PrismaClient;

  const entitlements = (id = employeeId) =>
    sys.employeeEntitlement
      .findMany({ where: { employeeId: id }, orderBy: [{ userId: "asc" }, { source: "asc" }] })
      .then((rows) => rows.map((row) => `${row.userId}:${row.source}:${row.role}`));
  const grant = (
    id: string,
    subjectKind: "user" | "claim",
    subjectValue: string,
    role: string,
    expiresAt?: Date,
  ) =>
    sys.employeeGrant.create({
      data: {
        employeeId: id,
        subjectKind,
        subjectValue,
        role,
        grantedBy: user("alice"),
        expiresAt,
      },
    });

  beforeAll(async () => {
    owner = createDb(migrationUrl!);
    app = createDb(runtimeUrl!, { poolMax: 6 });
    db = app.prisma;
    sys = asSystem(owner.prisma);
    installSecurityEventStore(db);
    await sys.organization.create({
      data: {
        id: organizationId,
        name: "Entitlements",
        slug: organizationId,
        createdAt: new Date(),
      },
    });
    for (const name of names) {
      await sys.user.create({
        data: { id: user(name), name, email: `${user(name)}@rakazo.test`, emailVerified: true },
      });
      await sys.space.create({ data: { id: space(name), organizationId, name } });
    }
    for (const id of [employeeId, secondEmployeeId]) {
      await sys.employee.create({
        data: { id, name: id, createdByUserId: user("alice"), status: "published" },
      });
    }
  });

  afterAll(async () => {
    installSecurityEventStore(undefined);
    if (!owner) return;
    await sys.employee.deleteMany({ where: { id: { in: [employeeId, secondEmployeeId] } } });
    await sys.securityEvent.deleteMany({ where: { userId: { in: names.map(user) } } });
    await sys.organization.deleteMany({ where: { id: organizationId } });
    await sys.user.deleteMany({ where: { id: { in: names.map(user) } } });
    for (const handle of [owner, app]) {
      await handle.prisma.$disconnect();
      await handle.pool.end();
    }
  });

  it("turns a user grant into an entitlement, and removing it removes the entitlement", async () => {
    await grant(employeeId, "user", user("alice"), "owner");
    const result = await reconcileEmployeeEntitlements(db, employeeId);
    expect(result).toEqual({ added: 1, updated: 0, removed: 0 });
    expect(await entitlements()).toEqual([`${user("alice")}:grant:owner`]);

    await sys.employeeGrant.deleteMany({ where: { employeeId } });
    expect(await reconcileEmployeeEntitlements(db, employeeId)).toEqual({
      added: 0,
      updated: 0,
      removed: 1,
    });
    expect(await entitlements()).toEqual([]);
  });

  it("follows a user's claim change through sign-in and revalidation", async () => {
    await grant(employeeId, "claim", "group-eng", "collaborator");
    await grant(employeeId, "claim", "group-ops", "viewer");

    const first = await recordDirectoryClaims(db, user("bob"), { values: ["group-eng"] });
    expect(first.added).toBe(1);
    expect(await entitlements()).toEqual([`${user("bob")}:claim:collaborator`]);

    // The same claim again changes nothing.
    expect(await recordDirectoryClaims(db, user("bob"), { values: ["group-eng"] })).toEqual({
      added: 0,
      updated: 0,
      removed: 0,
    });

    // Moving to another group changes the role.
    const moved = await recordDirectoryClaims(
      db,
      user("bob"),
      { values: ["group-ops"] },
      {
        via: "revalidation",
      },
    );
    expect(moved.updated).toBe(1);
    expect(await entitlements()).toEqual([`${user("bob")}:claim:viewer`]);

    // Losing the group at the directory removes the entitlement.
    const lost = await recordDirectoryClaims(db, user("bob"), { values: [] });
    expect(lost.removed).toBe(1);
    expect(await entitlements()).toEqual([]);

    const events = await sys.securityEvent.findMany({
      where: { userId: user("bob"), type: "employee.entitlements_reconciled" },
    });
    expect(events).toHaveLength(3);
    expect(events.map((event) => event.metadata)).toContainEqual(
      expect.objectContaining({ via: "revalidation", updated: 1 }),
    );
    // Only identifiers and counts, never a claim value.
    expect(JSON.stringify(events.map((event) => event.metadata))).not.toContain("group-");
  });

  it("fails closed on truncated claims", async () => {
    await recordDirectoryClaims(db, user("carol"), { values: ["group-eng"] });
    expect(await entitlements()).toContain(`${user("carol")}:claim:collaborator`);
    await recordDirectoryClaims(db, user("carol"), { values: [], truncated: true });
    expect((await entitlements()).filter((row) => row.startsWith(user("carol")))).toEqual([]);
    const stored = await sys.userDirectoryClaim.findUnique({ where: { userId: user("carol") } });
    expect(stored?.truncated).toBe(true);
  });

  it("recomputes every holder when a claim grant is added or changed", async () => {
    await recordDirectoryClaims(db, user("alice"), { values: ["group-new"] });
    await recordDirectoryClaims(db, user("bob"), { values: ["group-new"] });
    await grant(secondEmployeeId, "claim", "group-new", "viewer");
    expect(await reconcileEmployeeEntitlements(db, secondEmployeeId)).toMatchObject({ added: 2 });
    await sys.employeeGrant.updateMany({
      where: { employeeId: secondEmployeeId },
      data: { role: "collaborator" },
    });
    expect(await reconcileEmployeeEntitlements(db, secondEmployeeId)).toMatchObject({ updated: 2 });
    expect(await entitlements(secondEmployeeId)).toEqual([
      `${user("alice")}:claim:collaborator`,
      `${user("bob")}:claim:collaborator`,
    ]);
  });

  it("drops expired grants on the sweep and at the next sign-in", async () => {
    const now = new Date("2030-01-01T00:00:00Z");
    await sys.employeeGrant.deleteMany({ where: { employeeId: secondEmployeeId } });
    await sys.employeeEntitlement.deleteMany({ where: { employeeId: secondEmployeeId } });
    await grant(
      secondEmployeeId,
      "user",
      user("carol"),
      "viewer",
      new Date("2030-06-01T00:00:00Z"),
    );
    await grant(
      secondEmployeeId,
      "claim",
      "group-late",
      "viewer",
      new Date("2030-06-01T00:00:00Z"),
    );
    await recordDirectoryClaims(db, user("carol"), { values: ["group-late"] }, { now });
    expect(await entitlements(secondEmployeeId)).toEqual([
      `${user("carol")}:claim:viewer`,
      `${user("carol")}:grant:viewer`,
    ]);

    const later = new Date("2031-01-01T00:00:00Z");
    expect(await sweepExpiredEmployeeGrants(db, later)).toMatchObject({ removed: 2 });
    expect(await entitlements(secondEmployeeId)).toEqual([]);

    // Sign-in alone also drops them.
    await recordDirectoryClaims(db, user("carol"), { values: ["group-late"] }, { now });
    expect(await entitlements(secondEmployeeId)).toHaveLength(2);
    await recordDirectoryClaims(db, user("carol"), { values: ["group-late"] }, { now: later });
    expect(await entitlements(secondEmployeeId)).toEqual([]);
  });

  it("converges when reconciles run concurrently", async () => {
    await sys.employeeGrant.deleteMany({ where: { employeeId } });
    await sys.employeeEntitlement.deleteMany({ where: { employeeId } });
    await sys.employeeGrant.deleteMany({ where: { employeeId: secondEmployeeId } });
    await sys.employeeEntitlement.deleteMany({ where: { employeeId: secondEmployeeId } });
    await grant(employeeId, "claim", "group-eng", "collaborator");
    await grant(employeeId, "user", user("bob"), "manager");
    for (const name of names) {
      await sys.userDirectoryClaim.upsert({
        where: { userId: user(name) },
        create: { userId: user(name), values: ["group-eng"] },
        update: { values: ["group-eng"], truncated: false },
      });
    }
    const runs = await Promise.all([
      ...Array.from({ length: 4 }, () => reconcileEmployeeEntitlements(db, employeeId)),
      ...names.flatMap((name) => [
        reconcileUserEntitlements(db, user(name)),
        reconcileUserEntitlements(db, user(name)),
      ]),
    ]);
    expect(runs.every((run) => run.removed === 0)).toBe(true);
    expect(await entitlements()).toEqual([
      `${user("alice")}:claim:collaborator`,
      `${user("bob")}:claim:collaborator`,
      `${user("bob")}:grant:manager`,
      `${user("carol")}:claim:collaborator`,
    ]);
    // Settled: another pass changes nothing.
    expect(await reconcileEmployeeEntitlements(db, employeeId)).toEqual({
      added: 0,
      updated: 0,
      removed: 0,
    });
  });

  it("still limits tenant reads to the user's own rows and refuses tenant writes", async () => {
    const rows = await runAsTenant({ spaceId: space("bob"), userId: user("bob") }, () =>
      db.employeeEntitlement.findMany({
        where: { employeeId: { in: [employeeId, secondEmployeeId] } },
      }),
    );
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((row) => row.userId === user("bob"))).toBe(true);
    await expect(
      runAsTenant({ spaceId: space("bob"), userId: user("bob") }, () =>
        db.employeeEntitlement.create({
          data: {
            employeeId: secondEmployeeId,
            userId: user("bob"),
            role: "owner",
            source: "grant",
          },
        }),
      ),
    ).rejects.toThrow();
  });
});
