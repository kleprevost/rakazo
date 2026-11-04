import { beforeEach, describe, expect, it, vi } from "vitest";

const recorded = vi.hoisted(() => ({ audit: [] as Array<Record<string, unknown>> }));
vi.mock("@rakazo/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@rakazo/db")>()),
  recordAuditEvent: vi.fn(async (event: Record<string, unknown>) => {
    recorded.audit.push(event);
  }),
}));

import { createApprovedEffectReplayQueue } from "./approval-effect.js";
import { gateToolCall } from "./run-tool-gate.js";

function gateContext(capabilityMode: string | null, grants: unknown[] = []) {
  return {
    bot: { id: "bot-1", name: "Ada", employeeId: null, capabilityMode },
    deps: {
      prisma: {
        bot: { findUnique: async () => ({ spaceId: "space-1", groupMembers: [] }) },
        quarantine: { findFirst: async () => null },
        capabilityGrant: { findMany: vi.fn(async () => grants) },
      },
    },
    run: { userId: "user-1", spaceId: "space-1", trigger: "user" },
    runId: `run-${capabilityMode ?? "off"}-${grants.length}`,
    thread: { id: "thread-1" },
    source: { ownerStartedRun: true },
    state: {
      tainted: false,
      effects: {
        restoredPending: undefined,
        counts: new Map(),
        occurrences: [],
        consumedIds: new Set(),
      },
    },
    trust: {
      loadAutoReviewPreference: async () => ({ enabled: false, skipApprovals: false }),
      loadApprovalRules: async () => [],
      loadTrustedConnectors: async () => new Set<string>(),
      loadTrustedSites: async () => new Set<string>(),
    },
    tools: {
      disabled: new Set<string>(),
      approvedReplays: createApprovedEffectReplayQueue([]),
      connector: new Map(),
      connectedPlugins: [],
    },
    context: { signal: new AbortController().signal },
    secrets: [],
  };
}

function request(name: string, args: Record<string, unknown> = {}) {
  return {
    name,
    args,
    executionId: "call-1",
    connectorCall: { tool: name, args, executionId: "call-1" },
    effectRequest: args,
    resolvedTool: undefined,
    catalogRemapped: false,
    nextApprovedTool: undefined,
    approvedEffectKey: undefined,
    replayEffectToolName: name,
    fleetSummary: undefined,
    heldForApproval: false,
    purchase: undefined,
    cardUse: undefined,
  };
}

const gate = (ctx: ReturnType<typeof gateContext>, name: string, args = {}) =>
  gateToolCall(ctx as never, request(name, args) as never, undefined);

const shadowEvents = () => recorded.audit.filter((event) => event.action === "capability.shadow");

beforeEach(() => {
  recorded.audit.length = 0;
});

describe("gateToolCall in shadow mode", () => {
  it("decides the same with the broker off and in shadow, and records only in shadow", async () => {
    const off = await gate(gateContext(null), "scratchpad_list");
    expect(off).toHaveProperty("call");
    expect(shadowEvents()).toEqual([]);

    const shadow = await gate(gateContext("shadow"), "scratchpad_list");
    expect(shadow).toHaveProperty("call");
    // A call with no external effect needs no scope, so it is allowed with no grant.
    expect(shadowEvents()).toEqual([
      expect.objectContaining({
        runId: "run-shadow-0",
        metadata: expect.objectContaining({ decision: "allow", surface: "gate", scopes: "" }),
      }),
    ]);
  });

  it("records a would-be denial for a call the gate still lets through", async () => {
    const outcome = await gate(gateContext("shadow"), "web_search", { query: "PRIVATE-QUERY" });
    expect(outcome).toHaveProperty("call");
    expect(shadowEvents()).toEqual([
      expect.objectContaining({
        target: expect.objectContaining({ id: "web_search" }),
        metadata: expect.objectContaining({
          decision: "deny",
          rule: "no_grant",
          scopes: "web.fetch",
        }),
      }),
    ]);
    expect(JSON.stringify(recorded.audit)).not.toContain("PRIVATE-QUERY");
  });
});
