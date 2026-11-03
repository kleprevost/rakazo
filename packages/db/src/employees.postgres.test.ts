import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PrismaClient } from "./client.js";
import { createDb } from "./client.js";
import { asSystem, drainUnscopedDatabaseAccess, runAsSystem, runAsTenant } from "./row-security.js";

// Needs DATABASE_URL as the runtime login and DATABASE_MIGRATION_URL as the owner, as
// `pnpm test:integration` provides after `pnpm db:migrate`.
const runtimeUrl = process.env.DATABASE_URL;
const migrationUrl = process.env.DATABASE_MIGRATION_URL;
const describePostgres =
  process.env.VERIFY_DATABASE && runtimeUrl && migrationUrl && runtimeUrl !== migrationUrl
    ? describe.sequential
    : describe.skip;

describePostgres("shared employees row-level security (PostgreSQL)", () => {
  const suffix = `${process.pid}-${Date.now()}`;
  const organizationId = `emp-org-${suffix}`;
  const employeeId = `emp-${suffix}`;
  const otherEmployeeId = `emp-other-${suffix}`;
  const people = ["owner", "manager", "collab", "viewer", "outsider"].map((name) => ({
    name,
    userId: `emp-user-${name}-${suffix}`,
    spaceId: `emp-space-${name}-${suffix}`,
    botId: `emp-bot-${name}-${suffix}`,
    threadId: `emp-thread-${name}-${suffix}`,
  }));
  const by = Object.fromEntries(people.map((p) => [p.name, p])) as Record<
    string,
    (typeof people)[0]
  >;
  const tenant = (name: string) => ({ spaceId: by[name]!.spaceId, userId: by[name]!.userId });
  let owner: ReturnType<typeof createDb>;
  let app: ReturnType<typeof createDb>;
  let db: PrismaClient;
  let sys: PrismaClient;

  beforeAll(async () => {
    owner = createDb(migrationUrl!);
    app = createDb(runtimeUrl!, { poolMax: 4 });
    db = app.prisma;
    sys = asSystem(owner.prisma);
    const o = sys;
    await o.organization.create({
      data: { id: organizationId, name: "Employees", slug: organizationId, createdAt: new Date() },
    });
    for (const p of people) {
      await o.user.create({
        data: { id: p.userId, name: p.name, email: `${p.userId}@rakazo.test`, emailVerified: true },
      });
      await o.space.create({ data: { id: p.spaceId, organizationId, name: p.name } });
    }
    for (const id of [employeeId, otherEmployeeId]) {
      await o.employee.create({
        data: { id, name: id, createdByUserId: by.owner!.userId, status: "published" },
      });
      await o.employeeVersion.create({
        data: { employeeId: id, number: 1, createdBy: by.owner!.userId },
      });
    }
    const roles = [
      ["owner", "owner"],
      ["manager", "manager"],
      ["collab", "collaborator"],
      ["viewer", "viewer"],
    ] as const;
    for (const [name, role] of roles) {
      await o.employeeGrant.create({
        data: {
          employeeId,
          subjectKind: "user",
          subjectValue: by[name]!.userId,
          role,
          grantedBy: by.owner!.userId,
        },
      });
      await o.employeeEntitlement.create({
        data: { employeeId, userId: by[name]!.userId, role, source: "grant" },
      });
    }
    await o.employeeGrant.create({
      data: {
        employeeId,
        subjectKind: "claim",
        subjectValue: "group-eng",
        role: "collaborator",
        grantedBy: by.owner!.userId,
      },
    });
    for (const p of people) {
      await o.userDirectoryClaim.create({
        data: { userId: p.userId, values: [`group-${p.name}`] },
      });
    }
    // The Collaborator and the Manager each run their own instance of the employee.
    for (const name of ["collab", "manager"]) {
      const p = by[name]!;
      await o.bot.create({
        data: {
          id: p.botId,
          spaceId: p.spaceId,
          userId: p.userId,
          name,
          color: "#000",
          employeeId,
        },
      });
      await o.thread.create({
        data: { id: p.threadId, spaceId: p.spaceId, userId: p.userId, botId: p.botId },
      });
      await o.message.create({
        data: { threadId: p.threadId, seq: 1, role: "user", blocks: [{ text: `private ${name}` }] },
      });
    }
  });

  afterAll(async () => {
    if (!owner) return;
    await sys.employee.deleteMany({
      where: { id: { in: [employeeId, otherEmployeeId] } },
    });
    await sys.organization.deleteMany({ where: { id: organizationId } });
    await sys.user.deleteMany({ where: { id: { in: people.map((p) => p.userId) } } });
    for (const handle of [owner, app]) {
      await handle.prisma.$disconnect();
      await handle.pool.end();
    }
  });

  const employeesFor = (name: string) =>
    runAsTenant(tenant(name), () =>
      db.employee.findMany({
        where: { id: { in: [employeeId, otherEmployeeId] } },
        select: { id: true },
      }),
    ).then((rows) => rows.map((row) => row.id));

  it("shows an employee, its versions and entitlements only to entitled users", async () => {
    for (const name of ["owner", "manager", "collab", "viewer"]) {
      expect(await employeesFor(name)).toEqual([employeeId]);
      const versions = await runAsTenant(tenant(name), () =>
        db.employeeVersion.findMany({ where: { employeeId } }),
      );
      expect(versions).toHaveLength(1);
    }
    expect(await employeesFor("outsider")).toEqual([]);
    const versions = await runAsTenant(tenant("outsider"), () =>
      db.employeeVersion.findMany({ where: { employeeId } }),
    );
    expect(versions).toEqual([]);
  });

  it("returns nothing without a context", async () => {
    expect(await db.employee.findMany({ where: { id: employeeId } }).catch(() => [])).toEqual([]);
    expect(
      await db.employeeEntitlement.findMany({ where: { employeeId } }).catch(() => []),
    ).toEqual([]);
    // The client reports the missing context in CI; this test is that case on purpose.
    drainUnscopedDatabaseAccess();
  });

  it("limits entitlements and directory claims to the user's own rows", async () => {
    for (const p of people) {
      const entitlements = await runAsTenant(tenant(p.name), () =>
        db.employeeEntitlement.findMany({ where: { employeeId } }),
      );
      expect(entitlements.every((row) => row.userId === p.userId)).toBe(true);
      const claims = await runAsTenant(tenant(p.name), () => db.userDirectoryClaim.findMany());
      expect(claims.map((row) => row.userId).filter((id) => id.endsWith(suffix))).toEqual([
        p.userId,
      ]);
    }
  });

  it("shows grants to owners and managers, and to others only their own", async () => {
    const grantsFor = (name: string) =>
      runAsTenant(tenant(name), () =>
        db.employeeGrant.findMany({ where: { employeeId }, select: { subjectValue: true } }),
      ).then((rows) => rows.map((row) => row.subjectValue).sort());
    expect(await grantsFor("owner")).toHaveLength(5);
    expect(await grantsFor("manager")).toHaveLength(5);
    expect(await grantsFor("collab")).toEqual([by.collab!.userId]);
    expect(await grantsFor("viewer")).toEqual([by.viewer!.userId]);
    expect(await grantsFor("outsider")).toEqual([]);
  });

  it("lets a tenant read but never write employee tables", async () => {
    const writes: Array<() => Promise<unknown>> = [
      () => db.employee.create({ data: { name: "x", createdByUserId: by.owner!.userId } }),
      () => db.employee.update({ where: { id: employeeId }, data: { name: "renamed" } }),
      () =>
        db.employeeVersion.update({
          where: { employeeId_number: { employeeId, number: 1 } },
          data: { role: "x" },
        }),
      () =>
        db.employeeGrant.create({
          data: {
            employeeId,
            subjectKind: "user",
            subjectValue: by.outsider!.userId,
            role: "viewer",
            grantedBy: by.owner!.userId,
          },
        }),
      () =>
        db.employeeEntitlement.create({
          data: { employeeId, userId: by.outsider!.userId, role: "owner", source: "grant" },
        }),
      () =>
        db.userDirectoryClaim.update({
          where: { userId: by.owner!.userId },
          data: { values: ["x"] },
        }),
    ];
    for (const attempt of writes) {
      // The owner and manager are the strongest roles: still no write through a tenant.
      await runAsTenant(tenant("owner"), async () => {
        await expect(attempt().then((r) => r)).rejects.toThrow();
      });
    }
    const [row] = await sys.employee.findMany({ where: { id: employeeId } });
    expect(row?.name).toBe(employeeId);
    expect(await sys.employeeEntitlement.count({ where: { userId: by.outsider!.userId } })).toBe(0);
  });

  it("lets the system context write", async () => {
    await runAsSystem("employee test", async () => {
      await db.employee.update({ where: { id: otherEmployeeId }, data: { description: "d" } });
    });
    const row = await sys.employee.findUnique({ where: { id: otherEmployeeId } });
    expect(row?.description).toBe("d");
  });

  it("gives a manager no path to another user's instance content", async () => {
    const asManager = <T>(fn: () => Promise<T>) => runAsTenant(tenant("manager"), fn);
    const c = by.collab!;
    expect(await asManager(() => db.bot.findFirst({ where: { id: c.botId } }))).toBeNull();
    expect(await asManager(() => db.thread.findFirst({ where: { id: c.threadId } }))).toBeNull();
    expect(await asManager(() => db.message.findMany({ where: { threadId: c.threadId } }))).toEqual(
      [],
    );
    // Even asking for the whole employee returns only the manager's own instance.
    const bots = await asManager(() => db.bot.findMany({ where: { employeeId } }));
    expect(bots.map((bot) => bot.userId)).toEqual([by.manager!.userId]);
    const threads = await asManager(() => db.thread.findMany({ where: { bot: { employeeId } } }));
    expect(threads.map((thread) => thread.userId)).toEqual([by.manager!.userId]);
  });

  it("allows one instance per user per employee", async () => {
    const p = by.collab!;
    await expect(
      sys.bot.create({
        data: { spaceId: p.spaceId, userId: p.userId, name: "dup", color: "#000", employeeId },
      }),
    ).rejects.toThrow(/Unique constraint/);
    // Private bots (no employee) are unaffected.
    await sys.bot.createMany({
      data: [
        { id: `${p.botId}-p1`, spaceId: p.spaceId, userId: p.userId, name: "p1", color: "#000" },
        { id: `${p.botId}-p2`, spaceId: p.spaceId, userId: p.userId, name: "p2", color: "#000" },
      ],
    });
  });

  it("rejects bad roles and claim-sourced Owner at the database", async () => {
    const base = { employeeId, grantedBy: by.owner!.userId, subjectKind: "claim" };
    await expect(
      sys.employeeGrant.create({ data: { ...base, subjectValue: "g", role: "owner" } }),
    ).rejects.toThrow();
    await expect(
      sys.employeeGrant.create({ data: { ...base, subjectValue: "g", role: "admin" } }),
    ).rejects.toThrow();
    await expect(
      sys.employeeEntitlement.create({
        data: { employeeId, userId: by.outsider!.userId, role: "owner", source: "claim" },
      }),
    ).rejects.toThrow();
  });

  it("keeps instances when an employee is deleted", async () => {
    const id = `emp-delete-${suffix}`;
    const p = by.outsider!;
    await sys.employee.create({ data: { id, name: id, createdByUserId: p.userId } });
    await sys.bot.create({
      data: {
        id: `${p.botId}-i`,
        spaceId: p.spaceId,
        userId: p.userId,
        name: "i",
        color: "#000",
        employeeId: id,
      },
    });
    await sys.employee.delete({ where: { id } });
    const bot = await sys.bot.findUnique({ where: { id: `${p.botId}-i` } });
    expect(bot?.employeeId).toBeNull();
  });
});
