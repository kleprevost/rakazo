import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  deploymentServesModel,
  hostedModelProvider,
  resolveDeploymentModel,
} from "./deployment-model.js";

// Host credentials come from the process, so blank the ones a developer machine or CI
// host may carry; each case states its own.
const HOST_CREDENTIAL_ENV = [
  "AWS_PROFILE",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_BEARER_TOKEN_BEDROCK",
  "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI",
  "AWS_CONTAINER_CREDENTIALS_FULL_URI",
  "AWS_WEB_IDENTITY_TOKEN_FILE",
];

describe("organization models", () => {
  const azure = {
    PI_DEFAULT_PROVIDER: "azure",
    PI_DEFAULT_MODEL: "gpt-4.1",
    AZURE_OPENAI_API_KEY: "fake-azure-key",
    AZURE_OPENAI_DEPLOYMENT_NAME_MAP: "gpt-4.1-mini=mini-prod, gpt-5.1=big-prod",
  };

  it("serves the named Azure deployments and the default model only", () => {
    for (const id of ["gpt-4.1", "gpt-4.1-mini", "gpt-5.1"])
      expect(deploymentServesModel("azure", id, azure)).toBe(true);
    expect(deploymentServesModel("azure", "gpt-4", azure)).toBe(false);
    expect(
      deploymentServesModel("azure", "gpt-4.1-mini", {
        ...azure,
        AZURE_OPENAI_DEPLOYMENT_NAME_MAP: "",
      }),
    ).toBe(false);
  });

  it("serves a whole catalog for providers that need no deployment names", () => {
    expect(deploymentServesModel("opencode", "any-model", {})).toBe(true);
  });

  it("names the hosted provider while credits are metered or the deployment model can run", () => {
    expect(hostedModelProvider(false, azure)).toBe("azure");
    expect(hostedModelProvider(true, {})).toBe("openrouter");
    expect(hostedModelProvider(false, {})).toBeUndefined();
  });
});

describe("resolveDeploymentModel", () => {
  beforeEach(() => {
    for (const name of HOST_CREDENTIAL_ENV) vi.stubEnv(name, "");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("pairs the deployment model key with the provider it belongs to", () => {
    const both = { OPENROUTER_API_KEY: "or-key", ANTHROPIC_API_KEY: "sk-ant-key" };
    expect(resolveDeploymentModel(both)).toEqual({
      provider: "openrouter",
      model: "openai/gpt-6-luna",
      key: "or-key",
      configured: true,
      hostCredentials: false,
    });
    // Switching the provider switches the key with it.
    expect(resolveDeploymentModel({ ...both, PI_DEFAULT_PROVIDER: "anthropic" })).toEqual({
      provider: "anthropic",
      model: "claude-sonnet-5",
      key: "sk-ant-key",
      configured: true,
      hostCredentials: false,
    });
    // A provider with no key configured yields no key — never another vendor's.
    expect(
      resolveDeploymentModel({ OPENROUTER_API_KEY: "or-key", PI_DEFAULT_PROVIDER: "anthropic" }),
    ).toEqual({
      provider: "anthropic",
      model: "claude-sonnet-5",
      key: undefined,
      configured: false,
      hostCredentials: false,
    });
  });

  it("uses the standard key variable of any other provider as the deployment key", () => {
    expect(
      resolveDeploymentModel({
        PI_DEFAULT_PROVIDER: "opencode",
        PI_DEFAULT_MODEL: "example-model",
        OPENCODE_API_KEY: "oc-key",
        OPENROUTER_API_KEY: "or-key",
      }),
    ).toMatchObject({
      provider: "opencode",
      model: "example-model",
      key: "oc-key",
      configured: true,
    });
    expect(
      resolveDeploymentModel({
        PI_DEFAULT_PROVIDER: "azure",
        PI_DEFAULT_MODEL: "example-deployment",
        AZURE_OPENAI_API_KEY: "az-key",
      }),
    ).toMatchObject({ provider: "azure", key: "az-key", configured: true });
    // Without its own key a provider is unconfigured, never falling back to another vendor's.
    expect(
      resolveDeploymentModel({ PI_DEFAULT_PROVIDER: "azure", OPENROUTER_API_KEY: "or-key" }),
    ).toMatchObject({ key: undefined, configured: false });
  });

  it("runs a provider that authenticates from the host without a key", () => {
    vi.stubEnv("AWS_CONTAINER_CREDENTIALS_RELATIVE_URI", "/v2/credentials/example");
    const taskRole = {
      PI_DEFAULT_PROVIDER: "amazon-bedrock",
      PI_DEFAULT_MODEL: "eu.anthropic.claude-sonnet-5",
      PI_DEFAULT_CREDENTIALS: "host",
    };
    expect(resolveDeploymentModel(taskRole)).toEqual({
      provider: "amazon-bedrock",
      model: "eu.anthropic.claude-sonnet-5",
      key: undefined,
      configured: true,
      hostCredentials: true,
    });
  });

  it("leaves a deployment that did not opt in unchanged, even with host credentials", () => {
    vi.stubEnv("AWS_CONTAINER_CREDENTIALS_RELATIVE_URI", "/v2/credentials/example");
    const withoutOptIn = {
      PI_DEFAULT_PROVIDER: "amazon-bedrock",
      PI_DEFAULT_MODEL: "eu.anthropic.claude-sonnet-5",
    };
    expect(resolveDeploymentModel(withoutOptIn).configured).toBe(false);
    expect(
      resolveDeploymentModel({ ...withoutOptIn, PI_DEFAULT_CREDENTIALS: "true" }).configured,
    ).toBe(false);
  });

  it("allows Bedrock instance roles without environment credentials, but requires an explicit model", () => {
    const provider = { PI_DEFAULT_PROVIDER: "amazon-bedrock", PI_DEFAULT_CREDENTIALS: "host" };
    expect(resolveDeploymentModel(provider).configured).toBe(false);
    expect(
      resolveDeploymentModel({ ...provider, PI_DEFAULT_MODEL: "eu.anthropic.claude-sonnet-5" }),
    ).toMatchObject({
      configured: true,
      hostCredentials: true,
      key: undefined,
    });
  });

  it("does not assume host authentication for other providers", () => {
    expect(
      resolveDeploymentModel({
        PI_DEFAULT_PROVIDER: "unknown",
        PI_DEFAULT_MODEL: "example-model",
        PI_DEFAULT_CREDENTIALS: "host",
      }).configured,
    ).toBe(false);
  });

  it("allows an explicitly declared keyless local model as the deployment default", () => {
    expect(
      resolveDeploymentModel({
        PI_DEFAULT_PROVIDER: " local ",
        PI_DEFAULT_MODEL: " example-model ",
        PI_DEFAULT_CREDENTIALS: " host ",
        RAKAZO_LOCAL_MODELS: "other-model, , example-model ,",
        OPENROUTER_API_KEY: "or-key",
      }),
    ).toEqual({
      provider: "local",
      model: "example-model",
      key: undefined,
      configured: true,
      hostCredentials: true,
    });
  });

  it.each([
    { RAKAZO_LOCAL_MODELS: undefined },
    { RAKAZO_LOCAL_MODELS: " , , " },
    { RAKAZO_LOCAL_MODELS: "example-model-extra,other-example-model" },
    { RAKAZO_LOCAL_MODELS: "EXAMPLE-MODEL" },
    { PI_DEFAULT_MODEL: undefined },
    { PI_DEFAULT_MODEL: " " },
    { PI_DEFAULT_CREDENTIALS: undefined },
    { PI_DEFAULT_CREDENTIALS: "true" },
    { PI_DEFAULT_PROVIDER: "unknown" },
  ])("rejects a keyless local default without declaration and opt-in: %j", (overrides) => {
    expect(
      resolveDeploymentModel({
        PI_DEFAULT_PROVIDER: "local",
        PI_DEFAULT_MODEL: "example-model",
        PI_DEFAULT_CREDENTIALS: "host",
        RAKAZO_LOCAL_MODELS: "example-model",
        ...overrides,
      }),
    ).toMatchObject({ key: undefined, configured: false, hostCredentials: false });
  });
});
