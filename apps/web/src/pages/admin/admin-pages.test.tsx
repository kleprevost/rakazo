// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  me: vi.fn(),
  overview: vi.fn(),
  users: vi.fn(),
  bots: vi.fn(),
  computers: vi.fn(),
  computer: vi.fn(),
  operations: vi.fn(),
  operation: vi.fn(),
  createOperation: vi.fn(),
  policy: vi.fn(),
  audit: vi.fn(),
  endSessions: vi.fn(),
  suspend: vi.fn(),
  resume: vi.fn(),
  quarantines: vi.fn(),
  quarantineStart: vi.fn(),
  quarantineLift: vi.fn(),
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
}));

vi.mock("../../lib/rpc", () => ({
  rpc: {
    admin: {
      users: { endSessions: api.endSessions },
      bots: { suspend: api.suspend, resume: api.resume },
      quarantine: { start: api.quarantineStart, lift: api.quarantineLift },
      computers: { operations: { create: api.createOperation } },
    },
  },
}));
vi.mock("../../lib/query", () => {
  const plain = (name: string, call: (input?: unknown) => unknown) => ({
    queryOptions: () => ({ queryKey: [name], queryFn: () => call() }),
  });
  const paged = (name: string, call: (input?: unknown) => unknown) => ({
    infiniteOptions: (options: {
      input: (cursor: string | null) => unknown;
      initialPageParam: string | null;
      getNextPageParam: (page: never) => unknown;
    }) => ({
      ...options,
      queryKey: [name, JSON.stringify(options.input(null))],
      queryFn: ({ pageParam }: { pageParam: string | null }) => call(options.input(pageParam)),
    }),
  });
  const queries = {
    me: plain("me", () => api.me()),
    admin: {
      overview: plain("overview", () => api.overview()),
      users: { list: paged("users", (input) => api.users(input)) },
      bots: { list: paged("bots", (input) => api.bots(input)) },
      computers: {
        list: paged("computers", (input) => api.computers(input)),
        get: plain("computer", () => api.computer()),
        operations: {
          list: plain("operations", () => api.operations()),
          get: plain("operation", () => api.operation()),
        },
      },
      quarantine: { list: plain("quarantines", () => api.quarantines()) },
      policy: plain("policy", () => api.policy()),
      audit: paged("audit", (input) => api.audit(input)),
    },
  };
  return { useSpaceQueries: () => queries };
});
vi.mock("../../lib/user-error", () => ({
  errorText: (error: unknown, fallback: string) =>
    error instanceof Error ? error.message : fallback,
}));
vi.mock("../WindowChrome", () => ({ WindowChrome: () => null }));
vi.mock("@lingui/react/macro", () => {
  const t = (parts: TemplateStringsArray, ...values: unknown[]) =>
    parts.reduce((text, part, index) => text + String(values[index - 1] ?? "") + part);
  return {
    useLingui: () => ({ t, i18n: { locale: "en" } }),
    Trans: ({ children }: { children: ReactNode }) => children,
    Plural: ({ value, one, other }: { value: number; one: string; other: string }) =>
      (value === 1 ? one : other).replace("#", String(value)),
  };
});
vi.mock("@rakazo/ui-web", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@rakazo/ui-web")>()),
  toast: { error: api.toastError, success: api.toastSuccess },
}));

import { AdminAuditPage } from "./AdminAuditPage";
import { AdminBotsPage } from "./AdminBotsPage";
import { AdminComputersPage } from "./AdminComputersPage";
import { AdminOverviewPage } from "./AdminOverviewPage";
import { AdminPolicyPage } from "./AdminPolicyPage";
import { AdminUsersPage } from "./AdminUsersPage";
import { policyRows } from "./policy-rows";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function show(element: ReactNode) {
  const host = document.createElement("div");
  document.body.append(host);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const root = createRoot(host);
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={["/admin"]}>
          <Routes>
            <Route path="/admin" element={element} />
            <Route path="/app" element={<p>app home</p>} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
  // The shell reads who you are first; the page's own read starts once it renders.
  for (let round = 0; round < 3; round += 1) await settle();
  return { host, root };
}

const never = () => new Promise(() => undefined);

beforeEach(() => {
  document.body.innerHTML = "";
  for (const mock of Object.values(api)) mock.mockReset();
  api.me.mockResolvedValue({ isAdmin: true });
  api.overview.mockResolvedValue({ modelCredits: false });
  api.quarantines.mockResolvedValue({ quarantines: [] });
  api.policy.mockResolvedValue({ policy: null });
});

it("sends a non-admin back to the app without asking the API for admin data", async () => {
  api.me.mockResolvedValue({ isAdmin: false });
  const { host } = await show(<AdminOverviewPage />);
  expect(host.textContent).toContain("app home");
  expect(api.overview).not.toHaveBeenCalled();
});

it("links the sections and shows Free access only when the deployment sells credits", async () => {
  api.overview.mockResolvedValue({
    modelCredits: true,
    auth: { password: true, sso: false, easyAuth: false },
    defaultModel: "azure/gpt-x",
    computerProvider: "kubernetes",
    policy: { loaded: false, version: null, hash: null },
    userCount: 1,
    botCount: 0,
  });
  const { host } = await show(<AdminOverviewPage />);
  const links = [...host.querySelectorAll("nav a")].map((a) => a.getAttribute("href"));
  expect(links).toEqual([
    "/admin",
    "/admin/users",
    "/admin/bots",
    "/admin/computers",
    "/admin/policy",
    "/admin/audit",
    "/admin/access",
    "/admin/plugins",
  ]);
});

it.each([
  ["security", ["/admin", "/admin/users", "/admin/bots", "/admin/policy", "/admin/audit"]],
  ["fleet", ["/admin", "/admin/computers", "/admin/policy"]],
  [
    "auditor",
    ["/admin", "/admin/users", "/admin/bots", "/admin/computers", "/admin/policy", "/admin/audit"],
  ],
])("shows a %s operator only the sections the role allows", async (role, expected) => {
  api.me.mockResolvedValue({ isAdmin: false, adminRoles: [role] });
  api.overview.mockResolvedValue({
    modelCredits: true,
    auth: { password: true, sso: false, easyAuth: false },
    defaultModel: "azure/gpt-x",
    computerProvider: "kubernetes",
    policy: { loaded: false, version: null, hash: null },
    userCount: 1,
    botCount: 0,
  });
  const { host } = await show(<AdminOverviewPage />);
  const links = [...host.querySelectorAll("nav a")].map((a) => a.getAttribute("href"));
  expect(links).toEqual(expected);
});

it("hides the end-sessions action from an auditor but not from security", async () => {
  api.users.mockResolvedValue({
    users: [
      {
        id: "u2",
        name: "Sam",
        email: "sam@example.test",
        createdAt: "2026-01-01T00:00:00.000Z",
        adminVia: null,
        ssoLinked: false,
        lastSignInAt: null,
        isSelf: false,
      },
    ],
    nextCursor: null,
  });
  api.me.mockResolvedValue({ isAdmin: false, adminRoles: ["auditor"] });
  const auditor = await show(<AdminUsersPage />);
  expect(auditor.host.textContent).toContain("sam@example.test");
  expect(auditor.host.textContent).not.toContain("End sessions");

  document.body.innerHTML = "";
  api.me.mockResolvedValue({ isAdmin: false, adminRoles: ["security"] });
  const security = await show(<AdminUsersPage />);
  expect(security.host.textContent).toContain("End sessions");
});

it("shows the overview: loading, error with retry, and populated", async () => {
  api.overview.mockImplementation(never);
  const loading = await show(<AdminOverviewPage />);
  expect(loading.host.querySelector('[aria-label="Loading…"]')).not.toBeNull();

  document.body.innerHTML = "";
  api.overview.mockRejectedValueOnce(new Error("Boom"));
  const failed = await show(<AdminOverviewPage />);
  expect(failed.host.querySelector('[role="alert"]')?.textContent).toContain("Boom");

  document.body.innerHTML = "";
  api.overview.mockResolvedValue({
    modelCredits: false,
    auth: { password: false, sso: true, easyAuth: true },
    defaultModel: "azure/gpt-x",
    computerProvider: "kubernetes",
    policy: { loaded: true, version: 1, hash: "0123456789abcdef" },
    userCount: 4,
    botCount: 9,
  });
  const done = await show(<AdminOverviewPage />);
  const text = done.host.querySelector('[data-testid="admin-overview"]')?.textContent ?? "";
  expect(text).toContain("SSO");
  expect(text).toContain("Easy Auth");
  expect(text).not.toContain("Password");
  expect(text).toContain("azure/gpt-x");
  expect(text).toContain("kubernetes");
  expect(text).toContain("Version 1");
  expect(text).toContain("0123456789ab");
});

it("shows the users page: empty, error, and populated with the end-sessions action", async () => {
  api.users.mockResolvedValue({ users: [], nextCursor: null });
  const empty = await show(<AdminUsersPage />);
  expect(empty.host.textContent).toContain("Nothing to show.");

  document.body.innerHTML = "";
  api.users.mockRejectedValueOnce(new Error("Nope"));
  const failed = await show(<AdminUsersPage />);
  expect(failed.host.querySelector('[role="alert"]')?.textContent).toContain("Nope");

  document.body.innerHTML = "";
  api.users.mockResolvedValue({
    users: [
      {
        id: "u1",
        name: "Ada",
        email: "ada@example.test",
        createdAt: "2026-01-01T00:00:00.000Z",
        adminVia: "email",
        ssoLinked: false,
        lastSignInAt: "2026-02-01T10:00:00.000Z",
        isSelf: true,
      },
      {
        id: "u2",
        name: "Sam",
        email: "sam@example.test",
        createdAt: "2026-01-01T00:00:00.000Z",
        adminVia: null,
        ssoLinked: true,
        lastSignInAt: null,
        isSelf: false,
      },
    ],
    nextCursor: null,
  });
  api.endSessions.mockResolvedValue({ ended: 2 });
  const { host } = await show(<AdminUsersPage />);
  const rows = host.querySelectorAll('[data-testid="admin-users"] tbody tr');
  expect(rows).toHaveLength(2);
  expect(rows[0]?.textContent).toContain("Admin (email list)");
  expect(rows[1]?.textContent).toContain("Member");
  expect(rows[1]?.textContent).toContain("SSO");
  // Your own row has no action; another's asks for confirmation first.
  expect(rows[0]?.querySelector("button")).toBeNull();
  const button = rows[1]?.querySelector("button") as HTMLButtonElement;
  await act(async () => button.click());
  expect(api.endSessions).not.toHaveBeenCalled();
  expect(button.textContent).toBe("Confirm");
  await act(async () => button.click());
  expect(api.endSessions).toHaveBeenCalledWith({ userId: "u2" });
  expect(api.toastSuccess).toHaveBeenCalledWith("Sessions ended");
});

it("pages users with Load more", async () => {
  const user = (id: string) => ({
    id,
    name: id,
    email: `${id}@example.test`,
    createdAt: "2026-01-01T00:00:00.000Z",
    adminVia: null,
    ssoLinked: false,
    lastSignInAt: null,
    isSelf: false,
  });
  api.users.mockImplementation(async (input: { cursor?: string }) =>
    input.cursor
      ? { users: [user("b")], nextCursor: null }
      : { users: [user("a")], nextCursor: "a" },
  );
  const { host } = await show(<AdminUsersPage />);
  const more = [...host.querySelectorAll("button")].find((b) => b.textContent === "Load more");
  await act(async () => more?.click());
  await settle();
  expect(host.querySelectorAll('[data-testid="admin-users"] tbody tr')).toHaveLength(2);
  expect([...host.querySelectorAll("button")].some((b) => b.textContent === "Load more")).toBe(
    false,
  );
});

it("shows the AI employees page: empty, loading, and populated", async () => {
  api.bots.mockResolvedValue({ bots: [], nextCursor: null });
  const empty = await show(<AdminBotsPage />);
  expect(empty.host.textContent).toContain("Nothing to show.");

  document.body.innerHTML = "";
  api.bots.mockImplementation(never);
  const loading = await show(<AdminBotsPage />);
  expect(loading.host.querySelector('[aria-label="Loading…"]')).not.toBeNull();

  document.body.innerHTML = "";
  api.bots.mockResolvedValue({
    bots: [
      {
        id: "b1",
        name: "Reporter",
        ownerName: "Mia",
        ownerEmail: "mia@example.test",
        spaceName: "Team space",
        model: "azure/gpt-x",
        lastActiveAt: "2026-02-05T00:00:00.000Z",
        monthlySpendUsd: 4.25,
        archived: true,
        suspendedAt: null,
        quarantinedAt: null,
      },
    ],
    nextCursor: null,
  });
  const { host } = await show(<AdminBotsPage />);
  const row = host.querySelector('[data-testid="admin-bots"] tbody tr')?.textContent ?? "";
  for (const part of [
    "Reporter",
    "Archived",
    "mia@example.test",
    "Team space",
    "azure/gpt-x",
    "$4.25",
  ])
    expect(row).toContain(part);
});

it("shows the computers page: empty, loading, error with retry, and populated", async () => {
  api.computers.mockResolvedValue({ computers: [], nextCursor: null });
  const empty = await show(<AdminComputersPage />);
  expect(empty.host.textContent).toContain("Nothing to show.");

  document.body.innerHTML = "";
  api.computers.mockImplementation(never);
  const loading = await show(<AdminComputersPage />);
  expect(loading.host.querySelector('[aria-label="Loading…"]')).not.toBeNull();

  document.body.innerHTML = "";
  api.computers.mockRejectedValue(new Error("boom"));
  const failed = await show(<AdminComputersPage />);
  expect(failed.host.querySelector('[role="alert"]')?.textContent).toContain("boom");
  expect(failed.host.textContent).toContain("Retry");

  document.body.innerHTML = "";
  const computer = {
    kind: "docker",
    scope: "team",
    ownerName: "Mia",
    ownerEmail: "mia@example.test",
    spaceName: "Team space",
    runningSince: null,
    lastActivityAt: "2026-02-05T00:00:00.000Z",
  };
  api.computers.mockResolvedValue({
    computers: [
      {
        ...computer,
        id: "c1",
        state: "running",
        bots: [
          { id: "b1", name: "Reporter" },
          { id: "b2", name: "Analyst" },
        ],
        image: "registry.example.test/computer:1",
        isolation: "container",
        inspection: "inspected",
        health: "degraded",
      },
      {
        ...computer,
        id: "c2",
        kind: "e2b",
        state: "stopped",
        bots: [{ id: "b3", name: "Courier" }],
        image: null,
        isolation: null,
        inspection: "skipped_unsupported",
        health: "unknown",
      },
    ],
    nextCursor: null,
  });
  const { host } = await show(<AdminComputersPage />);
  const rows = [...host.querySelectorAll('[data-testid="admin-computers"] tbody tr')].map(
    (row) => row.textContent ?? "",
  );
  for (const part of [
    "Reporter, Analyst",
    "mia@example.test",
    "docker",
    "Running",
    "registry.example.test/computer:1",
    "container",
    "Degraded",
  ])
    expect(rows[0]).toContain(part);
  for (const part of ["Courier", "e2b", "Stopped", "Not reported", "Unknown"])
    expect(rows[1]).toContain(part);
});

it("opens a computer's detail: observation, disk and restart history, and its failure", async () => {
  api.computers.mockResolvedValue({
    computers: [
      {
        id: "c1",
        kind: "docker",
        scope: "team",
        state: "running",
        ownerName: "Mia",
        ownerEmail: "mia@example.test",
        spaceName: "Team space",
        bots: [{ id: "b1", name: "Reporter" }],
        image: "registry.example.test/computer:1",
        isolation: "container",
        inspection: "inspected",
        health: "ok",
        runningSince: null,
        lastActivityAt: null,
      },
    ],
    nextCursor: null,
  });
  api.computer.mockRejectedValue(new Error("gone"));
  const { host } = await show(<AdminComputersPage />);
  const open = async () => {
    await act(async () => {
      (host.querySelector("tbody button") as HTMLButtonElement).click();
    });
    await act(async () => {});
  };
  await open();
  expect(document.body.querySelector('[role="alert"]')?.textContent).toContain("gone");

  document.body.innerHTML = "";
  api.computer.mockResolvedValue({
    id: "c1",
    kind: "docker",
    scope: "team",
    state: "running",
    ownerName: "Mia",
    ownerEmail: "mia@example.test",
    spaceName: "Team space",
    bots: [{ id: "b1", name: "Reporter" }],
    image: "registry.example.test/computer:1",
    isolation: "container",
    inspection: "inspected",
    health: "ok",
    runningSince: null,
    lastActivityAt: null,
    createdAt: "2026-02-01T00:00:00.000Z",
    imageDigest: `sha256:${"a".repeat(64)}`,
    disk: { usedBytes: 5 * 1024 ** 3, freeBytes: 5 * 1024 ** 3 },
    observation: {
      observedAt: "2026-02-05T00:00:00.000Z",
      runtime: "running",
      startedAt: null,
      restartCount: 3,
      usage: {
        cpuMillis: 150,
        memoryBytes: 512 * 1024 ** 2,
        memoryLimitBytes: 2 * 1024 ** 3,
        pids: 9,
      },
      egress: { mode: "restricted", enforced: true },
    },
    runs: [
      {
        startedAt: "2026-02-04T00:00:00.000Z",
        endedAt: null,
        endReason: "replaced",
        lastSeenAt: null,
      },
    ],
  });
  const second = await show(<AdminComputersPage />);
  await act(async () => {
    (second.host.querySelector("tbody button") as HTMLButtonElement).click();
  });
  for (let round = 0; round < 3; round += 1) await settle();
  const detail = document.body.querySelector('[data-testid="admin-computer-detail"]')?.textContent;
  for (const part of [
    "Healthy",
    `sha256:${"a".repeat(64)}`,
    "Restricted",
    "3",
    "150 m",
    "replaced",
  ])
    expect(detail).toContain(part);
});

it("flags computers off the approved image list and filters to them, only when a list exists", async () => {
  const computer = {
    kind: "docker",
    scope: "team",
    state: "running",
    ownerName: "Mia",
    ownerEmail: "mia@example.test",
    spaceName: "Team space",
    image: "registry.example.test/computer:1",
    isolation: "container",
    inspection: "inspected",
    health: "ok",
    runningSince: null,
    lastActivityAt: null,
  };
  // No policy list: nothing is graded, so there is nothing to flag or filter.
  api.computers.mockResolvedValue({
    computers: [{ ...computer, id: "c1", bots: [], imageCompliance: null }],
    nextCursor: null,
  });
  const plain = await show(<AdminComputersPage />);
  expect(plain.host.textContent).not.toContain("Not approved");

  document.body.innerHTML = "";
  api.computers.mockClear();
  api.computers.mockImplementation(async (input?: { imageCompliance?: string }) => ({
    computers: [
      {
        ...computer,
        id: "c1",
        bots: [{ id: "b1", name: "Approved bot" }],
        imageCompliance: "approved",
      },
      {
        ...computer,
        id: "c2",
        bots: [{ id: "b2", name: "Drifted bot" }],
        imageCompliance: "not_approved",
      },
    ].filter((entry) => !input?.imageCompliance || entry.imageCompliance === "not_approved"),
    nextCursor: null,
  }));
  const { host } = await show(<AdminComputersPage />);
  const rows = () =>
    [...host.querySelectorAll('[data-testid="admin-computers"] tbody tr')].map(
      (row) => row.textContent ?? "",
    );
  expect(rows()).toHaveLength(2);
  expect(rows()[0]).not.toContain("Not approved");
  expect(rows()[1]).toContain("Not approved");

  const toggle = [...host.querySelectorAll("button")].find(
    (button) => button.textContent === "Not approved",
  ) as HTMLButtonElement;
  expect(toggle.getAttribute("aria-pressed")).toBe("false");
  await act(async () => toggle.click());
  for (let round = 0; round < 3; round += 1) await settle();
  expect(api.computers).toHaveBeenLastCalledWith({ limit: 50, imageCompliance: "not_approved" });
  expect(rows()).toHaveLength(1);
  expect(rows()[0]).toContain("Drifted bot");
  expect(toggle.getAttribute("aria-pressed")).toBe("true");
});

it("suspends an AI employee after a confirming click and resumes it in one click", async () => {
  const bot = {
    id: "b1",
    name: "Reporter",
    ownerName: "Mia",
    ownerEmail: "mia@example.test",
    spaceName: "Team space",
    model: null,
    lastActiveAt: null,
    monthlySpendUsd: 0,
    archived: false,
    suspendedAt: null as string | null,
    quarantinedAt: null as string | null,
  };
  api.bots.mockImplementation(async () => ({ bots: [{ ...bot }], nextCursor: null }));
  api.suspend.mockImplementation(async () => {
    bot.suspendedAt = "2026-02-05T00:00:00.000Z";
    return { cancelledRuns: 0 };
  });
  api.resume.mockImplementation(async () => {
    bot.suspendedAt = null;
    return { ok: true };
  });
  const { host } = await show(<AdminBotsPage />);
  const button = () => host.querySelector<HTMLButtonElement>("tbody tr button");
  expect(button()?.textContent).toBe("Suspend");
  await act(async () => button()?.click());
  expect(api.suspend).not.toHaveBeenCalled();
  expect(button()?.textContent).toBe("Confirm");
  await act(async () => button()?.click());
  await settle();
  expect(api.suspend).toHaveBeenCalledWith({ botId: "b1" });
  expect(host.querySelector("tbody tr")?.textContent).toContain("Suspended");
  expect(button()?.textContent).toBe("Resume");
  await act(async () => button()?.click());
  await settle();
  expect(api.resume).toHaveBeenCalledWith({ botId: "b1" });
  expect(button()?.textContent).toBe("Suspend");
});

it("quarantines a bot and everyone with a confirming click, and releases a quarantine", async () => {
  const bot = {
    id: "b1",
    name: "Reporter",
    ownerName: "Mia",
    ownerEmail: "mia@example.test",
    spaceName: "Team space",
    model: null,
    lastActiveAt: null,
    monthlySpendUsd: 0,
    archived: false,
    suspendedAt: null,
    quarantinedAt: null as string | null,
  };
  let quarantines: unknown[] = [];
  api.bots.mockImplementation(async () => ({ bots: [{ ...bot }], nextCursor: null }));
  api.quarantines.mockImplementation(async () => ({ quarantines }));
  api.quarantineStart.mockImplementation(async () => {
    bot.quarantinedAt = "2026-02-05T00:00:00.000Z";
    quarantines = [
      {
        id: "q1",
        scopeKind: "bot",
        scopeId: "b1",
        scopeName: "Reporter",
        reason: "",
        createdAt: bot.quarantinedAt,
      },
    ];
    return { id: "q1" };
  });
  api.quarantineLift.mockImplementation(async () => {
    bot.quarantinedAt = null;
    quarantines = [];
    return { ok: true };
  });
  const { host } = await show(<AdminBotsPage />);
  const rowButtons = () =>
    [...host.querySelectorAll<HTMLButtonElement>("tbody tr button")].map((b) => b.textContent);
  expect(rowButtons()).toEqual(["Suspend", "Quarantine"]);
  const quarantineButton = () =>
    host.querySelectorAll<HTMLButtonElement>("tbody tr button")[1] as HTMLButtonElement;
  await act(async () => quarantineButton().click());
  expect(api.quarantineStart).not.toHaveBeenCalled();
  await act(async () => quarantineButton().click());
  await settle();
  expect(api.quarantineStart).toHaveBeenCalledWith({ scopeKind: "bot", scopeId: "b1" });
  expect(host.querySelector("tbody tr")?.textContent).toContain("Quarantined");
  expect(rowButtons()).toEqual(["Suspend"]);
  const release = [...host.querySelectorAll("button")].find((b) => b.textContent === "Release");
  await act(async () => release?.click());
  await settle();
  expect(api.quarantineLift).toHaveBeenCalledWith({ id: "q1" });
  expect(rowButtons()).toEqual(["Suspend", "Quarantine"]);
  const all = () =>
    [...host.querySelectorAll("button")].find(
      (b) => b.textContent === "Quarantine all" || b.textContent === "Confirm",
    );
  expect(all()?.textContent).toBe("Quarantine all");
  await act(async () => all()?.click());
  await act(async () => all()?.click());
  await settle();
  expect(api.quarantineStart).toHaveBeenLastCalledWith({ scopeKind: "all" });
});

it("shows the policy page: error, not loaded, and populated", async () => {
  api.policy.mockRejectedValueOnce(new Error("Denied"));
  const failed = await show(<AdminPolicyPage />);
  expect(failed.host.querySelector('[role="alert"]')?.textContent).toContain("Denied");

  document.body.innerHTML = "";
  const spend = {
    periodStart: "2026-02-01T00:00:00.000Z",
    organizationUsd: 0,
    users: [],
    bots: [],
  };
  const noLimits = { organizationUsd: null, perUserUsd: null, perBotUsd: null };
  api.policy.mockResolvedValue({
    loaded: false,
    version: null,
    hash: null,
    policy: null,
    spend,
    limits: noLimits,
    denied: [],
  });
  const empty = await show(<AdminPolicyPage />);
  expect(empty.host.textContent).toContain("Not loaded");
  expect(empty.host.querySelector('[data-testid="admin-policy-rules"]')).toBeNull();
  expect(empty.host.querySelector('[data-testid="admin-denied"]')).toBeNull();

  document.body.innerHTML = "";
  api.policy.mockResolvedValue({
    loaded: true,
    version: 1,
    hash: "0123456789abcdef",
    policy: {
      version: 1,
      models: { allowProviders: ["azure", "opencode"], allowUserConnections: false },
      budgets: { organizationUsd: 100 },
    },
    spend: {
      periodStart: "2026-02-01T00:00:00.000Z",
      organizationUsd: 120,
      users: [{ id: "u1", label: "mia@example.test", spentUsd: 5 }],
      bots: [{ id: "b1", label: "Reporter", spentUsd: 1 }],
    },
    limits: { organizationUsd: 100, perUserUsd: 10, perBotUsd: null },
    denied: [
      {
        id: "e1",
        createdAt: "2026-02-03T00:00:00.000Z",
        userEmail: "mia@example.test",
        rule: "budgets.organization",
        subject: "monthly-budget",
        surface: "run",
      },
    ],
  });
  const { host } = await show(<AdminPolicyPage />);
  const rules = host.querySelector('[data-testid="admin-policy-rules"]')?.textContent ?? "";
  expect(rules).toContain("models.allowProviders");
  expect(rules).toContain("azure, opencode");
  expect(rules).toContain("false");
  expect(rules).not.toContain("budgets");
  const spendText = host.querySelector('[data-testid="admin-spend"]')?.textContent ?? "";
  expect(spendText).toContain("$120 / $100");
  expect(spendText).toContain("$5 / $10");
  expect(spendText).toContain("$1");
  expect(host.querySelector('[data-testid="admin-denied"]')?.textContent).toContain(
    "budgets.organization",
  );
});

it("shows the audit log: empty, error, populated, and filters", async () => {
  api.audit.mockResolvedValue({ events: [], nextCursor: null });
  const empty = await show(<AdminAuditPage />);
  expect(empty.host.textContent).toContain("Nothing to show.");

  document.body.innerHTML = "";
  api.audit.mockRejectedValueOnce(new Error("Broken"));
  const failed = await show(<AdminAuditPage />);
  expect(failed.host.querySelector('[role="alert"]')?.textContent).toContain("Broken");

  document.body.innerHTML = "";
  api.audit.mockResolvedValue({
    events: [
      {
        id: "e1",
        type: "policy.denied",
        createdAt: "2026-02-03T00:00:00.000Z",
        userEmail: "mia@example.test",
        ip: "10.0.0.1",
        metadata: { rule: "tools.deny" },
      },
    ],
    nextCursor: null,
  });
  const { host } = await show(<AdminAuditPage />);
  const row = host.querySelector('[data-testid="admin-audit"] tbody tr')?.textContent ?? "";
  expect(row).toContain("policy.denied");
  expect(row).toContain("mia@example.test");
  expect(row).toContain("10.0.0.1 · rule: tools.deny");

  const select = host.querySelector('select[aria-label="Type"]') as HTMLSelectElement;
  await act(async () => {
    select.value = "auth.sign_in";
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await settle();
  expect(api.audit).toHaveBeenLastCalledWith({ limit: 50, type: "auth.sign_in" });
});

it("renders policy rules as section.rule rows without budgets", () => {
  expect(
    policyRows({
      version: 1,
      tools: { deny: ["computer.*"] },
      computers: {
        allowHostComputer: false,
        images: { allow: [{ digest: `sha256:${"a".repeat(64)}`, tag: "2026.11" }] },
        egress: { denyDomains: ["a.test", "b.test"] },
      },
      budgets: { perBotUsd: 3 },
    }),
  ).toEqual([
    { key: "tools.deny", value: "computer.*" },
    { key: "computers.allowHostComputer", value: "false" },
    { key: "computers.images.allow", value: `sha256:${"a".repeat(64)} 2026.11` },
    { key: "computers.egress.denyDomains", value: "a.test, b.test" },
  ]);
});

const fleetComputers = {
  computers: ["c1", "c2"].map((id, index) => ({
    id,
    kind: "docker",
    scope: "team",
    state: index === 0 ? "running" : "suspended",
    ownerName: "Mia",
    ownerEmail: "mia@example.test",
    spaceName: "Team space",
    bots: [{ id: `b${id}`, name: index === 0 ? "Reporter" : "Courier" }],
    image: null,
    isolation: null,
    inspection: "not_running",
    health: "unknown",
    runningSince: null,
    lastActivityAt: null,
  })),
  nextCursor: null,
};

it("starts hibernate or wake for the selected computers and shows the operation's progress", async () => {
  api.computers.mockResolvedValue(fleetComputers);
  api.operations.mockResolvedValue({ operations: [] });
  api.createOperation.mockResolvedValue({ id: "op1" });
  const { host } = await show(<AdminComputersPage />);
  // No operations yet: nothing about them is on the page, and hibernated reads as such.
  expect(host.querySelector('[data-testid="fleet-operations"]')).toBeNull();
  expect(host.textContent).toContain("Hibernated");
  expect(host.textContent).not.toContain("Wake");

  api.operations.mockResolvedValue({
    operations: [
      {
        id: "op1",
        kind: "hibernate",
        status: "running",
        createdAt: "2026-02-05T00:00:00.000Z",
        finishedAt: null,
        maxParallel: 3,
        haltAfterFailures: 2,
        counts: { succeeded: 1, running: 1 },
      },
    ],
  });
  api.operation.mockResolvedValue({
    ...(await api.operations()).operations[0],
    items: [
      {
        computerId: "c1",
        spaceName: "Team space",
        bots: ["Reporter"],
        status: "succeeded",
        outcome: "hibernated",
        finishedAt: "2026-02-05T00:01:00.000Z",
      },
      {
        computerId: "c2",
        spaceName: "Team space",
        bots: ["Courier"],
        status: "skipped_busy",
        outcome: "busy",
        finishedAt: "2026-02-05T00:01:00.000Z",
      },
    ],
  });
  await act(async () => {
    (host.querySelector('[aria-label="Reporter"] [role="checkbox"]') as HTMLElement).click();
  });
  await act(async () => {
    (host.querySelector('[aria-label="Courier"] [role="checkbox"]') as HTMLElement).click();
  });
  const hibernate = [...host.querySelectorAll("button")].find(
    (button) => button.textContent === "Hibernate",
  ) as HTMLButtonElement;
  expect(host.textContent).toContain("Wake");
  await act(async () => {
    hibernate.click();
  });
  await settle();
  expect(api.createOperation).toHaveBeenCalledWith({
    kind: "hibernate",
    computerIds: ["c1", "c2"],
  });
  const row = host.querySelector('[data-testid="fleet-operations"] tbody tr')?.textContent ?? "";
  for (const part of ["Hibernate", "Running", "1/2"]) expect(row).toContain(part);
  // The new operation opens with one outcome per computer.
  const items = [
    ...document.body.querySelectorAll('[data-testid="fleet-operation-items"] tbody tr'),
  ].map((item) => item.textContent ?? "");
  expect(items[0]).toContain("Reporter");
  expect(items[0]).toContain("Done");
  expect(items[1]).toContain("Courier");
  expect(items[1]).toContain("Busy");
});

it("reports a failure to start an operation and keeps the selection", async () => {
  api.computers.mockResolvedValue(fleetComputers);
  api.operations.mockResolvedValue({ operations: [] });
  api.createOperation.mockRejectedValue(new Error("nope"));
  const { host } = await show(<AdminComputersPage />);
  await act(async () => {
    (host.querySelector('[aria-label="Reporter"] [role="checkbox"]') as HTMLElement).click();
  });
  await act(async () => {
    (
      [...host.querySelectorAll("button")].find((b) => b.textContent === "Wake") as HTMLElement
    ).click();
  });
  await settle();
  expect(api.toastError).toHaveBeenCalledWith("nope");
  expect(host.textContent).toContain("Hibernate");
});

it("recreates the selected computers from an approved image and shows each outcome", async () => {
  const approved = `sha256:${"b".repeat(64)}`;
  api.computers.mockResolvedValue(fleetComputers);
  api.operations.mockResolvedValue({ operations: [] });
  api.createOperation.mockResolvedValue({ id: "op2" });
  api.policy.mockResolvedValue({
    policy: {
      version: 1,
      computers: { images: { allow: [{ digest: approved, tag: "2026.11" }] } },
    },
  });
  const { host } = await show(<AdminComputersPage />);
  expect(host.querySelector('select[aria-label="Image"]')).toBeNull();
  await act(async () => {
    (host.querySelector('[aria-label="Reporter"] [role="checkbox"]') as HTMLElement).click();
  });
  await settle();
  const picker = host.querySelector('select[aria-label="Image"]') as HTMLSelectElement;
  expect([...picker.options].map((option) => option.textContent)).toEqual(["Default", "2026.11"]);
  await act(async () => {
    picker.value = approved;
    picker.dispatchEvent(new Event("change", { bubbles: true }));
  });
  api.operations.mockResolvedValue({
    operations: [
      {
        id: "op2",
        kind: "recreate",
        imageDigest: approved,
        status: "completed_with_failures",
        createdAt: "2026-02-05T00:00:00.000Z",
        finishedAt: "2026-02-05T00:02:00.000Z",
        maxParallel: 3,
        haltAfterFailures: 2,
        counts: { succeeded: 1, failed: 1 },
      },
    ],
  });
  api.operation.mockResolvedValue({
    ...(await api.operations()).operations[0],
    items: [
      {
        computerId: "c1",
        spaceName: "Team space",
        bots: ["Reporter"],
        status: "succeeded",
        outcome: "recreated",
        imageDigestBefore: `sha256:${"a".repeat(64)}`,
        imageDigestAfter: approved,
        homeRevisionBefore: "r1",
        homeRevisionAfter: "r2",
        finishedAt: "2026-02-05T00:01:00.000Z",
      },
      {
        computerId: "c2",
        spaceName: "Team space",
        bots: ["Courier"],
        status: "failed",
        outcome: "failed_checkpoint",
        imageDigestBefore: null,
        imageDigestAfter: null,
        homeRevisionBefore: null,
        homeRevisionAfter: null,
        finishedAt: "2026-02-05T00:01:00.000Z",
      },
    ],
  });
  await act(async () => {
    (
      [...host.querySelectorAll("button")].find((b) => b.textContent === "Recreate") as HTMLElement
    ).click();
  });
  await settle();
  expect(api.createOperation).toHaveBeenCalledWith({
    kind: "recreate",
    computerIds: ["c1"],
    imageDigest: approved,
  });
  const items = [
    ...document.body.querySelectorAll('[data-testid="fleet-operation-items"] tbody tr'),
  ].map((item) => item.textContent ?? "");
  expect(items[0]).toContain("Done");
  expect(items[0]).toContain("b".repeat(12));
  expect(items[1]).toContain("Failed");
  expect(items[1]).toContain("Not saved, left running");
});

it("terminates the selected computers only after a confirmation", async () => {
  api.computers.mockResolvedValue(fleetComputers);
  api.operations.mockResolvedValue({ operations: [] });
  api.createOperation.mockResolvedValue({ id: "op3" });
  const { host } = await show(<AdminComputersPage />);
  await act(async () => {
    (host.querySelector('[aria-label="Reporter"] [role="checkbox"]') as HTMLElement).click();
  });
  await settle();
  const button = (name: string, root: ParentNode = host) =>
    [...root.querySelectorAll("button")].find((b) => b.textContent === name) as HTMLElement;
  await act(async () => {
    button("Terminate").click();
  });
  await settle();
  expect(document.body.textContent).toContain("Terminate 1 computer?");
  expect(api.createOperation).not.toHaveBeenCalled();
  await act(async () => {
    button("Cancel", document.body).click();
  });
  await settle();
  expect(api.createOperation).not.toHaveBeenCalled();
  await act(async () => {
    button("Terminate").click();
  });
  await settle();
  await act(async () => {
    const dialog = document.body.querySelector('[role="alertdialog"]') as HTMLElement;
    button("Terminate", dialog).click();
  });
  await settle();
  expect(api.createOperation).toHaveBeenCalledWith({ kind: "terminate", computerIds: ["c1"] });
});
