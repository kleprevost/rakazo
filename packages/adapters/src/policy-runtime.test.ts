import { POLICY_DENIED_MESSAGE } from "@rakazo/contracts";
import { PolicyFileError } from "@rakazo/core";
import { installSecurityEventStore } from "@rakazo/db";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { validateBotModelChange } from "./model-selection.js";
import {
  activePolicy,
  assertModelAllowed,
  assertUserConnectionAllowed,
  loadPolicyFromEnv,
  PolicyDeniedError,
  setActivePolicy,
} from "./policy-runtime.js";
import { isTerminalModelSetupError, resolveModelKey } from "./run-model.js";

const rows: Array<{ data: Record<string, unknown> }> = [];
const store = {
  securityEvent: {
    create: vi.fn(async (args: { data: Record<string, unknown> }) => {
      rows.push(args);
      return args.data;
    }),
  },
};
const events = () => rows.map(({ data }) => data);

beforeEach(() => {
  rows.length = 0;
  installSecurityEventStore(store as never);
});
afterEach(() => {
  setActivePolicy(undefined);
  installSecurityEventStore(undefined);
});

describe("loadPolicyFromEnv", () => {
  it("leaves no policy and records nothing when the variable is absent", async () => {
    await expect(loadPolicyFromEnv({}, () => "unused")).resolves.toBeUndefined();
    expect(activePolicy()).toBeUndefined();
    expect(events()).toEqual([]);
  });

  it("loads a valid file once and records its version and content hash", async () => {
    const text = "version: 1\nmodels:\n  allowProviders: [azure]\n";
    const loaded = await loadPolicyFromEnv({ RAKAZO_POLICY_FILE: "/etc/policy.yaml" }, () => text);
    expect(loaded?.policy).toEqual({ version: 1, models: { allowProviders: ["azure"] } });
    expect(activePolicy()).toEqual(loaded?.policy);
    expect(loaded?.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(events()).toEqual([
      expect.objectContaining({
        type: "policy.loaded",
        metadata: { version: 1, hash: loaded?.hash },
      }),
    ]);
  });

  it("fails on an invalid or unreadable file and keeps no policy", async () => {
    await expect(
      loadPolicyFromEnv({ RAKAZO_POLICY_FILE: "/p" }, () => "version: 1\nmodel: {}\n"),
    ).rejects.toBeInstanceOf(PolicyFileError);
    await expect(
      loadPolicyFromEnv({ RAKAZO_POLICY_FILE: "/p" }, () => {
        throw Object.assign(new Error("nope"), { code: "ENOENT" });
      }),
    ).rejects.toThrow(/could not be read: ENOENT/);
    expect(activePolicy()).toBeUndefined();
    expect(events()).toEqual([]);
  });
});

describe("denials", () => {
  const audience = { userId: "user-1", spaceId: "space-1", surface: "test" };

  it("does nothing without a policy", async () => {
    await assertModelAllowed({ provider: "openai", modelId: "x", ownConnection: true }, audience);
    expect(events()).toEqual([]);
  });

  it("throws the short message and records the rule and subject only", async () => {
    setActivePolicy({ version: 1, models: { allowProviders: ["azure"] } });
    const error = await assertModelAllowed(
      { provider: "openai", modelId: "gpt-5", ownConnection: false },
      audience,
    ).catch((caught) => caught);
    expect(error).toBeInstanceOf(PolicyDeniedError);
    expect(error.message).toBe(POLICY_DENIED_MESSAGE);
    expect(error.rule).toBe("models.allowProviders");
    expect(events()).toEqual([
      expect.objectContaining({
        type: "policy.denied",
        userId: "user-1",
        metadata: { rule: "models.allowProviders", subject: "openai/gpt-5", surface: "test" },
      }),
    ]);
  });

  it("refuses adding a connection when users may not", async () => {
    setActivePolicy({ version: 1, models: { allowUserConnections: false } });
    await expect(assertUserConnectionAllowed("openai", audience)).rejects.toBeInstanceOf(
      PolicyDeniedError,
    );
    expect(events()[0]?.metadata).toMatchObject({ rule: "models.allowUserConnections" });
  });
});

describe("enforcement seams", () => {
  it("fails a run before any credential is read when the model is disallowed", async () => {
    setActivePolicy({ version: 1, models: { allowModels: ["azure/*"] } });
    const deps = { billingEnabled: false, prisma: {} } as never;
    const error = await resolveModelKey(deps, "user-1", "space-1", null, "openai", "gpt-5").catch(
      (caught) => caught,
    );
    expect(error).toBeInstanceOf(PolicyDeniedError);
    expect(error.message).toBe(POLICY_DENIED_MESSAGE);
    expect(isTerminalModelSetupError(error)).toBe(true);
    expect(events()[0]).toMatchObject({
      type: "policy.denied",
      metadata: { subject: "openai/gpt-5", surface: "run" },
    });
  });

  it("denies a run on the user's own credential when user connections are off", async () => {
    setActivePolicy({ version: 1, models: { allowUserConnections: false } });
    const credential = { id: "c", secretId: "s", provider: "openai" };
    await expect(
      resolveModelKey(
        { billingEnabled: false, prisma: {} } as never,
        "u",
        "sp",
        credential,
        "openai",
        "gpt-5",
      ),
    ).rejects.toMatchObject({ rule: "models.allowUserConnections" });
  });

  it("rejects a bot model change to a disallowed model", async () => {
    setActivePolicy({ version: 1, models: { allowProviders: ["azure"] } });
    const prisma = {
      userModelPreference: { findFirst: async () => null },
      userModelCredential: { findFirst: async () => null, findMany: async () => [] },
    };
    const result = await validateBotModelChange(
      {
        prisma,
        secretStore: {},
        refreshExpiredCredential: vi.fn(),
        defaultModel: vi.fn(),
      } as never,
      { userId: "user-1", spaceId: "space-1", provider: "openai", model: "gpt-5" },
    );
    expect(result).toEqual({ ok: false, error: POLICY_DENIED_MESSAGE });
    expect(events()[0]).toMatchObject({ metadata: { surface: "bot_model" } });
  });
});
