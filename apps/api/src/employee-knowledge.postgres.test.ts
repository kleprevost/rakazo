import { randomUUID } from "node:crypto";
import { resolveEmployeeRun } from "@rakazo/adapters";
import type { Actor } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { asSystem, createDb, installSecurityEventStore, runAsTenant } from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  decideProposal,
  listKnowledge,
  listOwnProposals,
  listProposals,
  proposeKnowledge,
  retireKnowledge,
  setKnowledge,
  withdrawProposal,
} from "./employee-knowledge.js";
import { setGrant, shareBot } from "./employees.js";

const databaseUrl = process.env.DATABASE_URL;
const enabled = process.env.VERIFY_DATABASE === "1" && Boolean(databaseUrl);

const NAMES = ["owner", "manager", "collab", "second", "viewer", "outsider"] as const;
type Name = (typeof NAMES)[number];

// A planted canary shaped like a real key. It must never reach a proposal, knowledge or an event.
const CANARY = "sk-proj-A1b2C3d4E5f6G7h8I9j0K1l2";

describe.skipIf(!enabled)("employee shared knowledge (PostgreSQL, runtime role)", () => {
  const suffix = randomUUID().slice(0, 8);
  const organizationId = `emp7-org-${suffix}`;
  let prisma: PrismaClient;
  let system: PrismaClient;
  let close: () => Promise<void>;
  let employeeId: string;
  let flagOn = true;
  const actors = {} as Record<Name, Actor>;
  const botIds = {} as Record<Name, string>;

  const deps = () => ({ prisma, env: { sharedEmployeesEnabled: flagOn } as never });
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
  const propose = (name: Name, path: string, content: string) =>
    as(name, (actor) => proposeKnowledge(deps(), actor, { employeeId, path, content }));
  const pending = (name: Name) => as(name, (actor) => listProposals(deps(), actor, { employeeId }));
  const decide = (
    name: Name,
    proposalId: string,
    decision: "approve" | "reject",
    reason?: string,
  ) =>
    as(name, (actor) =>
      decideProposal(deps(), actor, { employeeId, proposalId, decision, reason }),
    );
  const proposalFor = async (path: string, name: Name = "collab") =>
    (
      await system.employeeKnowledgeProposal.findFirstOrThrow({
        where: {
          employeeId,
          path,
          proposedByUserId: actors[name].userId,
          status: "pending",
        },
      })
    ).id;
  const knowledge = (name: Name) =>
    as(name, (actor) => listKnowledge(deps(), actor, { employeeId }));
  const grant = (name: Name, role: "manager" | "collaborator" | "viewer") =>
    as("owner", (actor) =>
      setGrant(deps(), actor, {
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
      data: { id: organizationId, name: "Knowledge", slug: organizationId, createdAt: new Date() },
    });
    for (const name of NAMES) {
      const id = `emp7-${name}-${suffix}`;
      const spaceId = `emp7-space-${name}-${suffix}`;
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
      botIds[name] = `emp7-bot-${name}-${suffix}`;
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
    }
    employeeId = (await as("owner", (actor) => shareBot(deps(), actor, { botId: botIds.owner })))
      .employeeId;
    await grant("manager", "manager");
    await grant("collab", "collaborator");
    await grant("second", "collaborator");
    await grant("viewer", "viewer");
  });

  afterAll(async () => {
    if (system) {
      await system.securityEvent.deleteMany({
        where: { userId: { in: NAMES.map((name) => `emp7-${name}-${suffix}`) } },
      });
      await system.employee.deleteMany({ where: { createdByUserId: { startsWith: "emp7-" } } });
      await system.organization.deleteMany({ where: { id: organizationId } });
      await system.user.deleteMany({
        where: { id: { startsWith: "emp7-" }, email: { endsWith: "@rakazo.test" } },
      });
    }
    await close?.();
  });

  it("refuses everything while the feature is off", async () => {
    flagOn = false;
    expect(await code(propose("collab", "off.md", "text"))).toBe("FORBIDDEN");
    expect(await code(knowledge("collab"))).toBe("FORBIDDEN");
    flagOn = true;
  });

  it("lets a Collaborator propose, and a Viewer or stranger not", async () => {
    expect(await propose("collab", "refunds.md", "Refund within 14 days.")).toEqual({ ok: true });
    expect(await code(propose("viewer", "v.md", "text"))).toBe("FORBIDDEN");
    expect(await code(propose("outsider", "o.md", "text"))).toBe("NOT_FOUND");
  });

  it("stores exactly the submitted text, with no link to any private note", async () => {
    const row = await system.employeeKnowledgeProposal.findFirstOrThrow({
      where: { employeeId, path: "refunds.md" },
    });
    expect(row.proposedContent).toBe("Refund within 14 days.");
    expect(Object.keys(row).sort()).toEqual(
      [
        "baseRevision",
        "createdAt",
        "decidedAt",
        "decidedBy",
        "employeeId",
        "id",
        "path",
        "proposedByUserId",
        "proposedContent",
        "reason",
        "status",
      ].sort(),
    );
  });

  it("changing the private note afterwards does not change the proposal", async () => {
    const memory = await system.memoryDocument.create({
      data: {
        spaceId: actors.second.spaceId,
        userId: actors.second.userId,
        botId: botIds.second,
        scope: "bot",
        path: "notes.md",
        content: "Original note",
      },
    });
    await propose("second", "notes.md", "Original note");
    await system.memoryDocument.update({ where: { id: memory.id }, data: { content: "Edited" } });
    const row = await system.employeeKnowledgeProposal.findFirstOrThrow({
      where: { employeeId, path: "notes.md" },
    });
    expect(row.proposedContent).toBe("Original note");
    await system.memoryDocument.delete({ where: { id: memory.id } });
    await as("second", (actor) =>
      withdrawProposal(deps(), actor, { employeeId, proposalId: row.id }),
    );
  });

  it("shows reviewers the text without the proposer, and nobody else", async () => {
    const seen = await pending("manager");
    expect(seen).toEqual([
      expect.objectContaining({
        path: "refunds.md",
        content: "Refund within 14 days.",
        currentContent: null,
        stale: false,
      }),
    ]);
    expect(JSON.stringify(seen)).not.toContain(actors.collab.userId);
    expect(await code(pending("collab"))).toBe("FORBIDDEN");
    expect(await code(pending("outsider"))).toBe("NOT_FOUND");
    // Row-level security: a Collaborator reads only their own proposals, a peer none of them.
    const asSecond = await as("second", () =>
      prisma.employeeKnowledgeProposal.count({ where: { proposedByUserId: actors.collab.userId } }),
    );
    const asCollab = await as("collab", () =>
      prisma.employeeKnowledgeProposal.count({ where: { proposedByUserId: actors.collab.userId } }),
    );
    const asOutsider = await as("outsider", () =>
      prisma.employeeKnowledgeProposal.count({ where: { proposedByUserId: actors.collab.userId } }),
    );
    expect([asSecond, asCollab, asOutsider]).toEqual([0, 1, 0]);
    expect(
      (await as("collab", (actor) => listOwnProposals(deps(), actor, { employeeId }))).map(
        (row) => row.path,
      ),
    ).toEqual(["refunds.md"]);
  });

  it("refuses a Collaborator approving their own proposal, and any Viewer", async () => {
    const id = await proposalFor("refunds.md");
    expect(await code(decide("collab", id, "approve"))).toBe("FORBIDDEN");
    expect(await code(decide("viewer", id, "approve"))).toBe("FORBIDDEN");
    expect(await code(decide("outsider", id, "approve"))).toBe("NOT_FOUND");
    expect(
      (await system.employeeKnowledgeProposal.findUniqueOrThrow({ where: { id } })).status,
    ).toBe("pending");
  });

  it("approves into a new revision that every entitled person reads", async () => {
    const id = await proposalFor("refunds.md");
    await decide("manager", id, "approve");
    for (const name of ["owner", "manager", "collab", "second"] as const) {
      expect(await knowledge(name)).toEqual([
        expect.objectContaining({
          path: "refunds.md",
          content: "Refund within 14 days.",
          revision: 1,
        }),
      ]);
    }
    expect(await code(knowledge("outsider"))).toBe("NOT_FOUND");
    const row = await system.employeeKnowledge.findFirstOrThrow({
      where: { employeeId, path: "refunds.md" },
      include: { revisions: true },
    });
    expect(row).toMatchObject({ approvedBy: actors.manager.userId, state: "approved" });
    expect(row.revisions).toHaveLength(1);
    expect(await code(decide("manager", id, "approve"))).toBe("CONFLICT");
    // An outsider reads no knowledge rows at all.
    expect(await as("outsider", () => prisma.employeeKnowledge.count())).toBe(0);
  });

  it("composes approved knowledge into the next run and drops it when retired", async () => {
    await system.bot.create({
      data: {
        id: `emp7-instance-${suffix}`,
        spaceId: actors.collab.spaceId,
        userId: actors.collab.userId,
        name: "instance",
        description: "",
        instructions: "",
        color: "#000",
        employeeId,
      },
    });
    const run = async () => {
      const result = await resolveEmployeeRun(
        system,
        await system.bot.findFirstOrThrow({ where: { employeeId, userId: actors.collab.userId } }),
      );
      if (!result.ok) throw new Error(result.message);
      return result.composed.instructions;
    };
    expect(await run()).toContain("Refund within 14 days.");
    await as("manager", (actor) =>
      retireKnowledge(deps(), actor, { employeeId, path: "refunds.md" }),
    );
    expect(await run()).not.toContain("Refund within 14 days.");
    expect(await knowledge("collab")).toEqual([]);
    expect(
      await code(as("collab", (a) => retireKnowledge(deps(), a, { employeeId, path: "x" }))),
    ).toBe("FORBIDDEN");
  });

  it("detects a revision conflict when the approved text moved since the proposal", async () => {
    await as("manager", (actor) =>
      setKnowledge(deps(), actor, { employeeId, path: "policy.md", content: "v1" }),
    );
    await propose("collab", "policy.md", "collab version");
    await propose("second", "policy.md", "second version");
    const first = await proposalFor("policy.md", "collab");
    const secondId = await proposalFor("policy.md", "second");
    expect((await pending("manager")).every((p) => p.stale === false)).toBe(true);
    await decide("manager", first, "approve");
    expect((await pending("manager"))[0]).toMatchObject({
      stale: true,
      currentContent: "collab version",
    });
    expect(await code(decide("manager", secondId, "approve"))).toBe("CONFLICT");
    const row = await system.employeeKnowledge.findFirstOrThrow({
      where: { employeeId, path: "policy.md" },
    });
    expect(row).toMatchObject({ content: "collab version", revision: 2 });
    await decide("manager", secondId, "reject", "Superseded");
    expect(
      await system.employeeKnowledgeProposal.findUniqueOrThrow({ where: { id: secondId } }),
    ).toMatchObject({ status: "rejected", reason: "Superseded", decidedBy: actors.manager.userId });
  });

  it("guards direct edits by the loaded revision and restricts them to reviewers", async () => {
    const edit = (name: Name, content: string, expectedRevision?: number) =>
      as(name, (actor) =>
        setKnowledge(deps(), actor, { employeeId, path: "policy.md", content, expectedRevision }),
      );
    expect(await code(edit("manager", "stale write", 1))).toBe("CONFLICT");
    expect(await code(edit("manager", "no revision given"))).toBe("CONFLICT");
    expect(await edit("owner", "v3", 2)).toMatchObject({ revision: 3, content: "v3" });
    expect(await code(edit("collab", "nope", 3))).toBe("FORBIDDEN");
  });

  it("lets a person replace or withdraw their open suggestion", async () => {
    await propose("collab", "draft.md", "one");
    await propose("collab", "draft.md", "two");
    expect(
      await system.employeeKnowledgeProposal.count({
        where: { employeeId, path: "draft.md", status: "pending" },
      }),
    ).toBe(1);
    const id = await proposalFor("draft.md");
    expect(
      await code(as("second", (a) => withdrawProposal(deps(), a, { employeeId, proposalId: id }))),
    ).toBe("NOT_FOUND");
    await as("collab", (a) => withdrawProposal(deps(), a, { employeeId, proposalId: id }));
    expect(await code(decide("manager", id, "approve"))).toBe("CONFLICT");
  });

  it("refuses credentials in proposals, edits and approvals, and logs no content", async () => {
    expect(await code(propose("collab", "secret.md", `key ${CANARY}`))).toBe("BAD_REQUEST");
    expect(
      await code(
        as("manager", (a) =>
          setKnowledge(deps(), a, { employeeId, path: "secret.md", content: CANARY }),
        ),
      ),
    ).toBe("BAD_REQUEST");
    // A proposal that slipped in another way is still caught when approved.
    const planted = await system.employeeKnowledgeProposal.create({
      data: {
        employeeId,
        proposedByUserId: actors.second.userId,
        path: "planted.md",
        proposedContent: `token ${CANARY}`,
      },
    });
    expect(await code(decide("manager", planted.id, "approve"))).toBe("BAD_REQUEST");
    await system.employeeKnowledgeProposal.delete({ where: { id: planted.id } });

    const events = await system.securityEvent.findMany({
      where: { type: { startsWith: "employee.knowledge_" } },
    });
    expect(events.length).toBeGreaterThan(0);
    const everything = JSON.stringify({
      events,
      knowledge: await system.employeeKnowledge.findMany({ where: { employeeId } }),
      revisions: await system.employeeKnowledgeRevision.findMany(),
      proposals: await system.employeeKnowledgeProposal.findMany({ where: { employeeId } }),
    });
    expect(everything).not.toContain(CANARY);
    for (const event of events) {
      expect(JSON.stringify(event.metadata)).not.toMatch(/Refund|collab version|\.md/);
    }
  });

  it("keeps a Manager out of private instance data while reading shared knowledge", async () => {
    const privateRows = await as("manager", async () => ({
      bots: await prisma.bot.count({ where: { id: `emp7-instance-${suffix}` } }),
      memory: await prisma.memoryDocument.count({ where: { userId: actors.collab.userId } }),
    }));
    expect(privateRows).toEqual({ bots: 0, memory: 0 });
  });

  it("keeps proposals and approved text when the proposer's account is deleted", async () => {
    await propose("second", "leaver.md", "Kept text");
    const id = await proposalFor("leaver.md", "second");
    await system.employeeEntitlement.deleteMany({ where: { userId: actors.second.userId } });
    await system.employeeGrant.deleteMany({
      where: { employeeId, subjectValue: actors.second.userId },
    });
    await system.user.delete({ where: { id: actors.second.userId } });
    const row = await system.employeeKnowledgeProposal.findUniqueOrThrow({ where: { id } });
    expect(row).toMatchObject({ proposedByUserId: null, proposedContent: "Kept text" });
    await decide("manager", id, "approve");
    expect((await knowledge("manager")).map((k) => k.path)).toContain("leaver.md");
  });
});
