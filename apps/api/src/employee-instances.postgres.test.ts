import { randomUUID } from "node:crypto";
import { resolveEmployeeRun } from "@rakazo/adapters";
import type { Actor } from "@rakazo/contracts";
import {
  EMPLOYEE_ACCESS_REMOVED_MESSAGE,
  EMPLOYEE_SUSPENDED_MESSAGE,
  EMPLOYEE_UNAVAILABLE_MESSAGE,
} from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import {
  asSystem,
  createDb,
  createRepos,
  installSecurityEventStore,
  runAsTenant,
} from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addInstance } from "./employee-instances.js";
import {
  publishVersion,
  removeGrant,
  rollbackVersion,
  saveDraft,
  setGrant,
  shareBot,
} from "./employees.js";

const databaseUrl = process.env.DATABASE_URL;
const enabled = process.env.VERIFY_DATABASE === "1" && Boolean(databaseUrl);

const NAMES = ["owner", "alice", "viewer", "outsider"] as const;
type Name = (typeof NAMES)[number];

describe.skipIf(!enabled)("shared employee instances (PostgreSQL, runtime role)", () => {
  const suffix = randomUUID().slice(0, 8);
  const organizationId = `emp4-org-${suffix}`;
  let prisma: PrismaClient;
  let system: PrismaClient;
  let close: () => Promise<void>;
  let employeeId: string;
  let flagOn = false;
  const actors = {} as Record<Name, Actor>;
  const botIds = {} as Record<Name, string>;

  const as = <T>(name: Name, fn: (actor: Actor) => Promise<T>) =>
    runAsTenant(actors[name], () => fn(actors[name]));
  const code = async (promise: Promise<unknown>) => {
    try {
      await promise;
      return "ok";
    } catch (error) {
      return (error as { code?: string }).code ?? "error";
    }
  };
  const add = (name: Name) =>
    as(name, (actor) =>
      addInstance(
        { prisma, env: { sharedEmployeesEnabled: flagOn } as never },
        createRepos(prisma, {}),
        actor,
        { employeeId },
      ),
    );
  const userId = (name: Name) => actors[name].userId;
  const instanceOf = (name: Name) =>
    system.bot.findFirstOrThrow({ where: { employeeId, userId: userId(name) } });
  const run = async (name: Name) => resolveEmployeeRun(system, await instanceOf(name));

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
      data: { id: organizationId, name: "Instances", slug: organizationId, createdAt: new Date() },
    });
    for (const name of NAMES) {
      const id = `emp4-${name}-${suffix}`;
      const spaceId = `emp4-space-${name}-${suffix}`;
      await system.user.create({
        data: { id, name, email: `${id}@rakazo.test`, emailVerified: true },
      });
      const createdAt = new Date();
      await system.member.create({
        data: { id: `${id}-member`, organizationId, userId: id, role: "member", createdAt },
      });
      await system.space.create({
        data: { id: spaceId, organizationId, name, createdByUserId: id },
      });
      await system.spaceMember.create({
        data: { id: `${spaceId}-member`, spaceId, organizationId, userId: id, createdAt },
      });
      actors[name] = { userId: id, spaceId, email: `${id}@rakazo.test`, isDeploymentOwner: false };
      botIds[name] = `emp4-bot-${name}-${suffix}`;
      await system.bot.create({
        data: {
          id: botIds[name],
          spaceId,
          userId: id,
          name: `${name} bot`,
          description: "Answers invoices",
          instructions: name === "owner" ? "Definition v1" : `Private notes of ${name}`,
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
        where: { userId: { in: NAMES.map((name) => `emp4-${name}-${suffix}`) } },
      });
      await system.employee.deleteMany({ where: { createdByUserId: { startsWith: "emp4-" } } });
      await system.organization.deleteMany({ where: { id: organizationId } });
      await system.user.deleteMany({
        where: { id: { startsWith: "emp4-" }, email: { endsWith: "@rakazo.test" } },
      });
    }
    await close?.();
  });

  it("starts with the owner's own bot as the first instance", async () => {
    ({ employeeId } = await as("owner", (actor) =>
      shareBot({ prisma }, actor, { botId: botIds.owner }),
    ));
    await as("owner", (actor) =>
      setGrant({ prisma }, actor, {
        employeeId,
        subjectKind: "user",
        subjectValue: userId("alice"),
        role: "collaborator",
      }),
    );
    await as("owner", (actor) =>
      setGrant({ prisma }, actor, {
        employeeId,
        subjectKind: "user",
        subjectValue: userId("viewer"),
        role: "viewer",
      }),
    );
    // The feature is off: the owner still has their instance, and asking again just returns it.
    expect(await add("owner")).toEqual({ botId: botIds.owner, created: false });
  });

  it("refuses to create an instance while the flag is off, and for people who may not use it", async () => {
    expect(await code(add("alice"))).toBe("FORBIDDEN");
    expect(await system.bot.count({ where: { employeeId, userId: userId("alice") } })).toBe(0);
    flagOn = true;
    expect(await code(add("outsider"))).toBe("NOT_FOUND");
    expect(await code(add("viewer"))).toBe("FORBIDDEN");
    expect(await system.bot.count({ where: { employeeId } })).toBe(1);
  });

  it("creates one instance in the person's own space, once, even under concurrent requests", async () => {
    const results = await Promise.all([add("alice"), add("alice"), add("alice")]);
    expect(new Set(results.map((result) => result.botId)).size).toBe(1);
    expect(results.filter((result) => result.created)).toHaveLength(1);
    const instance = await instanceOf("alice");
    expect(instance).toMatchObject({
      userId: userId("alice"),
      spaceId: actors.alice.spaceId,
      employeeId,
      instructions: "",
      crossSpaceCommunication: false,
      memoryScope: "isolated",
    });
    expect(await system.bot.count({ where: { employeeId, userId: userId("alice") } })).toBe(1);
    expect(await add("alice")).toEqual({ botId: instance.id, created: false });
    // Her instance has its own thread, memory and computer: nothing of the owner's moved.
    const thread = await system.thread.findFirstOrThrow({ where: { botId: instance.id } });
    expect(thread.userId).toBe(userId("alice"));
    expect(await system.message.count({ where: { threadId: thread.id } })).toBe(0);
    expect(instance.computerId).not.toBe((await instanceOf("owner")).computerId);
    const events = await system.securityEvent.findMany({
      where: { type: "employee.instance_created", userId: userId("alice") },
    });
    expect(events).toHaveLength(1);
    expect(events[0]!.metadata).toEqual({ employeeId, botId: instance.id });
  });

  it("keeps each person's threads, memory and bot rows invisible to the other", async () => {
    const aliceBot = await instanceOf("alice");
    await system.memoryDocument.create({
      data: {
        spaceId: actors.alice.spaceId,
        userId: userId("alice"),
        botId: aliceBot.id,
        scope: "bot",
        path: "alice.md",
        content: "alice private memory",
      },
    });
    const seen = (name: Name) =>
      as(name, async () => ({
        bots: (await prisma.bot.findMany({ where: { employeeId } })).map((bot) => bot.userId),
        threads: (await prisma.thread.findMany({ where: { bot: { employeeId } } })).map(
          (thread) => thread.userId,
        ),
        messages: await prisma.message.count({ where: { thread: { bot: { employeeId } } } }),
        memory: (await prisma.memoryDocument.findMany({ where: { bot: { employeeId } } })).map(
          (doc) => doc.content,
        ),
        computers: (
          await prisma.computer.findMany({
            where: {
              id: { in: [aliceBot.computerId ?? "", (await instanceOf("owner")).computerId ?? ""] },
            },
          })
        ).map((computer) => computer.userId),
      }));
    expect(await seen("owner")).toEqual({
      bots: [userId("owner")],
      threads: [userId("owner")],
      messages: 1,
      memory: ["memory of owner"],
      computers: expect.not.arrayContaining([userId("alice")]),
    });
    const alice = await seen("alice");
    expect(alice.bots).toEqual([userId("alice")]);
    expect(alice.threads).toEqual([userId("alice")]);
    expect(alice.messages).toBe(0);
    expect(alice.memory).toEqual(expect.not.arrayContaining(["memory of owner"]));
    expect(alice.memory).toContain("alice private memory");
    expect(alice.computers).not.toContain(userId("owner"));
  });

  it("runs the instance with the published definition on top of the person's own state", async () => {
    const owner = await run("owner");
    expect(owner.ok && owner.composed.instructions).toBe("Definition v1");
    await system.bot.update({
      where: { id: (await instanceOf("alice")).id },
      data: { instructions: "Call me Alice." },
    });
    const alice = await run("alice");
    expect(alice.ok).toBe(true);
    if (!alice.ok) return;
    expect(alice.composed).toMatchObject({
      description: "Answers invoices",
      crossSpaceCommunication: false,
      memoryScope: "isolated",
    });
    expect(alice.composed.instructions).toContain("Definition v1");
    expect(alice.composed.instructions).toContain("Call me Alice.");
    expect(alice.composed.instructions).not.toContain("Private notes of owner");
    const seen = (await instanceOf("alice")).employeeVersionSeen;
    expect(seen).toBe(
      (await system.employee.findUniqueOrThrow({ where: { id: employeeId } })).currentVersionId,
    );
  });

  it("picks up a new published version on the next run, and a rollback the same way", async () => {
    const { id: draftId } = await as("owner", (actor) =>
      saveDraft({ prisma }, actor, { employeeId, instructions: "Definition v2" }),
    );
    // A draft is not seen by anyone yet.
    const before = await run("alice");
    expect(before.ok && before.composed.instructions).toContain("Definition v1");
    await as("owner", (actor) =>
      publishVersion({ prisma }, actor, { employeeId, versionId: draftId }),
    );
    const after = await run("alice");
    expect(after.ok && after.composed.instructions).toContain("Definition v2");
    expect((await instanceOf("alice")).employeeVersionSeen).toBe(draftId);
    const first = await system.employeeVersion.findFirstOrThrow({
      where: { employeeId, number: 1 },
    });
    await as("owner", (actor) =>
      rollbackVersion({ prisma }, actor, { employeeId, versionId: first.id }),
    );
    const rolledBack = await run("alice");
    expect(rolledBack.ok && rolledBack.composed.instructions).toContain("Definition v1");
    expect((await instanceOf("alice")).employeeVersionSeen).toBe(first.id);
  });

  it("refuses the next run when access is removed, and keeps the person's data", async () => {
    const aliceBot = await instanceOf("alice");
    await as("owner", (actor) =>
      removeGrant({ prisma }, actor, {
        employeeId,
        subjectKind: "user",
        subjectValue: userId("alice"),
      }),
    );
    expect(await run("alice")).toEqual({ ok: false, message: EMPLOYEE_ACCESS_REMOVED_MESSAGE });
    // Creating another instance is refused too, but the existing one and all it holds stay.
    expect(await code(add("alice"))).toBe("NOT_FOUND");
    expect(await system.bot.findUnique({ where: { id: aliceBot.id } })).not.toBeNull();
    expect(
      await as("alice", () => prisma.memoryDocument.count({ where: { botId: aliceBot.id } })),
    ).toBeGreaterThan(0);
    expect(await as("alice", () => prisma.thread.count({ where: { botId: aliceBot.id } }))).toBe(1);

    // Granting access again lets the same instance run.
    await as("owner", (actor) =>
      setGrant({ prisma }, actor, {
        employeeId,
        subjectKind: "user",
        subjectValue: userId("alice"),
        role: "collaborator",
      }),
    );
    expect((await run("alice")).ok).toBe(true);
    expect(await add("alice")).toEqual({ botId: aliceBot.id, created: false });
  });

  it("refuses runs while the employee is suspended or retired", async () => {
    await system.employee.update({ where: { id: employeeId }, data: { suspendedAt: new Date() } });
    expect(await run("alice")).toEqual({ ok: false, message: EMPLOYEE_SUSPENDED_MESSAGE });
    expect(await run("owner")).toEqual({ ok: false, message: EMPLOYEE_SUSPENDED_MESSAGE });
    expect(await code(add("viewer"))).toBe("FORBIDDEN");
    await system.employee.update({
      where: { id: employeeId },
      data: { suspendedAt: null, status: "retired" },
    });
    expect(await run("alice")).toEqual({ ok: false, message: EMPLOYEE_UNAVAILABLE_MESSAGE });
    await system.employee.update({ where: { id: employeeId }, data: { status: "published" } });
    expect((await run("alice")).ok).toBe(true);
  });
});
