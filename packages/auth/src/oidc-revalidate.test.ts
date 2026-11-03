import { symmetricDecrypt, symmetricEncrypt } from "better-auth/crypto";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OidcConfig } from "./oidc.js";
import { oidcAccountSubject } from "./oidc.js";
import { createOidcRevalidator } from "./oidc-revalidate.js";
import { openIdToken, sealIdToken } from "./token-storage.js";

const events = vi.hoisted(() => [] as { type: string; userId?: string; metadata?: unknown }[]);
vi.mock("@rakazo/db", () => ({
  recordSecurityEvent: vi.fn(async (event: (typeof events)[number]) => {
    events.push(event);
  }),
  runAsSystem: (_reason: string, fn: () => unknown) => fn(),
}));

const issuer = "https://idp.example.test";
const clientId = "test-client";
const key = "revalidate-test-secret-with-at-least-32-characters";
const minute = 60_000;
const start = new Date("2026-01-01T12:00:00Z");

const config: OidcConfig = {
  issuer,
  clientId,
  clientSecret: "test-client-secret",
  name: "SSO",
  scopes: [],
  allowSignupBypass: false,
  accessClaim: "roles",
  allowedValues: ["app.user", "app.admin"],
  adminValues: ["app.admin"],
  revalidateMinutes: 60,
};

type Row = {
  id: string;
  userId: string;
  accountId: string;
  providerId: string;
  refreshToken: string | null;
  accessToken: string | null;
  idToken: string | null;
  updatedAt: Date;
};

let clock: Date;
let rows: Row[];
let sessions: Map<string, number>;
let signingKey: Awaited<ReturnType<typeof generateKeyPair>>["privateKey"];
let tokenResponses: Map<string, () => Response>;
let tokenCalls: number;

const prisma = {
  account: {
    findMany: vi.fn(async ({ where, take }: { where: any; take: number }) =>
      rows
        .filter(
          (row) =>
            row.providerId === where.providerId &&
            row.idToken !== null &&
            row.updatedAt < where.updatedAt.lt &&
            (sessions.get(row.userId) ?? 0) > 0,
        )
        .slice(0, take)
        .map((row) => ({ ...row })),
    ),
    updateMany: vi.fn(async ({ where, data }: { where: any; data: Partial<Row> }) => {
      const match = rows.filter(
        (row) => row.id === where.id && row.updatedAt.getTime() === where.updatedAt.getTime(),
      );
      for (const row of match) Object.assign(row, { updatedAt: clock }, data);
      return { count: match.length };
    }),
  },
};

async function idToken(user: string, claims: Record<string, unknown> = { roles: ["app.user"] }) {
  return new SignJWT({ ...claims })
    .setProtectedHeader({ alg: "RS256", kid: "k1" })
    .setIssuer(issuer)
    .setAudience(clientId)
    .setSubject(user)
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(signingKey);
}

async function addUser(
  user: string,
  options: { refresh?: string | null; roles?: string[]; providerId?: string; age?: number } = {},
) {
  const refresh = options.refresh === undefined ? `refresh-${user}` : options.refresh;
  rows.push({
    id: `acct-${user}`,
    userId: user,
    accountId: oidcAccountSubject(issuer, user),
    providerId: options.providerId ?? "oidc",
    refreshToken: refresh ? await symmetricEncrypt({ key, data: refresh }) : null,
    accessToken: null,
    idToken:
      (await sealIdToken(key, await idToken(user, { roles: options.roles ?? ["app.admin"] }))) ??
      null,
    updatedAt: new Date(clock.getTime() - (options.age ?? 61 * minute)),
  });
  sessions.set(user, 2);
}

function grant(user: string, claims: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return async () =>
    Response.json({
      access_token: `access-${user}`,
      refresh_token: `rotated-${user}`,
      expires_in: 3600,
      id_token: await idToken(user, claims),
      ...extra,
    });
}

function respondWith(user: string, build: () => Promise<Response> | Response) {
  tokenResponses.set(`refresh-${user}`, build as () => Response);
}

const fakeFetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input);
  if (url.endsWith("/.well-known/openid-configuration"))
    return Response.json({
      issuer,
      token_endpoint: `${issuer}/token`,
      jwks_uri: `${issuer}/jwks`,
    });
  if (url === `${issuer}/jwks`) return Response.json({ keys: [jwk] });
  if (url === `${issuer}/token`) {
    tokenCalls++;
    const body = new URLSearchParams(String(init?.body));
    expect(body.get("grant_type")).toBe("refresh_token");
    expect(body.get("client_id")).toBe(clientId);
    const handler = tokenResponses.get(body.get("refresh_token") ?? "");
    if (!handler) return Response.json({ error: "invalid_grant" }, { status: 400 });
    return handler();
  }
  throw new Error(`unexpected request ${url}`);
});

let jwk: Record<string, unknown>;

function revalidator(extra: Partial<Parameters<typeof createOidcRevalidator>[0]> = {}) {
  return createOidcRevalidator({
    config,
    ...extra,
    key,
    prisma: prisma as never,
    fetch: fakeFetch as never,
    now: () => clock,
    revokeSessions: async (userId) => {
      const count = sessions.get(userId) ?? 0;
      sessions.set(userId, 0);
      return count;
    },
  });
}

const row = (user: string) => rows.find((item) => item.userId === user)!;

beforeEach(async () => {
  const pair = await generateKeyPair("RS256", { extractable: true });
  signingKey = pair.privateKey;
  jwk = { ...(await exportJWK(pair.publicKey)), kid: "k1", alg: "RS256", use: "sig" };
  clock = new Date(start);
  rows = [];
  sessions = new Map();
  tokenResponses = new Map();
  tokenCalls = 0;
  events.length = 0;
  fakeFetch.mockClear();
});

describe("SSO revalidation", () => {
  it("stores refreshed tokens when the user still has access", async () => {
    await addUser("alice");
    respondWith("alice", await grant("alice", { roles: ["app.user"] }));
    expect(await revalidator().run()).toEqual({ checked: 1, revoked: 0 });
    expect(sessions.get("alice")).toBe(2);
    expect(await symmetricDecrypt({ key, data: row("alice").refreshToken! })).toBe("rotated-alice");
    expect(await symmetricDecrypt({ key, data: row("alice").accessToken! })).toBe("access-alice");
    expect(row("alice").updatedAt).toEqual(clock);
    expect(events).toEqual([]);
    // Fresh now, so the next pass leaves it alone.
    expect(await revalidator().run()).toEqual({ checked: 0, revoked: 0 });
    expect(tokenCalls).toBe(1);
  });

  it("revokes every session and clears tokens when the provider rejects the refresh token", async () => {
    await addUser("bob", { refresh: "refresh-bob-disabled" });
    expect(await revalidator().run()).toEqual({ checked: 1, revoked: 1 });
    expect(sessions.get("bob")).toBe(0);
    expect(row("bob")).toMatchObject({ refreshToken: null, accessToken: null, idToken: null });
    expect(events).toEqual([
      {
        type: "auth.session.revoked",
        userId: "bob",
        metadata: { via: "sso_revalidation", reason: "refresh_rejected", sessions: 2 },
      },
    ]);
    expect(JSON.stringify(events)).not.toContain("refresh-bob");
  });

  it("reports the refreshed directory claim, also when access was just removed", async () => {
    await addUser("alice");
    await addUser("carol");
    respondWith("alice", await grant("alice", { roles: ["app.user", "role.eng"] }));
    respondWith("carol", await grant("carol", { roles: ["other"] }));
    const seen: Array<[string, unknown]> = [];
    await revalidator({
      onClaims: async (userId, claims) => {
        seen.push([userId, claims]);
      },
    }).run();
    expect(seen).toContainEqual(["alice", { values: ["app.user", "role.eng"], truncated: false }]);
    expect(seen).toContainEqual(["carol", { values: ["other"], truncated: false }]);
  });

  it("revokes when the new ID token no longer carries an allowed value", async () => {
    await addUser("carol");
    respondWith("carol", await grant("carol", { roles: ["other"] }));
    expect(await revalidator().run()).toEqual({ checked: 1, revoked: 1 });
    expect(sessions.get("carol")).toBe(0);
    expect(row("carol").idToken).toBeNull();
    expect(events[0]?.metadata).toMatchObject({ reason: "access_removed" });
  });

  it("keeps sessions but stores the new ID token when only the admin value is gone", async () => {
    await addUser("dave", { roles: ["app.admin"] });
    respondWith("dave", await grant("dave", { roles: ["app.user"] }));
    expect(await revalidator().run()).toEqual({ checked: 1, revoked: 0 });
    expect(sessions.get("dave")).toBe(2);
    const stored = JSON.parse(
      Buffer.from(
        (await openIdToken(key, row("dave").idToken))!.split(".")[1] ?? "",
        "base64url",
      ).toString(),
    );
    expect(stored.roles).toEqual(["app.user"]);
    expect(events).toEqual([]);
  });

  it.each([
    ["a server error", () => new Response("down", { status: 503 })],
    ["a throttle", () => Response.json({ error: "slow_down" }, { status: 429 })],
    [
      "a client configuration error",
      () => Response.json({ error: "invalid_client" }, { status: 401 }),
    ],
    [
      "a network failure",
      () => {
        throw new TypeError("fetch failed");
      },
    ],
  ])("changes nothing on %s and retries soon", async (_name, build) => {
    await addUser("erin");
    respondWith("erin", build);
    const before = { ...row("erin") };
    expect(await revalidator().run()).toEqual({ checked: 1, revoked: 0 });
    expect(sessions.get("erin")).toBe(2);
    expect({ ...row("erin"), updatedAt: before.updatedAt }).toEqual(before);
    expect(events).toEqual([]);
    // Claimed only briefly: due again within minutes, not a full interval later.
    clock = new Date(clock.getTime() + 6 * minute);
    respondWith("erin", await grant("erin", { roles: ["app.user"] }));
    expect(await revalidator().run()).toEqual({ checked: 1, revoked: 0 });
    expect(row("erin").updatedAt).toEqual(clock);
  });

  it("does not trust an ID token signed by another key", async () => {
    await addUser("frank");
    const other = await generateKeyPair("RS256");
    const forged = await new SignJWT({ roles: ["app.user"] })
      .setProtectedHeader({ alg: "RS256", kid: "k1" })
      .setIssuer(issuer)
      .setAudience(clientId)
      .setSubject("frank")
      .setExpirationTime("5m")
      .sign(other.privateKey);
    respondWith("frank", () =>
      Response.json({ access_token: "a", id_token: forged, refresh_token: "r" }),
    );
    expect(await revalidator().run()).toEqual({ checked: 1, revoked: 0 });
    expect(sessions.get("frank")).toBe(2);
    expect(row("frank").refreshToken).not.toBeNull();
  });

  it("signs out SSO users that have no refresh token", async () => {
    await addUser("gina", { refresh: null });
    expect(await revalidator().run()).toEqual({ checked: 1, revoked: 1 });
    expect(tokenCalls).toBe(0);
    expect(sessions.get("gina")).toBe(0);
    expect(events[0]?.metadata).toMatchObject({ reason: "no_refresh_token" });
  });

  it("gives a user who just signed in a full interval", async () => {
    await addUser("hana", { refresh: null, age: 10 * minute });
    expect(await revalidator().run()).toEqual({ checked: 0, revoked: 0 });
    expect(sessions.get("hana")).toBe(2);
  });

  it("leaves password and other non-SSO accounts untouched", async () => {
    await addUser("ivan", { providerId: "credential", refresh: null });
    row("ivan").idToken = null;
    await addUser("jules", { providerId: "github", refresh: null });
    expect(await revalidator().run()).toEqual({ checked: 0, revoked: 0 });
    expect(sessions.get("ivan")).toBe(2);
    expect(sessions.get("jules")).toBe(2);
    expect(events).toEqual([]);
  });

  it("skips an SSO identity from another issuer for a full interval", async () => {
    await addUser("kim", { refresh: null });
    row("kim").accountId = oidcAccountSubject("https://other.example.test", "kim");
    expect(await revalidator().run()).toEqual({ checked: 1, revoked: 0 });
    expect(sessions.get("kim")).toBe(2);
    expect(row("kim").updatedAt).toEqual(clock);
  });

  it("lets only one of two concurrent instances refresh an account", async () => {
    await addUser("lena");
    respondWith("lena", await grant("lena", { roles: ["app.user"] }));
    await Promise.all([revalidator().run(), revalidator().run()]);
    expect(tokenCalls).toBe(1);
  });

  it("checks every due user independently", async () => {
    await addUser("mona", { refresh: "refresh-mona-disabled" });
    await addUser("nate");
    respondWith("nate", await grant("nate", { roles: ["app.user"] }));
    expect(await revalidator().run()).toEqual({ checked: 2, revoked: 1 });
    expect(sessions.get("mona")).toBe(0);
    expect(sessions.get("nate")).toBe(2);
  });
});
