import { oc } from "@orpc/contract";
import * as z from "zod";
import {
  CAPABILITY_EFFECTS,
  CapabilityGrantScopeSchema,
  CapabilityResourceSchema,
} from "./capabilities.js";
import { Id, IsoDate } from "./ids.js";

/** `shadow` records what the broker would decide and changes nothing. Off is `null`. */
export const CAPABILITY_MODES = ["shadow"] as const;
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
  list: oc
    .input(z.object(target).refine(oneTarget, ONE_TARGET))
    .output(
      z.object({
        mode: CapabilityModeSchema.nullable(),
        grants: z.array(CapabilityGrantViewSchema),
      }),
    ),
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
  /** Admins only: turn shadow recording on or off for one bot. */
  setMode: oc
    .input(z.object({ botId: Id, mode: CapabilityModeSchema.nullable() }))
    .output(z.object({ ok: z.literal(true) })),
};
