import * as z from "zod";

/**
 * What one firing of a routine came to. Decided from structured signals only: a run's status,
 * the change check's result, tool errors, and whether the model chose to say anything.
 *
 * - `no_change`: a clean check with nothing to report. Stays quiet.
 * - `action_needed`: the check found something and the bot told the user.
 * - `failed`: the check could not be completed (source or provider error). Never a clean check.
 * - `missed`: a scheduled firing that did not run.
 */
export const ROUTINE_RECEIPT_OUTCOMES = ["no_change", "action_needed", "failed", "missed"] as const;
export const RoutineReceiptOutcomeSchema = z.enum(ROUTINE_RECEIPT_OUTCOMES);
export type RoutineReceiptOutcome = z.infer<typeof RoutineReceiptOutcomeSchema>;

/** Quiet receipts older than this are pruned; exceptions and action receipts are kept. */
export const ROUTINE_RECEIPT_QUIET_DAYS = 35;
