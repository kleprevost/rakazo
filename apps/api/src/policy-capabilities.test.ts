import { setActivePolicy } from "@rakazo/adapters";
import type { Actor, Policy } from "@rakazo/contracts";
import { LOCAL_COMPUTER_HOST_PATH, LOCAL_SETTINGS_TOKEN_HEADER } from "@rakazo/contracts";
import { installSecurityEventStore } from "@rakazo/db";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mountAccountExportRoute } from "./account-export.js";
import { mountLocalComputerHost } from "./local-settings.js";
import {
  assertBotCapabilityAllowedForRequest,
  assertComputerProviderAllowedForRequest,
  assertMessagingSurfaceAllowedForRequest,
} from "./policy-capabilities-guard.js";
import { webhookDenied } from "./webhook-policy.js";

const rows: Array<Record<string, unknown>> = [];
beforeEach(() => {
  rows.length = 0;
  installSecurityEventStore({
    securityEvent: {
      create: vi.fn(async (args: { data: Record<string, unknown> }) => {
        rows.push(args.data);
        return args.data;
      }),
    },
  } as never);
});
afterEach(() => {
  setActivePolicy(undefined);
  installSecurityEventStore(undefined);
});

const actor = { userId: "user-1", spaceId: "space-1" } as Actor;
const policy = (rest: Omit<Policy, "version">): Policy => ({ version: 1, ...rest });

async function forbidden(promise: Promise<unknown>) {
  return promise.then(
    () => undefined,
    (error: { code: string; message: string; data: unknown }) => error,
  );
}

describe("request guards", () => {
  it("refuse a disallowed computer provider with the policy reason, but never going back to default", async () => {
    setActivePolicy(policy({ computers: { allowProviders: ["kubernetes"] } }));
    await assertComputerProviderAllowedForRequest(actor, "default");
    await assertComputerProviderAllowedForRequest(actor, "kubernetes");
    const error = await forbidden(assertComputerProviderAllowedForRequest(actor, "e2b"));
    expect(error).toMatchObject({
      code: "FORBIDDEN",
      message: "Blocked by your organization",
      data: { reason: "policy", rule: "computers.allowProviders" },
    });
    expect(rows).toEqual([
      expect.objectContaining({
        type: "policy.denied",
        metadata: { rule: "computers.allowProviders", subject: "e2b", surface: "settings" },
      }),
    ]);
  });

  it("refuse bot capabilities and messaging surfaces the policy switches off", async () => {
    setActivePolicy(
      policy({ bots: { allowRoutines: false }, messaging: { allowSurfaces: ["slack"] } }),
    );
    await assertBotCapabilityAllowedForRequest(actor, "webhooks");
    expect(await forbidden(assertBotCapabilityAllowedForRequest(actor, "routines"))).toMatchObject({
      data: { reason: "policy", rule: "bots.allowRoutines" },
    });
    await assertMessagingSurfaceAllowedForRequest(actor, "slack");
    expect(
      await forbidden(assertMessagingSurfaceAllowedForRequest(actor, "telegram")),
    ).toMatchObject({ data: { reason: "policy", rule: "messaging.allowSurfaces" } });
  });
});

describe("webhookDenied", () => {
  it("is true and recorded only when webhooks are switched off", async () => {
    const bot = { spaceId: "space-1", userId: "user-1" };
    expect(await webhookDenied(bot)).toBe(false);
    setActivePolicy(policy({ bots: { allowWebhooks: false } }));
    expect(await webhookDenied(bot)).toBe(true);
    expect(rows).toEqual([
      expect.objectContaining({
        type: "policy.denied",
        metadata: { rule: "bots.allowWebhooks", subject: "webhooks", surface: "webhook" },
      }),
    ]);
  });
});

describe("account export download", () => {
  function app() {
    const consumeAccountExportToken = vi.fn(async () => "user-1");
    const hono = new Hono();
    mountAccountExportRoute(hono, {
      prisma: {} as never,
      auth: { consumeAccountExportToken },
      artifacts: {} as never,
      home: {} as never,
    });
    return hono;
  }

  it("is refused with the one message when the policy forbids exports", async () => {
    setActivePolicy(policy({ data: { allowAccountExport: false } }));
    const res = await app().request("/api/account/export?token=t");
    expect(res.status).toBe(403);
    expect(await res.text()).toBe("Blocked by your organization");
    expect(rows).toEqual([
      expect.objectContaining({
        type: "policy.denied",
        userId: "user-1",
        metadata: { rule: "data.allowAccountExport", subject: "account-export", surface: "export" },
      }),
    ]);
  });
});

describe("local computer host choice", () => {
  const token = "a".repeat(64);

  it("refuses choosing this computer when the host computer is switched off", async () => {
    setActivePolicy(policy({ computers: { allowHostComputer: false } }));
    const upsert = vi.fn(async () => ({}));
    const hono = new Hono();
    mountLocalComputerHost(hono, {
      token,
      sandboxProvider: "docker",
      prisma: { deploymentSettings: { upsert } } as never,
    });
    const choose = (computerHost: string) =>
      hono.request(LOCAL_COMPUTER_HOST_PATH, {
        method: "POST",
        headers: { [LOCAL_SETTINGS_TOKEN_HEADER]: token },
        body: JSON.stringify({ computerHost }),
      });
    const refused = await choose("this-mac");
    expect(refused.status).toBe(403);
    expect(await refused.json()).toMatchObject({
      reason: "policy",
      rule: "computers.allowHostComputer",
    });
    expect(upsert).not.toHaveBeenCalled();
    expect((await choose("docker")).status).toBe(200);
    expect(upsert).toHaveBeenCalledTimes(1);
  });
});
