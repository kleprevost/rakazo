import { recordSecurityEvent } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import type { DecisionInput } from "./capability-decision.js";
import { enforcing, evaluateBotCall } from "./capability-decision.js";
import { recordShadowDecision } from "./capability-shadow.js";
import { activePolicy } from "./policy-runtime.js";

export type CapabilityVerdict = { outcome: "allow" | "ask" | "deny"; rule?: string | undefined };

export type EnforceInput = DecisionInput & {
  /**
   * `gate` decides before approval, `recheck` runs at the instant before the effect (after any
   * approval wait), `connector` covers callers that never reach the gate.
   */
  surface: "gate" | "recheck" | "connector";
};

const ALLOW: CapabilityVerdict = { outcome: "allow" };

/**
 * The capability broker at one enforcement point. Off does nothing, shadow records what it would
 * decide and allows, enforce returns the real verdict. A failure to evaluate under enforcement
 * is a denial: the broker never fails open. A refusal is one `capability.denied` security event
 * with the surface, deciding rule and scopes only: no arguments, resources or content.
 */
export async function capabilityGate(input: EnforceInput): Promise<CapabilityVerdict> {
  const policy = input.policy ?? activePolicy();
  const { surface, ...decisionInput } = input;
  if (!enforcing(input.bot.capabilityMode, policy)) {
    if (surface !== "recheck") {
      await recordShadowDecision({ ...decisionInput, surface: surface, policy });
    }
    return ALLOW;
  }
  let verdict: CapabilityVerdict;
  let scopes = "";
  try {
    const decision = await evaluateBotCall({ ...decisionInput, policy });
    verdict = { outcome: decision.outcome, rule: decision.rule };
    scopes = decision.classification.scopes.join(",");
  } catch (error) {
    getLogger().error("capability check failed", error instanceof Error ? error.message : "error");
    verdict = { outcome: "deny", rule: "evaluation_failed" };
  }
  if (verdict.outcome === "deny") {
    await recordSecurityEvent({
      type: "capability.denied",
      userId: input.userId,
      spaceId: input.spaceId,
      metadata: { botId: input.bot.id, surface, rule: verdict.rule, scopes },
    });
  }
  return verdict;
}
