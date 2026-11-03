import { createHmac } from "node:crypto";
import type * as Db from "@rakazo/db";
import { memoryAdapter } from "better-auth/adapters/memory";
import type { CryptoKey } from "jose";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Auth, AuthEnv } from "./index.js";
import { createAuth } from "./index.js";
import type { OidcConfig } from "./oidc.js";
import { oidcAccountSubject } from "./oidc.js";
import { openIdToken } from "./token-storage.js";

const state = vi.hoisted(() => ({ db: {} as Record<string, Record<string, unknown>[]> }));
vi.mock("better-auth/adapters/prisma", () => ({ prismaAdapter: () => memoryAdapter(state.db) }));
vi.mock("@rakazo/db", async (original) => ({
  ...(await original<typeof Db>()),
  bootstrapUserSpace: vi.fn(),
}));

const issuer = "https://identity.example.test/tenant/v2.0";
const origin = "https://rakazo.example.test";
const secret = "easy-auth-test-secret-with-at-least-32-characters";
const clientId = "test-client";

let signing: { privateKey: CryptoKey; publicKey: CryptoKey };
let otherKey: CryptoKey;
let publicJwk: Record<string, unknown>;
let auth: Auth;
let discoveryDown: boolean;
let jar: Map<string, string>;

const oidc: OidcConfig = {
  issuer,
  clientId,
  clientSecret: "test-client-secret",
  name: "SSO",
  scopes: ["openid", "email", "profile"],
  allowSignupBypass: false,
  accessClaim: "roles",
  allowedValues: ["app.user", "app.admin"],
  adminValues: ["app.admin"],
  trustEmail: true,
};

beforeAll(async () => {
  signing = await generateKeyPair("RS256");
  otherKey = (await generateKeyPair("RS256")).privateKey;
  publicJwk = { ...(await exportJWK(signing.publicKey)), kid: "k1", alg: "RS256", use: "sig" };
});

async function token(
  claims: Record<string, unknown> = {},
  options: { key?: CryptoKey; issuer?: string; audience?: string; expires?: number | string } = {},
) {
  return new SignJWT({
    email: "ada@example.test",
    name: "Ada",
    roles: ["app.user"],
    oid: "object-1",
    ...claims,
  })
    .setProtectedHeader({ alg: "RS256", kid: "k1" })
    .setIssuer(options.issuer ?? issuer)
    .setAudience(options.audience ?? clientId)
    .setSubject(String(claims.sub ?? "subject-1"))
    .setIssuedAt()
    .setExpirationTime(options.expires ?? "10m")
    .sign(options.key ?? signing.privateKey);
}

function principal(claims: { typ: string; val: string }[]) {
  return Buffer.from(JSON.stringify({ auth_typ: "aad", claims })).toString("base64");
}

function setup(options: Partial<AuthEnv> = {}, config: Partial<OidcConfig> = {}) {
  const prisma: Record<string, unknown> = {
    deploymentSettings: {
      findUnique: vi.fn(async () => null),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    spaceMember: { findFirst: vi.fn(async () => ({ id: "existing-space" })) },
    member: { findMany: vi.fn(async () => []) },
    messagingIdentity: { deleteMany: vi.fn(async () => ({})) },
    messagingLinkCode: { deleteMany: vi.fn(async () => ({})) },
    userDevice: { updateMany: vi.fn(async () => ({})) },
    passkey: { deleteMany: vi.fn(async () => ({})) },
    account: {
      findMany: vi.fn(async ({ where }: { where: { userId: string; providerId: string } }) =>
        rows("account").filter(
          (row) => row.userId === where.userId && row.providerId === where.providerId,
        ),
      ),
    },
    organization: { deleteMany: vi.fn(async () => ({})) },
  };
  prisma.$transaction = vi.fn(async (operations: (tx: unknown) => Promise<unknown>) =>
    operations(prisma),
  );
  auth = createAuth(prisma as never, {
    secret,
    baseURL: origin,
    webOrigin: origin,
    signupsEnabled: "true",
    signupAllowlist: undefined,
    oidc: { ...oidc, ...config },
    easyAuth: true,
    ...options,
  });
}

const rows = (model: string) => state.db[model] ?? [];

interface Pass {
  token?: string;
  principal?: string;
  extra?: Record<string, string>;
  create?: boolean;
  cookie?: boolean;
}

/** One request through the Easy Auth pass, keeping the browser's cookie jar like a browser does. */
async function pass(options: Pass = {}) {
  const headers = new Headers(options.extra);
  const cookie = [...jar].map(([name, value]) => `${name}=${value}`).join("; ");
  if (cookie && options.cookie !== false) headers.set("cookie", cookie);
  if (options.token) headers.set("x-ms-token-aad-id-token", options.token);
  if (options.principal) headers.set("x-ms-client-principal", options.principal);
  const result = await auth.easyAuth!(headers, { create: options.create ?? true });
  for (const header of result.setCookies) {
    const [name, ...rest] = header.split(";")[0]!.split("=");
    const attributes = header.toLowerCase();
    if (attributes.includes("max-age=0") || !rest.join("=")) jar.delete(name!);
    else jar.set(name!, rest.join("="));
  }
  // What the rest of the request sees.
  const seen = new Headers(headers);
  if (result.cookie !== undefined) {
    if (result.cookie) seen.set("cookie", result.cookie);
    else seen.delete("cookie");
  }
  return { ...result, session: await auth.api.getSession({ headers: seen }) };
}

const sessions = () => rows("session");
const markers = () =>
  rows("verification").filter((row) => String(row.identifier).startsWith("easy-auth-session-"));

async function nativeSessionCookie(userId: string) {
  const context = await auth.$context;
  const tokenValue = `native-${userId}`;
  sessions().push({
    id: `native-session-${userId}`,
    userId,
    token: tokenValue,
    expiresAt: new Date(Date.now() + 3_600_000),
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  const signature = createHmac("sha256", secret).update(tokenValue).digest("base64");
  return {
    name: context.authCookies.sessionToken.name,
    value: encodeURIComponent(`${tokenValue}.${signature}`),
    bearer: `${tokenValue}.${signature}`,
  };
}

function addUser(id: string, email: string, sub?: string) {
  state.db.user!.push({
    id,
    email,
    name: id,
    emailVerified: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  if (sub)
    state.db.account!.push({
      id: `account-${id}`,
      userId: id,
      providerId: "oidc",
      accountId: oidcAccountSubject(issuer, sub),
      createdAt: new Date(),
      updatedAt: new Date(),
    });
}

beforeEach(() => {
  state.db = {
    user: [],
    session: [],
    account: [],
    verification: [],
    organization: [],
    member: [],
    invitation: [],
  };
  discoveryDown = false;
  jar = new Map();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.origin !== new URL(issuer).origin) throw new Error("Unexpected offline request");
      if (discoveryDown) return Response.json({}, { status: 503 });
      if (url.pathname.endsWith("openid-configuration"))
        return Response.json({
          issuer,
          authorization_endpoint: `${issuer}/authorize`,
          token_endpoint: `${issuer}/token`,
          jwks_uri: `${new URL(issuer).origin}/keys`,
        });
      if (url.pathname === "/keys") return Response.json({ keys: [publicJwk] });
      throw new Error("Unexpected route");
    }),
  );
});
afterEach(() => {
  auth?.disposeOidcDiscovery();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("Easy Auth sign-in", () => {
  it("signs in a verified identity as the OIDC account and stores its sealed token", async () => {
    setup();
    const idToken = await token();
    const { session } = await pass({ token: idToken });
    expect(session?.user.email).toBe("ada@example.test");
    expect(rows("user")).toHaveLength(1);
    const account = rows("account")[0]!;
    expect(account.providerId).toBe("oidc");
    expect(account.accountId).toBe(oidcAccountSubject(issuer, "subject-1"));
    expect(await openIdToken(secret, account.idToken as string)).toBe(idToken);
    expect(account.idToken).not.toBe(idToken);
    expect(markers()).toHaveLength(1);
    expect((await pass({ token: idToken })).session?.user.id).toBe(session?.user.id);
    expect(sessions()).toHaveLength(1);
  });

  it("maps to the existing account of an OIDC sign-in and never links by email", async () => {
    setup();
    addUser("user-existing", "ada@example.test", "subject-1");
    const { session } = await pass({ token: await token() });
    expect(session?.user.id).toBe("user-existing");
    expect(rows("user")).toHaveLength(1);
    expect(rows("account")).toHaveLength(1);

    jar.clear();
    addUser("user-other", "grace@example.test");
    const refused = await pass({
      token: await token({ sub: "subject-2", email: "grace@example.test" }),
    });
    expect(refused.session).toBeNull();
    expect(rows("account")).toHaveLength(1);
  });

  it("ignores forged identity headers without a verified token", async () => {
    setup();
    const forged = principal([{ typ: "sub", val: "subject-1" }]);
    const result = await pass({
      principal: forged,
      extra: { "x-ms-client-principal-id": "subject-1", "x-ms-client-principal-name": "ada" },
    });
    expect(result.session).toBeNull();
    expect(rows("user")).toHaveLength(0);
  });

  it.each([
    ["signed by another key", { key: "other" }],
    ["issued by another issuer", { issuer: "https://identity.example.test/other/v2.0" }],
    ["for another audience", { audience: "someone-else" }],
    ["expired", { expires: Math.floor(Date.now() / 1000) - 600 }],
  ])("rejects a token %s", async (_name, change) => {
    setup();
    const { key, ...rest } = change as { key?: string; [name: string]: unknown };
    const idToken = await token({}, { ...rest, ...(key ? { key: otherKey } : {}) });
    const result = await pass({ token: idToken });
    expect(result.session).toBeNull();
    expect(rows("user")).toHaveLength(0);
    expect(sessions()).toHaveLength(0);
  });

  it("rejects a tampered payload and a token without a subject expiry", async () => {
    setup();
    const [header, , signature] = (await token()).split(".");
    const payload = Buffer.from(
      JSON.stringify({
        iss: issuer,
        aud: clientId,
        sub: "subject-9",
        exp: 9_999_999_999,
        email: "x@example.test",
      }),
    ).toString("base64url");
    expect((await pass({ token: `${header}.${payload}.${signature}` })).session).toBeNull();
    expect(rows("user")).toHaveLength(0);
  });

  it("requires the principal header to agree with the token subject", async () => {
    setup();
    const idToken = await token();
    const wrong = principal([
      {
        typ: "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/nameidentifier",
        val: "someone-else",
      },
    ]);
    expect((await pass({ token: idToken, principal: wrong })).session).toBeNull();
    expect((await pass({ token: idToken, principal: "not-base64-json" })).session).toBeNull();
    const empty = principal([{ typ: "name", val: "Ada" }]);
    expect((await pass({ token: idToken, principal: empty })).session).toBeNull();
    const oidMismatch = principal([
      { typ: "sub", val: "subject-1" },
      { typ: "oid", val: "object-2" },
    ]);
    expect((await pass({ token: idToken, principal: oidMismatch })).session).toBeNull();
    expect(rows("user")).toHaveLength(0);
    const agree = principal([
      { typ: "sub", val: "subject-1" },
      { typ: "oid", val: "object-1" },
    ]);
    expect((await pass({ token: idToken, principal: agree })).session?.user.email).toBe(
      "ada@example.test",
    );
  });

  it("ends the previous session when a different subject arrives", async () => {
    setup();
    const first = await pass({ token: await token() });
    const firstSession = first.session!.session.id;
    const second = await pass({
      token: await token({ sub: "subject-2", email: "grace@example.test", name: "Grace" }),
    });
    expect(second.session?.user.email).toBe("grace@example.test");
    expect(sessions().some((row) => row.id === firstSession)).toBe(false);
    expect(markers().map((row) => row.value)).toEqual([oidcAccountSubject(issuer, "subject-2")]);
  });

  it("ends an Easy Auth session once browser requests stop carrying an identity", async () => {
    setup();
    await pass({ token: await token() });
    expect(sessions()).toHaveLength(1);
    const later = await pass({});
    expect(later.session).toBeNull();
    expect(sessions()).toHaveLength(0);
    expect(markers()).toHaveLength(0);
    expect(jar.size).toBe(0);
  });

  it("ends an Easy Auth session when its forwarded token expires", async () => {
    setup();
    await pass({ token: await token() });
    const expired = await token({}, { expires: Math.floor(Date.now() / 1000) - 600 });
    expect((await pass({ token: expired })).session).toBeNull();
    expect(sessions()).toHaveLength(0);
  });

  it("leaves native sessions alone when no Easy Auth headers arrive", async () => {
    setup();
    addUser("user-native", "native@example.test", "native-subject");
    const native = await nativeSessionCookie("user-native");
    jar.set(native.name, native.value);
    const viaCookie = await pass({});
    expect(viaCookie.session?.user.id).toBe("user-native");
    jar.clear();
    const viaBearer = await pass({
      extra: { authorization: `Bearer ${native.bearer}` },
      cookie: false,
    });
    expect(sessions().filter((row) => row.id === "native-session-user-native")).toHaveLength(1);
    expect(viaBearer.setCookies).toEqual([]);
    // Even a stray Easy Auth identity cannot touch a bearer session.
    const stray = await pass({
      extra: { authorization: `Bearer ${native.bearer}` },
      token: await token({ sub: "other", email: "other@example.test" }),
      cookie: false,
    });
    expect(stray.setCookies).toEqual([]);
    expect(rows("user")).toHaveLength(1);
  });

  it("keeps a same-user native session without binding it", async () => {
    setup();
    addUser("user-native", "ada@example.test", "subject-1");
    const native = await nativeSessionCookie("user-native");
    jar.set(native.name, native.value);
    expect((await pass({ token: await token() })).session?.user.id).toBe("user-native");
    expect(markers()).toHaveLength(0);
    expect((await pass({})).session?.user.id).toBe("user-native");
  });

  it("replaces a different user's native session", async () => {
    setup();
    addUser("user-native", "native@example.test", "native-subject");
    const native = await nativeSessionCookie("user-native");
    jar.set(native.name, native.value);
    const result = await pass({ token: await token() });
    expect(result.session?.user.email).toBe("ada@example.test");
    expect(sessions().some((row) => row.id === "native-session-user-native")).toBe(false);
  });

  it("applies the claim allow-list and drops the stored admin token on denial", async () => {
    setup();
    await pass({ token: await token({ roles: ["app.admin"] }) });
    const userId = rows("user")[0]!.id as string;
    expect(await auth.isSsoAdmin(userId)).toBe(true);
    const denied = await pass({ token: await token({ roles: ["other"] }) });
    expect(denied.session).toBeNull();
    expect(sessions()).toHaveLength(0);
    expect(rows("account")[0]!.idToken).toBeNull();
    expect(await auth.isSsoAdmin(userId)).toBe(false);

    jar.clear();
    const fresh = await pass({
      token: await token({ sub: "subject-3", email: "c@example.test", roles: [] }),
    });
    expect(fresh.session).toBeNull();
    expect(rows("user")).toHaveLength(1);
  });

  it("maps the admin claim and refreshes the stored token when it changes", async () => {
    setup();
    await pass({ token: await token({ roles: ["app.admin"] }) });
    const userId = rows("user")[0]!.id as string;
    expect(await auth.isSsoAdmin(userId)).toBe(true);
    const demoted = await token({ roles: ["app.user"] });
    expect((await pass({ token: demoted })).session?.user.id).toBe(userId);
    expect(await auth.isSsoAdmin(userId)).toBe(false);
    expect(sessions()).toHaveLength(1);
  });

  it("reports the directory claim on first sign-in and when the token changes, not on repeats", async () => {
    const seen: Array<[string, string[], string]> = [];
    setup({
      onDirectoryClaims: async (userId, claims, via) => {
        seen.push([userId, claims.values, via]);
      },
    });
    const first = await token({ roles: ["app.user", "role.eng"] });
    await pass({ token: first });
    const userId = rows("user")[0]!.id as string;
    expect(seen).toEqual([[userId, ["app.user", "role.eng"], "easy_auth"]]);
    await pass({ token: first });
    expect(seen).toHaveLength(1);
    await pass({ token: await token({ roles: ["app.user"] }) });
    expect(seen).toHaveLength(2);
    expect(seen[1]![1]).toEqual(["app.user"]);
    // Denial reports once, with the values that no longer match, then stays quiet.
    await pass({ token: await token({ roles: ["other"] }) });
    await pass({ token: await token({ roles: ["other"] }) });
    expect(seen).toHaveLength(3);
    expect(seen[2]![1]).toEqual(["other"]);
  });

  it("follows the sign-up policy of OIDC sign-in", async () => {
    setup({ signupsEnabled: "false" });
    expect((await pass({ token: await token() })).session).toBeNull();
    expect(rows("user")).toHaveLength(0);
  });

  it("requires a verified email under an allow-list unless sign-up bypass is on", async () => {
    const unverified = await token({ email_verified: false, email: "ada@corp.example" });
    setup({ signupAllowlist: "corp.example" });
    expect((await pass({ token: unverified })).session).toBeNull();
    auth.disposeOidcDiscovery();
    state.db.user = [];
    setup({ signupAllowlist: "corp.example" }, { allowSignupBypass: true });
    expect((await pass({ token: unverified })).session?.user.email).toBe("ada@corp.example");
  });

  it("refuses an identity without an email address", async () => {
    setup();
    const result = await pass({ token: await token({ email: undefined }) });
    expect(result.session).toBeNull();
    expect(rows("user")).toHaveLength(0);
  });

  it("does not create a session when asked not to, such as for sign-out", async () => {
    setup();
    expect((await pass({ token: await token(), create: false })).session).toBeNull();
    expect(sessions()).toHaveLength(0);
  });

  it("shares one session between concurrent first requests", async () => {
    setup();
    const idToken = await token();
    const results = await Promise.all([pass({ token: idToken }), pass({ token: idToken })]);
    expect(results.every((result) => result.session?.user.email === "ada@example.test")).toBe(true);
    expect(sessions()).toHaveLength(1);
    expect(markers()).toHaveLength(1);
  });

  it("hides the session but keeps it when the issuer cannot be reached", async () => {
    setup();
    await pass({ token: await token() });
    const idToken = await token();
    // Discovery is cached for five minutes; let it lapse while the issuer is down.
    vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + 6 * 60_000 });
    discoveryDown = true;
    const result = await pass({ token: idToken });
    expect(result.session).toBeNull();
    expect(sessions()).toHaveLength(1);
    expect(markers()).toHaveLength(1);
    discoveryDown = false;
    expect((await pass({ token: idToken })).session?.user.email).toBe("ada@example.test");
  });

  it("does nothing when the mode is off, whatever headers arrive", async () => {
    setup({ easyAuth: false });
    expect(auth.easyAuth).toBeUndefined();
    const headers = new Headers({
      "x-ms-token-aad-id-token": await token(),
      "x-ms-client-principal": principal([{ typ: "sub", val: "subject-1" }]),
    });
    expect(await auth.api.getSession({ headers })).toBeNull();
    expect(rows("user")).toHaveLength(0);
  });

  it("refuses unsafe configuration", () => {
    expect(() =>
      createAuth({} as never, {
        secret,
        baseURL: origin,
        webOrigin: origin,
        signupsEnabled: "true",
        signupAllowlist: undefined,
        easyAuth: true,
      }),
    ).toThrow("requires OIDC");
    expect(() =>
      createAuth({} as never, {
        secret,
        baseURL: origin,
        webOrigin: origin,
        signupsEnabled: "true",
        signupAllowlist: undefined,
        easyAuth: true,
        oidc: { ...oidc, revalidateMinutes: 60 },
      }),
    ).toThrow("revalidation");
  });
});
