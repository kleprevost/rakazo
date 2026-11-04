import { randomUUID } from "node:crypto";
import type { Actor, EmployeeRole } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import {
  asSystem,
  createDb,
  installSecurityEventStore,
  recordDirectoryClaims,
  runAsTenant,
} from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  getEmployee,
  listEmployees,
  listGrants,
  publishVersion,
  removeGrant,
  rollbackVersion,
  saveDraft,
  setGrant,
  shareBot,
} from "./employees.js";

const databaseUrl = process.env.DATABASE_URL;
const enabled = process.env.VERIFY_DATABASE === "1" && Boolean(databaseUrl);

const NAMES = ["owner", "manager", "collab", "viewer", "outsider", "second"] as const;
type Name = (typeof NAMES)[number];

describe.skipIf(!enabled)("shared employees API (PostgreSQL)", () => {
  const suffix = randomUUID().slice(0, 8);
  const organizationId = `emp3-org-${suffix}`;
  let prisma: PrismaClient;
  let system: PrismaClient;
  let close: () => Promise<void>;
  let employeeId: string;
  const actors = {} as Record<Name, Actor>;
  const botIds = {} as Record<Name, string>;

  /** Runs like the router does: under the caller's own tenant scope. */
  const as = <T>(name: Name, fn: (deps: { prisma: PrismaClient }, actor: Actor) => Promise<T>) =>
    runAsTenant(actors[name], () => fn({ prisma }, actors[name]));
  const outcome = async (promise: Promise<unknown>) => {
    try {
      await promise;
      return "ok";
    } catch (error) {
      return (error as { code?: string }).code ?? "error";
    }
  };
  const entitlements = async () =>
    (await system.employeeEntitlement.findMany({ where: { employeeId } }))
      .map((row) => `${row.userId.split("-")[1]}:${row.source}:${row.role}`)
      .sort();
  const grant = (
    actor: Name,
    subjectKind: "user" | "claim",
    subjectValue: string,
    role: EmployeeRole,
    expiresAt?: string,
  ) =>
    as(actor, (deps, a) =>
      setGrant(deps, a, { employeeId, subjectKind, subjectValue, role, expiresAt }),
    );
  const userId = (name: Name) => actors[name].userId;

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
        name: "Employees API",
        slug: organizationId,
        createdAt: new Date(),
      },
    });
    for (const name of NAMES) {
      const id = `emp3-${name}-${suffix}`;
      const spaceId = `emp3-space-${name}-${suffix}`;
      await system.user.create({
        data: { id, name, email: `${id}@rakazo.test`, emailVerified: true },
      });
      await system.space.create({ data: { id: spaceId, organizationId, name } });
      actors[name] = { userId: id, spaceId, email: `${id}@rakazo.test`, isDeploymentOwner: false };
      botIds[name] = `emp3-bot-${name}-${suffix}`;
      await system.bot.create({
        data: {
          id: botIds[name],
          spaceId,
          userId: id,
          name: `${name} bot`,
          description: "Answers invoices",
          instructions: `Private instructions of ${name}`,
          color: "#000",
        },
      });
      const thread = await system.thread.create({
        data: { spaceId, userId: id, botId: botIds[name] },
      });
      await system.message.create({
        data: { threadId: thread.id, seq: 1, role: "user", blocks: [{ text: `secret ${name}` }] },
      });
      await system.memoryDocument.create({
        data: {
          spaceId,
          userId: id,
          botId: botIds[name],
          scope: "bot",
          path: "notes.md",
          content: `memory of ${name}`,
        },
      });
    }
  });

  afterAll(async () => {
    if (system) {
      await system.securityEvent.deleteMany({
        where: { userId: { in: NAMES.map((name) => `emp3-${name}-${suffix}`) } },
      });
      await system.employee.deleteMany({ where: { createdByUserId: { startsWith: "emp3-" } } });
      await system.organization.deleteMany({ where: { id: organizationId } });
      await system.user.deleteMany({
        where: { id: { startsWith: "emp3-" }, email: { endsWith: "@rakazo.test" } },
      });
    }
    await close?.();
  });

  it("shares a bot in place: the owner keeps the same bot, thread and memory", async () => {
    const before = await system.bot.findUniqueOrThrow({ where: { id: botIds.owner } });
    const { employeeId: created } = await as("owner", (deps, a) =>
      shareBot(deps, a, { botId: botIds.owner }),
    );
    employeeId = created;

    const after = await system.bot.findUniqueOrThrow({ where: { id: botIds.owner } });
    expect(after).toMatchObject({ id: before.id, employeeId, instructions: before.instructions });
    expect(await system.thread.count({ where: { botId: botIds.owner } })).toBe(1);
    expect(await system.message.count({ where: { thread: { botId: botIds.owner } } })).toBe(1);
    expect(
      (await system.memoryDocument.findFirstOrThrow({ where: { botId: botIds.owner } })).content,
    ).toBe("memory of owner");

    const versions = await system.employeeVersion.findMany({ where: { employeeId } });
    expect(versions).toHaveLength(1);
    expect(versions[0]).toMatchObject({
      number: 1,
      state: "published",
      instructions: "Private instructions of owner",
      role: "Answers invoices",
    });
    expect(
      (await system.employee.findUniqueOrThrow({ where: { id: employeeId } })).currentVersionId,
    ).toBe(versions[0]!.id);
    expect(await entitlements()).toEqual(["owner:grant:owner"]);

    // Ids only: no instructions, names or memory reach the event.
    const events = await system.securityEvent.findMany({
      where: { type: "employee.shared", userId: userId("owner") },
    });
    expect(events).toHaveLength(1);
    expect(events[0]!.metadata).toEqual({ employeeId, botId: botIds.owner });
  });

  it("refuses to share twice, or a bot that is not the caller's", async () => {
    expect(
      await outcome(as("owner", (deps, a) => shareBot(deps, a, { botId: botIds.owner }))),
    ).toBe("CONFLICT");
    expect(
      await outcome(as("manager", (deps, a) => shareBot(deps, a, { botId: botIds.owner }))),
    ).toBe("NOT_FOUND");
    expect(await system.employee.count({ where: { createdByUserId: userId("manager") } })).toBe(0);
  });

  it("lets only an Owner add managers, and a claim never confers Owner", async () => {
    // Fixture: the Owner adds each role. Every grant reconciles entitlements before returning.
    for (const [name, role] of [
      ["manager", "manager"],
      ["collab", "collaborator"],
      ["viewer", "viewer"],
    ] as const) {
      await grant("owner", "user", userId(name), role);
    }
    expect(await entitlements()).toEqual([
      "collab:grant:collaborator",
      "manager:grant:manager",
      "owner:grant:owner",
      "viewer:grant:viewer",
    ]);

    expect(await outcome(grant("manager", "user", userId("outsider"), "manager"))).toBe(
      "FORBIDDEN",
    );
    expect(await outcome(grant("manager", "user", userId("outsider"), "owner"))).toBe("FORBIDDEN");
    expect(await outcome(grant("manager", "user", userId("owner"), "viewer"))).toBe("FORBIDDEN");
    expect(await outcome(grant("manager", "claim", "group-ops", "manager"))).toBe("FORBIDDEN");
    expect(await outcome(grant("owner", "claim", "group-ops", "owner"))).toBe("FORBIDDEN");
    expect(await system.employeeGrant.count({ where: { employeeId, subjectKind: "claim" } })).toBe(
      0,
    );

    // A Manager may manage the lower tiers.
    expect(await outcome(grant("manager", "user", userId("outsider"), "viewer"))).toBe("ok");
    expect(
      await outcome(
        as("manager", (d, a) =>
          removeGrant(d, a, { employeeId, subjectKind: "user", subjectValue: userId("outsider") }),
        ),
      ),
    ).toBe("ok");
    expect(
      await outcome(grant("owner", "user", userId("outsider"), "viewer", "2000-01-01T00:00:00Z")),
    ).toBe("BAD_REQUEST");
    expect(
      await outcome(grant("owner", "user", userId("second"), "owner", "2099-01-01T00:00:00Z")),
    ).toBe("BAD_REQUEST");
    expect(await outcome(grant("owner", "user", "no-such-user", "viewer"))).toBe("NOT_FOUND");
    expect(await entitlements()).not.toContain("outsider:grant:viewer");
  });

  it("answers every procedure by role: Owner, Manager, Collaborator, Viewer, none", async () => {
    const draft = await as("owner", (d, a) =>
      saveDraft(d, a, { employeeId, instructions: "v2 text" }),
    );
    const roster: Name[] = ["outsider", "viewer", "collab", "manager", "owner"];
    const expectations: Record<string, string[]> = {
      // none, viewer, collaborator, manager, owner
      get: ["NOT_FOUND", "ok", "ok", "ok", "ok"],
      saveDraft: ["NOT_FOUND", "FORBIDDEN", "FORBIDDEN", "ok", "ok"],
      publishDenied: ["NOT_FOUND", "FORBIDDEN", "FORBIDDEN"],
      listGrants: ["NOT_FOUND", "FORBIDDEN", "FORBIDDEN", "ok", "ok"],
      setGrant: ["NOT_FOUND", "FORBIDDEN", "FORBIDDEN", "ok", "ok"],
      removeGrant: ["NOT_FOUND", "FORBIDDEN", "FORBIDDEN", "ok", "ok"],
    };
    const run: Record<string, (name: Name) => Promise<unknown>> = {
      get: (n) => as(n, (d, a) => getEmployee(d, a, employeeId)),
      saveDraft: (n) => as(n, (d, a) => saveDraft(d, a, { employeeId, role: "Billing" })),
      listGrants: (n) => as(n, (d, a) => listGrants(d, a, employeeId)),
      setGrant: (n) => grant(n, "user", userId("second"), "viewer"),
      removeGrant: (n) =>
        as(n, (d, a) =>
          removeGrant(d, a, { employeeId, subjectKind: "user", subjectValue: userId("second") }),
        ),
    };
    for (const [procedure, expected] of Object.entries(expectations)) {
      if (procedure === "publishDenied") continue;
      const results = [];
      for (const name of roster) results.push(await outcome(run[procedure]!(name)));
      expect(results, procedure).toEqual(expected);
    }
    // Publish and rollback: the three roles below Manager and strangers are refused first.
    for (const name of ["outsider", "viewer", "collab"] as const) {
      const code = name === "outsider" ? "NOT_FOUND" : "FORBIDDEN";
      expect(
        await outcome(
          as(name, (d, a) => publishVersion(d, a, { employeeId, versionId: draft.id })),
        ),
      ).toBe(code);
      expect(
        await outcome(
          as(name, (d, a) => rollbackVersion(d, a, { employeeId, versionId: draft.id })),
        ),
      ).toBe(code);
    }
    expect(
      await outcome(
        as("manager", (d, a) => publishVersion(d, a, { employeeId, versionId: draft.id })),
      ),
    ).toBe("ok");
    const v1 = await system.employeeVersion.findFirstOrThrow({ where: { employeeId, number: 1 } });
    expect(
      await outcome(
        as("collab", (d, a) => rollbackVersion(d, a, { employeeId, versionId: v1.id })),
      ),
    ).toBe("FORBIDDEN");
    expect(
      await outcome(
        as("manager", (d, a) => rollbackVersion(d, a, { employeeId, versionId: v1.id })),
      ),
    ).toBe("ok");
    const rolled = await as("owner", (d, a) => getEmployee(d, a, employeeId));
    expect(rolled.employee.currentVersion).toBe(1);

    // The list shows only what the caller is entitled to.
    expect(await as("outsider", (d, a) => listEmployees(d, a))).toEqual([]);
    expect((await as("viewer", (d, a) => listEmployees(d, a))).map((card) => card.role)).toEqual([
      "viewer",
    ]);
    expect((await as("manager", (d, a) => listEmployees(d, a))).map((card) => card.id)).toEqual([
      employeeId,
    ]);
  });

  it("keeps versions immutable once published, and edits open the next draft", async () => {
    const view = await as("owner", (d, a) => getEmployee(d, a, employeeId));
    const numbers = view.versions!.map((version) => [
      version.number,
      version.state,
      version.current,
    ]);
    expect(numbers).toEqual([
      [2, "published", false],
      [1, "published", true],
    ]);
    const next = await as("manager", (d, a) =>
      saveDraft(d, a, { employeeId, instructions: "v3 text" }),
    );
    expect(next).toMatchObject({
      number: 3,
      state: "draft",
      instructions: "v3 text",
      role: "Answers invoices",
    });
    const again = await as("manager", (d, a) => saveDraft(d, a, { employeeId, role: "Support" }));
    expect(again).toMatchObject({
      id: next.id,
      number: 3,
      role: "Support",
      instructions: "v3 text",
    });
    expect(
      (await system.employeeVersion.findFirstOrThrow({ where: { employeeId, number: 2 } }))
        .instructions,
    ).toBe("v2 text");
    expect(
      await outcome(
        as("owner", (d, a) => publishVersion(d, a, { employeeId, versionId: next.id })),
      ),
    ).toBe("ok");
    expect(
      await outcome(
        as("owner", (d, a) => publishVersion(d, a, { employeeId, versionId: next.id })),
      ),
    ).toBe("CONFLICT");
    expect(
      await outcome(
        as("owner", (d, a) => rollbackVersion(d, a, { employeeId, versionId: "missing" })),
      ),
    ).toBe("NOT_FOUND");
    const events = await system.securityEvent.findMany({
      where: { type: "employee.version_published", userId: userId("owner") },
    });
    expect(events.length).toBeGreaterThan(0);
    expect(Object.keys(events[0]!.metadata as object).sort()).toEqual([
      "change",
      "employeeId",
      "number",
      "versionId",
    ]);
  });

  it("gives a Collaborator the card, never the definition or anyone's instance", async () => {
    const view = await as("collab", (d, a) => getEmployee(d, a, employeeId));
    expect(view.versions).toBeNull();
    expect(JSON.stringify(view)).not.toContain("Private instructions");
    // Even an Owner or Manager reads no other person's thread, messages or memory.
    for (const name of ["owner", "manager"] as const) {
      const seen = await runAsTenant(actors[name], async () => ({
        bots: await prisma.bot.findMany({ where: { id: botIds.collab } }),
        messages: await prisma.message.findMany({ where: { thread: { botId: botIds.collab } } }),
        memory: await prisma.memoryDocument.findMany({ where: { botId: botIds.collab } }),
      }));
      expect(seen).toEqual({ bots: [], messages: [], memory: [] });
    }
    // Sharing converted the owner's bot only; nobody else's bot was touched.
    expect(
      (await system.bot.findUniqueOrThrow({ where: { id: botIds.collab } })).employeeId,
    ).toBeNull();
  });

  it("applies grant changes to entitlements through the API, for users and claims", async () => {
    expect(await outcome(grant("owner", "claim", "group-eng", "collaborator"))).toBe("ok");
    // Not signed in yet: the group confers nothing.
    expect(await entitlements()).not.toContain("outsider:claim:collaborator");

    await recordDirectoryClaims(prisma, userId("outsider"), { values: ["group-eng"] });
    expect(await entitlements()).toContain("outsider:claim:collaborator");
    expect((await as("outsider", (d, a) => getEmployee(d, a, employeeId))).employee.role).toBe(
      "collaborator",
    );

    // Changing the grant's role moves the people carrying the claim.
    await grant("owner", "claim", "group-eng", "viewer");
    expect(await entitlements()).toContain("outsider:claim:viewer");

    // A truncated claim list fails closed.
    await recordDirectoryClaims(prisma, userId("outsider"), {
      values: ["group-eng"],
      truncated: true,
    });
    expect(await entitlements()).not.toContain("outsider:claim:viewer");
    await recordDirectoryClaims(prisma, userId("outsider"), { values: ["group-eng"] });
    expect(await entitlements()).toContain("outsider:claim:viewer");

    await as("owner", (d, a) =>
      removeGrant(d, a, { employeeId, subjectKind: "claim", subjectValue: "group-eng" }),
    );
    expect(await entitlements()).not.toContain("outsider:claim:viewer");
    expect(await outcome(as("outsider", (d, a) => getEmployee(d, a, employeeId)))).toBe(
      "NOT_FOUND",
    );

    // Removing a user grant removes the entitlement, and repeating it changes nothing.
    await grant("owner", "user", userId("second"), "collaborator");
    expect(await entitlements()).toContain("second:grant:collaborator");
    const remove = () =>
      as("owner", (d, a) =>
        removeGrant(d, a, { employeeId, subjectKind: "user", subjectValue: userId("second") }),
      );
    await remove();
    await remove();
    expect(await entitlements()).not.toContain("second:grant:collaborator");

    const changes = await system.securityEvent.findMany({
      where: {
        type: { in: ["employee.grant_changed", "employee.grant_removed"] },
        userId: userId("owner"),
      },
    });
    expect(changes.length).toBeGreaterThanOrEqual(6);
    // A directory group value never reaches the log.
    expect(JSON.stringify(changes.map((event) => event.metadata))).not.toContain("group-eng");
  });

  it("keeps the last Owner, including when two Owners demote each other at once", async () => {
    const demote = (name: Name, target: Name) => grant(name, "user", userId(target), "manager");
    expect(await outcome(demote("owner", "owner"))).toBe("FORBIDDEN");
    expect(
      await outcome(
        as("owner", (d, a) =>
          removeGrant(d, a, { employeeId, subjectKind: "user", subjectValue: userId("owner") }),
        ),
      ),
    ).toBe("FORBIDDEN");

    await grant("owner", "user", userId("second"), "owner");
    const results = await Promise.all(
      [demote("owner", "second"), demote("second", "owner")].map(outcome),
    );
    expect(results.filter((result) => result === "ok")).toHaveLength(1);
    expect(
      await system.employeeGrant.count({
        where: { employeeId, subjectKind: "user", role: "owner" },
      }),
    ).toBe(1);
  });
});
