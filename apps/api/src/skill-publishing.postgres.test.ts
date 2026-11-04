import { randomUUID } from "node:crypto";
import type {
  AdapterContext,
  ConnectorCall,
  ConnectorEvent,
  ConnectorProvider,
} from "@rakazo/adapter-kit";
import {
  BrokeredConnector,
  ConnectorRegistry,
  loadPublishedSkills,
  setActivePolicy,
} from "@rakazo/adapters";
import type { Actor } from "@rakazo/contracts";
import { CAPABILITY_DENIED_MESSAGE } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import {
  asSystem,
  createDb,
  installAuditEventStore,
  installSecurityEventStore,
  runAsSystem,
  runAsTenant,
} from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setCapabilityGrant, setCapabilityMode } from "./capability-grants.js";
import {
  decideReview,
  getReview,
  listCatalog,
  listReviews,
  listSubmissions,
  publishVersion,
  rollbackSkill,
  submitSkill,
  unpublish,
  withdrawSubmission,
} from "./skill-publishing.js";

const databaseUrl = process.env.DATABASE_URL;
const enabled = process.env.VERIFY_DATABASE === "1" && Boolean(databaseUrl);

const NAMES = ["ann", "ben", "cy", "dee", "admin"] as const;
type Name = (typeof NAMES)[number];

// Planted in the author's recording, thread-side notes and memory. It must never reach a version.
const CANARY = "PRIVATE-QUARTERLY-FIGURES-7731";

const STEPS_V1 = ["Open the CRM", "Export this week's list", "Drop it in the shared folder"];
const STEPS_V2 = [
  "Open the CRM",
  "Filter to this week",
  "Export this week's list",
  "Drop it in the shared folder",
];

class CalendarConnector implements ConnectorProvider {
  served: Array<{ tool: string; connectionId: string | undefined }> = [];
  describe() {
    return {
      id: "composio",
      contractVersion: "1",
      adapterVersion: "1",
      capabilities: { discover: false, oauth: false, secretsBrokered: false },
    };
  }
  async discoverTools() {
    return [];
  }
  async *execute(call: ConnectorCall, context: AdapterContext): AsyncIterable<ConnectorEvent> {
    this.served.push({ tool: call.tool, connectionId: context.connectedConnections?.[0]?.id });
    yield { type: "result", data: { ok: true } };
  }
}

/**
 * Release gate for publishing a taught skill: Ann teaches a skill, an admin reviews and pins it
 * for Ben, Ben runs it with his own connection and grants, Ann's private state stays hers, a
 * rollback changes the next run, and none of it grants a capability.
 */
describe.skipIf(!enabled)("skill publishing (PostgreSQL, runtime role)", () => {
  const suffix = randomUUID().slice(0, 8);
  const organizationId = `sp-org-${suffix}`;
  let prisma: PrismaClient;
  let system: PrismaClient;
  let close: () => Promise<void>;
  const actors = {} as Record<Name, Actor>;
  const botIds = {} as Record<Name, string>;
  let taughtId: string;
  let skillId: string;
  const inner = new CalendarConnector();
  let connector: BrokeredConnector;

  const deps = () =>
    ({
      prisma,
      env: { adminEmails: [actors.admin.email], ssoAdminEnabled: false },
      auth: { isSsoAdmin: () => false },
    }) as never;
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
  /** What the executor would offer this person at the start of a run. */
  const offered = (name: Name) =>
    as(name, (actor) => loadPublishedSkills(prisma, actor.userId)).then((skills) =>
      skills.map((skill) => ({ name: skill.name, steps: skill.playbook.steps })),
    );
  const submit = () => as("ann", (actor) => submitSkill(deps(), actor, { skillId: taughtId }));
  const approve = (versionId: string) =>
    as("admin", (actor) => decideReview(deps(), actor, { versionId, decision: "approve" }));
  const pin = (versionId: string, audience: Parameters<typeof publishVersion>[2]["audience"]) =>
    as("admin", (actor) => publishVersion(deps(), actor, { skillId, versionId, audience }));
  const forBen = (versionId: string) => pin(versionId, { kind: "user", value: actors.ben.userId });
  const connectionOf = (name: Name) => `sp-conn-${name}-${suffix}`;

  async function callAsBen(tool: string) {
    const before = inner.served.length;
    const events: ConnectorEvent[] = [];
    await runAsSystem("skill publishing call", async () => {
      for await (const event of connector.execute(
        {
          tool,
          args: {},
          executionId: randomUUID(),
          route: { connectorId: "composio", toolName: tool, connectionId: connectionOf("ben") },
        },
        {
          operationId: "op",
          traceId: "op",
          spaceId: actors.ben.spaceId,
          userId: actors.ben.userId,
          botId: botIds.ben,
          signal: new AbortController().signal,
          connectedConnections: [
            {
              id: connectionOf("ben"),
              connectorId: "composio",
              externalId: "calendar",
              displayName: "Calendar",
            },
          ],
        },
      )) {
        events.push(event);
      }
    });
    const refused = events.find((event) => event.type === "error");
    return {
      served: inner.served.length > before,
      error: refused?.type === "error" ? refused.message : undefined,
    };
  }

  beforeAll(async () => {
    const db = createDb(databaseUrl!);
    prisma = db.prisma;
    system = asSystem(prisma);
    installSecurityEventStore(prisma);
    installAuditEventStore(prisma);
    close = async () => {
      installSecurityEventStore(undefined);
      installAuditEventStore(undefined);
      await prisma.$disconnect();
      await db.pool.end();
    };
    connector = new BrokeredConnector(new ConnectorRegistry([inner]), prisma);
    await system.organization.create({
      data: { id: organizationId, name: "Publishing", slug: organizationId, createdAt: new Date() },
    });
    for (const name of NAMES) {
      const id = `sp-${name}-${suffix}`;
      const spaceId = `sp-space-${name}-${suffix}`;
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
      botIds[name] = `sp-bot-${name}-${suffix}`;
      await system.bot.create({
        data: { id: botIds[name], spaceId, userId: id, name: `${name} bot`, color: "#000" },
      });
    }
    // Ann's private state: a saved taught skill whose recording and a memory note carry the canary.
    const taught = await system.taughtSkill.create({
      data: {
        spaceId: actors.ann.spaceId,
        botId: botIds.ann,
        userId: actors.ann.userId,
        name: "Weekly export",
        goal: "Export the weekly list",
        status: "saved",
        playbook: playbook(STEPS_V1),
        recording: { events: [{ at: "0", type: "type", text: CANARY }], snapshots: [] },
      },
    });
    taughtId = taught.id;
    await system.memoryDocument.create({
      data: {
        spaceId: actors.ann.spaceId,
        userId: actors.ann.userId,
        botId: botIds.ann,
        scope: "bot",
        path: "notes.md",
        content: CANARY,
      },
    });
    // Ben's bot is an instance whose calls the broker enforces, so a grant is what lets a call through.
    const employee = await system.employee.create({
      data: { name: "Scheduler", createdByUserId: actors.admin.userId },
    });
    await system.bot.update({ where: { id: botIds.ben }, data: { employeeId: employee.id } });
    await system.employeeEntitlement.create({
      data: {
        employeeId: employee.id,
        userId: actors.ben.userId,
        role: "collaborator",
        source: "grant",
      },
    });
    await as("admin", (actor) =>
      setCapabilityMode(deps(), actor, { botId: botIds.ben, mode: "enforce" }),
    );
    await system.userDirectoryClaim.create({
      data: { userId: actors.cy.userId, values: ["pilot-group"] },
    });
  });

  afterAll(async () => {
    setActivePolicy(undefined);
    if (system) {
      const ids = NAMES.map((name) => `sp-${name}-${suffix}`);
      await system.auditEvent.deleteMany({ where: { organizationId } });
      await system.securityEvent.deleteMany({ where: { userId: { in: ids } } });
      await system.publishedSkill.deleteMany({ where: { authorUserId: { in: ids } } });
      await system.employee.deleteMany({ where: { createdByUserId: { startsWith: "sp-" } } });
      await system.organization.deleteMany({ where: { id: organizationId } });
      await system.user.deleteMany({
        where: { id: { startsWith: "sp-" }, email: { endsWith: "@rakazo.test" } },
      });
    }
    await close?.();
  });

  it("freezes the text of a saved skill into version 1 and keeps the recording out", async () => {
    const created = await submit();
    expect(created.number).toBe(1);
    const row = await system.publishedSkillVersion.findUniqueOrThrow({
      where: { id: created.versionId },
    });
    skillId = row.skillId;
    expect(row.authorUserId).toBe(actors.ann.userId);
    expect(row.sourceSkillId).toBe(taughtId);
    expect(row.status).toBe("submitted");
    expect(JSON.stringify(row)).not.toContain(CANARY);
    expect(Object.keys(row).sort()).toEqual(
      [
        "authorUserId",
        "decidedAt",
        "decidedBy",
        "description",
        "id",
        "name",
        "number",
        "playbook",
        "reason",
        "skillId",
        "sourceSkillId",
        "status",
        "submittedAt",
      ].sort(),
    );
    // One open submission at a time; the author sees their own.
    expect(await code(submit())).toBe("CONFLICT");
    expect(await as("ann", (actor) => listSubmissions(deps(), actor))).toMatchObject([
      { number: 1, status: "submitted" },
    ]);
  });

  it("refuses a skill the caller does not own, one that is not saved, and one with a credential", async () => {
    expect(
      await code(as("ben", (actor) => submitSkill(deps(), actor, { skillId: taughtId }))),
    ).toBe("NOT_FOUND");
    const leaky = await system.taughtSkill.create({
      data: {
        spaceId: actors.ann.spaceId,
        botId: botIds.ann,
        userId: actors.ann.userId,
        name: "Leaky",
        goal: "Leaky",
        status: "saved",
        playbook: playbook(["Use key sk-proj-A1b2C3d4E5f6G7h8I9j0K1l2"]),
      },
    });
    expect(
      await code(as("ann", (actor) => submitSkill(deps(), actor, { skillId: leaky.id }))),
    ).toBe("BAD_REQUEST");
    const draft = await system.taughtSkill.create({
      data: {
        spaceId: actors.ann.spaceId,
        botId: botIds.ann,
        userId: actors.ann.userId,
        goal: "Draft",
        status: "draft",
      },
    });
    expect(
      await code(as("ann", (actor) => submitSkill(deps(), actor, { skillId: draft.id }))),
    ).toBe("NOT_FOUND");
  });

  it("lets only a platform admin review, and never the author", async () => {
    const [pending] = await as("admin", (actor) => listReviews(deps(), actor));
    expect(pending).toMatchObject({ number: 1, name: "Weekly export" });
    for (const name of ["ann", "ben"] as const) {
      expect(await code(as(name, (actor) => listReviews(deps(), actor)))).toBe("FORBIDDEN");
      expect(
        await code(
          as(name, (actor) =>
            decideReview(deps(), actor, { versionId: pending!.versionId, decision: "approve" }),
          ),
        ),
      ).toBe("FORBIDDEN");
      expect(await code(as(name, (actor) => listCatalog(deps(), actor)))).toBe("FORBIDDEN");
    }
    const review = await as("admin", (actor) =>
      getReview(deps(), actor, { versionId: pending!.versionId }),
    );
    expect(review.previousNumber).toBeNull();
    expect(review.diff.find((entry) => entry.field === "steps")?.lines).toEqual(
      STEPS_V1.map((text) => ({ op: "add", text })),
    );
    expect(JSON.stringify(review)).not.toContain(CANARY);
  });

  it("does not run an unapproved version, and pins only approved ones", async () => {
    const versionId = (await system.publishedSkillVersion.findFirstOrThrow({ where: { skillId } }))
      .id;
    expect(await code(forBen(versionId))).toBe("CONFLICT");
    expect(await offered("ben")).toEqual([]);
  });

  it("approves version 1 for Ben alone", async () => {
    const v1 = await system.publishedSkillVersion.findFirstOrThrow({
      where: { skillId, number: 1 },
    });
    await approve(v1.id);
    expect(await code(approve(v1.id))).toBe("CONFLICT");
    // Approval alone publishes to nobody.
    expect(await offered("ben")).toEqual([]);
    const audience = await forBen(v1.id);
    expect(audience).toMatchObject({ kind: "user", versionNumber: 1 });
    expect(await offered("ben")).toEqual([{ name: "Weekly export", steps: STEPS_V1 }]);
    expect(await offered("cy")).toEqual([]);
    expect(await offered("dee")).toEqual([]);
    // Ann's own run gets her saved skill, not a second copy.
    expect(await as("ann", (actor) => loadPublishedSkills(prisma, actor.userId))).toEqual([]);
  });

  it("keeps Ann's recording, memory and transcript away from Ben", async () => {
    await as("ben", async () => {
      expect(await prisma.taughtSkill.findMany({ where: { id: taughtId } })).toEqual([]);
      expect(
        await prisma.memoryDocument.findMany({ where: { content: { contains: CANARY } } }),
      ).toEqual([]);
      expect(await prisma.thread.findMany({ where: { userId: actors.ann.userId } })).toEqual([]);
      const visible = await prisma.publishedSkillVersion.findMany();
      expect(visible).toHaveLength(1);
      expect(JSON.stringify(visible)).not.toContain(CANARY);
      // He sees the pin naming him, not a version nobody pinned for him.
      expect(await prisma.publishedSkillAudience.count()).toBe(1);
    });
    await as("dee", async () => {
      expect(await prisma.publishedSkillVersion.findMany()).toEqual([]);
      expect(await prisma.publishedSkill.findMany()).toEqual([]);
    });
  });

  it("runs on Ben's own connection and grants, and publishing adds none", async () => {
    setActivePolicy({
      version: 1,
      capabilities: {
        mappings: [
          {
            match: { source: "connector", app: "calendar", tool: "list_*" },
            scopes: ["calendar.read"],
          },
        ],
      },
    });
    const grants = () => system.capabilityGrant.count();
    const before = await grants();
    // The skill is pinned for Ben, yet his bot holds no grant: the call is refused.
    expect(await offered("ben")).toHaveLength(1);
    expect(await callAsBen("list_events")).toEqual({
      served: false,
      error: CAPABILITY_DENIED_MESSAGE,
    });
    expect(await grants()).toBe(before);
    // Ben's own grant lets it through, served by his connected account.
    await as("ben", (actor) =>
      setCapabilityGrant(deps(), actor, {
        botId: botIds.ben,
        scope: "calendar.read",
        effect: "allow",
      } as never),
    );
    expect(await callAsBen("list_events")).toEqual({ served: true, error: undefined });
    expect(inner.served.map((entry) => entry.connectionId)).toEqual([connectionOf("ben")]);
    // Exactly the grant Ben made. Nothing came from submitting, approving or pinning.
    expect(await grants()).toBe(before + 1);
    expect(await system.capabilityGrant.count({ where: { botId: botIds.ann } })).toBe(0);
    // Revoking Ben's pin leaves his grants alone.
    await system.capabilityGrant.deleteMany({ where: { botId: botIds.ben } });
  });

  it("shows the changes in version 2 and runs it only where it is pinned", async () => {
    await system.taughtSkill.update({
      where: { id: taughtId },
      data: { playbook: playbook(STEPS_V2) },
    });
    const v2 = await submit();
    expect(v2.number).toBe(2);
    // The frozen v1 did not move when the source skill changed.
    expect(await offered("ben")).toEqual([{ name: "Weekly export", steps: STEPS_V1 }]);
    const review = await as("admin", (actor) =>
      getReview(deps(), actor, { versionId: v2.versionId }),
    );
    expect(review.previousNumber).toBe(1);
    expect(review.diff.map((entry) => entry.field)).toEqual(["steps"]);
    expect(review.diff[0]!.lines.filter((line) => line.op !== "same")).toEqual([
      { op: "add", text: "Filter to this week" },
    ]);
    await approve(v2.versionId);
    await forBen(v2.versionId);
    expect(await offered("ben")).toEqual([{ name: "Weekly export", steps: STEPS_V2 }]);
  });

  it("widens to a directory group and everyone, each pinned on its own", async () => {
    const [v1, v2] = await Promise.all(
      [1, 2].map((number) =>
        system.publishedSkillVersion.findFirstOrThrow({ where: { skillId, number } }),
      ),
    );
    await pin(v1!.id, { kind: "claim", value: "pilot-group" });
    expect(await offered("cy")).toEqual([{ name: "Weekly export", steps: STEPS_V1 }]);
    expect(await offered("dee")).toEqual([]);
    await pin(v2!.id, { kind: "all" });
    expect(await offered("dee")).toEqual([{ name: "Weekly export", steps: STEPS_V2 }]);
    // The group pin is more specific than everyone, and Ben's own pin beats both.
    expect(await offered("cy")).toEqual([{ name: "Weekly export", steps: STEPS_V1 }]);
    expect(await offered("ben")).toEqual([{ name: "Weekly export", steps: STEPS_V2 }]);
  });

  it("rolls back from version 2 to version 1 on the next run", async () => {
    const v1 = await system.publishedSkillVersion.findFirstOrThrow({
      where: { skillId, number: 1 },
    });
    expect(await offered("ben")).toEqual([{ name: "Weekly export", steps: STEPS_V2 }]);
    const moved = await as("admin", (actor) =>
      rollbackSkill(deps(), actor, { skillId, versionId: v1.id }),
    );
    // Ben's pin and the everyone pin were on version 2; the group already ran version 1.
    expect(moved).toEqual({ moved: 2 });
    for (const name of ["ben", "cy", "dee"] as const) {
      expect(await offered(name), name).toEqual([{ name: "Weekly export", steps: STEPS_V1 }]);
    }
    const events = await system.securityEvent.findMany({
      where: { userId: actors.admin.userId, type: "skill.rolled_back" },
    });
    expect(events).toHaveLength(1);
    expect(JSON.stringify(events)).not.toContain(STEPS_V1[0]);
  });

  it("freezes content, withdraws and rejects, and unpublishes", async () => {
    const v1 = await system.publishedSkillVersion.findFirstOrThrow({
      where: { skillId, number: 1 },
    });
    await expect(
      system.publishedSkillVersion.update({
        where: { id: v1.id },
        data: { playbook: playbook(["Changed after approval"]) },
      }),
    ).rejects.toThrow(/immutable/);
    // A tenant cannot write at all.
    await as("ann", async () => {
      await expect(
        prisma.publishedSkillVersion.updateMany({ where: {}, data: { status: "approved" } }),
      ).resolves.toMatchObject({ count: 0 });
    });

    const v3 = await submit();
    expect(await as("ann", (actor) => withdrawSubmission(deps(), actor, v3))).toEqual({ ok: true });
    expect(await code(as("ben", (actor) => withdrawSubmission(deps(), actor, v3)))).toBe(
      "NOT_FOUND",
    );
    const v4 = await submit();
    await as("admin", (actor) =>
      decideReview(deps(), actor, {
        versionId: v4.versionId,
        decision: "reject",
        reason: "Too broad",
      }),
    );
    expect(await as("ann", (actor) => listSubmissions(deps(), actor))).toContainEqual(
      expect.objectContaining({ number: 4, status: "rejected", reason: "Too broad" }),
    );
    expect(await code(forBen(v4.versionId))).toBe("CONFLICT");

    const catalog = await as("admin", (actor) => listCatalog(deps(), actor));
    const audience = catalog
      .find((skill) => skill.id === skillId)!
      .audiences.find((a) => a.kind === "all")!;
    await as("admin", (actor) => unpublish(deps(), actor, { audienceId: audience.id }));
    expect(await offered("dee")).toEqual([]);
    expect(await offered("ben")).toEqual([{ name: "Weekly export", steps: STEPS_V1 }]);
  });
});

function playbook(steps: string[]) {
  return {
    whenToUse: "Every Monday",
    inputs: [],
    steps,
    howToCheck: "The file is in the folder",
    whatToReturn: "The file name",
    approvalBoundaries: "Ask before sending anything",
    failureHandling: "Stop and ask",
  };
}
