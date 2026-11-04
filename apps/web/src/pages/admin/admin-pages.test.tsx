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
      quarantine: { list: plain("quarantines", () => api.quarantines()) },
      computers: { list: paged("computers", (input) => api.computers(input)) },
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
  ])
    expect(rows[0]).toContain(part);
  for (const part of ["Courier", "e2b", "Stopped", "Not reported"]) expect(rows[1]).toContain(part);
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
      computers: { allowHostComputer: false, egress: { denyDomains: ["a.test", "b.test"] } },
      budgets: { perBotUsd: 3 },
    }),
  ).toEqual([
    { key: "tools.deny", value: "computer.*" },
    { key: "computers.allowHostComputer", value: "false" },
    { key: "computers.egress.denyDomains", value: "a.test, b.test" },
  ]);
});
