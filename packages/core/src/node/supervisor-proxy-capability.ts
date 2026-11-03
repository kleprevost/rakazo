import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * A short-lived grant for one browser-facing stream through the computer supervisor's reverse
 * proxy. The supervisor bearer token is too broad to hand to anything near a browser, so the
 * adapter signs this instead: it names one computer, one container port and one purpose, and the
 * supervisor verifies it with a key derived from the same token. It is carried in a header the
 * web process seals server-side; it never appears in a URL.
 */
export type SupervisorProxyPurpose = "screen" | "terminal";

export interface SupervisorProxyClaims {
  computerId: string;
  /** The computer's container port, never a host port. */
  port: number;
  purpose: SupervisorProxyPurpose;
  /** Epoch milliseconds. */
  expiresAt: number;
}

const PREFIX = "rsc1";
const KEY_CONTEXT = "rakazo supervisor proxy capability v1";
/** Expiry is rounded to this bucket so a repeat mint in the same window is byte-identical. */
const EXPIRY_BUCKET_MS = 5 * 60_000;
/**
 * Outlives a sealed screen capability (`SCREEN_PROXY_TTL_MS`, 60 minutes) plus its reuse window,
 * so the grant inside a still-valid seal is never the first thing to run out.
 */
const MINIMUM_LIFETIME_MS = 65 * 60_000;
const COMPUTER_ID = /^[A-Za-z0-9_.-]{1,128}$/;

function derivedKey(supervisorToken: string) {
  return createHmac("sha256", supervisorToken).update(KEY_CONTEXT).digest();
}

function sign(supervisorToken: string, payload: string) {
  return createHmac("sha256", derivedKey(supervisorToken)).update(`${PREFIX}.${payload}`).digest();
}

export function isSupervisorProxyComputerId(value: string) {
  return COMPUTER_ID.test(value) && value !== "." && value !== "..";
}

/** Deterministic for a given computer, port and purpose within one expiry bucket. */
export function mintSupervisorProxyCapability(
  supervisorToken: string,
  grant: Omit<SupervisorProxyClaims, "expiresAt">,
  now = Date.now(),
) {
  if (!isSupervisorProxyComputerId(grant.computerId)) throw new Error("Invalid computer id");
  if (!Number.isInteger(grant.port) || grant.port < 1024 || grant.port > 65535)
    throw new Error("Invalid proxy port");
  const expiresAt =
    Math.floor((now + MINIMUM_LIFETIME_MS) / EXPIRY_BUCKET_MS) * EXPIRY_BUCKET_MS +
    EXPIRY_BUCKET_MS;
  const payload = Buffer.from(
    JSON.stringify([grant.computerId, grant.port, grant.purpose, expiresAt]),
  ).toString("base64url");
  return `${PREFIX}.${payload}.${sign(supervisorToken, payload).toString("base64url")}`;
}

/** The claims of a genuine, unexpired capability; null for anything else. */
export function verifySupervisorProxyCapability(
  supervisorToken: string,
  capability: string | undefined,
  now = Date.now(),
): SupervisorProxyClaims | null {
  const parts = capability?.split(".");
  if (parts?.length !== 3 || parts[0] !== PREFIX) return null;
  const [, payload, signature] = parts as [string, string, string];
  if (!/^[A-Za-z0-9_-]+$/.test(payload) || !/^[A-Za-z0-9_-]+$/.test(signature)) return null;
  const expected = sign(supervisorToken, payload);
  const supplied = Buffer.from(signature, "base64url");
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return null;
  try {
    const [computerId, port, purpose, expiresAt] = JSON.parse(
      Buffer.from(payload, "base64url").toString("utf8"),
    ) as unknown[];
    if (
      typeof computerId !== "string" ||
      !isSupervisorProxyComputerId(computerId) ||
      typeof port !== "number" ||
      !Number.isInteger(port) ||
      (purpose !== "screen" && purpose !== "terminal") ||
      typeof expiresAt !== "number" ||
      !Number.isSafeInteger(expiresAt) ||
      expiresAt <= now
    )
      return null;
    return { computerId, port, purpose, expiresAt };
  } catch {
    return null;
  }
}

/** The `authorization` header value that carries a capability. */
export function supervisorProxyAuthorization(capability: string) {
  return `Bearer ${capability}`;
}

export function supervisorProxyCapabilityFromAuthorization(authorization: string | undefined) {
  return authorization?.slice(0, 7).toLowerCase() === "bearer "
    ? authorization.slice(7)
    : undefined;
}
