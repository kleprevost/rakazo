import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { withRunGates } from "./testing/run-gates.js";
import type { TicketChange } from "./ticket-changes.js";
import { createTicketChangeNotifier } from "./ticket-changes.js";

const change: TicketChange = {
  spaceId: "space-1",
  boardId: "board-1",
  ticketId: "ticket-1",
  assigneeBotId: "bot-1",
  wakeAssignee: true,
};
function setup(
  ticketBoardEnabled: boolean,
  status = "todo",
  existing: { id: string; botId: string; threadId: string } | null = null,
) {
  const notify = vi.fn(async () => {});
  const enqueue = vi.fn(async () => {});
  const createRun = vi.fn(async () => ({ id: "run-1" }));
  const createTask = vi.fn(async () => ({ id: "task-1" }));
  const createThread = vi.fn(async () => ({ id: "assignment-thread" }));
  const createAssignment = vi.fn(async ({ data }: { data: { threadId: string } }) => ({
    id: "assignment-new",
    botId: "bot-1",
    threadId: data.threadId,
  }));
  const updateAssignment = vi.fn(async () => ({}));
  const tx = withRunGates({
    ticket: {
      findFirst: vi.fn(async () => ({
        id: "ticket-1",
        title: "Fix the thing",
        status,
        number: 1,
        board: { ticketPrefix: "RAK" },
      })),
      update: vi.fn(async () => ({})),
    },
    bot: {
      findFirst: vi.fn(async () => ({ id: "bot-1", userId: "user-1", employeeId: null })),
    },
    thread: { create: createThread },
    assignment: {
      findUnique: vi.fn(async () => existing),
      create: createAssignment,
      update: updateAssignment,
    },
    task: { create: createTask },
    run: { create: createRun },
  });
  const transaction = vi.fn(async (fn: (client: typeof tx) => Promise<unknown>) => fn(tx));
  const changes = createTicketChangeNotifier({
    ticketBoardEnabled,
    prisma: { $transaction: transaction } as unknown as PrismaClient,
    jobs: { enqueue } as never,
    boardEvents: { notify } as never,
  });
  return {
    changes,
    notify,
    enqueue,
    createRun,
    createTask,
    transaction,
    createThread,
    createAssignment,
    updateAssignment,
  };
}

describe("ticket changes", () => {
  it("does nothing when disabled, including creation and assignment", async () => {
    const s = setup(false);
    await s.changes(change);
    expect(s.notify).not.toHaveBeenCalled();
    expect(s.transaction).not.toHaveBeenCalled();
    expect(s.enqueue).not.toHaveBeenCalled();
  });
  it.each(["todo", "doing", "review", "blocked"])(
    "wakes an assigned %s ticket once using a hidden run",
    async (status) => {
      const s = setup(true, status);
      await s.changes(change);
      expect(s.createRun).toHaveBeenCalledTimes(1);
      expect(s.createRun).toHaveBeenCalledWith({
        data: expect.objectContaining({ trigger: "tickets", status: "queued" }),
      });
      expect(s.enqueue).toHaveBeenCalledTimes(1);
      expect(s.enqueue).toHaveBeenCalledWith(
        expect.objectContaining({ name: "run.continue", payload: { runId: "run-1" } }),
      );
      expect(s.notify).toHaveBeenCalledWith("space-1", {
        boardId: "board-1",
        ticketId: "ticket-1",
      });
    },
  );
  it.each(["done", "closed", "cancelled"])(
    "does not wake a reassigned %s ticket",
    async (status) => {
      const s = setup(true, status);
      await s.changes(change);
      expect(s.notify).toHaveBeenCalledTimes(1);
      expect(s.createTask).not.toHaveBeenCalled();
      expect(s.createRun).not.toHaveBeenCalled();
      expect(s.enqueue).not.toHaveBeenCalled();
    },
  );
  it("only publishes changes for comments or status edits", async () => {
    const s = setup(true);
    await s.changes({ ...change, wakeAssignee: false });
    expect(s.notify).toHaveBeenCalledTimes(1);
    expect(s.transaction).not.toHaveBeenCalled();
    expect(s.enqueue).not.toHaveBeenCalled();
  });
  it("does not wake an unassigned ticket", async () => {
    const s = setup(true);
    await s.changes({ ...change, assigneeBotId: null });
    expect(s.transaction).not.toHaveBeenCalled();
  });
  it("runs a ticket's first wake in a new assignment thread, not the employee's chat", async () => {
    const s = setup(true);
    await s.changes(change);
    expect(s.createThread).toHaveBeenCalledWith({
      data: { spaceId: "space-1", userId: "user-1" },
      select: { id: true },
    });
    expect(s.createAssignment).toHaveBeenCalledWith({
      data: expect.objectContaining({
        botId: "bot-1",
        ticketId: "ticket-1",
        threadId: "assignment-thread",
        title: "Fix the thing",
      }),
    });
    expect(s.createTask).toHaveBeenCalledWith({
      data: expect.objectContaining({ threadId: "assignment-thread", ticketId: "ticket-1" }),
    });
    expect(s.createRun).toHaveBeenCalledWith({
      data: expect.objectContaining({ threadId: "assignment-thread", trigger: "tickets" }),
    });
  });
  it("wakes again in the ticket's existing assignment thread", async () => {
    const s = setup(true, "doing", { id: "a-1", botId: "bot-1", threadId: "a-thread" });
    await s.changes(change);
    expect(s.createThread).not.toHaveBeenCalled();
    expect(s.createAssignment).not.toHaveBeenCalled();
    expect(s.createRun).toHaveBeenCalledWith({
      data: expect.objectContaining({ threadId: "a-thread" }),
    });
  });
  it("detaches a reassigned ticket's earlier assignment and starts a new one", async () => {
    const s = setup(true, "doing", { id: "a-old", botId: "bot-2", threadId: "old-thread" });
    await s.changes(change);
    expect(s.updateAssignment).toHaveBeenCalledWith({
      where: { id: "a-old" },
      data: { ticketId: null },
    });
    expect(s.createRun).toHaveBeenCalledWith({
      data: expect.objectContaining({ threadId: "assignment-thread" }),
    });
  });
});
