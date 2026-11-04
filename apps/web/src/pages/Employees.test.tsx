// @vitest-environment jsdom

import type { EmployeeDirectoryEntry } from "@rakazo/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";

const rpc = vi.hoisted(() => ({
  employees: {
    directory: vi.fn(),
    addInstance: vi.fn(),
    requests: { create: vi.fn() },
  },
}));
vi.mock("../lib/rpc", () => ({
  rpc,
  rpcForSpace: () => rpc,
  createSpaceRpc: () => rpc,
  selectedSpaceId: () => null,
}));
vi.mock("@lingui/react/macro", () => {
  const t = (parts: TemplateStringsArray) => parts.join("");
  return { useLingui: () => ({ t }), Trans: ({ children }: { children: ReactNode }) => children };
});
vi.mock("./WindowChrome", () => ({ WindowChrome: () => null }));
vi.mock("../components/PageLoading", () => ({
  PageLoading: () => <div role="status">Loading…</div>,
}));

import { EmployeesPage } from "./Employees";

const entry = (overrides: Partial<EmployeeDirectoryEntry>): EmployeeDirectoryEntry => ({
  id: "e1",
  name: "Ada",
  description: "Answers invoices",
  ownerName: "Ola Owner",
  role: null,
  canUse: false,
  requested: false,
  ...overrides,
});

const mounted: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of mounted.splice(0)) cleanup();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

function Where() {
  return <p data-testid="where">{useLocation().pathname}</p>;
}

async function mount() {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={["/app/employees"]}>
          <Routes>
            <Route path="/app/employees" element={<EmployeesPage />} />
            <Route path="*" element={<Where />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    ),
  );
  mounted.push(() => {
    act(() => root.unmount());
    container.remove();
  });
  return container;
}

const button = (container: HTMLElement, name: string) =>
  [...container.querySelectorAll("button")].find((el) => el.textContent === name);
const click = (element: Element | undefined) =>
  act(async () => {
    (element as HTMLElement).click();
  });

it("shows a loading state until the directory arrives", async () => {
  rpc.employees.directory.mockReturnValue(new Promise(() => undefined));
  const container = await mount();
  expect(container.querySelector('[role="status"]')).not.toBeNull();
});

it("shows an empty state", async () => {
  rpc.employees.directory.mockResolvedValue([]);
  const container = await mount();
  await vi.waitFor(() =>
    expect(container.querySelector('[data-testid="employees-empty"]')).not.toBeNull(),
  );
});

it("shows the error and retries", async () => {
  rpc.employees.directory.mockRejectedValueOnce(new Error("Shared employees are not turned on"));
  rpc.employees.directory.mockResolvedValue([]);
  const container = await mount();
  await vi.waitFor(() =>
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      "Shared employees are not turned on",
    ),
  );
  await click(button(container, "Try again"));
  await vi.waitFor(() =>
    expect(container.querySelector('[data-testid="employees-empty"]')).not.toBeNull(),
  );
});

it("offers one action per access state", async () => {
  rpc.employees.directory.mockResolvedValue([
    entry({ id: "mine", name: "Mine", role: "collaborator", canUse: true }),
    entry({ id: "open", name: "Open" }),
    entry({ id: "asked", name: "Asked", requested: true }),
    entry({ id: "view", name: "Viewer only", role: "viewer" }),
  ]);
  const container = await mount();
  await vi.waitFor(() =>
    expect(container.querySelector('[data-testid="employees"]')).not.toBeNull(),
  );
  const row = (id: string) =>
    container.querySelector<HTMLElement>(`[data-testid="employee-${id}"]`)!;
  expect(row("mine").textContent).toContain("Ola Owner");
  expect(row("mine").textContent).toContain("Answers invoices");
  expect([...row("mine").querySelectorAll("button")].map((b) => b.textContent)).toEqual(["Add"]);
  expect([...row("open").querySelectorAll("button")].map((b) => b.textContent)).toEqual([
    "Request access",
  ]);
  const asked = [...row("asked").querySelectorAll("button")];
  expect(asked.map((b) => b.textContent)).toEqual(["Requested"]);
  expect(asked[0]!.disabled).toBe(true);
  expect(row("view").querySelectorAll("button")).toHaveLength(0);
});

it("adds an instance and opens it", async () => {
  rpc.employees.directory.mockResolvedValue([entry({ role: "owner", canUse: true })]);
  rpc.employees.addInstance.mockResolvedValue({ botId: "bot-9", created: true });
  const container = await mount();
  await vi.waitFor(() => expect(button(container, "Add")).toBeDefined());
  await click(button(container, "Add"));
  expect(rpc.employees.addInstance).toHaveBeenCalledWith({ employeeId: "e1" });
  await vi.waitFor(() =>
    expect(container.querySelector('[data-testid="where"]')?.textContent).toBe("/app/bot-9"),
  );
});

it("requests access, then shows it as requested", async () => {
  rpc.employees.directory.mockResolvedValueOnce([entry({})]);
  rpc.employees.directory.mockResolvedValue([entry({ requested: true })]);
  rpc.employees.requests.create.mockResolvedValue({ ok: true });
  const container = await mount();
  await vi.waitFor(() => expect(button(container, "Request access")).toBeDefined());
  await click(button(container, "Request access"));
  expect(rpc.employees.requests.create).toHaveBeenCalledWith({ employeeId: "e1" });
  await vi.waitFor(() => expect(button(container, "Requested")).toBeDefined());
});

it("shows a refused action without leaving the page", async () => {
  rpc.employees.directory.mockResolvedValue([entry({ role: "owner", canUse: true })]);
  rpc.employees.addInstance.mockRejectedValue(new Error("Shared employees are not turned on"));
  const container = await mount();
  await vi.waitFor(() => expect(button(container, "Add")).toBeDefined());
  await click(button(container, "Add"));
  await vi.waitFor(() =>
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("not turned on"),
  );
  expect(container.querySelector('[data-testid="where"]')).toBeNull();
});
