import type {
  AdapterContext,
  ConnectorCall,
  ConnectorEvent,
  ConnectorProvider,
  ConnectorTool,
  ManagedConnectorProvider,
} from "@rakazo/adapter-kit";
import {
  BOT_QUARANTINED_MESSAGE,
  BOT_SUSPENDED_MESSAGE,
  CAPABILITY_DENIED_MESSAGE,
} from "@rakazo/contracts";
import { connectorKindFromToolName } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import { activeQuarantine, recordAuditEvent } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import { capabilityGate } from "./capability-enforce.js";
import { classifyInputForCall } from "./capability-shadow.js";
import type { ConnectorRegistry } from "./composio-connector.js";
import { assertConnectorAllowed } from "./policy-integrations.js";
import { PolicyDeniedError } from "./policy-runtime.js";
import { assertToolAllowed, policyBlockedToolMessage } from "./policy-tools.js";

type BotReader = Pick<PrismaClient, "bot" | "quarantine" | "capabilityGrant">;

type BotState = {
  blocked: BotBlock | null;
  name: string;
  /** Read with the same row, so the shadow check needs no second lookup. */
  capabilityMode: string | null;
  employeeId: string | null;
};

export type BotBlock = "suspended" | "quarantined";

/** The refusal a blocked bot gets, shared by every gate. */
export const botBlockMessage = (blocked: BotBlock) =>
  blocked === "quarantined" ? BOT_QUARANTINED_MESSAGE : BOT_SUSPENDED_MESSAGE;

/**
 * Whether the bot is suspended or quarantined right now. Reads the rows, never cached: the call
 * it protects is a network round trip, and a cached answer is how a stopped bot keeps acting.
 * Fails closed: a missing bot or a failed read counts as suspended.
 */
export async function botBlockedNow(
  prisma: Pick<PrismaClient, "bot" | "quarantine">,
  botId: string | undefined,
): Promise<BotState> {
  const failed: BotState = {
    blocked: "suspended",
    name: "Bot",
    capabilityMode: null,
    employeeId: null,
  };
  if (!botId) return failed;
  try {
    const bot = await prisma.bot.findUnique({
      where: { id: botId },
      select: {
        suspendedAt: true,
        name: true,
        spaceId: true,
        capabilityMode: true,
        employeeId: true,
        groupMembers: { select: { groupId: true } },
      },
    });
    if (!bot) return failed;
    const state = {
      name: bot.name,
      capabilityMode: bot.capabilityMode ?? null,
      employeeId: bot.employeeId ?? null,
    };
    if (bot.suspendedAt) return { ...state, blocked: "suspended" };
    const quarantine = await activeQuarantine(prisma, {
      id: botId,
      spaceId: bot.spaceId,
      groupIds: bot.groupMembers.map((member) => member.groupId),
    });
    return { ...state, blocked: quarantine ? "quarantined" : null };
  } catch (error) {
    getLogger().error("suspension check failed", error instanceof Error ? error.message : "error");
    return failed;
  }
}

/**
 * The one enforcement point for connector tools. Every caller that reaches a connector goes
 * through `execute` here, runs and routine watches alike, so suspension, quarantine and central policy
 * apply the same way to both: the bot is not suspended, the tool is not denied, and the
 * connected app is allowed.
 */
export class BrokeredConnector implements ConnectorProvider {
  constructor(
    private readonly inner: ConnectorRegistry,
    private readonly prisma: BotReader,
  ) {}

  describe() {
    return this.inner.describe();
  }

  discoverTools(context: AdapterContext): Promise<ConnectorTool[]> {
    return this.inner.discoverTools(context);
  }

  resolveCall(call: ConnectorCall, context: AdapterContext) {
    return this.inner.resolveCall(call, context);
  }

  endRun(runId: string): void {
    this.inner.endRun(runId);
  }

  managed(id: string): ManagedConnectorProvider | undefined {
    return this.inner.managed(id);
  }

  managedProviders(): ManagedConnectorProvider[] {
    return this.inner.managedProviders();
  }

  async *execute(call: ConnectorCall, context: AdapterContext): AsyncIterable<ConnectorEvent> {
    const refusal = await this.refusal(call, context);
    if (refusal) {
      yield { type: "error", message: refusal };
      return;
    }
    yield* this.inner.execute(call, context);
  }

  private async refusal(call: ConnectorCall, context: AdapterContext): Promise<string | undefined> {
    const state = await botBlockedNow(this.prisma, context.botId);
    const { blocked, name } = state;
    if (blocked) {
      await this.audit(call, context, name, blocked);
      return botBlockMessage(blocked);
    }
    const audience = {
      userId: context.userId,
      spaceId: context.spaceId,
      surface: context.runId ? "run" : "routine",
    };
    const toolName = call.route?.toolName ?? call.tool;
    try {
      await assertToolAllowed([...new Set([call.tool, toolName])], call.tool, audience);
      const app = connectedApp(call, toolName, context);
      if (app) await assertConnectorAllowed(app, audience);
    } catch (error) {
      if (!(error instanceof PolicyDeniedError)) throw error;
      await this.audit(call, context, name, "policy");
      return policyBlockedToolMessage(call.tool);
    }
    // A run's own tool calls were evaluated at the gate and are rechecked before the effect; this
    // covers the callers that reach a connector without either (routine watches).
    if (!context.runId && context.botId) {
      const verdict = await capabilityGate({
        prisma: this.prisma,
        bot: {
          id: context.botId,
          name,
          capabilityMode: state.capabilityMode,
          employeeId: state.employeeId,
        },
        spaceId: context.spaceId,
        userId: context.userId,
        surface: "connector",
        connections: context.connectedConnections,
        call: classifyInputForCall({
          name: call.tool,
          args: call.args,
          route: call.route,
          appSlug: connectedApp(call, toolName, context),
          connectionId: call.connectionId,
        }),
      });
      // A watch has no one to ask, so an ask is a refusal.
      if (verdict.outcome !== "allow") {
        await this.audit(call, context, name, "capability");
        return CAPABILITY_DENIED_MESSAGE;
      }
    }
    return undefined;
  }

  private audit(call: ConnectorCall, context: AdapterContext, name: string, reason: string) {
    return recordAuditEvent({
      action: "tool.call",
      actor: { type: "bot", id: context.botId ?? "unknown", label: name },
      spaceId: context.spaceId,
      target: { type: "tool", id: call.tool },
      outcome: "denied",
      runId: context.runId,
      metadata: { reason },
    });
  }
}

/** The connected app slug this call uses, when it is one of the run's connected accounts. */
function connectedApp(
  call: ConnectorCall,
  toolName: string,
  context: AdapterContext,
): string | undefined {
  const connections = context.connectedConnections ?? [];
  const connectionId = call.route?.connectionId ?? call.connectionId;
  const byId = connectionId
    ? connections.find((connection) => connection.id === connectionId)
    : undefined;
  if (byId) return byId.externalId;
  const kind = connectorKindFromToolName(
    toolName,
    connections.map((connection) => connection.externalId),
  );
  return connections.some((connection) => connection.externalId.toLowerCase() === kind)
    ? kind
    : undefined;
}
