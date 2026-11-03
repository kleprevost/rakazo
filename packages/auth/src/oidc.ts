import { createHash } from "node:crypto";
import type { BetterAuthPlugin } from "better-auth";
import { APIError, getOAuthState } from "better-auth/api";
import { genericOAuth } from "better-auth/plugins";
import type { TokenKey } from "./token-storage.js";
import { openIdToken } from "./token-storage.js";

const OIDC_FRESH_AGE = 5 * 60;
const OIDC_CLOCK_SKEW = 60;

const deniedStates = new WeakSet<object>();

/** Whether this callback's ID token failed the access allow-list (request-local state). */
export async function isOidcAccessDenied() {
  const state = await getOAuthState();
  return Boolean(state && deniedStates.has(state));
}

export interface OidcConfig {
  issuer: string;
  clientId: string;
  clientSecret: string;
  name: string;
  scopes: string[];
  allowSignupBypass: boolean;
  /** Claim read from the ID token for access control. */
  accessClaim?: string;
  /** When non-empty, only tokens carrying one of these values in the claim may sign in or link. */
  allowedValues?: string[];
  /** Tokens carrying one of these values in the claim are deployment admins. */
  adminValues?: string[];
  /**
   * Re-checks signed-in SSO users against the provider this often, in minutes. Unset is off.
   * It needs a refresh token, so `offline_access` is requested at sign-in.
   */
  revalidateMinutes?: number;
  /** Count the email as verified when the token omits `email_verified` (e.g. Microsoft Entra ID). */
  trustEmail?: boolean;
}

/**
 * `email_verified: true` always counts. With `trustEmail`, a missing claim counts too, but an
 * explicit `email_verified: false` never does, and neither does Entra's `xms_edov` unless true.
 */
export function isOidcEmailVerified(config: OidcConfig, claims: Record<string, unknown>) {
  if (claims.email_verified === true) return true;
  if (!config.trustEmail || claims.email_verified !== undefined) return false;
  return claims.xms_edov === undefined || claims.xms_edov === true || claims.xms_edov === "true";
}

/** Values of an array claim. Missing, non-array or non-string entries yield nothing (fail closed). */
export function oidcClaimValues(config: OidcConfig, claims: Record<string, unknown>): string[] {
  const value = claims[config.accessClaim ?? "groups"];
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

/** What the directory said about a person, as stored in `user_directory_claims`. */
export interface OidcDirectoryClaims {
  values: string[];
  /** The directory returned a link or too many values: claim grants must not be trusted. */
  truncated: boolean;
}

const MAX_DIRECTORY_VALUES = 1_000;
const MAX_DIRECTORY_VALUE_LENGTH = 256;

/**
 * The configured claim for entitlements. Entra replaces an oversized `groups` list with
 * `_claim_names` (or `hasgroups`) and a link; that is recorded as truncated, never as empty.
 */
export function oidcDirectoryClaims(
  config: OidcConfig,
  claims: Record<string, unknown>,
): OidcDirectoryClaims {
  const name = config.accessClaim ?? "groups";
  const names = claims._claim_names;
  const overflow =
    (typeof names === "object" && names !== null && name in names) ||
    (name === "groups" && claims.hasgroups === true);
  const all = oidcClaimValues(config, claims);
  const values = all.filter((value) => value.length <= MAX_DIRECTORY_VALUE_LENGTH);
  return {
    values: values.slice(0, MAX_DIRECTORY_VALUES),
    truncated: overflow || values.length !== all.length || values.length > MAX_DIRECTORY_VALUES,
  };
}

const callbackClaims = new WeakMap<object, OidcDirectoryClaims>();

/** The verified directory claims of this callback's ID token (request-local state). */
export async function takeOidcDirectoryClaims() {
  const state = await getOAuthState();
  return state ? callbackClaims.get(state) : undefined;
}

export function isOidcAccessAllowed(config: OidcConfig, claims: Record<string, unknown>) {
  const allowed = config.allowedValues ?? [];
  if (allowed.length === 0) return true;
  return oidcClaimValues(config, claims).some((value) => allowed.includes(value));
}

export function hasOidcAdminClaim(config: OidcConfig, claims: Record<string, unknown>) {
  const admin = config.adminValues ?? [];
  return oidcClaimValues(config, claims).some((value) => admin.includes(value));
}

/** Discovery never gates API startup. Failed attempts share exponential backoff. */
export function oidcDiscovery(config: OidcConfig) {
  const generic = genericOAuth({
    config: [
      {
        providerId: "oidc",
        name: config.name,
        discoveryUrl: `${config.issuer.replace(/\/$/, "")}/.well-known/openid-configuration`,
        clientId: config.clientId,
        clientSecret: config.clientSecret,
        scopes: [
          ...new Set([
            "openid",
            "email",
            "profile",
            ...(config.revalidateMinutes ? ["offline_access"] : []),
            ...config.scopes,
          ]),
        ],
        pkce: true,
        accountSubject: ({ profile }) => {
          if (typeof profile.sub !== "string" || !profile.sub.trim()) return "";
          // Subjects are unique within an issuer, never across different IdPs.
          return oidcAccountSubject(config.issuer, profile.sub);
        },
        requireIdTokenVerification: true,
        mapProfileToUser: (profile) => ({ emailVerified: isOidcEmailVerified(config, profile) }),
      },
    ],
  });
  type Provider = Awaited<ReturnType<typeof generic.init>>["context"]["socialProviders"][number];
  let provider: Provider | undefined;
  let pending: Promise<Provider> | undefined;
  let nextAttempt = 0;
  let failures = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;
  let availability: "checking" | "available" | "unavailable" = "checking";
  let resolveProvider: (() => Promise<Provider>) | undefined;
  const unavailable = () =>
    new APIError("SERVICE_UNAVAILABLE", {
      code: "SSO_UNAVAILABLE",
      message: "SSO is temporarily unavailable. Try again.",
    });
  const plugin: BetterAuthPlugin = {
    id: "oidc-discovery",
    init(ctx) {
      const schedule = (delay: number) => {
        if (disposed) return;
        clearTimeout(timer);
        timer = setTimeout(() => {
          void discover().catch(() => undefined);
        }, delay);
        timer.unref?.();
      };
      const discover = (): Promise<Provider> => {
        if (pending) return pending;
        if (Date.now() < nextAttempt) return Promise.reject(unavailable());
        pending = (async () => {
          let timeout: ReturnType<typeof setTimeout> | undefined;
          try {
            const result = await Promise.race([
              // The library may log upstream error detail. Keep discovery errors generic.
              generic.init({
                ...ctx,
                socialProviders: ctx.socialProviders.filter((item) => item.id !== "oidc"),
                logger: { ...ctx.logger, error: () => undefined },
              }),
              new Promise<never>((_, reject) => {
                timeout = setTimeout(() => reject(unavailable()), 8_000);
              }),
            ]);
            const discovered = result.context.socialProviders[0];
            if (
              !discovered ||
              typeof discovered === "function" ||
              discovered.issuer !== config.issuer
            )
              throw unavailable();
            provider = discovered;
            availability = "available";
            failures = 0;
            nextAttempt = 0;
            schedule(5 * 60_000);
            return discovered;
          } catch {
            provider = undefined;
            availability = "unavailable";
            const delay = Math.min(60_000, 1_000 * 2 ** Math.min(failures++, 6));
            nextAttempt = Date.now() + delay;
            schedule(delay);
            throw unavailable();
          } finally {
            clearTimeout(timeout);
            pending = undefined;
          }
        })();
        return pending;
      };
      schedule(0);
      const getProvider = () => (provider ? Promise.resolve(provider) : discover());
      resolveProvider = getProvider;
      const lazy: Provider = {
        id: "oidc",
        name: config.name,
        issuer: config.issuer,
        requiresIdTokenNonce: true,
        createAuthorizationURL: async (data) => {
          const url = await (await getProvider()).createAuthorizationURL(data);
          // Only authenticated, server-bound reauthentication needs an interactive
          // provider login. Apply these last so client parameters cannot weaken it.
          const expectedUser = (await getOAuthState())?.serverContext?.reauthUserId;
          if (typeof expectedUser === "string") {
            url.searchParams.set("prompt", "login");
            url.searchParams.set("max_age", "0");
          }
          // Better Auth's state read/delete is not atomic. Consume a separate
          // server-side marker before code exchange, including concurrent callbacks.
          await ctx.internalAdapter.createVerificationValue({
            identifier: `oidc-callback-${data.state}`,
            value: data.idTokenNonce!,
            expiresAt: new Date(Date.now() + 10 * 60_000),
          });
          return url;
        },
        validateAuthorizationCode: async (data) => {
          const state = await getOAuthState();
          const marker = await ctx.internalAdapter.consumeVerificationValue(
            `oidc-callback-${state?.oauthState}`,
          );
          if (!marker || marker.value !== state?.idTokenNonce) return null;
          return (await getProvider()).validateAuthorizationCode(data);
        },
        getUserInfo: async (tokens) => {
          if (!tokens.idToken) return null;
          let claims: Record<string, unknown>;
          try {
            claims = JSON.parse(
              Buffer.from(tokens.idToken.split(".")[1] ?? "", "base64url").toString(),
            );
          } catch {
            return null;
          }
          // Reject malformed identity claims before the library can fall back to
          // userinfo. None of these claims are trusted until verification below.
          if (claims?.iss !== config.issuer || typeof claims.sub !== "string" || !claims.sub.trim())
            return null;
          // The provider verifies the signature, issuer, audience and nonce first.
          const info = await (await getProvider()).getUserInfo(tokens);
          if (!info?.data || !("sub" in info.data) || info.data.sub !== claims.sub) return null;
          const callbackState = await getOAuthState();
          if (callbackState) callbackClaims.set(callbackState, oidcDirectoryClaims(config, claims));
          if (!isOidcAccessAllowed(config, claims)) {
            // Better Auth turns a validateUserInfo error into a redirect with a code; this
            // callback has no other way to reach it. Without request state, fail closed.
            const state = await getOAuthState();
            if (!state) return null;
            deniedStates.add(state);
          }
          const context = (await getOAuthState())?.serverContext;
          if (typeof context?.reauthUserId === "string") {
            const startedAt = context.reauthStartedAt;
            const { auth_time: authTime } = claims;
            const now = Math.floor(Date.now() / 1_000);
            const accountId = oidcAccountSubject(config.issuer, claims.sub);
            const account = await ctx.internalAdapter.findAccountByKey({
              providerId: "oidc",
              accountId,
            });
            const session =
              typeof context.reauthSessionToken === "string"
                ? await ctx.internalAdapter.findSession(context.reauthSessionToken)
                : null;
            if (
              !Array.isArray(context.reauthAccountIds) ||
              !context.reauthAccountIds.includes(accountId) ||
              account?.userId !== context.reauthUserId ||
              session?.user.id !== context.reauthUserId ||
              session.session.expiresAt.getTime() <= Date.now() ||
              typeof startedAt !== "number" ||
              !Number.isSafeInteger(startedAt) ||
              typeof authTime !== "number" ||
              !Number.isFinite(authTime) ||
              authTime < startedAt - OIDC_CLOCK_SKEW ||
              authTime > now + OIDC_CLOCK_SKEW ||
              authTime <= now - OIDC_FRESH_AGE
            )
              return null;
            // Request-local parsed state: never persist callback-derived fields in
            // the reusable OAuth record. Skew must not extend the proof lifetime.
            context.reauthExpiresAt = (Math.min(authTime, now) + OIDC_FRESH_AGE) * 1_000;
          }
          return info;
        },
        accountSubject: async (data) => {
          const resolved = await getProvider();
          if (!resolved.accountSubject) throw unavailable();
          return resolved.accountSubject(data);
        },
        refreshAccessToken: async (token, context) => {
          const resolved = await getProvider();
          if (!resolved.refreshAccessToken) throw unavailable();
          return resolved.refreshAccessToken(token, context);
        },
      };
      return { context: { socialProviders: [lazy, ...ctx.socialProviders] } };
    },
  };
  return {
    plugin,
    availability: () => availability,
    /** The Expo proxy must only send a browser to the provider's real authorization endpoint. */
    isAuthorizationURL: async (value: string) => {
      if (!resolveProvider) return false;
      const endpoint = await (await resolveProvider()).createAuthorizationURL({
        state: "probe",
        codeVerifier: "probe",
        redirectURI: config.issuer,
      });
      const url = URL.parse(value);
      return url?.origin === endpoint.origin && url.pathname === endpoint.pathname;
    },
    dispose: () => {
      disposed = true;
      clearTimeout(timer);
    },
  };
}

export function oidcAccountSubject(issuer: string, subject: string) {
  return createHash("sha256")
    .update(JSON.stringify([issuer, subject]))
    .digest("hex");
}

/** Stored ID tokens were verified during linking; bind their subject to the stored account ID. */
export async function isCurrentOidcAccount(
  account: { providerId: string; accountId: string; idToken?: string | null },
  issuer: string | undefined,
  key: TokenKey,
) {
  if (!issuer || account.providerId !== "oidc") return false;
  const idToken = await openIdToken(key, account.idToken);
  if (!idToken) return false;
  try {
    const claims = JSON.parse(Buffer.from(idToken.split(".")[1] ?? "", "base64url").toString());
    return (
      claims.iss === issuer &&
      typeof claims.sub === "string" &&
      account.accountId === oidcAccountSubject(issuer, claims.sub)
    );
  } catch {
    return false;
  }
}

/** Whether a stored ID token, still bound to this issuer and account, carries an admin value. */
export async function isOidcAdminAccount(
  config: OidcConfig,
  account: { providerId: string; accountId: string; idToken?: string | null },
  key: TokenKey,
) {
  if (!config.adminValues?.length || !(await isCurrentOidcAccount(account, config.issuer, key)))
    return false;
  const idToken = await openIdToken(key, account.idToken);
  try {
    const claims = JSON.parse(Buffer.from(idToken?.split(".")[1] ?? "", "base64url").toString());
    return hasOidcAdminClaim(config, claims);
  } catch {
    return false;
  }
}
