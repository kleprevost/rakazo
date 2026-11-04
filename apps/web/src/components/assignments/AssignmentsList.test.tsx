// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({ assignments: { list: vi.fn() } }));
vi.mock("../../lib/rpc", () => ({
  rpc: api,
  rpcForSpace: () => api,
  createSpaceRpc: () => api,
  selectedSpaceId: () => null,
}));
vi.mock("../../lib/relative-time", () => ({ formatRelativeTime: () => "5m ago" }));
vi.mock("@lingui/react/macro", () => {
  const t = (parts: TemplateStringsArray, ...values: unknown[]) =>
    parts.reduce((text, part, index) => text + part + String(values[index] ?? ""), "");
  return { useLingui: () => ({ t }), Trans: ({ children }: { children: ReactNode }) => children };
});

import { AssignmentsList } from "./AssignmentsList";

const item = (id: string, title: string, archivedAt: string | null = null) => ({
  id,
  botId: "bot-1",
  threadId: `thread-${id}`,
  ticketId: null,
  title,
  phase: "running",
  cancelledAt: null,
  archivedAt,
  createdAt: "2026-11-01T10:00:00.000Z",
  updatedAt: "2026-11-01T10:00:00.000Z",
});

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  api.assignments.list.mockReset().mockImplementation(async (input: { state: string }) => ({
    items:
      input.state === "archived"
        ? [item("a3", "Old invoice", "2026-11-02T10:00:00.000Z")]
        : [item("a1", "Plan the offsite"), item("a2", "Draft the invoice")],
    nextCursor: null,
  }));
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

const settle = () => act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
const hrefs = () => [...container.querySelectorAll("a")].map((a) => a.getAttribute("href"));
const button = (label: string) =>
  [...container.querySelectorAll("button")].find((node) => node.textContent === label);

it("lists the employee's assignments, each opening its own page, and reaches the archived ones", async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <AssignmentsList botId="bot-1" />
        </MemoryRouter>
      </QueryClientProvider>,
    ),
  );
  await settle();
  expect(hrefs()).toEqual(["/app/a/a1", "/app/a/a2"]);
  expect(api.assignments.list).toHaveBeenCalledWith(
    expect.objectContaining({ botId: "bot-1", state: "active" }),
    expect.anything(),
  );

  await act(async () => button("Archived")!.click());
  await settle();
  expect(hrefs()).toEqual(["/app/a/a3"]);
  await act(async () => button("Active")!.click());
  await settle();
  expect(hrefs()).toEqual(["/app/a/a1", "/app/a/a2"]);
});

it("shows no way into archived jobs when there are none", async () => {
  api.assignments.list.mockImplementation(async (input: { state: string }) => ({
    items: input.state === "archived" ? [] : [item("a1", "Plan the offsite")],
    nextCursor: null,
  }));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <AssignmentsList botId="bot-1" />
        </MemoryRouter>
      </QueryClientProvider>,
    ),
  );
  await settle();
  expect(button("Archived")).toBeUndefined();
});
