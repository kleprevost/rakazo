import { ORPCError } from "@orpc/server";
import {
  assertConnectorAllowed,
  assertStdioMcpAllowed,
  assertToolSourceHostAllowed,
  PolicyDeniedError,
} from "@rakazo/adapters";
import type { Actor } from "@rakazo/contracts";

/** A policy refusal as the `FORBIDDEN` error clients show as one short message. */
export function policyForbidden(error: unknown): ORPCError<"FORBIDDEN", unknown> | undefined {
  return error instanceof PolicyDeniedError
    ? new ORPCError("FORBIDDEN", {
        message: error.message,
        data: { reason: "policy", rule: error.rule },
      })
    : undefined;
}

async function asForbidden(check: () => Promise<void>): Promise<void> {
  try {
    await check();
  } catch (error) {
    throw policyForbidden(error) ?? error;
  }
}

export function assertConnectorAllowedForRequest(actor: Actor, slug: string): Promise<void> {
  return asForbidden(() => assertConnectorAllowed(slug, { ...actor, surface: "settings" }));
}

/** `actor` is absent on paths that only know the deployment (plugin previews). */
export function assertToolSourceAllowedForRequest(url: string, actor?: Actor): Promise<void> {
  return asForbidden(() => assertToolSourceHostAllowed(url, { ...actor, surface: "settings" }));
}

export function assertStdioMcpAllowedForRequest(actor: Actor): Promise<void> {
  return asForbidden(() => assertStdioMcpAllowed({ ...actor, surface: "settings" }));
}
