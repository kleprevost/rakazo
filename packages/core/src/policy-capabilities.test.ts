import type { Policy } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import {
  evaluateAccountExport,
  evaluateBotCapability,
  evaluateBotTool,
  evaluateComputerKind,
  evaluateHostComputer,
  evaluateMessagingSurface,
  evaluateRunTrigger,
} from "./policy-capabilities.js";

const policy = (rest: Omit<Policy, "version">): Policy => ({ version: 1, ...rest });

describe("evaluateComputerKind", () => {
  it("allows everything without a policy or section", () => {
    expect(evaluateComputerKind(undefined, "docker")).toEqual({ allowed: true });
    expect(evaluateComputerKind(policy({}), "docker")).toEqual({ allowed: true });
  });

  it("limits kinds to the allowed providers", () => {
    const p = policy({ computers: { allowProviders: ["kubernetes"] } });
    expect(evaluateComputerKind(p, "kubernetes")).toEqual({ allowed: true });
    expect(evaluateComputerKind(p, "e2b")).toEqual({
      allowed: false,
      rule: "computers.allowProviders",
    });
  });

  it("refuses the host computer when it is switched off, ahead of the provider list", () => {
    const p = policy({ computers: { allowHostComputer: false, allowProviders: ["desktop"] } });
    expect(evaluateComputerKind(p, "desktop")).toEqual({
      allowed: false,
      rule: "computers.allowHostComputer",
    });
    expect(evaluateComputerKind(p, "docker")).toEqual({
      allowed: false,
      rule: "computers.allowProviders",
    });
  });

  it("also requires the host computer to be a listed provider", () => {
    const p = policy({ computers: { allowProviders: ["docker"] } });
    expect(evaluateHostComputer(p)).toEqual({ allowed: false, rule: "computers.allowProviders" });
    expect(evaluateHostComputer(policy({ computers: { allowHostComputer: true } }))).toEqual({
      allowed: true,
    });
  });
});

describe("bot capabilities", () => {
  const off = policy({
    bots: {
      allowFleetManagement: false,
      allowSubagents: false,
      allowWebhooks: false,
      allowRoutines: false,
    },
  });

  it("names the rule that refuses each capability", () => {
    expect(evaluateBotCapability(off, "fleetManagement")).toEqual({
      allowed: false,
      rule: "bots.allowFleetManagement",
    });
    expect(evaluateBotCapability(off, "subagents")).toEqual({
      allowed: false,
      rule: "bots.allowSubagents",
    });
    expect(evaluateBotCapability(off, "webhooks")).toEqual({
      allowed: false,
      rule: "bots.allowWebhooks",
    });
    expect(evaluateBotCapability(off, "routines")).toEqual({
      allowed: false,
      rule: "bots.allowRoutines",
    });
  });

  it("allows what is true or unset", () => {
    const on = policy({ bots: { allowFleetManagement: true } });
    expect(evaluateBotCapability(on, "fleetManagement")).toEqual({ allowed: true });
    expect(evaluateBotCapability(on, "routines")).toEqual({ allowed: true });
    expect(evaluateBotCapability(undefined, "subagents")).toEqual({ allowed: true });
  });

  it("maps tools to the capability that governs them", () => {
    expect(evaluateBotTool(off, "run_subagent")).toMatchObject({ allowed: false });
    expect(evaluateBotTool(off, "spawn_bot")).toMatchObject({ allowed: false });
    expect(evaluateBotTool(off, "list_fleet")).toMatchObject({ allowed: false });
    expect(evaluateBotTool(off, "schedule_create")).toMatchObject({ allowed: false });
    expect(evaluateBotTool(off, "shell")).toEqual({ allowed: true });
    const routinesOnly = policy({ bots: { allowRoutines: false } });
    expect(evaluateBotTool(routinesOnly, "create_child_routine")).toEqual({
      allowed: false,
      rule: "bots.allowRoutines",
    });
    expect(evaluateBotTool(routinesOnly, "run_subagent")).toEqual({ allowed: true });
  });

  it("refuses routine and webhook runs only", () => {
    expect(evaluateRunTrigger(off, "routine")).toMatchObject({ allowed: false });
    expect(evaluateRunTrigger(off, "webhook")).toMatchObject({ allowed: false });
    expect(evaluateRunTrigger(off, "user")).toEqual({ allowed: true });
    expect(evaluateRunTrigger(undefined, "routine")).toEqual({ allowed: true });
  });
});

describe("evaluateMessagingSurface", () => {
  it("allows any surface without a list", () => {
    expect(evaluateMessagingSurface(undefined, "slack")).toEqual({ allowed: true });
    expect(evaluateMessagingSurface(policy({ messaging: {} }), "slack")).toEqual({ allowed: true });
  });

  it("allows only listed chat apps", () => {
    const p = policy({ messaging: { allowSurfaces: ["web", "slack"] } });
    expect(evaluateMessagingSurface(p, "slack")).toEqual({ allowed: true });
    expect(evaluateMessagingSurface(p, "telegram")).toEqual({
      allowed: false,
      rule: "messaging.allowSurfaces",
    });
  });

  it("an empty list blocks every chat app", () => {
    expect(evaluateMessagingSurface(policy({ messaging: { allowSurfaces: [] } }), "slack")).toEqual(
      { allowed: false, rule: "messaging.allowSurfaces" },
    );
  });
});

describe("evaluateAccountExport", () => {
  it("refuses only when explicitly off", () => {
    expect(evaluateAccountExport(policy({ data: { allowAccountExport: false } }))).toEqual({
      allowed: false,
      rule: "data.allowAccountExport",
    });
    expect(evaluateAccountExport(policy({ data: { allowAccountExport: true } }))).toEqual({
      allowed: true,
    });
    expect(evaluateAccountExport(undefined)).toEqual({ allowed: true });
  });
});
