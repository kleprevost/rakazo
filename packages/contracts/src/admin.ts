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

/** What a run says when it is refused before the model because the shared employee behind it is unavailable. */
export const EMPLOYEE_ACCESS_REMOVED_MESSAGE = "Access removed";
export const EMPLOYEE_SUSPENDED_MESSAGE = "This employee is suspended";
export const EMPLOYEE_UNAVAILABLE_MESSAGE = "This employee is no longer available";
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
  /**
   * The provider's health report from the latest observation. `unknown` when none exists or it is
   * older than three observation intervals; never `ok` on stale data.
   */
  health: z.enum(["ok", "degraded", "unreachable", "unknown"]),
  /**
   * The last known image against `computers.images` in central policy: null when the policy lists
   * no images, `unknown` before any image is known, `not_approved` for a digest off the list or an
   * image with no digest.
   */
  imageCompliance: z.enum(["approved", "not_approved", "unknown"]).nullable(),
  runningSince: z.string().nullable(),
  lastActivityAt: z.string().nullable(),
});
export type AdminComputer = z.infer<typeof AdminComputerSchema>;

/** One stretch the computer ran; the restart history. */
export const AdminComputerRunSchema = z.object({
  startedAt: z.string(),
  endedAt: z.string().nullable(),
  endReason: z.string().nullable(),
  lastSeenAt: z.string().nullable(),
});

/** Everything the list shows plus the latest observation and restart history. Metadata only. */
export const AdminComputerDetailSchema = AdminComputerSchema.extend({
  createdAt: z.string(),
  /** The content digest actually running, when the provider reports one. */
  imageDigest: z.string().nullable(),
  /** The home's disk as last measured; null where it never was. */
  disk: z.object({ usedBytes: z.number(), freeBytes: z.number() }).nullable(),
  /** The latest stored observation, even when stale; null before the first one. */
  observation: z
    .object({
      observedAt: z.string(),
      runtime: z.enum(["running", "stopped", "gone"]),
      startedAt: z.string().nullable(),
      /** Provider-visible restarts of the same machine. */
      restartCount: z.number().int().nullable(),
      usage: z
        .object({
          cpuMillis: z.number().nullable(),
          memoryBytes: z.number().nullable(),
          memoryLimitBytes: z.number().nullable(),
          pids: z.number().nullable(),
        })
        .nullable(),
      egress: z
        .object({
          mode: z.enum(["open", "restricted", "isolated", "unknown"]),
          enforced: z.boolean(),
        })
        .nullable(),
    })
    .nullable(),
  /** Newest first, the last 20. */
  runs: z.array(AdminComputerRunSchema),
});
export type AdminComputerDetail = z.infer<typeof AdminComputerDetailSchema>;

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
   * Incident stop for one bot, a Space, a chat group or every bot: cancels active runs and blocks
   * new runs and every tool, connector, MCP, webhook and computer call. Nothing is deleted or
   * revoked, so releasing restores full function.
   */
  quarantine: {
    list: oc.output(z.object({ quarantines: z.array(AdminQuarantineSchema) })),
    start: oc.input(AdminQuarantineStartSchema).output(
      z.object({
        id: z.string(),
        bots: z.number().int(),
        cancelledRuns: z.number().int(),
      }),
    ),
    lift: oc.input(z.object({ id: Id })).output(z.object({ ok: z.literal(true) })),
  },
  /** Every bot computer in the deployment. Read-only; metadata only, never content. */
  computers: {
    list: oc
      .input(
        AdminPageInputSchema.extend({
          /** Only computers whose last known image the policy does not approve; none without a policy list. */
          imageCompliance: z.literal("not_approved").optional(),
        }),
      )
      .output(AdminComputerPageSchema),
    get: oc.input(z.object({ computerId: Id })).output(AdminComputerDetailSchema),
  },
  policy: oc.output(AdminPolicyViewSchema),
  audit: oc.input(AdminAuditInputSchema).output(AdminAuditPageSchema),
};
