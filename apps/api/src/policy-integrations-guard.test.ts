import { ORPCError } from "@orpc/server";
import { setActivePolicy } from "@rakazo/adapters";
import { POLICY_DENIED_MESSAGE } from "@rakazo/contracts";
import { installSecurityEventStore } from "@rakazo/db";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { assertMcpRemoteEndpoint } from "./mcp-servers.js";
import {
  assertConnectorAllowedForRequest,
  assertStdioMcpAllowedForRequest,
} from "./policy-integrations-guard.js";

const actor = { userId: "u1", spaceId: "s1" } as never;
const create = vi.fn(async (args: { data: Record<string, unknown> }) => args.data);
const deps = {
  env: { mcpAllowPrivateEndpoint: false },
  remoteConnectors: { resolveHostname: async () => [{ address: "93.184.216.34", family: 4 }] },
} as never;

async function forbidden(promise: Promise<unknown>) {
  const error = (await promise.catch((e) => e)) as ORPCError<string, unknown>;
  expect(error).toBeInstanceOf(ORPCError);
  expect(error.code).toBe("FORBIDDEN");
  expect(error.message).toBe(POLICY_DENIED_MESSAGE);
  return error.data;
}

beforeEach(() => installSecurityEventStore({ securityEvent: { create } } as never));
afterEach(() => {
  setActivePolicy(undefined);
  installSecurityEventStore(undefined);
  create.mockClear();
});

describe("integration policy at settings time", () => {
  it("refuses connecting a disallowed app with the policy reason", async () => {
    setActivePolicy({ version: 1, integrations: { allowConnectors: ["slack"] } });
    expect(await forbidden(assertConnectorAllowedForRequest(actor, "gmail"))).toEqual({
      reason: "policy",
      rule: "integrations.allowConnectors",
    });
    await expect(assertConnectorAllowedForRequest(actor, "slack")).resolves.toBeUndefined();
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("refuses an MCP endpoint, or an OAuth server, on a host outside the list", async () => {
    setActivePolicy({
      version: 1,
      integrations: { mcp: { allowHosts: ["mcp.example.com"] } },
    });
    expect(await forbidden(assertMcpRemoteEndpoint("https://evil.test/mcp", deps, actor))).toEqual({
      reason: "policy",
      rule: "integrations.mcp.allowHosts",
    });
    await forbidden(assertMcpRemoteEndpoint("https://mcp.example.com@evil.test/", deps));
    await expect(
      assertMcpRemoteEndpoint("https://mcp.example.com/mcp", deps, actor),
    ).resolves.toBeUndefined();
  });

  it("refuses a local-command server while a host list is set", async () => {
    setActivePolicy({
      version: 1,
      integrations: { mcp: { allowHosts: ["mcp.example.com"] } },
    });
    await forbidden(assertStdioMcpAllowedForRequest(actor));
    setActivePolicy(undefined);
    await expect(assertStdioMcpAllowedForRequest(actor)).resolves.toBeUndefined();
  });
});
