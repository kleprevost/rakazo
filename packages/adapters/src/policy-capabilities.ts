import type { AdapterContext, MessagingSurface } from "@rakazo/adapter-kit";
import type { Policy } from "@rakazo/contracts";
import type { BotCapability, PolicyDecision } from "@rakazo/core";
import {
  evaluateAccountExport,
  evaluateBotCapability,
  evaluateBotTool,
  evaluateComputerKind,
  evaluateHostComputer,
  evaluateMessagingSurface,
  evaluateRunTrigger,
} from "@rakazo/core";
import { recordSecurityEvent } from "@rakazo/db";
import { providerOfThreadId } from "./chat-sdk-surface.js";
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

async function enforce(decision: PolicyDecision, subject: string, audience: Audience) {
  if (!decision.allowed) await deny(decision.rule, subject, audience);
}

/** Whether `check` raised a policy denial (already recorded); other errors still throw. */
export async function policyDenied(check: () => Promise<void>): Promise<boolean> {
  try {
    await check();
    return false;
  } catch (error) {
    if (error instanceof PolicyDeniedError) return true;
    throw error;
  }
}

/** Refuse starting a computer on a sandbox kind the policy does not allow. */
export function assertComputerKindAllowed(kind: string, audience: Audience): Promise<void> {
  return enforce(evaluateComputerKind(activePolicy(), kind), kind, audience);
}

/** Refuse pairing, connecting or using the user's own computer. */
export function assertHostComputerAllowed(audience: Audience): Promise<void> {
  return enforce(evaluateHostComputer(activePolicy()), "host-computer", audience);
}

export function assertBotCapabilityAllowed(
  capability: BotCapability,
  audience: Audience,
): Promise<void> {
  return enforce(evaluateBotCapability(activePolicy(), capability), capability, audience);
}

/** Refuse a built-in tool that a bot capability switched off. */
export function assertBotToolAllowed(toolName: string, audience: Audience): Promise<void> {
  return enforce(evaluateBotTool(activePolicy(), toolName), toolName, audience);
}

/** Refuse a routine or webhook run when its capability is off. */
export function assertRunTriggerAllowed(trigger: string, audience: Audience): Promise<void> {
  return enforce(evaluateRunTrigger(activePolicy(), trigger), trigger, audience);
}

export function assertMessagingSurfaceAllowed(surface: string, audience: Audience): Promise<void> {
  return enforce(evaluateMessagingSurface(activePolicy(), surface), surface, audience);
}

export function assertAccountExportAllowed(audience: Audience): Promise<void> {
  return enforce(evaluateAccountExport(activePolicy()), "account-export", audience);
}

/** Tool names of the built-in set that are offered under the active policy. */
export function filterToolsByBotPolicy<T extends { name: string }>(
  tools: T[],
  policy: Policy | undefined = activePolicy(),
): T[] {
  if (!policy?.bots) return tools;
  return tools.filter((tool) => evaluateBotTool(policy, tool.name).allowed);
}

/**
 * Wraps a messaging surface so a chat app the policy disallows is never listed, never receives
 * webhooks, drops its inbound messages and refuses to send. The policy is read on every call.
 */
export class PolicyMessagingSurface implements MessagingSurface {
  constructor(private readonly inner: MessagingSurface) {
    // Optional methods exist only when the inner surface has them.
    if (inner.fetchThreadHistory) {
      this.fetchThreadHistory = async (threadId, options, context) => {
        await this.check(providerOfThreadId(threadId), context);
        return inner.fetchThreadHistory!(threadId, options, context);
      };
    }
    if (inner.initialize) this.initialize = () => inner.initialize!();
    if (inner.shutdown) this.shutdown = () => inner.shutdown!();
  }

  fetchThreadHistory?: MessagingSurface["fetchThreadHistory"];
  initialize?: MessagingSurface["initialize"];
  shutdown?: MessagingSurface["shutdown"];

  private allowed(provider: string) {
    return evaluateMessagingSurface(activePolicy(), provider).allowed;
  }

  private check(provider: string, context: AdapterContext) {
    return assertMessagingSurfaceAllowed(provider, {
      userId: context.userId,
      spaceId: context.spaceId,
      surface: "messaging",
    });
  }

  describe() {
    const described = this.inner.describe();
    return {
      ...described,
      capabilities: {
        ...described.capabilities,
        providers: described.capabilities.providers.filter((provider) => this.allowed(provider)),
      },
    };
  }

  platforms() {
    return this.inner.platforms().filter((platform) => this.allowed(platform.provider));
  }

  handleWebhook(provider: string, request: Request) {
    if (!this.allowed(provider)) return Promise.resolve(new Response(null, { status: 403 }));
    return this.inner.handleWebhook(provider, request);
  }

  onInbound(sink: Parameters<MessagingSurface["onInbound"]>[0]) {
    this.inner.onInbound(async (event) => {
      if (!this.allowed(event.provider)) {
        await recordSecurityEvent({
          type: "policy.denied",
          metadata: {
            rule: "messaging.allowSurfaces",
            subject: event.provider,
            surface: "messaging",
          },
        });
        return;
      }
      await sink(event);
    });
  }

  async sendToThread(
    request: Parameters<MessagingSurface["sendToThread"]>[0],
    context: AdapterContext,
  ) {
    await this.check(providerOfThreadId(request.threadId), context);
    return this.inner.sendToThread(request, context);
  }

  async openDirectThread(provider: string, address: string, context: AdapterContext) {
    await this.check(provider, context);
    return this.inner.openDirectThread(provider, address, context);
  }

  acknowledge(threadId: string, handle: string, context: AdapterContext) {
    if (!this.allowed(providerOfThreadId(threadId))) return Promise.resolve();
    return this.inner.acknowledge(threadId, handle, context);
  }
}
