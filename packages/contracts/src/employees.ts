import * as z from "zod";

/** Lowest to highest. Rank is the position. */
export const EMPLOYEE_ROLES = ["viewer", "collaborator", "manager", "owner"] as const;
export const EmployeeRoleSchema = z.enum(EMPLOYEE_ROLES);
export type EmployeeRole = z.infer<typeof EmployeeRoleSchema>;

/** Where a role came from: a grant naming the user, or a directory claim the user carries. */
export const EMPLOYEE_GRANT_SUBJECT_KINDS = ["user", "claim"] as const;
export const EmployeeGrantSubjectKindSchema = z.enum(EMPLOYEE_GRANT_SUBJECT_KINDS);
export type EmployeeGrantSubjectKind = z.infer<typeof EmployeeGrantSubjectKindSchema>;

export const EMPLOYEE_ENTITLEMENT_SOURCES = ["grant", "claim"] as const;
export const EmployeeEntitlementSourceSchema = z.enum(EMPLOYEE_ENTITLEMENT_SOURCES);
export type EmployeeEntitlementSource = z.infer<typeof EmployeeEntitlementSourceSchema>;

export const EMPLOYEE_LISTINGS = ["listed", "unlisted"] as const;
export const EMPLOYEE_STATUSES = ["draft", "published", "retired"] as const;
export const EmployeeListingSchema = z.enum(EMPLOYEE_LISTINGS);
export const EmployeeStatusSchema = z.enum(EMPLOYEE_STATUSES);
export type EmployeeListing = z.infer<typeof EmployeeListingSchema>;
export type EmployeeStatus = z.infer<typeof EmployeeStatusSchema>;

/**
 * What a person can ask to do with an employee definition. None of them reaches another
 * person's instance: `read_instance_content` exists so that denial is an explicit outcome.
 */
export const EMPLOYEE_ACTIONS = [
  "view_card",
  "use",
  "propose_knowledge",
  "edit",
  "publish",
  "approve_knowledge",
  "configure_credentials",
  "manage_grants",
  "authorize_shared_credential",
  "delete",
  "read_instance_content",
] as const;
export const EmployeeActionSchema = z.enum(EMPLOYEE_ACTIONS);
export type EmployeeAction = z.infer<typeof EmployeeActionSchema>;

export const EMPLOYEE_DENIAL_REASONS = [
  "no_access",
  "insufficient_role",
  "suspended",
  "retired",
  "private_content",
  "not_credential_approver",
  "claim_cannot_be_owner",
  "last_owner",
] as const;
export const EmployeeDenialReasonSchema = z.enum(EMPLOYEE_DENIAL_REASONS);
export type EmployeeDenialReason = z.infer<typeof EmployeeDenialReasonSchema>;
