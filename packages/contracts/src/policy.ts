import * as z from "zod";
import { CapabilityPolicySchema } from "./capabilities.js";

const globs = z.array(z.string().min(1).max(256)).max(500);
const hosts = z.array(z.string().min(1).max(253)).max(500);
const ids = z.array(z.string().min(1).max(128)).max(500);
/** An image content digest, the only form an approved image is named by. */
export const IMAGE_DIGEST = /^sha256:[0-9a-f]{64}$/;

/**
 * Central policy v1: org-wide rules an administrator sets once and no user, bot or space
 * setting can loosen. Every section is optional and an absent rule means "no restriction".
 * Strict at every level so a misspelled rule fails startup instead of silently allowing.
 * See docs/enterprise/central-policy.md.
 */
export const PolicySchema = z.strictObject({
  version: z.literal(1),
  models: z
    .strictObject({
      allowProviders: ids.optional(),
      /** Globs on `provider/model`. */
      allowModels: globs.optional(),
      allowUserConnections: z.boolean().optional(),
    })
    .optional(),
  approvals: z
    .strictObject({
      minimumMode: z.enum(["ask", "auto"]).optional(),
      alwaysAsk: globs.optional(),
    })
    .optional(),
  tools: z.strictObject({ deny: globs.optional() }).optional(),
  integrations: z
    .strictObject({
      allowConnectors: ids.optional(),
      mcp: z.strictObject({ allowHosts: hosts.optional() }).optional(),
    })
    .optional(),
  computers: z
    .strictObject({
      allowProviders: ids.optional(),
      allowHostComputer: z.boolean().optional(),
      /**
       * Approved computer images, by content digest. A computer running any other image is
       * flagged in the Admin inventory, and a request that names an image is accepted only when
       * its digest is listed. The supervisor reads the same file and checks again.
       */
      images: z
        .strictObject({
          allow: z
            .array(
              z.strictObject({
                digest: z.string().regex(IMAGE_DIGEST, "must be sha256:<64 hex characters>"),
                /** Shown next to the digest; never matched. */
                tag: z.string().min(1).max(128).optional(),
              }),
            )
            .max(500),
        })
        .optional(),
      egress: z
        .strictObject({ allowDomains: hosts.optional(), denyDomains: hosts.optional() })
        .optional(),
    })
    .optional(),
  bots: z
    .strictObject({
      allowFleetManagement: z.boolean().optional(),
      allowSubagents: z.boolean().optional(),
      allowWebhooks: z.boolean().optional(),
      allowRoutines: z.boolean().optional(),
    })
    .optional(),
  messaging: z.strictObject({ allowSurfaces: ids.optional() }).optional(),
  data: z.strictObject({ allowAccountExport: z.boolean().optional() }).optional(),
  /** Scope ceiling, mappings and grant rules for the capability broker. */
  capabilities: CapabilityPolicySchema.optional(),
  /** Spend limits in USD for the current calendar month (UTC). Absent = no limit. */
  budgets: z
    .strictObject({
      period: z.literal("month").optional(),
      organizationUsd: z.number().positive().finite().optional(),
      perUserUsd: z.number().positive().finite().optional(),
      perBotUsd: z.number().positive().finite().optional(),
      warnAtPercent: z.number().gt(0).lt(100).optional(),
    })
    .optional(),
});
export type Policy = z.infer<typeof PolicySchema>;

/** The one short message shown wherever a policy rule refuses an action. */
export const POLICY_DENIED_MESSAGE = "Blocked by your organization";

/** The one short message a run shows when a spend budget stops it. */
export const BUDGET_REACHED_MESSAGE = "Monthly budget reached";
