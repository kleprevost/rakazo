import { createRouterClient } from "@orpc/server";
import { setActivePolicy } from "@rakazo/adapters";
import type { Actor } from "@rakazo/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { assertConnectionAllowedForRequest } from "./policy-guard.js";
import type { RouterDeps } from "./router.js";
import { createRouter } from "./router.js";

const actor = {
  userId: "user-test",
  spaceId: "space-test",
  email: "user@example.test",
  isDeploymentOwner: false,
} satisfies Actor;

/** A deployment on Azure with two named deployments and no personal connections. */
async function memberCatalog(modelCreditsEnabled: boolean | null = false) {
  const prisma = {
    userModelCredential: { findMany: vi.fn(async () => []), findFirst: vi.fn(async () => null) },
    userModelPreference: { findMany: vi.fn(async () => []) },
    space: { findFirst: vi.fn(async () => null) },
    deploymentSettings: {
      findUnique: vi.fn(async () =>
        modelCreditsEnabled === null ? null : { modelCreditsEnabled },
      ),
    },
  };
  const deps = {
    prisma,
    secrets: { load: vi.fn() },
    env: {
      agentRuntime: "pi",
      defaultProvider: "azure",
      defaultModel: "gpt-4.1",
      deploymentModelConfigured: true,
    },
  } as unknown as RouterDeps;
  const client = createRouterClient(createRouter(deps), { context: { actor } as never });
  return client.models.list();
}

describe("organization models", () => {
  beforeEach(() => {
    vi.stubEnv("PI_DEFAULT_PROVIDER", "azure");
    vi.stubEnv("PI_DEFAULT_MODEL", "gpt-4.1");
    vi.stubEnv("AZURE_OPENAI_API_KEY", "fake-azure-key");
    vi.stubEnv("AZURE_OPENAI_DEPLOYMENT_NAME_MAP", "gpt-4.1-mini=mini-prod, gpt-4.1=main-prod");
  });
  afterEach(() => {
    setActivePolicy(undefined);
    vi.unstubAllEnvs();
  });

  const azure = (entries: Awaited<ReturnType<typeof memberCatalog>>) =>
    entries.filter((entry) => entry.provider === "azure");

  it("lists every deployed model of the deployment provider without a personal connection", async () => {
    const entries = azure(await memberCatalog());
    expect(entries.map((entry) => entry.id).sort()).toEqual(["gpt-4.1", "gpt-4.1-mini"]);
    expect(entries.every((entry) => entry.managed === true)).toBe(true);
    expect(entries[0]?.billing).toBe("Provided by your organization");
    expect(entries.find((entry) => entry.id === "gpt-4.1")).toMatchObject({
      inputUsdPerMillion: 2,
      outputUsdPerMillion: 8,
    });
  });

  it("lists the same models under allowUserConnections false", async () => {
    setActivePolicy({
      version: 1,
      models: { allowProviders: ["azure"], allowUserConnections: false },
    });
    const entries = await memberCatalog();
    expect(entries.map((entry) => entry.provider)).toEqual(["azure", "azure"]);
    await expect(assertConnectionAllowedForRequest(actor as never, "azure")).rejects.toMatchObject({
      data: { rule: "models.allowUserConnections" },
    });
  });

  it("narrows the list to allowModels", async () => {
    setActivePolicy({
      version: 1,
      models: { allowUserConnections: false, allowModels: ["azure/gpt-4.1-mini"] },
    });
    expect((await memberCatalog()).map((entry) => entry.id)).toEqual(["gpt-4.1-mini"]);
  });

  it("offers only the default model when Azure has no deployment map", async () => {
    vi.stubEnv("AZURE_OPENAI_DEPLOYMENT_NAME_MAP", "");
    expect(azure(await memberCatalog()).map((entry) => entry.id)).toEqual(["gpt-4.1"]);
  });

  it("keeps the models behind a connection when credits are metered and unfunded", async () => {
    expect(azure(await memberCatalog(true)).some((entry) => entry.managed)).toBe(false);
  });
});
