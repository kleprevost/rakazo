import type {
  Actor,
  CalendarOccurrence,
  CalendarOutcome,
  CalendarRange,
  CalendarRangeInput,
  CalendarRoutine,
} from "@rakazo/contracts";
import {
  CALENDAR_MAX_OCCURRENCES,
  CALENDAR_MAX_OCCURRENCES_PER_ROUTINE,
  CALENDAR_MAX_PAST_RUNS,
} from "@rakazo/contracts";
import { ACTIVE_RUN_STATUSES, isOneShotRoutineCrons, nextRoutineRunDateAcross } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";

type ScheduledRoutine = {
  crons: string[];
  timezone: string;
  nextRunAt: Date | null;
  watch: unknown;
};

/** A routine sits on the grid when a clock starts it; events, webhooks and messages do not. */
function isScheduled(routine: Pick<ScheduledRoutine, "crons" | "watch">): boolean {
  return routine.crons.length > 0 && !routine.watch;
}

/**
 * The times an active routine will run in [from, to], as the scheduler computes them: the stored
 * `nextRunAt` is the first one, and each later one is `nextRoutineRunDateAcross` from the one
 * before, exactly how a finished run arms the next. Stops at `limit`.
 */
export function projectOccurrences(
  routine: ScheduledRoutine,
  from: Date,
  to: Date,
  now: Date,
  limit = CALENDAR_MAX_OCCURRENCES_PER_ROUTINE,
): { times: Date[]; truncated: boolean } {
  const times: Date[] = [];
  if (!isScheduled(routine)) return { times, truncated: false };
  // Nothing in the past is projected; past days show what actually ran.
  const start = new Date(Math.max(from.getTime(), now.getTime()));
  if (isOneShotRoutineCrons(routine.crons)) {
    const at = routine.nextRunAt;
    if (at && at >= start && at <= to) times.push(at);
    return { times, truncated: false };
  }
  const next = (anchor: Date, after: Date) =>
    nextRoutineRunDateAcross(routine.crons, anchor, after, routine.timezone);
  let cursor = routine.nextRunAt ?? next(start, start);
  // A run that is already due is placed at its next slot, as the scheduler would after firing it.
  if (cursor && cursor < start) cursor = next(cursor, start);
  while (cursor && cursor <= to) {
    if (times.length >= limit) return { times, truncated: true };
    times.push(cursor);
    const after: Date = cursor;
    cursor = next(after, after);
    if (cursor && cursor <= after) break;
  }
  return { times, truncated: false };
}

function outcome(status: string): CalendarOutcome {
  if (status === "completed") return "success";
  if (status === "failed") return "failed";
  if ((ACTIVE_RUN_STATUSES as readonly string[]).includes(status)) return "running";
  return "skipped";
}

/**
 * The calendar for one signed-in user in one space. Routines are the same set the routine list
 * shows (the user's own, on bots that are not archived), so nothing else is readable here.
 */
export async function calendarRange(
  prisma: PrismaClient,
  actor: Actor,
  input: CalendarRangeInput,
  now = new Date(),
): Promise<CalendarRange> {
  const from = new Date(input.from);
  const to = new Date(input.to);
  const scope = { spaceId: actor.spaceId, userId: actor.userId };
  const rows = await prisma.routine.findMany({
    where: { ...scope, bot: { archivedAt: null } },
    include: { bot: { select: { name: true } }, thread: { select: { groupId: true } } },
    orderBy: [{ name: "asc" }, { id: "asc" }],
  });
  const ids = rows.map((row) => row.id);
  const runs = ids.length
    ? await prisma.run.findMany({
        where: {
          ...scope,
          routineId: { in: ids },
          createdAt: { gte: from, lt: to },
        },
        select: { id: true, routineId: true, threadId: true, status: true, createdAt: true },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: CALENDAR_MAX_PAST_RUNS + 1,
      })
    : [];
  const pastRuns = runs.slice(0, CALENDAR_MAX_PAST_RUNS);
  let truncated = runs.length > CALENDAR_MAX_PAST_RUNS;

  const replies = pastRuns.length
    ? await prisma.message.findMany({
        where: {
          runId: { in: pastRuns.map((run) => run.id) },
          role: "bot",
          thread: scope,
        },
        select: { id: true, runId: true, threadId: true },
        distinct: ["runId"],
        orderBy: [{ runId: "asc" }, { seq: "asc" }],
      })
    : [];
  const replyByRun = new Map(replies.map((m) => [`${m.runId}:${m.threadId}`, m.id]));

  const upcoming: CalendarOccurrence[] = [];
  const hasRun = new Set(pastRuns.map((run) => run.routineId));
  const grid: CalendarRoutine[] = [];
  const unscheduled: CalendarRoutine[] = [];
  for (const row of rows) {
    const routine: CalendarRoutine = {
      routineId: row.id,
      name: row.name,
      botId: row.botId,
      botName: row.bot.name,
      groupId: row.thread?.groupId ?? null,
      active: row.active,
      timezone: row.timezone,
    };
    const scheduled = isScheduled(row);
    if (scheduled || hasRun.has(row.id)) grid.push(routine);
    else unscheduled.push(routine);
    // A paused routine runs nothing, so it has no future to project.
    if (!row.active || !scheduled) continue;
    const room = CALENDAR_MAX_OCCURRENCES - upcoming.length;
    if (room <= 0) {
      truncated = true;
      continue;
    }
    const projected = projectOccurrences(
      row,
      from,
      to,
      now,
      Math.min(room, CALENDAR_MAX_OCCURRENCES_PER_ROUTINE),
    );
    if (projected.truncated) truncated = true;
    for (const time of projected.times) {
      upcoming.push({ routineId: row.id, at: time.toISOString() });
    }
  }
  upcoming.sort((a, b) => a.at.localeCompare(b.at) || a.routineId.localeCompare(b.routineId));

  return {
    from: from.toISOString(),
    to: to.toISOString(),
    routines: grid,
    unscheduled,
    upcoming,
    past: pastRuns
      .filter((run): run is typeof run & { routineId: string } => run.routineId !== null)
      .map((run) => ({
        routineId: run.routineId,
        runId: run.id,
        at: run.createdAt.toISOString(),
        outcome: outcome(run.status),
        messageId: replyByRun.get(`${run.id}:${run.threadId}`) ?? null,
      }))
      .reverse(),
    truncated,
  };
}
