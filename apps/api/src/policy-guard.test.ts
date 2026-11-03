import { ORPCError } from "@orpc/server";
import { setActivePolicy } from "@rakazo/adapters";
import { installSecurityEventStore } from "@rakazo/db";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertApprovalModeForRequest,
  assertConnectionAllowedForRequest,
  assertModelAllowedForRequest,
} from "./policy-guard.js";

const actor = { userId: "user-1", spaceId: "space-1" } as never;

afterEach(() => {
  setActivePolicy(undefined);
  installSecurityEventStore(undefined);
});

describe("settings-time policy guard", () => {
  it("passes without a policy", async () => {
    await expect(
      assertModelAllowedForRequest(actor, {
        provider: "openai",
        modelId: "x",
        ownConnection: true,
      }),
    ).resolves.toBeUndefined();
    await expect(assertConnectionAllowedForRequest(actor, "openai")).resolves.toBeUndefined();
  });

  it("refuses a looser approval mode than the floor with a structured reason", async () => {
    setActivePolicy({ version: 1, approvals: { minimumMode: "ask" } });
    await expect(assertApprovalModeForRequest(actor, "ask")).resolves.toBeUndefined();
    const error = await assertApprovalModeForRequest(actor, "never").catch((e) => e);
    expect(error.code).toBe("FORBIDDEN");
    expect(error.data).toEqual({ reason: "policy", rule: "approvals.minimumMode" });
  });

  it("answers FORBIDDEN with a structured policy reason", async () => {
    setActivePolicy({ version: 1, models: { allowUserConnections: false } });
    const error = await assertConnectionAllowedForRequest(actor, "openai").catch((e) => e);
    expect(error).toBeInstanceOf(ORPCError);
    expect(error.code).toBe("FORBIDDEN");
    expect(error.message).toBe("Blocked by your organization");
    expect(error.data).toEqual({ reason: "policy", rule: "models.allowUserConnections" });
    const modelError = await assertModelAllowedForRequest(actor, {
      provider: "openai",
      modelId: "x",
      ownConnection: true,
    }).catch((e) => e);
    expect(modelError.data).toEqual({ reason: "policy", rule: "models.allowUserConnections" });
  });
});
