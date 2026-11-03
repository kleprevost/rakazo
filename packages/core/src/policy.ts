import type { Policy } from "@rakazo/contracts";
import { canonicalPiProviderId, PolicySchema } from "@rakazo/contracts";
import { parse as parseYaml } from "yaml";

/** Thrown for a policy file that cannot be read as a valid v1 policy. */
export class PolicyFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PolicyFileError";
  }
}

/** Parse policy text. JSON is YAML, so one parser reads both. Never returns a partial policy. */
export function parsePolicy(text: string, source = "policy file"): Policy {
  let raw: unknown;
  try {
    raw = parseYaml(text);
  } catch (error) {
    throw new PolicyFileError(
      `${source} is not valid YAML or JSON: ${error instanceof Error ? error.message.split("\n")[0] : "parse error"}`,
    );
  }
  const parsed = PolicySchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .slice(0, 5)
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ");
    throw new PolicyFileError(`${source} is invalid: ${issues}`);
  }
  return parsed.data;
}

/** `*` matches any run of characters, `?` one character; case-insensitive, whole value. */
export function policyGlobMatches(pattern: string, value: string): boolean {
  const source = pattern
    .toLowerCase()
    .split("")
    .map((char) =>
      char === "*" ? ".*" : char === "?" ? "." : char.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&"),
    )
    .join("");
  return new RegExp(`^${source}$`, "s").test(value.toLowerCase());
}

export type PolicyDecision = { allowed: true } | { allowed: false; rule: string };

const ALLOWED: PolicyDecision = { allowed: true };

/**
 * Whether a model may run. `ownConnection` is true when the run uses a credential or endpoint
 * the user added, false when it uses the deployment's. No policy allows everything.
 */
export function evaluateModelUse(
  policy: Policy | undefined,
  use: { provider: string; modelId: string; ownConnection: boolean },
): PolicyDecision {
  const models = policy?.models;
  if (!models) return ALLOWED;
  if (use.ownConnection && models.allowUserConnections === false)
    return { allowed: false, rule: "models.allowUserConnections" };
  const provider = canonicalPiProviderId(use.provider);
  if (models.allowProviders && !models.allowProviders.includes(provider))
    return { allowed: false, rule: "models.allowProviders" };
  if (
    models.allowModels &&
    !models.allowModels.some((glob) => policyGlobMatches(glob, `${provider}/${use.modelId}`))
  )
    return { allowed: false, rule: "models.allowModels" };
  return ALLOWED;
}

/** Whether a user may add their own connection to `provider`. */
export function evaluateUserConnection(
  policy: Policy | undefined,
  provider: string,
): PolicyDecision {
  const models = policy?.models;
  if (models?.allowUserConnections === false)
    return { allowed: false, rule: "models.allowUserConnections" };
  if (models?.allowProviders && !models.allowProviders.includes(canonicalPiProviderId(provider)))
    return { allowed: false, rule: "models.allowProviders" };
  return ALLOWED;
}

/**
 * The catalog entries a user may pick. A managed entry runs on the deployment's credentials;
 * any other runs on the user's own connection.
 */
export function filterModelCatalog<
  T extends { provider: string; id: string; managed?: boolean | undefined },
>(policy: Policy | undefined, entries: T[]): T[] {
  if (!policy?.models) return entries;
  return entries.filter(
    (entry) =>
      evaluateModelUse(policy, {
        provider: entry.provider,
        modelId: entry.id,
        ownConnection: !entry.managed,
      }).allowed,
  );
}

export type BudgetScope = "organization" | "user" | "bot";
export type BudgetSpend = { organization: number; user: number; bot: number };

/** Start of the budget period containing `now`: the first instant of the UTC calendar month. */
export function budgetPeriodStart(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

const BUDGET_LIMITS = {
  organization: "organizationUsd",
  user: "perUserUsd",
  bot: "perBotUsd",
} as const;

/** The configured limit for a scope, or undefined when the policy sets none. */
export function budgetLimit(policy: Policy | undefined, scope: BudgetScope): number | undefined {
  return policy?.budgets?.[BUDGET_LIMITS[scope]];
}

/** Whether a run may start given period spend. A limit is reached once spend equals it. */
export function evaluateBudgets(policy: Policy | undefined, spend: BudgetSpend): PolicyDecision {
  for (const scope of ["organization", "user", "bot"] as const) {
    const limit = budgetLimit(policy, scope);
    if (limit !== undefined && spend[scope] >= limit)
      return { allowed: false, rule: `budgets.${scope}` };
  }
  return ALLOWED;
}
