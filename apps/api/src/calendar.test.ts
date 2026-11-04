import type { Actor } from "@rakazo/contracts";
import {
  CALENDAR_MAX_OCCURRENCES_PER_ROUTINE,
  CalendarRangeInputSchema,
  CalendarRangeSchema,
} from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { calendarRange, projectOccurrences } from "./calendar.js";

const actor: Actor = {
  userId: "user-1",
  spaceId: "space-1",
  email: "user@rakazo.test",
  isDeploymentOwner: false,
};
const now = new Date("2026-03-10T12:00:00Z");
const iso = (d: Date) => d.toISOString();

function routineRow(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    name: `Routine ${id}`,
    botId: "bot-1",
    bot: { name: "Maya" },
    thread: null,
    crons: ["0 9 * * *"],
    timezone: "UTC",
    active: true,
    watch: null,
    nextRunAt: new Date("2026-03-11T09:00:00Z"),
    ...overrides,
  };
}

function fixture(
  rows: unknown[] = [],
  runs: unknown[] = [],
  messages: unknown[] = [],
  receipts: unknown[] = [],
) {
  const routines = vi.fn(async (_args: unknown) => rows);
  const runFind = vi.fn(async (_args: unknown) => runs);
  const messageFind = vi.fn(async (_args: unknown) => messages);
  const receiptFind = vi.fn(async (_args: unknown) => receipts);
  const prisma = {
    routineReceipt: { findMany: receiptFind },
    routine: { findMany: routines },
    run: { findMany: runFind },
    message: { findMany: messageFind },
  } as unknown as PrismaClient;
  return { prisma, routines, runFind, messageFind, receiptFind };
}

describe("projectOccurrences", () => {
  it("continues from the stored next run the way the scheduler does", () => {
    const { times } = projectOccurrences(
      routineRow("r1"),
      new Date("2026-03-10T00:00:00Z"),
      new Date("2026-03-14T00:00:00Z"),
      now,
    );
    expect(times.map(iso)).toEqual([
      "2026-03-11T09:00:00.000Z",
      "2026-03-12T09:00:00.000Z",
      "2026-03-13T09:00:00.000Z",
    ]);
  });

  it("keeps local wall-clock time across the spring-forward change", () => {
    const { times } = projectOccurrences(
      routineRow("r1", {
        timezone: "America/New_York",
        nextRunAt: new Date("2026-03-07T14:00:00Z"),
      }),
      new Date("2026-03-07T00:00:00Z"),
      new Date("2026-03-10T00:00:00Z"),
      new Date("2026-03-06T00:00:00Z"),
    );
    // 09:00 is EST (UTC-5) on the 7th and EDT (UTC-4) from the 8th.
    expect(times.map(iso)).toEqual([
      "2026-03-07T14:00:00.000Z",
      "2026-03-08T13:00:00.000Z",
      "2026-03-09T13:00:00.000Z",
    ]);
  });

  it("keeps local wall-clock time across the fall-back change", () => {
    const { times } = projectOccurrences(
      routineRow("r1", {
        timezone: "America/New_York",
        nextRunAt: new Date("2026-10-31T13:00:00Z"),
      }),
      new Date("2026-10-31T00:00:00Z"),
      new Date("2026-11-03T00:00:00Z"),
      new Date("2026-10-30T00:00:00Z"),
    );
    expect(times.map(iso)).toEqual([
      "2026-10-31T13:00:00.000Z",
      "2026-11-01T14:00:00.000Z",
      "2026-11-02T14:00:00.000Z",
    ]);
  });

  it("projects nothing before now and moves a due run to its next slot", () => {
    const { times } = projectOccurrences(
      routineRow("r1", { nextRunAt: new Date("2026-03-09T09:00:00Z") }),
      new Date("2026-03-09T00:00:00Z"),
      new Date("2026-03-12T00:00:00Z"),
      now,
    );
    expect(times.map(iso)).toEqual(["2026-03-11T09:00:00.000Z"]);
  });

  it("places a one-time routine at its armed time and skips event triggers", () => {
    const from = new Date("2026-03-10T00:00:00Z");
    const to = new Date("2026-03-12T00:00:00Z");
    const once = projectOccurrences(
      routineRow("r1", { crons: ["@once"], nextRunAt: new Date("2026-03-11T15:00:00Z") }),
      from,
      to,
      now,
    );
    expect(once.times.map(iso)).toEqual(["2026-03-11T15:00:00.000Z"]);
    expect(projectOccurrences(routineRow("r2", { crons: [] }), from, to, now).times).toEqual([]);
    expect(
      projectOccurrences(routineRow("r3", { crons: [], watch: { kind: "x" } }), from, to, now)
        .times,
    ).toEqual([]);
  });

  it("caps a frequent routine and reports it", () => {
    const result = projectOccurrences(
      routineRow("r1", { crons: ["* * * * *"], nextRunAt: new Date("2026-03-10T12:01:00Z") }),
      new Date("2026-03-10T00:00:00Z"),
      new Date("2026-03-20T00:00:00Z"),
      now,
    );
    expect(result.times).toHaveLength(CALENDAR_MAX_OCCURRENCES_PER_ROUTINE);
    expect(result.truncated).toBe(true);
  });
});

describe("calendar range input", () => {
  const input = (from: string, to: string) => CalendarRangeInputSchema.safeParse({ from, to });
  it("accepts up to 31 days and refuses empty, reversed and longer ranges", () => {
    expect(input("2026-03-01T00:00:00Z", "2026-04-01T00:00:00Z").success).toBe(true);
    expect(input("2026-03-01T00:00:00Z", "2026-04-01T00:00:01Z").success).toBe(false);
    expect(input("2026-03-01T00:00:00Z", "2026-03-01T00:00:00Z").success).toBe(false);
    expect(input("2026-03-02T00:00:00Z", "2026-03-01T00:00:00Z").success).toBe(false);
  });
});

describe("calendar range", () => {
  const range = { from: "2026-03-09T00:00:00.000Z", to: "2026-03-13T00:00:00.000Z" };

  it("scopes every read to the signed-in user and space, and to active bots", async () => {
    const { prisma, routines, runFind } = fixture([routineRow("r1")], []);
    await calendarRange(prisma, actor, range, now);
    expect(routines.mock.calls[0]?.[0]).toMatchObject({
      where: { spaceId: "space-1", userId: "user-1", bot: { archivedAt: null } },
    });
    expect(runFind.mock.calls[0]?.[0]).toMatchObject({
      where: { spaceId: "space-1", userId: "user-1", routineId: { in: ["r1"] } },
    });
  });

  it("returns an empty valid calendar and reads no runs without routines", async () => {
    const { prisma, runFind } = fixture();
    const result = await calendarRange(prisma, actor, range, now);
    expect(CalendarRangeSchema.parse(result)).toEqual(result);
    expect(result).toMatchObject({ routines: [], unscheduled: [], upcoming: [], past: [] });
    expect(runFind).not.toHaveBeenCalled();
  });

  it("merges projections, past outcomes and the event-triggered side list", async () => {
    const rows = [
      routineRow("daily"),
      routineRow("hook", { crons: [], nextRunAt: null }),
      routineRow("paused", { active: false, nextRunAt: null }),
      routineRow("watching", { crons: [], watch: { kind: "x" } }),
    ];
    const runs = [
      {
        id: "run-hook",
        routineId: "hook",
        threadId: "t2",
        status: "cancelled",
        createdAt: new Date("2026-03-10T10:00:00Z"),
      },
      {
        id: "run-fail",
        routineId: "daily",
        threadId: "t1",
        status: "failed",
        createdAt: new Date("2026-03-10T09:00:00Z"),
      },
      {
        id: "run-ok",
        routineId: "daily",
        threadId: "t1",
        status: "completed",
        createdAt: new Date("2026-03-09T09:00:00Z"),
      },
    ];
    const { prisma } = fixture(rows, runs, [{ id: "m1", runId: "run-ok", threadId: "t1" }]);
    const result = await calendarRange(prisma, actor, range, now);
    expect(CalendarRangeSchema.parse(result)).toEqual(result);
    expect(result.routines.map((r) => r.routineId)).toEqual(["daily", "hook", "paused"]);
    expect(result.unscheduled.map((r) => r.routineId)).toEqual(["watching"]);
    expect(result.upcoming).toEqual([
      { routineId: "daily", at: "2026-03-11T09:00:00.000Z" },
      { routineId: "daily", at: "2026-03-12T09:00:00.000Z" },
    ]);
    expect(result.past.map((r) => [r.runId, r.outcome, r.messageId])).toEqual([
      ["run-ok", "success", "m1"],
      ["run-fail", "failed", null],
      ["run-hook", "skipped", null],
    ]);
    expect(result.truncated).toBe(false);
  });

  it("shows each firing's receipt: run outcomes, quiet checks and misses without a run", async () => {
    const rows = [routineRow("daily"), routineRow("watching", { crons: [], watch: { kind: "x" } })];
    const runs = [
      {
        id: "run-quiet",
        routineId: "daily",
        threadId: "t1",
        status: "completed",
        createdAt: new Date("2026-03-10T09:00:00Z"),
      },
      {
        id: "run-news",
        routineId: "daily",
        threadId: "t1",
        status: "completed",
        createdAt: new Date("2026-03-09T09:00:00Z"),
      },
      {
        id: "run-live",
        routineId: "daily",
        threadId: "t1",
        status: "running",
        createdAt: new Date("2026-03-10T11:00:00Z"),
      },
    ];
    const receipts = [
      { routineId: "daily", runId: "run-quiet", scheduledFor: new Date(), outcome: "no_change" },
      { routineId: "daily", runId: "run-news", scheduledFor: new Date(), outcome: "action_needed" },
      {
        routineId: "watching",
        runId: null,
        scheduledFor: new Date("2026-03-10T10:30:00Z"),
        outcome: "no_change",
      },
      {
        routineId: "daily",
        runId: null,
        scheduledFor: new Date("2026-03-08T09:00:00Z"),
        outcome: "missed",
      },
    ];
    const { prisma, receiptFind } = fixture(rows, runs, [], receipts);
    const result = await calendarRange(prisma, actor, range, now);
    expect(CalendarRangeSchema.parse(result)).toEqual(result);
    expect(result.past.map((r) => [r.runId, r.outcome])).toEqual([
      [null, "missed"],
      ["run-news", "action_needed"],
      ["run-quiet", "no_change"],
      [null, "no_change"],
      ["run-live", "running"],
    ]);
    expect(result.routines.map((r) => r.routineId)).toEqual(["daily", "watching"]);
    expect(receiptFind.mock.calls[0]?.[0]).toMatchObject({
      where: { spaceId: "space-1", userId: "user-1", routineId: { in: ["daily", "watching"] } },
    });
  });

  it("flags truncation when more runs exist than the cap", async () => {
    const runs = Array.from({ length: 501 }, (_, index) => ({
      id: `run-${index}`,
      routineId: "r1",
      threadId: "t1",
      status: "completed",
      createdAt: new Date(now.getTime() - index * 60_000),
    }));
    const { prisma } = fixture([routineRow("r1")], runs);
    const result = await calendarRange(prisma, actor, range, now);
    expect(result.past).toHaveLength(500);
    expect(result.truncated).toBe(true);
  });
});
