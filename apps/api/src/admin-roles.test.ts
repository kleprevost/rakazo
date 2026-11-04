import { createRouterClient } from "@orpc/server";
import type { Actor, AdminRole } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it } from "vitest";
import { adminRoles } from "./admins.js";
import type { RouterDeps } from "./router.js";
import { createRouter } from "./router.js";

const accounts = [
  { id: "platform", email: "platform@example.test" },
  { id: "security", email: "security@example.test" },
  { id: "fleet", email: "fleet@example.test" },
  { id: "auditor", email: "auditor@example.test" },
  { id: "sso-fleet", email: "sso-fleet@example.test" },
  { id: "unverified", email: "security@example.test", verified: false },
  { id: "member", email: "member@example.test" },
];

/** Anything past the role check reaches the database, which this fake refuses with a plain error. */
const reached = new Error("reached the database");
const prisma = new Proxy(
  {
    user: {
      findUnique: async ({ where }: { where: { id: string } }) => {
        const account = accounts.find((row) => row.id === where.id);
        return account ? { email: account.email, emailVerified: account.verified !== false } : null;
      },
    },
  },
  {
    get: (target, key) => {
      if (key in target) return target[key as keyof typeof target];
      throw reached;
    },
  },
) as unknown as PrismaClient;

const deps = {
  prisma,
  auth: {
    isSsoAdmin: async () => false,
    ssoOperatorRoles: async (userId: string) => (userId === "sso-fleet" ? ["fleet"] : []),
  },
  env: {
    adminEmails: ["platform@example.test"],
    ssoAdminEnabled: false,
    operatorEmails: {
      security: ["security@example.test"],
      fleet: ["fleet@example.test"],
      auditor: ["auditor@example.test"],
    },
    ssoOperatorRolesEnabled: true,
    defaultProvider: "azure",
    defaultModel: "gpt-x",
    sandboxProvider: "fake",
    webOrigin: "http://127.0.0.1:5173",
    screenProxySecret: "fake-test-secret",
  },
  dataDir: "/tmp/rakazo-router-test",
} as unknown as RouterDeps;

const client = (userId: string) =>
  createRouterClient(createRouter(deps), {
    context: {
      actor: {
        userId,
        spaceId: "space-1",
        email: `${userId}@x.test`,
        isDeploymentOwner: false,
      } satisfies Actor,
    } as never,
  });

type Admin = ReturnType<typeof client>["admin"];

/** Procedure to the operator roles that may call it, besides `platform`, which may call all. */
const matrix: Array<[string, Array<Exclude<AdminRole, "platform">>, (admin: Admin) => unknown]> = [
  ["overview", ["security", "fleet", "auditor"], (a) => a.overview()],
  ["users.list", ["security", "auditor"], (a) => a.users.list({ limit: 10 })],
  ["users.endSessions", ["security"], (a) => a.users.endSessions({ userId: "member" })],
  ["bots.list", ["security", "auditor"], (a) => a.bots.list({ limit: 10 })],
  ["bots.suspend", ["security"], (a) => a.bots.suspend({ botId: "bot-1" })],
  ["bots.resume", ["security"], (a) => a.bots.resume({ botId: "bot-1" })],
  ["quarantine.list", ["security", "auditor"], (a) => a.quarantine.list()],
  ["quarantine.start", ["security"], (a) => a.quarantine.start({ scopeKind: "all" })],
  ["quarantine.lift", ["security"], (a) => a.quarantine.lift({ id: "q-1" })],
  ["credentials.revoke", ["security"], (a) => a.credentials.revoke({ userId: "member" })],
  ["computers.list", ["security", "fleet", "auditor"], (a) => a.computers.list({ limit: 10 })],
  [
    "computers.get",
    ["security", "fleet", "auditor"],
    (a) => a.computers.get({ computerId: "c-1" }),
  ],
  ["computers.quarantine", ["security"], (a) => a.computers.quarantine({ computerIds: ["c-1"] })],
  ["computers.release", ["security"], (a) => a.computers.release({ computerIds: ["c-1"] })],
  [
    "computers.operations.create",
    ["fleet"],
    (a) => a.computers.operations.create({ kind: "hibernate", computerIds: ["c-1"] }),
  ],
  [
    "computers.operations.list",
    ["security", "fleet", "auditor"],
    (a) => a.computers.operations.list({}),
  ],
  [
    "computers.operations.get",
    ["security", "fleet", "auditor"],
    (a) => a.computers.operations.get({ operationId: "op-1" }),
  ],
  ["policy", ["security", "fleet", "auditor"], (a) => a.policy()],
  ["audit", ["security", "auditor"], (a) => a.audit({ limit: 10 })],
];

async function outcome(call: () => unknown) {
  try {
    await call();
    return "allowed";
  } catch (error) {
    return (error as { code?: string }).code === "FORBIDDEN" ? "forbidden" : "allowed";
  }
}

describe("admin roles", () => {
  const roles: AdminRole[] = ["platform", "security", "fleet", "auditor"];
  for (const [name, allowed, call] of matrix) {
    it(`${name}: ${["platform", ...allowed].join(", ")}`, async () => {
      for (const role of roles) {
        const expected = role === "platform" || allowed.includes(role) ? "allowed" : "forbidden";
        expect(await outcome(() => call(client(role).admin)), `${name} as ${role}`).toBe(expected);
      }
      expect(await outcome(() => call(client("member").admin)), `${name} as member`).toBe(
        "forbidden",
      );
      expect(await outcome(() => call(client("unverified").admin)), `${name} unverified`).toBe(
        "forbidden",
      );
    });
  }

  it("answers FORBIDDEN, never NOT_FOUND, for every denial", async () => {
    await expect(
      client("fleet").admin.users.endSessions({ userId: "member" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      client("security").admin.computers.operations.create({
        kind: "hibernate",
        computerIds: ["c-1"],
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("keeps platform-only procedures for platform", async () => {
    for (const role of ["security", "fleet", "auditor"]) {
      await expect(
        client(role).marketplace.submissions({ status: "pending" }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
    }
  });

  it("lists the roles an account holds, from email lists and SSO values", async () => {
    expect(await adminRoles(deps, "platform")).toEqual(["platform"]);
    expect(await adminRoles(deps, "security")).toEqual(["security"]);
    expect(await adminRoles(deps, "sso-fleet")).toEqual(["fleet"]);
    expect(await adminRoles(deps, "unverified")).toEqual([]);
    expect(await adminRoles(deps, "member")).toEqual([]);
  });

  it("leaves an install with only RAKAZO_ADMIN_EMAILS as it was", async () => {
    const legacy = {
      ...deps,
      env: { adminEmails: ["platform@example.test"], ssoAdminEnabled: false },
    } as unknown as RouterDeps;
    expect(await adminRoles(legacy, "platform")).toEqual(["platform"]);
    expect(await adminRoles(legacy, "security")).toEqual([]);
  });
});
