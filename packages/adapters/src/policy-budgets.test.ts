import { BUDGET_REACHED_MESSAGE, PolicySchema } from "@rakazo/contracts";
import { installSecurityEventStore } from "@rakazo/db";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { assertBudgetAvailable } from "./policy-budgets.js";
import { policyDenied } from "./policy-capabilities.js";
import { PolicyDeniedError, setActivePolicy } from "./policy-runtime.js";
import { isTerminalModelSetupError } from "./run-model.js";

const rows: Array<{ data: Record<string, unknown> }> = [];
beforeEach(() => {
  rows.length = 0;
  installSecurityEventStore({
    securityEvent: {
      create: vi.fn(async (args: { data: Record<string, unknown> }) => {
        rows.push(args);
        return args.data;
      }),
    },
  } as never);
});
afterEach(() => {
  setActivePolicy(undefined);
  installSecurityEventStore(undefined);
});

const run = { userId: "user-1", spaceId: "space-1", botId: "bot-1" };
const policy = PolicySchema.parse({
  version: 1,
  budgets: { organizationUsd: 1000, perUserUsd: 100, perBotUsd: 50 },
});

/** A $queryRaw tagged template returning one aggregate row; records the bound parameters. */
function fakePrisma(spend: { organization: number; user: number; bot: number }) {
  const queryRaw = vi.fn(async (_strings: TemplateStringsArray, ..._values: unknown[]) => [spend]);
  return { prisma: { $queryRaw: queryRaw } as never, queryRaw };
}

describe("assertBudgetAvailable", () => {
  it("makes no query without a budget", async () => {
    const { prisma, queryRaw } = fakePrisma({ organization: 1e9, user: 1e9, bot: 1e9 });
    await assertBudgetAvailable(prisma, run);
    setActivePolicy(PolicySchema.parse({ version: 1, budgets: { warnAtPercent: 80 } }));
    await assertBudgetAvailable(prisma, run);
    expect(queryRaw).not.toHaveBeenCalled();
    expect(rows).toEqual([]);
  });

  it("queries once for the run's user and bot from the start of the UTC month", async () => {
    setActivePolicy(policy);
    const { prisma, queryRaw } = fakePrisma({ organization: 0, user: 0, bot: 0 });
    await assertBudgetAvailable(prisma, run, new Date("2026-11-17T08:00:00Z"));
    expect(queryRaw).toHaveBeenCalledTimes(1);
    expect(queryRaw.mock.calls[0]?.slice(1)).toEqual([
      "user-1",
      "bot-1",
      new Date("2026-11-01T00:00:00Z"),
    ]);
  });

  it("allows under every limit", async () => {
    setActivePolicy(policy);
    const { prisma } = fakePrisma({ organization: 999, user: 99, bot: 49 });
    await expect(assertBudgetAvailable(prisma, run)).resolves.toBeUndefined();
    expect(rows).toEqual([]);
  });

  it.each([
    ["organization", { organization: 1000, user: 1, bot: 1 }],
    ["organization", { organization: 1200, user: 1, bot: 1 }],
    ["user", { organization: 1, user: 100, bot: 1 }],
    ["user", { organization: 1, user: 150, bot: 1 }],
    ["bot", { organization: 1, user: 1, bot: 50 }],
    ["bot", { organization: 1, user: 1, bot: 75 }],
  ])("refuses at or over the %s limit and records the denial", async (scope, spend) => {
    setActivePolicy(policy);
    const { prisma } = fakePrisma(spend);
    const error = await assertBudgetAvailable(prisma, run).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PolicyDeniedError);
    expect((error as PolicyDeniedError).message).toBe(BUDGET_REACHED_MESSAGE);
    expect((error as PolicyDeniedError).rule).toBe(`budgets.${scope}`);
    expect(isTerminalModelSetupError(error)).toBe(true);
    expect(rows.map(({ data }) => data)).toEqual([
      expect.objectContaining({
        type: "policy.denied",
        userId: "user-1",
        spaceId: "space-1",
        metadata: { rule: `budgets.${scope}`, subject: "monthly-budget", surface: "run" },
      }),
    ]);
  });

  it("reports a denial through policyDenied so the run can fail before the model", async () => {
    setActivePolicy(policy);
    const { prisma } = fakePrisma({ organization: 0, user: 100, bot: 0 });
    await expect(policyDenied(() => assertBudgetAvailable(prisma, run))).resolves.toBe(true);
  });
});
