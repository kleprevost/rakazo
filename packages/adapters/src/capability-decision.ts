import type { Policy } from "@rakazo/contracts";
import type { CapabilityCredential, ClassifyInput } from "@rakazo/core";
import { evaluateCall } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import { activeQuarantineFor, loadBotCapabilityGrants } from "@rakazo/db";

/*
 * The capability broker's one decision for a bot's call, shared by shadow mode and enforcement:
 * load the snapshot (grants, quarantine, policy) and run the pure evaluator.
 */

export type DecisionReader = Pick<PrismaClient, "bot" | "quarantine" | "capabilityGrant">;

export type DecisionInput = {
  prisma: DecisionReader;
  bot: {
    id: string;
    name: string;
    employeeId: string | null;
    capabilityMode: string | null;
  };
  spaceId: string;
  /** The acting requester: `run.userId`. */
  userId: string;
  runId?: string | null | undefined;
  threadId?: string | null | undefined;
  call: ClassifyInput;
  /** The connected accounts the acting user holds; a call naming any other is not theirs. */
  connections?: ReadonlyArray<{ id: string }> | undefined;
  policy?: Policy | undefined;
};

/** Stands for a credential owner that is not the acting user. Never matches a real user id. */
const NOT_THE_PRINCIPAL = "!not-the-principal";

/** Whether the broker refuses what it denies: the bot opted in, or policy requires grants. */
export function enforcing(mode: string | null | undefined, policy: Policy | undefined): boolean {
  return mode === "enforce" || policy?.capabilities?.requireGrants === true;
}

/**
 * The credential a call would use. Every external call uses the acting user's own credential;
 * one naming a connected account the user does not hold (a model-supplied id) is another
 * owner's, which the evaluator refuses as a principal mismatch.
 */
export function credentialFor(
  call: ClassifyInput,
  userId: string,
  connections: DecisionInput["connections"],
): CapabilityCredential {
  if (call.source === "builtin") return { kind: "none" };
  const foreign =
    call.connectionId !== undefined &&
    connections !== undefined &&
    !connections.some((connection) => connection.id === call.connectionId);
  return { kind: "personal", userId: foreign ? NOT_THE_PRINCIPAL : userId };
}

/** Load the live rows and decide the call as enforce would. Throws when a read fails. */
export async function evaluateBotCall(input: DecisionInput) {
  const { prisma, bot, call } = input;
  const [grants, quarantine] = await Promise.all([
    loadBotCapabilityGrants(prisma, bot),
    activeQuarantineFor(prisma, bot.id),
  ]);
  return evaluateCall(
    {
      now: new Date(),
      policy: input.policy,
      quarantine: quarantine ? { id: quarantine.id } : undefined,
      principal: { actingUserId: input.userId },
      grants,
    },
    call,
    credentialFor(call, input.userId, input.connections),
  );
}
