import { createRouterClient } from "@orpc/server";
import { setActivePolicy } from "@rakazo/adapters";
import type { Actor } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RouterDeps } from "./router.js";
import { createRouter } from "./router.js";

const users = [
  {
    id: "admin",
    name: "Ada Admin",
    email: "ada@example.test",
    emailVerified: true,
    createdAt: new Date("2026-01-03T00:00:00Z"),
  },
  {
    id: "sso-admin",
    name: "Sam SSO",
    email: "sam@example.test",
    emailVerified: true,
    createdAt: new Date("2026-01-02T00:00:00Z"),
  },
  {
    id: "member",
    name: "Mia Member",
    email: "mia@example.test",
    emailVerified: true,
    createdAt: new Date("2026-01-01T00:00:00Z"),
  },
];

const securityEvents = [
  {
    id: "ev-3",
    type: "policy.denied",
    userId: "member",
    spaceId: null,
    ip: "10.0.0.1",
    userAgent: "agent",
    metadata: { rule: "models.allowModels", subject: "x/y", surface: "run" },
    createdAt: new Date("2026-02-03T00:00:00Z"),
  },
  {
    id: "ev-2",
    type: "auth.sign_in",
    userId: "member",
    spaceId: null,
    ip: null,
    userAgent: null,
    metadata: {},
    createdAt: new Date("2026-02-02T00:00:00Z"),
  },
  {
    id: "ev-1",
    type: "auth.sign_in",
    userId: "admin",
    spaceId: null,
    ip: null,
    userAgent: null,
    metadata: {},
    createdAt: new Date("2026-02-01T00:00:00Z"),
  },
];

const bots = [
  {
    id: "bot-1",
    name: "Reporter",
    userId: "member",
    modelProvider: "azure",
    modelId: "gpt-x",
    archivedAt: null,
    suspendedAt: new Date("2026-02-06T00:00:00Z"),
    space: { name: "Team space" },
  },
  {
    id: "bot-2",
    name: "Old bot",
    userId: "ghost",
    modelProvider: null,
    modelId: null,
    archivedAt: new Date(),
    suspendedAt: null,
    space: { name: "Team space" },
  },
];

type IdFilter = { where?: { id?: { in: string[] } }; take?: number };

function setup(options: { ssoAdmins?: string[] } = {}) {
  const deleted: string[][] = [];
  const securityEventFindMany = vi.fn(
    async (args: { where: Record<string, unknown>; take: number }) => {
      const type = args.where.type as string | { in: string[] };
      return securityEvents
        .filter((row) =>
          typeof type === "string" ? row.type === type : type.in.includes(row.type),
        )
        .filter((row) => !args.where.userId || row.userId === args.where.userId)
        .slice(0, args.take);
    },
  );
  const prisma = {
    user: {
      findUnique: async ({ where }: { where: { id: string } }) =>
        users.find((user) => user.id === where.id) ?? null,
      findFirst: async ({ where }: { where: { email: { equals: string } } }) =>
        users.find((user) => user.email === where.email.equals.toLowerCase()) ?? null,
      findMany: async ({ where, take }: IdFilter) =>
        users.filter((user) => !where?.id || where.id.in.includes(user.id)).slice(0, take),
      count: async () => users.length,
    },
    account: { findMany: async () => [{ userId: "sso-admin" }] },
    session: {
      groupBy: async () => [
        { userId: "member", _max: { createdAt: new Date("2026-02-10T00:00:00Z") } },
      ],
    },
    securityEvent: {
      findMany: securityEventFindMany,
      findUnique: async () => null,
      groupBy: async () => [
        { userId: "member", _max: { createdAt: new Date("2026-02-02T00:00:00Z") } },
      ],
    },
    bot: {
      count: async () => bots.length,
      findMany: async ({ where, take }: IdFilter) =>
        bots.filter((bot) => !where?.id || where.id.in.includes(bot.id)).slice(0, take),
    },
    run: {
      groupBy: async () => [
        { botId: "bot-1", _max: { createdAt: new Date("2026-02-05T00:00:00Z") } },
      ],
    },
    usageRecord: {
      aggregate: async () => ({ _sum: { costUsd: 12.5 } }),
      groupBy: async ({ by }: { by: string[] }) =>
        by[0] === "userId"
          ? [{ userId: "member", _sum: { costUsd: 9 } }]
          : [{ botId: "bot-1", _sum: { costUsd: 4.25 } }],
    },
  } as unknown as PrismaClient;
  const internalAdapter = {
    listSessions: vi.fn(async () => [{ token: "t1" }, { token: "t2" }]),
    deleteSessions: vi.fn(async (tokens: string[]) => {
      deleted.push(tokens);
    }),
  };
  const deps = {
    prisma,
    auth: {
      isSsoAdmin: async (userId: string) => (options.ssoAdmins ?? []).includes(userId),
      $context: Promise.resolve({ internalAdapter }),
    },
    env: {
      adminEmails: ["ada@example.test"],
      ssoAdminEnabled: true,
      authModes: { password: false, sso: true, easyAuth: true },
      policyHash: "abc123",
      defaultProvider: "azure",
      defaultModel: "gpt-x",
      webOrigin: "http://127.0.0.1:5173",
      screenProxySecret: "fake-test-secret",
      sandboxProvider: "kubernetes",
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
    }).admin;
  return { client, deleted, internalAdapter, securityEventFindMany };
}

afterEach(() => setActivePolicy(undefined));

describe("admin console authorization", () => {
  it("refuses every procedure to a non-admin", async () => {
    const { client, internalAdapter } = setup();
    const member = client("member");
    const calls: Array<() => Promise<unknown>> = [
      () => member.overview(),
      () => member.users.list({ limit: 10 }),
      () => member.users.endSessions({ userId: "admin" }),
      () => member.bots.list({ limit: 10 }),
      () => member.bots.suspend({ botId: "bot-1" }),
      () => member.bots.resume({ botId: "bot-1" }),
      () => member.policy(),
      () => member.audit({ limit: 10 }),
    ];
    for (const call of calls) await expect(call()).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(internalAdapter.deleteSessions).not.toHaveBeenCalled();
  });

  it("refuses a listed admin whose email is unverified", async () => {
    const { client } = setup();
    users[0]!.emailVerified = false;
    try {
      await expect(client("admin").overview()).rejects.toMatchObject({ code: "FORBIDDEN" });
    } finally {
      users[0]!.emailVerified = true;
    }
  });

  it("lets an SSO admin in", async () => {
    const { client } = setup({ ssoAdmins: ["sso-admin"] });
    await expect(client("sso-admin").overview()).resolves.toMatchObject({ userCount: 3 });
  });
});

describe("admin console data", () => {
  it("summarizes the deployment", async () => {
    setActivePolicy({ version: 1 });
    const { client } = setup();
    await expect(client("admin").overview()).resolves.toEqual({
      auth: { password: false, sso: true, easyAuth: true },
      defaultModel: "azure/gpt-x",
      computerProvider: "kubernetes",
      policy: { loaded: true, version: 1, hash: "abc123" },
      modelCredits: false,
      userCount: 3,
      botCount: 2,
    });
  });

  it("reports no policy as not loaded", async () => {
    const { client } = setup();
    const overview = await client("admin").overview();
    expect(overview.policy).toEqual({ loaded: false, version: null, hash: null });
  });

  it("lists users with role, SSO link and last sign-in, and nothing sensitive", async () => {
    const { client } = setup({ ssoAdmins: ["sso-admin"] });
    const page = await client("admin").users.list({ limit: 10 });
    expect(page.nextCursor).toBeNull();
    expect(page.users.map((user) => [user.id, user.adminVia, user.ssoLinked, user.isSelf])).toEqual(
      [
        ["admin", "email", false, true],
        ["sso-admin", "sso", true, false],
        ["member", null, false, false],
      ],
    );
    expect(page.users[2]?.lastSignInAt).toBe("2026-02-10T00:00:00.000Z");
    expect(page.users[0]?.lastSignInAt).toBeNull();
    expect(Object.keys(page.users[0] ?? {}).sort()).toEqual(
      [
        "adminVia",
        "createdAt",
        "email",
        "id",
        "isSelf",
        "lastSignInAt",
        "name",
        "ssoLinked",
      ].sort(),
    );
  });

  it("pages users", async () => {
    const { client } = setup();
    const page = await client("admin").users.list({ limit: 2 });
    expect(page.users).toHaveLength(2);
    expect(page.nextCursor).toBe("sso-admin");
  });

  it("ends every session of another user", async () => {
    const { client, deleted } = setup();
    await expect(client("admin").users.endSessions({ userId: "member" })).resolves.toEqual({
      ended: 2,
    });
    expect(deleted).toEqual([["t1", "t2"]]);
  });

  it("will not end your own sessions or an unknown user's", async () => {
    const { client } = setup();
    await expect(client("admin").users.endSessions({ userId: "admin" })).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
    await expect(client("admin").users.endSessions({ userId: "nobody" })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });

  it("lists bots with owner, space, model, activity and spend", async () => {
    const { client } = setup();
    const page = await client("admin").bots.list({ limit: 10 });
    expect(page.bots).toEqual([
      {
        id: "bot-1",
        name: "Reporter",
        ownerName: "Mia Member",
        ownerEmail: "mia@example.test",
        spaceName: "Team space",
        model: "azure/gpt-x",
        lastActiveAt: "2026-02-05T00:00:00.000Z",
        monthlySpendUsd: 4.25,
        archived: false,
        suspendedAt: "2026-02-06T00:00:00.000Z",
      },
      {
        id: "bot-2",
        name: "Old bot",
        ownerName: null,
        ownerEmail: null,
        spaceName: "Team space",
        model: null,
        lastActiveAt: null,
        monthlySpendUsd: 0,
        archived: true,
        suspendedAt: null,
      },
    ]);
  });

  it("shows the policy, month spend against limits, and recent denials", async () => {
    setActivePolicy({ version: 1, budgets: { organizationUsd: 100, perUserUsd: 10 } });
    const { client } = setup();
    const view = await client("admin").policy();
    expect(view).toMatchObject({
      loaded: true,
      version: 1,
      hash: "abc123",
      limits: { organizationUsd: 100, perUserUsd: 10, perBotUsd: null },
      spend: {
        organizationUsd: 12.5,
        users: [{ id: "member", label: "mia@example.test", spentUsd: 9 }],
        bots: [{ id: "bot-1", label: "Reporter", spentUsd: 4.25 }],
      },
      denied: [
        {
          id: "ev-3",
          userEmail: "mia@example.test",
          rule: "models.allowModels",
          subject: "x/y",
          surface: "run",
        },
      ],
    });
    expect(view.policy?.budgets?.organizationUsd).toBe(100);
  });

  it("shows an empty policy view when none is loaded", async () => {
    const { client } = setup();
    const view = await client("admin").policy();
    expect(view).toMatchObject({ loaded: false, policy: null, hash: null });
    expect(view.limits).toEqual({ organizationUsd: null, perUserUsd: null, perBotUsd: null });
  });

  it("pages security events and filters by type, user email and dates", async () => {
    const { client, securityEventFindMany } = setup();
    const first = await client("admin").audit({ limit: 2 });
    expect(first.events.map((event) => event.id)).toEqual(["ev-3", "ev-2"]);
    expect(first.nextCursor).toBe("ev-2");
    expect(first.events[0]).toEqual({
      id: "ev-3",
      type: "policy.denied",
      createdAt: "2026-02-03T00:00:00.000Z",
      userEmail: "mia@example.test",
      ip: "10.0.0.1",
      metadata: { rule: "models.allowModels", subject: "x/y", surface: "run" },
    });
    const filtered = await client("admin").audit({
      type: "auth.sign_in",
      user: "MIA@example.test",
      from: "2026-02-01T00:00:00Z",
      to: "2026-03-01T00:00:00Z",
      limit: 10,
    });
    expect(filtered.events.map((event) => event.id)).toEqual(["ev-2"]);
    expect(securityEventFindMany.mock.lastCall?.[0].where).toMatchObject({
      type: "auth.sign_in",
      userId: "member",
      createdAt: { gte: new Date("2026-02-01T00:00:00Z"), lt: new Date("2026-03-01T00:00:00Z") },
    });
    await expect(
      client("admin").audit({ user: "nobody@example.test", limit: 10 }),
    ).resolves.toEqual({ events: [], nextCursor: null });
  });
});
