// @vitest-environment jsdom

import type { CalendarRange } from "@rakazo/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const rpc = vi.hoisted(() => ({
  calendar: { range: vi.fn() },
  routines: { update: vi.fn(), testRun: vi.fn() },
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

import { CalendarPage } from "./Calendar";

const now = new Date(2026, 2, 10, 12, 0);
const localAt = (day: number, hour: number) => new Date(2026, 2, day, hour, 0).toISOString();
const routine = {
  routineId: "routine-1",
  name: "Inbox sweep",
  botId: "bot-1",
  botName: "Maya",
  groupId: null,
  active: true,
  timezone: "UTC",
};
const empty: CalendarRange = {
  from: localAt(9, 0),
  to: localAt(16, 0),
  routines: [],
  unscheduled: [],
  upcoming: [],
  past: [],
  truncated: false,
};
const populated: CalendarRange = {
  ...empty,
  routines: [routine, { ...routine, routineId: "routine-2", name: "Weekly report", groupId: "g1" }],
  unscheduled: [{ ...routine, routineId: "routine-3", name: "On webhook", active: false }],
  upcoming: [{ routineId: "routine-1", at: localAt(11, 9) }],
  past: [
    {
      routineId: "routine-1",
      runId: "run-1",
      at: localAt(10, 9),
      outcome: "failed",
      messageId: "m1",
    },
    {
      routineId: "routine-2",
      runId: "run-2",
      at: localAt(9, 9),
      outcome: "success",
      messageId: null,
    },
    {
      routineId: "routine-1",
      runId: null,
      at: localAt(12, 9),
      outcome: "no_change",
      messageId: null,
    },
    {
      routineId: "routine-1",
      runId: "run-3",
      at: localAt(12, 10),
      outcome: "action_needed",
      messageId: null,
    },
    { routineId: "routine-2", runId: null, at: localAt(13, 9), outcome: "missed", messageId: null },
  ],
};

const mounted: Array<() => void> = [];
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"], now });
});
afterEach(() => {
  for (const cleanup of mounted.splice(0)) cleanup();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
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
          <CalendarPage />
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
  [...container.querySelectorAll("button")].find(
    (el) => el.textContent === name || el.getAttribute("aria-label") === name,
  );
const loaded = (container: HTMLElement) =>
  vi.waitFor(() => expect(container.querySelector('[data-testid="calendar"]')).not.toBeNull());

it("shows a loading state until the range arrives", async () => {
  rpc.calendar.range.mockReturnValue(new Promise(() => undefined));
  const container = await mount();
  expect(container.querySelector('[role="status"]')).not.toBeNull();
});

it("shows an empty state when there are no routines", async () => {
  rpc.calendar.range.mockResolvedValue(empty);
  const container = await mount();
  await vi.waitFor(() =>
    expect(container.querySelector('[data-testid="calendar-empty"]')).not.toBeNull(),
  );
});

it("shows the failure and loads again on request", async () => {
  rpc.calendar.range.mockRejectedValueOnce(new Error("Calendar unavailable"));
  const container = await mount();
  await vi.waitFor(() => expect(container.querySelector('[role="alert"]')).not.toBeNull());
  expect(container.textContent).toContain("Calendar unavailable");
  rpc.calendar.range.mockResolvedValue(empty);
  await act(async () => button(container, "Try again")?.click());
  await vi.waitFor(() =>
    expect(container.querySelector('[data-testid="calendar-empty"]')).not.toBeNull(),
  );
});

it("asks for the current week and places past and upcoming items on their days", async () => {
  rpc.calendar.range.mockResolvedValue(populated);
  const container = await mount();
  await loaded(container);
  // Monday 9 March to the next Monday, in local time.
  expect(rpc.calendar.range).toHaveBeenCalledWith(
    { from: localAt(9, 0), to: localAt(16, 0) },
    expect.anything(),
  );
  expect(container.querySelectorAll('[data-testid="calendar-past"]')).toHaveLength(5);
  expect(container.querySelectorAll('[data-testid="calendar-upcoming"]')).toHaveLength(1);
  expect(container.textContent).toContain("Failed");
  expect(container.textContent).toContain("Done");
  expect(container.textContent).toContain("No change");
  expect(container.textContent).toContain("Action needed");
  expect(container.textContent).toContain("Missed");
  const hrefs = [...container.querySelectorAll("a")].map((a) => a.getAttribute("href"));
  expect(hrefs).toContain("/app/bot-1?m=m1");
  expect(hrefs).toContain("/app/g/g1");
  const headings = [...container.querySelectorAll("h2")].map((h) => h.textContent);
  expect(headings).toHaveLength(8);
  expect(headings.at(-1)).toBe("Event-triggered");
  expect(container.textContent).toContain("On webhook");
});

it("moves to the next week and to a single day", async () => {
  rpc.calendar.range.mockResolvedValue(populated);
  const container = await mount();
  await loaded(container);
  await act(async () => button(container, "Next")?.click());
  await vi.waitFor(() =>
    expect(rpc.calendar.range).toHaveBeenCalledWith(
      { from: localAt(16, 0), to: localAt(23, 0) },
      expect.anything(),
    ),
  );
  await act(async () => button(container, "Day")?.click());
  await vi.waitFor(() =>
    expect(rpc.calendar.range).toHaveBeenCalledWith(
      { from: localAt(17, 0), to: localAt(18, 0) },
      expect.anything(),
    ),
  );
});
