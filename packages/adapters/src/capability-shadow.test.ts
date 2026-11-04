import type { Policy } from "@rakazo/contracts";
import { BUILTIN_TOOL_NAMES } from "@rakazo/contracts";
import { BUILTIN_TOOL_SCOPES } from "@rakazo/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

const recorded = vi.hoisted(() => ({ audit: [] as Array<Record<string, unknown>> }));
vi.mock("@rakazo/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@rakazo/db")>()),
  recordAuditEvent: vi.fn(async (event: Record<string, unknown>) => {
    recorded.audit.push(event);
  }),
}));

import { agentConnectionTools, builtinAgentTools } from "./builtin-tools.js";
import {
  classifyInputForCall,
  classifyInputForTool,
  formatTrace,
  isBuiltinCall,
  recordShadowDecision,
  SHADOW_AUDIT_ACTION,
} from "./capability-shadow.js";
import { BUILTIN_AGENT_TOOL_NAMES } from "./run-tool-selection.js";

describe("built-in tool names", () => {
  it("keeps the contract list, the adapter tools and the scope table in sync", () => {
    const adapterNames = [...builtinAgentTools, ...agentConnectionTools].map((tool) => tool.name);
    expect(new Set(adapterNames).size).toBe(adapterNames.length);
    expect([...BUILTIN_TOOL_NAMES].sort()).toEqual([...adapterNames].sort());
    expect(Object.keys(BUILTIN_TOOL_SCOPES).sort()).toEqual([...BUILTIN_TOOL_NAMES].sort());
    for (const name of BUILTIN_AGENT_TOOL_NAMES) {
      expect(BUILTIN_TOOL_NAMES as readonly string[], name).toContain(name);
    }
  });

  it("classifies every built-in as a built-in, never as an unmapped connector", () => {
    for (const name of BUILTIN_TOOL_NAMES) {
      expect(isBuiltinCall(name, undefined), name).toBe(true);
      expect(classifyInputForTool({ name, args: {} }), name).toMatchObject({
        source: "builtin",
        tool: name,
      });
    }
  });

  it("does not let a connector tool borrow a built-in's name", () => {
    const route = { connectorId: "installed", toolName: "message_agent", catalogGroup: "acme" };
    expect(isBuiltinCall("message_agent", route)).toBe(false);
    expect(classifyInputForTool({ name: "message_agent", args: {}, route })).toMatchObject({
      source: "installed",
      slug: "acme",
    });
  });
});

type Row = Record<string, unknown>;
const row = (over: Partial<Row> & { scope: string }): Row => ({
  id: `g-${over.scope}`,
  botId: "bot-1",
  employeeId: null,
  spaceId: "space-1",
  kind: "bot",
  resource: null,
  effect: "allow",
  principalUserId: null,
  createdByUserId: "admin-1",
  createdVia: "admin",
  expiresAt: null,
  revokedAt: null,
  revokedReason: null,
  createdAt: new Date("2026-01-01T00:00:00Z"),
  ...over,
});

function setup(grants: Row[] = [], quarantine: { id: string; reason: string } | null = null) {
  const findMany = vi.fn(async (_args: unknown) => grants);
  const prisma = {
    bot: { findUnique: async () => ({ spaceId: "space-1", groupMembers: [] }) },
    quarantine: { findFirst: async () => quarantine },
    capabilityGrant: { findMany },
  };
  return { prisma: prisma as never, findMany };
}

const bot = (capabilityMode: string | null = "shadow", employeeId: string | null = null) => ({
  id: "bot-1",
  name: "Ada",
  employeeId,
  capabilityMode,
});

let runs = 0;
const base = () => ({
  spaceId: "space-1",
  userId: "user-1",
  runId: `run-${++runs}`,
  threadId: "thread-1",
  surface: "gate" as const,
});

const metadata = (index = 0) => recorded.audit[index]?.metadata as Record<string, unknown>;

beforeEach(() => {
  recorded.audit.length = 0;
});

describe("recordShadowDecision", () => {
  it("does nothing for a bot with the broker off, and reads nothing", async () => {
    const { prisma, findMany } = setup();
    await recordShadowDecision({
      ...base(),
      prisma,
      bot: bot(null),
      call: { source: "builtin", tool: "write_file", args: {} },
    });
    expect(findMany).not.toHaveBeenCalled();
    expect(recorded.audit).toEqual([]);
  });

  it("records the would-be denial of a built-in with no grant, with the rule trace and no arguments", async () => {
    const { prisma } = setup();
    await recordShadowDecision({
      ...base(),
      prisma,
      bot: bot(),
      call: {
        source: "builtin",
        tool: "web_fetch",
        args: { url: "https://internal.example.com/payroll?token=SECRET-VALUE" },
      },
    });
    expect(recorded.audit).toHaveLength(1);
    expect(recorded.audit[0]).toMatchObject({
      action: SHADOW_AUDIT_ACTION,
      outcome: "success",
      target: { type: "tool", id: "web_fetch" },
      actor: { type: "bot", id: "bot-1" },
    });
    expect(metadata()).toMatchObject({
      mode: "shadow",
      surface: "gate",
      decision: "deny",
      rule: "no_grant",
      scopes: "web.fetch",
      basis: "builtin",
      unmapped: false,
      source: "builtin",
      trace: "grant:no_grant:web.fetch:deny",
    });
    expect(JSON.stringify(recorded.audit)).not.toMatch(/SECRET-VALUE|internal\.example|payroll/);
  });

  it("allows with a covering grant, and samples repeated read allows per run", async () => {
    const { prisma } = setup([row({ scope: "web.fetch", createdVia: "owner" })]);
    const input = {
      ...base(),
      prisma,
      bot: bot(),
      call: { source: "builtin" as const, tool: "web_fetch", args: {} },
    };
    await recordShadowDecision(input);
    await recordShadowDecision(input);
    expect(recorded.audit).toHaveLength(1);
    expect(metadata()).toMatchObject({
      decision: "allow",
      trace: "grant:g-web.fetch:web.fetch:allow",
    });
    await recordShadowDecision({ ...input, runId: "another-run" });
    expect(recorded.audit).toHaveLength(2);
  });

  it("records every non-read allow and every deny, never sampled", async () => {
    const { prisma } = setup([row({ scope: "files.write" })]);
    const input = {
      ...base(),
      prisma,
      bot: bot(),
      call: { source: "builtin" as const, tool: "write_file", args: {} },
    };
    await recordShadowDecision(input);
    await recordShadowDecision(input);
    await recordShadowDecision({ ...input, call: { ...input.call, tool: "shell" } });
    await recordShadowDecision({ ...input, call: { ...input.call, tool: "shell" } });
    expect(recorded.audit.map((event) => (event.metadata as Row).decision)).toEqual([
      "allow",
      "allow",
      "deny",
      "deny",
    ]);
  });

  it("ignores an owner's own write grant unless central policy lists it, and an expired grant", async () => {
    const past = new Date(Date.now() - 60_000);
    const { prisma } = setup([
      row({ scope: "files.write", createdVia: "owner" }),
      row({ scope: "computer.shell", expiresAt: past }),
    ]);
    const input = { ...base(), prisma, bot: bot() };
    await recordShadowDecision({
      ...input,
      call: { source: "builtin", tool: "write_file", args: {} },
    });
    await recordShadowDecision({ ...input, call: { source: "builtin", tool: "shell", args: {} } });
    expect(metadata(0)).toMatchObject({
      decision: "deny",
      trace:
        "grant:g-files.write:files.write:none:owner_not_permitted grant:no_grant:files.write:deny",
    });
    expect(metadata(1)).toMatchObject({
      decision: "deny",
      trace: expect.stringContaining("grant:g-computer.shell:computer.shell:none:expired"),
    });
    const listed: Policy = { version: 1, capabilities: { ownerGrantable: ["files.write"] } };
    await recordShadowDecision({
      ...input,
      policy: listed,
      call: { source: "builtin", tool: "write_file", args: {} },
    });
    expect(metadata(2)).toMatchObject({ decision: "allow" });
  });

  it("reads the employee's grants along with the bot's", async () => {
    const { prisma, findMany } = setup();
    await recordShadowDecision({
      ...base(),
      prisma,
      bot: bot("shadow", "employee-1"),
      call: { source: "builtin", tool: "read_file", args: {} },
    });
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          revokedAt: null,
          OR: [{ botId: "bot-1" }, { employeeId: "employee-1" }],
        },
      }),
    );
  });

  it("classifies an MCP call by its declared effect and needs the delegation for the user's credential", async () => {
    const route = {
      connectorId: "mcp",
      toolName: "create_event",
      resourceId: "srv-1",
      catalogGroup: "cal",
    };
    const call = classifyInputForTool({
      name: "mcp__cal__create_event",
      args: { title: "private meeting title" },
      route,
      tool: { readOnly: false },
    });
    const { prisma } = setup([row({ scope: "ext.cal.write" })]);
    await recordShadowDecision({ ...base(), prisma, bot: bot(), call });
    expect(metadata()).toMatchObject({
      decision: "deny",
      rule: "not_delegated",
      scopes: "ext.cal.write",
      source: "mcp",
      unmapped: true,
    });
    expect(JSON.stringify(recorded.audit)).not.toContain("private meeting title");
    const delegated = setup([
      row({ scope: "ext.cal.write", kind: "delegation", principalUserId: "user-1" }),
    ]);
    await recordShadowDecision({ ...base(), prisma: delegated.prisma, bot: bot(), call });
    expect(metadata(1)).toMatchObject({ decision: "allow" });
  });

  it("uses the admin mapping for a managed connector tool", async () => {
    const policy: Policy = {
      version: 1,
      capabilities: {
        mappings: [
          { match: { source: "connector", app: "gmail", tool: "*send*" }, scopes: ["mail.send"] },
        ],
      },
    };
    const call = classifyInputForCall({
      name: "GMAIL_SEND_EMAIL",
      args: { to: "x@example.com" },
      route: { connectorId: "composio", toolName: "GMAIL_SEND_EMAIL", connectionId: "conn-1" },
      appSlug: "gmail",
    });
    const { prisma } = setup([
      row({ scope: "mail.send", kind: "delegation", principalUserId: "user-1" }),
    ]);
    await recordShadowDecision({ ...base(), prisma, bot: bot(), policy, call });
    expect(metadata()).toMatchObject({
      decision: "allow",
      scopes: "mail.send",
      basis: "mapping",
      source: "connector",
    });
  });

  it("records a call from a quarantined bot as denied by the quarantine", async () => {
    const { prisma } = setup([], { id: "q-1", reason: "incident" });
    await recordShadowDecision({
      ...base(),
      prisma,
      bot: bot(),
      call: { source: "builtin", tool: "read_file", args: {} },
    });
    expect(metadata()).toMatchObject({ decision: "deny", rule: "quarantine" });
  });

  it("leaves a bot to enforcement, and records nothing, when central policy requires grants", async () => {
    const { prisma } = setup();
    const policy: Policy = { version: 1, capabilities: { requireGrants: true } };
    await recordShadowDecision({
      ...base(),
      prisma,
      bot: bot(null),
      policy,
      call: { source: "builtin", tool: "read_file", args: {} },
    });
    expect(recorded.audit).toEqual([]);
  });

  it("never throws, and records nothing, when it cannot evaluate", async () => {
    const { prisma, findMany } = setup();
    findMany.mockRejectedValueOnce(new Error("db down"));
    await expect(
      recordShadowDecision({
        ...base(),
        prisma,
        bot: bot(),
        call: { source: "builtin", tool: "read_file", args: {} },
      }),
    ).resolves.toBeUndefined();
    expect(recorded.audit).toEqual([]);
  });
});

describe("formatTrace", () => {
  it("keeps layer, rule, scope and effect, and drops the quarantine id detail", () => {
    expect(
      formatTrace([
        { layer: "quarantine", rule: "quarantine", effect: "deny", detail: "q-1" },
        { layer: "ceiling", rule: "capabilities.deny", scope: "mail.send", effect: "deny" },
      ]),
    ).toBe("quarantine:quarantine:deny ceiling:capabilities.deny:mail.send:deny");
  });
});
