import type { ApprovalMode } from "@rakazo/core";
import {
  approvalModeFromPreference,
  approvalPreferenceFromMode,
  clampApprovalMode,
  evaluateApprovalMode,
  evaluateToolUse,
  filterOfferedTools,
  toolAlwaysAsks,
} from "@rakazo/core";
import { recordSecurityEvent } from "@rakazo/db";
import { activePolicy, PolicyDeniedError } from "./policy-runtime.js";

type Audience = { userId?: string; spaceId?: string; surface: string };

async function deny(rule: string, subject: string, audience: Audience): Promise<never> {
  await recordSecurityEvent({
    type: "policy.denied",
    userId: audience.userId,
    spaceId: audience.spaceId,
    metadata: { rule, subject, surface: audience.surface },
  });
  throw new PolicyDeniedError(rule, subject);
}

/**
 * Refuse a tool call the policy forbids; records one `policy.denied` event. `ids` are every name
 * the call goes by (see `evaluateToolUse`). No-op without policy.
 */
export async function assertToolAllowed(
  ids: readonly string[],
  subject: string,
  audience: Audience,
): Promise<void> {
  const decision = evaluateToolUse(activePolicy(), ids);
  if (!decision.allowed) await deny(decision.rule, subject, audience);
}

/** What a bot is told when the policy refuses one of its tool calls. */
export function policyBlockedToolMessage(name: string): string {
  return `${name} is blocked by your organization. Don't try it another way; tell the user it's blocked.`;
}

/** Refuse saving an approval mode looser than the policy floor. */
export async function assertApprovalModeAllowed(
  mode: ApprovalMode,
  audience: Audience,
): Promise<void> {
  const decision = evaluateApprovalMode(activePolicy(), mode);
  if (!decision.allowed) await deny(decision.rule, mode, audience);
}

/** The stored approval preference as it applies at run time, clamped to the policy floor. */
export function effectiveApprovalPreference(preference: {
  enabled: boolean;
  skipApprovals: boolean;
}): { enabled: boolean; skipApprovals: boolean } {
  return approvalPreferenceFromMode(
    clampApprovalMode(activePolicy(), approvalModeFromPreference(preference)),
  );
}

/** Whether the policy makes this call show an approval card in every mode. */
export function policyAlwaysAsks(ids: readonly string[]): boolean {
  return toolAlwaysAsks(activePolicy(), ids);
}

/** The tools the model may be offered. */
export function policyOfferedTools<T extends { name: string }>(tools: T[]): T[] {
  return filterOfferedTools(activePolicy(), tools);
}
