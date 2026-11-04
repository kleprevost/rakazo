import { ORPCError } from "@orpc/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const lifecycle = vi.hoisted(() => ({
  deprovisionUser: vi.fn(),
  reactivateUser: vi.fn(),
}));
vi.mock("./identity-lifecycle.js", () => lifecycle);
vi.mock("@rakazo/db", () => ({ runAsSystem: (_why: string, fn: () => unknown) => fn() }));

const { provisioningRoutes, requestedActive } = await import("./provisioning.js");

const TOKEN = "t".repeat(40);
const BASE = "/api/v1/scim/v2";
const alice = {
  id: "user-1",
  name: "Alice",
  email: "Alice@Example.test",
  createdAt: new Date("2026-01-01T00:00:00Z"),
  deprovisionedAt: null as Date | null,
};

const prisma = {
  user: {
    count: vi.fn(),
    findMany: vi.fn(),
    findUnique: vi.fn(),
  },
};

function routes(now = () => 0) {
  return provisioningRoutes({
    prisma,
    token: TOKEN,
    clientIp: () => "203.0.113.5",
    now,
  } as unknown as Parameters<typeof provisioningRoutes>[0]);
}

const request = (
  app: ReturnType<typeof routes>,
  path: string,
  init: RequestInit = {},
  token: string | null = TOKEN,
) =>
  app.request(`${BASE}${path}`, {
    ...init,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      "content-type": "application/scim+json",
      ...(init.headers as Record<string, string> | undefined),
    },
  });

const patch = (active: unknown, shape: "path" | "bare" = "path") => ({
  method: "PATCH",
  body: JSON.stringify({
    schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"],
    Operations: [
      shape === "path"
        ? { op: "Replace", path: "active", value: active }
        : { op: "replace", value: { active } },
    ],
  }),
});

beforeEach(() => {
  vi.clearAllMocks();
  alice.deprovisionedAt = null;
  prisma.user.findUnique.mockImplementation(async ({ where }: { where: { id: string } }) =>
    where.id === alice.id ? { ...alice } : null,
  );
  lifecycle.deprovisionUser.mockImplementation(async () => {
    alice.deprovisionedAt = new Date();
  });
  lifecycle.reactivateUser.mockResolvedValue(true);
});

describe("provisioning endpoint authentication", () => {
  it.each([
    ["no credentials", null],
    ["a wrong token", "x".repeat(40)],
    ["a token with the right prefix", TOKEN.slice(0, -1)],
    ["an empty token", ""],
  ])("refuses %s on every route", async (_name, token) => {
    const app = routes();
    for (const [method, path] of [
      ["GET", '/Users?filter=userName eq "a"'],
      ["GET", "/Users/user-1"],
      ["GET", "/ServiceProviderConfig"],
      ["POST", "/Users"],
      ["PATCH", "/Users/user-1"],
      ["DELETE", "/Users/user-1"],
    ] as const) {
      const response = await request(app, path, { method }, token);
      expect(response.status, `${method} ${path}`).toBe(401);
      expect(response.headers.get("www-authenticate")).toMatch(/^Bearer/);
    }
    expect(lifecycle.deprovisionUser).not.toHaveBeenCalled();
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
  });

  it("refuses a session cookie and the basic scheme", async () => {
    const app = routes();
    const cookie = await app.request(`${BASE}/Users/user-1`, {
      headers: { cookie: "better-auth.session_token=abc" },
    });
    const basic = await app.request(`${BASE}/Users/user-1`, {
      headers: { authorization: `Basic ${Buffer.from(`a:${TOKEN}`).toString("base64")}` },
    });
    expect([cookie.status, basic.status]).toEqual([401, 401]);
  });

  it("limits requests per address before looking at the token", async () => {
    let at = 0;
    const app = routes(() => at);
    let last = 0;
    for (let i = 0; i < 601; i++) last = (await request(app, "/Users/user-1", {}, "bad")).status;
    expect(last).toBe(429);
    // Even the right token waits out the window.
    expect((await request(app, "/Users/user-1")).status).toBe(429);
    at = 61_000;
    expect((await request(app, "/Users/user-1")).status).toBe(200);
  });
});

describe("provisioning endpoint users", () => {
  it("finds an account by userName, ignoring case, for the directory's validation call", async () => {
    prisma.user.count.mockResolvedValue(1);
    prisma.user.findMany.mockResolvedValue([alice]);
    const response = await request(
      routes(),
      `/Users?filter=${encodeURIComponent('userName eq "alice@example.test"')}`,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/scim+json");
    const body = await response.json();
    expect(body).toMatchObject({
      totalResults: 1,
      Resources: [{ id: "user-1", userName: "Alice@Example.test", active: true }],
    });
    expect(prisma.user.findMany.mock.calls[0]?.[0].where).toEqual({
      email: { equals: "alice@example.test", mode: "insensitive" },
    });
  });

  it("answers an empty list for an unknown userName and rejects other filters", async () => {
    prisma.user.count.mockResolvedValue(0);
    prisma.user.findMany.mockResolvedValue([]);
    const none = await request(routes(), `/Users?filter=${encodeURIComponent('userName eq "x"')}`);
    expect(await none.json()).toMatchObject({ totalResults: 0, Resources: [] });
    const other = await request(
      routes(),
      `/Users?filter=${encodeURIComponent('externalId eq "x"')}`,
    );
    expect(other.status).toBe(400);
    expect(await other.json()).toMatchObject({ scimType: "invalidFilter" });
  });

  it("reports an account as inactive once deprovisioned", async () => {
    alice.deprovisionedAt = new Date();
    const response = await request(routes(), "/Users/user-1");
    expect(await response.json()).toMatchObject({ id: "user-1", active: false });
    expect((await request(routes(), "/Users/nobody")).status).toBe(404);
  });

  it("does not create accounts", async () => {
    const response = await request(routes(), "/Users", { method: "POST", body: "{}" });
    expect(response.status).toBe(501);
  });
});

describe("provisioning endpoint deprovisioning", () => {
  it.each([
    ["false", false],
    ['"False"', "False"],
    ['"false"', "false"],
  ])("deprovisions on PATCH active=%s", async (_label, value) => {
    const response = await request(routes(), "/Users/user-1", patch(value));
    expect(response.status).toBe(200);
    expect(lifecycle.deprovisionUser).toHaveBeenCalledWith(
      expect.anything(),
      { via: "provisioning" },
      { userId: "user-1" },
    );
    expect(await response.json()).toMatchObject({ active: false });
  });

  it("accepts the value without a path", async () => {
    await request(routes(), "/Users/user-1", patch(false, "bare"));
    expect(lifecycle.deprovisionUser).toHaveBeenCalledTimes(1);
  });

  it("reactivates on active=true and reports a conflict when an admin decided", async () => {
    alice.deprovisionedAt = new Date();
    expect((await request(routes(), "/Users/user-1", patch("True"))).status).toBe(200);
    expect(lifecycle.reactivateUser).toHaveBeenCalledWith(
      expect.anything(),
      { via: "provisioning" },
      "user-1",
    );
    lifecycle.reactivateUser.mockResolvedValue(false);
    const conflict = await request(routes(), "/Users/user-1", patch(true));
    expect(conflict.status).toBe(409);
  });

  it("ignores changes that do not touch active", async () => {
    const response = await request(routes(), "/Users/user-1", {
      method: "PATCH",
      body: JSON.stringify({ Operations: [{ op: "Replace", path: "displayName", value: "A" }] }),
    });
    expect(response.status).toBe(200);
    expect(lifecycle.deprovisionUser).not.toHaveBeenCalled();
    expect(lifecycle.reactivateUser).not.toHaveBeenCalled();
  });

  it("rejects malformed bodies and unknown accounts", async () => {
    expect((await request(routes(), "/Users/user-1", { method: "PATCH", body: "{" })).status).toBe(
      400,
    );
    expect((await request(routes(), "/Users/nobody", patch(false))).status).toBe(404);
    expect(lifecycle.deprovisionUser).not.toHaveBeenCalled();
  });

  it("deprovisions on DELETE and keeps the account", async () => {
    const response = await request(routes(), "/Users/user-1", { method: "DELETE" });
    expect(response.status).toBe(204);
    expect(lifecycle.deprovisionUser).toHaveBeenCalledWith(
      expect.anything(),
      { via: "provisioning" },
      { userId: "user-1" },
    );
    lifecycle.deprovisionUser.mockRejectedValue(new ORPCError("NOT_FOUND"));
    expect((await request(routes(), "/Users/nobody", { method: "DELETE" })).status).toBe(404);
  });
});

describe("requestedActive", () => {
  it("takes the last active it is given and nothing else", () => {
    expect(requestedActive({})).toBeNull();
    expect(requestedActive({ Operations: [{ op: "remove", path: "active" }] })).toBeNull();
    expect(
      requestedActive({
        Operations: [
          { op: "replace", path: "active", value: false },
          { op: "replace", path: "active", value: "True" },
        ],
      }),
    ).toBe(true);
    expect(
      requestedActive({ Operations: [{ op: "replace", path: "active", value: "maybe" }] }),
    ).toBeNull();
  });
});
