import type { RoutineReceiptOutcome } from "@rakazo/contracts";
import { ROUTINE_RECEIPT_QUIET_DAYS } from "@rakazo/contracts";
import { nextRoutineRunDateAcross } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import { routineTimerScheduledFor } from "./routine-coalescing.js";
import { isUniqueViolation } from "./run-messages.js";

const DETAIL_MAX = 300;
/** Occurrences skipped while the worker was away are recorded up to this many per wake. */
const MAX_MISSED_PER_WAKE = 10;

type ReceiptTarget = { id: string; spaceId: string; userId: string; botId: string };

function clip(text: string): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length <= DETAIL_MAX ? oneLine : `${oneLine.slice(0, DETAIL_MAX - 1)}…`;
}

/**
 * Records what one firing came to. One receipt per routine and scheduled time, so a repeated
 * delivery of the same wake or completion adds nothing. Best effort: a failure here never
 * changes the run or the schedule it describes.
 */
export async function recordRoutineReceipt(
  prisma: PrismaClient,
  routine: ReceiptTarget,
  input: {
    scheduledFor: Date;
    outcome: RoutineReceiptOutcome;
    runId?: string | null;
    detail?: string | null;
  },
): Promise<void> {
  try {
    await prisma.routineReceipt.create({
      data: {
        spaceId: routine.spaceId,
        userId: routine.userId,
        botId: routine.botId,
        routineId: routine.id,
        runId: input.runId ?? null,
        scheduledFor: input.scheduledFor,
        outcome: input.outcome,
        detail: input.detail ? clip(input.detail) : null,
      },
    });
    if (input.outcome === "no_change") {
      // Quiet checks can run every few minutes; only the recent ones are worth keeping.
      await prisma.routineReceipt.deleteMany({
        where: {
          routineId: routine.id,
          outcome: "no_change",
          scheduledFor: { lt: new Date(Date.now() - ROUTINE_RECEIPT_QUIET_DAYS * 86_400_000) },
        },
      });
    }
  } catch (error) {
    if (isUniqueViolation(error)) return;
    getLogger().warn("routine.receipt_failed", { "routine.id": routine.id });
  }
}

/**
 * The outcome of a finished routine run, from structured facts only: the run's status, whether
 * the model said anything (a silent reply is its explicit quiet decision), and whether a tool
 * reported an error. A silent run that hit a tool error did not check cleanly.
 */
export function routineRunOutcome(input: {
  status: "completed" | "failed";
  replied: boolean;
  toolErrored: boolean;
}): RoutineReceiptOutcome {
  if (input.status === "failed") return "failed";
  if (input.replied) return "action_needed";
  return input.toolErrored ? "failed" : "no_change";
}

/** When the firing was due: a timer tick's nonce, else the wake the scheduler recorded, else the run's start. */
async function runScheduledFor(
  prisma: PrismaClient,
  run: { id: string; routineId: string; clientNonce: string | null; createdAt: Date },
): Promise<Date> {
  const tick = routineTimerScheduledFor(run.routineId, run.clientNonce);
  if (tick) return tick;
  const fired = await prisma.event.findFirst({
    where: { runId: run.id, type: "routine.fired" },
    select: { payload: true },
  });
  const wake = new Date(
    String((fired?.payload as { scheduledFor?: unknown } | null)?.scheduledFor),
  );
  return Number.isFinite(wake.getTime()) ? wake : run.createdAt;
}

export async function recordRoutineRunReceipt(
  prisma: PrismaClient,
  run: {
    id: string;
    spaceId: string;
    userId: string;
    botId: string;
    trigger: string;
    routineId: string | null;
    clientNonce: string | null;
    createdAt: Date;
  },
  result: { status: "completed"; replied: boolean } | { status: "failed"; error: string },
): Promise<void> {
  if (run.trigger !== "routine" || !run.routineId) return;
  try {
    let detail: string | null = result.status === "failed" ? result.error : null;
    let toolErrored = false;
    if (result.status === "completed" && !result.replied) {
      const failedTool = await prisma.event.findFirst({
        where: {
          runId: run.id,
          type: "agent.tool.completed",
          payload: { path: ["outcome"], equals: "error" },
        },
        select: { payload: true },
      });
      toolErrored = Boolean(failedTool);
      const reason = (failedTool?.payload as { error?: unknown } | null)?.error;
      if (typeof reason === "string") detail = reason;
    }
    await recordRoutineReceipt(
      prisma,
      { id: run.routineId, spaceId: run.spaceId, userId: run.userId, botId: run.botId },
      {
        scheduledFor: await runScheduledFor(prisma, { ...run, routineId: run.routineId }),
        outcome: routineRunOutcome({
          status: result.status,
          replied: result.status === "completed" && result.replied,
          toolErrored,
        }),
        runId: run.id,
        detail,
      },
    );
  } catch {
    getLogger().warn("routine.receipt_failed", { "run.id": run.id });
  }
}

/**
 * The occurrences of a clock schedule strictly between the one that just fired and the next one
 * armed: they came due while nothing was running and will never fire.
 */
export function skippedOccurrences(
  routine: { crons: string[]; timezone: string },
  firedAt: Date,
  nextRunAt: Date | null,
  limit = MAX_MISSED_PER_WAKE,
): Date[] {
  const skipped: Date[] = [];
  if (!nextRunAt) return skipped;
  let cursor = nextRoutineRunDateAcross(routine.crons, firedAt, firedAt, routine.timezone);
  while (cursor && cursor < nextRunAt && skipped.length < limit) {
    skipped.push(cursor);
    cursor = nextRoutineRunDateAcross(routine.crons, cursor, cursor, routine.timezone);
  }
  return skipped;
}
