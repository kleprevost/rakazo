import type { JWTPayload } from "jose";
import { createRemoteJWKSet, customFetch, jwtVerify } from "jose";
import type { OidcConfig } from "./oidc.js";

const REQUEST_TIMEOUT_MS = 10_000;
const DISCOVERY_TTL_MS = 5 * 60_000;

export interface OidcEndpoints {
  tokenEndpoint: string;
  jwksUri: string;
  authMethods: string[];
}

export interface OidcKeysDeps {
  config: Pick<OidcConfig, "issuer" | "clientId">;
  fetch?: typeof fetch;
  now?: () => Date;
}

/**
 * Cached discovery document and key set of the configured issuer, shared by everything that
 * verifies ID tokens outside the sign-in callback. The issuer must match exactly.
 */
export function createOidcKeys(deps: OidcKeysDeps) {
  const { config } = deps;
  const request = deps.fetch ?? fetch;
  const now = deps.now ?? (() => new Date());
  let endpoints: { value: OidcEndpoints; at: number } | undefined;
  let jwks: ReturnType<typeof createRemoteJWKSet> | undefined;
  let jwksUri: string | undefined;

  const discover = async (): Promise<OidcEndpoints> => {
    if (endpoints && now().getTime() - endpoints.at < DISCOVERY_TTL_MS) return endpoints.value;
    const response = await request(
      `${config.issuer.replace(/\/$/, "")}/.well-known/openid-configuration`,
      { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) },
    );
    if (!response.ok) throw new Error("discovery failed");
    const doc = (await response.json()) as Record<string, unknown>;
    const tokenEndpoint = doc.token_endpoint;
    const jwksUriValue = doc.jwks_uri;
    if (
      doc.issuer !== config.issuer ||
      typeof tokenEndpoint !== "string" ||
      typeof jwksUriValue !== "string" ||
      !tokenEndpoint.startsWith("https://") ||
      !jwksUriValue.startsWith("https://")
    )
      throw new Error("discovery document is not usable");
    const methods = doc.token_endpoint_auth_methods_supported;
    const value = {
      tokenEndpoint,
      jwksUri: jwksUriValue,
      authMethods: Array.isArray(methods)
        ? methods.filter((item): item is string => typeof item === "string")
        : [],
    };
    endpoints = { value, at: now().getTime() };
    return value;
  };

  /** Verified like sign-in: signature from the discovered key set, exact issuer and audience. */
  const verifyIdToken = async (idToken: string): Promise<JWTPayload> => {
    const found = await discover();
    if (!jwks || jwksUri !== found.jwksUri) {
      jwks = createRemoteJWKSet(new URL(found.jwksUri), {
        timeoutDuration: REQUEST_TIMEOUT_MS,
        [customFetch]: request,
      });
      jwksUri = found.jwksUri;
    }
    const { payload } = await jwtVerify(idToken, jwks, {
      issuer: config.issuer,
      audience: config.clientId,
      clockTolerance: 60,
    });
    return payload;
  };

  return { discover, verifyIdToken };
}

export type OidcKeys = ReturnType<typeof createOidcKeys>;
