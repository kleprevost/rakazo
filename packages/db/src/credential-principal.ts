import type { RunPrincipal } from "@rakazo/contracts";
import { CAPABILITY_DENIED_MESSAGE } from "@rakazo/contracts";
import { availableInSpace, itemSecretIn } from "./availability.js";
import { recordSecurityEvent } from "./security-events.js";

/**
 * The one place a credential lookup learns whose credentials it may touch. Every function that
 * resolves a credential (an MCP server and its secret, a connected app, a vault entry, a model
 * connection, an OAuth session) takes the run's acting requester as a `RunPrincipal` and builds
 * its owner filter here, or checks a row it fetched by id with `ownedCredential`. A credential
 * belongs to one user; nothing is shared between users, and the shared-identity path is not
 * built, so a principal that names one is refused. A refusal is a `capability.denied` security
 * event (rule `principal_mismatch`) carrying ids only. `credential-principal.architecture.test.ts`
 * fails when a lookup does not route through this module.
 */
export type CredentialKind =
  | "connection"
  | "mcp_server"
  | "mcp_oauth_session"
  | "vault_credential"
  | "bot_secret"
  | "model_connection"
  | "voice_connection";

export class CredentialPrincipalError extends Error {
  constructor(
    readonly kind: CredentialKind | "principal",
    readonly credentialId: string | undefined,
  ) {
    super(CAPABILITY_DENIED_MESSAGE);
    this.name = "CredentialPrincipalError";
  }
}

/** The acting requester of a run or context. Today that is `run.userId`. */
export function principalOf(scope: { userId: string }): RunPrincipal {
  return { actingUserId: scope.userId };
}

/** The owner filter for a credential lookup. Refuses a shared identity: that path is not built. */
export function credentialOwner(principal: RunPrincipal): { userId: string } {
  if (principal.sharedIdentityId) throw new CredentialPrincipalError("principal", undefined);
  return { userId: principal.actingUserId };
}

/** `availableInSpace` for the principal's own servers, skills and installs. */
export function principalAvailable(principal: RunPrincipal, spaceId: string) {
  return availableInSpace({ spaceId, ...credentialOwner(principal) });
}

/** `itemSecretIn` for the principal's own secrets. */
export function principalItemSecret(principal: RunPrincipal, spaceId: string) {
  return itemSecretIn({ spaceId, ...credentialOwner(principal) });
}

type Owned = { id: string; userId: string };

/**
 * The row when the principal owns it; otherwise null after an audited refusal. For a lookup by
 * an id that may have come from a model or a client: fetch by id alone, then check here.
 */
export async function ownedCredential<T extends Owned>(
  principal: RunPrincipal,
  kind: CredentialKind,
  row: T | null | undefined,
  context: { spaceId?: string | null; botId?: string | null; surface?: string } = {},
): Promise<T | null> {
  if (!row) return null;
  if (!principal.sharedIdentityId && row.userId === principal.actingUserId) return row;
  await recordSecurityEvent({
    type: "capability.denied",
    userId: principal.actingUserId,
    ...(context.spaceId ? { spaceId: context.spaceId } : {}),
    metadata: {
      rule: "principal_mismatch",
      surface: context.surface ?? "credential",
      kind,
      resourceId: row.id,
      ...(context.botId ? { botId: context.botId } : {}),
    },
  });
  return null;
}

/** `ownedCredential` that throws instead of returning null. */
export async function assertCredentialPrincipal<T extends Owned>(
  principal: RunPrincipal,
  kind: CredentialKind,
  row: T,
  context?: Parameters<typeof ownedCredential>[3],
): Promise<T> {
  const owned = await ownedCredential(principal, kind, row, context);
  if (!owned) throw new CredentialPrincipalError(kind, row.id);
  return owned;
}
