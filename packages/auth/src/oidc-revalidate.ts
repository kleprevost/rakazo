import type { PrismaClient } from "@rakazo/db";
import { recordSecurityEvent, runAsSystem } from "@rakazo/db";
import { symmetricDecrypt, symmetricEncrypt } from "better-auth/crypto";
import type { OidcConfig, OidcDirectoryClaims } from "./oidc.js";
import {
  isCurrentOidcAccount,
  isOidcAccessAllowed,
  oidcAccountSubject,
  oidcDirectoryClaims,
} from "./oidc.js";
import { createOidcKeys } from "./oidc-keys.js";
import type { TokenKey } from "./token-storage.js";
import { sealIdToken } from "./token-storage.js";

const REQUEST_TIMEOUT_MS = 10_000;
const RETRY_AFTER_MS = 5 * 60_000;
const BATCH_SIZE = 20;
const MAX_BATCHES_PER_RUN = 10;

type AccountDb = Pick<PrismaClient, "account">;

export interface OidcRevalidationDeps {
  config: OidcConfig;
  key: TokenKey;
  prisma: AccountDb;
  /** Ends every session of the user on every device. Returns how many existed. */
  revokeSessions: (userId: string) => Promise<number>;
  /** Receives the refreshed ID token's directory claim, before the access check. */
  onClaims?: (userId: string, claims: OidcDirectoryClaims) => Promise<void>;
  fetch?: typeof fetch;
  now?: () => Date;
  /** Called with the error name when one account could not be checked and will be retried. */
  onDeferred?: (errorName: string) => void;
}

type Outcome = "refreshed" | "skipped" | "revoked" | "transient";

/** The IdP answered, but refused the refresh token. Everything else is transient. */
class RefreshRejected extends Error {}

/**
 * Re-checks signed-in SSO users against the identity provider, so a user disabled or removed
 * from an allowed role loses their sessions without waiting for them to expire. Each account is
 * claimed by moving its `updatedAt` forward with a compare-and-set, so concurrent instances never
 * refresh the same token (refresh tokens may rotate) and a crashed run is retried shortly after.
 */
export function createOidcRevalidator(deps: OidcRevalidationDeps) {
  const { config, key, prisma, revokeSessions } = deps;
  const request = deps.fetch ?? fetch;
  const now = deps.now ?? (() => new Date());
  const keys = createOidcKeys({ config, fetch: request, now });
  const { discover } = keys;

  const refresh = async (refreshToken: string) => {
    const found = await discover();
    const body = new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken });
    const headers: Record<string, string> = { "content-type": "application/x-www-form-urlencoded" };
    const basic =
      found.authMethods.length > 0 &&
      !found.authMethods.includes("client_secret_post") &&
      found.authMethods.includes("client_secret_basic");
    if (basic) {
      const credentials = `${encodeURIComponent(config.clientId)}:${encodeURIComponent(config.clientSecret)}`;
      headers.authorization = `Basic ${Buffer.from(credentials).toString("base64")}`;
    } else {
      body.set("client_id", config.clientId);
      body.set("client_secret", config.clientSecret);
    }
    const response = await request(found.tokenEndpoint, {
      method: "POST",
      headers,
      body,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const data = (await response.json().catch(() => null)) as Record<string, unknown> | null;
    if (!response.ok) {
      // Only an explicit grant refusal proves the user or token is gone. An invalid client,
      // a throttle or a server error says nothing about the user.
      if (response.status === 400 && data?.error === "invalid_grant") throw new RefreshRejected();
      throw new Error(`refresh failed with status ${response.status}`);
    }
    if (!data || typeof data.access_token !== "string") throw new Error("refresh had no token");
    return {
      accessToken: data.access_token,
      refreshToken: typeof data.refresh_token === "string" ? data.refresh_token : undefined,
      idToken: typeof data.id_token === "string" ? data.id_token : undefined,
      expiresIn: typeof data.expires_in === "number" ? data.expires_in : undefined,
    };
  };

  const verify = async (idToken: string, accountId: string) => {
    const payload = await keys.verifyIdToken(idToken);
    if (
      typeof payload.sub !== "string" ||
      oidcAccountSubject(config.issuer, payload.sub) !== accountId
    )
      throw new Error("ID token belongs to another subject");
    return payload as Record<string, unknown>;
  };

  const revoke = async (userId: string, reason: string): Promise<"revoked"> => {
    const ended = await revokeSessions(userId);
    // Nothing to end means an earlier run already revoked this user.
    if (ended > 0)
      await recordSecurityEvent({
        type: "auth.session.revoked",
        userId,
        metadata: { via: "sso_revalidation", reason, sessions: ended },
      });
    return "revoked";
  };

  const process = async (
    row: {
      id: string;
      userId: string;
      accountId: string;
      providerId: string;
      refreshToken: string | null;
      idToken: string | null;
      updatedAt: Date;
    },
    intervalMs: number,
  ): Promise<Outcome> => {
    const at = now();
    // Claimed until retryAt: a transient failure or a crash is retried then, not a full interval later.
    const retryAt = new Date(at.getTime() - intervalMs + Math.min(RETRY_AFTER_MS, intervalMs / 2));
    const claim = await prisma.account.updateMany({
      where: { id: row.id, updatedAt: row.updatedAt },
      data: { updatedAt: retryAt },
    });
    if (claim.count === 0) return "skipped";
    const guard = { id: row.id, updatedAt: retryAt };
    if (!(await isCurrentOidcAccount(row, config.issuer, key))) {
      // Not an identity from the current issuer: leave it alone for a full interval.
      await prisma.account.updateMany({ where: guard, data: { updatedAt: at } });
      return "skipped";
    }
    const endSso = async (reason: string): Promise<Outcome> => {
      await revoke(row.userId, reason);
      await prisma.account.updateMany({
        where: guard,
        data: {
          accessToken: null,
          refreshToken: null,
          idToken: null,
          accessTokenExpiresAt: null,
          refreshTokenExpiresAt: null,
        },
      });
      return "revoked";
    };
    if (!row.refreshToken) return endSso("no_refresh_token");
    let refreshToken: string;
    try {
      refreshToken = await symmetricDecrypt({ key, data: row.refreshToken });
    } catch {
      return endSso("unreadable_refresh_token");
    }
    try {
      const tokens = await refresh(refreshToken);
      let idToken = row.idToken;
      if (tokens.idToken) {
        const claims = await verify(tokens.idToken, row.accountId);
        // Recorded even when access is now denied, so entitlements follow the directory.
        await deps.onClaims?.(row.userId, oidcDirectoryClaims(config, claims));
        if (!isOidcAccessAllowed(config, claims)) return endSso("access_removed");
        idToken = (await sealIdToken(key, tokens.idToken)) ?? null;
      } else if (config.allowedValues?.length) {
        // The claim cannot be re-checked, so the user cannot be shown to still have access.
        return endSso("no_id_token");
      }
      const saved = await prisma.account.updateMany({
        where: guard,
        data: {
          accessToken: await symmetricEncrypt({ key, data: tokens.accessToken }),
          ...(tokens.refreshToken
            ? { refreshToken: await symmetricEncrypt({ key, data: tokens.refreshToken }) }
            : {}),
          idToken,
          accessTokenExpiresAt: tokens.expiresIn
            ? new Date(at.getTime() + tokens.expiresIn * 1000)
            : null,
          updatedAt: at,
        },
      });
      return saved.count > 0 ? "refreshed" : "skipped";
    } catch (error) {
      if (error instanceof RefreshRejected) return endSso("refresh_rejected");
      throw error;
    }
  };

  /** One pass over the accounts that are due. Returns how many accounts were checked and how many lost their sessions. */
  const run = async (): Promise<{ checked: number; revoked: number }> =>
    runAsSystem("sso revalidation", async () => {
      const intervalMs = (config.revalidateMinutes ?? 0) * 60_000;
      if (intervalMs <= 0) return { checked: 0, revoked: 0 };
      let checked = 0;
      let revoked = 0;
      for (let batch = 0; batch < MAX_BATCHES_PER_RUN; batch++) {
        const at = now();
        const due = await prisma.account.findMany({
          where: {
            providerId: "oidc",
            idToken: { not: null },
            updatedAt: { lt: new Date(at.getTime() - intervalMs) },
            user: { sessions: { some: { expiresAt: { gt: at } } } },
          },
          select: {
            id: true,
            userId: true,
            accountId: true,
            providerId: true,
            refreshToken: true,
            idToken: true,
            updatedAt: true,
          },
          orderBy: { updatedAt: "asc" },
          take: BATCH_SIZE,
        });
        if (due.length === 0) break;
        const results = await Promise.allSettled(due.map((row) => process(row, intervalMs)));
        for (const result of results) {
          checked++;
          if (result.status === "fulfilled" && result.value === "revoked") revoked++;
          if (result.status === "rejected") deps.onDeferred?.(errorName(result.reason));
        }
        if (due.length < BATCH_SIZE) break;
      }
      return { checked, revoked };
    });

  return { run };
}

function errorName(error: unknown) {
  return error instanceof Error ? error.name : "unknown";
}
