import { BUDGET_REACHED_MESSAGE } from "@rakazo/contracts";
import { budgetPeriodStart, evaluateBudgets } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import { periodSpendUsd } from "@rakazo/db";
import { activePolicy, deny } from "./policy-runtime.js";

/**
 * Refuse a run once this month's spend has reached a budget in the policy, recording
 * `policy.denied` with rule `budgets.<scope>`. Spend is every persisted usage cost, including
 * calls on a user's own connection. The check happens before the model is called, so runs
 * already in flight (and concurrent starts) can overshoot a limit slightly. No-op without a
 * budget, and then no query is made.
 */
export async function assertBudgetAvailable(
  prisma: Pick<PrismaClient, "$queryRaw">,
  run: { userId: string; spaceId: string; botId: string },
  now = new Date(),
): Promise<void> {
  const policy = activePolicy();
  const budgets = policy?.budgets;
  if (!budgets || (!budgets.organizationUsd && !budgets.perUserUsd && !budgets.perBotUsd)) return;
  const spend = await periodSpendUsd(prisma, {
    userId: run.userId,
    botId: run.botId,
    since: budgetPeriodStart(now),
  });
  const decision = evaluateBudgets(policy, spend);
  if (!decision.allowed)
    await deny(
      decision.rule,
      "monthly-budget",
      { userId: run.userId, spaceId: run.spaceId, surface: "run" },
      BUDGET_REACHED_MESSAGE,
    );
}
