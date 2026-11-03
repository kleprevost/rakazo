import type { Policy } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import {
  evaluateConnectorUse,
  evaluateStdioMcp,
  evaluateToolSourceHost,
  filterConnectorCatalog,
  policyRequestHost,
} from "./policy-integrations.js";

const hosts = (allowHosts: string[]): Policy => ({
  version: 1,
  integrations: { mcp: { allowHosts } },
});
const apps = (allowConnectors: string[]): Policy => ({
  version: 1,
  integrations: { allowConnectors },
});

describe("evaluateConnectorUse", () => {
  it("allows everything without a policy or list", () => {
    expect(evaluateConnectorUse(undefined, "gmail").allowed).toBe(true);
    expect(evaluateConnectorUse({ version: 1 }, "gmail").allowed).toBe(true);
  });

  it("matches the app slug case-insensitively and by glob", () => {
    const policy = apps(["Gmail", "google*"]);
    expect(evaluateConnectorUse(policy, " GMAIL ").allowed).toBe(true);
    expect(evaluateConnectorUse(policy, "googlecalendar").allowed).toBe(true);
    expect(evaluateConnectorUse(policy, "slack")).toEqual({
      allowed: false,
      rule: "integrations.allowConnectors",
    });
  });

  it("denies everything for an empty list and an empty slug", () => {
    expect(evaluateConnectorUse(apps([]), "gmail").allowed).toBe(false);
    expect(evaluateConnectorUse(apps(["*"]), "").allowed).toBe(false);
  });

  it("filters a catalog", () => {
    const items = [{ slug: "gmail" }, { slug: "slack" }];
    expect(filterConnectorCatalog(apps(["slack"]), items)).toEqual([{ slug: "slack" }]);
    expect(filterConnectorCatalog(undefined, items)).toBe(items);
  });
});

describe("policyRequestHost", () => {
  it.each([
    ["https://MCP.Example.com./path?x=1", "mcp.example.com"],
    ["https://mcp.example.com:8443/mcp", "mcp.example.com"],
    ["https://allowed.com@evil.com/", "evil.com"],
    ["https://allowed.com:pw@evil.com/", "evil.com"],
    ["https://[::1]:3000/", "::1"],
    ["http://2130706433/", "127.0.0.1"],
    ["Mcp.Example.com", "mcp.example.com"],
    ["mcp.example.com:9000", "mcp.example.com"],
  ])("reads %s", (input, host) => {
    expect(policyRequestHost(input)).toBe(host);
  });

  it.each(["", "   ", "https://", "allowed.com@evil.com", "a.com/path"])("rejects %j", (input) => {
    expect(policyRequestHost(input)).toBeUndefined();
  });
});

describe("evaluateToolSourceHost", () => {
  it("allows everything without a list", () => {
    expect(evaluateToolSourceHost(undefined, "https://anything.test").allowed).toBe(true);
    expect(evaluateToolSourceHost({ version: 1 }, "https://anything.test").allowed).toBe(true);
  });

  it("matches exact hosts ignoring case, trailing dot and port", () => {
    const policy = hosts(["MCP.example.com"]);
    expect(evaluateToolSourceHost(policy, "https://mcp.example.com/mcp").allowed).toBe(true);
    expect(evaluateToolSourceHost(policy, "https://mcp.example.com.:8443/x").allowed).toBe(true);
    expect(evaluateToolSourceHost(policy, "https://other.example.com/").allowed).toBe(false);
    expect(evaluateToolSourceHost(policy, "https://evil-mcp.example.com/").allowed).toBe(false);
  });

  it("wildcards cover subdomains only, not the apex or lookalikes", () => {
    const policy = hosts(["*.example.com"]);
    expect(evaluateToolSourceHost(policy, "https://a.example.com/").allowed).toBe(true);
    expect(evaluateToolSourceHost(policy, "https://a.b.example.com/").allowed).toBe(true);
    expect(evaluateToolSourceHost(policy, "https://example.com/").allowed).toBe(false);
    expect(evaluateToolSourceHost(policy, "https://notexample.com/").allowed).toBe(false);
    expect(evaluateToolSourceHost(policy, "https://example.com.evil.com/").allowed).toBe(false);
  });

  it("is not fooled by userinfo", () => {
    const policy = hosts(["allowed.com"]);
    expect(evaluateToolSourceHost(policy, "https://allowed.com@evil.com/").allowed).toBe(false);
    expect(evaluateToolSourceHost(policy, "https://evil.com@allowed.com/").allowed).toBe(true);
  });

  it("matches IP literals exactly and never by wildcard", () => {
    expect(evaluateToolSourceHost(hosts(["10.0.0.5"]), "http://10.0.0.5:8080/").allowed).toBe(true);
    expect(evaluateToolSourceHost(hosts(["10.0.0.5"]), "http://10.0.0.6/").allowed).toBe(false);
    expect(evaluateToolSourceHost(hosts(["[::1]"]), "http://[::1]:3000/").allowed).toBe(true);
    expect(evaluateToolSourceHost(hosts(["*.0.0.5"]), "http://10.0.0.5/").allowed).toBe(false);
    expect(evaluateToolSourceHost(hosts(["*.1"]), "http://[::1]/").allowed).toBe(false);
  });

  it("does not let an odd IP spelling bypass an exact entry", () => {
    expect(evaluateToolSourceHost(hosts(["127.0.0.1"]), "http://2130706433/").allowed).toBe(true);
    expect(evaluateToolSourceHost(hosts(["10.0.0.5"]), "http://0x7f000001/").allowed).toBe(false);
  });

  it("refuses unparseable targets and malformed entries when a list is set", () => {
    expect(evaluateToolSourceHost(hosts(["*"]), "https://a.com/").allowed).toBe(false);
    expect(evaluateToolSourceHost(hosts(["*.*"]), "https://a.com/").allowed).toBe(false);
    expect(evaluateToolSourceHost(hosts(["a.com"]), "not a url").allowed).toBe(false);
    expect(evaluateToolSourceHost(hosts([]), "https://a.com/")).toEqual({
      allowed: false,
      rule: "integrations.mcp.allowHosts",
    });
  });
});

describe("evaluateStdioMcp", () => {
  it("blocks local commands only while a host list is set", () => {
    expect(evaluateStdioMcp(undefined).allowed).toBe(true);
    expect(evaluateStdioMcp(apps(["gmail"])).allowed).toBe(true);
    expect(evaluateStdioMcp(hosts(["a.com"]))).toEqual({
      allowed: false,
      rule: "integrations.mcp.allowHosts",
    });
  });
});
