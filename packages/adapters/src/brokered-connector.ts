import type {
  AdapterContext,
  ConnectorCall,
  ConnectorEvent,
  ConnectorProvider,
  ConnectorTool,
  ManagedConnectorProvider,
} from "@rakazo/adapter-kit";
import { BOT_QUARANTINED_MESSAGE, BOT_SUSPENDED_MESSAGE } from "@rakazo/contracts";
import { connectorKindFromToolName } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import { activeQuarantine, recordAuditEvent } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import type { ConnectorRegistry } from "./composio-connector.js";
import { assertConnectorAllowed } from "./policy-integrations.js";
import { PolicyDeniedError } from "./policy-runtime.js";
import { assertToolAllowed, policyBlockedToolMessage } from "./policy-tools.js";

type BotReader = Pick<PrismaClient, "bot" | "quarantine">;

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
  prisma: BotReader,
  botId: string | undefined,
): Promise<{ blocked: BotBlock | null; name: string }> {
  if (!botId) return { blocked: "suspended", name: "Bot" };
  try {
    const bot = await prisma.bot.findUnique({
      where: { id: botId },
      select: {
        suspendedAt: true,
        name: true,
        spaceId: true,
        groupMembers: { select: { groupId: true } },
      },
    });
    if (!bot) return { blocked: "suspended", name: "Bot" };
    if (bot.suspendedAt) return { blocked: "suspended", name: bot.name };
    const quarantine = await activeQuarantine(prisma, {
      id: botId,
      spaceId: bot.spaceId,
      groupIds: bot.groupMembers.map((member) => member.groupId),
    });
    return { blocked: quarantine ? "quarantined" : null, name: bot.name };
  } catch (error) {
    getLogger().error("suspension check failed", error instanceof Error ? error.message : "error");
    return { blocked: "suspended", name: "Bot" };
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
    const { blocked, name } = await botBlockedNow(this.prisma, context.botId);
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
