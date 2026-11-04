// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  reviews: vi.fn(),
  review: vi.fn(),
  catalog: vi.fn(),
  decide: vi.fn(),
  publish: vi.fn(),
  unpublish: vi.fn(),
  rollback: vi.fn(),
}));

vi.mock("../../lib/rpc", () => ({
  rpc: {
    skillPublishing: {
      review: { decide: api.decide },
      publish: api.publish,
      unpublish: api.unpublish,
      rollback: api.rollback,
    },
  },
}));
vi.mock("../../lib/query", () => {
  const plain = (name: string, call: (input?: unknown) => unknown) => ({
    queryOptions: (options?: { input?: unknown }) => ({
      queryKey: [name, JSON.stringify(options?.input ?? null)],
      queryFn: () => call(options?.input),
    }),
    key: () => [name],
  });
  const queries = {
    me: plain("me", () => ({ isAdmin: true, adminRoles: ["platform"] })),
    admin: { overview: plain("overview", () => ({})) },
    skillPublishing: {
      review: { list: plain("reviews", () => api.reviews()), get: plain("review", api.review) },
      catalog: plain("catalog", () => api.catalog()),
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

import { AdminSkillsPage } from "./AdminSkillsPage";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const v = (id: string, number: number) => ({
  id,
  skillId: "s1",
  number,
  status: "approved",
  name: "Export",
  description: "",
  submittedAt: "2026-01-01T00:00:00.000Z",
  decidedAt: null,
  reason: null,
});

async function show() {
  const host = document.createElement("div");
  document.body.append(host);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () =>
    createRoot(host).render(
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <AdminSkillsPage />
        </MemoryRouter>
      </QueryClientProvider>,
    ),
  );
  await settle();
  await settle();
  await settle();
  return host;
}
const settle = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
const button = (host: HTMLElement, label: string) =>
  [...host.querySelectorAll("button")].find((el) => el.textContent === label);

beforeEach(() => {
  document.body.innerHTML = "";
  for (const fn of Object.values(api)) fn.mockReset();
  api.reviews.mockResolvedValue([
    {
      versionId: "v2",
      skillId: "s1",
      number: 2,
      name: "Export",
      authorName: "Ann",
      submittedAt: "2026-01-01T00:00:00.000Z",
    },
  ]);
  api.review.mockResolvedValue({
    version: {},
    authorName: "Ann",
    previousNumber: 1,
    diff: [
      {
        field: "steps",
        lines: [
          { op: "same", text: "Open the CRM" },
          { op: "add", text: "Filter to this week" },
          { op: "remove", text: "Drop it anywhere" },
        ],
      },
    ],
  });
  api.catalog.mockResolvedValue([
    {
      id: "s1",
      name: "Export",
      versions: [v("v1", 1), v("v2", 2)],
      audiences: [{ id: "a1", kind: "claim", value: "pilot", versionId: "v2", versionNumber: 2 }],
    },
  ]);
  api.decide.mockResolvedValue({ ok: true });
  api.rollback.mockResolvedValue({ moved: 1 });
  api.publish.mockResolvedValue({});
});

it("shows the diff of a waiting version and approves it", async () => {
  const host = await show();
  await act(async () => (host.querySelector("[aria-expanded]") as HTMLElement).click());
  await settle();
  await settle();
  const diff = host.querySelector("[data-testid=skill-diff]")!;
  expect(diff.textContent).toContain("+ Filter to this week");
  expect(diff.textContent).toContain("- Drop it anywhere");
  await act(async () => button(host, "Approve")!.click());
  expect(api.decide).toHaveBeenCalledWith({ versionId: "v2", decision: "approve" });
});

it("lists audiences with their pinned version and rolls back", async () => {
  const host = await show();
  const skill = host.querySelector("[data-testid=published-skill]")!;
  expect(skill.textContent).toContain("pilot");
  const rollback = skill.querySelectorAll("select")[1] as HTMLSelectElement;
  await act(async () => {
    rollback.value = "v1";
    rollback.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await act(async () => button(host, "Roll back")!.click());
  expect(api.rollback).toHaveBeenCalledWith({ skillId: "s1", versionId: "v1" });
  await act(async () => button(host, "Remove")!.click());
  expect(api.unpublish).toHaveBeenCalledWith({ audienceId: "a1" });
});
