// @vitest-environment jsdom

import type { TodaySummary } from "@rakazo/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";

const rpc = vi.hoisted(() => ({
  today: { summary: vi.fn() },
  threads: { answer: vi.fn() },
  routines: { testRun: vi.fn() },
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

import { TodayPage } from "./Today";

const bot = { botId: "bot-1", botName: "Maya", groupId: null };
const at = new Date().toISOString();
const empty: TodaySummary = {
  generatedAt: at,
  counts: { working: 0, waiting: 0, attention: 0, completed: 0 },
  attention: [],
  active: [],
  completed: [],
  upcoming: [],
  work: [],
};
const populated: TodaySummary = {
  generatedAt: at,
  counts: { working: 1, waiting: 1, attention: 3, completed: 1 },
  attention: [
    {
      ...bot,
      kind: "approval",
      key: "ask:m1",
      runId: "run-ask",
      title: "Email",
      at,
      messageId: "m1",
      text: "Send the email to Dana?",
      actions: [
        { id: "allow", label: "Allow once" },
        { id: "deny", label: "Deny" },
      ],
    },
    {
      ...bot,
      kind: "question",
      key: "ask:m2",
      runId: "run-q",
      title: "Plan",
      at,
      messageId: "m2",
      text: "Which region?",
    },
    {
      ...bot,
      botId: "bot-2",
      botName: "Scout",
      groupId: "group-1",
      kind: "failed_routine",
      key: "failed:run-f",
      runId: "run-f",
      title: "Inbox sweep",
      at,
      routineId: "routine-1",
      error: "504: request timed out",
    },
  ],
  active: [
    {
      ...bot,
      runId: "run-w",
      status: "running",
      trigger: "user",
      title: "Summarize the inbox",
      routineId: null,
      at,
      artifacts: [],
    },
  ],
  completed: [
    {
      ...bot,
      runId: "run-d",
      status: "completed",
      trigger: "routine",
      title: "Weekly report",
      routineId: "routine-2",
      at,
      artifacts: [{ id: "artifact-1", name: "report.pdf", mimeType: "application/pdf" }],
    },
  ],
  upcoming: [
    {
      ...bot,
      routineId: "routine-3",
      name: "Morning brief",
      nextRunAt: "2026-03-11T08:00:00.000Z",
    },
  ],
  work: [
    { id: "t1", ref: "RAK-1", title: "Draft the board deck", phase: "running", ...bot, at },
    {
      id: "t2",
      ref: "RAK-2",
      title: "Audit vendor list",
      phase: "review",
      botId: null,
      botName: null,
      at,
    },
  ],
};

const mounted: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of mounted.splice(0)) cleanup();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

async function mount() {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <TodayPage />
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

it("shows a loading state until the summary arrives", async () => {
  rpc.today.summary.mockReturnValue(new Promise(() => undefined));
  const container = await mount();
  expect(container.querySelector('[role="status"]')).not.toBeNull();
  expect(container.querySelector('[data-testid="today"]')).toBeNull();
});

it("shows an empty state when nothing happened", async () => {
  rpc.today.summary.mockResolvedValue(empty);
  const container = await mount();
  await vi.waitFor(() =>
    expect(container.querySelector('[data-testid="today-empty"]')).not.toBeNull(),
  );
});

it("shows the failure and loads again on request", async () => {
  rpc.today.summary.mockRejectedValueOnce(new Error("Summary unavailable"));
  const container = await mount();
  await vi.waitFor(() => expect(container.querySelector('[role="alert"]')).not.toBeNull());
  expect(container.textContent).toContain("Summary unavailable");
  rpc.today.summary.mockResolvedValue(empty);
  await act(async () => button(container, "Try again")?.click());
  await vi.waitFor(() =>
    expect(container.querySelector('[data-testid="today-empty"]')).not.toBeNull(),
  );
});

it("lists every section with links to the work behind each row", async () => {
  rpc.today.summary.mockResolvedValue(populated);
  const container = await mount();
  await vi.waitFor(() => expect(container.querySelector('[data-testid="today"]')).not.toBeNull());
  const headings = [...container.querySelectorAll("h2")].map((h) => h.textContent);
  expect(headings).toEqual([
    "Needs attention 3",
    "Working 1",
    "Running 1",
    "In review 1",
    "Done 1",
    "Coming up 1",
  ]);
  const hrefs = [...container.querySelectorAll("a")].map((a) => a.getAttribute("href"));
  expect(hrefs).toContain("/app/bot-1");
  expect(hrefs).toContain("/app/g/group-1");
  expect(hrefs).toContain("/app/artifacts/artifact-1");
  expect(hrefs).toContain("/app/board?ticket=t1");
  expect(container.textContent).toContain("Draft the board deck");
  expect(container.textContent).toContain("Send the email to Dana?");
  expect(container.textContent).toContain("504: request timed out");
});

it("answers an approval through the existing thread procedure and refreshes", async () => {
  rpc.today.summary.mockResolvedValue(populated);
  rpc.threads.answer.mockResolvedValue({ ok: true });
  const container = await mount();
  await vi.waitFor(() => expect(button(container, "Deny")).toBeDefined());
  await act(async () => button(container, "Deny")?.click());
  expect(rpc.threads.answer).toHaveBeenCalledWith({
    botId: "bot-1",
    runId: "run-ask",
    messageId: "m1",
    answer: "deny",
  });
  await vi.waitFor(() => expect(rpc.today.summary).toHaveBeenCalledTimes(2));
});

it("retries a failed routine with a stable nonce and reports a refusal", async () => {
  rpc.today.summary.mockResolvedValue(populated);
  rpc.routines.testRun.mockRejectedValueOnce(new Error("Routines are paused"));
  const container = await mount();
  await vi.waitFor(() => expect(button(container, "Retry")).toBeDefined());
  await act(async () => button(container, "Retry")?.click());
  expect(rpc.routines.testRun).toHaveBeenCalledWith({
    routineId: "routine-1",
    clientNonce: "today-retry:run-f",
  });
  await vi.waitFor(() => expect(container.textContent).toContain("Routines are paused"));
});
