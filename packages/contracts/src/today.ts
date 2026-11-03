import * as z from "zod";
import { Id, IsoDate, RunStatus } from "./ids.js";
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
  /** When the run last changed; for a finished run, when it finished. */
  at: IsoDate,
  artifacts: z.array(TodayArtifactSchema),
});
export type TodayRun = z.infer<typeof TodayRunSchema>;

const AttentionBase = TodayBotRef.extend({
  /** Stable per item, so a list keeps its rows when the data refreshes. */
  key: z.string(),
  runId: Id,
  title: z.string(),
  at: IsoDate,
});

export const TodayAttentionSchema = z.discriminatedUnion("kind", [
  /**
   * An approval card the signed-in user can answer. `actions` are the card's own choices, answered
   * through `threads.answer` with `messageId`.
   */
  AttentionBase.extend({
    kind: z.literal("approval"),
    messageId: Id,
    text: z.string(),
    actions: z.array(z.object({ id: z.string(), label: z.string() })),
  }),
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
]);
export type TodayAttention = z.infer<typeof TodayAttentionSchema>;

export const TodayUpcomingSchema = TodayBotRef.extend({
  routineId: Id,
  name: z.string(),
  nextRunAt: IsoDate,
});
export type TodayUpcoming = z.infer<typeof TodayUpcomingSchema>;

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
});
export type TodaySummary = z.infer<typeof TodaySummarySchema>;
