import type { BetterAuthPlugin } from "better-auth";
import { createAuthEndpoint, getSessionFromCtx, isAPIError } from "better-auth/api";
import { deleteSessionCookie, parseSetCookieHeader, setSessionCookie } from "better-auth/cookies";
import { handleOAuthUserInfo } from "better-auth/oauth2";
import { errors } from "jose";
import type { OidcConfig, OidcDirectoryClaims } from "./oidc.js";
import {
  isOidcAccessAllowed,
  isOidcEmailVerified,
  oidcAccountSubject,
  oidcDirectoryClaims,
} from "./oidc.js";
import type { OidcKeys } from "./oidc-keys.js";
import { openIdToken } from "./token-storage.js";

/**
 * Sign-in behind App Service / Container Apps built-in authentication ("Easy Auth"). The platform
 * authenticates the browser and forwards its token store. Rakazo never trusts a forwarded identity
 * header by itself: the ID token must verify against the issuer's keys, exactly like an OIDC
 * callback, and only then maps to the same `oidc` account the redirect flow uses.
 */
export const EASY_AUTH_ID_TOKEN_HEADER = "x-ms-token-aad-id-token";
export const EASY_AUTH_PRINCIPAL_HEADER = "x-ms-client-principal";
/** Server-only endpoint path. Hooks recognize an Easy Auth sign-in by it. */
export const EASY_AUTH_SESSION_PATH = "/easy-auth/session";

const MAX_TOKEN_LENGTH = 16_384;
const MAX_PRINCIPAL_LENGTH = 65_536;
/** Marks a session created from Easy Auth headers. Sliding sessions must never outlive it. */
const NEVER = new Date("9999-12-31T00:00:00Z");

export const easyAuthMarkerKey = (sessionId: string) => `easy-auth-session-${sessionId}`;

type Claims = Record<string, unknown>;
type Verified =
  | { status: "valid"; claims: Claims; sub: string; idToken: string }
  /** No usable identity: no token, or one that failed verification. */
  | { status: "absent"; reason: string }
  /** The issuer's keys could not be read, so nothing is known about this request. */
  | { status: "unavailable"; reason: string };

const SUBJECT_TYPES = new Set([
  "sub",
  "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/nameidentifier",
]);
const OBJECT_ID_TYPES = new Set([
  "oid",
  "http://schemas.microsoft.com/identity/claims/objectidentifier",
]);

/** The principal header is unsigned, so it may only agree with the verified token. */
function principalAgrees(header: string, claims: Claims): boolean {
  if (header.length > MAX_PRINCIPAL_LENGTH) return false;
  try {
    const principal = JSON.parse(Buffer.from(header, "base64").toString("utf8")) as {
      claims?: { typ?: unknown; val?: unknown }[];
    };
    if (!Array.isArray(principal.claims)) return false;
    let compared = 0;
    for (const claim of principal.claims) {
      if (typeof claim?.typ !== "string") continue;
      const expected = SUBJECT_TYPES.has(claim.typ)
        ? claims.sub
        : OBJECT_ID_TYPES.has(claim.typ)
          ? claims.oid
          : undefined;
      // An identifier the token does not carry cannot be compared and is ignored.
      if (typeof expected !== "string") continue;
      if (claim.val !== expected) return false;
      compared++;
    }
    return compared > 0;
  } catch {
    return false;
  }
}

/** A loggable code for a verification failure: never the token or a claim value. */
function errorReason(error: unknown): string {
  if (error instanceof errors.JOSEError) return error.code;
  return error instanceof Error ? error.name : "unknown";
}

function isUnavailable(error: unknown) {
  if (!(error instanceof errors.JOSEError)) return true;
  return error.code === "ERR_JWKS_TIMEOUT" || error.code === "ERR_JOSE_GENERIC";
}

export async function verifyEasyAuthHeaders(keys: OidcKeys, headers: Headers): Promise<Verified> {
  const idToken = headers.get(EASY_AUTH_ID_TOKEN_HEADER);
  if (!idToken) return { status: "absent", reason: "no-token" };
  if (idToken.length > MAX_TOKEN_LENGTH) return { status: "absent", reason: "token-too-long" };
  let claims: Claims;
  try {
    claims = await keys.verifyIdToken(idToken);
  } catch (error) {
    const reason = errorReason(error);
    return isUnavailable(error) ? { status: "unavailable", reason } : { status: "absent", reason };
  }
  if (typeof claims.sub !== "string" || !claims.sub.trim() || typeof claims.exp !== "number")
    return { status: "absent", reason: "missing-claims" };
  const principal = headers.get(EASY_AUTH_PRINCIPAL_HEADER);
  if (principal !== null && !principalAgrees(principal, claims))
    return { status: "absent", reason: "principal-mismatch" };
  return { status: "valid", claims, sub: claims.sub, idToken };
}

type EndpointContext = Parameters<typeof setSessionCookie>[0];
type CreatedSession = Awaited<ReturnType<typeof handleOAuthUserInfo>>["data"];

export interface EasyAuthDeps {
  config: OidcConfig;
  keys: OidcKeys;
  /** Called with the verified directory claim when a person's ID token is new or changed. */
  onClaims?: (userId: string, claims: OidcDirectoryClaims) => Promise<void>;
}

export interface EasyAuthResult {
  /** Cookies the rest of this request must not see, though the session row was left alone. */
  hide: string[];
  /** What this pass did, for diagnostics. Never contains tokens or claim values. */
  outcome: string;
}

/**
 * Brings the Rakazo session in line with the Easy Auth identity of one request. Returns whether the
 * request's session cookie must be hidden from the rest of the request.
 */
async function resolve(
  ctx: EndpointContext,
  deps: EasyAuthDeps,
  create: boolean,
  inflight: Map<string, Promise<NonNullable<CreatedSession>>>,
): Promise<EasyAuthResult> {
  const { config, keys } = deps;
  const none = (outcome: string): EasyAuthResult => ({ hide: [], outcome });
  const headers = ctx.headers;
  // Native clients authenticate with a bearer and never carry Easy Auth headers.
  if (!headers || /^bearer\s/i.test(headers.get("authorization") ?? "")) return none("bearer");
  const adapter = ctx.context.internalAdapter;
  const verified = await verifyEasyAuthHeaders(keys, headers);
  const current = await getSessionFromCtx(ctx, { disableCookieCache: true });
  const marker = current
    ? await adapter.findVerificationValue(easyAuthMarkerKey(current.session.id))
    : null;
  const end = async () => {
    if (!current) return;
    await adapter.deleteSession(current.session.token);
    deleteSessionCookie(ctx);
  };
  if (verified.status === "unavailable")
    return {
      hide: marker ? [ctx.context.authCookies.sessionToken.name] : [],
      outcome: `unavailable:${verified.reason}`,
    };
  if (verified.status === "absent") {
    if (marker) await end();
    return none(`${marker ? "ended" : "skipped"}:${verified.reason}`);
  }
  const accountId = oidcAccountSubject(config.issuer, verified.sub);
  const account = await adapter.findAccountByKey({ providerId: "oidc", accountId });
  const directory = () => oidcDirectoryClaims(config, verified.claims);
  if (!isOidcAccessAllowed(config, verified.claims)) {
    // A denied identity must not leave an older ID token granting administration.
    if (account) {
      await ctx.context.adapter.updateMany({
        model: "account",
        where: [{ field: "id", value: account.id }],
        update: { idToken: null },
      });
      // Only the first denial: later requests find no stored token and skip this.
      if (account.idToken) await deps.onClaims?.(account.userId, directory());
    }
    if (marker) await end();
    return none("denied");
  }
  const syncToken = async () => {
    if (!account) return;
    const stored = await openIdToken(ctx.context.secretConfig, account.idToken);
    if (stored !== verified.idToken) {
      await adapter.updateAccount(account.id, { idToken: verified.idToken });
      await deps.onClaims?.(account.userId, directory());
    }
  };
  if (current) {
    if (marker?.value === accountId) {
      await syncToken();
      return none("kept");
    }
    if (!marker && account?.userId === current.user.id) {
      // The same person already signed in another way. That session keeps its own rules.
      await syncToken();
      return none("kept-native");
    }
    await end();
  }
  if (!create) return none(current ? "ended:other-identity" : "skipped:no-create");
  const email = typeof verified.claims.email === "string" ? verified.claims.email.trim() : "";
  if (!email) return none("skipped:no-email");
  let pending = inflight.get(accountId);
  if (!pending) {
    pending = (async () => {
      const result = await handleOAuthUserInfo(ctx, {
        userInfo: {
          id: verified.sub,
          email,
          emailVerified: isOidcEmailVerified(config, verified.claims),
          name: typeof verified.claims.name === "string" ? verified.claims.name : email,
          image: typeof verified.claims.picture === "string" ? verified.claims.picture : undefined,
        },
        account: { providerId: "oidc", accountId, idToken: verified.idToken },
      });
      if (!result.data) throw new SignInRefused();
      await deps.onClaims?.(result.data.user.id, directory());
      try {
        await adapter.createVerificationValue({
          identifier: easyAuthMarkerKey(result.data.session.id),
          value: accountId,
          expiresAt: NEVER,
        });
      } catch (error) {
        // Without its marker the session would escape the Easy Auth binding.
        await adapter.deleteSession(result.data.session.token).catch(() => undefined);
        throw error;
      }
      return result.data;
    })();
    inflight.set(accountId, pending);
    void pending.then(
      () => inflight.delete(accountId),
      () => inflight.delete(accountId),
    );
  }
  try {
    // Concurrent first requests share one session, so one cookie is issued to all of them.
    await setSessionCookie(ctx, await pending);
  } catch (error) {
    if (error instanceof SignInRefused || isAPIError(error)) return none("refused");
    throw error;
  }
  return none(current ? "replaced" : "created");
}

class SignInRefused extends Error {}

export function easyAuthPlugin(deps: EasyAuthDeps): BetterAuthPlugin {
  const inflight = new Map<string, Promise<NonNullable<CreatedSession>>>();
  return {
    id: "easy-auth",
    endpoints: {
      easyAuthSession: createAuthEndpoint(
        EASY_AUTH_SESSION_PATH,
        // Reachable only through `auth.api`, never over HTTP.
        { method: "POST", metadata: { SERVER_ONLY: true } },
        async (ctx) => ctx.json(await resolve(ctx, deps, ctx.body?.create === true, inflight)),
      ),
    },
  };
}

/** Applies the cookies an Easy Auth pass set or removed to the request's own `Cookie` header. */
export function rewriteRequestCookie(
  requestCookie: string | null,
  setCookies: string[],
  hide: string[],
): string | undefined {
  const changes = new Map<string, string | null>();
  for (const name of hide) changes.set(name, null);
  for (const header of setCookies) {
    for (const [name, attributes] of parseSetCookieHeader(header)) {
      changes.set(name, attributes["max-age"] === 0 || !attributes.value ? null : attributes.value);
    }
  }
  if (changes.size === 0) return undefined;
  const kept = (requestCookie ?? "")
    .split(";")
    .map((pair) => pair.trim())
    .filter((pair) => pair && !changes.has(pair.split("=")[0] ?? ""));
  for (const [name, value] of changes) if (value !== null) kept.push(`${name}=${value}`);
  return kept.join("; ");
}
