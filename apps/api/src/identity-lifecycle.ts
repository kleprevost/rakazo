import { ORPCError } from "@orpc/server";
import type { DeprovisionResult } from "@rakazo/contracts";
import { reconcileUserEntitlements, recordSecurityEvent, runAsSystem } from "@rakazo/db";
import { cancelBotRuns, finishCancelledRuns } from "./bot-suspension.js";
import type { RouterDeps } from "./router.js";

export type LifecycleDeps = Pick<RouterDeps, "prisma" | "events" | "jobs" | "sandbox"> & {
  auth: Pick<RouterDeps["auth"], "$context">;
};

/** Who asked: a security admin, or the directory provisioning endpoint. */
export type LifecycleActor = { via: "admin"; adminId: string } | { via: "provisioning" };

const system = <T>(what: string, fn: () => Promise<T>) =>
  runAsSystem(`identity lifecycle: ${what}`, fn);

const REVOKED_REASON = "deprovisioned";

/**
 * Offboards an account without deleting anything. The flag is set first, so from then on no
 * session can be created or used; the other steps are idempotent, so a repeat call finishes a
 * partly applied one. AI employees are suspended with the existing suspension, so they stay
 * stopped after a reactivation until an admin resumes them.
 */
export async function deprovisionUser(
  deps: LifecycleDeps,
  actor: LifecycleActor,
  input: { userId: string; reason?: string },
): Promise<DeprovisionResult> {
  const now = new Date();
  const user = await system("find user", () =>
    deps.prisma.user.findUnique({ where: { id: input.userId }, select: { id: true } }),
  );
  if (!user) throw new ORPCError("NOT_FOUND", { message: "User not found" });
  const adminId = actor.via === "admin" ? actor.adminId : null;
  const { bots, cancelled, revokedGrants } = await system("deprovision", async () => {
    await deps.prisma.user.updateMany({
      where: { id: user.id, deprovisionedAt: null },
      data: { deprovisionedAt: now, deprovisionedVia: actor.via },
    });
    return deps.prisma.$transaction(async (tx) => {
      const bots = await tx.bot.findMany({
        where: { userId: user.id },
        select: { id: true },
      });
      const botIds = bots.map((bot) => bot.id);
      await tx.bot.updateMany({
        where: { userId: user.id, suspendedAt: null },
        data: { suspendedAt: now, suspendedByUserId: adminId },
      });
      const cancelled = await cancelBotRuns(tx, botIds, now, user.id);
      // Allow and ask rows go; a deny row only ever narrows access, so it stays.
      const revoked = await tx.capabilityGrant.updateMany({
        where: {
          revokedAt: null,
          effect: { not: "deny" },
          OR: [
            { principalUserId: user.id },
            { botId: { in: botIds } },
            { createdByUserId: user.id, createdVia: "owner", employeeId: null },
          ],
        },
        data: { revokedAt: now, revokedReason: REVOKED_REASON },
      });
      return { bots: botIds, cancelled, revokedGrants: revoked.count };
    });
  });
  const { internalAdapter } = await deps.auth.$context;
  const sessions = await internalAdapter.listSessions(user.id);
  if (sessions.length)
    await internalAdapter.deleteSessions(sessions.map((session) => session.token));
  await reconcileUserEntitlements(deps.prisma, user.id, { via: "deprovision" });
  await finishCancelledRuns(deps, cancelled);
  const result = {
    endedSessions: sessions.length,
    suspendedBots: bots.length,
    cancelledRuns: cancelled.runs.length,
    revokedGrants,
  };
  await recordSecurityEvent({
    type: "user.deprovisioned",
    userId: user.id,
    metadata: {
      via: actor.via,
      ...(adminId ? { adminId } : {}),
      ...(input.reason ? { reason: input.reason } : {}),
      ...result,
    },
  });
  return result;
}

/**
 * Lets the account sign in again and recomputes its employee access from the grants. Revoked
 * capability grants and suspended AI employees are not restored: a person decides those.
 * Provisioning may only undo what provisioning did, so an admin's decision survives the
 * directory re-enabling the account. Returns whether the account is now active.
 */
export async function reactivateUser(
  deps: Pick<LifecycleDeps, "prisma">,
  actor: LifecycleActor,
  userId: string,
): Promise<boolean> {
  const user = await system("find user", () =>
    deps.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, deprovisionedAt: true, deprovisionedVia: true },
    }),
  );
  if (!user) throw new ORPCError("NOT_FOUND", { message: "User not found" });
  if (!user.deprovisionedAt) return true;
  if (actor.via === "provisioning" && user.deprovisionedVia !== "provisioning") return false;
  await system("reactivate", () =>
    deps.prisma.user.update({
      where: { id: userId },
      data: { deprovisionedAt: null, deprovisionedVia: null },
    }),
  );
  await reconcileUserEntitlements(deps.prisma, userId, { via: "reactivate" });
  await recordSecurityEvent({
    type: "user.reactivated",
    userId,
    metadata: { via: actor.via, ...(actor.via === "admin" ? { adminId: actor.adminId } : {}) },
  });
  return true;
}
