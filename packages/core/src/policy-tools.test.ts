import type { Policy } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import { planActionGate } from "./action-approval.js";
import {
  clampApprovalMode,
  evaluateApprovalMode,
  evaluateToolUse,
  filterOfferedTools,
  toolAlwaysAsks,
} from "./policy-tools.js";

const policy = (rest: Omit<Policy, "version">): Policy => ({ version: 1, ...rest });

describe("tools.deny", () => {
  it("allows everything without a policy or rule", () => {
    expect(evaluateToolUse(undefined, ["computer_shell"])).toEqual({ allowed: true });
    expect(evaluateToolUse(policy({}), ["computer_shell"])).toEqual({ allowed: true });
  });

  it("denies by exact id or glob, case-insensitively, on any of a call's ids", () => {
    const p = policy({ tools: { deny: ["computer_*", "Gmail_Delete_Thread"] } });
    expect(evaluateToolUse(p, ["computer_shell"])).toEqual({
      allowed: false,
      rule: "tools.deny",
    });
    expect(evaluateToolUse(p, ["gmail_delete_thread"]).allowed).toBe(false);
    expect(evaluateToolUse(p, ["batch_tool", "COMPUTER_ACT"]).allowed).toBe(false);
    expect(evaluateToolUse(p, ["web_fetch"]).allowed).toBe(true);
  });

  it("hides denied tools from the offered list", () => {
    const p = policy({ tools: { deny: ["computer_*"] } });
    const tools = [{ name: "computer_shell" }, { name: "web_fetch" }];
    expect(filterOfferedTools(p, tools)).toEqual([{ name: "web_fetch" }]);
    expect(filterOfferedTools(undefined, tools)).toBe(tools);
  });
});

describe("approvals.alwaysAsk", () => {
  it("matches ids and globs only when configured", () => {
    const p = policy({ approvals: { alwaysAsk: ["email_*"] } });
    expect(toolAlwaysAsks(p, ["email_send"])).toBe(true);
    expect(toolAlwaysAsks(p, ["web_fetch"])).toBe(false);
    expect(toolAlwaysAsks(undefined, ["email_send"])).toBe(false);
  });

  it("makes the gate ask in every mode, even for an Always allow rule", () => {
    const resolved = {
      decision: "allow" as const,
      source: "always_allow" as const,
      matchingRules: [],
      decisiveRules: [],
    };
    for (const mode of ["never", "auto", "ask"] as const)
      expect(
        planActionGate({
          resolved,
          mode,
          consequential: false,
          checkerConfigured: true,
          alwaysAsk: true,
        }),
      ).toBe("ask");
    expect(
      planActionGate({
        resolved: { ...resolved, decision: "deny", source: "deny" },
        mode: "never",
        consequential: false,
        checkerConfigured: true,
        alwaysAsk: true,
      }),
    ).toBe("deny");
  });
});

describe("approvals.minimumMode", () => {
  it("leaves modes alone without a floor", () => {
    expect(clampApprovalMode(undefined, "never")).toBe("never");
    expect(evaluateApprovalMode(policy({}), "never")).toEqual({ allowed: true });
  });

  it("an ask floor allows only ask", () => {
    const p = policy({ approvals: { minimumMode: "ask" } });
    expect(clampApprovalMode(p, "never")).toBe("ask");
    expect(clampApprovalMode(p, "auto")).toBe("ask");
    expect(clampApprovalMode(p, "ask")).toBe("ask");
    expect(evaluateApprovalMode(p, "auto")).toEqual({
      allowed: false,
      rule: "approvals.minimumMode",
    });
  });

  it("an auto floor forbids only never ask", () => {
    const p = policy({ approvals: { minimumMode: "auto" } });
    expect(clampApprovalMode(p, "never")).toBe("auto");
    expect(clampApprovalMode(p, "auto")).toBe("auto");
    expect(clampApprovalMode(p, "ask")).toBe("ask");
    expect(evaluateApprovalMode(p, "never").allowed).toBe(false);
    expect(evaluateApprovalMode(p, "ask").allowed).toBe(true);
  });
});
