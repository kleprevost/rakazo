import { POLICY_DENIED_MESSAGE } from "@rakazo/contracts";
import { installSecurityEventStore } from "@rakazo/db";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { connectedContext } from "./connection-context.js";
import {
  assertConnectorAllowed,
  assertStdioMcpAllowed,
  assertToolSourceHostAllowed,
  connectorAllowed,
} from "./policy-integrations.js";
import { PolicyDeniedError, setActivePolicy } from "./policy-runtime.js";
import { assertSafeRemoteUrl, createSafeRemoteFetch } from "./remote-mcp.js";

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
const publicHost = async () => [{ address: "93.184.216.34", family: 4 as const }];

beforeEach(() => {
  rows.length = 0;
  installSecurityEventStore(store as never);
});
afterEach(() => {
  setActivePolicy(undefined);
  installSecurityEventStore(undefined);
});

describe("assertConnectorAllowed", () => {
  it("is a no-op without a policy", async () => {
    await expect(assertConnectorAllowed("gmail", { surface: "settings" })).resolves.toBeUndefined();
    expect(events()).toEqual([]);
  });

  it("refuses a disallowed app and audits only the slug", async () => {
    setActivePolicy({ version: 1, integrations: { allowConnectors: ["slack"] } });
    const error = await assertConnectorAllowed("GMail", {
      userId: "u1",
      spaceId: "s1",
      surface: "settings",
    }).catch((e) => e);
    expect(error).toBeInstanceOf(PolicyDeniedError);
    expect(error.message).toBe(POLICY_DENIED_MESSAGE);
    expect(events()).toEqual([
      expect.objectContaining({
        type: "policy.denied",
        userId: "u1",
        metadata: { rule: "integrations.allowConnectors", subject: "gmail", surface: "settings" },
      }),
    ]);
    await expect(assertConnectorAllowed("slack", { surface: "settings" })).resolves.toBeUndefined();
  });
});

describe("connectedContext", () => {
  const connected = [
    { id: "1", connectorId: "composio", provider: "gmail", displayName: "G", providerRef: null },
    { id: "2", connectorId: "composio", provider: "slack", displayName: "S", providerRef: null },
  ];

  it("keeps every connection without a policy", () => {
    expect(connectedContext(connected).connectedConnections).toHaveLength(2);
  });

  it("drops an already-connected app the policy no longer allows", () => {
    setActivePolicy({ version: 1, integrations: { allowConnectors: ["slack"] } });
    const context = connectedContext(connected);
    expect(context.connectedConnections?.map((row) => row.externalId)).toEqual(["slack"]);
    expect(context.connectedProviders).toEqual(["slack"]);
    expect(connectorAllowed("gmail")).toBe(false);
  });
});

describe("tool source hosts", () => {
  beforeEach(() => {
    setActivePolicy({
      version: 1,
      integrations: { mcp: { allowHosts: ["mcp.example.com", "*.tools.example.com"] } },
    });
  });

  it("audits the host only, never the path, query or credentials", async () => {
    await expect(
      assertToolSourceHostAllowed("https://user:pw@evil.test:8443/mcp?token=secret", {
        userId: "u1",
        surface: "settings",
      }),
    ).rejects.toBeInstanceOf(PolicyDeniedError);
    expect(events()).toEqual([
      expect.objectContaining({
        metadata: {
          rule: "integrations.mcp.allowHosts",
          subject: "evil.test",
          surface: "settings",
        },
      }),
    ]);
    expect(JSON.stringify(events())).not.toContain("secret");
  });

  it("gates a tool-source URL before any network or DNS work", async () => {
    const resolve = vi.fn(publicHost);
    await expect(
      assertSafeRemoteUrl("https://evil.test/mcp", resolve, { toolSource: true }),
    ).rejects.toBeInstanceOf(PolicyDeniedError);
    expect(resolve).not.toHaveBeenCalled();
    await expect(
      assertSafeRemoteUrl("https://a.tools.example.com/mcp", resolve, { toolSource: true }),
    ).resolves.toBeInstanceOf(URL);
  });

  it("leaves built-in services (not tool sources) alone", async () => {
    await expect(assertSafeRemoteUrl("https://evil.test/", publicHost, {})).resolves.toBeInstanceOf(
      URL,
    );
  });

  it("refuses a request to a disallowed host without contacting it", async () => {
    const fetchImpl = vi.fn(async () => new Response("ok"));
    const safeFetch = createSafeRemoteFetch(fetchImpl as never, publicHost, { toolSource: true });
    await expect(safeFetch("https://evil.test/token")).rejects.toBeInstanceOf(PolicyDeniedError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("blocks local-command servers while a host list is set", async () => {
    await expect(assertStdioMcpAllowed({ surface: "mcp" })).rejects.toBeInstanceOf(
      PolicyDeniedError,
    );
    expect(events()[0]?.metadata).toMatchObject({ subject: "stdio" });
    setActivePolicy({ version: 1, integrations: { allowConnectors: ["gmail"] } });
    await expect(assertStdioMcpAllowed({ surface: "mcp" })).resolves.toBeUndefined();
  });
});
