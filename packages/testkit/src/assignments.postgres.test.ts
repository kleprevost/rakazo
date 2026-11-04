import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ComposioConnector, FakeComposioClient } from "@rakazo/adapters";
import type { createApp } from "@rakazo/api/app";
import { ACTIVE_RUN_STATUSES } from "@rakazo/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { BotIntroHarness } from "./discard-bot-intro.js";
import { discardBotIntroFromCreate } from "./discard-bot-intro.js";
import { sessionCookieHeader } from "./index.js";
import { asSystem } from "./system-db.js";

process.env.WAKEUP_DRIVER = "memory";
process.env.SANDBOX_PROVIDER = "fake";
process.env.AGENT_RUNTIME = "scripted";

type App = { request: (input: string, init?: RequestInit) => Response | Promise<Response> };
type Snap = {
  threadId: string;
  messages: Array<{ id: string; blocks: Array<{ kind?: string; text?: string }> }>;
  run: { id: string; status: string } | null;
};
type Created = { id: string; botId: string; threadId: string; ticketId: string | null };

const hasDb = process.env.VERIFY_DATABASE === "1" && Boolean(process.env.DATABASE_URL);
const describeWithDatabase = hasDb ? describe : describe.skip;
const HANG = "keep working until I stop you";
const ASK = "ask me which city to use";
let harness: BotIntroHarness | undefined;

describeWithDatabase("independent assignments on one employee", () => {
  let handles: Awaited<ReturnType<typeof createApp>>;
  let app: App;
  let db: Awaited<ReturnType<typeof createApp>>["prisma"];
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const dataDir = mkdtempSync(path.join(tmpdir(), "rakazo-assignments-"));
  let cookie: string;
  let botId: string;
  let primaryThreadId: string;

  beforeAll(async () => {
    const { createApp } = await import("@rakazo/api/app");
    handles = await createApp({
      databaseUrl: process.env.DATABASE_URL!,
      encryptionKey: "offline-assignments-encryption-key",
      dataDir,
      sandboxProvider: "fake",
      agentRuntime: "scripted",
      wakeupDriver: "memory",
      signupsEnabled: "true",
      ticketBoardEnabled: true,
      composio: new ComposioConnector({ client: new FakeComposioClient() }),
    });
    app = handles.app;
    db = asSystem(handles.prisma);
    harness = handles;
    cookie = await signup(app, `assign-${stamp}@rakazo.test`);
    const bot = await rpc<{ id: string }>(app, cookie, "bots/create", {
      name: "Chief",
      title: "",
      description: "",
      instructions: "",
      notifyOnFinish: false,
    });
    botId = bot.id;
    primaryThreadId = (await db.thread.findFirstOrThrow({ where: { botId } })).id;
    // The employee's introduction runs in the primary chat first.
    await until(
      async () =>
        (await db.run.count({ where: { botId, status: { in: [...ACTIVE_RUN_STATUSES] } } })) === 0,
    );
  });

  afterAll(async () => {
    await handles?.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  const create = (brief: string, nonce = `${brief}-${Math.random()}`) =>
    rpc<Created>(app, cookie, "assignments/create", {
      botId,
      title: brief.slice(0, 40),
      brief,
      clientNonce: nonce,
    });
  const runsOf = (assignment: Created) =>
    db.run.findMany({ where: { threadId: assignment.threadId }, orderBy: { createdAt: "asc" } });
  const statusOf = async (assignment: Created) => (await runsOf(assignment)).at(-1)?.status;
  const text = (snap: Snap) => JSON.stringify(snap.messages);

  it("starts two jobs on one employee at once, each in its own thread", async () => {
    const a = await create(HANG);
    const b = await create(HANG);
    expect(a.threadId).not.toBe(b.threadId);
    expect([a.threadId, b.threadId]).not.toContain(primaryThreadId);
    await until(
      async () =>
        ACTIVE_RUN_STATUSES.includes((await statusOf(a)) as never) &&
        ACTIVE_RUN_STATUSES.includes((await statusOf(b)) as never),
    );
    const runA = (await runsOf(a))[0]!;
    const runB = (await runsOf(b))[0]!;
    expect(runA.threadId).toBe(a.threadId);
    expect(runB.threadId).toBe(b.threadId);
    expect(runA.botId).toBe(botId);
    expect(runB.botId).toBe(botId);
    await rpc(app, cookie, "threads/stop", { assignmentId: a.id });
    await rpc(app, cookie, "threads/stop", { assignmentId: b.id });
  });

  it("keeps a message to one job out of the other job and the employee's chat", async () => {
    const a = await create(HANG);
    const b = await create(HANG);
    await until(async () => ACTIVE_RUN_STATUSES.includes((await statusOf(a)) as never));
    await rpc(app, cookie, "threads/send", {
      assignmentId: a.id,
      text: "only-for-the-first-job",
      clientNonce: `m-${stamp}`,
    });
    const inA = await rpc<Snap>(app, cookie, "threads/get", { assignmentId: a.id });
    const inB = await rpc<Snap>(app, cookie, "threads/get", { assignmentId: b.id });
    const primary = await rpc<Snap>(app, cookie, "threads/get", { botId });
    expect(inA.threadId).toBe(a.threadId);
    expect(text(inA)).toContain("only-for-the-first-job");
    expect(text(inB)).not.toContain("only-for-the-first-job");
    expect(text(primary)).not.toContain("only-for-the-first-job");
    expect(text(primary)).not.toContain(HANG);
    // The steering row belongs to the first job's message and thread only.
    const steered = await db.steeringMessage.findMany({
      where: { message: { threadId: { in: [b.threadId, primaryThreadId] } } },
    });
    expect(steered).toEqual([]);
    await rpc(app, cookie, "threads/stop", { assignmentId: a.id });
    await rpc(app, cookie, "threads/stop", { assignmentId: b.id });
  });

  it("waits on one job's question without touching the other, and answering resumes only it", async () => {
    const asking = await create(ASK);
    const working = await create(HANG);
    await until(async () => (await statusOf(asking)) === "waiting_input");
    expect(ACTIVE_RUN_STATUSES.includes((await statusOf(working)) as never)).toBe(true);

    const waiting = await rpc<Snap>(app, cookie, "threads/get", { assignmentId: asking.id });
    const card = waiting.messages.find((message) =>
      message.blocks.some((block) => block.kind === "ask"),
    );
    expect(card).toBeTruthy();
    const runId = (await runsOf(asking))[0]!.id;
    // The other job cannot answer it: the run is not in that thread.
    const wrong = await raw(app, cookie, "threads/answer", {
      assignmentId: working.id,
      runId,
      messageId: card!.id,
      answer: "Paris",
    });
    expect(wrong.status).toBeGreaterThanOrEqual(400);
    expect(await statusOf(asking)).toBe("waiting_input");

    await rpc(app, cookie, "threads/answer", {
      assignmentId: asking.id,
      runId,
      messageId: card!.id,
      answer: "Paris",
    });
    await until(async () => (await statusOf(asking)) === "completed");
    expect(ACTIVE_RUN_STATUSES.includes((await statusOf(working)) as never)).toBe(true);
    await rpc(app, cookie, "threads/stop", { assignmentId: working.id });
  });

  it("stops one job and leaves the other running", async () => {
    const a = await create(HANG);
    const b = await create(HANG);
    await until(
      async () =>
        ACTIVE_RUN_STATUSES.includes((await statusOf(a)) as never) &&
        ACTIVE_RUN_STATUSES.includes((await statusOf(b)) as never),
    );
    await rpc(app, cookie, "threads/stop", { assignmentId: a.id });
    await until(async () => (await statusOf(a)) === "cancelled");
    expect(ACTIVE_RUN_STATUSES.includes((await statusOf(b)) as never)).toBe(true);
    await rpc(app, cookie, "threads/stop", { assignmentId: b.id });
  });

  it("returns the first job for a repeated create with the same nonce", async () => {
    const first = await create("say hello", `repeat-${stamp}`);
    const again = await create("say hello", `repeat-${stamp}`);
    expect(again.id).toBe(first.id);
    expect(again.threadId).toBe(first.threadId);
    await until(async () => (await statusOf(first)) === "completed");
    const runs = await runsOf(first);
    expect(runs).toHaveLength(1);
    expect(await db.assignment.count({ where: { clientNonce: `repeat-${stamp}` } })).toBe(1);
    const messages = await db.message.count({ where: { threadId: first.threadId, role: "user" } });
    expect(messages).toBe(1);
  });

  it("completes a job's run in its own thread and leaves the employee's chat working", async () => {
    const job = await create("say hello from the job");
    await until(async () => (await statusOf(job)) === "completed");
    const sent = await rpc<{ runId: string }>(app, cookie, "threads/send", {
      botId,
      text: "hello in the main chat",
    });
    await until(
      async () => (await db.run.findUnique({ where: { id: sent.runId } }))?.status === "completed",
    );
    const primary = await rpc<Snap>(app, cookie, "threads/get", { botId });
    expect(text(primary)).toContain("hello in the main chat");
    expect(text(primary)).not.toContain("say hello from the job");
    const work = await rpc<{ runs: Array<{ threadId: string }>; phase: string }>(
      app,
      cookie,
      "assignments/get",
      { assignmentId: job.id },
    );
    expect(work.runs.every((run) => run.threadId === job.threadId)).toBe(true);
    expect(work.phase).toBe("review");
  });

  it("shows another person nothing of the job", async () => {
    const mine = await create("say hello privately");
    const other = await signup(app, `assign-other-${stamp}@rakazo.test`);
    const listed = await rpc<{ items: Array<{ id: string }> }>(app, other, "assignments/list", {});
    expect(listed.items).toEqual([]);
    for (const [procedure, body] of [
      ["assignments/get", { assignmentId: mine.id }],
      ["threads/get", { assignmentId: mine.id }],
      ["threads/send", { assignmentId: mine.id, text: "intrude" }],
      ["threads/stop", { assignmentId: mine.id }],
    ] as const) {
      expect((await raw(app, other, procedure, body)).status).toBeGreaterThanOrEqual(400);
    }
    const mineList = await rpc<{ items: Array<{ id: string }> }>(app, cookie, "assignments/list", {
      botId,
    });
    expect(mineList.items.map((item) => item.id)).toContain(mine.id);
  });

  it("refuses a job for an employee that is not yours", async () => {
    const other = await signup(app, `assign-third-${stamp}@rakazo.test`);
    const res = await raw(app, other, "assignments/create", {
      botId,
      title: "x",
      brief: "say hello",
      clientNonce: `third-${stamp}`,
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(await db.assignment.count({ where: { clientNonce: `third-${stamp}` } })).toBe(0);
  });

  const steer = (
    assignment: Created,
    instruction: string,
    nonce = `${instruction}-${Math.random()}`,
  ) =>
    rpc<{ messageId: string; runId: string }>(app, cookie, "assignments/steer", {
      assignmentId: assignment.id,
      text: instruction,
      clientNonce: nonce,
    });
  const steeringFor = (assignment: Created) =>
    db.steeringMessage.findMany({ where: { message: { threadId: assignment.threadId } } });

  it("queues an instruction for one job only and leaves the other job's instructions intact", async () => {
    const a = await create(HANG);
    const b = await create(HANG);
    await until(
      async () =>
        ACTIVE_RUN_STATUSES.includes((await statusOf(a)) as never) &&
        ACTIVE_RUN_STATUSES.includes((await statusOf(b)) as never),
    );
    const runA = (await runsOf(a))[0]!.id;
    const runB = (await runsOf(b))[0]!.id;
    const forB = await steer(b, `for-b-${stamp}`);
    const forA = await steer(a, `for-a-${stamp}`);
    expect(forA.runId).toBe(runA);
    expect(forB.runId).toBe(runB);

    const rowsA = await steeringFor(a);
    const rowsB = await steeringFor(b);
    expect(rowsA.map((row) => row.messageId)).toEqual([forA.messageId]);
    expect(rowsB.map((row) => row.messageId)).toEqual([forB.messageId]);

    // Each instruction is in its own conversation only.
    const snapA = await rpc<Snap>(app, cookie, "threads/get", { assignmentId: a.id });
    const snapB = await rpc<Snap>(app, cookie, "threads/get", { assignmentId: b.id });
    const primary = await rpc<Snap>(app, cookie, "threads/get", { botId });
    expect(text(snapA)).toContain(`for-a-${stamp}`);
    expect(text(snapA)).not.toContain(`for-b-${stamp}`);
    expect(text(snapB)).toContain(`for-b-${stamp}`);
    expect(text(snapB)).not.toContain(`for-a-${stamp}`);
    expect(text(primary)).not.toContain(`for-a-${stamp}`);
    expect(text(primary)).not.toContain(`for-b-${stamp}`);

    // Stopping A does not drop B's instruction or end B's run.
    await rpc(app, cookie, "threads/stop", { assignmentId: a.id });
    await until(async () => (await statusOf(a)) === "cancelled");
    expect(ACTIVE_RUN_STATUSES.includes((await statusOf(b)) as never)).toBe(true);
    expect((await steeringFor(b)).map((row) => row.messageId)).toEqual([forB.messageId]);
    await rpc(app, cookie, "threads/stop", { assignmentId: b.id });
  });

  it("holds an instruction for a job waiting on a question until the question is answered", async () => {
    const asking = await create(ASK);
    await until(async () => (await statusOf(asking)) === "waiting_input");
    const runId = (await runsOf(asking))[0]!.id;
    const queued = await steer(asking, `also-weather-${stamp}`);
    expect(queued.runId).toBe(runId);
    // The text is not taken as the answer: the run still waits and the instruction is pending.
    expect(await statusOf(asking)).toBe("waiting_input");
    const [row] = await steeringFor(asking);
    expect(row).toMatchObject({ messageId: queued.messageId, runId, claimedAt: null });

    const waiting = await rpc<Snap>(app, cookie, "threads/get", { assignmentId: asking.id });
    const card = waiting.messages.find((message) =>
      message.blocks.some((block) => block.kind === "ask"),
    );
    await rpc(app, cookie, "threads/answer", {
      assignmentId: asking.id,
      runId,
      messageId: card!.id,
      answer: "Paris",
    });
    await until(
      async () =>
        !ACTIVE_RUN_STATUSES.includes((await statusOf(asking)) as never) &&
        (await db.steeringMessage.count({
          where: { message: { threadId: asking.threadId }, claimedAt: null },
        })) === 0,
    );
  });

  it("answers a repeated instruction with the first one", async () => {
    const job = await create(HANG);
    await until(async () => ACTIVE_RUN_STATUSES.includes((await statusOf(job)) as never));
    const first = await steer(job, "tighten the summary", `steer-${stamp}`);
    const again = await steer(job, "tighten the summary", `steer-${stamp}`);
    expect(again).toEqual(first);
    expect(await steeringFor(job)).toHaveLength(1);
    expect(
      await db.message.count({ where: { threadId: job.threadId, clientNonce: `steer-${stamp}` } }),
    ).toBe(1);
    await rpc(app, cookie, "threads/stop", { assignmentId: job.id });
  });

  it("starts one continuation when nothing is running, and refuses a stopped or archived job", async () => {
    const job = await create("say hello");
    await until(async () => (await statusOf(job)) === "completed");
    const queued = await steer(job, "now say goodbye");
    const run = await db.run.findUniqueOrThrow({ where: { id: queued.runId } });
    expect(run.threadId).toBe(job.threadId);
    expect(run.trigger).toBe("follow_up");
    expect(await db.run.count({ where: { threadId: primaryThreadId, id: run.id } })).toBe(0);
    await until(async () => (await statusOf(job)) === "completed");

    await db.assignment.update({ where: { id: job.id }, data: { archivedAt: new Date() } });
    const archived = await raw(app, cookie, "assignments/steer", {
      assignmentId: job.id,
      text: "again",
      clientNonce: `again-${stamp}`,
    });
    expect(archived.status).toBe(409);
    await db.assignment.update({
      where: { id: job.id },
      data: { archivedAt: null, cancelledAt: new Date() },
    });
    const stopped = await raw(app, cookie, "assignments/steer", {
      assignmentId: job.id,
      text: "again",
      clientNonce: `again2-${stamp}`,
    });
    expect(stopped.status).toBe(409);
  });

  it("refuses an instruction for another person's job", async () => {
    const job = await create(HANG);
    const other = await signup(app, `assign-steer-${stamp}@rakazo.test`);
    const res = await raw(app, other, "assignments/steer", {
      assignmentId: job.id,
      text: "take over",
      clientNonce: `other-${stamp}`,
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(await steeringFor(job)).toHaveLength(0);
    await rpc(app, cookie, "threads/stop", { assignmentId: job.id });
  });

  type Row = {
    id: string;
    phase: string;
    cancelledAt: string | null;
    archivedAt: string | null;
    runs?: Array<{ id: string; status: string }>;
    artifacts?: unknown[];
  };
  const get = (assignment: Created) =>
    rpc<Row>(app, cookie, "assignments/get", { assignmentId: assignment.id });
  const listed = async (state: "active" | "archived") =>
    (
      await rpc<{ items: Array<{ id: string }> }>(app, cookie, "assignments/list", {
        botId,
        state,
        limit: 100,
      })
    ).items.map((item) => item.id);
  const live = (assignment: Created) =>
    statusOf(assignment).then((status) => ACTIVE_RUN_STATUSES.includes(status as never));

  it("cancels one job's live runs and leaves the other job working", async () => {
    const a = await create(HANG);
    const b = await create(HANG);
    await until(async () => (await live(a)) && (await live(b)));
    const cancelled = await rpc<Row>(app, cookie, "assignments/cancel", { assignmentId: a.id });
    expect(cancelled.phase).toBe("cancelled");
    expect(cancelled.cancelledAt).not.toBeNull();
    await until(async () => (await statusOf(a)) === "cancelled");
    expect(await live(b)).toBe(true);
    expect((await get(b)).cancelledAt).toBeNull();

    // Two racing cancels end in one state: the first mark stays.
    const first = (await get(a)).cancelledAt;
    await Promise.all([
      rpc(app, cookie, "assignments/cancel", { assignmentId: a.id }),
      rpc(app, cookie, "assignments/cancel", { assignmentId: a.id }),
    ]);
    expect((await get(a)).cancelledAt).toBe(first);
    await rpc(app, cookie, "threads/stop", { assignmentId: b.id });
  });

  it("refuses to archive a job with a live run, then archives and restores it keeping its data", async () => {
    const job = await create(HANG);
    await until(() => live(job));
    const refused = await raw(app, cookie, "assignments/archive", { assignmentId: job.id });
    expect(refused.status).toBe(409);
    expect((await get(job)).archivedAt).toBeNull();

    await rpc(app, cookie, "assignments/cancel", { assignmentId: job.id });
    await until(async () => (await statusOf(job)) === "cancelled");
    expect(await listed("active")).toContain(job.id);

    const archived = await rpc<Row>(app, cookie, "assignments/archive", { assignmentId: job.id });
    expect(archived.archivedAt).not.toBeNull();
    expect(await listed("active")).not.toContain(job.id);
    expect(await listed("archived")).toContain(job.id);
    // Transcript, runs and files stay.
    const kept = await get(job);
    expect(kept.runs).toHaveLength(1);
    expect(text(await rpc<Snap>(app, cookie, "threads/get", { assignmentId: job.id }))).toContain(
      HANG,
    );

    // Two racing archives end in one state.
    await Promise.all([
      rpc(app, cookie, "assignments/archive", { assignmentId: job.id }),
      rpc(app, cookie, "assignments/archive", { assignmentId: job.id }),
    ]);
    expect((await get(job)).archivedAt).toBe(archived.archivedAt);

    const restored = await rpc<Row>(app, cookie, "assignments/unarchive", { assignmentId: job.id });
    expect(restored.archivedAt).toBeNull();
    expect(await listed("active")).toContain(job.id);
  });

  it("resumes a stopped job with a new run in the same thread", async () => {
    const job = await create(HANG);
    await until(() => live(job));
    await rpc(app, cookie, "assignments/cancel", { assignmentId: job.id });
    await until(async () => (await statusOf(job)) === "cancelled");
    const before = (await runsOf(job)).map((run) => run.id);

    const sent = await rpc<{ runId: string }>(app, cookie, "threads/send", {
      assignmentId: job.id,
      text: "say hello again",
      clientNonce: `resume-${stamp}`,
    });
    expect(before).not.toContain(sent.runId);
    const row = await db.run.findUniqueOrThrow({ where: { id: sent.runId } });
    expect(row.threadId).toBe(job.threadId);
    const resumed = await get(job);
    expect(resumed.cancelledAt).toBeNull();
    expect(resumed.runs?.map((run) => run.id)).toEqual(
      expect.arrayContaining([...before, sent.runId]),
    );
    await until(async () => (await statusOf(job)) === "completed");

    // A message to an archived job brings it back.
    await rpc(app, cookie, "assignments/archive", { assignmentId: job.id });
    await rpc(app, cookie, "threads/send", {
      assignmentId: job.id,
      text: "and once more",
      clientNonce: `resume2-${stamp}`,
    });
    expect((await get(job)).archivedAt).toBeNull();
    await until(async () => (await statusOf(job)) === "completed");
  });

  it("refuses to cancel or archive another person's job", async () => {
    const job = await create("say hello");
    const other = await signup(app, `assign-cancel-${stamp}@rakazo.test`);
    for (const action of ["cancel", "archive", "unarchive"]) {
      const res = await raw(app, other, `assignments/${action}`, { assignmentId: job.id });
      expect(res.status).toBeGreaterThanOrEqual(400);
    }
    const row = await get(job);
    expect(row.cancelledAt).toBeNull();
    expect(row.archivedAt).toBeNull();
  });

  it("wakes a ticket's employee in the ticket's own assignment, without the board needing a job first", async () => {
    const ticket = await rpc<{ id: string }>(app, cookie, "tickets/create", {
      title: "Tidy the notes",
      assigneeBotId: botId,
    });
    await until(async () => (await db.assignment.count({ where: { ticketId: ticket.id } })) === 1);
    const assignment = await db.assignment.findFirstOrThrow({ where: { ticketId: ticket.id } });
    expect(assignment.botId).toBe(botId);
    expect(assignment.threadId).not.toBe(primaryThreadId);
    await until(
      async () => (await db.run.count({ where: { threadId: assignment.threadId } })) >= 1,
    );
    const run = await db.run.findFirstOrThrow({ where: { threadId: assignment.threadId } });
    expect(run.trigger).toBe("tickets");
    expect(await db.run.count({ where: { threadId: primaryThreadId, trigger: "tickets" } })).toBe(
      0,
    );
    const work = await rpc<{ runs: Array<{ id: string }> }>(app, cookie, "tickets/work", {
      ticketId: ticket.id,
    });
    expect(work.runs.map((item) => item.id)).toContain(run.id);
    await rpc(app, cookie, "threads/stop", { assignmentId: assignment.id });
  });
});

async function signup(app: App, email: string) {
  const res = await app.request("/api/auth/sign-up/email", {
    method: "POST",
    headers: { "content-type": "application/json", origin: "http://127.0.0.1:5173" },
    body: JSON.stringify({ email, password: "password12", name: "Assign" }),
  });
  if (res.status >= 400) throw new Error(`signup failed ${res.status}: ${await res.text()}`);
  return sessionCookieHeader(res);
}

function raw(app: App, cookie: string, proc: string, body: unknown = {}) {
  return app.request(`/rpc/${proc}`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie, origin: "http://127.0.0.1:5173" },
    body: JSON.stringify({ json: body }),
  });
}

async function rpc<T>(app: App, cookie: string, proc: string, body: unknown = {}): Promise<T> {
  const res = await raw(app, cookie, proc, body);
  const payload = await res.text();
  const parsed = JSON.parse(payload) as { json?: T; error?: { message?: string } };
  if (res.status >= 400 || parsed.error) {
    throw new Error(`${proc} ${res.status}: ${parsed.error?.message ?? payload}`);
  }
  return discardBotIntroFromCreate(harness, cookie, proc, parsed.json as T);
}

async function until(check: () => Promise<boolean>) {
  const start = Date.now();
  while (Date.now() - start < 20_000) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("timeout waiting for database state");
}
