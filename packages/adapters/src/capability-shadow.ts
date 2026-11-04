import type { ConnectorRoute, ConnectorTool } from "@rakazo/adapter-kit";
import type { Policy } from "@rakazo/contracts";
import { isBuiltinToolName } from "@rakazo/contracts";
import type { CapabilityTraceEntry, ClassifyInput } from "@rakazo/core";
import { recordAuditEvent } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import type { DecisionInput } from "./capability-decision.js";
import { enforcing, evaluateBotCall } from "./capability-decision.js";
import { activePolicy } from "./policy-runtime.js";

/*
 * Shadow mode of the capability broker: at the enforcement points, run the real evaluator over
 * the real grants and record what it WOULD decide. Nothing here changes what a call does, and a
 * failure to evaluate or record is logged and dropped. Enforcement is `capability-enforce.ts`.
 */

export const SHADOW_AUDIT_ACTION = "capability.shadow";

/** Shadow records only for a bot opted in; once enforcing, the denial itself is the record. */
function shadowMode(mode: string | null | undefined, policy: Policy | undefined) {
  return mode === "shadow" && !enforcing(mode, policy) ? mode : null;
}

const READ_WINDOW_MS = 10 * 60_000;
const MAX_SEEN = 5_000;
const seen = new Map<string, number>();

/**
 * Whether an allowed read of these scopes was already recorded for this run (or, outside a run,
 * for this bot in the last few minutes). Denials, asks and non-read allows are never sampled.
 */
function readAlreadyRecorded(key: string, perRun: boolean, now: number): boolean {
  const at = seen.get(key);
  if (at !== undefined && (perRun || now - at < READ_WINDOW_MS)) return true;
  seen.delete(key);
  seen.set(key, now);
  if (seen.size > MAX_SEEN) seen.delete(seen.keys().next().value as string);
  return false;
}

const READ_VERBS = new Set(["read", "fetch"]);

function onlyReads(scopes: readonly string[]): boolean {
  return scopes.every((scope) => READ_VERBS.has(scope.split(".").at(-1) ?? ""));
}

/** Compact, content-free: layer, rule, scope, effect. Never arguments, resources or credentials. */
export function formatTrace(trace: readonly CapabilityTraceEntry[]): string {
  return trace
    .map((entry) =>
      [
        entry.layer,
        entry.rule,
        entry.scope,
        entry.effect,
        entry.detail && entry.layer !== "quarantine" ? entry.detail : undefined,
      ]
        .filter(Boolean)
        .join(":"),
    )
    .join(" ");
}

/**
 * What the classifier needs from a connector call. `tool` is the resolved catalog entry when the
 * caller has it (the run gate does; a routine watch does not). Declared effects and annotations
 * only ever tighten a classification.
 */
export function classifyInputForCall(call: {
  name: string;
  args: Record<string, unknown>;
  route?: ConnectorRoute | undefined;
  tool?: Pick<ConnectorTool, "readOnly"> | undefined;
  /** The app slug for a managed connector tool. */
  appSlug?: string | undefined;
  /** The connected account the call names when its route does not. */
  connectionId?: string | undefined;
  batchActions?: ReadonlyArray<string | undefined> | undefined;
}): ClassifyInput {
  const { route, tool } = call;
  const common = { args: call.args, batchActions: call.batchActions };
  const toolName = route?.toolName ?? call.name;
  if (route?.connectorId === "mcp") {
    return {
      ...common,
      source: "mcp",
      tool: toolName,
      slug: route.catalogGroup,
      serverId: route.resourceId,
      annotations: tool?.readOnly === undefined ? undefined : { readOnlyHint: tool.readOnly },
    };
  }
  if (route?.connectorId === "installed") {
    return {
      ...common,
      source: "installed",
      tool: toolName,
      slug: route.catalogGroup,
      serverId: route.resourceId,
      effect: tool?.readOnly === undefined ? undefined : tool.readOnly ? "read" : "write",
    };
  }
  return {
    ...common,
    source: "connector",
    tool: toolName,
    slug: call.appSlug ?? route?.connectorId,
    connectionId: route?.connectionId ?? call.connectionId,
  };
}

/**
 * Whether a tool name is a first-party tool: one of the contract's built-in names with no
 * connector route (the built-in catalog's own route counts as none). A connector tool can never
 * borrow a built-in's scopes by taking its name. A test keeps the contract list equal to the
 * tools the adapters offer, so a new built-in cannot fall through to the connector fallback.
 */
export function isBuiltinCall(name: string, route: ConnectorRoute | undefined): boolean {
  return isBuiltinToolName(name) && (!route || route.connectorId === "builtin");
}

/** `classifyInputForCall` for any tool the gate sees, built-in or connector. */
export function classifyInputForTool(
  call: Parameters<typeof classifyInputForCall>[0],
): ClassifyInput {
  return isBuiltinCall(call.name, call.route)
    ? { source: "builtin", tool: call.name, args: call.args }
    : classifyInputForCall(call);
}

export type ShadowInput = DecisionInput & { surface: "gate" | "connector" };

/**
 * Evaluate one call and append a `capability.shadow` audit event with the would-be outcome, the
 * deciding rule, the scopes and a compact rule trace. Records every deny, ask and non-read allow,
 * and the first read allow per run. Never throws and never alters the call.
 */
export async function recordShadowDecision(input: ShadowInput): Promise<void> {
  const policy = input.policy ?? activePolicy();
  const mode = shadowMode(input.bot.capabilityMode, policy);
  if (!mode) return;
  try {
    const { bot, call } = input;
    const decision = await evaluateBotCall({ ...input, policy });
    const { scopes, basis, unmapped } = decision.classification;
    if (
      decision.outcome === "allow" &&
      onlyReads(scopes) &&
      readAlreadyRecorded(
        `${input.runId ?? bot.id}:${scopes.join(",")}`,
        Boolean(input.runId),
        Date.now(),
      )
    ) {
      return;
    }
    await recordAuditEvent({
      action: SHADOW_AUDIT_ACTION,
      actor: { type: "bot", id: bot.id, label: bot.name },
      spaceId: input.spaceId,
      target: { type: "tool", id: call.tool },
      outcome: "success",
      runId: input.runId,
      threadId: input.threadId,
      metadata: {
        mode,
        surface: input.surface,
        decision: decision.outcome,
        rule: decision.rule,
        scopes: scopes.join(","),
        basis,
        unmapped,
        source: call.source,
        trace: formatTrace(decision.trace),
      },
    });
  } catch (error) {
    getLogger().error("capability shadow failed", error instanceof Error ? error.message : "error");
  }
}
