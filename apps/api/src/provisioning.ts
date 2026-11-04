import { createHash, timingSafeEqual } from "node:crypto";
import { ORPCError } from "@orpc/server";
import { runAsSystem } from "@rakazo/db";
import type { Context } from "hono";
import { Hono } from "hono";
import { readBoundedBody } from "./http-body.js";
import type { LifecycleDeps } from "./identity-lifecycle.js";
import { deprovisionUser, reactivateUser } from "./identity-lifecycle.js";
import { throttleKey, windowCounter } from "./window-counter.js";

/** SCIM 2.0 (RFC 7644) subset: enough for a directory to find, deactivate and reactivate accounts. */
export const PROVISIONING_BASE_PATH = "/api/v1/scim/v2";

const USER_SCHEMA = "urn:ietf:params:scim:schemas:core:2.0:User";
const LIST_SCHEMA = "urn:ietf:params:scim:api:messages:2.0:ListResponse";
const ERROR_SCHEMA = "urn:ietf:params:scim:api:messages:2.0:Error";
const MEDIA_TYPE = "application/scim+json";
const WINDOW_MS = 60_000;
const REQUESTS_PER_WINDOW = 600;
const MAX_BODY_BYTES = 64 * 1024;
const MAX_PAGE = 100;

const system = <T>(what: string, fn: () => Promise<T>) => runAsSystem(`provisioning: ${what}`, fn);

type ScimUser = {
  id: string;
  name: string;
  email: string;
  createdAt: Date;
  deprovisionedAt: Date | null;
};

const USER_SELECT = {
  id: true,
  name: true,
  email: true,
  createdAt: true,
  deprovisionedAt: true,
} as const;

function resource(user: ScimUser) {
  return {
    schemas: [USER_SCHEMA],
    id: user.id,
    userName: user.email,
    displayName: user.name,
    name: { formatted: user.name },
    emails: [{ value: user.email, primary: true }],
    active: user.deprovisionedAt === null,
    meta: { resourceType: "User", created: user.createdAt.toISOString() },
  };
}

const digest = (value: string) => createHash("sha256").update(value).digest();

function bearerMatches(header: string | undefined, token: string): boolean {
  const presented = /^Bearer\s+(.+)$/i.exec(header ?? "")?.[1];
  return presented !== undefined && timingSafeEqual(digest(presented), digest(token));
}

/** `userName eq "value"`, the one filter a directory needs to find an account. */
function parseUserNameFilter(filter: string): string | null {
  const match = /^\s*userName\s+eq\s+"((?:[^"\\]|\\.)*)"\s*$/i.exec(filter);
  return match ? (match[1] ?? "").replace(/\\(.)/g, "$1") : null;
}

/** A directory sends booleans as true/false or as "True"/"False". */
function asBoolean(value: unknown): boolean | null {
  if (typeof value === "boolean") return value;
  if (typeof value === "string" && /^(true|false)$/i.test(value))
    return value.toLowerCase() === "true";
  return null;
}

/** The last `active` the PATCH asks for, or null when it does not touch `active`. */
export function requestedActive(body: unknown): boolean | null {
  const operations = (body as { Operations?: unknown } | null)?.Operations;
  if (!Array.isArray(operations)) return null;
  let active: boolean | null = null;
  for (const operation of operations) {
    const { op, path, value } = (operation ?? {}) as {
      op?: unknown;
      path?: unknown;
      value?: unknown;
    };
    if (typeof op !== "string" || !/^(add|replace)$/i.test(op)) continue;
    if (typeof path === "string" && path.toLowerCase() === "active") {
      active = asBoolean(value) ?? active;
    } else if (path === undefined && value && typeof value === "object") {
      active = asBoolean((value as { active?: unknown }).active) ?? active;
    }
  }
  return active;
}

export type ProvisioningDeps = LifecycleDeps & {
  /** The shared secret the directory presents as a bearer token. */
  token: string;
  clientIp: (c: Context) => string | undefined;
  now?: () => number;
};

export function provisioningRoutes(deps: ProvisioningDeps) {
  const app = new Hono();
  const requests = windowCounter(WINDOW_MS, deps.now);
  const { prisma } = deps;
  const fail = (status: 400 | 401 | 404 | 409 | 429 | 501, detail: string, scimType?: string) =>
    new Response(
      JSON.stringify({
        schemas: [ERROR_SCHEMA],
        status: String(status),
        detail,
        ...(scimType ? { scimType } : {}),
      }),
      {
        status,
        headers: {
          "content-type": MEDIA_TYPE,
          "cache-control": "no-store",
          ...(status === 401 ? { "www-authenticate": 'Bearer realm="provisioning"' } : {}),
          ...(status === 429 ? { "retry-after": String(WINDOW_MS / 1000) } : {}),
        },
      },
    );
  const ok = (body: unknown, status: 200 | 201 = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": MEDIA_TYPE, "cache-control": "no-store" },
    });

  app.use(`${PROVISIONING_BASE_PATH}/*`, async (c, next) => {
    // Counted before the token is compared, so guessing is bounded per address.
    if (requests(throttleKey(deps.clientIp(c))) > REQUESTS_PER_WINDOW)
      return fail(429, "Too many requests");
    if (!bearerMatches(c.req.header("authorization"), deps.token)) return fail(401, "Unauthorized");
    await next();
  });

  app.get(`${PROVISIONING_BASE_PATH}/ServiceProviderConfig`, () =>
    ok({
      schemas: ["urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig"],
      patch: { supported: true },
      bulk: { supported: false, maxOperations: 0, maxPayloadSize: 0 },
      filter: { supported: true, maxResults: MAX_PAGE },
      changePassword: { supported: false },
      sort: { supported: false },
      etag: { supported: false },
      authenticationSchemes: [{ type: "oauthbearertoken", name: "Bearer token", primary: true }],
    }),
  );

  app.get(`${PROVISIONING_BASE_PATH}/Users`, async (c) => {
    const filter = c.req.query("filter");
    const userName = filter ? parseUserNameFilter(filter) : null;
    if (filter && userName === null)
      return fail(400, "Only userName eq is supported", "invalidFilter");
    const count = Math.min(Math.max(Number(c.req.query("count") ?? MAX_PAGE) || 0, 0), MAX_PAGE);
    const startIndex = Math.max(Number(c.req.query("startIndex") ?? 1) || 1, 1);
    const where =
      userName === null ? {} : { email: { equals: userName, mode: "insensitive" as const } };
    const [total, users] = await system("list users", () =>
      Promise.all([
        prisma.user.count({ where }),
        prisma.user.findMany({
          where,
          select: USER_SELECT,
          orderBy: [{ createdAt: "asc" }, { id: "asc" }],
          skip: startIndex - 1,
          take: count,
        }),
      ]),
    );
    return ok({
      schemas: [LIST_SCHEMA],
      totalResults: total,
      startIndex,
      itemsPerPage: users.length,
      Resources: users.map(resource),
    });
  });

  const find = (id: string) =>
    system("find user", () => prisma.user.findUnique({ where: { id }, select: USER_SELECT }));

  app.get(`${PROVISIONING_BASE_PATH}/Users/:id`, async (c) => {
    const user = await find(c.req.param("id"));
    return user ? ok(resource(user)) : fail(404, "User not found");
  });

  // An account is created when its person first signs in, under the sign-up rules.
  app.post(`${PROVISIONING_BASE_PATH}/Users`, () =>
    fail(501, "Accounts are created at first sign-in"),
  );

  app.patch(`${PROVISIONING_BASE_PATH}/Users/:id`, async (c) => {
    const id = c.req.param("id");
    const text = await readBoundedBody(c.req.raw, MAX_BODY_BYTES);
    if (text === null) return fail(400, "Request too large", "invalidValue");
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      return fail(400, "Invalid JSON", "invalidSyntax");
    }
    if (!(await find(id))) return fail(404, "User not found");
    const active = requestedActive(body);
    try {
      if (active === false) await deprovisionUser(deps, { via: "provisioning" }, { userId: id });
      else if (active === true && !(await reactivateUser(deps, { via: "provisioning" }, id)))
        return fail(409, "Deactivated by an administrator", "mutability");
    } catch (error) {
      if (error instanceof ORPCError && error.code === "NOT_FOUND")
        return fail(404, "User not found");
      throw error;
    }
    const user = await find(id);
    return user ? ok(resource(user)) : fail(404, "User not found");
  });

  // Deleting in the directory deactivates; Rakazo keeps the account's data.
  app.delete(`${PROVISIONING_BASE_PATH}/Users/:id`, async (c) => {
    try {
      await deprovisionUser(deps, { via: "provisioning" }, { userId: c.req.param("id") });
    } catch (error) {
      if (error instanceof ORPCError && error.code === "NOT_FOUND")
        return fail(404, "User not found");
      throw error;
    }
    return new Response(null, { status: 204 });
  });

  return app;
}
