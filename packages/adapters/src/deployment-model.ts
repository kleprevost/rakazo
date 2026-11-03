import { getEnvApiKey } from "@earendil-works/pi-ai/compat";
import type { ModelUsageLookup } from "@rakazo/adapter-kit";
import { OpenRouterUsageLookup } from "./openrouter-usage.js";
import { LOCAL_PROVIDER_ID, localModelIds } from "./pi-local-provider-id.js";

export const DEFAULT_OPENROUTER_MODEL_ID = "openai/gpt-6-luna";

/**
 * What Pi reports for a provider that authenticates from the host instead of a key: an AWS
 * profile or task role for Amazon Bedrock, Application Default Credentials for Vertex.
 */
const HOST_CREDENTIALS = "<authenticated>";

/** What a provider's host credentials are, for telling a user what a deployment runs on. */
const HOST_CREDENTIAL_SOURCES: Record<string, string> = {
  "amazon-bedrock": "AWS IAM",
  "google-vertex": "Google Cloud",
};

/** The kind of host credentials a provider authenticates with, e.g. "AWS IAM". */
export function hostCredentialSource(provider: string): string {
  return HOST_CREDENTIAL_SOURCES[provider] ?? "host";
}

/**
 * The deployment-wide model default: which provider a run falls back to when no user
 * credential applies, and the key for that provider.
 *
 * Keyless host authentication requires explicit opt-in and a model id. Bedrock resolves
 * its credential chain (including instance roles) at request time; local models must be
 * declared by the operator; other providers must report host credentials in the process
 * environment. Host credentials never become `key`.
 *
 * Vendor env names and model ids live here, in the adapter layer, not in core.
 */
export function resolveDeploymentModel(env: NodeJS.ProcessEnv = process.env) {
  const provider = env.PI_DEFAULT_PROVIDER?.trim() || "openrouter";
  // An unknown provider gets no key rather than another vendor's.
  const keys: Record<string, string | undefined> = {
    openrouter: env.OPENROUTER_API_KEY,
    anthropic: env.ANTHROPIC_API_KEY,
  };
  const models: Record<string, string> = {
    openrouter: DEFAULT_OPENROUTER_MODEL_ID,
    anthropic: "claude-sonnet-5",
  };
  const explicitModel = env.PI_DEFAULT_MODEL?.trim();
  // Any other provider with a standard key variable (OPENCODE_API_KEY, AZURE_OPENAI_API_KEY, ...)
  // uses the key Pi reports for it; host credentials are not a key.
  const envKey = provider in keys ? undefined : getEnvApiKey(provider, definedEnv(env));
  const key = keys[provider] ?? (envKey && envKey !== HOST_CREDENTIALS ? envKey : undefined);
  const hostCredentials =
    !key &&
    Boolean(explicitModel) &&
    env.PI_DEFAULT_CREDENTIALS?.trim() === "host" &&
    // Bedrock also resolves EC2 instance roles through IMDS at request time.
    (provider === LOCAL_PROVIDER_ID
      ? localModelIds(env).includes(explicitModel!)
      : provider === "amazon-bedrock" || getEnvApiKey(provider) === HOST_CREDENTIALS);
  return {
    provider,
    model: explicitModel || models[provider] || models.openrouter!,
    key,
    configured: Boolean(key) || hostCredentials,
    hostCredentials,
  };
}

/**
 * The provider whose deployment credentials serve members: always while credits are metered,
 * otherwise whenever the deployment model can run (the organization's models).
 */
export function hostedModelProvider(
  meteredCredits: boolean,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const deployment = resolveDeploymentModel(env);
  return meteredCredits || deployment.configured ? deployment.provider : undefined;
}

/**
 * Whether the deployment's own credentials can serve `modelId`, for the organization models
 * every member may pick. Azure serves only the deployments the operator named: the models in
 * `AZURE_OPENAI_DEPLOYMENT_NAME_MAP`, plus the default model. Other providers serve their
 * whole catalog.
 */
export function deploymentServesModel(
  provider: string,
  modelId: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (provider !== "azure") return true;
  const deployed = (env.AZURE_OPENAI_DEPLOYMENT_NAME_MAP ?? "")
    .split(",")
    .map((pair) => pair.split("=")[0]?.trim());
  return modelId === env.PI_DEFAULT_MODEL?.trim() || deployed.includes(modelId);
}

function definedEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
}

export function deploymentModelUsageLookup(): ModelUsageLookup | undefined {
  const model = resolveDeploymentModel();
  return model.provider === "openrouter" && model.key
    ? new OpenRouterUsageLookup(model.key)
    : undefined;
}
