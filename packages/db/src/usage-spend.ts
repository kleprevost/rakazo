import type { PrismaClient } from "./generated/prisma/client.js";
import { runAsSystem } from "./row-security.js";

export interface PeriodSpend {
  organization: number;
  user: number;
  bot: number;
}

/**
 * USD spent since `since`, organization-wide and for one user and bot, from persisted usage.
 * One covering-index scan (`usage_records_period_spend_idx`); unpriced calls count as zero.
 * Runs as system because the organization, a user and a bot each span Spaces.
 */
export async function periodSpendUsd(
  prisma: Pick<PrismaClient, "$queryRaw">,
  scope: { userId: string; botId?: string | null; since: Date },
): Promise<PeriodSpend> {
  const [row] = await runAsSystem(
    "budget period spend",
    () =>
      prisma.$queryRaw<Array<PeriodSpend>>`
      SELECT
        COALESCE(SUM("costUsd"), 0)::float8 AS organization,
        COALESCE(SUM("costUsd") FILTER (WHERE "userId" = ${scope.userId}), 0)::float8 AS "user",
        COALESCE(SUM("costUsd") FILTER (WHERE "botId" = ${scope.botId ?? null}), 0)::float8 AS bot
      FROM usage_records
      WHERE "createdAt" >= ${scope.since}`,
  );
  return { organization: row?.organization ?? 0, user: row?.user ?? 0, bot: row?.bot ?? 0 };
}
