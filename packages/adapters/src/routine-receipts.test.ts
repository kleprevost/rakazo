import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { routineTimerNonce } from "./routine-coalescing.js";
import {
  recordRoutineReceipt,
  recordRoutineRunReceipt,
  routineRunOutcome,
  skippedOccurrences,
} from "./routine-receipts.js";

const routine = { id: "routine-1", spaceId: "space-1", userId: "user-1", botId: "bot-1" };
const run = {
  ...routine,
  id: "run-1",
  trigger: "routine",
  routineId: "routine-1",
  clientNonce: null,
  createdAt: new Date("2026-03-10T09:00:05Z"),
};

function fake(options: { toolError?: unknown; fired?: unknown } = {}) {
  const create = vi.fn(async (_args: unknown) => ({}));
  const findEvent = vi.fn(async ({ where }: { where: { type: string } }) =>
    where.type === "routine.fired"
      ? options.fired
        ? { payload: { scheduledFor: options.fired } }
        : null
      : options.toolError
        ? { payload: { outcome: "error", error: options.toolError } }
        : null,
  );
  const prisma = {
    routineReceipt: { create, deleteMany: vi.fn(async () => ({ count: 0 })) },
    event: { findFirst: findEvent },
  } as unknown as PrismaClient;
  return { prisma, create, findEvent };
}

describe("routineRunOutcome", () => {
  it.each([
    [{ status: "completed", replied: false, toolErrored: false }, "no_change"],
    [{ status: "completed", replied: true, toolErrored: false }, "action_needed"],
    // A silent run that hit a tool error did not check cleanly.
    [{ status: "completed", replied: false, toolErrored: true }, "failed"],
    [{ status: "completed", replied: true, toolErrored: true }, "action_needed"],
    [{ status: "failed", replied: false, toolErrored: false }, "failed"],
  ] as const)("%j is %s", (input, outcome) => {
    expect(routineRunOutcome(input)).toBe(outcome);
  });
});

describe("recordRoutineRunReceipt", () => {
  it("records a silent run as no change", async () => {
    const { prisma, create } = fake();
    await recordRoutineRunReceipt(prisma, run, { status: "completed", replied: false });
    expect(create.mock.calls[0]?.[0]).toMatchObject({
      data: { routineId: "routine-1", runId: "run-1", outcome: "no_change", detail: null },
    });
  });

  it("records a silent run whose tool errored as failed, with the tool's error", async () => {
    const { prisma, create } = fake({ toolError: "503 service unavailable" });
    await recordRoutineRunReceipt(prisma, run, { status: "completed", replied: false });
    expect(create.mock.calls[0]?.[0]).toMatchObject({
      data: { outcome: "failed", detail: "503 service unavailable" },
    });
  });

  it("does not look for tool errors when the run replied", async () => {
    const { prisma, create, findEvent } = fake({ toolError: "boom" });
    await recordRoutineRunReceipt(prisma, run, { status: "completed", replied: true });
    expect(create.mock.calls[0]?.[0]).toMatchObject({ data: { outcome: "action_needed" } });
    expect(findEvent).not.toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ type: "agent.tool.completed" }) }),
    );
  });

  it("dates a timer tick by its occurrence and a change check by its wake", async () => {
    const tick = fake();
    await recordRoutineRunReceipt(
      tick.prisma,
      { ...run, clientNonce: routineTimerNonce("routine-1", "2026-03-10T09:00:00.000Z") },
      { status: "failed", error: "model unavailable" },
    );
    expect(tick.create.mock.calls[0]?.[0]).toMatchObject({
      data: { scheduledFor: new Date("2026-03-10T09:00:00.000Z"), outcome: "failed" },
    });
    const watch = fake({ fired: "2026-03-10T08:55:00.000Z" });
    await recordRoutineRunReceipt(watch.prisma, run, { status: "completed", replied: true });
    expect(watch.create.mock.calls[0]?.[0]).toMatchObject({
      data: { scheduledFor: new Date("2026-03-10T08:55:00.000Z") },
    });
  });

  it("ignores runs that are not routine firings and never throws", async () => {
    const { prisma, create } = fake();
    await recordRoutineRunReceipt(
      prisma,
      { ...run, trigger: "user" },
      { status: "completed", replied: true },
    );
    expect(create).not.toHaveBeenCalled();
    const broken = { routineReceipt: {}, event: {} } as unknown as PrismaClient;
    await expect(
      recordRoutineRunReceipt(broken, run, { status: "completed", replied: false }),
    ).resolves.toBeUndefined();
  });
});

describe("recordRoutineReceipt", () => {
  it("treats a repeated delivery as already recorded", async () => {
    const { prisma, create } = fake();
    create.mockRejectedValueOnce(Object.assign(new Error("unique"), { code: "P2002" }));
    await expect(
      recordRoutineReceipt(prisma, routine, { scheduledFor: new Date(), outcome: "missed" }),
    ).resolves.toBeUndefined();
  });
});

describe("skippedOccurrences", () => {
  const every = { crons: ["* * * * *"], timezone: "UTC" };
  const fired = new Date("2026-03-10T09:00:00Z");

  it("lists the occurrences between the one that fired and the next armed", () => {
    expect(
      skippedOccurrences(every, fired, new Date("2026-03-10T09:04:00Z")).map((d) =>
        d.toISOString(),
      ),
    ).toEqual(["2026-03-10T09:01:00.000Z", "2026-03-10T09:02:00.000Z", "2026-03-10T09:03:00.000Z"]);
  });

  it("is empty for an on-time wake, a one-shot, and caps a long outage", () => {
    expect(skippedOccurrences(every, fired, new Date("2026-03-10T09:01:00Z"))).toEqual([]);
    expect(skippedOccurrences(every, fired, null)).toEqual([]);
    expect(skippedOccurrences(every, fired, new Date("2026-03-11T09:00:00Z"))).toHaveLength(10);
  });
});
