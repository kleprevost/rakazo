import type {
  EmployeeAction,
  EmployeeDenialReason,
  EmployeeEntitlementSource,
  EmployeeGrantSubjectKind,
  EmployeeRole,
  EmployeeStatus,
} from "@rakazo/contracts";
import { EMPLOYEE_ROLES } from "@rakazo/contracts";

/**
 * Employee access: may this person do this to the employee definition? Pure and deny by
 * default. The second question, who owns a thread, memory or credential, stays with the
 * existing space and user checks; nothing here ever grants access to an instance.
 */

export type EmployeeGrantInput = {
  subjectKind: EmployeeGrantSubjectKind;
  /** A user id, or a directory claim value. */
  subjectValue: string;
  role: EmployeeRole;
  expiresAt?: Date | null;
};

export type EmployeeIdentity = {
  userId: string;
  /** Directory claim values from the last sign-in or revalidation. */
  claimValues: readonly string[];
  /** The directory returned a link instead of the full list: claim grants are not trusted. */
  claimsTruncated?: boolean;
};

export type EmployeeEntitlementRow = {
  role: EmployeeRole;
  source: EmployeeEntitlementSource;
};

export type EmployeeDecision = { allowed: true } | { allowed: false; reason: EmployeeDenialReason };

const ALLOW: EmployeeDecision = { allowed: true };
const deny = (reason: EmployeeDenialReason): EmployeeDecision => ({ allowed: false, reason });

export function employeeRoleRank(role: EmployeeRole): number {
  return EMPLOYEE_ROLES.indexOf(role);
}

function highest(roles: readonly EmployeeRole[]): EmployeeRole | null {
  return roles.reduce<EmployeeRole | null>(
    (best, role) =>
      best === null || employeeRoleRank(role) > employeeRoleRank(best) ? role : best,
    null,
  );
}

/**
 * The role each source gives this person, the highest per source. Expired grants confer
 * nothing; a claim never confers Owner; truncated claims confer nothing.
 */
export function resolveEmployeeEntitlements(
  identity: EmployeeIdentity,
  grants: readonly EmployeeGrantInput[],
  now: Date,
): EmployeeEntitlementRow[] {
  const live = grants.filter(
    (grant) => !grant.expiresAt || grant.expiresAt.getTime() > now.getTime(),
  );
  const explicit = highest(
    live
      .filter((grant) => grant.subjectKind === "user" && grant.subjectValue === identity.userId)
      .map((grant) => grant.role),
  );
  const claimed = identity.claimsTruncated
    ? null
    : highest(
        live
          .filter(
            (grant) =>
              grant.subjectKind === "claim" &&
              grant.role !== "owner" &&
              identity.claimValues.includes(grant.subjectValue),
          )
          .map((grant) => grant.role),
      );
  const rows: EmployeeEntitlementRow[] = [];
  if (explicit) rows.push({ role: explicit, source: "grant" });
  if (claimed) rows.push({ role: claimed, source: "claim" });
  return rows;
}

/** The highest role across sources, or null when the person has no entitlement. */
export function effectiveEmployeeRole(
  entitlements: readonly EmployeeEntitlementRow[],
): EmployeeRole | null {
  return highest(entitlements.map((row) => row.role));
}

/** The lowest role that may do each action. `null`: no role may, whoever asks. */
const MINIMUM_ROLE: Record<EmployeeAction, EmployeeRole | null> = {
  view_card: "viewer",
  use: "collaborator",
  propose_knowledge: "collaborator",
  edit: "manager",
  publish: "manager",
  approve_knowledge: "manager",
  // Managers configure which credential an employee uses; they cannot attach a shared one.
  configure_credentials: "manager",
  manage_grants: "manager",
  authorize_shared_credential: "owner",
  delete: "owner",
  // A manager, an owner and an admin reach definitions, never another person's instance.
  read_instance_content: null,
};

export type EmployeeAccessRequest = {
  /** Highest entitled role, null when none. */
  role: EmployeeRole | null;
  action: EmployeeAction;
  /** The person asking; only needed for `authorize_shared_credential`. */
  userId?: string;
  employee?: { status: EmployeeStatus; suspendedAt?: Date | null };
  /** Admin-configured people besides the Owner who may authorize shared credentials. */
  credentialApproverUserIds?: readonly string[];
};

export function evaluateEmployeeAccess(request: EmployeeAccessRequest): EmployeeDecision {
  const { role, action } = request;
  // Decided before looking at the role: no entitlement and no admin override changes it.
  if (MINIMUM_ROLE[action] === null) return deny("private_content");
  if (role === null) return deny("no_access");

  if (action === "authorize_shared_credential") {
    if (role === "owner") return ALLOW;
    const listed =
      request.userId !== undefined && request.credentialApproverUserIds?.includes(request.userId);
    // A listed approver still needs a working entitlement; a Viewer on the list cannot approve.
    if (listed && employeeRoleRank(role) >= employeeRoleRank("collaborator")) return ALLOW;
    return deny(
      employeeRoleRank(role) >= employeeRoleRank("manager")
        ? "not_credential_approver"
        : "insufficient_role",
    );
  }

  const minimum = MINIMUM_ROLE[action];
  if (minimum === null || employeeRoleRank(role) < employeeRoleRank(minimum)) {
    return deny("insufficient_role");
  }

  if (action === "use") {
    if (request.employee?.suspendedAt) return deny("suspended");
    if (request.employee?.status === "retired") return deny("retired");
  }
  return ALLOW;
}

export type EmployeeGrantChange = {
  actorRole: EmployeeRole | null;
  subjectKind: EmployeeGrantSubjectKind;
  /** The subject's role before the change; null when adding. */
  from: EmployeeRole | null;
  /** The subject's role after the change; null when removing. */
  to: EmployeeRole | null;
  /** Owners the employee has now, counting the subject when `from` is owner. */
  ownerCount: number;
};

/**
 * May the actor add, change or remove this grant? Owners change any role; Managers only
 * Collaborator and Viewer grants. A claim cannot confer Owner and the last Owner stays.
 */
export function evaluateGrantChange(change: EmployeeGrantChange): EmployeeDecision {
  const base = evaluateEmployeeAccess({ role: change.actorRole, action: "manage_grants" });
  if (!base.allowed) return base;
  if (change.to === "owner" && change.subjectKind === "claim") return deny("claim_cannot_be_owner");
  if (change.from === "owner" && change.to !== "owner" && change.ownerCount <= 1) {
    return deny("last_owner");
  }
  if (change.actorRole !== "owner") {
    const touchesManagerTier = [change.from, change.to].some(
      (role) => role === "manager" || role === "owner",
    );
    if (touchesManagerTier) return deny("insufficient_role");
  }
  return ALLOW;
}
