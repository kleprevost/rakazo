import type { EmployeeRole } from "@rakazo/contracts";
import { EmployeeRoleSchema } from "@rakazo/contracts";
import type { EmployeeGrantInput, EntitlementDiff, EntitlementRow } from "@rakazo/core";
import { diffEntitlements, resolveEmployeeEntitlements } from "@rakazo/core";
import type { PrismaClient } from "./client.js";
import { Prisma } from "./client.js";
import { runAsSystem } from "./row-security.js";
import { recordSecurityEvent } from "./security-events.js";

/**
 * Keeps `employee_entitlements` equal to employee grants x directory claims. Every function is a
 * recompute from current rows (never an incremental patch), so repeating one or running it from
 * several API instances at once converges on the same rows. A user's rows are serialized by an
 * advisory lock taken before the inputs are read; no global lock or loop is involved.
 */

type Db = Pick<
  PrismaClient,
  "$transaction" | "user" | "userDirectoryClaim" | "employeeGrant" | "employeeEntitlement"
>;
type Tx = Prisma.TransactionClient;

/** Users handled per transaction, so one large group never holds thousands of locks. */
const CHUNK = 200;

export type DirectoryClaims = {
  values: readonly string[];
  /** The directory returned a link instead of the full list; claim grants fail closed. */
  truncated?: boolean;
};

export type ReconcileResult = { added: number; updated: number; removed: number };

const EMPTY: ReconcileResult = { added: 0, updated: 0, removed: 0 };

const asRole = (value: string): EmployeeRole | null => {
  const parsed = EmployeeRoleSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
};

const toGrant = (grant: {
  subjectKind: string;
  subjectValue: string;
  role: string;
  expiresAt: Date | null;
}): EmployeeGrantInput | null => {
  const role = asRole(grant.role);
  if (!role || (grant.subjectKind !== "user" && grant.subjectKind !== "claim")) return null;
  return {
    subjectKind: grant.subjectKind,
    subjectValue: grant.subjectValue,
    role,
    expiresAt: grant.expiresAt,
  };
};

const toRow = (row: {
  employeeId: string;
  userId: string;
  role: string;
  source: string;
}): EntitlementRow | null => {
  const role = asRole(row.role);
  if (!role || (row.source !== "grant" && row.source !== "claim")) return null;
  return { employeeId: row.employeeId, userId: row.userId, role, source: row.source };
};

const compact = <T>(items: Array<T | null>): T[] =>
  items.filter((item): item is T => item !== null);

/** Serializes entitlement writes for the users, in a stable order so locks never cross. */
async function lockUsers(tx: Tx, userIds: readonly string[]) {
  for (const userId of [...userIds].sort()) {
    await tx.$queryRaw(Prisma.sql`
      SELECT pg_advisory_xact_lock(hashtextextended(${userId}, 2))::text AS "lock"
    `);
  }
}

async function apply(tx: Tx, diff: EntitlementDiff) {
  if (diff.add.length > 0)
    await tx.employeeEntitlement.createMany({ data: diff.add, skipDuplicates: true });
  for (const row of diff.update)
    await tx.employeeEntitlement.updateMany({
      where: { employeeId: row.employeeId, userId: row.userId, source: row.source },
      data: { role: row.role },
    });
  for (const row of diff.remove)
    await tx.employeeEntitlement.deleteMany({
      where: { employeeId: row.employeeId, userId: row.userId, source: row.source },
    });
}

const counts = (diff: EntitlementDiff): ReconcileResult => ({
  added: diff.add.length,
  updated: diff.update.length,
  removed: diff.remove.length,
});

/** Recomputes one user's rows from their claims and every grant that can reach them. */
async function reconcileUserIn(tx: Tx, userId: string, now: Date): Promise<ReconcileResult> {
  await lockUsers(tx, [userId]);
  const claims = await tx.userDirectoryClaim.findUnique({ where: { userId } });
  const values = claims?.values ?? [];
  const truncated = claims?.truncated ?? false;
  const grants = await tx.employeeGrant.findMany({
    where: {
      OR: [
        { subjectKind: "user", subjectValue: userId },
        ...(truncated || values.length === 0
          ? []
          : [{ subjectKind: "claim", subjectValue: { in: [...values] } }]),
      ],
    },
    select: {
      employeeId: true,
      subjectKind: true,
      subjectValue: true,
      role: true,
      expiresAt: true,
    },
  });
  const byEmployee = new Map<string, EmployeeGrantInput[]>();
  for (const grant of grants) {
    const input = toGrant(grant);
    if (input)
      byEmployee.set(grant.employeeId, [...(byEmployee.get(grant.employeeId) ?? []), input]);
  }
  const desired: EntitlementRow[] = [];
  for (const [employeeId, list] of byEmployee)
    for (const entitlement of resolveEmployeeEntitlements(
      { userId, claimValues: values, claimsTruncated: truncated },
      list,
      now,
    ))
      desired.push({ employeeId, userId, ...entitlement });
  const current = compact(
    (await tx.employeeEntitlement.findMany({ where: { userId } })).map(toRow),
  );
  const diff = diffEntitlements(current, desired);
  await apply(tx, diff);
  return counts(diff);
}

/** Recomputes a user's entitlements after their claims or grants naming them changed. */
export async function reconcileUserEntitlements(
  db: Db,
  userId: string,
  options: { now?: Date; via?: string } = {},
): Promise<ReconcileResult> {
  const result = await runAsSystem("reconcile employee entitlements", () =>
    db.$transaction((tx) => reconcileUserIn(tx, userId, options.now ?? new Date())),
  );
  await recordChange({ userId }, result, options.via ?? "user");
  return result;
}

/**
 * Stores the verified claim and recomputes the user's entitlements in one transaction. The
 * claim row is only written when it changed, so a sign-in with the same groups is cheap.
 */
export async function recordDirectoryClaims(
  db: Db,
  userId: string,
  claims: DirectoryClaims,
  options: { now?: Date; via?: string } = {},
): Promise<ReconcileResult> {
  const now = options.now ?? new Date();
  const values = [...new Set(claims.values)].sort();
  const truncated = claims.truncated === true;
  const result = await runAsSystem("record directory claims", () =>
    db.$transaction(async (tx) => {
      await lockUsers(tx, [userId]);
      const existing = await tx.userDirectoryClaim.findUnique({ where: { userId } });
      const same =
        existing &&
        existing.truncated === truncated &&
        existing.values.length === values.length &&
        [...existing.values].sort().every((value, index) => value === values[index]);
      if (same) {
        await tx.userDirectoryClaim.update({ where: { userId }, data: { refreshedAt: now } });
      } else {
        await tx.userDirectoryClaim.upsert({
          where: { userId },
          create: { userId, values, truncated, refreshedAt: now },
          update: { values, truncated, refreshedAt: now },
        });
      }
      // Unchanged claims still reconcile: an expired grant drops out at the next sign-in.
      return reconcileUserIn(tx, userId, now);
    }),
  );
  await recordChange({ userId }, result, options.via ?? "sign_in");
  return result;
}

/** Recomputes every entitlement of one employee after its grants changed. */
export async function reconcileEmployeeEntitlements(
  db: Db,
  employeeId: string,
  options: { now?: Date; via?: string } = {},
): Promise<ReconcileResult> {
  const now = options.now ?? new Date();
  const total = { ...EMPTY };
  await runAsSystem("reconcile employee entitlements", async () => {
    const grants = await db.employeeGrant.findMany({
      where: { employeeId },
      select: { subjectKind: true, subjectValue: true, role: true, expiresAt: true },
    });
    const claimValues = grants.filter((g) => g.subjectKind === "claim").map((g) => g.subjectValue);
    const userGrantIds = grants.filter((g) => g.subjectKind === "user").map((g) => g.subjectValue);
    const [entitled, claimed, named] = await Promise.all([
      db.employeeEntitlement.findMany({ where: { employeeId }, select: { userId: true } }),
      claimValues.length > 0
        ? db.userDirectoryClaim.findMany({
            where: { values: { hasSome: claimValues } },
            select: { userId: true },
          })
        : [],
      userGrantIds.length > 0
        ? db.user.findMany({ where: { id: { in: userGrantIds } }, select: { id: true } })
        : [],
    ]);
    const users = [
      ...new Set([
        ...entitled.map((row) => row.userId),
        ...claimed.map((row) => row.userId),
        ...named.map((row) => row.id),
      ]),
    ].sort();
    for (let start = 0; start < users.length; start += CHUNK) {
      const chunk = users.slice(start, start + CHUNK);
      const done = await db.$transaction(async (tx) => {
        await lockUsers(tx, chunk);
        // Grants and claims are read after the locks, so a concurrent change is never missed.
        const live = compact(
          (
            await tx.employeeGrant.findMany({
              where: { employeeId },
              select: { subjectKind: true, subjectValue: true, role: true, expiresAt: true },
            })
          ).map(toGrant),
        );
        const claimRows = await tx.userDirectoryClaim.findMany({
          where: { userId: { in: chunk } },
        });
        const claimsOf = new Map(claimRows.map((row) => [row.userId, row]));
        const existing = await tx.user.findMany({
          where: { id: { in: chunk } },
          select: { id: true },
        });
        const present = new Set(existing.map((row) => row.id));
        const current = compact(
          (
            await tx.employeeEntitlement.findMany({ where: { employeeId, userId: { in: chunk } } })
          ).map(toRow),
        );
        const desired: EntitlementRow[] = [];
        for (const userId of chunk) {
          if (!present.has(userId)) continue;
          const claim = claimsOf.get(userId);
          for (const entitlement of resolveEmployeeEntitlements(
            {
              userId,
              claimValues: claim?.values ?? [],
              claimsTruncated: claim?.truncated ?? false,
            },
            live,
            now,
          ))
            desired.push({ employeeId, userId, ...entitlement });
        }
        const diff = diffEntitlements(current, desired);
        await apply(tx, diff);
        return counts(diff);
      });
      total.added += done.added;
      total.updated += done.updated;
      total.removed += done.removed;
    }
  });
  await recordChange({ employeeId }, total, options.via ?? "employee");
  return total;
}

/**
 * Drops entitlements that rest on expired grants. Cheap to repeat on any instance: it only
 * visits employees that have an expired grant and reconciles them like a grant change.
 */
export async function sweepExpiredEmployeeGrants(
  db: Db,
  now = new Date(),
): Promise<ReconcileResult> {
  const expired = await runAsSystem("find expired employee grants", () =>
    db.employeeGrant.findMany({
      where: { expiresAt: { lte: now } },
      select: { employeeId: true },
      distinct: ["employeeId"],
    }),
  );
  const total = { ...EMPTY };
  for (const { employeeId } of expired) {
    const done = await reconcileEmployeeEntitlements(db, employeeId, { now, via: "expiry" });
    total.added += done.added;
    total.updated += done.updated;
    total.removed += done.removed;
  }
  return total;
}

async function recordChange(
  scope: { userId: string } | { employeeId: string },
  result: ReconcileResult,
  via: string,
) {
  if (result.added + result.updated + result.removed === 0) return;
  await recordSecurityEvent({
    type: "employee.entitlements_reconciled",
    userId: "userId" in scope ? scope.userId : null,
    metadata: {
      ...("employeeId" in scope ? { employeeId: scope.employeeId } : {}),
      via,
      added: result.added,
      updated: result.updated,
      removed: result.removed,
    },
  });
}
