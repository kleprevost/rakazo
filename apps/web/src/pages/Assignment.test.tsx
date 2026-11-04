// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  assignments: {
    get: vi.fn(),
    list: vi.fn(),
    cancel: vi.fn(),
    archive: vi.fn(),
    unarchive: vi.fn(),
  },
  bots: { list: vi.fn() },
  threads: { get: vi.fn(), head: vi.fn(), subscribe: vi.fn(), messages: vi.fn() },
}));
vi.mock("../lib/rpc", () => ({
  rpc: api,
  rpcForSpace: () => api,
  createSpaceRpc: () => api,
  selectedSpaceId: () => null,
}));
vi.mock("../lib/auth", () => ({
  authClient: { useSession: () => ({ data: { user: { id: "user-1" } } }) },
}));
vi.mock("../lib/relative-time", () => ({ formatRelativeTime: () => "5m ago" }));
vi.mock("./WindowChrome", () => ({ WindowChrome: () => null }));
vi.mock("./shell/transcript", () => ({
  Transcript: (props: { running: boolean; transcript: { messages: unknown[] } }) => (
    <div data-testid="transcript" data-running={String(props.running)} />
  ),
}));
vi.mock("./shell/composer", () => ({
  Composer: (props: { running: boolean; draftKey: string }) => (
    <div data-testid="composer" data-running={String(props.running)} data-draft={props.draftKey} />
  ),
}));
vi.mock("@rakazo/ui-web", async (importOriginal) => {
  const original = await importOriginal<typeof import("@rakazo/ui-web")>();
  const Container = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  return {
    ...original,
    DropdownMenu: Container,
    DropdownMenuContent: Container,
    DropdownMenuTrigger: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
    DropdownMenuItem: ({ children, onClick }: { children?: ReactNode; onClick?: () => void }) => (
      <button type="button" onClick={onClick}>
        {children}
      </button>
    ),
  };
});
vi.mock("@lingui/react/macro", () => {
  const t = (parts: TemplateStringsArray, ...values: unknown[]) =>
    parts.reduce((text, part, index) => text + part + String(values[index] ?? ""), "");
  return { useLingui: () => ({ t }), Trans: ({ children }: { children: ReactNode }) => children };
});

import { AssignmentPage } from "./Assignment";

const now = "2026-11-01T10:00:00.000Z";
const run = (id: string, status: string, trigger = "tickets") => ({
  id,
  status,
  trigger,
  error: null,
  threadId: "thread-2",
  createdAt: now,
  completedAt: null,
});
function assignment(runs: ReturnType<typeof run>[], overrides: Record<string, unknown> = {}) {
  return {
    id: "assignment-1",
    botId: "bot-1",
    threadId: "thread-2",
    ticketId: "ticket-1",
    title: "Plan the offsite",
    phase: "running",
    cancelledAt: null,
    archivedAt: null,
    createdAt: now,
    updatedAt: now,
    runs,
    artifacts: [
      {
        id: "artifact-1",
        name: "agenda.md",
        mimeType: "text/markdown",
        version: 1,
        runId: "run-1",
        createdAt: now,
      },
    ],
    ...overrides,
  };
}

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  api.threads.get.mockReset().mockResolvedValue({
    threadId: "thread-2",
    botId: "bot-1",
    cursor: 3,
    messages: [],
    olderCursor: null,
    run: null,
    activeRuns: [],
  });
  api.threads.head.mockReset().mockResolvedValue({ threadId: "thread-2", cursor: 3 });
  api.threads.subscribe.mockReset().mockResolvedValue({
    [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => {}) }),
  });
  api.bots.list.mockReset().mockResolvedValue([{ id: "bot-1", name: "Maya", color: "ink" }]);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

async function open(work: ReturnType<typeof assignment>) {
  api.assignments.get.mockReset().mockResolvedValue(work);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={["/app/a/assignment-1"]}>
          <Routes>
            <Route path="/app/a/:assignmentId" element={<AssignmentPage />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    ),
  );
  await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
}

it("opens an assignment with its own conversation, status, runs and files", async () => {
  await open(assignment([run("run-1", "running")]));
  expect(container.querySelector("h1")?.textContent).toBe("Plan the offsite");
  expect(api.threads.get).toHaveBeenCalledWith({ assignmentId: "assignment-1" }, expect.anything());
  expect(container.querySelector('[data-testid="transcript"]')).not.toBeNull();
  expect(container.querySelector('[data-testid="composer"]')?.getAttribute("data-draft")).toBe(
    "assignment:assignment-1",
  );
  const status = container.querySelector('[data-testid="assignment-status"]');
  expect(status?.textContent).toContain("Running");
  const hrefs = [...container.querySelectorAll("a")].map((a) => a.getAttribute("href"));
  expect(hrefs).toContain("/app/artifacts/artifact-1");
  expect(hrefs).toContain("/app/bot-1");
});

it("lists a ticket's run as work in progress even though the chat snapshot omits it", async () => {
  await open(assignment([run("run-1", "running", "tickets")]));
  expect(container.querySelector('[data-testid="composer"]')?.getAttribute("data-running")).toBe(
    "true",
  );
  expect(container.querySelector('[data-testid="transcript"]')?.getAttribute("data-running")).toBe(
    "true",
  );
});

it("reads as Queued while the employee's computer is held by another job", async () => {
  await open(assignment([run("run-2", "queued")]));
  expect(container.querySelector('[data-testid="assignment-status"]')?.textContent).toContain(
    "Queued",
  );
});

it("shows the refusal instead of an empty page for an assignment that is not yours", async () => {
  api.assignments.get.mockReset().mockRejectedValue(new Error("Not found"));
  api.threads.get.mockReset().mockRejectedValue(new Error("Not found"));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={["/app/a/assignment-9"]}>
          <Routes>
            <Route path="/app/a/:assignmentId" element={<AssignmentPage />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    ),
  );
  await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
  expect(container.querySelector('[role="alert"]')).not.toBeNull();
});

function menuItem(label: string) {
  return [...container.querySelectorAll("button")].find((node) => node.textContent === label);
}

it("offers Cancel while the job works and calls the assignment's own cancel", async () => {
  api.assignments.cancel.mockReset().mockResolvedValue({});
  await open(assignment([run("run-1", "running")]));
  expect(menuItem("Archive")).toBeUndefined();
  await act(async () => menuItem("Cancel")!.click());
  expect(api.assignments.cancel).toHaveBeenCalledWith({ assignmentId: "assignment-1" });
});

it("offers Archive for a finished job and Restore for an archived one", async () => {
  api.assignments.archive.mockReset().mockResolvedValue({});
  await open(assignment([run("run-1", "completed")], { phase: "done" }));
  expect(menuItem("Cancel")).toBeUndefined();
  await act(async () => menuItem("Archive")!.click());
  expect(api.assignments.archive).toHaveBeenCalledWith({ assignmentId: "assignment-1" });

  await act(async () => root.unmount());
  root = createRoot(container);
  api.assignments.unarchive.mockReset().mockResolvedValue({});
  await open(
    assignment([run("run-1", "completed")], { phase: "done", archivedAt: "2026-11-02T10:00:00Z" }),
  );
  expect(container.querySelector('[data-testid="assignment-status"]')?.textContent).toContain(
    "Archived",
  );
  expect(menuItem("Archive")).toBeUndefined();
  await act(async () => menuItem("Restore")!.click());
  expect(api.assignments.unarchive).toHaveBeenCalledWith({ assignmentId: "assignment-1" });
});

it("shows why an archive was refused", async () => {
  api.assignments.archive
    .mockReset()
    .mockRejectedValue(new Error("Stop the job before archiving it."));
  await open(assignment([run("run-1", "completed")], { phase: "done" }));
  await act(async () => menuItem("Archive")!.click());
  expect(container.querySelector('[role="alert"]')?.textContent).toContain("Stop the job");
});
