import {
  evaluateConnectorUse,
  evaluateStdioMcp,
  evaluateToolSourceHost,
  policyRequestHost,
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

/** Whether the active policy lets this app slug be connected or used. Silent; no audit. */
export function connectorAllowed(slug: string): boolean {
  return evaluateConnectorUse(activePolicy(), slug).allowed;
}

/** Refuse an app the policy does not allow. The subject is the app slug. */
export async function assertConnectorAllowed(slug: string, audience: Audience): Promise<void> {
  const decision = evaluateConnectorUse(activePolicy(), slug);
  if (!decision.allowed) await deny(decision.rule, slug.trim().toLowerCase(), audience);
}

/**
 * Refuse a remote MCP, OpenAPI or GraphQL tool source whose host the policy does not allow.
 * Only the host is recorded: never the path, query or credentials of the URL.
 */
export async function assertToolSourceHostAllowed(
  target: string,
  audience: Audience = { surface: "mcp" },
): Promise<void> {
  const decision = evaluateToolSourceHost(activePolicy(), target);
  if (!decision.allowed)
    await deny(decision.rule, policyRequestHost(target) ?? "invalid", audience);
}

/** Refuse a local-command MCP server while a host allowlist is in force. */
export async function assertStdioMcpAllowed(
  audience: Audience = { surface: "mcp" },
): Promise<void> {
  const decision = evaluateStdioMcp(activePolicy());
  if (!decision.allowed) await deny(decision.rule, "stdio", audience);
}
