import { ORPCError } from "@orpc/server";
import {
  assertAccountExportAllowed,
  assertBotCapabilityAllowed,
  assertComputerKindAllowed,
  assertHostComputerAllowed,
  assertMessagingSurfaceAllowed,
  PolicyDeniedError,
} from "@rakazo/adapters";
import type { Actor } from "@rakazo/contracts";
import type { BotCapability } from "@rakazo/core";

/** Policy refusals carry `{ reason: "policy", rule }` so clients show one short message. */
export function policyForbidden(error: PolicyDeniedError): ORPCError<"FORBIDDEN", unknown> {
  return new ORPCError("FORBIDDEN", {
    message: error.message,
    data: { reason: "policy", rule: error.rule },
  });
}

async function asForbidden(check: () => Promise<void>): Promise<void> {
  try {
    await check();
  } catch (error) {
    if (error instanceof PolicyDeniedError) throw policyForbidden(error);
    throw error;
  }
}

/** Choosing a computer provider in Settings. "default" is always allowed so an admin can go back. */
export function assertComputerProviderAllowedForRequest(
  actor: Actor,
  provider: string,
): Promise<void> {
  if (provider === "default") return Promise.resolve();
  return asForbidden(() => assertComputerKindAllowed(provider, { ...actor, surface: "settings" }));
}

export function assertHostComputerAllowedForRequest(actor: Actor): Promise<void> {
  return asForbidden(() => assertHostComputerAllowed({ ...actor, surface: "settings" }));
}

export function assertBotCapabilityAllowedForRequest(
  actor: Actor,
  capability: BotCapability,
): Promise<void> {
  return asForbidden(() =>
    assertBotCapabilityAllowed(capability, { ...actor, surface: "settings" }),
  );
}

export function assertMessagingSurfaceAllowedForRequest(
  actor: Actor,
  surface: string,
): Promise<void> {
  return asForbidden(() =>
    assertMessagingSurfaceAllowed(surface, { ...actor, surface: "settings" }),
  );
}

export function assertAccountExportAllowedForRequest(actor: Actor): Promise<void> {
  return asForbidden(() => assertAccountExportAllowed({ ...actor, surface: "settings" }));
}
