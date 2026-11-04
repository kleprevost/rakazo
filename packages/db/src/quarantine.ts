import type { PrismaClient } from "./generated/prisma/client.js";

type QuarantineReader = Pick<PrismaClient, "bot" | "quarantine">;

export type BotQuarantineScope = { id: string; spaceId: string; groupIds: string[] };

/** Whether a quarantine (its scope columns) covers a bot, by membership at the time of asking. */
export function quarantineCovers(
  quarantine: { scopeKind: string; scopeId: string | null },
  bot: BotQuarantineScope,
): boolean {
  switch (quarantine.scopeKind) {
    case "all":
      return true;
    case "bot":
      return quarantine.scopeId === bot.id;
    case "space":
      return quarantine.scopeId === bot.spaceId;
    case "group":
      return quarantine.scopeId !== null && bot.groupIds.includes(quarantine.scopeId);
    default:
      return false;
  }
}

/**
 * The live quarantine that covers a bot, if any. Never cached: it guards run starts and tool
 * calls, which are far slower than one indexed read, and a cached answer is how a quarantined
 * bot keeps acting. A bot created into a quarantined Space or group afterwards is covered
 * because membership is read here, not snapshotted when the quarantine started.
 */
export async function activeQuarantine(
  prisma: Pick<PrismaClient, "quarantine">,
  bot: BotQuarantineScope,
): Promise<{ id: string; reason: string } | null> {
  return prisma.quarantine.findFirst({
    where: {
      liftedAt: null,
      OR: [
        { scopeKind: "all" },
        { scopeKind: "bot", scopeId: bot.id },
        { scopeKind: "space", scopeId: bot.spaceId },
        { scopeKind: "group", scopeId: { in: bot.groupIds } },
      ],
    },
    select: { id: true, reason: true },
  });
}

/** `activeQuarantine` for a bot id, reading its Space and chat groups first. */
export async function activeQuarantineFor(
  prisma: QuarantineReader,
  botId: string,
): Promise<{ id: string; reason: string } | null> {
  const bot = await prisma.bot.findUnique({
    where: { id: botId },
    select: { spaceId: true, groupMembers: { select: { groupId: true } } },
  });
  if (!bot) return null;
  return activeQuarantine(prisma, {
    id: botId,
    spaceId: bot.spaceId,
    groupIds: bot.groupMembers.map((member) => member.groupId),
  });
}
