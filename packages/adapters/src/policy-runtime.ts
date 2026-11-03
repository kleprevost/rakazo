import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { Policy } from "@rakazo/contracts";
import { POLICY_DENIED_MESSAGE } from "@rakazo/contracts";
import {
  evaluateModelUse,
  evaluateUserConnection,
  PolicyFileError,
  parsePolicy,
} from "@rakazo/core";
import { recordSecurityEvent } from "@rakazo/db";

let active: Policy | undefined;

/** The policy this process loaded at startup, or undefined when none is configured. */
export function activePolicy(): Policy | undefined {
  return active;
}

/** Tests and composition roots only. */
export function setActivePolicy(policy: Policy | undefined): void {
  active = policy;
}

/**
 * Load `RAKAZO_POLICY_FILE` once at startup. No variable means no policy. An unreadable or
 * invalid file throws so the process fails to start instead of running unrestricted.
 */
export async function loadPolicyFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  read: (path: string) => string = (path) => readFileSync(path, "utf8"),
): Promise<{ policy: Policy; hash: string } | undefined> {
  const path = env.RAKAZO_POLICY_FILE?.trim();
  if (!path) {
    active = undefined;
    return undefined;
  }
  let text: string;
  try {
    text = read(path);
  } catch (error) {
    throw new PolicyFileError(
      `RAKAZO_POLICY_FILE could not be read: ${(error as NodeJS.ErrnoException).code ?? "read error"}`,
    );
  }
  const policy = parsePolicy(text, "RAKAZO_POLICY_FILE");
  const hash = createHash("sha256").update(text).digest("hex");
  active = policy;
  await recordSecurityEvent({
    type: "policy.loaded",
    metadata: { version: policy.version, hash },
  });
  return { policy, hash };
}

/** A policy rule refused the action. The message is the one short text users see. */
export class PolicyDeniedError extends Error {
  readonly reason = "policy";
  constructor(
    readonly rule: string,
    readonly subject: string,
  ) {
    super(POLICY_DENIED_MESSAGE);
    this.name = "PolicyDeniedError";
  }
}

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

/** Refuse a model the policy forbids; records one `policy.denied` event. No-op without policy. */
export async function assertModelAllowed(
  use: { provider: string; modelId: string; ownConnection: boolean },
  audience: Audience,
): Promise<void> {
  const decision = evaluateModelUse(active, use);
  if (!decision.allowed) await deny(decision.rule, `${use.provider}/${use.modelId}`, audience);
}

/** Refuse saving a model credential or endpoint the policy does not allow users to add. */
export async function assertUserConnectionAllowed(
  provider: string,
  audience: Audience,
): Promise<void> {
  const decision = evaluateUserConnection(active, provider);
  if (!decision.allowed) await deny(decision.rule, provider, audience);
}
