import type {
  AdapterContext,
  ConnectorCall,
  ConnectorProvider,
  ConnectorTool,
} from "@rakazo/adapter-kit";
import {
  BOT_QUARANTINED_MESSAGE,
  BOT_SUSPENDED_MESSAGE,
  CAPABILITY_DENIED_MESSAGE,
} from "@rakazo/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const recorded = vi.hoisted(() => ({ audit: [] as unknown[], security: [] as unknown[] }));
vi.mock("@rakazo/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@rakazo/db")>()),
  recordAuditEvent: vi.fn(async (event: unknown) => {
    recorded.audit.push(event);
  }),
  recordSecurityEvent: vi.fn(async (event: unknown) => {
    recorded.security.push(event);
  }),
}));

import { BrokeredConnector } from "./brokered-connector.js";
import { ConnectorRegistry } from "./composio-connector.js";
import { setActivePolicy } from "./policy-runtime.js";
import type { RoutineWatchTickDeps } from "./routine-watch.js";
import { checkRoutineWatch } from "./routine-watch.js";

class StubConnector implements ConnectorProvider {
  executed: ConnectorCall[] = [];

  describe() {
    return {
      id: "installed",
      contractVersion: "1",
      adapterVersion: "1",
      capabilities: { discover: true, oauth: false, secretsBrokered: false },
    };
  }

  async discoverTools(): Promise<ConnectorTool[]> {
    return ["gmail_list", "brain_changed"].map((name) => ({
      name,
      description: name,
      readOnly: true,
      inputSchema: { type: "object", properties: {} },
    }));
  }

  async *execute(call: ConnectorCall) {
    this.executed.push(call);
    yield { type: "result" as const, data: { ok: true } };
  }
}

function setup(suspendedAt: Date | null = null, quarantined = false) {
  const stub = new StubConnector();
  const findUnique = vi.fn(async () => ({
    suspendedAt,
    name: "Ada",
    spaceId: "space-1",
    groupMembers: [{ groupId: "group-1" }],
  }));
  const findFirst = vi.fn(async () => (quarantined ? { id: "q-1", reason: "incident" } : null));
  const prisma = { bot: { findUnique }, quarantine: { findFirst } };
  const connector = new BrokeredConnector(new ConnectorRegistry([stub]), prisma as never);
  return { stub, findUnique, findFirst, connector, prisma };
}

const context: AdapterContext = {
  operationId: "op",
  traceId: "op",
  spaceId: "space-1",
  userId: "user-1",
  botId: "bot-1",
  runId: "run-1",
  signal: new AbortController().signal,
  connectedConnections: [
    { id: "conn-1", connectorId: "composio", externalId: "gmail", displayName: "Gmail" },
  ],
};

async function run(connector: ConnectorProvider, call: Partial<ConnectorCall>, ctx = context) {
  const events = [];
  const tool = call.tool ?? "gmail_list";
  for await (const event of connector.execute(
    {
      tool,
      args: {},
      executionId: "e",
      route: { connectorId: "installed", toolName: tool },
      ...call,
    },
    ctx,
  ))
    events.push(event);
  return events;
}

beforeEach(() => {
  recorded.audit.length = 0;
  recorded.security.length = 0;
});
afterEach(() => setActivePolicy(undefined));

describe("BrokeredConnector", () => {
  it("passes a normal call through with one suspension read", async () => {
    const { stub, findUnique, connector } = setup();
    await expect(run(connector, {})).resolves.toEqual([{ type: "result", data: { ok: true } }]);
    expect(stub.executed).toHaveLength(1);
    expect(findUnique).toHaveBeenCalledTimes(1);
    expect(findUnique).toHaveBeenCalledWith({
      where: { id: "bot-1" },
      select: {
        suspendedAt: true,
        name: true,
        spaceId: true,
        capabilityMode: true,
        employeeId: true,
        groupMembers: { select: { groupId: true } },
      },
    });
    expect(recorded.audit).toEqual([]);
  });

  it("refuses and audits a call once a quarantine covers the bot, by space or group membership", async () => {
    const { stub, findFirst, connector } = setup(null, true);
    await expect(run(connector, {})).resolves.toEqual([
      { type: "error", message: BOT_QUARANTINED_MESSAGE },
    ]);
    expect(stub.executed).toEqual([]);
    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          OR: expect.arrayContaining([
            { scopeKind: "space", scopeId: "space-1" },
            { scopeKind: "group", scopeId: { in: ["group-1"] } },
          ]),
        }),
      }),
    );
    expect(recorded.audit).toEqual([
      expect.objectContaining({
        action: "tool.call",
        outcome: "denied",
        metadata: { reason: "quarantined" },
      }),
    ]);
  });

  it("refuses and audits a call from a suspended bot", async () => {
    const { stub, connector } = setup(new Date());
    await expect(run(connector, {})).resolves.toEqual([
      { type: "error", message: BOT_SUSPENDED_MESSAGE },
    ]);
    expect(stub.executed).toEqual([]);
    expect(recorded.audit).toEqual([
      expect.objectContaining({
        action: "tool.call",
        outcome: "denied",
        metadata: { reason: "suspended" },
      }),
    ]);
  });

  it("fails closed when the suspension read fails or no bot is named", async () => {
    const { stub, findUnique, connector } = setup();
    findUnique.mockRejectedValueOnce(new Error("db down"));
    expect(await run(connector, {})).toEqual([{ type: "error", message: BOT_SUSPENDED_MESSAGE }]);
    expect(await run(connector, {}, { ...context, botId: undefined })).toEqual([
      { type: "error", message: BOT_SUSPENDED_MESSAGE },
    ]);
    findUnique.mockResolvedValueOnce(null as never);
    expect(await run(connector, {})).toEqual([{ type: "error", message: BOT_SUSPENDED_MESSAGE }]);
    expect(stub.executed).toEqual([]);
  });

  it("enforces the capability broker for a call with no run, failing closed", async () => {
    const stub = new StubConnector();
    const findMany = vi.fn(async (): Promise<unknown[]> => []);
    const prisma = {
      bot: {
        findUnique: vi.fn(async () => ({
          suspendedAt: null,
          name: "Ada",
          spaceId: "space-1",
          capabilityMode: "enforce",
          employeeId: null,
          groupMembers: [],
        })),
      },
      quarantine: { findFirst: vi.fn(async () => null) },
      capabilityGrant: { findMany },
    };
    const connector = new BrokeredConnector(new ConnectorRegistry([stub]), prisma as never);
    const watch = { ...context, runId: undefined };
    // No grant covers the tool.
    expect(await run(connector, {}, watch)).toEqual([
      { type: "error", message: CAPABILITY_DENIED_MESSAGE },
    ]);
    findMany.mockRejectedValueOnce(new Error("db down"));
    expect(await run(connector, {}, watch)).toEqual([
      { type: "error", message: CAPABILITY_DENIED_MESSAGE },
    ]);
    expect(stub.executed).toEqual([]);
    expect(recorded.audit).toEqual([
      expect.objectContaining({ outcome: "denied", metadata: { reason: "capability" } }),
      expect.objectContaining({ outcome: "denied", metadata: { reason: "capability" } }),
    ]);
    expect(recorded.security).toEqual([
      expect.objectContaining({ type: "capability.denied" }),
      expect.objectContaining({ type: "capability.denied" }),
    ]);
  });

  it("refuses a tool the policy denies, by any name it goes by", async () => {
    setActivePolicy({ version: 1, tools: { deny: ["gmail_*"] } });
    const { stub, connector } = setup();
    const [event] = await run(connector, {
      tool: "alias",
      route: { connectorId: "installed", toolName: "gmail_list" },
    });
    expect(event).toMatchObject({ type: "error", message: expect.stringContaining("blocked") });
    expect(stub.executed).toEqual([]);
    expect(recorded.security).toEqual([
      expect.objectContaining({ type: "policy.denied", metadata: expect.objectContaining({}) }),
    ]);
    expect(recorded.audit).toEqual([
      expect.objectContaining({ outcome: "denied", metadata: { reason: "policy" } }),
    ]);
  });

  it("refuses a connected app the policy does not allow", async () => {
    setActivePolicy({ version: 1, integrations: { allowConnectors: ["slack"] } });
    const { stub, connector } = setup();
    const byConnection = await run(connector, {
      route: { connectorId: "installed", toolName: "list", connectionId: "conn-1" },
    });
    const byName = await run(connector, {});
    expect(byConnection[0]).toMatchObject({ type: "error" });
    expect(byName[0]).toMatchObject({ type: "error" });
    expect(stub.executed).toEqual([]);
    // A tool that is not a connected app's is not an app, so the app list does not apply.
    await expect(run(connector, { tool: "brain_changed" })).resolves.toEqual([
      { type: "result", data: { ok: true } },
    ]);
  });
});

describe("routine watches through BrokeredConnector", () => {
  function watchDeps(connector: BrokeredConnector) {
    return {
      prisma: {
        connection: {
          findMany: vi.fn(async () => [
            {
              id: "conn-1",
              connectorId: "composio",
              provider: "gmail",
              providerRef: null,
              displayName: "Gmail",
              status: "connected",
            },
          ]),
        },
        spaceSettingOverride: { findUnique: vi.fn(async () => null) },
        actionApprovalRule: { findMany: vi.fn(async () => []) },
        userActionApprovalRule: { findMany: vi.fn(async () => []) },
      },
      connector,
    } as unknown as RoutineWatchTickDeps;
  }
  const routine = (tool: string) => ({
    id: "r",
    spaceId: "space-1",
    userId: "user-1",
    botId: "bot-1",
    watch: { kind: "tool", tool, args: {} },
    watchState: null,
  });

  it("reads normally", async () => {
    const { connector, stub } = setup();
    await expect(
      checkRoutineWatch(watchDeps(connector), routine("brain_changed")),
    ).resolves.toBeDefined();
    expect(stub.executed).toHaveLength(1);
  });

  it("refuses a suspended bot's watch", async () => {
    const { connector, stub } = setup(new Date());
    await expect(checkRoutineWatch(watchDeps(connector), routine("brain_changed"))).rejects.toThrow(
      BOT_SUSPENDED_MESSAGE,
    );
    expect(stub.executed).toEqual([]);
  });

  it("refuses a quarantined bot's watch", async () => {
    const { connector, stub } = setup(null, true);
    await expect(checkRoutineWatch(watchDeps(connector), routine("brain_changed"))).rejects.toThrow(
      BOT_QUARANTINED_MESSAGE,
    );
    expect(stub.executed).toEqual([]);
  });

  it("refuses a denied tool", async () => {
    const { connector, stub } = setup();
    setActivePolicy({ version: 1, tools: { deny: ["brain_*"] } });
    await expect(checkRoutineWatch(watchDeps(connector), routine("brain_changed"))).rejects.toThrow(
      /blocked by your organization/,
    );
    expect(stub.executed).toEqual([]);
  });
});

describe("shadow mode through BrokeredConnector", () => {
  function shadowSetup(capabilityMode: string | null, grants: unknown[] = []) {
    const stub = new StubConnector();
    const prisma = {
      bot: {
        findUnique: vi.fn(async () => ({
          suspendedAt: null,
          name: "Ada",
          spaceId: "space-1",
          capabilityMode,
          employeeId: null,
          groupMembers: [],
        })),
      },
      quarantine: { findFirst: async () => null },
      capabilityGrant: { findMany: vi.fn(async () => grants) },
    };
    return {
      stub,
      prisma,
      connector: new BrokeredConnector(new ConnectorRegistry([stub]), prisma as never),
    };
  }
  const watchContext: AdapterContext = { ...context, runId: undefined };
  const shadowEvents = () =>
    recorded.audit.filter((event) => (event as { action: string }).action === "capability.shadow");

  it("records what a routine watch call would be decided and still runs it", async () => {
    const { stub, connector } = shadowSetup("shadow");
    await expect(
      run(
        connector,
        {
          args: { secret: "ARG-VALUE" },
          route: { connectorId: "installed", toolName: "gmail_list", catalogGroup: "acme" },
        },
        watchContext,
      ),
    ).resolves.toEqual([{ type: "result", data: { ok: true } }]);
    expect(stub.executed).toHaveLength(1);
    expect(shadowEvents()).toEqual([
      expect.objectContaining({
        outcome: "success",
        metadata: expect.objectContaining({
          mode: "shadow",
          surface: "connector",
          decision: "deny",
          rule: "no_grant",
          scopes: "ext.acme.admin",
          unmapped: true,
        }),
      }),
    ]);
    expect(JSON.stringify(recorded.audit)).not.toContain("ARG-VALUE");
  });

  it("records nothing when the broker is off, or for a run the gate already decided", async () => {
    const off = shadowSetup(null);
    await run(off.connector, {}, watchContext);
    expect(off.prisma.capabilityGrant.findMany).not.toHaveBeenCalled();
    const inRun = shadowSetup("shadow");
    await run(inRun.connector, {});
    expect(inRun.prisma.capabilityGrant.findMany).not.toHaveBeenCalled();
    expect(shadowEvents()).toEqual([]);
  });

  it("does not record a call it refuses for policy", async () => {
    const { connector } = shadowSetup("shadow");
    setActivePolicy({ version: 1, tools: { deny: ["gmail_*"] } });
    await run(connector, {}, watchContext);
    expect(shadowEvents()).toEqual([]);
  });
});
