import type { Policy } from "@rakazo/contracts";
import type { PolicyDecision } from "./policy.js";

const ALLOWED: PolicyDecision = { allowed: true };

/** The sandbox kind that is the user's own computer (the desktop app's host computer). */
export const HOST_COMPUTER_KIND = "desktop";

/** Bot capabilities a policy can switch off. */
export type BotCapability = "fleetManagement" | "subagents" | "webhooks" | "routines";

const BOT_CAPABILITY_RULES: Record<BotCapability, keyof NonNullable<Policy["bots"]>> = {
  fleetManagement: "allowFleetManagement",
  subagents: "allowSubagents",
  webhooks: "allowWebhooks",
  routines: "allowRoutines",
};

/**
 * Whether a computer may start on `kind`. The host computer is governed by
 * `computers.allowHostComputer`; every kind (the host computer included) must also be listed
 * in `computers.allowProviders` when that list is set.
 */
export function evaluateComputerKind(policy: Policy | undefined, kind: string): PolicyDecision {
  const computers = policy?.computers;
  if (!computers) return ALLOWED;
  if (kind === HOST_COMPUTER_KIND && computers.allowHostComputer === false)
    return { allowed: false, rule: "computers.allowHostComputer" };
  if (computers.allowProviders && !computers.allowProviders.includes(kind))
    return { allowed: false, rule: "computers.allowProviders" };
  return ALLOWED;
}

/** Whether the user's own computer may be paired, connected or used. */
export function evaluateHostComputer(policy: Policy | undefined): PolicyDecision {
  return evaluateComputerKind(policy, HOST_COMPUTER_KIND);
}

export function evaluateBotCapability(
  policy: Policy | undefined,
  capability: BotCapability,
): PolicyDecision {
  const key = BOT_CAPABILITY_RULES[capability];
  return policy?.bots?.[key] === false ? { allowed: false, rule: `bots.${key}` } : ALLOWED;
}

/**
 * Built-in tools a bot capability governs: helper and child-bot tools, the fleet tools
 * (`FLEET_TOOL_NAMES`, minus the routine one that `routines` also covers) and routine creation.
 */
const CAPABILITY_TOOLS: Record<BotCapability, readonly string[]> = {
  fleetManagement: [
    "list_fleet",
    "create_group",
    "update_group",
    "organize_bot",
    "set_child_instructions",
    "set_child_bot_model",
    "archive_bot",
    "create_child_routine",
  ],
  subagents: ["run_subagent", "spawn_bot"],
  webhooks: [],
  routines: ["schedule_create", "schedule_update", "create_child_routine"],
};

/** The decision for one built-in tool name, or allowed when no bot capability governs it. */
export function evaluateBotTool(policy: Policy | undefined, toolName: string): PolicyDecision {
  for (const capability of Object.keys(CAPABILITY_TOOLS) as BotCapability[]) {
    if (!CAPABILITY_TOOLS[capability].includes(toolName)) continue;
    const decision = evaluateBotCapability(policy, capability);
    if (!decision.allowed) return decision;
  }
  return ALLOWED;
}

/** The capability a run trigger depends on, if any: routine and webhook runs. */
export function evaluateRunTrigger(policy: Policy | undefined, trigger: string): PolicyDecision {
  if (trigger === "routine") return evaluateBotCapability(policy, "routines");
  if (trigger === "webhook") return evaluateBotCapability(policy, "webhooks");
  return ALLOWED;
}

/**
 * External messaging surfaces are chat apps, named by their provider id (`slack`, `telegram`,
 * ...). The Rakazo app itself (`web`, `desktop`, `mobile`) is never one of them and is always
 * allowed, so those entries in the list have no effect. No list means any surface.
 */
export function evaluateMessagingSurface(
  policy: Policy | undefined,
  surface: string,
): PolicyDecision {
  const allowed = policy?.messaging?.allowSurfaces;
  if (!allowed) return ALLOWED;
  return allowed.includes(surface) ? ALLOWED : { allowed: false, rule: "messaging.allowSurfaces" };
}

export function evaluateAccountExport(policy: Policy | undefined): PolicyDecision {
  return policy?.data?.allowAccountExport === false
    ? { allowed: false, rule: "data.allowAccountExport" }
    : ALLOWED;
}
