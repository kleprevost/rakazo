import { ORPCError } from "@orpc/server";
import type {
  Actor,
  EmployeeAction,
  EmployeeCard,
  EmployeeDenialReason,
  EmployeeDetail,
  EmployeeGrant,
  EmployeeRole,
  EmployeeVersion,
} from "@rakazo/contracts";
import { EmployeeRoleSchema } from "@rakazo/contracts";
import { effectiveEmployeeRole, evaluateEmployeeAccess, evaluateGrantChange } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import {
  Prisma,
  reconcileEmployeeEntitlements,
  recordSecurityEvent,
  runAsSystem,
} from "@rakazo/db";
import type { RouterDeps } from "./router.js";

/**
 * Employee definitions: share a bot in place, versions, and who may use or manage them. Every
 * procedure asks the pure evaluator in `@rakazo/core` first and only touches definition tables;
 * nothing here reads a bot's thread, memory, computer or secrets. Writes run as system after the
 * role check, inside one transaction that holds the employee row, so two Owners cannot both
 * demote each other and two drafts cannot take the same number.
 */

type EmployeesDeps = Pick<RouterDeps, "prisma">;
type Db = Pick<
  PrismaClient,
  "employee" | "employeeEntitlement" | "employeeVersion" | "employeeGrant" | "user"
>;

const VERSION_LIST_LIMIT = 50;
const system = <T>(what: string, fn: () => Promise<T>) => runAsSystem(`employees: ${what}`, fn);

const REFUSALS: Record<EmployeeDenialReason, string> = {
  no_access: "Employee not found",
  insufficient_role: "Your role does not allow this",
  suspended: "This employee is suspended",
  retired: "This employee is retired",
  private_content: "This is private to its owner",
  not_credential_approver: "Only the Owner can do this",
  claim_cannot_be_owner: "A directory group cannot be an Owner",
  last_owner: "An employee needs at least one Owner",
};

/** No entitlement answers as not found, so a stranger cannot tell which employees exist. */
function refuse(reason: EmployeeDenialReason): never {
  throw new ORPCError(reason === "no_access" ? "NOT_FOUND" : "FORBIDDEN", {
    message: REFUSALS[reason],
  });
}

const parseRole = (value: string): EmployeeRole | null => {
  const parsed = EmployeeRoleSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
};

async function roleOf(db: Db, employeeId: string, userId: string): Promise<EmployeeRole | null> {
  const rows = await db.employeeEntitlement.findMany({
    where: { employeeId, userId },
    select: { role: true, source: true },
  });
  return effectiveEmployeeRole(
    rows.flatMap((row) => {
      const role = parseRole(row.role);
      return role && (row.source === "grant" || row.source === "claim")
        ? [{ role, source: row.source }]
        : [];
    }),
  );
}

/** Loads the employee and refuses unless the caller's role may do the action. */
async function authorize(db: Db, userId: string, employeeId: string, action: EmployeeAction) {
  const employee = await db.employee.findUnique({ where: { id: employeeId } });
  if (!employee) refuse("no_access");
  const role = await roleOf(db, employeeId, userId);
  const decision = evaluateEmployeeAccess({
    role,
    action,
    userId,
    employee: { status: parseStatus(employee.status), suspendedAt: employee.suspendedAt },
  });
  if (!decision.allowed) refuse(decision.reason);
  return { employee, role: role as EmployeeRole };
}

const parseStatus = (value: string) =>
  value === "draft" || value === "retired" ? value : ("published" as const);

async function lockEmployee(tx: Prisma.TransactionClient, employeeId: string) {
  await tx.$queryRaw(Prisma.sql`SELECT id FROM employees WHERE id = ${employeeId} FOR UPDATE`);
}

type EmployeeRow = {
  id: string;
  name: string;
  description: string;
  status: string;
  listing: string;
  currentVersionId: string | null;
  suspendedAt: Date | null;
};

function toCard(row: EmployeeRow, role: EmployeeRole, currentVersion: number | null): EmployeeCard {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    status: parseStatus(row.status),
    listing: row.listing === "listed" ? "listed" : "unlisted",
    role,
    currentVersion,
    suspended: row.suspendedAt !== null,
  };
}

async function currentNumbers(db: Db, rows: EmployeeRow[]): Promise<Map<string, number>> {
  const ids = rows.flatMap((row) => (row.currentVersionId ? [row.currentVersionId] : []));
  if (ids.length === 0) return new Map();
  const versions = await db.employeeVersion.findMany({
    where: { id: { in: ids } },
    select: { id: true, number: true },
  });
  return new Map(versions.map((version) => [version.id, version.number]));
}

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const asNames = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];

function toVersion(
  row: {
    id: string;
    number: number;
    state: string;
    role: string;
    instructions: string;
    skills: unknown;
    capabilityPolicy: unknown;
    modelPolicy: unknown;
    publishedAt: Date | null;
  },
  currentVersionId: string | null,
): EmployeeVersion {
  return {
    id: row.id,
    number: row.number,
    state: row.state === "published" ? "published" : "draft",
    role: row.role,
    instructions: row.instructions,
    skills: asNames(row.skills),
    capabilityPolicy: asRecord(row.capabilityPolicy),
    modelPolicy: asRecord(row.modelPolicy),
    publishedAt: row.publishedAt?.toISOString() ?? null,
    current: row.id === currentVersionId,
  };
}

/** Everything the caller is entitled to. Read under the caller's own row-level scope. */
export async function listEmployees(deps: EmployeesDeps, actor: Actor): Promise<EmployeeCard[]> {
  const rows = await deps.prisma.employeeEntitlement.findMany({
    where: { userId: actor.userId },
    select: { role: true, source: true, employee: true },
  });
  const best = new Map<string, { employee: EmployeeRow; roles: EmployeeRole[] }>();
  for (const row of rows) {
    const role = parseRole(row.role);
    if (!role) continue;
    const entry = best.get(row.employee.id) ?? { employee: row.employee, roles: [] };
    entry.roles.push(role);
    best.set(row.employee.id, entry);
  }
  const numbers = await currentNumbers(
    deps.prisma,
    [...best.values()].map((entry) => entry.employee),
  );
  return [...best.values()]
    .map(({ employee, roles }) =>
      toCard(
        employee,
        effectiveEmployeeRole(roles.map((role) => ({ role, source: "grant" as const })))!,
        employee.currentVersionId ? (numbers.get(employee.currentVersionId) ?? null) : null,
      ),
    )
    .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}

export async function getEmployee(
  deps: EmployeesDeps,
  actor: Actor,
  employeeId: string,
): Promise<EmployeeDetail> {
  const { employee, role } = await authorize(deps.prisma, actor.userId, employeeId, "view_card");
  const numbers = await currentNumbers(deps.prisma, [employee]);
  const card = toCard(
    employee,
    role,
    employee.currentVersionId ? (numbers.get(employee.currentVersionId) ?? null) : null,
  );
  // The definition itself is for people who can edit it; everyone else sees the card.
  const canEdit = evaluateEmployeeAccess({ role, action: "edit" }).allowed;
  if (!canEdit) return { employee: card, versions: null };
  const versions = await deps.prisma.employeeVersion.findMany({
    where: { employeeId },
    orderBy: { number: "desc" },
    take: VERSION_LIST_LIMIT,
  });
  return {
    employee: card,
    versions: versions.map((version) => toVersion(version, employee.currentVersionId)),
  };
}

/**
 * Makes the caller's own AI employee the first instance of a new shared employee. Version 1
 * snapshots its role and instructions. The same bot row stays: its thread, memory, computer and
 * secrets are not read, copied or moved, and the caller keeps them privately.
 */
export async function shareBot(
  deps: EmployeesDeps,
  actor: Actor,
  input: { botId: string; name?: string },
): Promise<{ employeeId: string }> {
  const bot = await deps.prisma.bot.findFirst({
    where: { id: input.botId, userId: actor.userId, spaceId: actor.spaceId },
    select: { id: true, name: true, description: true, instructions: true, employeeId: true },
  });
  if (!bot) throw new ORPCError("NOT_FOUND", { message: "AI employee not found" });
  if (bot.employeeId) throw new ORPCError("CONFLICT", { message: "Already shared" });
  const now = new Date();
  const employeeId = await system("share", () =>
    deps.prisma.$transaction(async (tx) => {
      const employee = await tx.employee.create({
        data: {
          name: input.name ?? bot.name,
          description: bot.description,
          status: "published",
          createdByUserId: actor.userId,
        },
      });
      const version = await tx.employeeVersion.create({
        data: {
          employeeId: employee.id,
          number: 1,
          state: "published",
          role: bot.description,
          instructions: bot.instructions,
          createdBy: actor.userId,
          publishedBy: actor.userId,
          publishedAt: now,
        },
      });
      await tx.employee.update({
        where: { id: employee.id },
        data: { currentVersionId: version.id },
      });
      await tx.employeeGrant.create({
        data: {
          employeeId: employee.id,
          subjectKind: "user",
          subjectValue: actor.userId,
          role: "owner",
          grantedBy: actor.userId,
        },
      });
      // Guarded, so a second share of the same bot rolls this whole transaction back.
      const moved = await tx.bot.updateMany({
        where: { id: bot.id, userId: actor.userId, employeeId: null },
        data: { employeeId: employee.id },
      });
      if (moved.count !== 1) throw new ORPCError("CONFLICT", { message: "Already shared" });
      return employee.id;
    }),
  );
  await reconcileEmployeeEntitlements(deps.prisma, employeeId, { via: "share" });
  await recordSecurityEvent({
    type: "employee.shared",
    userId: actor.userId,
    spaceId: actor.spaceId,
    metadata: { employeeId, botId: bot.id },
  });
  return { employeeId };
}

export async function saveDraft(
  deps: EmployeesDeps,
  actor: Actor,
  input: {
    employeeId: string;
    role?: string;
    instructions?: string;
    skills?: string[];
    capabilityPolicy?: Record<string, unknown>;
    modelPolicy?: Record<string, unknown>;
  },
): Promise<EmployeeVersion> {
  const { employeeId } = input;
  const edits = {
    ...(input.role !== undefined ? { role: input.role } : {}),
    ...(input.instructions !== undefined ? { instructions: input.instructions } : {}),
    ...(input.skills !== undefined ? { skills: input.skills } : {}),
    ...(input.capabilityPolicy !== undefined
      ? { capabilityPolicy: input.capabilityPolicy as Prisma.InputJsonObject }
      : {}),
    ...(input.modelPolicy !== undefined
      ? { modelPolicy: input.modelPolicy as Prisma.InputJsonObject }
      : {}),
  };
  const saved = await system("save draft", () =>
    deps.prisma.$transaction(async (tx) => {
      await lockEmployee(tx, employeeId);
      const { employee } = await authorize(tx, actor.userId, employeeId, "edit");
      const open = await tx.employeeVersion.findFirst({ where: { employeeId, state: "draft" } });
      if (open) return tx.employeeVersion.update({ where: { id: open.id }, data: edits });
      const latest = await tx.employeeVersion.findFirst({
        where: { employeeId },
        orderBy: { number: "desc" },
        select: { number: true },
      });
      const base = employee.currentVersionId
        ? await tx.employeeVersion.findUnique({ where: { id: employee.currentVersionId } })
        : null;
      return tx.employeeVersion.create({
        data: {
          employeeId,
          number: (latest?.number ?? 0) + 1,
          state: "draft",
          role: base?.role ?? "",
          instructions: base?.instructions ?? "",
          skills: (base?.skills ?? []) as Prisma.InputJsonValue,
          capabilityPolicy: (base?.capabilityPolicy ?? {}) as Prisma.InputJsonValue,
          modelPolicy: (base?.modelPolicy ?? {}) as Prisma.InputJsonValue,
          createdBy: actor.userId,
          ...edits,
        },
      });
    }),
  );
  await recordSecurityEvent({
    type: "employee.version_saved",
    userId: actor.userId,
    spaceId: actor.spaceId,
    metadata: { employeeId, versionId: saved.id, number: saved.number },
  });
  return toVersion(saved, null);
}

/** Points the employee at a version. A draft becomes published first; a published one is a rollback. */
async function setCurrent(
  deps: EmployeesDeps,
  actor: Actor,
  input: { employeeId: string; versionId: string },
  change: "publish" | "rollback",
): Promise<EmployeeCard> {
  const { employeeId, versionId } = input;
  const result = await system(change, () =>
    deps.prisma.$transaction(async (tx) => {
      await lockEmployee(tx, employeeId);
      const { employee, role } = await authorize(tx, actor.userId, employeeId, "publish");
      if (employee.status === "retired")
        throw new ORPCError("CONFLICT", { message: "This employee is retired" });
      const version = await tx.employeeVersion.findFirst({ where: { id: versionId, employeeId } });
      if (!version) throw new ORPCError("NOT_FOUND", { message: "Version not found" });
      if (change === "publish") {
        if (version.state !== "draft")
          throw new ORPCError("CONFLICT", { message: "Already published" });
        await tx.employeeVersion.update({
          where: { id: version.id },
          data: { state: "published", publishedBy: actor.userId, publishedAt: new Date() },
        });
      } else if (version.state !== "published") {
        throw new ORPCError("CONFLICT", { message: "Only a published version can be restored" });
      }
      const updated = await tx.employee.update({
        where: { id: employeeId },
        data: { currentVersionId: version.id, status: "published" },
      });
      return { employee: updated, role, number: version.number };
    }),
  );
  await recordSecurityEvent({
    type: "employee.version_published",
    userId: actor.userId,
    spaceId: actor.spaceId,
    metadata: { employeeId, versionId, number: result.number, change },
  });
  return toCard(result.employee, result.role, result.number);
}

export const publishVersion = (
  deps: EmployeesDeps,
  actor: Actor,
  input: { employeeId: string; versionId: string },
) => setCurrent(deps, actor, input, "publish");

export const rollbackVersion = (
  deps: EmployeesDeps,
  actor: Actor,
  input: { employeeId: string; versionId: string },
) => setCurrent(deps, actor, input, "rollback");

export async function listGrants(
  deps: EmployeesDeps,
  actor: Actor,
  employeeId: string,
): Promise<EmployeeGrant[]> {
  await authorize(deps.prisma, actor.userId, employeeId, "manage_grants");
  const grants = await deps.prisma.employeeGrant.findMany({
    where: { employeeId },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
  return grants.flatMap((grant) => toGrant(grant));
}

function toGrant(grant: {
  subjectKind: string;
  subjectValue: string;
  role: string;
  grantedBy: string;
  expiresAt: Date | null;
}): EmployeeGrant[] {
  const role = parseRole(grant.role);
  if (!role || (grant.subjectKind !== "user" && grant.subjectKind !== "claim")) return [];
  return [
    {
      subjectKind: grant.subjectKind,
      subjectValue: grant.subjectValue,
      role,
      grantedBy: grant.grantedBy,
      expiresAt: grant.expiresAt?.toISOString() ?? null,
    },
  ];
}

type GrantSubject = { employeeId: string; subjectKind: "user" | "claim"; subjectValue: string };

/** Owners that exist: expired or deleted-user grants cannot keep the last Owner in place. */
async function ownerCount(tx: Prisma.TransactionClient, employeeId: string, now: Date) {
  const owners = await tx.employeeGrant.findMany({
    where: {
      employeeId,
      subjectKind: "user",
      role: "owner",
      OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
    },
    select: { subjectValue: true },
  });
  return tx.user.count({ where: { id: { in: owners.map((owner) => owner.subjectValue) } } });
}

async function changeGrant(
  deps: EmployeesDeps,
  actor: Actor,
  subject: GrantSubject,
  to: { role: EmployeeRole; expiresAt: Date | null } | null,
): Promise<EmployeeGrant | null> {
  const { employeeId, subjectKind, subjectValue } = subject;
  if (to?.role === "owner" && to.expiresAt)
    throw new ORPCError("BAD_REQUEST", { message: "An Owner grant does not expire" });
  const now = new Date();
  if (to?.expiresAt && to.expiresAt.getTime() <= now.getTime())
    throw new ORPCError("BAD_REQUEST", { message: "The expiry is in the past" });
  const saved = await system(to ? "set grant" : "remove grant", () =>
    deps.prisma.$transaction(async (tx) => {
      await lockEmployee(tx, employeeId);
      const { role: actorRole } = await authorize(tx, actor.userId, employeeId, "manage_grants");
      const key = { employeeId_subjectKind_subjectValue: subject };
      const existing = await tx.employeeGrant.findUnique({ where: key });
      const decision = evaluateGrantChange({
        actorRole,
        subjectKind,
        from: existing ? parseRole(existing.role) : null,
        to: to?.role ?? null,
        ownerCount: await ownerCount(tx, employeeId, now),
      });
      if (!decision.allowed) refuse(decision.reason);
      if (!to) {
        if (existing) await tx.employeeGrant.delete({ where: key });
        return null;
      }
      if (subjectKind === "user") {
        const user = await tx.user.findUnique({
          where: { id: subjectValue },
          select: { id: true },
        });
        if (!user) throw new ORPCError("NOT_FOUND", { message: "User not found" });
      }
      return tx.employeeGrant.upsert({
        where: key,
        create: { ...subject, role: to.role, expiresAt: to.expiresAt, grantedBy: actor.userId },
        update: { role: to.role, expiresAt: to.expiresAt, grantedBy: actor.userId },
      });
    }),
  );
  // After the commit and repeatable: if this fails the caller retries the same change.
  await reconcileEmployeeEntitlements(deps.prisma, employeeId, { via: "grant_change" });
  await recordSecurityEvent({
    type: to ? "employee.grant_changed" : "employee.grant_removed",
    userId: actor.userId,
    spaceId: actor.spaceId,
    // A directory group value stays out of the log; a user is named by id.
    metadata: {
      employeeId,
      subjectKind,
      subjectId: subjectKind === "user" ? subjectValue : null,
      role: to?.role ?? null,
    },
  });
  return saved ? (toGrant(saved)[0] ?? null) : null;
}

export async function setGrant(
  deps: EmployeesDeps,
  actor: Actor,
  input: GrantSubject & { role: EmployeeRole; expiresAt?: string },
): Promise<EmployeeGrant> {
  const { role, expiresAt, ...subject } = input;
  const grant = await changeGrant(deps, actor, subject, {
    role,
    expiresAt: expiresAt ? new Date(expiresAt) : null,
  });
  if (!grant) throw new ORPCError("INTERNAL_SERVER_ERROR");
  return grant;
}

export async function removeGrant(
  deps: EmployeesDeps,
  actor: Actor,
  input: GrantSubject,
): Promise<{ ok: true }> {
  await changeGrant(deps, actor, input, null);
  return { ok: true };
}
