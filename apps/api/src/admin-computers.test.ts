import type { SandboxProvider } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { adminComputers } from "./admin-computers.js";
import type { RouterDeps } from "./router.js";

const base = {
  scope: "team",
  homeKey: "home-secret-key",
  spaceId: "space-1",
  userId: "owner",
  updatedAt: new Date("2026-03-01T00:00:00Z"),
  space: { name: "Ops" },
};

const rows = [
  {
    ...base,
    id: "c-1",
    kind: "docker",
    state: "running",
    providerRef: "box-1",
    runningSince: new Date("2026-03-02T00:00:00Z"),
    bots: [
      { id: "bot-a", name: "Alpha" },
      { id: "bot-b", name: "Beta" },
    ],
    // Columns the page must never expose, present on the stored row to prove the shaping drops them.
    screenUrl: "http://screen.internal/token",
    homeStorageKey: "wrapped-key",
    controlLeaseId: "lease-secret",
  },
  {
    ...base,
    id: "c-2",
    kind: "docker",
    state: "stopped",
    providerRef: null,
    runningSince: null,
    bots: [],
  },
  {
    ...base,
    id: "c-3",
    kind: "e2b",
    state: "running",
    providerRef: "remote-1",
    runningSince: null,
    bots: [{ id: "bot-c", name: "Gamma" }],
  },
];

function setup(options: { admin?: boolean; sandbox?: Partial<SandboxProvider> } = {}) {
  const findMany = vi.fn(async ({ take }: { take: number }) => rows.slice(0, take));
  const prisma = {
    user: {
      findUnique: async () => ({ email: "ada@example.test", emailVerified: true }),
      findMany: async () => [{ id: "owner", name: "Olive Owner", email: "olive@example.test" }],
    },
    computer: { findMany },
    computerRun: {
      groupBy: async () => [
        {
          computerId: "c-1",
          _max: {
            startedAt: new Date("2026-03-02T00:00:00Z"),
            endedAt: null,
            lastSeenAt: new Date("2026-03-02T01:00:00Z"),
          },
        },
      ],
    },
  } as unknown as PrismaClient;
  const inspect = vi.fn(async () => ({
    runtime: "running" as const,
    image: { ref: "registry.example/computer:1" },
    isolation: "container" as const,
  }));
  const sandbox = {
    describe: () => ({
      id: "docker",
      contractVersion: "1",
      adapterVersion: "0",
      capabilities: { fleet: { inspect: true } },
    }),
    inspect,
    ...options.sandbox,
  } as unknown as SandboxProvider;
  const deps = {
    prisma,
    sandbox,
    env: {
      adminEmails: options.admin === false ? [] : ["ada@example.test"],
      ssoAdminEnabled: false,
    },
    auth: { isSsoAdmin: async () => false },
  } as unknown as Parameters<typeof adminComputers>[0] & Pick<RouterDeps, "prisma">;
  return { deps, inspect, findMany };
}

describe("admin computer inventory", () => {
  it("refuses a non-admin before reading anything", async () => {
    const { deps, findMany, inspect } = setup({ admin: false });
    await expect(adminComputers(deps, "member", { limit: 10 })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    expect(findMany).not.toHaveBeenCalled();
    expect(inspect).not.toHaveBeenCalled();
  });

  it("lists computers with owner, bots, image, isolation and last activity", async () => {
    const { deps, inspect } = setup();
    const page = await adminComputers(deps, "admin", { limit: 10 });
    expect(page.computers[0]).toEqual({
      id: "c-1",
      kind: "docker",
      scope: "team",
      state: "running",
      ownerName: "Olive Owner",
      ownerEmail: "olive@example.test",
      spaceName: "Ops",
      bots: [
        { id: "bot-a", name: "Alpha" },
        { id: "bot-b", name: "Beta" },
      ],
      image: "registry.example/computer:1",
      isolation: "container",
      inspection: "inspected",
      runningSince: "2026-03-02T00:00:00.000Z",
      lastActivityAt: "2026-03-02T01:00:00.000Z",
    });
    // Only the running computer on the configured provider is asked.
    expect(inspect).toHaveBeenCalledTimes(1);
    expect(page.computers[1]).toMatchObject({
      id: "c-2",
      inspection: "not_running",
      image: null,
      isolation: null,
      lastActivityAt: null,
    });
  });

  it("exposes no secrets, paths, tokens or content", async () => {
    const { deps } = setup();
    const page = await adminComputers(deps, "admin", { limit: 10 });
    const text = JSON.stringify(page);
    for (const secret of [
      "home-secret-key",
      "screen.internal",
      "wrapped-key",
      "lease-secret",
      "box-1",
    ])
      expect(text).not.toContain(secret);
    expect(Object.keys(page.computers[0] ?? {}).sort()).toEqual([
      "bots",
      "id",
      "image",
      "inspection",
      "isolation",
      "kind",
      "lastActivityAt",
      "ownerEmail",
      "ownerName",
      "runningSince",
      "scope",
      "spaceName",
      "state",
    ]);
  });

  it("marks a computer on a provider that cannot inspect as skipped_unsupported", async () => {
    const { deps, inspect } = setup();
    const page = await adminComputers(deps, "admin", { limit: 10 });
    expect(page.computers[2]).toMatchObject({
      id: "c-3",
      inspection: "skipped_unsupported",
      image: null,
      isolation: null,
    });
    expect(inspect).not.toHaveBeenCalledWith(
      expect.objectContaining({ providerRef: "remote-1" }),
      expect.anything(),
    );
  });

  it("reports every computer skipped when the provider declares no fleet capability", async () => {
    const { deps, inspect } = setup({
      sandbox: {
        describe: () => ({
          id: "docker",
          contractVersion: "1",
          adapterVersion: "0",
          capabilities: {},
        }),
      } as unknown as Partial<SandboxProvider>,
    });
    const page = await adminComputers(deps, "admin", { limit: 10 });
    expect(page.computers.map((computer) => computer.inspection)).toEqual([
      "skipped_unsupported",
      "skipped_unsupported",
      "skipped_unsupported",
    ]);
    expect(inspect).not.toHaveBeenCalled();
  });

  it("reports unavailable instead of failing when the provider errors", async () => {
    const { deps } = setup({
      sandbox: {
        inspect: async () => {
          throw new Error("connect ECONNREFUSED 10.0.0.9:7777 token=abc");
        },
      },
    });
    const page = await adminComputers(deps, "admin", { limit: 10 });
    expect(page.computers[0]).toMatchObject({ inspection: "unavailable", image: null });
    expect(JSON.stringify(page)).not.toContain("ECONNREFUSED");
  });

  it("pages with a cursor", async () => {
    const { deps } = setup();
    const page = await adminComputers(deps, "admin", { limit: 2 });
    expect(page.computers.map((computer) => computer.id)).toEqual(["c-1", "c-2"]);
    expect(page.nextCursor).toBe("c-2");
  });
});
