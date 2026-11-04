import * as z from "zod";
import { Id, IsoDate } from "./ids.js";

/** The widest range one read covers; larger asks are refused instead of truncated. */
export const CALENDAR_MAX_RANGE_DAYS = 31;
/** Caps so a per-minute routine cannot flood the response; `truncated` reports a hit. */
export const CALENDAR_MAX_OCCURRENCES_PER_ROUTINE = 300;
export const CALENDAR_MAX_OCCURRENCES = 1500;
export const CALENDAR_MAX_PAST_RUNS = 500;

export const CalendarRangeInputSchema = z
  .object({ from: IsoDate, to: IsoDate })
  .superRefine((value, ctx) => {
    const span = Date.parse(value.to) - Date.parse(value.from);
    if (!(span > 0) || span > CALENDAR_MAX_RANGE_DAYS * 86_400_000) {
      ctx.addIssue({
        code: "custom",
        message: `Range must be between 0 and ${CALENDAR_MAX_RANGE_DAYS} days`,
        path: ["to"],
      });
    }
  });
export type CalendarRangeInput = z.infer<typeof CalendarRangeInputSchema>;

/** A routine the signed-in user can see, referenced by the items below. */
export const CalendarRoutineSchema = z.object({
  routineId: Id,
  name: z.string(),
  botId: Id,
  botName: z.string(),
  /** Set when the routine's chat is a group chat. */
  groupId: Id.nullable(),
  active: z.boolean(),
  timezone: z.string(),
});
export type CalendarRoutine = z.infer<typeof CalendarRoutineSchema>;

/** A projected run of an active, scheduled routine. */
export const CalendarOccurrenceSchema = z.object({ routineId: Id, at: IsoDate });
export type CalendarOccurrence = z.infer<typeof CalendarOccurrenceSchema>;

/** A run's state, or its receipt when it has one (`no_change`, `action_needed`, `missed`). */
export const CalendarOutcomeSchema = z.enum([
  "success",
  "failed",
  "skipped",
  "running",
  "no_change",
  "action_needed",
  "missed",
]);
export type CalendarOutcome = z.infer<typeof CalendarOutcomeSchema>;

/** A firing that already happened in the range: a run, or a check that started none. */
export const CalendarRunSchema = z.object({
  routineId: Id,
  /** Null for a firing that started no run: a quiet or failed check, or a missed one. */
  runId: Id.nullable(),
  at: IsoDate,
  outcome: CalendarOutcomeSchema,
  /** The reply to open in the chat; null when the run posted nothing. */
  messageId: Id.nullable(),
});
export type CalendarRun = z.infer<typeof CalendarRunSchema>;

export const CalendarRangeSchema = z.object({
  from: IsoDate,
  to: IsoDate,
  /** Routines placed on the grid: scheduled ones, plus any with a run in the range. */
  routines: z.array(CalendarRoutineSchema),
  /** Routines started by an event, webhook or message; they have no time to place. */
  unscheduled: z.array(CalendarRoutineSchema),
  upcoming: z.array(CalendarOccurrenceSchema),
  past: z.array(CalendarRunSchema),
  /** True when an occurrence or run cap cut the lists short. */
  truncated: z.boolean(),
});
export type CalendarRange = z.infer<typeof CalendarRangeSchema>;
