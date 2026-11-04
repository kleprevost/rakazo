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
  /** A person's name, set by the server on listings; a directory group shows its value. */
  subjectLabel: z.string().optional(),
});
export type EmployeeGrant = z.infer<typeof EmployeeGrantSchema>;

/**
 * One directory row: a listed employee, or one the caller is entitled to. It carries the card
 * fields and the owner's name only, never anything from an instance.
 */
export const EmployeeDirectoryEntrySchema = z.object({
  id: Id,
  name: z.string(),
  description: z.string(),
  ownerName: z.string().nullable(),
  /** The caller's highest role, or null when they have none. */
  role: EmployeeRoleSchema.nullable(),
  /** The caller may add their own instance (`use`). */
  canUse: z.boolean(),
  /** The caller has an open request. */
  requested: z.boolean(),
});
export type EmployeeDirectoryEntry = z.infer<typeof EmployeeDirectoryEntrySchema>;

export const EmployeeAccessRequestSchema = z.object({
  id: Id,
  requesterName: z.string(),
  requesterEmail: z.string(),
  requestedRole: EmployeeRoleSchema,
  createdAt: IsoDate,
});
export type EmployeeAccessRequest = z.infer<typeof EmployeeAccessRequestSchema>;

/** Shared knowledge is plain text under a relative path, like a memory document. */
export const EMPLOYEE_KNOWLEDGE_CONTENT_MAX = 20_000;
export const EmployeeKnowledgePathSchema = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .refine((path) => !path.startsWith("/") && !path.split("/").some((part) => part === ".."), {
    message: "Use a relative path",
  });
export const EmployeeKnowledgeContentSchema = z.string().min(1).max(EMPLOYEE_KNOWLEDGE_CONTENT_MAX);

export const EmployeeKnowledgeSchema = z.object({
  path: z.string(),
  content: z.string(),
  revision: z.number().int(),
  updatedAt: IsoDate,
});
export type EmployeeKnowledge = z.infer<typeof EmployeeKnowledgeSchema>;

/**
 * A pending proposal as a reviewer sees it: the submitted text, the approved text it would
 * replace, and whether that text has changed since. The proposer is not named.
 */
export const EmployeeKnowledgeProposalSchema = z.object({
  id: Id,
  path: z.string(),
  content: z.string(),
  currentContent: z.string().nullable(),
  stale: z.boolean(),
  createdAt: IsoDate,
});
export type EmployeeKnowledgeProposal = z.infer<typeof EmployeeKnowledgeProposalSchema>;

/** The caller's own open proposal. */
export const EmployeeOwnProposalSchema = z.object({
  id: Id,
  path: z.string(),
  createdAt: IsoDate,
});

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
  /** Listed employees and the caller's own, with their access state. Needs the feature on. */
  directory: oc.output(z.array(EmployeeDirectoryEntrySchema)),
  requests: {
    /** Asks for access to a listed employee the caller cannot use yet. Repeating it changes nothing. */
    create: oc.input(z.object({ employeeId: Id })).output(z.object({ ok: z.literal(true) })),
    /** Open requests for an employee, for Owners and Managers. */
    list: oc.input(z.object({ employeeId: Id })).output(z.array(EmployeeAccessRequestSchema)),
    /** Approving creates the grant; denying only closes the request. */
    decide: oc
      .input(
        z.object({
          employeeId: Id,
          requestId: Id,
          decision: z.enum(["approve", "deny"]),
        }),
      )
      .output(z.object({ ok: z.literal(true) })),
  },
  versions: {
    /** Edits the open draft, or opens the next one from the current version. */
    saveDraft: oc.input(EmployeeDraftInputSchema).output(EmployeeVersionSchema),
    /** Makes a draft the current version. A published version is never edited. */
    publish: oc.input(z.object({ employeeId: Id, versionId: Id })).output(EmployeeCardSchema),
    /** Points the employee back at an earlier published version. */
    rollback: oc.input(z.object({ employeeId: Id, versionId: Id })).output(EmployeeCardSchema),
  },
  knowledge: {
    /** Approved shared knowledge, for anyone who may use the employee. */
    list: oc.input(z.object({ employeeId: Id })).output(z.array(EmployeeKnowledgeSchema)),
    /**
     * Offers text to the reviewers. The text is copied as submitted; nothing links it to the
     * private note it came from. Text that looks like a credential is refused.
     */
    propose: oc
      .input(
        z.object({
          employeeId: Id,
          path: EmployeeKnowledgePathSchema,
          content: EmployeeKnowledgeContentSchema,
        }),
      )
      .output(z.object({ ok: z.literal(true) })),
    /** Writes approved knowledge directly. Owners and Managers only. */
    set: oc
      .input(
        z.object({
          employeeId: Id,
          path: EmployeeKnowledgePathSchema,
          content: EmployeeKnowledgeContentSchema,
          /** The revision the editor loaded; omit for a new path. */
          expectedRevision: z.number().int().optional(),
        }),
      )
      .output(EmployeeKnowledgeSchema),
    /** Takes a path out of the prompt from the next run. Owners and Managers only. */
    retire: oc
      .input(z.object({ employeeId: Id, path: EmployeeKnowledgePathSchema }))
      .output(z.object({ ok: z.literal(true) })),
    proposals: {
      /** Pending proposals, for Owners and Managers. */
      list: oc.input(z.object({ employeeId: Id })).output(z.array(EmployeeKnowledgeProposalSchema)),
      /** The caller's own pending proposals. */
      mine: oc.input(z.object({ employeeId: Id })).output(z.array(EmployeeOwnProposalSchema)),
      decide: oc
        .input(
          z.object({
            employeeId: Id,
            proposalId: Id,
            decision: z.enum(["approve", "reject"]),
            reason: z.string().max(500).optional(),
          }),
        )
        .output(z.object({ ok: z.literal(true) })),
      withdraw: oc
        .input(z.object({ employeeId: Id, proposalId: Id }))
        .output(z.object({ ok: z.literal(true) })),
    },
  },
  /** People a Manager or Owner can name in a grant. Identity only. */
  people: {
    search: oc
      .input(z.object({ employeeId: Id, q: z.string().max(100) }))
      .output(z.array(z.object({ userId: Id, name: z.string(), email: z.string() }))),
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
