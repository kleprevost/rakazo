import type {
  AdapterContext,
  ConnectorCall,
  ConnectorProvider,
  ConnectorTool,
} from "@rakazo/adapter-kit";
import { BOT_SUSPENDED_MESSAGE } from "@rakazo/contracts";
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

function setup(suspendedAt: Date | null = null) {
  const stub = new StubConnector();
  const findUnique = vi.fn(async () => ({ suspendedAt, name: "Ada" }));
  const prisma = { bot: { findUnique } };
  const connector = new BrokeredConnector(new ConnectorRegistry([stub]), prisma as never);
  return { stub, findUnique, connector, prisma };
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
      select: { suspendedAt: true, name: true },
    });
    expect(recorded.audit).toEqual([]);
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

  it("refuses a denied tool", async () => {
    const { connector, stub } = setup();
    setActivePolicy({ version: 1, tools: { deny: ["brain_*"] } });
    await expect(checkRoutineWatch(watchDeps(connector), routine("brain_changed"))).rejects.toThrow(
      /blocked by your organization/,
    );
    expect(stub.executed).toEqual([]);
  });
});
