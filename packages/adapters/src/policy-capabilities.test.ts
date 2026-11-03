import type { AdapterContext, MessagingSurface } from "@rakazo/adapter-kit";
import type { Policy } from "@rakazo/contracts";
import { installSecurityEventStore } from "@rakazo/db";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  assertAccountExportAllowed,
  assertBotCapabilityAllowed,
  assertComputerKindAllowed,
  assertHostComputerAllowed,
  assertMessagingSurfaceAllowed,
  assertRunTriggerAllowed,
  filterToolsByBotPolicy,
  PolicyMessagingSurface,
  policyDenied,
} from "./policy-capabilities.js";
import { PolicyDeniedError, setActivePolicy } from "./policy-runtime.js";
import type { RunContext } from "./run-context.js";
import type { ToolRequest } from "./run-tool-request.js";
import { prepareToolRequest } from "./run-tool-request.js";

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
const audience = { userId: "user-1", spaceId: "space-1", surface: "test" };
const policy = (rest: Omit<Policy, "version">): Policy => ({ version: 1, ...rest });

beforeEach(() => {
  rows.length = 0;
  installSecurityEventStore(store as never);
});
afterEach(() => {
  setActivePolicy(undefined);
  installSecurityEventStore(undefined);
});

describe("capability asserts", () => {
  it("do nothing and record nothing without a policy", async () => {
    await assertComputerKindAllowed("docker", audience);
    await assertHostComputerAllowed(audience);
    await assertBotCapabilityAllowed("webhooks", audience);
    await assertRunTriggerAllowed("routine", audience);
    await assertMessagingSurfaceAllowed("slack", audience);
    await assertAccountExportAllowed(audience);
    expect(events()).toEqual([]);
  });

  it("refuse a computer kind outside the allowed providers and record the rule only", async () => {
    setActivePolicy(policy({ computers: { allowProviders: ["kubernetes"] } }));
    await assertComputerKindAllowed("kubernetes", audience);
    await expect(assertComputerKindAllowed("e2b", audience)).rejects.toMatchObject({
      reason: "policy",
      rule: "computers.allowProviders",
      message: "Blocked by your organization",
    });
    expect(events()).toEqual([
      expect.objectContaining({
        type: "policy.denied",
        userId: "user-1",
        spaceId: "space-1",
        metadata: { rule: "computers.allowProviders", subject: "e2b", surface: "test" },
      }),
    ]);
  });

  it("refuse the host computer when it is switched off", async () => {
    setActivePolicy(policy({ computers: { allowHostComputer: false } }));
    await expect(assertHostComputerAllowed(audience)).rejects.toBeInstanceOf(PolicyDeniedError);
    await expect(assertComputerKindAllowed("desktop", audience)).rejects.toMatchObject({
      rule: "computers.allowHostComputer",
    });
    await assertComputerKindAllowed("docker", audience);
  });

  it("refuse routine and webhook runs but not user runs", async () => {
    setActivePolicy(policy({ bots: { allowRoutines: false, allowWebhooks: false } }));
    await expect(assertRunTriggerAllowed("routine", audience)).rejects.toMatchObject({
      rule: "bots.allowRoutines",
    });
    await expect(assertRunTriggerAllowed("webhook", audience)).rejects.toMatchObject({
      rule: "bots.allowWebhooks",
    });
    await assertRunTriggerAllowed("user", audience);
    expect(events()).toHaveLength(2);
  });

  it("refuse an account export when it is switched off", async () => {
    setActivePolicy(policy({ data: { allowAccountExport: false } }));
    await expect(assertAccountExportAllowed(audience)).rejects.toMatchObject({
      rule: "data.allowAccountExport",
    });
  });

  it("policyDenied turns a denial into true and lets other errors through", async () => {
    setActivePolicy(policy({ bots: { allowWebhooks: false } }));
    await expect(
      policyDenied(() => assertBotCapabilityAllowed("webhooks", audience)),
    ).resolves.toBe(true);
    await expect(
      policyDenied(() => assertBotCapabilityAllowed("routines", audience)),
    ).resolves.toBe(false);
    await expect(
      policyDenied(async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
  });
});

describe("filterToolsByBotPolicy", () => {
  const tools = ["shell", "run_subagent", "spawn_bot", "list_fleet", "schedule_create"].map(
    (name) => ({ name }),
  );

  it("keeps every tool without a bots section", () => {
    expect(filterToolsByBotPolicy(tools, policy({}))).toEqual(tools);
  });

  it("drops the tools of each switched-off capability", () => {
    expect(
      filterToolsByBotPolicy(tools, policy({ bots: { allowSubagents: false } })).map((t) => t.name),
    ).toEqual(["shell", "list_fleet", "schedule_create"]);
    expect(
      filterToolsByBotPolicy(
        tools,
        policy({ bots: { allowFleetManagement: false, allowRoutines: false } }),
      ).map((t) => t.name),
    ).toEqual(["shell", "run_subagent", "spawn_bot"]);
  });
});

describe("PolicyMessagingSurface", () => {
  const context = { userId: "user-1", spaceId: "space-1" } as AdapterContext;

  function surface() {
    const inbound: Array<(event: never) => Promise<void>> = [];
    const inner = {
      describe: () => ({
        id: "inner",
        contractVersion: "1",
        adapterVersion: "1",
        capabilities: { providers: ["slack", "telegram"] },
      }),
      platforms: () => [
        { provider: "slack", capabilities: {} },
        { provider: "telegram", capabilities: {} },
      ],
      handleWebhook: vi.fn(async () => new Response("ok")),
      onInbound: (sink: (event: never) => Promise<void>) => inbound.push(sink),
      sendToThread: vi.fn(async () => ({ handle: "h" })),
      openDirectThread: vi.fn(async () => "slack:1"),
      acknowledge: vi.fn(async () => undefined),
    };
    const wrapped = new PolicyMessagingSurface(inner as unknown as MessagingSurface);
    const sink = vi.fn(async () => undefined);
    wrapped.onInbound(sink);
    return { inner, wrapped, sink, deliver: (event: unknown) => inbound[0]!(event as never) };
  }

  it("passes everything through without a policy", async () => {
    const { inner, wrapped, sink, deliver } = surface();
    expect(wrapped.platforms().map((p) => p.provider)).toEqual(["slack", "telegram"]);
    await wrapped.sendToThread({ threadId: "telegram:1", body: "hi" }, context);
    expect(inner.sendToThread).toHaveBeenCalledTimes(1);
    await deliver({ type: "message", provider: "telegram" });
    expect(sink).toHaveBeenCalledTimes(1);
  });

  it("hides, refuses and drops a chat app that is not allowed", async () => {
    setActivePolicy(policy({ messaging: { allowSurfaces: ["slack", "web"] } }));
    const { inner, wrapped, sink, deliver } = surface();
    expect(wrapped.platforms().map((p) => p.provider)).toEqual(["slack"]);
    expect(wrapped.describe().capabilities.providers).toEqual(["slack"]);

    const blocked = await wrapped.handleWebhook("telegram", new Request("http://x"));
    expect(blocked?.status).toBe(403);
    expect(inner.handleWebhook).not.toHaveBeenCalled();
    await wrapped.handleWebhook("slack", new Request("http://x"));
    expect(inner.handleWebhook).toHaveBeenCalledTimes(1);

    await expect(
      wrapped.sendToThread({ threadId: "telegram:1", body: "hi" }, context),
    ).rejects.toMatchObject({ rule: "messaging.allowSurfaces" });
    await expect(wrapped.openDirectThread("telegram", "a", context)).rejects.toBeInstanceOf(
      PolicyDeniedError,
    );
    await wrapped.sendToThread({ threadId: "slack:C1:1", body: "hi" }, context);
    expect(inner.sendToThread).toHaveBeenCalledTimes(1);

    await deliver({ type: "message", provider: "telegram" });
    expect(sink).not.toHaveBeenCalled();
    await deliver({ type: "message", provider: "slack" });
    expect(sink).toHaveBeenCalledTimes(1);
    expect(events().map((e) => e.metadata)).toEqual([
      { rule: "messaging.allowSurfaces", subject: "telegram", surface: "messaging" },
      { rule: "messaging.allowSurfaces", subject: "telegram", surface: "messaging" },
      { rule: "messaging.allowSurfaces", subject: "telegram", surface: "messaging" },
    ]);
  });
});

describe("tool requests at run time", () => {
  const ctx = { run: { userId: "user-1", spaceId: "space-1" }, bot: { id: "b" } } as RunContext;
  const prepare = (name: string, args: Record<string, unknown> = {}) =>
    prepareToolRequest(ctx, { name, args, executionId: "e" } as unknown as ToolRequest);

  it("refuses helper, fleet and routine tools the policy switched off and records each", async () => {
    setActivePolicy(
      policy({
        bots: { allowSubagents: false, allowFleetManagement: false, allowRoutines: false },
      }),
    );
    for (const name of ["run_subagent", "spawn_bot", "list_fleet", "schedule_create"])
      expect(await prepare(name)).toEqual({ error: "Blocked by your organization" });
    expect(await prepare("update_bot", { bot_id: "other" })).toEqual({
      error: "Blocked by your organization",
    });
    expect(events()).toHaveLength(5);
  });
});
