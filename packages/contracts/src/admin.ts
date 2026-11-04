import { oc } from "@orpc/contract";
import * as z from "zod";
import { CapabilityModeSchema } from "./capability-grants.js";
import { IMAGE_DIGEST, PolicySchema } from "./policy.js";
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

/** What a bot is told when the capability broker refuses a call. */
export const CAPABILITY_DENIED_MESSAGE = "Not permitted for this bot";

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
  /** Whether the capability broker is in use: central policy has a capabilities section or a bot has a mode. */
  capabilityBroker: z.boolean(),
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
  /** When the account was deprovisioned; it cannot sign in until reactivated. */
  deprovisionedAt: z.string().nullable(),
});
export type AdminUser = z.infer<typeof AdminUserSchema>;

export const DeprovisionResultSchema = z.object({
  endedSessions: z.number().int(),
  suspendedBots: z.number().int(),
  cancelledRuns: z.number().int(),
  revokedGrants: z.number().int(),
});
export type DeprovisionResult = z.infer<typeof DeprovisionResultSchema>;

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

export const AdminCapabilityBotSchema = z.object({
  id: z.string(),
  name: z.string(),
  ownerEmail: z.string().nullable(),
  spaceName: z.string().nullable(),
  mode: CapabilityModeSchema.nullable(),
  /** Its own live grants (an employee's inherited ones are not counted). */
  grants: z.number().int(),
  /** Calls `shadow` recorded as denied in the last seven days. */
  wouldDeny: z.number().int(),
});
export type AdminCapabilityBot = z.infer<typeof AdminCapabilityBotSchema>;

export const AdminCapabilityPageSchema = z.object({
  bots: z.array(AdminCapabilityBotSchema),
  nextCursor: z.string().nullable(),
});
export type AdminCapabilityPage = z.infer<typeof AdminCapabilityPageSchema>;

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
  /** When an admin quarantined it; null when it is not. */
  quarantinedAt: z.string().nullable(),
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

export const NetworkIsolationOutcomeSchema = z.enum([
  "applied",
  "not_running",
  "unsupported",
  "failed",
]);

export const FLEET_OPERATION_KINDS = ["hibernate", "wake", "recreate", "terminate"] as const;
export const FleetOperationKindSchema = z.enum(FLEET_OPERATION_KINDS);
export const FLEET_MAX_COMPUTERS = 200;
export const FLEET_MAX_PARALLEL = 10;
export const FLEET_DEFAULT_PARALLEL = 3;
export const FLEET_DEFAULT_HALT_AFTER = 2;

export const FleetOperationStatusSchema = z.enum([
  "queued",
  "running",
  "completed",
  "completed_with_failures",
]);

export const FleetItemStatusSchema = z.enum([
  "queued",
  "running",
  "succeeded",
  "failed",
  "skipped_unsupported",
  "skipped_busy",
  "halted",
  "interrupted",
]);

export const FleetOperationInputSchema = z.object({
  kind: FleetOperationKindSchema,
  computerIds: z.array(Id).min(1).max(FLEET_MAX_COMPUTERS),
  /** Recreate only: an image on the policy's approved list; without one the provider's own image. */
  imageDigest: z.string().regex(IMAGE_DIGEST).optional(),
  maxParallel: z.number().int().min(1).max(FLEET_MAX_PARALLEL).default(FLEET_DEFAULT_PARALLEL),
  /** Failed items after which the rest are halted. */
  haltAfterFailures: z
    .number()
    .int()
    .min(1)
    .max(FLEET_MAX_COMPUTERS)
    .default(FLEET_DEFAULT_HALT_AFTER),
});

/** Per-status item counts, so a list row shows progress without the items. */
export const FleetOperationSchema = z.object({
  id: z.string(),
  kind: FleetOperationKindSchema,
  imageDigest: z.string().nullable(),
  status: FleetOperationStatusSchema,
  createdAt: z.string(),
  finishedAt: z.string().nullable(),
  maxParallel: z.number().int(),
  haltAfterFailures: z.number().int(),
  counts: z.record(FleetItemStatusSchema, z.number().int()),
});
export type FleetOperation = z.infer<typeof FleetOperationSchema>;

export const FleetItemSchema = z.object({
  computerId: z.string(),
  /** Names for the row; null once the computer is gone. */
  spaceName: z.string().nullable(),
  bots: z.array(z.string()),
  status: FleetItemStatusSchema,
  /** A short code such as `already_hibernated`; never provider text. */
  outcome: z.string().nullable(),
  /** Recreate only: the image and saved home revision before and after; null when not known. */
  imageDigestBefore: z.string().nullable(),
  imageDigestAfter: z.string().nullable(),
  homeRevisionBefore: z.string().nullable(),
  homeRevisionAfter: z.string().nullable(),
  finishedAt: z.string().nullable(),
});

export const FleetOperationDetailSchema = FleetOperationSchema.extend({
  items: z.array(FleetItemSchema),
});
export type FleetOperationDetail = z.infer<typeof FleetOperationDetailSchema>;

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
    /**
     * Offboards the account: ends its sessions, blocks sign-in, suspends its AI employees, stops
     * their runs and revokes grants and employee access. Keeps all data. Idempotent. Not
     * available on your own account.
     */
    deprovision: oc
      .input(z.object({ userId: Id, reason: z.string().trim().max(200).optional() }))
      .output(DeprovisionResultSchema),
    /** Allows sign-in again. AI employees stay suspended until an admin resumes them. */
    reactivate: oc.input(z.object({ userId: Id })).output(z.object({ ok: z.literal(true) })),
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
        /** Computers contained with them: only those no other bot uses. */
        computers: z.number().int(),
      }),
    ),
    lift: oc.input(z.object({ id: Id })).output(z.object({ ok: z.literal(true) })),
  },
  /** Every bot with its broker mode and grant count; per-bot grants, mode and the simulator are `capabilityGrants`. */
  capabilities: {
    list: oc.input(AdminPageInputSchema).output(AdminCapabilityPageSchema),
  },
  /** Every bot computer in the deployment. Read-only; metadata only, never content. */
  computers: {
    list: oc
      .input(
        AdminPageInputSchema.extend({
          /** Only computers whose last known image the policy does not approve; none without a policy list. */
          imageCompliance: z.literal("not_approved").optional(),
          /** Only computers an admin quarantined. */
          quarantined: z.literal(true).optional(),
        }),
      )
      .output(AdminComputerPageSchema),
    get: oc.input(z.object({ computerId: Id })).output(AdminComputerDetailSchema),
    /**
     * Contains computers: refuses start, wake, takeover and execution leases, cancels the runs of
     * the bots on them, cuts the network where the provider can really do it and stops idle
     * machines with their homes saved. A busy machine is never destroyed. Nothing is revoked.
     */
    quarantine: oc
      .input(
        z.object({
          computerIds: z.array(Id).min(1).max(FLEET_MAX_COMPUTERS),
          reason: z.string().trim().max(200).optional(),
        }),
      )
      .output(
        z.object({
          quarantined: z.number().int(),
          cancelledRuns: z.number().int(),
          /** Computers by what the network cut came to; `unsupported` is never counted as isolated. */
          networkIsolation: z.partialRecord(NetworkIsolationOutcomeSchema, z.number().int()),
          /** The terminate operation stopping the idle ones; null when none were running. */
          operationId: z.string().nullable(),
        }),
      ),
    /** Clears the flag and restores a still-running computer's network. Starts nothing. */
    release: oc
      .input(z.object({ computerIds: z.array(Id).min(1).max(FLEET_MAX_COMPUTERS) }))
      .output(z.object({ released: z.number().int() })),
    /** Hibernate, wake, recreate or terminate many computers at a bounded pace. Busy computers are skipped, never forced. */
    operations: {
      create: oc.input(FleetOperationInputSchema).output(z.object({ id: z.string() })),
      list: oc
        .input(z.object({ limit: pageLimit(50, 20) }))
        .output(z.object({ operations: z.array(FleetOperationSchema) })),
      get: oc.input(z.object({ operationId: Id })).output(FleetOperationDetailSchema),
    },
  },
  policy: oc.output(AdminPolicyViewSchema),
  audit: oc.input(AdminAuditInputSchema).output(AdminAuditPageSchema),
};
