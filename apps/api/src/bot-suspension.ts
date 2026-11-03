import { ORPCError } from "@orpc/server";
import { runJobKey } from "@rakazo/adapter-kit";
import { BOT_SUSPENDED_MESSAGE } from "@rakazo/contracts";
import { ACTIVE_RUN_STATUSES } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import {
  appendEventInTransaction,
  cancelRunsInTransaction,
  recordSecurityEvent,
  runAsSystem,
  transientRunEventsWhere,
} from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import { requireAdmin } from "./admins.js";
import type { RouterDeps } from "./router.js";
import { finishThreadStop } from "./thread-target.js";

type SuspensionDeps = Pick<RouterDeps, "prisma" | "events" | "jobs" | "sandbox"> & {
  env: Pick<RouterDeps["env"], "adminEmails" | "ssoAdminEnabled">;
  auth: Pick<RouterDeps["auth"], "isSsoAdmin">;
};

const system = <T>(what: string, fn: () => Promise<T>) =>
  runAsSystem(`bot suspension: ${what}`, fn);

/** Refuses a user's message to a suspended bot, so it is never queued. */
export async function assertBotNotSuspended(prisma: PrismaClient, botId: string): Promise<void> {
  const bot = await prisma.bot.findUnique({ where: { id: botId }, select: { suspendedAt: true } });
  if (bot?.suspendedAt) throw new ORPCError("FORBIDDEN", { message: BOT_SUSPENDED_MESSAGE });
}

/**
 * Suspends a bot: marks it, cancels every active run it has (the same cancellation Stop uses,
 * so the worker's lease check ends a run that is mid-turn), and releases the screen and
 * run work on its computer. New runs from any source are refused by the executor. Admin only:
 * an owner who could resume would undo the admin's decision.
 */
export async function suspendBot(
  deps: SuspensionDeps,
  actorId: string,
  input: { botId: string; reason?: string },
): Promise<{ cancelledRuns: number }> {
  await requireAdmin(deps, actorId);
  const now = new Date();
  const result = await system("suspend", async () => {
    const bot = await deps.prisma.bot.findUnique({
      where: { id: input.botId },
      select: { id: true, userId: true, spaceId: true, suspendedAt: true },
    });
    if (!bot) throw new ORPCError("NOT_FOUND", { message: "AI employee not found" });
    const committed = await deps.prisma.$transaction(async (tx) => {
      await tx.bot.update({
        where: { id: bot.id },
        data: { suspendedAt: bot.suspendedAt ?? now, suspendedByUserId: actorId },
      });
      const active = await tx.run.findMany({
        where: { botId: bot.id, status: { in: [...ACTIVE_RUN_STATUSES] } },
        select: { id: true, taskId: true, userId: true, spaceId: true, threadId: true },
      });
      const cancelled = await cancelRunsInTransaction(tx, active, now);
      const runIds = cancelled.map((run) => run.id);
      await tx.steeringMessage.deleteMany({ where: { botId: bot.id } });
      // Snapshot teardown coordinates before commit: a worker may release them right after.
      const leases = runIds.length
        ? await tx.computerExecutionLease.findMany({
            where: { runId: { in: runIds } },
            select: { computerId: true, botId: true, runId: true, fence: true },
          })
        : [];
      const computers = runIds.length
        ? await tx.computer.findMany({
            where: {
              OR: [
                { id: { in: [...new Set(leases.map((lease) => lease.computerId))] } },
                { executionRunId: { in: runIds } },
              ],
            },
            select: {
              id: true,
              homeKey: true,
              kind: true,
              providerRef: true,
              executionBotId: true,
              executionRunId: true,
            },
          })
        : [];
      const seqByThread = new Map<string, number>();
      for (const run of cancelled) {
        const event = await appendEventInTransaction(tx, {
          spaceId: run.spaceId,
          threadId: run.threadId,
          botId: bot.id,
          type: "run.cancelled",
          runId: run.id,
          payload: {},
        });
        seqByThread.set(run.threadId, event.seq);
      }
      if (runIds.length) {
        await tx.event.deleteMany({
          where: { ...transientRunEventsWhere(), runId: { in: runIds } },
        });
      }
      return { bot, runIds, leases, computers, seqByThread };
    });
    return committed;
  });
  const { bot, runIds, leases, computers, seqByThread } = result;
  await system("tear down", async () => {
    for (const [threadId, seq] of seqByThread) {
      await deps.events.notify(threadId, seq).catch((error) => {
        getLogger().error("bot suspension realtime notification", error);
      });
    }
    await Promise.allSettled(runIds.map((runId) => deps.jobs.cancel(runJobKey(runId))));
    await finishThreadStop(
      deps,
      { spaceId: bot.spaceId, userId: bot.userId },
      { threadId: "" },
      { runIds, computers, leases, eventSeq: null },
    );
  });
  await recordSecurityEvent({
    type: "bot.suspended",
    userId: actorId,
    spaceId: bot.spaceId,
    metadata: {
      botId: bot.id,
      ownerId: bot.userId,
      cancelledRuns: runIds.length,
      reason: input.reason,
    },
  });
  return { cancelledRuns: runIds.length };
}

/** Clears the suspension. Routines keep the schedule they were skipping along, so nothing bursts. */
export async function resumeBot(
  deps: SuspensionDeps,
  actorId: string,
  botId: string,
): Promise<{ ok: true }> {
  await requireAdmin(deps, actorId);
  const bot = await system("resume", async () => {
    const found = await deps.prisma.bot.findUnique({
      where: { id: botId },
      select: { id: true, userId: true, spaceId: true, suspendedAt: true },
    });
    if (!found) throw new ORPCError("NOT_FOUND", { message: "AI employee not found" });
    if (found.suspendedAt)
      await deps.prisma.bot.update({
        where: { id: botId },
        data: { suspendedAt: null, suspendedByUserId: null },
      });
    return found;
  });
  if (bot.suspendedAt)
    await recordSecurityEvent({
      type: "bot.resumed",
      userId: actorId,
      spaceId: bot.spaceId,
      metadata: { botId: bot.id, ownerId: bot.userId },
    });
  return { ok: true };
}
