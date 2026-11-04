import { oc } from "@orpc/contract";
import * as z from "zod";
import { PolicySchema } from "./policy.js";
import { SecurityEventMetadataSchema, SecurityEventTypeSchema } from "./security-events.js";

/**
 * The deployment admin console. Every procedure is for deployment admins only (the accounts
 * `isAdmin` accepts) and returns identifiers, names and counts: never secrets, tokens or message
 * content. See docs/enterprise/features/admin.md.
 */
const Id = z.string().min(1).max(128);

/** What a run, a send or a delegated request says when the AI employee is suspended. */
export const BOT_SUSPENDED_MESSAGE = "Suspended by your organization";
/** The same, when an admin quarantined it (one bot, its Space or chat group, or all bots). */
export const BOT_QUARANTINED_MESSAGE = "Quarantined by your organization";
const pageLimit = (max: number, fallback: number) =>
  z.number().int().min(1).max(max).default(fallback);

export const AdminOverviewSchema = z.object({
  auth: z.object({ password: z.boolean(), sso: z.boolean(), easyAuth: z.boolean() }),
  /** `provider/model` the deployment uses when nothing else is chosen. */
  defaultModel: z.string(),
  computerProvider: z.string(),
  policy: z.object({
    loaded: z.boolean(),
    version: z.number().int().nullable(),
    hash: z.string().nullable(),
  }),
  /** Whether the Free access page applies (the deployment sells model credits). */
  modelCredits: z.boolean(),
  userCount: z.number().int(),
  botCount: z.number().int(),
});
export type AdminOverview = z.infer<typeof AdminOverviewSchema>;

export const AdminPageInputSchema = z.object({
  cursor: Id.optional(),
  limit: pageLimit(100, 50),
});

export const AdminUserSchema = z.object({
  id: z.string(),
  name: z.string(),
  email: z.string(),
  createdAt: z.string(),
  /** How the account is an admin: the email list, or an SSO claim. Null for everyone else. */
  adminVia: z.enum(["email", "sso"]).nullable(),
  ssoLinked: z.boolean(),
  lastSignInAt: z.string().nullable(),
  isSelf: z.boolean(),
});
export type AdminUser = z.infer<typeof AdminUserSchema>;

export const AdminUserPageSchema = z.object({
  users: z.array(AdminUserSchema),
  nextCursor: z.string().nullable(),
});
export type AdminUserPage = z.infer<typeof AdminUserPageSchema>;

export const AdminBotSchema = z.object({
  id: z.string(),
  name: z.string(),
  ownerName: z.string().nullable(),
  ownerEmail: z.string().nullable(),
  spaceName: z.string().nullable(),
  /** `provider/model` set on the bot; null when it follows the deployment default. */
  model: z.string().nullable(),
  lastActiveAt: z.string().nullable(),
  monthlySpendUsd: z.number(),
  archived: z.boolean(),
  /** When an admin suspended it; null when it is active. */
  suspendedAt: z.string().nullable(),
  /** When a quarantine that covers it started; null when none does. */
  quarantinedAt: z.string().nullable(),
});
export type AdminBot = z.infer<typeof AdminBotSchema>;

export const AdminBotPageSchema = z.object({
  bots: z.array(AdminBotSchema),
  nextCursor: z.string().nullable(),
});
export type AdminBotPage = z.infer<typeof AdminBotPageSchema>;

export const AdminComputerSchema = z.object({
  id: z.string(),
  /** The provider kind that holds it, such as `docker` or `kubernetes`. */
  kind: z.string(),
  scope: z.string(),
  state: z.string(),
  ownerName: z.string().nullable(),
  ownerEmail: z.string().nullable(),
  spaceName: z.string().nullable(),
  bots: z.array(z.object({ id: z.string(), name: z.string() })),
  /** The image reference the machine was started from; null until the provider reports one. */
  image: z.string().nullable(),
  isolation: z.enum(["container", "microvm", "vm", "host", "unknown"]).nullable(),
  /**
   * Whether `image` and `isolation` came from the provider: `skipped_unsupported` when it cannot
   * report them, `unavailable` when it could not be reached, `not_running` when nothing was asked.
   */
  inspection: z.enum(["inspected", "skipped_unsupported", "unavailable", "not_running"]),
  runningSince: z.string().nullable(),
  lastActivityAt: z.string().nullable(),
});
export type AdminComputer = z.infer<typeof AdminComputerSchema>;

export const AdminComputerPageSchema = z.object({
  computers: z.array(AdminComputerSchema),
  nextCursor: z.string().nullable(),
});
export type AdminComputerPage = z.infer<typeof AdminComputerPageSchema>;

const SpendRowSchema = z.object({ id: z.string(), label: z.string(), spentUsd: z.number() });

export const AdminPolicyViewSchema = z.object({
  loaded: z.boolean(),
  version: z.number().int().nullable(),
  hash: z.string().nullable(),
  /** The parsed policy file. Policy files hold rules only, never credentials. */
  policy: PolicySchema.nullable(),
  spend: z.object({
    periodStart: z.string(),
    organizationUsd: z.number(),
    users: z.array(SpendRowSchema),
    bots: z.array(SpendRowSchema),
  }),
  limits: z.object({
    organizationUsd: z.number().nullable(),
    perUserUsd: z.number().nullable(),
    perBotUsd: z.number().nullable(),
  }),
  denied: z.array(
    z.object({
      id: z.string(),
      createdAt: z.string(),
      userEmail: z.string().nullable(),
      rule: z.string().nullable(),
      subject: z.string().nullable(),
      surface: z.string().nullable(),
    }),
  ),
});
export type AdminPolicyView = z.infer<typeof AdminPolicyViewSchema>;

export const AdminAuditInputSchema = z.object({
  type: SecurityEventTypeSchema.optional(),
  /** An account's email address; matched exactly. */
  user: z.string().max(254).optional(),
  from: z.string().datetime({ offset: true }).optional(),
  to: z.string().datetime({ offset: true }).optional(),
  cursor: Id.optional(),
  limit: pageLimit(200, 50),
});
export type AdminAuditInput = z.infer<typeof AdminAuditInputSchema>;

export const AdminAuditPageSchema = z.object({
  events: z.array(
    z.object({
      id: z.string(),
      type: SecurityEventTypeSchema,
      createdAt: z.string(),
      userEmail: z.string().nullable(),
      ip: z.string().nullable(),
      metadata: SecurityEventMetadataSchema,
    }),
  ),
  nextCursor: z.string().nullable(),
});
export type AdminAuditPage = z.infer<typeof AdminAuditPageSchema>;

export const QuarantineScopeKindSchema = z.enum(["bot", "space", "group", "all"]);

export const AdminQuarantineSchema = z.object({
  id: z.string(),
  scopeKind: QuarantineScopeKindSchema,
  scopeId: z.string().nullable(),
  /** The bot, Space or chat group name; null for everything or when it no longer exists. */
  scopeName: z.string().nullable(),
  reason: z.string(),
  createdAt: z.string(),
});
export type AdminQuarantine = z.infer<typeof AdminQuarantineSchema>;

export const AdminQuarantineStartSchema = z
  .object({
    scopeKind: QuarantineScopeKindSchema,
    scopeId: Id.optional(),
    reason: z.string().trim().max(200).optional(),
  })
  .refine((input) => (input.scopeKind === "all") === (input.scopeId === undefined), {
    message: "scopeId is required for every scope except all",
  });

export const adminContract = {
  overview: oc.output(AdminOverviewSchema),
  users: {
    list: oc.input(AdminPageInputSchema).output(AdminUserPageSchema),
    /** Signs the account out everywhere. Not available on your own account. */
    endSessions: oc.input(z.object({ userId: Id })).output(z.object({ ended: z.number().int() })),
  },
  bots: {
    list: oc.input(AdminPageInputSchema).output(AdminBotPageSchema),
    /** Stops its runs and refuses new ones from every source until resumed. Idempotent. */
    suspend: oc
      .input(z.object({ botId: Id, reason: z.string().trim().max(200).optional() }))
      .output(z.object({ cancelledRuns: z.number().int() })),
    resume: oc.input(z.object({ botId: Id })).output(z.object({ ok: z.literal(true) })),
  },
  /**
   * Incident stop for one bot, a Space, a chat group or every bot: cancels active runs, blocks new
   * runs and every tool, connector and computer call, and removes the bots' own secrets and MCP
   * assignments. Personal connections are never revoked. Releasing restores none of that.
   */
  quarantine: {
    list: oc.output(z.object({ quarantines: z.array(AdminQuarantineSchema) })),
    start: oc.input(AdminQuarantineStartSchema).output(
      z.object({
        id: z.string(),
        bots: z.number().int(),
        cancelledRuns: z.number().int(),
        revokedSecrets: z.number().int(),
        revokedMcpAssignments: z.number().int(),
      }),
    ),
    lift: oc.input(z.object({ id: Id })).output(z.object({ ok: z.literal(true) })),
  },
  /** Every bot computer in the deployment. Read-only; metadata only, never content. */
  computers: { list: oc.input(AdminPageInputSchema).output(AdminComputerPageSchema) },
  policy: oc.output(AdminPolicyViewSchema),
  audit: oc.input(AdminAuditInputSchema).output(AdminAuditPageSchema),
};
