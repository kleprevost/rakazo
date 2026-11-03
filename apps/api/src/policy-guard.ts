import { ORPCError } from "@orpc/server";
import {
  assertApprovalModeAllowed,
  assertModelAllowed,
  assertUserConnectionAllowed,
  PolicyDeniedError,
} from "@rakazo/adapters";
import type { Actor } from "@rakazo/contracts";
import type { ApprovalMode } from "@rakazo/core";

/** Settings-time refusals carry `{ reason: "policy", rule }` so clients show one short message. */
async function asForbidden(check: () => Promise<void>): Promise<void> {
  try {
    await check();
  } catch (error) {
    if (error instanceof PolicyDeniedError)
      throw new ORPCError("FORBIDDEN", {
        message: error.message,
        data: { reason: "policy", rule: error.rule },
      });
    throw error;
  }
}

export function assertModelAllowedForRequest(
  actor: Actor,
  choice: { provider: string; modelId: string; ownConnection: boolean },
): Promise<void> {
  return asForbidden(() => assertModelAllowed(choice, { ...actor, surface: "settings" }));
}

export function assertConnectionAllowedForRequest(actor: Actor, provider: string): Promise<void> {
  return asForbidden(() =>
    assertUserConnectionAllowed(provider, { ...actor, surface: "settings" }),
  );
}

/** Refuse an approval mode looser than the policy minimum. */
export function assertApprovalModeForRequest(actor: Actor, mode: ApprovalMode): Promise<void> {
  return asForbidden(() => assertApprovalModeAllowed(mode, { ...actor, surface: "settings" }));
}
