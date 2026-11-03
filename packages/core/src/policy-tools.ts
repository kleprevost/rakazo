import type { Policy } from "@rakazo/contracts";
import type { ApprovalMode } from "./action-approval.js";
import type { PolicyDecision } from "./policy.js";
import { policyGlobMatches } from "./policy.js";

/*
 * Tool ids are the names the approval Allow/Block lists use: a built-in tool's name
 * (`computer_shell`), or an installed connector tool's name. A call may carry several (the
 * model-facing name, the connector's own tool name, each action of a batch); one match is enough.
 * Globs are case-insensitive: `*` any run, `?` one character.
 */

function matchesAny(globs: readonly string[] | undefined, ids: readonly string[]): boolean {
  return Boolean(globs?.some((glob) => ids.some((id) => policyGlobMatches(glob, id))));
}

/** Whether any of a call's tool ids is refused everywhere. */
export function evaluateToolUse(
  policy: Policy | undefined,
  ids: readonly string[],
): PolicyDecision {
  return matchesAny(policy?.tools?.deny, ids)
    ? { allowed: false, rule: "tools.deny" }
    : { allowed: true };
}

/** Whether a call always shows an approval card, in every mode and whatever Always allow says. */
export function toolAlwaysAsks(policy: Policy | undefined, ids: readonly string[]): boolean {
  return matchesAny(policy?.approvals?.alwaysAsk, ids);
}

/** Drop the tools the model must not be offered. */
export function filterOfferedTools<T extends { name: string }>(
  policy: Policy | undefined,
  tools: T[],
): T[] {
  if (!policy?.tools?.deny?.length) return tools;
  return tools.filter((tool) => evaluateToolUse(policy, [tool.name]).allowed);
}

// Strictest first: a floor forbids every mode after it.
const STRICTNESS: readonly ApprovalMode[] = ["ask", "auto", "never"];

/** The mode a run uses: the chosen one, or the policy floor when the choice is looser. */
export function clampApprovalMode(policy: Policy | undefined, mode: ApprovalMode): ApprovalMode {
  const floor = policy?.approvals?.minimumMode;
  if (!floor) return mode;
  return STRICTNESS.indexOf(mode) > STRICTNESS.indexOf(floor) ? floor : mode;
}

/** Whether saving `mode` is allowed. */
export function evaluateApprovalMode(
  policy: Policy | undefined,
  mode: ApprovalMode,
): PolicyDecision {
  return clampApprovalMode(policy, mode) === mode
    ? { allowed: true }
    : { allowed: false, rule: "approvals.minimumMode" };
}
