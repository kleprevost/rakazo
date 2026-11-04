import { ORPCError } from "@orpc/server";
import type {
  Actor,
  EmployeeAccessRequest,
  EmployeeDirectoryEntry,
  EmployeeRole,
} from "@rakazo/contracts";
import { EmployeeRoleSchema } from "@rakazo/contracts";
import { effectiveEmployeeRole, employeeRoleRank, evaluateEmployeeAccess } from "@rakazo/core";
import { recordSecurityEvent, runAsSystem } from "@rakazo/db";
import { authorize, setGrant } from "./employees.js";
import type { RouterDeps } from "./router.js";

/**
 * The directory and access requests. The directory is the one place a person sees employees they
 * are not entitled to, so it reads as system, but only listed and published employees, and only
 * card fields plus the owner's name: nothing from any instance. Requests are written as system after
 * the application checks; approving one goes through the same grant procedure as the Share dialog.
 */

type DirectoryDeps = Pick<RouterDeps, "prisma" | "env">;

const DIRECTORY_LIMIT = 200;
/** Role handed out when a request is approved: use, never manage. */
const REQUESTED_ROLE: EmployeeRole = "collaborator";
const system = <T>(what: string, fn: () => Promise<T>) =>
  runAsSystem(`employee directory: ${what}`, fn);

const isUniqueViolation = (error: unknown) =>
  typeof error === "object" && error !== null && (error as { code?: unknown }).code === "P2002";

function requireEnabled(deps: DirectoryDeps) {
  if (!deps.env.sharedEmployeesEnabled)
    throw new ORPCError("FORBIDDEN", { message: "Shared employees are not turned on" });
}

const parseRole = (value: string): EmployeeRole | null => {
  const parsed = EmployeeRoleSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
};

/**
 * Listed, published, running employees, plus every employee the caller is entitled to (listed or
 * not). An unlisted employee the caller has no entitlement to is never returned.
 */
export async function listDirectory(
  deps: DirectoryDeps,
  actor: Actor,
): Promise<EmployeeDirectoryEntry[]> {
  requireEnabled(deps);
  const userId = actor.userId;
  return system("list", async () => {
    const rows = await deps.prisma.employee.findMany({
      where: {
        OR: [
          { listing: "listed", status: "published", suspendedAt: null },
          { status: { not: "retired" }, entitlements: { some: { userId } } },
        ],
      },
      select: {
        id: true,
        name: true,
        description: true,
        status: true,
        suspendedAt: true,
        entitlements: { where: { userId }, select: { role: true, source: true } },
        accessRequests: {
          where: { requesterUserId: userId, status: "pending" },
          select: { id: true },
          take: 1,
        },
        grants: { where: { subjectKind: "user", role: "owner" }, select: { subjectValue: true } },
      },
      orderBy: [{ name: "asc" }, { id: "asc" }],
      take: DIRECTORY_LIMIT,
    });
    const ownerIds = [...new Set(rows.flatMap((row) => row.grants.map((g) => g.subjectValue)))];
    const owners = await deps.prisma.user.findMany({
      where: { id: { in: ownerIds } },
      select: { id: true, name: true, email: true },
    });
    const names = new Map(owners.map((owner) => [owner.id, owner.name || owner.email]));
    return rows.map((row) => {
      const role = effectiveEmployeeRole(
        row.entitlements.flatMap((entitlement) => {
          const parsed = parseRole(entitlement.role);
          return parsed && (entitlement.source === "grant" || entitlement.source === "claim")
            ? [{ role: parsed, source: entitlement.source }]
            : [];
        }),
      );
      const ownerId = row.grants[0]?.subjectValue;
      return {
        id: row.id,
        name: row.name,
        description: row.description,
        ownerName: ownerId ? (names.get(ownerId) ?? null) : null,
        role,
        canUse: evaluateEmployeeAccess({
          role,
          action: "use",
          employee: {
            status: row.status === "draft" || row.status === "retired" ? row.status : "published",
            suspendedAt: row.suspendedAt,
          },
        }).allowed,
        requested: row.accessRequests.length > 0,
      };
    });
  });
}

/** Opens a request for a listed employee the caller has no role on. Repeating it is harmless. */
export async function requestAccess(
  deps: DirectoryDeps,
  actor: Actor,
  input: { employeeId: string },
): Promise<{ ok: true }> {
  requireEnabled(deps);
  const { employeeId } = input;
  const created = await system("request", async () => {
    // Unlisted, draft, retired and suspended employees answer exactly like missing ones.
    const employee = await deps.prisma.employee.findFirst({
      where: { id: employeeId, listing: "listed", status: "published", suspendedAt: null },
      select: { id: true },
    });
    if (!employee) throw new ORPCError("NOT_FOUND", { message: "Employee not found" });
    const entitled = await deps.prisma.employeeEntitlement.count({
      where: { employeeId, userId: actor.userId },
    });
    if (entitled > 0) throw new ORPCError("CONFLICT", { message: "You already have access" });
    try {
      return await deps.prisma.employeeAccessRequest.create({
        data: { employeeId, requesterUserId: actor.userId, requestedRole: REQUESTED_ROLE },
        select: { id: true },
      });
    } catch (error) {
      if (isUniqueViolation(error)) return null;
      throw error;
    }
  });
  if (created) {
    await recordSecurityEvent({
      type: "employee.access_requested",
      userId: actor.userId,
      spaceId: actor.spaceId,
      metadata: { employeeId, requestId: created.id },
    });
  }
  return { ok: true };
}

/** Open requests for Owners and Managers, read under their own row-level scope. */
export async function listRequests(
  deps: DirectoryDeps,
  actor: Actor,
  input: { employeeId: string },
): Promise<EmployeeAccessRequest[]> {
  requireEnabled(deps);
  await authorize(deps.prisma, actor.userId, input.employeeId, "manage_grants");
  const rows = await deps.prisma.employeeAccessRequest.findMany({
    where: { employeeId: input.employeeId, status: "pending" },
    select: {
      id: true,
      requestedRole: true,
      createdAt: true,
      requester: { select: { name: true, email: true } },
    },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
  return rows.map((row) => ({
    id: row.id,
    requesterName: row.requester.name || row.requester.email,
    requesterEmail: row.requester.email,
    requestedRole: parseRole(row.requestedRole) ?? REQUESTED_ROLE,
    createdAt: row.createdAt.toISOString(),
  }));
}

/**
 * Approve creates an ordinary user grant (which reconciles entitlements and is audited), unless
 * the person already holds the role through another route; deny only closes the request.
 */
export async function decideRequest(
  deps: DirectoryDeps,
  actor: Actor,
  input: { employeeId: string; requestId: string; decision: "approve" | "deny" },
): Promise<{ ok: true }> {
  requireEnabled(deps);
  const { employeeId, requestId, decision } = input;
  await authorize(deps.prisma, actor.userId, employeeId, "manage_grants");
  const request = await deps.prisma.employeeAccessRequest.findFirst({
    where: { id: requestId, employeeId },
    select: { requesterUserId: true, requestedRole: true, status: true },
  });
  if (!request) throw new ORPCError("NOT_FOUND", { message: "Request not found" });
  if (request.status !== "pending")
    throw new ORPCError("CONFLICT", { message: "This request was already decided" });

  if (decision === "approve") {
    const wanted = parseRole(request.requestedRole) ?? REQUESTED_ROLE;
    const held = await system("held role", async () =>
      effectiveEmployeeRole(
        (
          await deps.prisma.employeeEntitlement.findMany({
            where: { employeeId, userId: request.requesterUserId },
            select: { role: true, source: true },
          })
        ).flatMap((row) => {
          const role = parseRole(row.role);
          return role && (row.source === "grant" || row.source === "claim")
            ? [{ role, source: row.source }]
            : [];
        }),
      ),
    );
    // A grant never lowers a role the person already has.
    if (!held || employeeRoleRank(held) < employeeRoleRank(wanted)) {
      await setGrant(deps, actor, {
        employeeId,
        subjectKind: "user",
        subjectValue: request.requesterUserId,
        role: wanted,
      });
    }
  }
  const closed = await system("decide", () =>
    deps.prisma.employeeAccessRequest.updateMany({
      where: { id: requestId, employeeId, status: "pending" },
      data: {
        status: decision === "approve" ? "approved" : "denied",
        decidedBy: actor.userId,
        decidedAt: new Date(),
      },
    }),
  );
  if (closed.count !== 1)
    throw new ORPCError("CONFLICT", { message: "This request was already decided" });
  await recordSecurityEvent({
    type: "employee.access_decided",
    userId: actor.userId,
    spaceId: actor.spaceId,
    metadata: { employeeId, requestId, requesterId: request.requesterUserId, decision },
  });
  return { ok: true };
}
