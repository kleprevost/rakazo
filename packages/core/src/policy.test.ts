import type { Policy } from "@rakazo/contracts";
import { PolicySchema } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import {
  budgetPeriodStart,
  evaluateBudgets,
  evaluateModelUse,
  evaluateUserConnection,
  filterModelCatalog,
  PolicyFileError,
  parsePolicy,
  policyGlobMatches,
} from "./policy.js";

const FULL = {
  version: 1,
  models: { allowProviders: ["azure"], allowModels: ["azure/gpt-*"], allowUserConnections: false },
  approvals: { minimumMode: "ask", alwaysAsk: ["email.send"] },
  tools: { deny: ["computer.host_*"] },
  integrations: { allowConnectors: ["slack"], mcp: { allowHosts: ["mcp.example.com"] } },
  computers: {
    allowProviders: ["kubernetes"],
    allowHostComputer: false,
    egress: { allowDomains: [], denyDomains: [] },
  },
  bots: {
    allowFleetManagement: true,
    allowSubagents: true,
    allowWebhooks: true,
    allowRoutines: true,
  },
  messaging: { allowSurfaces: ["web", "teams"] },
  data: { allowAccountExport: true },
  budgets: {
    period: "month",
    organizationUsd: 5000,
    perUserUsd: 200,
    perBotUsd: 100,
    warnAtPercent: 80,
  },
};

describe("policy schema", () => {
  it("accepts the full v1 schema and a bare version", () => {
    expect(PolicySchema.parse(FULL)).toEqual(FULL);
    expect(PolicySchema.parse({ version: 1 })).toEqual({ version: 1 });
  });

  it("rejects unknown keys at every level and unknown versions", () => {
    expect(PolicySchema.safeParse({ version: 1, extra: true }).success).toBe(false);
    expect(PolicySchema.safeParse({ version: 1, models: { allowModel: ["x"] } }).success).toBe(
      false,
    );
    expect(
      PolicySchema.safeParse({ version: 1, computers: { egress: { allow: [] } } }).success,
    ).toBe(false);
    expect(PolicySchema.safeParse({ version: 2 }).success).toBe(false);
    expect(PolicySchema.safeParse({}).success).toBe(false);
  });
});

describe("parsePolicy", () => {
  it("reads YAML and JSON", () => {
    expect(parsePolicy("version: 1\nmodels:\n  allowProviders: [azure]\n")).toEqual({
      version: 1,
      models: { allowProviders: ["azure"] },
    });
    expect(parsePolicy('{"version":1,"data":{"allowAccountExport":false}}')).toEqual({
      version: 1,
      data: { allowAccountExport: false },
    });
  });

  it("names the invalid field without echoing values", () => {
    expect(() => parsePolicy("version: 1\nmodels:\n  allowProviders: secret-value\n")).toThrow(
      /models\.allowProviders/,
    );
    expect(() => parsePolicy("version: 1\nmodels:\n  allowProviders: secret-value\n")).not.toThrow(
      /secret-value/,
    );
    expect(() => parsePolicy("version: 1\nbogus: 1\n", "RAKAZO_POLICY_FILE")).toThrow(
      PolicyFileError,
    );
    expect(() => parsePolicy("{ not: [valid")).toThrow(PolicyFileError);
    expect(() => parsePolicy("")).toThrow(PolicyFileError);
  });
});

describe("policyGlobMatches", () => {
  it("matches whole values with * and ?, ignoring case", () => {
    expect(policyGlobMatches("azure/gpt-*", "azure/gpt-5")).toBe(true);
    expect(policyGlobMatches("azure/gpt-*", "Azure/GPT-5")).toBe(true);
    expect(policyGlobMatches("azure/gpt-*", "azure/o3")).toBe(false);
    expect(policyGlobMatches("azure/gpt-?", "azure/gpt-55")).toBe(false);
    expect(policyGlobMatches("*", "anything/at-all")).toBe(true);
    expect(policyGlobMatches("a.b", "axb")).toBe(false);
    expect(policyGlobMatches("azure", "azure/gpt-5")).toBe(false);
  });
});

describe("evaluateModelUse", () => {
  const use = { provider: "azure", modelId: "gpt-5", ownConnection: false };

  it("allows everything without a policy or models section", () => {
    expect(evaluateModelUse(undefined, use)).toEqual({ allowed: true });
    expect(evaluateModelUse({ version: 1 }, use)).toEqual({ allowed: true });
  });

  it("applies provider, model and own-connection rules with the matching rule id", () => {
    const policy: Policy = PolicySchema.parse(FULL);
    expect(evaluateModelUse(policy, use)).toEqual({ allowed: true });
    expect(evaluateModelUse(policy, { ...use, provider: "openai" })).toEqual({
      allowed: false,
      rule: "models.allowProviders",
    });
    expect(evaluateModelUse(policy, { ...use, modelId: "o3" })).toEqual({
      allowed: false,
      rule: "models.allowModels",
    });
    expect(evaluateModelUse(policy, { ...use, ownConnection: true })).toEqual({
      allowed: false,
      rule: "models.allowUserConnections",
    });
  });

  it("treats the legacy azure provider id as azure and omitted lists as any", () => {
    const policy = parsePolicy("version: 1\nmodels:\n  allowModels: ['azure/*']\n");
    expect(evaluateModelUse(policy, { ...use, provider: "azure-openai-responses" }).allowed).toBe(
      true,
    );
    expect(evaluateModelUse(policy, { ...use, provider: "anthropic" }).allowed).toBe(false);
  });
});

describe("evaluateUserConnection", () => {
  it("refuses when user connections are off or the provider is not allowed", () => {
    expect(evaluateUserConnection(undefined, "openai")).toEqual({ allowed: true });
    expect(
      evaluateUserConnection({ version: 1, models: { allowUserConnections: false } }, "openai"),
    ).toEqual({ allowed: false, rule: "models.allowUserConnections" });
    expect(
      evaluateUserConnection({ version: 1, models: { allowProviders: ["azure"] } }, "openai"),
    ).toEqual({ allowed: false, rule: "models.allowProviders" });
    expect(
      evaluateUserConnection({ version: 1, models: { allowProviders: ["azure"] } }, "azure"),
    ).toEqual({ allowed: true });
  });
});

describe("filterModelCatalog", () => {
  const entries = [
    { provider: "azure", id: "gpt-5", managed: true },
    { provider: "azure", id: "o3", managed: true },
    { provider: "openai", id: "gpt-5" },
    { provider: "azure", id: "gpt-5-mini" },
  ];

  it("returns the catalog untouched without a policy", () => {
    expect(filterModelCatalog(undefined, entries)).toBe(entries);
  });

  it("drops disallowed models and, without user connections, every unmanaged entry", () => {
    const policy = PolicySchema.parse(FULL);
    expect(filterModelCatalog(policy, entries).map((entry) => entry.id)).toEqual(["gpt-5"]);
    const open = parsePolicy("version: 1\nmodels:\n  allowModels: ['azure/gpt-*']\n");
    expect(
      filterModelCatalog(open, entries).map((entry) => `${entry.provider}/${entry.id}`),
    ).toEqual(["azure/gpt-5", "azure/gpt-5-mini"]);
  });
});

describe("budgets", () => {
  const policy = parsePolicy(
    "version: 1\nbudgets:\n  organizationUsd: 1000\n  perUserUsd: 100\n  perBotUsd: 50\n",
  );
  const spend = (organization: number, user: number, bot: number) => ({ organization, user, bot });

  it("rejects non-positive limits, unknown periods and unknown keys", () => {
    for (const budgets of [
      { perUserUsd: 0 },
      { perUserUsd: -1 },
      { period: "week" },
      { warnAtPercent: 100 },
      { perTeamUsd: 5 },
    ]) {
      expect(PolicySchema.safeParse({ version: 1, budgets }).success).toBe(false);
    }
  });

  it("allows every run without a budget", () => {
    expect(evaluateBudgets(undefined, spend(1e9, 1e9, 1e9))).toEqual({ allowed: true });
    expect(evaluateBudgets(parsePolicy("version: 1\nbudgets: {}\n"), spend(1, 1, 1))).toEqual({
      allowed: true,
    });
  });

  it("allows under a limit and refuses at and over it, one scope at a time", () => {
    expect(evaluateBudgets(policy, spend(999.99, 99.99, 49.99))).toEqual({ allowed: true });
    expect(evaluateBudgets(policy, spend(1000, 0, 0))).toEqual({
      allowed: false,
      rule: "budgets.organization",
    });
    expect(evaluateBudgets(policy, spend(10, 100, 0))).toEqual({
      allowed: false,
      rule: "budgets.user",
    });
    expect(evaluateBudgets(policy, spend(10, 10, 50.5))).toEqual({
      allowed: false,
      rule: "budgets.bot",
    });
  });

  it("starts the period at the first instant of the UTC month", () => {
    expect(budgetPeriodStart(new Date("2026-11-30T23:59:59.999Z")).toISOString()).toBe(
      "2026-11-01T00:00:00.000Z",
    );
    expect(budgetPeriodStart(new Date("2026-12-01T00:00:00.000Z")).toISOString()).toBe(
      "2026-12-01T00:00:00.000Z",
    );
  });
});
