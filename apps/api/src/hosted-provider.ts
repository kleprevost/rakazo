import type { RouterDeps } from "./router.js";

/**
 * The provider the deployment's own credentials serve members with: always while credits are
 * metered, otherwise whenever the deployment model can run (the organization's models).
 */
export function hostedProviderOf(deps: Pick<RouterDeps, "billing" | "env">): string | undefined {
  return deps.billing?.modelCreditsEnabled || deps.env.deploymentModelConfigured
    ? deps.env.defaultProvider
    : undefined;
}
