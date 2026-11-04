import * as z from "zod";
import { WorkPhaseSchema } from "./board.js";
import { Id, IsoDate, RunStatus } from "./ids.js";
import { RoutineReceiptOutcomeSchema } from "./routine-receipts.js";
import { RunTriggerSchema } from "./runs.js";

/** Where the Today read model looks back: finished work and failures that still need a look. */
export const TODAY_COMPLETED_WINDOW_HOURS = 24;
export const TODAY_FAILED_WINDOW_DAYS = 3;

const TodayBotRef = z.object({
  botId: Id,
  botName: z.string(),
  /** Set when the work happened in a group chat; the link then opens the group. */
  groupId: Id.nullable(),
});

export const TodayArtifactSchema = z.object({
  id: Id,
  name: z.string(),
  mimeType: z.string(),
});
export type TodayArtifact = z.infer<typeof TodayArtifactSchema>;

/** One run of a bot: running, waiting on the user, finished or failed. */
export const TodayRunSchema = TodayBotRef.extend({
  runId: Id,
  status: RunStatus,
  trigger: RunTriggerSchema,
  /** The routine's name for a routine run, otherwise a one-line snippet of what was asked. */
  title: z.string(),
  routineId: Id.nullable(),
  /** Set when the run belongs to an assignment; the link then opens that assignment. */
  assignmentId: Id.nullable(),
  /** When the run last changed; for a finished run, when it finished. */
  at: IsoDate,
  artifacts: z.array(TodayArtifactSchema),
});
export type TodayRun = z.infer<typeof TodayRunSchema>;

const AttentionBase = TodayBotRef.extend({
  /** Stable per item, so a list keeps its rows when the data refreshes. */
  key: z.string(),
  runId: Id,
  assignmentId: Id.nullable(),
  title: z.string(),
  at: IsoDate,
});

export const TodayAttentionSchema = z.discriminatedUnion("kind", [
  /**
   * An approval card waiting in a chat. `text` is a clipped preview only; the whole card, with its
   * destination and arguments, is decided in the chat, never from this summary.
   */
  AttentionBase.extend({ kind: z.literal("approval"), messageId: Id, text: z.string() }),
  /** A question from a bot, answered in the chat. */
  AttentionBase.extend({ kind: z.literal("question"), messageId: Id, text: z.string() }),
  AttentionBase.extend({
    kind: z.literal("failed_run"),
    error: z.string().nullable(),
  }),
  /** A routine's latest run failed and nothing newer has run. `routines.testRun` runs it again. */
  AttentionBase.extend({
    kind: z.literal("failed_routine"),
    routineId: Id,
    error: z.string().nullable(),
  }),
  /**
   * A routine firing that did not complete cleanly and has no failed run to show: a check that
   * could not reach its source, or a scheduled firing that did not run.
   */
  TodayBotRef.extend({
    kind: z.literal("routine_exception"),
    key: z.string(),
    /** The run that checked, when there was one (a silent run whose tool failed). */
    runId: Id.nullable(),
    routineId: Id,
    title: z.string(),
    at: IsoDate,
    outcome: RoutineReceiptOutcomeSchema.extract(["failed", "missed"]),
    error: z.string().nullable(),
  }),
]);
export type TodayAttention = z.infer<typeof TodayAttentionSchema>;

export const TodayUpcomingSchema = TodayBotRef.extend({
  routineId: Id,
  name: z.string(),
  nextRunAt: IsoDate,
});
export type TodayUpcoming = z.infer<typeof TodayUpcomingSchema>;

/** The phases of an assignment that still need watching. Done and cancelled work is not listed. */
export const TODAY_WORK_PHASES = ["running", "waiting", "review", "failed"] as const;
export const TodayWorkPhaseSchema = WorkPhaseSchema.extract(TODAY_WORK_PHASES);
export type TodayWorkPhase = z.infer<typeof TodayWorkPhaseSchema>;

/** An assignment (ticket) from the user's own work: created by them or given to one of their bots. */
export const TodayWorkItemSchema = z.object({
  id: Id,
  ref: z.string(),
  title: z.string(),
  phase: TodayWorkPhaseSchema,
  /** The ticket's assignment, when it has one; the link then opens that assignment. */
  assignmentId: Id.nullable(),
  /** The assignee when it is one of the user's own bots; never another person's bot. */
  botId: Id.nullable(),
  botName: z.string().nullable(),
  at: IsoDate,
});
export type TodayWorkItem = z.infer<typeof TodayWorkItemSchema>;

export const TodaySummarySchema = z.object({
  generatedAt: IsoDate,
  counts: z.object({
    working: z.number().int().nonnegative(),
    waiting: z.number().int().nonnegative(),
    attention: z.number().int().nonnegative(),
    completed: z.number().int().nonnegative(),
  }),
  attention: z.array(TodayAttentionSchema),
  /** Running, queued, or paused on the user. */
  active: z.array(TodayRunSchema),
  /** Autonomous or deliverable-producing runs that finished in the last day. */
  completed: z.array(TodayRunSchema),
  upcoming: z.array(TodayUpcomingSchema),
  /** Assignments in progress, newest activity first. Empty when the ticket board is off. */
  work: z.array(TodayWorkItemSchema),
});
export type TodaySummary = z.infer<typeof TodaySummarySchema>;
