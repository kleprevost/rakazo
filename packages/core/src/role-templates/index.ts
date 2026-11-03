import type { Policy, RoleTemplate, RoleTemplateBlock } from "@rakazo/contracts";
import { BOT_INSTRUCTIONS_MAX_LENGTH, RoleTemplateSchema } from "@rakazo/contracts";
import { evaluateBotCapability } from "../policy-capabilities.js";
import { evaluateToolUse } from "../policy-tools.js";
import chiefOfStaff from "./templates/chief-of-staff.json" with { type: "json" };
import executiveAssistant from "./templates/executive-assistant.json" with { type: "json" };
import operationsAssistant from "./templates/operations-assistant.json" with { type: "json" };
import researchAnalyst from "./templates/research-analyst.json" with { type: "json" };

/**
 * The built-in catalog. A template is data validated by `RoleTemplateSchema`; an installed
 * catalog (for example an admin's own) can later be merged in here without touching callers.
 */
export const ROLE_TEMPLATES: readonly RoleTemplate[] = [
  executiveAssistant,
  chiefOfStaff,
  researchAnalyst,
  operationsAssistant,
].map((data) => RoleTemplateSchema.parse(data));

export function findRoleTemplate(id: string): RoleTemplate | undefined {
  return ROLE_TEMPLATES.find((template) => template.id === id);
}

/**
 * What central policy refuses in a template. Hiring leaves these parts out rather than asking
 * for what policy forbids. Connections are provider-neutral kinds, so policy can only refuse
 * them all (an empty `allowConnectors`); the connection itself is still checked when made.
 */
export function evaluateRoleTemplate(
  policy: Policy | undefined,
  template: RoleTemplate,
): RoleTemplateBlock[] {
  const blocked: RoleTemplateBlock[] = [];
  if (template.routines.length) {
    const decision = evaluateBotCapability(policy, "routines");
    if (!decision.allowed) blocked.push({ part: "routines", ref: "", rule: decision.rule });
  }
  for (const tool of template.tools) {
    const decision = evaluateToolUse(policy, [tool]);
    if (!decision.allowed) blocked.push({ part: "tool", ref: tool, rule: decision.rule });
  }
  if (policy?.integrations?.allowConnectors?.length === 0) {
    for (const connection of template.connections) {
      blocked.push({
        part: "connection",
        ref: connection.kind,
        rule: "integrations.allowConnectors",
      });
    }
  }
  return blocked;
}

/** The bot's instructions: the template's, plus its approval defaults as a standing rule. */
export function roleTemplateInstructions(template: RoleTemplate): string {
  const asks = template.approvals.askBefore;
  const text = asks.length
    ? `${template.instructions}\n\nAlways ask me and wait for a yes before you: ${asks.join("; ")}.`
    : template.instructions;
  return text.slice(0, BOT_INSTRUCTIONS_MAX_LENGTH);
}
