import { oc } from "@orpc/contract";
import * as z from "zod";
import { Id, IsoDate } from "./ids.js";

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

const Name = z.string().trim().min(1).max(120);

/** What the directory shows of an employee. Never an instance's thread, memory or computer. */
export const EmployeeCardSchema = z.object({
  id: Id,
  name: z.string(),
  description: z.string(),
  status: EmployeeStatusSchema,
  listing: EmployeeListingSchema,
  /** The caller's highest entitled role. */
  role: EmployeeRoleSchema,
  currentVersion: z.number().int().nullable(),
  suspended: z.boolean(),
});
export type EmployeeCard = z.infer<typeof EmployeeCardSchema>;

export const EmployeeVersionSchema = z.object({
  id: Id,
  number: z.number().int(),
  state: z.enum(["draft", "published"]),
  role: z.string(),
  instructions: z.string(),
  skills: z.array(z.string()),
  capabilityPolicy: z.record(z.string(), z.unknown()),
  modelPolicy: z.record(z.string(), z.unknown()),
  publishedAt: IsoDate.nullable(),
  current: z.boolean(),
});
export type EmployeeVersion = z.infer<typeof EmployeeVersionSchema>;

/** Definition content comes only with `edit`: a Viewer or Collaborator sees the card. */
export const EmployeeDetailSchema = z.object({
  employee: EmployeeCardSchema,
  versions: z.array(EmployeeVersionSchema).nullable(),
});
export type EmployeeDetail = z.infer<typeof EmployeeDetailSchema>;

export const EmployeeGrantSchema = z.object({
  subjectKind: EmployeeGrantSubjectKindSchema,
  subjectValue: z.string(),
  role: EmployeeRoleSchema,
  grantedBy: z.string(),
  expiresAt: IsoDate.nullable(),
});
export type EmployeeGrant = z.infer<typeof EmployeeGrantSchema>;

export const EmployeeDraftInputSchema = z.object({
  employeeId: Id,
  role: z.string().max(2_000).optional(),
  instructions: z.string().max(200_000).optional(),
  skills: z.array(z.string().min(1).max(200)).max(200).optional(),
  capabilityPolicy: z.record(z.string(), z.unknown()).optional(),
  modelPolicy: z.record(z.string(), z.unknown()).optional(),
});

export const EmployeeGrantSetInputSchema = z.object({
  employeeId: Id,
  subjectKind: EmployeeGrantSubjectKindSchema,
  subjectValue: z.string().trim().min(1).max(256),
  role: EmployeeRoleSchema,
  /** Not allowed for Owner: an Owner who expires could leave the employee without one. */
  expiresAt: IsoDate.optional(),
});

export const employeesContract = {
  /** Everything the caller is entitled to, any role. */
  list: oc.output(z.array(EmployeeCardSchema)),
  get: oc.input(z.object({ employeeId: Id })).output(EmployeeDetailSchema),
  /**
   * Turns the caller's own AI employee into the first instance of a new shared employee: version 1
   * is a snapshot of its definition, the caller becomes Owner, and its thread, memory and computer
   * stay exactly as they were.
   */
  share: oc
    .input(z.object({ botId: Id, name: Name.optional() }))
    .output(z.object({ employeeId: Id })),
  /**
   * Gives the caller their own working copy of an employee they may use: a bot in their own space
   * that follows the current version. Repeating it returns the same bot.
   */
  addInstance: oc
    .input(z.object({ employeeId: Id }))
    .output(z.object({ botId: Id, created: z.boolean() })),
  versions: {
    /** Edits the open draft, or opens the next one from the current version. */
    saveDraft: oc.input(EmployeeDraftInputSchema).output(EmployeeVersionSchema),
    /** Makes a draft the current version. A published version is never edited. */
    publish: oc.input(z.object({ employeeId: Id, versionId: Id })).output(EmployeeCardSchema),
    /** Points the employee back at an earlier published version. */
    rollback: oc.input(z.object({ employeeId: Id, versionId: Id })).output(EmployeeCardSchema),
  },
  grants: {
    list: oc.input(z.object({ employeeId: Id })).output(z.array(EmployeeGrantSchema)),
    set: oc.input(EmployeeGrantSetInputSchema).output(EmployeeGrantSchema),
    remove: oc
      .input(
        z.object({
          employeeId: Id,
          subjectKind: EmployeeGrantSubjectKindSchema,
          subjectValue: z.string().min(1).max(256),
        }),
      )
      .output(z.object({ ok: z.literal(true) })),
  },
};
