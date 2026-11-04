import { ORPCError } from "@orpc/server";
import type { AdminQuarantine } from "@rakazo/contracts";
import { QuarantineScopeKindSchema } from "@rakazo/contracts";
import { recordSecurityEvent, runAsSystem } from "@rakazo/db";
import { requireAdminRole } from "./admins.js";
import type { SuspensionDeps } from "./bot-suspension.js";
import { cancelBotRuns, finishCancelledRuns } from "./bot-suspension.js";

const system = <T>(what: string, fn: () => Promise<T>) =>
  runAsSystem(`bot quarantine: ${what}`, fn);

type Scope = { scopeKind: "bot" | "space" | "group" | "all"; scopeId: string | null };

/** The bots a scope covers right now, or null for every bot. */
async function coveredBotIds(deps: SuspensionDeps, scope: Scope): Promise<string[] | null> {
  switch (scope.scopeKind) {
    case "all":
      return null;
    case "bot": {
      const bot = await deps.prisma.bot.findUnique({
        where: { id: scope.scopeId ?? "" },
        select: { id: true },
      });
      if (!bot) throw new ORPCError("NOT_FOUND", { message: "AI employee not found" });
      return [bot.id];
    }
    case "space": {
      const space = await deps.prisma.space.findUnique({
        where: { id: scope.scopeId ?? "" },
        select: { id: true },
      });
      if (!space) throw new ORPCError("NOT_FOUND", { message: "Space not found" });
      const bots = await deps.prisma.bot.findMany({
        where: { spaceId: space.id },
        select: { id: true },
      });
      return bots.map((bot) => bot.id);
    }
    case "group": {
      const group = await deps.prisma.chatGroup.findUnique({
        where: { id: scope.scopeId ?? "" },
        select: { id: true, members: { select: { botId: true } } },
      });
      if (!group) throw new ORPCError("NOT_FOUND", { message: "Chat group not found" });
      return group.members.map((member) => member.botId);
    }
  }
}

/**
 * Quarantines one bot, every bot in a Space or chat group, or all bots. The row goes in first, so
 * every gate refuses the bots from that moment; then their active runs are cancelled (the
 * suspend primitive, no drain). Secrets, MCP configuration, webhook secrets and personal
 * connections are never touched: they are unusable while the gates refuse the bot, so releasing
 * restores everything. Admin only.
 */
export async function startQuarantine(
  deps: SuspensionDeps,
  actorId: string,
  input: { scopeKind: Scope["scopeKind"]; scopeId?: string; reason?: string },
): Promise<{
  id: string;
  bots: number;
  cancelledRuns: number;
}> {
  await requireAdminRole(deps, actorId, "security");
  const scope: Scope = {
    scopeKind: input.scopeKind,
    scopeId: input.scopeKind === "all" ? null : (input.scopeId ?? null),
  };
  const now = new Date();
  const reason = input.reason ?? "";
  const botIds = await system("resolve scope", () => coveredBotIds(deps, scope));
  const existing = await system("find active", () =>
    deps.prisma.quarantine.findFirst({ where: { ...scope, liftedAt: null }, select: { id: true } }),
  );
  const row =
    existing ??
    (await system("start", () =>
      deps.prisma.quarantine.create({
        data: { ...scope, reason, createdByUserId: actorId },
        select: { id: true },
      }),
    ));
  const cancelled = await system("cancel", () =>
    deps.prisma.$transaction((tx) => cancelBotRuns(tx, botIds, now)),
  );
  await finishCancelledRuns(deps, cancelled);
  const bots = botIds
    ? botIds.length
    : await system("count", () => deps.prisma.bot.count({ where: { archivedAt: null } }));
  const summary = {
    bots,
    cancelledRuns: cancelled.runs.length,
  };
  await system("summary", () =>
    deps.prisma.quarantine.update({ where: { id: row.id }, data: { summary } }),
  );
  await recordSecurityEvent({
    type: "bot.quarantined",
    userId: actorId,
    metadata: {
      quarantineId: row.id,
      scopeKind: scope.scopeKind,
      scopeId: scope.scopeId ?? undefined,
      reason: reason || undefined,
      ...summary,
    },
  });
  return { id: row.id, ...summary };
}

/**
 * Ends a quarantine. Idempotent. Cancelled runs are not replayed; everything else works again.
 */
export async function liftQuarantine(
  deps: SuspensionDeps,
  actorId: string,
  id: string,
): Promise<{ ok: true }> {
  await requireAdminRole(deps, actorId, "security");
  const row = await system("find", () =>
    deps.prisma.quarantine.findUnique({
      where: { id },
      select: { id: true, scopeKind: true, scopeId: true, liftedAt: true },
    }),
  );
  if (!row) throw new ORPCError("NOT_FOUND", { message: "Quarantine not found" });
  if (row.liftedAt) return { ok: true };
  const lifted = await system("lift", () =>
    deps.prisma.quarantine.updateMany({
      where: { id, liftedAt: null },
      data: { liftedAt: new Date(), liftedByUserId: actorId },
    }),
  );
  if (lifted.count === 1)
    await recordSecurityEvent({
      type: "bot.released",
      userId: actorId,
      metadata: {
        quarantineId: row.id,
        scopeKind: row.scopeKind,
        scopeId: row.scopeId ?? undefined,
      },
    });
  return { ok: true };
}

/** The quarantines in force, newest first, with the name of what each covers. */
export async function listQuarantines(
  deps: SuspensionDeps,
  actorId: string,
): Promise<{ quarantines: AdminQuarantine[] }> {
  await requireAdminRole(deps, actorId, ["security", "auditor"]);
  return system("list", async () => {
    const rows = await deps.prisma.quarantine.findMany({
      where: { liftedAt: null },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: 100,
    });
    const ids = (kind: string) =>
      rows.flatMap((row) => (row.scopeKind === kind && row.scopeId ? [row.scopeId] : []));
    const [bots, spaces, groups] = await Promise.all([
      deps.prisma.bot.findMany({
        where: { id: { in: ids("bot") } },
        select: { id: true, name: true },
      }),
      deps.prisma.space.findMany({
        where: { id: { in: ids("space") } },
        select: { id: true, name: true },
      }),
      deps.prisma.chatGroup.findMany({
        where: { id: { in: ids("group") } },
        select: { id: true, name: true },
      }),
    ]);
    const names = new Map(
      [...bots, ...spaces, ...groups].map((item) => [item.id, item.name] as const),
    );
    return {
      quarantines: rows.map((row) => ({
        id: row.id,
        scopeKind: QuarantineScopeKindSchema.parse(row.scopeKind),
        scopeId: row.scopeId,
        scopeName: row.scopeId ? (names.get(row.scopeId) ?? null) : null,
        reason: row.reason,
        createdAt: row.createdAt.toISOString(),
      })),
    };
  });
}
