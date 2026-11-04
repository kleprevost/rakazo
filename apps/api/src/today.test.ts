import type { Actor } from "@rakazo/contracts";
import { TodaySummarySchema } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { todaySummary } from "./today.js";

const actor: Actor = {
  userId: "user-1",
  spaceId: "space-1",
  email: "user@rakazo.test",
  isDeploymentOwner: false,
};
const now = new Date("2026-03-10T12:00:00Z");
const at = (minutesAgo: number) => new Date(now.getTime() - minutesAgo * 60_000);

function runRow(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    botId: "bot-1",
    threadId: `thread-${id}`,
    status: "running",
    trigger: "user",
    routineId: null,
    error: null,
    createdAt: at(30),
    updatedAt: at(5),
    completedAt: null,
    bot: { name: "Maya" },
    task: { prompt: "Summarize   the\ninbox" },
    routine: null,
    sourceMessage: null,
    thread: { groupId: null },
    ...overrides,
  };
}

function fixture() {
  const runs = vi.fn(async (_args: { where: Record<string, unknown> }) => [] as unknown[]);
  const messages = vi.fn(async (_args: unknown) => [] as unknown[]);
  const artifacts = vi.fn(async (_args: unknown) => [] as unknown[]);
  const routines = vi.fn(async (_args: unknown) => [] as unknown[]);
  const tickets = vi.fn(async (_args: { where: Record<string, unknown> }) => [] as unknown[]);
  const tasks = vi.fn(async (_args: unknown) => [] as unknown[]);
  const bots = vi.fn(async (_args: { where: Record<string, unknown> }) => [] as unknown[]);
  const receipts = vi.fn(async (_args: { where: Record<string, unknown> }) => [] as unknown[]);
  const assignments = vi.fn(
    async (_args: { where: Record<string, unknown> }) =>
      [] as Array<{ id: string; ticketId: string | null }>,
  );
  const prisma = {
    assignment: { findMany: assignments },
    routineReceipt: { findMany: receipts },
    board: { findUnique: vi.fn(async () => ({ id: "board-1", ticketPrefix: "RAK" })) },
    ticket: { findMany: tickets },
    task: { findMany: tasks },
    bot: { findMany: bots },
    run: { findMany: runs },
    message: { findMany: messages },
    artifact: { findMany: artifacts },
    routine: { findMany: routines },
  } as unknown as PrismaClient;
  /** Answers the active, completed, failed and superseding-run reads by their filters. */
  const byStatus = (rows: { active?: unknown[]; completed?: unknown[]; failed?: unknown[] }) =>
    runs.mockImplementation(async ({ where }) => {
      const status = where.status as unknown;
      if (status === "completed") return rows.completed ?? [];
      if (status === "failed") return rows.failed ?? [];
      if (typeof status === "object" && status && "in" in status) {
        const list = (status as { in: string[] }).in;
        return list.includes("running") && !list.includes("completed") ? (rows.active ?? []) : [];
      }
      return [];
    });
  return {
    prisma,
    receipts,
    runs,
    messages,
    artifacts,
    routines,
    tickets,
    tasks,
    bots,
    assignments,
    byStatus,
  };
}

const approvalBlock = {
  kind: "ask",
  text: "Send the email to Dana?",
  approvalEffectId: "effect-1",
  status: "pending",
  actions: [
    { id: "allow", label: "Allow once" },
    { id: "always", label: "Always allow this tool" },
    { id: "deny", label: "Deny" },
  ],
};

describe("today summary", () => {
  it("returns an empty, valid summary when nothing has happened", async () => {
    const { prisma } = fixture();
    const summary = await todaySummary(prisma, actor, now);
    expect(TodaySummarySchema.parse(summary)).toEqual(summary);
    expect(summary.counts).toEqual({ working: 0, waiting: 0, attention: 0, completed: 0 });
    expect(summary.attention).toEqual([]);
  });

  it("scopes every read to the actor's space and user and hides archived bots", async () => {
    const { prisma, runs, artifacts, routines, byStatus } = fixture();
    byStatus({ completed: [runRow("done", { status: "completed", completedAt: at(10) })] });
    await todaySummary(prisma, actor, now);
    for (const [args] of runs.mock.calls) {
      expect(args.where).toMatchObject({ spaceId: "space-1", userId: "user-1" });
    }
    const runReads = runs.mock.calls.filter(([args]) => args.where.bot);
    expect(runReads).toHaveLength(3);
    for (const [args] of runReads) {
      expect(args.where).toMatchObject({
        bot: { archivedAt: null },
        trigger: { notIn: ["tickets"] },
      });
    }
    expect(artifacts).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ spaceId: "space-1", userId: "user-1" }),
      }),
    );
    expect(routines).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          spaceId: "space-1",
          userId: "user-1",
          active: true,
          bot: { archivedAt: null },
        }),
      }),
    );
  });

  it("splits active runs into working and waiting and surfaces an approval without quick actions", async () => {
    const { prisma, messages, byStatus } = fixture();
    byStatus({
      active: [
        runRow("working", { status: "running" }),
        runRow("approve", { status: "waiting_input", thread: { groupId: "group-1" } }),
        runRow("takeover", { status: "waiting_takeover" }),
      ],
    });
    messages.mockResolvedValue([
      {
        id: "message-1",
        runId: "approve",
        threadId: "thread-approve",
        blocks: [{ kind: "text", text: "Drafting" }, approvalBlock],
      },
    ]);
    const summary = await todaySummary(prisma, actor, now);
    expect(TodaySummarySchema.parse(summary)).toEqual(summary);
    expect(summary.counts).toMatchObject({ working: 1, waiting: 2, attention: 1 });
    expect(summary.active.map((run) => run.runId)).toEqual(["working", "approve", "takeover"]);
    expect(summary.attention).toEqual([
      expect.objectContaining({
        kind: "approval",
        runId: "approve",
        groupId: "group-1",
        messageId: "message-1",
        text: "Send the email to Dana?",
      }),
    ]);
    // The clipped text is a preview; Today carries nothing to decide with.
    expect(summary.attention[0]).not.toHaveProperty("actions");
  });

  it("names the assignment of a run that works in one, for its row and its approval", async () => {
    const { prisma, messages, byStatus } = fixture();
    const thread = { groupId: null, assignment: { id: "assignment-1" } };
    byStatus({
      active: [
        runRow("working", { thread }),
        runRow("approve", { status: "waiting_input", thread }),
        runRow("chat"),
      ],
    });
    messages.mockResolvedValue([
      {
        id: "message-1",
        runId: "approve",
        threadId: "thread-approve",
        blocks: [approvalBlock],
      },
    ]);
    const summary = await todaySummary(prisma, actor, now);
    expect(TodaySummarySchema.parse(summary)).toEqual(summary);
    expect(summary.active.map((run) => run.assignmentId)).toEqual([
      "assignment-1",
      "assignment-1",
      null,
    ]);
    expect(summary.attention[0]).toMatchObject({ kind: "approval", assignmentId: "assignment-1" });
  });

  it("clips a long approval to a preview and keeps it an approval", async () => {
    const { prisma, messages, byStatus } = fixture();
    byStatus({ active: [runRow("approve", { status: "waiting_input" })] });
    messages.mockResolvedValue([
      {
        id: "message-1",
        runId: "approve",
        threadId: "thread-approve",
        blocks: [{ ...approvalBlock, text: `Send to ${"x".repeat(400)}` }],
      },
    ]);
    const summary = await todaySummary(prisma, actor, now);
    expect(summary.attention[0]).toMatchObject({ kind: "approval", messageId: "message-1" });
    expect((summary.attention[0] as { text: string }).text).toHaveLength(300);
  });

  it("treats secret requests, plain questions and answered asks conservatively", async () => {
    const { prisma, messages, byStatus } = fixture();
    byStatus({
      active: ["secret", "question", "answered", "other-thread"].map((id) =>
        runRow(id, { status: "waiting_input" }),
      ),
    });
    messages.mockResolvedValue([
      {
        id: "m-secret",
        runId: "secret",
        threadId: "thread-secret",
        blocks: [{ ...approvalBlock, input: "secret", purpose: "api_key" }],
      },
      {
        id: "m-question",
        runId: "question",
        threadId: "thread-question",
        blocks: [{ kind: "ask", text: "Which   region?", status: "pending" }],
      },
      {
        id: "m-answered",
        runId: "answered",
        threadId: "thread-answered",
        blocks: [{ ...approvalBlock, status: "answered", answer: "allow" }],
      },
      // A message that names the run but lives in another thread is not this run's ask.
      { id: "m-other", runId: "other-thread", threadId: "elsewhere", blocks: [approvalBlock] },
    ]);
    const summary = await todaySummary(prisma, actor, now);
    expect(summary.attention.map((item) => [item.kind, item.runId])).toEqual([
      ["question", "secret"],
      ["question", "question"],
    ]);
    expect(summary.attention[1]).toMatchObject({ text: "Which region?" });
    expect(summary.attention[0]).not.toHaveProperty("actions");
  });

  it("lists failures once per routine and drops ones a newer run has superseded", async () => {
    const { prisma, runs, byStatus } = fixture();
    const failed = (id: string, extra: Record<string, unknown>) =>
      runRow(id, {
        status: "failed",
        error: "504: request timed out",
        completedAt: at(20),
        ...extra,
      });
    byStatus({
      failed: [
        failed("f-new", {
          routineId: "routine-1",
          routine: { name: "Inbox sweep" },
          createdAt: at(10),
        }),
        failed("f-old", {
          routineId: "routine-1",
          routine: { name: "Inbox sweep" },
          createdAt: at(90),
        }),
        failed("f-fixed", {
          routineId: "routine-2",
          routine: { name: "Digest" },
          createdAt: at(60),
        }),
        failed("f-chat", { threadId: "chat-1", createdAt: at(40) }),
      ],
    });
    const original = runs.getMockImplementation();
    runs.mockImplementation(async (args) => {
      if ("OR" in args.where) return [{ routineId: "routine-2", threadId: "t", createdAt: at(30) }];
      return original?.(args) ?? [];
    });
    const summary = await todaySummary(prisma, actor, now);
    expect(summary.attention.map((item) => [item.kind, item.runId])).toEqual([
      ["failed_routine", "f-new"],
      ["failed_run", "f-chat"],
    ]);
    expect(summary.attention[0]).toMatchObject({
      routineId: "routine-1",
      title: "Inbox sweep",
      error: "504: request timed out",
    });
    const supersede = runs.mock.calls.find(([args]) => "OR" in args.where)?.[0].where;
    expect(supersede).toMatchObject({ spaceId: "space-1", userId: "user-1" });
  });

  it("shows finished routine work and anything with a deliverable, not plain chat replies", async () => {
    const { prisma, artifacts, byStatus } = fixture();
    byStatus({
      completed: [
        runRow("chat", { status: "completed", completedAt: at(5) }),
        runRow("routine", {
          status: "completed",
          trigger: "routine",
          routine: { name: "Weekly report" },
          completedAt: at(15),
        }),
        runRow("report", { status: "completed", completedAt: at(25) }),
      ],
    });
    artifacts.mockResolvedValue([
      { id: "artifact-1", runId: "report", name: "report.pdf", mimeType: "application/pdf" },
    ]);
    const summary = await todaySummary(prisma, actor, now);
    expect(summary.completed.map((run) => run.runId)).toEqual(["routine", "report"]);
    expect(summary.completed[0]?.title).toBe("Weekly report");
    expect(summary.completed[1]).toMatchObject({
      title: "Summarize the inbox",
      artifacts: [{ id: "artifact-1", name: "report.pdf", mimeType: "application/pdf" }],
    });
    expect(summary.counts.completed).toBe(2);
  });

  it("keeps quiet routine runs out of Done and shows check failures and misses as exceptions", async () => {
    const { prisma, receipts, byStatus } = fixture();
    byStatus({
      completed: [
        runRow("quiet", {
          status: "completed",
          trigger: "routine",
          routine: { name: "Inbox watch" },
          completedAt: at(5),
        }),
        runRow("news", {
          status: "completed",
          trigger: "routine",
          routine: { name: "Inbox watch" },
          completedAt: at(15),
        }),
      ],
    });
    const receipt = (id: string, routineId: string, outcome: string, minutesAgo: number) => ({
      id,
      routineId,
      botId: "bot-1",
      runId: null,
      outcome,
      detail: outcome === "failed" ? "gmail failed: 503" : null,
      scheduledFor: at(minutesAgo),
      routine: { name: routineId, bot: { name: "Maya" }, thread: null },
    });
    receipts.mockImplementation(async ({ where }) => {
      if (where.outcome === "no_change") return [{ runId: "quiet" }];
      const outcomes = (where.outcome as { in: string[] }).in;
      if (outcomes.includes("failed"))
        return [
          receipt("r1", "outage", "failed", 10),
          receipt("r2", "outage", "missed", 40),
          receipt("r3", "skipped", "missed", 20),
          receipt("r4", "recovered", "failed", 60),
        ];
      // A clean check after the failure clears it; a clean check before it does not.
      return [
        { routineId: "recovered", scheduledFor: at(30) },
        { routineId: "outage", scheduledFor: at(90) },
      ];
    });
    const summary = await todaySummary(prisma, actor, now);
    expect(TodaySummarySchema.parse(summary)).toEqual(summary);
    expect(summary.completed.map((run) => run.runId)).toEqual(["news"]);
    expect(summary.attention.map((item) => item.kind)).toEqual([
      "routine_exception",
      "routine_exception",
    ]);
    expect(summary.attention).toMatchObject([
      { routineId: "outage", outcome: "failed", error: "gmail failed: 503" },
      { routineId: "skipped", outcome: "missed", error: null },
    ]);
  });

  it("lists upcoming routine runs", async () => {
    const { prisma, routines } = fixture();
    routines.mockResolvedValue([
      {
        id: "routine-1",
        botId: "bot-1",
        name: "Morning brief",
        nextRunAt: new Date("2026-03-11T08:00:00Z"),
        bot: { name: "Maya" },
        thread: null,
      },
    ]);
    const summary = await todaySummary(prisma, actor, now);
    expect(summary.upcoming).toEqual([
      {
        botId: "bot-1",
        botName: "Maya",
        groupId: null,
        routineId: "routine-1",
        name: "Morning brief",
        nextRunAt: "2026-03-11T08:00:00.000Z",
      },
    ]);
  });

  describe("assignments", () => {
    const ticketRow = (id: string, number: number, overrides: Record<string, unknown> = {}) => ({
      id,
      boardId: "board-1",
      spaceId: "space-1",
      number,
      title: `Ticket ${number}`,
      description: null,
      status: "doing",
      priority: null,
      assigneeBotId: "bot-1",
      createdByBotId: null,
      createdByUserId: "user-1",
      createdAt: at(120),
      updatedAt: at(number),
      completedAt: null,
      ...overrides,
    });

    it("stays off unless the ticket board is on", async () => {
      const { prisma, tickets } = fixture();
      const summary = await todaySummary(prisma, actor, now);
      expect(summary.work).toEqual([]);
      expect(tickets).not.toHaveBeenCalled();
    });

    it("asks only for open tickets the user created or whose assignee is the user's bot", async () => {
      const { prisma, tickets, bots } = fixture();
      await todaySummary(prisma, actor, now, { workItems: true });
      const where = tickets.mock.calls[0]?.[0].where;
      expect(where).toMatchObject({
        spaceId: "space-1",
        OR: [
          { createdByUserId: "user-1" },
          { assigneeBot: { userId: "user-1", spaceId: "space-1" } },
        ],
        status: { notIn: ["done", "closed"] },
      });
      expect(bots).not.toHaveBeenCalled();
    });

    it("groups open work by phase and never names another user's bot", async () => {
      const { prisma, tickets, tasks, bots, assignments } = fixture();
      assignments.mockResolvedValue([{ id: "assignment-1", ticketId: "t1" }]);
      tickets.mockResolvedValue([
        ticketRow("t1", 1),
        ticketRow("t2", 2, { assigneeBotId: "bot-other", status: "review" }),
        ticketRow("t3", 3, { status: "todo" }),
        ticketRow("t4", 4, { status: "blocked" }),
      ]);
      tasks.mockResolvedValue([
        { ticketId: "t1", runs: [{ status: "failed", createdAt: at(10) }] },
      ]);
      // The bot lookup is scoped to the actor, so a colleague's bot never comes back.
      bots.mockImplementation(async ({ where }) => {
        expect(where).toMatchObject({ spaceId: "space-1", userId: "user-1" });
        return [{ id: "bot-1", name: "Maya" }];
      });
      const summary = await todaySummary(prisma, actor, now, { workItems: true });
      expect(TodaySummarySchema.parse(summary)).toEqual(summary);
      expect(summary.work.map((item) => [item.ref, item.phase, item.botName])).toEqual([
        ["RAK-1", "failed", "Maya"],
        ["RAK-2", "review", null],
        ["RAK-4", "waiting", "Maya"],
      ]);
      expect(summary.work[1]?.botId).toBeNull();
      // Only the ticket with an assignment of the user's own links to it.
      expect(summary.work.map((item) => item.assignmentId)).toEqual(["assignment-1", null, null]);
      expect(assignments.mock.calls[0]?.[0].where).toMatchObject({
        spaceId: "space-1",
        userId: "user-1",
      });
    });
  });
});
