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

const bot = { botId: "bot-1", botName: "Maya", groupId: null, assignmentId: null };
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
    },
    {
      ...bot,
      kind: "question",
      assignmentId: "assignment-1",
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
      assignmentId: "assignment-1",
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
  // An attention row and a work row of one assignment open the same page, not the chat or board.
  expect(hrefs).toContain("/app/a/assignment-1");
  expect(hrefs).not.toContain("/app/board?ticket=t2");
  expect(container.textContent).toContain("Draft the board deck");
  expect(container.textContent).toContain("Send the email to Dana?");
  expect(container.textContent).toContain("504: request timed out");
});

it("lists a run waiting on the user under Needs attention, never under Working", async () => {
  const waitingRun = (runId: string, status: "waiting_input" | "waiting_takeover") => ({
    ...bot,
    runId,
    status,
    trigger: "user" as const,
    title: `Paused ${runId}`,
    routineId: null,
    at,
    artifacts: [],
  });
  rpc.today.summary.mockResolvedValue({
    ...populated,
    counts: { ...populated.counts, attention: 1 },
    attention: populated.attention.slice(0, 1),
    active: [
      ...populated.active,
      waitingRun("run-ask", "waiting_input"),
      waitingRun("run-takeover", "waiting_takeover"),
    ],
  });
  const container = await mount();
  await vi.waitFor(() => expect(container.querySelector('[data-testid="today"]')).not.toBeNull());
  const section = (title: string) =>
    [...container.querySelectorAll("section")].find((el) =>
      el.querySelector("h2")?.textContent?.startsWith(title),
    );
  const working = section("Working");
  expect(working?.textContent).toContain("Summarize the inbox");
  expect(working?.textContent).not.toContain("Paused");
  // The run with a card is listed once, as its card; the takeover has none and joins the section.
  const attention = section("Needs attention");
  expect(attention?.querySelector("h2")?.textContent).toBe("Needs attention 2");
  expect(attention?.textContent).toContain("Paused run-takeover");
  expect(attention?.textContent).not.toContain("Paused run-ask");
});

it("lists a failed check and a missed run as exceptions that open the chat", async () => {
  const exception = {
    ...bot,
    kind: "routine_exception" as const,
    runId: null,
    routineId: "routine-9",
    at,
    error: null,
  };
  rpc.today.summary.mockResolvedValue({
    ...empty,
    counts: { ...empty.counts, attention: 2 },
    attention: [
      { ...exception, key: "receipt:r1", title: "Release watch", outcome: "failed", error: "503" },
      { ...exception, key: "receipt:r2", title: "Weekly report", outcome: "missed" },
    ],
  });
  const container = await mount();
  await vi.waitFor(() => expect(container.querySelector('[data-testid="today"]')).not.toBeNull());
  expect(container.textContent).toContain("503");
  expect(container.textContent).toContain("Weekly report · Missed");
  expect(container.querySelectorAll("button")).toHaveLength(0);
});

it("never offers a decision for an approval, only a way into its chat", async () => {
  rpc.today.summary.mockResolvedValue(populated);
  const container = await mount();
  await vi.waitFor(() => expect(container.textContent).toContain("Send the email to Dana?"));
  expect(button(container, "Allow")).toBeUndefined();
  expect(button(container, "Deny")).toBeUndefined();
  const open = [...container.querySelectorAll("a")].find((a) => a.textContent === "Open");
  expect(open?.getAttribute("href")).toBe("/app/bot-1");
  expect(rpc.threads.answer).not.toHaveBeenCalled();
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
