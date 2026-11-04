import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type {
  AdapterContext,
  ConnectorCall,
  ConnectorEvent,
  ConnectorProvider,
  ConnectorTool,
  NotificationMessage,
} from "@rakazo/adapter-kit";
import { ComposioConnector, FakeComposioClient, listPiCatalog } from "@rakazo/adapters";
import type { createApp } from "@rakazo/api/app";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sessionCookieHeader } from "./index.js";
import { createModelConnectionFixtureFetch } from "./model-connection-fixture.js";
import { asSystem } from "./system-db.js";

process.env.WAKEUP_DRIVER = "memory";
process.env.SANDBOX_PROVIDER = "fake";
process.env.AGENT_RUNTIME = "scripted";

const hasDb = process.env.VERIFY_DATABASE === "1" && Boolean(process.env.DATABASE_URL);
type App = { request: (input: string, init?: RequestInit) => Response | Promise<Response> };

/** A read-only source whose answer, or outage, the test controls. */
class FakeSource implements ConnectorProvider {
  events: string[] = ["release 1"];
  down = false;
  describe() {
    return {
      id: "source",
      contractVersion: "1",
      adapterVersion: "0.1.0",
      capabilities: { discover: true, oauth: false, secretsBrokered: false },
    };
  }
  async discoverTools(_context: AdapterContext): Promise<ConnectorTool[]> {
    return [
      {
        name: "source_events",
        description: "List the source's events",
        inputSchema: { type: "object", properties: {} },
        readOnly: true,
        route: { connectorId: "source", toolName: "source_events" },
      },
    ];
  }
  async *execute(_call: ConnectorCall, _context: AdapterContext): AsyncIterable<ConnectorEvent> {
    if (this.down) {
      yield { type: "error", message: "503 service unavailable" };
      return;
    }
    yield { type: "result", data: { events: this.events } };
  }
}

describe.skipIf(!hasDb)("routine receipts through the product", () => {
  let app: App;
  let stop: () => Promise<void>;
  let prisma: Awaited<ReturnType<typeof createApp>>["prisma"];
  let jobs: Awaited<ReturnType<typeof createApp>>["jobs"];
  const source = new FakeSource();
  const sent: NotificationMessage[] = [];
  const stamp = Date.now();
  const dataDir = mkdtempSync(path.join(tmpdir(), "rakazo-receipts-"));

  beforeAll(async () => {
    const { createApp } = await import("@rakazo/api/app");
    const handles = await createApp({
      modelConnectionFetch: createModelConnectionFixtureFetch(listPiCatalog()),
      databaseUrl: process.env.DATABASE_URL!,
      dataDir,
      sandboxProvider: "fake",
      agentRuntime: "scripted",
      composio: new ComposioConnector({ client: new FakeComposioClient() }),
      connectors: [source],
      notifications: {
        describe: () => ({
          id: "fake",
          contractVersion: "1",
          adapterVersion: "0.1.0",
          capabilities: { push: true, email: false },
        }),
        send: async (message) => {
          sent.push(message);
        },
      },
    });
    app = handles.app;
    stop = handles.stop;
    prisma = asSystem(handles.prisma);
    jobs = handles.jobs;
  });
  afterAll(async () => {
    await stop?.();
  });

  async function setup(label: string) {
    const cookie = await signup(`receipts-${label}-${stamp}@rakazo.test`, label);
    const bot = await rpc<{ id: string }>(cookie, "bots/create", {
      name: "Monitor",
      title: "",
      description: "",
      instructions: "",
      notifyOnFinish: true,
    });
    // The new bot's welcome turn finishes first, so its notification is not counted below.
    await until(
      async () =>
        (await prisma.run.count({
          where: { botId: bot.id, status: { in: ["queued", "leased", "running"] } },
        })) === 0,
    );
    return { cookie, botId: bot.id };
  }

  async function create(cookie: string, botId: string, input: Record<string, unknown>) {
    const routine = await rpc<{ id: string }>(cookie, "routines/create", {
      botId,
      name: "Monitor",
      timezone: "UTC",
      notify: true,
      active: true,
      ...input,
    });
    return routine.id;
  }

  /** Delivers the routine's due wake at `at` as the scheduler's job, and waits for it to be handled. */
  async function wake(routineId: string, at: Date) {
    await prisma.routine.update({
      where: { id: routineId },
      data: { nextRunAt: at, active: true },
    });
    await jobs.enqueue({
      name: "routine.wakeup",
      payload: { routineId, scheduledFor: at.toISOString() },
    });
    await until(
      async () =>
        (
          await prisma.routine.findUniqueOrThrow({ where: { id: routineId } })
        ).nextRunAt?.getTime() !== at.getTime(),
    );
  }

  async function finish(routineId: string) {
    await until(async () => {
      const runs = await prisma.run.findMany({ where: { routineId } });
      return runs.length > 0 && runs.every((run) => ["completed", "failed"].includes(run.status));
    });
    await until(
      async () =>
        (await prisma.routineReceipt.count({ where: { routineId, runId: { not: null } } })) ===
        (await prisma.run.count({ where: { routineId } })),
    );
  }

  const receipts = async (routineId: string, count?: number) => {
    if (count !== undefined) {
      await until(
        async () => (await prisma.routineReceipt.count({ where: { routineId } })) >= count,
      );
    }
    return prisma.routineReceipt.findMany({
      where: { routineId },
      orderBy: { scheduledFor: "asc" },
      select: { outcome: true, runId: true, detail: true },
    });
  };
  const pushes = (botId: string) => sent.filter((message) => message.botId === botId);

  it("checks one source three times: one event notifies once, an unchanged result stays quiet, an outage is failed", async () => {
    const { cookie, botId } = await setup("watch");
    const routineId = await create(cookie, botId, {
      prompt: "Tell me what is new in the source",
      crons: [],
      watch: { kind: "tool", tool: "source_events", args: {}, everyMinutes: 5 },
    });
    const start = Date.now() - 60 * 60_000;
    const at = (check: number) => new Date(start + check * 5 * 60_000);

    await wake(routineId, at(0)); // first look: the baseline
    await wake(routineId, at(1)); // unchanged
    expect(await prisma.run.count({ where: { routineId } })).toBe(0);
    expect((await receipts(routineId, 2)).map((r) => r.outcome)).toEqual([
      "no_change",
      "no_change",
    ]);
    expect(pushes(botId)).toHaveLength(0);

    source.events = ["release 1", "release 2"]; // one new event
    await wake(routineId, at(2));
    await finish(routineId);
    await until(async () => pushes(botId).length > 0);
    expect(pushes(botId)).toHaveLength(1);

    await wake(routineId, at(3)); // the same result again
    expect(await prisma.run.count({ where: { routineId } })).toBe(1);
    expect(pushes(botId)).toHaveLength(1);

    source.down = true;
    await wake(routineId, at(4)); // the source is down: not a clean check
    source.down = false;
    const rows = await receipts(routineId, 5);
    expect(rows.map((r) => r.outcome)).toEqual([
      "no_change",
      "no_change",
      "action_needed",
      "no_change",
      "failed",
    ]);
    expect(rows[2]?.runId).toBeTruthy();
    expect(rows[4]?.detail).toContain("503");
    expect(pushes(botId)).toHaveLength(1);

    // Today lists the outage as an exception, and the calendar shows every firing's outcome.
    const today = await rpc<{ attention: Array<Record<string, unknown>> }>(cookie, "today/summary");
    expect(today.attention).toMatchObject([
      { kind: "routine_exception", routineId, outcome: "failed" },
    ]);
    const range = await rpc<{ past: Array<{ outcome: string }> }>(cookie, "calendar/range", {
      from: new Date(start - 60_000).toISOString(),
      to: new Date(start + 2 * 3_600_000).toISOString(),
    });
    // A run sits at the time it started, which is later than its wake in this accelerated test.
    expect(range.past.map((entry) => entry.outcome).sort()).toEqual([
      "action_needed",
      "failed",
      "no_change",
      "no_change",
      "no_change",
    ]);
  }, 60_000);

  it("a scheduled run that finds nothing says nothing and is recorded as no change", async () => {
    const { cookie, botId } = await setup("silent");
    const routineId = await create(cookie, botId, {
      prompt: "silent routine fixture: stay quiet unless something changed",
      crons: ["0 9 * * 1"],
    });
    await wake(routineId, new Date(Date.now() - 1_000));
    await finish(routineId);
    expect((await receipts(routineId)).map((r) => r.outcome)).toEqual(["no_change"]);
    expect(pushes(botId)).toHaveLength(0);
  }, 60_000);

  it("a skipped schedule is recorded as missed", async () => {
    const { cookie, botId } = await setup("missed");
    const routineId = await create(cookie, botId, {
      prompt: "silent routine fixture",
      crons: ["* * * * *"],
    });
    // The worker was away for three minutes: the late run covers them, the others never fire.
    await wake(routineId, new Date(Date.now() - 3 * 60_000 - 1_000));
    await finish(routineId);
    const caughtUp = await receipts(routineId);
    expect(caughtUp.filter((r) => r.outcome === "missed").length).toBeGreaterThanOrEqual(2);
    expect(caughtUp.filter((r) => r.runId)).toHaveLength(1);

    // A suspended bot skips its firing and keeps the schedule.
    const other = await setup("suspended");
    const suspendedRoutine = await create(other.cookie, other.botId, {
      prompt: "silent routine fixture",
      crons: ["0 9 * * 1"],
    });
    await prisma.bot.update({ where: { id: other.botId }, data: { suspendedAt: new Date() } });
    await wake(suspendedRoutine, new Date(Date.now() - 1_000));
    expect((await receipts(suspendedRoutine, 1)).map((r) => r.outcome)).toEqual(["missed"]);
    expect(await prisma.run.count({ where: { routineId: suspendedRoutine } })).toBe(0);
  }, 60_000);

  async function signup(email: string, name: string) {
    const res = await app.request("/api/auth/sign-up/email", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://127.0.0.1:5173" },
      body: JSON.stringify({ email, password: "password12", name }),
    });
    if (res.status >= 400) throw new Error(`signup failed ${res.status}: ${await res.text()}`);
    return sessionCookieHeader(res);
  }

  async function rpc<T>(cookie: string, proc: string, body: unknown = {}): Promise<T> {
    const res = await app.request(`/rpc/${proc}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie,
        origin: "http://127.0.0.1:5173",
      },
      body: JSON.stringify({ json: body }),
    });
    const text = await res.text();
    const parsed = JSON.parse(text) as { json?: T; error?: { message?: string } };
    if (res.status >= 400 || parsed.error) {
      throw new Error(`${proc} ${res.status}: ${parsed.error?.message ?? text}`);
    }
    return parsed.json as T;
  }
});

async function until(predicate: () => Promise<boolean>) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 20_000) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("timeout waiting for database state");
}
