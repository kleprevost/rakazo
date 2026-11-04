import { ORPCError } from "@orpc/server";
import type { AdapterContext } from "@rakazo/adapter-kit";
import { createFleetOperation, toComputerRef } from "@rakazo/adapters";
import type { Prisma } from "@rakazo/db";
import { recordSecurityEvent, runAsSystem } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import { requireAdminRole } from "./admins.js";
import type { SuspensionDeps } from "./bot-suspension.js";
import { cancelBotRuns, finishCancelledRuns } from "./bot-suspension.js";

const system = <T>(what: string, fn: () => Promise<T>) =>
  runAsSystem(`computer quarantine: ${what}`, fn);

/** What containing or releasing one computer's network came to; never claims more than the provider confirmed. */
export type IsolationOutcome = "applied" | "not_running" | "unsupported" | "failed";

const ISOLATE_PARALLEL = 4;
const ISOLATE_TIMEOUT_MS = 10_000;

type Contained = {
  id: string;
  kind: string;
  state: string;
  homeKey: string;
  providerRef: string | null;
  spaceId: string;
  userId: string;
  adminQuarantinedAt: Date | null;
  bots: Array<{ id: string }>;
};

const SELECT = {
  id: true,
  kind: true,
  state: true,
  homeKey: true,
  providerRef: true,
  spaceId: true,
  userId: true,
  adminQuarantinedAt: true,
  bots: { select: { id: true } },
} satisfies Prisma.ComputerSelect;

/** Cuts a running computer off from its network, or restores it, only where the provider can. */
async function setNetwork(
  deps: SuspensionDeps,
  computer: Contained,
  isolated: boolean,
): Promise<IsolationOutcome> {
  const sandbox = deps.sandbox;
  const description = sandbox.describe();
  if (
    description.id !== computer.kind ||
    !description.capabilities.fleet?.networkIsolation ||
    !sandbox.isolateNetwork
  )
    return "unsupported";
  if (computer.state !== "running" || !computer.providerRef) return "not_running";
  const context: AdapterContext = {
    operationId: `computer-quarantine-${computer.id}`,
    traceId: `computer-quarantine-${computer.id}`,
    spaceId: computer.spaceId,
    userId: computer.userId,
    botId: computer.homeKey,
    signal: AbortSignal.timeout(ISOLATE_TIMEOUT_MS),
  };
  try {
    return await sandbox.isolateNetwork(toComputerRef(computer), isolated, context);
  } catch (error) {
    // Provider errors can carry private URLs; log them, report only the outcome.
    getLogger().error("computer.network_change_failed", error, { "computer.id": computer.id });
    return "failed";
  }
}

async function inBatches<T, R>(items: T[], fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += ISOLATE_PARALLEL)
    out.push(...(await Promise.all(items.slice(i, i + ISOLATE_PARALLEL).map(fn))));
  return out;
}

export type ContainmentSummary = {
  quarantined: number;
  cancelledRuns: number;
  /** Computers by what the network cut came to. */
  networkIsolation: Partial<Record<IsolationOutcome, number>>;
  /** The terminate operation that stops the idle ones; null when none were running. */
  operationId: string | null;
};

const tally = (outcomes: IsolationOutcome[]) => {
  const counts: Partial<Record<IsolationOutcome, number>> = {};
  for (const outcome of outcomes) counts[outcome] = (counts[outcome] ?? 0) + 1;
  return counts;
};

/**
 * Contains computers: the flag goes on first, so every start, wake, takeover and execution lease
 * is refused from that moment; then the active runs of the bots on them are cancelled (the
 * suspend primitive), the network is cut where the provider can really do it, and a terminate
 * operation stops the machines with their homes saved. A busy computer is never destroyed: its
 * item is skipped, and the flag keeps it from starting again. Safe to repeat.
 */
export async function containComputers(
  deps: SuspensionDeps,
  actorId: string,
  computerIds: string[],
  options: {
    reason?: string;
    /** The bot quarantine containing them, so lifting it releases them. */
    quarantineId?: string;
    /** Runs of bots on these computers are already cancelled by the caller. */
    runsCancelled?: boolean;
  } = {},
): Promise<ContainmentSummary> {
  const ids = [...new Set(computerIds)];
  const computers: Contained[] = ids.length
    ? await system("read", () =>
        deps.prisma.computer.findMany({ where: { id: { in: ids } }, select: SELECT }),
      )
    : [];
  if (computers.length !== ids.length)
    throw new ORPCError("NOT_FOUND", { message: "Computer not found" });
  const fresh = computers.filter((computer) => !computer.adminQuarantinedAt);
  const now = new Date();
  await system("flag", async () => {
    await deps.prisma.computer.updateMany({
      where: { id: { in: fresh.map((computer) => computer.id) }, adminQuarantinedAt: null },
      data: {
        adminQuarantinedAt: now,
        adminQuarantinedByUserId: actorId,
        adminQuarantineReason: options.reason || null,
        adminQuarantineId: options.quarantineId ?? null,
      },
    });
    // An admin who contains a computer a bot quarantine already holds takes it over, so lifting
    // that quarantine no longer releases it.
    if (!options.quarantineId)
      await deps.prisma.computer.updateMany({
        where: { id: { in: ids }, adminQuarantineId: { not: null } },
        data: { adminQuarantineId: null },
      });
  });
  const botIds = computers.flatMap((computer) => computer.bots.map((bot) => bot.id));
  let cancelledRuns = 0;
  if (!options.runsCancelled && botIds.length > 0) {
    const cancelled = await system("cancel", () =>
      deps.prisma.$transaction((tx) => cancelBotRuns(tx, botIds, now)),
    );
    await finishCancelledRuns(deps, cancelled);
    cancelledRuns = cancelled.runs.length;
  }
  const outcomes = await inBatches(computers, (computer) => setNetwork(deps, computer, true));
  const running = computers.filter(
    (computer) => computer.state === "running" && computer.providerRef,
  );
  const operation = running.length
    ? await createFleetOperation(deps, {
        actorUserId: actorId,
        kind: "terminate",
        computerIds: running.map((computer) => computer.id),
      })
    : null;
  for (const [index, computer] of computers.entries()) {
    if (computer.adminQuarantinedAt) continue;
    await recordSecurityEvent({
      type: "computer.quarantined",
      userId: actorId,
      spaceId: computer.spaceId,
      metadata: {
        kind: "computer",
        computerId: computer.id,
        provider: computer.kind,
        bots: computer.bots.length,
        networkIsolation: outcomes[index] ?? "unsupported",
        ...(options.quarantineId ? { quarantineId: options.quarantineId } : {}),
        ...(options.reason ? { reason: options.reason } : {}),
        ...(operation ? { operationId: operation.id } : {}),
      },
    });
  }
  return {
    quarantined: fresh.length,
    cancelledRuns,
    networkIsolation: tally(outcomes),
    operationId: operation?.id ?? null,
  };
}

/** Admin quarantine of chosen computers. */
export async function quarantineComputers(
  deps: SuspensionDeps,
  actorId: string,
  input: { computerIds: string[]; reason?: string },
): Promise<ContainmentSummary> {
  await requireAdminRole(deps, actorId, "security");
  return containComputers(deps, actorId, input.computerIds, { reason: input.reason });
}

/**
 * Clears the flag and restores the network of a computer that is still up. It does not start
 * anything: a stopped computer stays stopped until it is used or woken, and the bots on it stay
 * suspended or quarantined until released on their own.
 */
export async function releaseContainedComputers(
  deps: SuspensionDeps,
  actorId: string,
  where: Prisma.ComputerWhereInput,
): Promise<{ released: number }> {
  const flagged = await system("find", () =>
    deps.prisma.computer.findMany({
      where: { ...where, adminQuarantinedAt: { not: null } },
      select: SELECT,
    }),
  );
  if (flagged.length === 0) return { released: 0 };
  const cleared = await system("clear", () =>
    deps.prisma.computer.updateMany({
      where: {
        id: { in: flagged.map((computer) => computer.id) },
        adminQuarantinedAt: { not: null },
      },
      data: {
        adminQuarantinedAt: null,
        adminQuarantinedByUserId: null,
        adminQuarantineReason: null,
        adminQuarantineId: null,
      },
    }),
  );
  const outcomes = await inBatches(flagged, (computer) => setNetwork(deps, computer, false));
  for (const [index, computer] of flagged.entries())
    await recordSecurityEvent({
      type: "computer.released",
      userId: actorId,
      spaceId: computer.spaceId,
      metadata: {
        kind: "computer",
        computerId: computer.id,
        provider: computer.kind,
        networkIsolation: outcomes[index] ?? "unsupported",
      },
    });
  return { released: cleared.count };
}

/** Admin release of chosen computers. */
export async function releaseComputers(
  deps: SuspensionDeps,
  actorId: string,
  input: { computerIds: string[] },
): Promise<{ released: number }> {
  await requireAdminRole(deps, actorId, "security");
  const known = await system("check", () =>
    deps.prisma.computer.count({ where: { id: { in: input.computerIds } } }),
  );
  if (known !== new Set(input.computerIds).size)
    throw new ORPCError("NOT_FOUND", { message: "Computer not found" });
  return releaseContainedComputers(deps, actorId, { id: { in: input.computerIds } });
}

/**
 * The computers every active bot on which a bot quarantine covers. A Team computer that also serves
 * a bot outside the quarantine is left alone: containing it would stop other people's work.
 * `null` covers every bot.
 */
export async function computersCoveredBy(
  deps: SuspensionDeps,
  botIds: string[] | null,
): Promise<string[]> {
  const rows = await system("find covered", () =>
    deps.prisma.computer.findMany({
      where: botIds
        ? {
            bots: {
              some: { id: { in: botIds } },
              none: { archivedAt: null, id: { notIn: botIds } },
            },
          }
        : { bots: { some: {} } },
      select: { id: true },
    }),
  );
  return rows.map((row) => row.id);
}
