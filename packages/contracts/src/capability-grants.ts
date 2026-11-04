import { oc } from "@orpc/contract";
import * as z from "zod";
import {
  CAPABILITY_EFFECTS,
  CAPABILITY_GRANTED_VIA,
  CapabilityGrantScopeSchema,
  CapabilityResourceSchema,
} from "./capabilities.js";
import { Id, IsoDate } from "./ids.js";

/**
 * `shadow` records what the broker would decide and changes nothing; `enforce` refuses what it
 * would deny. Off is `null`.
 */
export const CAPABILITY_MODES = ["shadow", "enforce"] as const;
export const CapabilityModeSchema = z.enum(CAPABILITY_MODES);
export type CapabilityMode = z.infer<typeof CapabilityModeSchema>;

/** A grant belongs to one bot, or to an employee where every instance inherits it. */
const target = {
  botId: Id.optional(),
  employeeId: Id.optional(),
};
const oneTarget = (input: { botId?: string | undefined; employeeId?: string | undefined }) =>
  (input.botId === undefined) !== (input.employeeId === undefined);
const ONE_TARGET = { message: "Name a bot or an employee, not both" };

export const CapabilityGrantViewSchema = z.object({
  id: Id,
  kind: z.enum(["bot", "delegation"]),
  scope: z.string(),
  resource: CapabilityResourceSchema.nullable(),
  effect: z.enum(CAPABILITY_EFFECTS),
  /** Delegation: whose credentials or data the bot may use. */
  principalUserId: z.string().nullable(),
  createdVia: z.enum(["owner", "admin", "policy"]),
  createdByUserId: z.string(),
  expiresAt: IsoDate.nullable(),
  createdAt: IsoDate,
  /** Set on a bot's view when the row belongs to its employee. */
  inherited: z.boolean(),
});
export type CapabilityGrantView = z.infer<typeof CapabilityGrantViewSchema>;

/** One step of a decision: scope names, ids and rule names only, never arguments or content. */
export const CapabilityTraceEntrySchema = z.object({
  layer: z.enum(["quarantine", "ceiling", "principal", "grant", "delegation", "approval"]),
  rule: z.string(),
  scope: z.string().optional(),
  effect: z.enum([...CAPABILITY_EFFECTS, "none"]),
  source: z.enum(CAPABILITY_GRANTED_VIA).optional(),
  detail: z.string().optional(),
  expiresAt: z.string().optional(),
});

/** Name a tool (with its server, for one that is not built in) or a scope, not both. */
export const CapabilitySimulateInputSchema = z
  .object({
    botId: Id,
    tool: z.string().trim().min(1).max(100).optional(),
    server: z.string().trim().min(1).max(100).optional(),
    scope: CapabilityGrantScopeSchema.optional(),
    args: z
      .record(z.string().max(100), z.union([z.string().max(2000), z.number(), z.boolean()]))
      .refine((args) => Object.keys(args).length <= 20)
      .optional(),
  })
  .refine((input) => (input.tool === undefined) !== (input.scope === undefined), {
    message: "Name a tool or a scope, not both",
  });

export const CapabilitySimulationSchema = z.object({
  outcome: z.enum(CAPABILITY_EFFECTS),
  rule: z.string().optional(),
  scopes: z.array(z.string()),
  /** How the call was classified; absent when a scope was named. */
  basis: z.string().optional(),
  unmapped: z.boolean(),
  mode: CapabilityModeSchema.nullable(),
  /** Whether the bot is refused what this denies; otherwise the outcome is only recorded. */
  enforced: z.boolean(),
  trace: z.array(CapabilityTraceEntrySchema),
});
export type CapabilitySimulation = z.infer<typeof CapabilitySimulationSchema>;

/** What `shadow` recorded in the last seven days, so enforcing is a known step. */
export const CapabilityShadowSummarySchema = z.object({
  since: IsoDate,
  allowed: z.number().int(),
  asked: z.number().int(),
  denied: z.number().int(),
  /** The scopes behind the denials and asks, most frequent first. */
  scopes: z.array(z.object({ scope: z.string(), count: z.number().int() })),
});
export type CapabilityShadowSummary = z.infer<typeof CapabilityShadowSummarySchema>;

export const CapabilityGrantSetInputSchema = z
  .object({
    ...target,
    scope: CapabilityGrantScopeSchema,
    resource: CapabilityResourceSchema.optional(),
    effect: z.enum(CAPABILITY_EFFECTS).default("allow"),
    /**
     * `delegation` lets the bot use the caller's own credentials and data; it is the default for a
     * bot's owner. `bot` is what an admin grants a bot on its own. An employee takes `bot` only.
     */
    kind: z.enum(["bot", "delegation"]).optional(),
    expiresAt: IsoDate.optional(),
  })
  .refine(oneTarget, ONE_TARGET);

export const capabilityGrantsContract = {
  /** The grants in force for a bot (its own and inherited) or for an employee. */
  list: oc.input(z.object(target).refine(oneTarget, ONE_TARGET)).output(
    z.object({
      mode: CapabilityModeSchema.nullable(),
      /** Whether the broker applies to this bot: its mode is set or central policy requires grants. */
      active: z.boolean(),
      grants: z.array(CapabilityGrantViewSchema),
      /** Scopes the caller may grant now, inside the organization's limits. */
      grantable: z.array(z.string()),
    }),
  ),
  /** Decides a hypothetical call from the bot's live grants. Runs nothing and changes nothing. */
  simulate: oc.input(CapabilitySimulateInputSchema).output(CapabilitySimulationSchema),
  shadowSummary: oc.input(z.object({ botId: Id })).output(CapabilityShadowSummarySchema),
  /**
   * A bot's owner may grant read scopes, restrict further, and delegate their own credentials. A
   * write, send, spend or other non-read scope needs an admin unless central policy lists it as
   * owner-grantable. An employee's grants are an admin's.
   */
  set: oc.input(CapabilityGrantSetInputSchema).output(CapabilityGrantViewSchema),
  /** Idempotent. An owner cannot lift a restriction an admin set. */
  revoke: oc
    .input(z.object({ id: Id, reason: z.string().trim().max(200).optional() }))
    .output(z.object({ ok: z.literal(true) })),
  /** Admins only: set the broker mode (off, shadow or enforce) for one bot. */
  setMode: oc
    .input(z.object({ botId: Id, mode: CapabilityModeSchema.nullable() }))
    .output(z.object({ ok: z.literal(true) })),
};
