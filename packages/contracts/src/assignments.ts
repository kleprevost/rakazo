import * as z from "zod";
import type { TicketStatus, WorkPhase } from "./board.js";
import { WorkArtifactSchema, WorkPhaseSchema, WorkRunSchema, workPhase } from "./board.js";
import { Id } from "./ids.js";

export const ASSIGNMENT_TITLE_MAX_LENGTH = 200;
export const ASSIGNMENT_BRIEF_MAX_LENGTH = 20_000;
export const ASSIGNMENT_LIST_MAX = 100;

/**
 * Where an assignment stands. Nothing is stored: the linked ticket, cancellation and the newest
 * run in the assignment's thread decide, so paths that change runs cannot leave it stale. A
 * standalone assignment reads as a ticket still `todo` until its runs say otherwise.
 */
export function assignmentPhase(input: {
  cancelledAt: Date | string | null;
  ticketStatus: TicketStatus | null;
  latestRunStatus: string | null;
}): WorkPhase {
  if (input.cancelledAt) return "cancelled";
  return workPhase(input.ticketStatus ?? "todo", input.latestRunStatus);
}

export const AssignmentSchema = z.object({
  id: Id,
  botId: Id,
  threadId: Id,
  ticketId: Id.nullable(),
  title: z.string(),
  phase: WorkPhaseSchema,
  cancelledAt: z.string().nullable(),
  archivedAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Assignment = z.infer<typeof AssignmentSchema>;

/** One assignment with the runs in its thread and the files those runs produced. */
export const AssignmentWorkSchema = AssignmentSchema.extend({
  runs: z.array(WorkRunSchema),
  artifacts: z.array(WorkArtifactSchema),
});
export type AssignmentWork = z.infer<typeof AssignmentWorkSchema>;

/** `clientNonce` makes a retried create return the first assignment instead of a second one. */
export const CreateAssignmentInput = z.object({
  botId: Id,
  title: z.string().trim().min(1).max(ASSIGNMENT_TITLE_MAX_LENGTH),
  brief: z.string().trim().min(1).max(ASSIGNMENT_BRIEF_MAX_LENGTH),
  clientNonce: z.string().min(1).max(200),
});
export type CreateAssignmentInput = z.infer<typeof CreateAssignmentInput>;

export const ListAssignmentsInput = z.object({
  botId: Id.optional(),
  state: z.enum(["active", "archived"]).default("active"),
  cursor: z.string().max(200).optional(),
  limit: z.number().int().min(1).max(ASSIGNMENT_LIST_MAX).default(50),
});
export type ListAssignmentsInput = z.infer<typeof ListAssignmentsInput>;

export const ListAssignmentsOutput = z.object({
  items: z.array(AssignmentSchema),
  nextCursor: z.string().nullable(),
});
export type ListAssignmentsOutput = z.infer<typeof ListAssignmentsOutput>;

export const GetAssignmentInput = z.object({ assignmentId: Id });
export type GetAssignmentInput = z.infer<typeof GetAssignmentInput>;

/**
 * An instruction for the job while it works. `clientNonce` makes a retry return the first answer
 * instead of queueing the instruction twice.
 */
export const SteerAssignmentInput = z.object({
  assignmentId: Id,
  text: z.string().trim().min(1).max(ASSIGNMENT_BRIEF_MAX_LENGTH),
  clientNonce: z.string().min(1).max(200),
});
export type SteerAssignmentInput = z.infer<typeof SteerAssignmentInput>;

/** The run that will read the instruction: the live one, or the one started for it. */
export const SteerAssignmentOutput = z.object({ messageId: Id, runId: Id });
export type SteerAssignmentOutput = z.infer<typeof SteerAssignmentOutput>;
