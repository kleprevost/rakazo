import { ORPCError } from "@orpc/server";
import { parsePlaybook } from "@rakazo/adapters";
import type {
  Actor,
  PublishedSkill,
  SkillAudience,
  SkillAudienceInput,
  SkillReview,
  SkillReviewItem,
  SkillSubmission,
  SkillVersion,
  SkillVersionStatus,
} from "@rakazo/contracts";
import { SkillVersionStatusSchema } from "@rakazo/contracts";
import { diffSkillSnapshots, looksLikeCredential, snapshotTaughtSkill } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import { Prisma, recordSecurityEvent, runAsSystem } from "@rakazo/db";
import { requireAdminRole } from "./admins.js";
import type { RouterDeps } from "./router.js";

/**
 * Publishing a taught skill. A submission freezes the saved skill's playbook text into an
 * immutable version: name, description and playbook, with the author and the source skill id.
 * The recording, the thread and the author's memory are never read. A platform admin reviews the
 * version against the previous approved one and pins an approved version for an audience (people,
 * directory claims, or everyone); the executor then offers the pinned text to those people.
 * Nothing here touches a capability grant, connection or credential: a published skill runs with
 * the runner's own. Writes run as system after the check, in a transaction that holds the skill
 * row so two admins or two submissions cannot interleave.
 */

type Deps = Pick<RouterDeps, "prisma" | "env" | "auth">;
type Tx = Prisma.TransactionClient;

const system = <T>(what: string, fn: () => Promise<T>) =>
  runAsSystem(`skill publishing: ${what}`, fn);

const LIST_LIMIT = 200;
/** Versions kept per skill; a skill that needs more is a different skill. */
const MAX_VERSIONS = 100;

const asAdmin = (deps: Deps, actor: Actor) => requireAdminRole(deps, actor.userId, "platform");
const conflict = (message: string) => new ORPCError("CONFLICT", { message });
const notFound = (message: string) => new ORPCError("NOT_FOUND", { message });

async function lockSkill(tx: Tx, skillId: string) {
  await tx.$queryRaw(Prisma.sql`SELECT id FROM published_skills WHERE id = ${skillId} FOR UPDATE`);
}

/** Deterministic, never echoes the value. A credential must not reach colleagues' prompts. */
function refuseCredentials(snapshot: { name: string; description: string; playbook: unknown }) {
  if (looksLikeCredential(JSON.stringify(snapshot)))
    throw new ORPCError("BAD_REQUEST", { message: "This looks like it contains a credential" });
}

const statusOf = (value: string): SkillVersionStatus => {
  const parsed = SkillVersionStatusSchema.safeParse(value);
  return parsed.success ? parsed.data : "withdrawn";
};

type VersionRow = Prisma.PublishedSkillVersionGetPayload<object>;

function toVersion(row: VersionRow): SkillVersion {
  return {
    id: row.id,
    skillId: row.skillId,
    number: row.number,
    status: statusOf(row.status),
    name: row.name,
    description: row.description,
    playbook: parsePlaybook(row.playbook),
    submittedAt: row.submittedAt.toISOString(),
    decidedAt: row.decidedAt?.toISOString() ?? null,
    reason: row.reason,
  };
}

const snapshotOf = (row: VersionRow) => ({
  name: row.name,
  description: row.description,
  playbook: parsePlaybook(row.playbook),
});

/** The author offers a saved taught skill. One submission waits for review at a time. */
export async function submitSkill(
  deps: Deps,
  actor: Actor,
  input: { skillId: string },
): Promise<{ versionId: string; number: number }> {
  const source = await deps.prisma.taughtSkill.findFirst({
    where: { id: input.skillId, spaceId: actor.spaceId, userId: actor.userId, status: "saved" },
    // Only the text that gets published: the recording is never loaded.
    select: { id: true, name: true, goal: true, playbook: true },
  });
  if (!source) throw notFound("Skill not found");
  const snapshot = snapshotTaughtSkill({
    name: source.name,
    goal: source.goal,
    playbook: parsePlaybook(source.playbook),
  });
  refuseCredentials(snapshot);
  const created = await system("submit", () =>
    deps.prisma.$transaction(async (tx) => {
      const skill = await tx.publishedSkill.upsert({
        where: {
          authorUserId_sourceSkillId: { authorUserId: actor.userId, sourceSkillId: source.id },
        },
        create: { authorUserId: actor.userId, sourceSkillId: source.id, name: snapshot.name },
        update: { name: snapshot.name },
      });
      await lockSkill(tx, skill.id);
      const versions = await tx.publishedSkillVersion.findMany({
        where: { skillId: skill.id },
        select: { number: true, status: true },
      });
      if (versions.some((row) => row.status === "submitted"))
        throw conflict("This is already waiting for review");
      if (versions.length >= MAX_VERSIONS)
        throw new ORPCError("BAD_REQUEST", { message: "Too many versions" });
      const number = Math.max(0, ...versions.map((row) => row.number)) + 1;
      return tx.publishedSkillVersion.create({
        data: {
          skillId: skill.id,
          number,
          name: snapshot.name,
          description: snapshot.description,
          playbook: snapshot.playbook,
          authorUserId: actor.userId,
          sourceSkillId: source.id,
        },
        select: { id: true, number: true },
      });
    }),
  );
  await recordSecurityEvent({
    type: "skill.submitted",
    userId: actor.userId,
    spaceId: actor.spaceId,
    metadata: { versionId: created.id, number: created.number },
  });
  return { versionId: created.id, number: created.number };
}

/** The author's own submissions, newest first. */
export async function listSubmissions(deps: Deps, actor: Actor): Promise<SkillSubmission[]> {
  const rows = await deps.prisma.publishedSkillVersion.findMany({
    where: { authorUserId: actor.userId },
    orderBy: [{ submittedAt: "desc" }, { id: "asc" }],
    take: LIST_LIMIT,
  });
  return rows.map((row) => ({
    versionId: row.id,
    skillId: row.skillId,
    number: row.number,
    name: row.name,
    status: statusOf(row.status),
    submittedAt: row.submittedAt.toISOString(),
    reason: row.reason,
  }));
}

export async function withdrawSubmission(
  deps: Deps,
  actor: Actor,
  input: { versionId: string },
): Promise<{ ok: true }> {
  const closed = await system("withdraw", () =>
    deps.prisma.publishedSkillVersion.updateMany({
      where: { id: input.versionId, authorUserId: actor.userId, status: "submitted" },
      data: { status: "withdrawn", decidedAt: new Date() },
    }),
  );
  if (closed.count !== 1) throw notFound("Submission not found");
  return { ok: true };
}

async function authorNames(prisma: PrismaClient, ids: Array<string | null>) {
  const known = ids.filter((id): id is string => id !== null);
  const users = await prisma.user.findMany({
    where: { id: { in: known } },
    select: { id: true, name: true, email: true },
  });
  return new Map(users.map((user) => [user.id, user.name || user.email]));
}

export async function listReviews(deps: Deps, actor: Actor): Promise<SkillReviewItem[]> {
  await asAdmin(deps, actor);
  return system("review list", async () => {
    const rows = await deps.prisma.publishedSkillVersion.findMany({
      where: { status: "submitted" },
      orderBy: [{ submittedAt: "asc" }, { id: "asc" }],
      take: LIST_LIMIT,
    });
    const names = await authorNames(
      deps.prisma,
      rows.map((row) => row.authorUserId),
    );
    return rows.map((row) => ({
      versionId: row.id,
      skillId: row.skillId,
      number: row.number,
      name: row.name,
      authorName: (row.authorUserId && names.get(row.authorUserId)) || "",
      submittedAt: row.submittedAt.toISOString(),
    }));
  });
}

/** The version with its difference from the latest approved version before it. */
export async function getReview(
  deps: Deps,
  actor: Actor,
  input: { versionId: string },
): Promise<SkillReview> {
  await asAdmin(deps, actor);
  return system("review get", async () => {
    const row = await deps.prisma.publishedSkillVersion.findUnique({
      where: { id: input.versionId },
    });
    if (!row) throw notFound("Submission not found");
    const previous = await deps.prisma.publishedSkillVersion.findFirst({
      where: { skillId: row.skillId, status: "approved", number: { lt: row.number } },
      orderBy: { number: "desc" },
    });
    const names = await authorNames(deps.prisma, [row.authorUserId]);
    return {
      version: toVersion(row),
      authorName: (row.authorUserId && names.get(row.authorUserId)) || "",
      previousNumber: previous?.number ?? null,
      diff: diffSkillSnapshots(previous ? snapshotOf(previous) : null, snapshotOf(row)),
    };
  });
}

/** Approve or reject a waiting version. Nobody reviews their own submission. */
export async function decideReview(
  deps: Deps,
  actor: Actor,
  input: { versionId: string; decision: "approve" | "reject"; reason?: string | undefined },
): Promise<{ ok: true }> {
  await asAdmin(deps, actor);
  await system("decide", () =>
    deps.prisma.$transaction(async (tx) => {
      const found = await tx.publishedSkillVersion.findUnique({ where: { id: input.versionId } });
      if (!found) throw notFound("Submission not found");
      await lockSkill(tx, found.skillId);
      const row = await tx.publishedSkillVersion.findUniqueOrThrow({ where: { id: found.id } });
      if (row.status !== "submitted") throw conflict("This was already decided");
      if (row.authorUserId === actor.userId)
        throw new ORPCError("FORBIDDEN", { message: "You cannot review your own skill" });
      if (input.decision === "approve") refuseCredentials(snapshotOf(row));
      await tx.publishedSkillVersion.update({
        where: { id: row.id },
        data: {
          status: input.decision === "approve" ? "approved" : "rejected",
          decidedBy: actor.userId,
          decidedAt: new Date(),
          reason: input.decision === "reject" ? input.reason?.trim() || null : null,
        },
      });
    }),
  );
  await recordSecurityEvent({
    type: "skill.decided",
    userId: actor.userId,
    spaceId: actor.spaceId,
    metadata: { versionId: input.versionId, decision: input.decision },
  });
  return { ok: true };
}

type AudienceRow = Prisma.PublishedSkillAudienceGetPayload<{
  include: { version: { select: { number: true } } };
}>;

const toAudience = (row: AudienceRow): SkillAudience => ({
  id: row.id,
  kind: row.subjectKind === "user" || row.subjectKind === "claim" ? row.subjectKind : "all",
  value: row.subjectValue,
  versionId: row.versionId,
  versionNumber: row.version.number,
});

/** Every skill that has a submission, with its versions and who each audience is pinned to. */
export async function listCatalog(deps: Deps, actor: Actor): Promise<PublishedSkill[]> {
  await asAdmin(deps, actor);
  return system("catalog", async () => {
    const skills = await deps.prisma.publishedSkill.findMany({
      orderBy: [{ name: "asc" }, { id: "asc" }],
      take: LIST_LIMIT,
      include: {
        versions: { orderBy: { number: "desc" }, take: MAX_VERSIONS },
        audiences: {
          include: { version: { select: { number: true } } },
          orderBy: [{ subjectKind: "asc" }, { subjectValue: "asc" }],
        },
      },
    });
    return skills.map((skill) => ({
      id: skill.id,
      name: skill.name,
      versions: skill.versions.map((row) => {
        const { playbook: _playbook, ...rest } = toVersion(row);
        return rest;
      }),
      audiences: skill.audiences.map(toAudience),
    }));
  });
}

const audienceKey = (audience: SkillAudienceInput) =>
  audience.kind === "all"
    ? { subjectKind: "all", subjectValue: "*" }
    : { subjectKind: audience.kind, subjectValue: audience.value };

/**
 * Pins an approved version for an audience, replacing that audience's earlier pin. Pinning a
 * lower number than the audience had is a rollback for them. Takes effect on the next run.
 */
export async function publishVersion(
  deps: Deps,
  actor: Actor,
  input: { skillId: string; versionId: string; audience: SkillAudienceInput },
): Promise<SkillAudience> {
  await asAdmin(deps, actor);
  const key = audienceKey(input.audience);
  const { row, rolledBack } = await system("publish", () =>
    deps.prisma.$transaction(async (tx) => {
      await lockSkill(tx, input.skillId);
      const version = await tx.publishedSkillVersion.findFirst({
        where: { id: input.versionId, skillId: input.skillId },
      });
      if (!version) throw notFound("Version not found");
      if (version.status !== "approved")
        throw conflict("Only an approved version can be published");
      if (key.subjectKind === "user") {
        const person = await tx.user.findUnique({
          where: { id: key.subjectValue },
          select: { id: true },
        });
        if (!person) throw notFound("Person not found");
      }
      const where = { skillId_subjectKind_subjectValue: { skillId: input.skillId, ...key } };
      const existing = await tx.publishedSkillAudience.findUnique({
        where,
        include: { version: { select: { number: true } } },
      });
      const saved = await tx.publishedSkillAudience.upsert({
        where,
        create: { skillId: input.skillId, ...key, versionId: version.id, pinnedBy: actor.userId },
        update: { versionId: version.id, pinnedBy: actor.userId },
        include: { version: { select: { number: true } } },
      });
      return {
        row: saved,
        rolledBack: existing ? existing.version.number > version.number : false,
      };
    }),
  );
  await recordSecurityEvent({
    type: rolledBack ? "skill.rolled_back" : "skill.published",
    userId: actor.userId,
    spaceId: actor.spaceId,
    metadata: {
      skillId: input.skillId,
      versionId: input.versionId,
      audienceKind: key.subjectKind,
      audienceId: row.id,
    },
  });
  return toAudience(row);
}

export async function unpublish(
  deps: Deps,
  actor: Actor,
  input: { audienceId: string },
): Promise<{ ok: true }> {
  await asAdmin(deps, actor);
  const removed = await system("unpublish", () =>
    deps.prisma.publishedSkillAudience.deleteMany({ where: { id: input.audienceId } }),
  );
  if (removed.count !== 1) throw notFound("Audience not found");
  await recordSecurityEvent({
    type: "skill.unpublished",
    userId: actor.userId,
    spaceId: actor.spaceId,
    metadata: { audienceId: input.audienceId },
  });
  return { ok: true };
}

/** Moves every audience pinned above `versionId` back to it. Runs started later use it. */
export async function rollbackSkill(
  deps: Deps,
  actor: Actor,
  input: { skillId: string; versionId: string },
): Promise<{ moved: number }> {
  await asAdmin(deps, actor);
  const moved = await system("rollback", () =>
    deps.prisma.$transaction(async (tx) => {
      await lockSkill(tx, input.skillId);
      const target = await tx.publishedSkillVersion.findFirst({
        where: { id: input.versionId, skillId: input.skillId },
      });
      if (!target) throw notFound("Version not found");
      if (target.status !== "approved") throw conflict("Only an approved version can be published");
      const result = await tx.publishedSkillAudience.updateMany({
        where: { skillId: input.skillId, version: { number: { gt: target.number } } },
        data: { versionId: target.id, pinnedBy: actor.userId },
      });
      return result.count;
    }),
  );
  await recordSecurityEvent({
    type: "skill.rolled_back",
    userId: actor.userId,
    spaceId: actor.spaceId,
    metadata: { skillId: input.skillId, versionId: input.versionId, moved },
  });
  return { moved };
}
