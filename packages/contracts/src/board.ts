import * as z from "zod";
import { Id } from "./ids.js";

export const TICKET_STATUSES = ["todo", "doing", "review", "blocked", "done", "closed"] as const;
export const TicketStatusSchema = z.enum(TICKET_STATUSES);
export type TicketStatus = z.infer<typeof TicketStatusSchema>;

/** `done` is finished-but-open for review; `closed` is terminal, so both stamp completion. */
export function isTicketCompletedStatus(status: TicketStatus): boolean {
  return status === "done" || status === "closed";
}

export const TICKET_PRIORITIES = ["low", "normal", "high", "urgent"] as const;
export const TicketPrioritySchema = z.enum(TICKET_PRIORITIES);
export type TicketPriority = z.infer<typeof TicketPrioritySchema>;
const DEFAULT_TICKET_PRIORITY: TicketPriority = "normal";

export const TICKET_TITLE_MAX_LENGTH = 200;
export const TICKET_DESCRIPTION_MAX_LENGTH = 20_000;
const TICKET_PREFIX_MAX_LENGTH = 12;
// Ticket numbers are stored as PostgreSQL Int values.
const TICKET_NUMBER_MAX = 2_147_483_647;
export const TICKET_COMMENT_MAX_LENGTH = 10_000;

const TicketPrefixSchema = z
  .string()
  .trim()
  .min(1)
  .max(TICKET_PREFIX_MAX_LENGTH)
  .regex(
    /^[A-Za-z][A-Za-z0-9]*$/,
    "Prefix must start with a letter and contain only letters and digits",
  );

export function ticketRef(prefix: string, number: number): string {
  return `${prefix}-${number}`;
}

export function parseTicketRef(
  value: string,
  expectedPrefix?: string,
): { prefix: string; number: number } | null {
  const match = /^([A-Za-z][A-Za-z0-9]*)-([1-9][0-9]*)$/.exec(value.trim());
  if (!match) return null;
  const [, rawPrefix, rawNumber] = match;
  if (!rawPrefix || !rawNumber) return null;
  const prefix = rawPrefix.toUpperCase();
  if (expectedPrefix !== undefined && prefix !== expectedPrefix.trim().toUpperCase()) return null;
  const number = Number(rawNumber);
  if (number > TICKET_NUMBER_MAX) return null;
  return { prefix, number };
}

export const BoardSchema = z.object({
  id: Id,
  spaceId: Id,
  name: z.string(),
  ticketPrefix: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Board = z.infer<typeof BoardSchema>;

export const RenameBoardInput = z
  .object({
    name: z.string().trim().min(1).max(80).optional(),
    ticketPrefix: TicketPrefixSchema.optional(),
  })
  .refine((value) => value.name !== undefined || value.ticketPrefix !== undefined, {
    message: "Provide a name or ticketPrefix",
  });
export type RenameBoardInput = z.infer<typeof RenameBoardInput>;

export const TicketCommentSchema = z.object({
  id: Id,
  ticketId: Id,
  body: z.string(),
  authorBotId: Id.nullable(),
  authorUserId: Id.nullable(),
  authorName: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type TicketComment = z.infer<typeof TicketCommentSchema>;

export const TicketSchema = z.object({
  id: Id,
  boardId: Id,
  spaceId: Id,
  number: z.number().int().positive(),
  ref: z.string(),
  title: z.string(),
  description: z.string().nullable(),
  status: TicketStatusSchema,
  priority: TicketPrioritySchema,
  assigneeBotId: Id.nullable(),
  createdByBotId: Id.nullable(),
  createdByUserId: Id.nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  completedAt: z.string().nullable(),
});
export type Ticket = z.infer<typeof TicketSchema>;

export const ListTicketsInput = z.object({
  boardId: Id.optional(),
  status: TicketStatusSchema.optional(),
  assigneeBotId: Id.optional(),
  q: z.string().trim().max(200).optional(),
});
export type ListTicketsInput = z.infer<typeof ListTicketsInput>;

export const ListTicketsOutput = z.object({ tickets: z.array(TicketSchema) });
export type ListTicketsOutput = z.infer<typeof ListTicketsOutput>;

export const GetTicketInput = z
  .object({
    id: Id.optional(),
    ref: z.string().trim().min(1).max(120).optional(),
  })
  .refine((value) => Boolean(value.id) !== Boolean(value.ref), {
    message: "Provide exactly one of id or ref",
  });
export type GetTicketInput = z.infer<typeof GetTicketInput>;

export const CreateTicketInput = z.object({
  boardId: Id.optional(),
  title: z.string().trim().min(1).max(TICKET_TITLE_MAX_LENGTH),
  description: z.string().max(TICKET_DESCRIPTION_MAX_LENGTH).optional(),
  priority: TicketPrioritySchema.default(DEFAULT_TICKET_PRIORITY),
  assigneeBotId: Id,
});
export type CreateTicketInput = z.infer<typeof CreateTicketInput>;

export const UpdateTicketInput = z.object({
  id: Id,
  title: z.string().trim().min(1).max(TICKET_TITLE_MAX_LENGTH).optional(),
  description: z.string().max(TICKET_DESCRIPTION_MAX_LENGTH).nullable().optional(),
  priority: TicketPrioritySchema.nullable().optional(),
  status: TicketStatusSchema.optional(),
  assigneeBotId: Id.optional(),
});
export type UpdateTicketInput = z.infer<typeof UpdateTicketInput>;

export const MoveTicketInput = z.object({
  id: Id,
  status: TicketStatusSchema,
});
export type MoveTicketInput = z.infer<typeof MoveTicketInput>;

export const CommentTicketInput = z.object({
  ticketId: Id,
  body: z.string().trim().min(1).max(TICKET_COMMENT_MAX_LENGTH),
});
export type CommentTicketInput = z.infer<typeof CommentTicketInput>;

export const BoardEventSchema = z.object({
  spaceId: Id,
  boardId: Id.optional(),
  ticketId: Id.optional(),
  createdAt: z.string(),
});
export type BoardEvent = z.infer<typeof BoardEventSchema>;

export const WORK_PHASES = [
  "ready",
  "running",
  "waiting",
  "review",
  "done",
  "failed",
  "cancelled",
] as const;
export const WorkPhaseSchema = z.enum(WORK_PHASES);
export type WorkPhase = z.infer<typeof WorkPhaseSchema>;

const ACTIVE_RUN_STATUSES = new Set(["queued", "leased", "running"]);
const WAITING_RUN_STATUSES = new Set(["waiting_input", "waiting_takeover"]);

/**
 * Where a ticket stands as a unit of work. The ticket's status is what people and
 * the bot set; the latest linked run decides whether it is running, waiting or failed.
 */
export function workPhase(status: TicketStatus, latestRunStatus: string | null): WorkPhase {
  if (status === "closed") return "cancelled";
  if (status === "done") return "done";
  if (latestRunStatus && ACTIVE_RUN_STATUSES.has(latestRunStatus)) return "running";
  if (latestRunStatus && WAITING_RUN_STATUSES.has(latestRunStatus)) return "waiting";
  if (status === "review") return "review";
  if (latestRunStatus === "completed") return "review";
  if (latestRunStatus === "failed") return "failed";
  if (status === "blocked") return "waiting";
  return status === "doing" ? "running" : "ready";
}

export const WorkRunSchema = z.object({
  id: Id,
  status: z.string(),
  trigger: z.string(),
  error: z.string().nullable(),
  threadId: Id,
  createdAt: z.string(),
  completedAt: z.string().nullable(),
});
export type WorkRun = z.infer<typeof WorkRunSchema>;

export const WorkArtifactSchema = z.object({
  id: Id,
  name: z.string(),
  mimeType: z.string(),
  version: z.number().int(),
  runId: Id,
  createdAt: z.string(),
});
export type WorkArtifact = z.infer<typeof WorkArtifactSchema>;

export const TicketWorkSchema = z.object({
  ticketId: Id,
  phase: WorkPhaseSchema,
  runs: z.array(WorkRunSchema),
  artifacts: z.array(WorkArtifactSchema),
});
export type TicketWork = z.infer<typeof TicketWorkSchema>;

/** A ticket with its phase: the read model other surfaces (dashboards, mobile) list. */
export const WorkItemSchema = TicketSchema.extend({ phase: WorkPhaseSchema });
export type WorkItem = z.infer<typeof WorkItemSchema>;
