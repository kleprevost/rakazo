import { randomUUID } from "node:crypto";
import type { Actor, EmployeeRole } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { asSystem, createDb, installSecurityEventStore, runAsTenant } from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PEOPLE_SEARCH_MIN_QUERY, searchPeople, setGrant, shareBot } from "./employees.js";

const databaseUrl = process.env.DATABASE_URL;
const enabled = process.env.VERIFY_DATABASE === "1" && Boolean(databaseUrl);

const NAMES = ["owner", "manager", "collab", "viewer", "outsider", "other"] as const;
type Name = (typeof NAMES)[number];

describe.skipIf(!enabled)("employees.people.search (PostgreSQL)", () => {
  const suffix = randomUUID().slice(0, 8);
  const organizationId = `ps-org-${suffix}`;
  const needle = `zq${suffix}`;
  let prisma: PrismaClient;
  let system: PrismaClient;
  let close: () => Promise<void>;
  let employeeId: string;
  let otherEmployeeId: string;
  const actors = {} as Record<Name, Actor>;
  const botIds = {} as Record<Name, string>;
  const extraIds: string[] = [];

  const search = (name: Name, q: string, id = employeeId, flag = true) =>
    runAsTenant(actors[name], () =>
      searchPeople({ prisma, env: { sharedEmployeesEnabled: flag } }, actors[name], {
        employeeId: id,
        q,
      }),
    );
  const outcome = async (promise: Promise<unknown>) => {
    try {
      await promise;
      return "ok";
    } catch (error) {
      return (error as { code?: string }).code ?? "error";
    }
  };
  const grant = (name: Name, role: EmployeeRole) =>
    runAsTenant(actors.owner, () =>
      setGrant({ prisma }, actors.owner, {
        employeeId,
        subjectKind: "user",
        subjectValue: actors[name].userId,
        role,
      }),
    );

  beforeAll(async () => {
    const db = createDb(databaseUrl!);
    prisma = db.prisma;
    system = asSystem(prisma);
    installSecurityEventStore(prisma);
    close = async () => {
      installSecurityEventStore(undefined);
      await prisma.$disconnect();
      await db.pool.end();
    };
    await system.organization.create({
      data: {
        id: organizationId,
        name: "People search",
        slug: organizationId,
        createdAt: new Date(),
      },
    });
    for (const name of NAMES) {
      const id = `ps-${name}-${suffix}`;
      const spaceId = `ps-space-${name}-${suffix}`;
      // Everyone is findable by the needle in the name; the email carries it too.
      await system.user.create({
        data: { id, name: `${needle} ${name}`, email: `${id}@rakazo.test`, emailVerified: true },
      });
      await system.space.create({ data: { id: spaceId, organizationId, name } });
      actors[name] = { userId: id, spaceId, email: `${id}@rakazo.test`, isDeploymentOwner: false };
      botIds[name] = `ps-bot-${name}-${suffix}`;
      await system.bot.create({
        data: {
          id: botIds[name],
          spaceId,
          userId: id,
          name: `${name} bot`,
          description: "",
          instructions: "",
          color: "#000",
        },
      });
      await system.thread.create({ data: { spaceId, userId: id, botId: botIds[name] } });
    }
    // More matches than the limit, to prove results are bounded.
    for (let index = 0; index < 12; index++) {
      const id = `ps-extra-${index}-${suffix}`;
      extraIds.push(id);
      await system.user.create({
        data: { id, name: `${needle} extra ${index}`, email: `${id}@rakazo.test` },
      });
    }
    employeeId = (
      await runAsTenant(actors.owner, () =>
        shareBot({ prisma }, actors.owner, { botId: botIds.owner }),
      )
    ).employeeId;
    otherEmployeeId = (
      await runAsTenant(actors.other, () =>
        shareBot({ prisma }, actors.other, { botId: botIds.other }),
      )
    ).employeeId;
    await grant("manager", "manager");
    await grant("collab", "collaborator");
    await grant("viewer", "viewer");
  });

  afterAll(async () => {
    if (system) {
      const ids = [...NAMES.map((name) => `ps-${name}-${suffix}`), ...extraIds];
      await system.securityEvent.deleteMany({ where: { userId: { in: ids } } });
      await system.employee.deleteMany({ where: { createdByUserId: { in: ids } } });
      await system.organization.deleteMany({ where: { id: organizationId } });
      await system.user.deleteMany({ where: { id: { in: ids } } });
    }
    await close?.();
  });

  it("lets an Owner and a Manager search", async () => {
    for (const name of ["owner", "manager"] as const) {
      const found = await search(name, needle);
      expect(found.length, name).toBeGreaterThan(0);
      expect(found.map((person) => person.userId)).not.toContain(actors[name].userId);
    }
  });

  it("refuses a Collaborator, a Viewer, a stranger and another employee's Owner", async () => {
    expect(await outcome(search("collab", needle))).toBe("FORBIDDEN");
    expect(await outcome(search("viewer", needle))).toBe("FORBIDDEN");
    // No entitlement answers as not found, so strangers cannot tell the employee exists.
    expect(await outcome(search("outsider", needle))).toBe("NOT_FOUND");
    expect(await outcome(search("other", needle))).toBe("NOT_FOUND");
    expect(await outcome(search("owner", needle, otherEmployeeId))).toBe("NOT_FOUND");
  });

  it("returns only id, name and email", async () => {
    const found = await search("owner", needle);
    for (const person of found) {
      expect(Object.keys(person).sort()).toEqual(["email", "name", "userId"]);
    }
  });

  it("is bounded and needs a minimum query length", async () => {
    expect((await search("owner", needle)).length).toBeLessThanOrEqual(8);
    expect(await search("owner", "a".repeat(PEOPLE_SEARCH_MIN_QUERY - 1))).toEqual([]);
    expect(await search("owner", "  ab ")).toEqual([]);
    expect(await search("owner", "%")).toEqual([]);
  });

  it("is refused while shared employees are off", async () => {
    expect(await outcome(search("owner", needle, employeeId, false))).toBe("FORBIDDEN");
  });
});
