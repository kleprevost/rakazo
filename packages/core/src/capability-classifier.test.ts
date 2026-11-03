import type { Policy } from "@rakazo/contracts";
import { BUILTIN_TOOL_NAMES, isConcreteScope } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import { BUILTIN_TOOL_SCOPES } from "./capability-builtin-scopes.js";
import { classifyCall } from "./capability-classifier.js";

const policy = (capabilities: NonNullable<Policy["capabilities"]>): Policy => ({
  version: 1,
  capabilities,
});

describe("built-in table", () => {
  it("classifies every built-in tool with valid scopes (or explicitly none)", () => {
    for (const name of BUILTIN_TOOL_NAMES) {
      const scopes = BUILTIN_TOOL_SCOPES[name];
      expect(scopes, name).toBeDefined();
      for (const scope of scopes) expect(isConcreteScope(scope), `${name}: ${scope}`).toBe(true);
    }
    expect(Object.keys(BUILTIN_TOOL_SCOPES).sort()).toEqual([...BUILTIN_TOOL_NAMES].sort());
  });

  it("maps the sensitive tools", () => {
    const scopes = (tool: string) => classifyCall({ source: "builtin", tool }).scopes;
    expect(scopes("web_fetch")).toEqual(["web.fetch"]);
    expect(scopes("secret_request")).toEqual(["secrets.use"]);
    expect(scopes("user_computer_shell")).toEqual(["computer.host"]);
    expect(scopes("spawn_bot")).toEqual(["fleet.spawn"]);
    expect(scopes("request_purchase")).toEqual(["spend.purchase"]);
    expect(scopes("ask_user")).toEqual([]);
  });

  it("reads host and path resources only from the tool's own arguments", () => {
    const fetched = classifyCall({
      source: "builtin",
      tool: "web_fetch",
      args: { url: "https://Docs.Example.com/a?b=1" },
    });
    expect(fetched.resources).toEqual({ host: "docs.example.com" });
    expect(
      classifyCall({ source: "builtin", tool: "web_fetch", args: { url: "file:///etc/passwd" } })
        .resources,
    ).toEqual({});
    expect(
      classifyCall({ source: "builtin", tool: "write_file", args: { path: "work/a.txt" } })
        .resources,
    ).toEqual({ path: "work/a.txt" });
  });

  it("gives an unknown built-in name the top ext scope", () => {
    const result = classifyCall({ source: "builtin", tool: "brand_new_tool" });
    expect(result.scopes).toEqual(["ext.builtin.admin"]);
    expect(result.unmapped).toBe(true);
  });
});

describe("admin mappings", () => {
  const p = policy({
    mappings: [
      {
        match: { source: "mcp", server: "cal-*", tool: "list_*" },
        scopes: ["calendar.read"],
        resourceArg: "calendarId",
      },
      { match: { source: "mcp", server: "cal-*", tool: "create_*" }, scopes: ["calendar.write"] },
      { match: { source: "connector", app: "mail-*", tool: "*send*" }, scopes: ["mail.send"] },
      {
        match: { source: "mcp", server: "wiki" },
        scopes: ["docs.write"],
        trustAnnotations: true,
        readScopes: ["docs.read"],
      },
    ],
  });

  it("maps by source, slug glob and tool glob, and extracts the resource argument", () => {
    const read = classifyCall(
      {
        source: "mcp",
        tool: "list_events",
        slug: "cal-main",
        serverId: "srv1",
        args: { calendarId: "team" },
      },
      p,
    );
    expect(read).toMatchObject({
      scopes: ["calendar.read"],
      basis: "mapping",
      unmapped: false,
      resources: { mcp_server: "srv1", resource_arg: "team" },
    });
    expect(
      classifyCall({ source: "mcp", tool: "create_event", slug: "cal-main" }, p).scopes,
    ).toEqual(["calendar.write"]);
    expect(
      classifyCall({ source: "connector", tool: "gmail_send", slug: "mail-x" }, p).scopes,
    ).toEqual(["mail.send"]);
  });

  it("does not match across sources and takes the first match", () => {
    expect(
      classifyCall({ source: "connector", tool: "list_events", slug: "cal-main" }, p).unmapped,
    ).toBe(true);
    const first = policy({
      mappings: [
        { match: { source: "mcp", tool: "get_*" }, scopes: ["docs.read"] },
        { match: { source: "mcp" }, scopes: ["docs.delete"] },
      ],
    });
    expect(classifyCall({ source: "mcp", tool: "get_x", slug: "a" }, first).scopes).toEqual([
      "docs.read",
    ]);
  });

  it("leaves the resource out when the argument is missing or not a scalar", () => {
    const missing = classifyCall({ source: "mcp", tool: "list_x", slug: "cal-a", args: {} }, p);
    expect(missing.resources).toEqual({});
    const list = classifyCall(
      { source: "mcp", tool: "list_x", slug: "cal-a", args: { calendarId: ["a", "b"] } },
      p,
    );
    expect(list.resources).toEqual({});
  });

  it("ignores annotations on a mapped call unless the mapping trusts them", () => {
    const lying = classifyCall(
      { source: "mcp", tool: "create_event", slug: "cal-a", annotations: { readOnlyHint: true } },
      p,
    );
    expect(lying.scopes).toEqual(["calendar.write"]);
    const trusted = classifyCall(
      { source: "mcp", tool: "x", slug: "wiki", annotations: { readOnlyHint: true } },
      p,
    );
    expect(trusted).toMatchObject({ scopes: ["docs.read"], basis: "annotation" });
    const destructive = classifyCall(
      {
        source: "mcp",
        tool: "x",
        slug: "wiki",
        annotations: { readOnlyHint: true, destructiveHint: true },
      },
      p,
    );
    expect(destructive.scopes).toEqual(["docs.write"]);
    expect(classifyCall({ source: "mcp", tool: "x", slug: "wiki" }, p).scopes).toEqual([
      "docs.write",
    ]);
  });
});

describe("unmapped tools", () => {
  const call = (extra: object) =>
    classifyCall({ source: "mcp", tool: "send_mail", slug: "Acme MCP", ...extra });

  it("fall back to ext.<slug>.admin when nothing is known", () => {
    expect(call({})).toMatchObject({
      scopes: ["ext.acme-mcp.admin"],
      basis: "unmapped",
      unmapped: true,
    });
  });

  it("uses a server-verified effect", () => {
    expect(call({ effect: "read" }).scopes).toEqual(["ext.acme-mcp.read"]);
    expect(call({ effect: "write" }).scopes).toEqual(["ext.acme-mcp.write"]);
    expect(call({ effect: "read" }).basis).toBe("declared");
  });

  it("lets annotations only tighten", () => {
    expect(call({ annotations: { destructiveHint: true } }).scopes).toEqual(["ext.acme-mcp.admin"]);
    expect(call({ effect: "read", annotations: { destructiveHint: true } }).scopes).toEqual([
      "ext.acme-mcp.admin",
    ]);
    expect(call({ annotations: { readOnlyHint: false } }).scopes).toEqual(["ext.acme-mcp.write"]);
    // A read claim is only a candidate for the ext read scope; a name that says "send" is ignored.
    const lying = call({ annotations: { readOnlyHint: true } });
    expect(lying.scopes).toEqual(["ext.acme-mcp.read"]);
    expect(lying.unmapped).toBe(true);
    expect(call({ annotations: { readOnlyHint: true, destructiveHint: true } }).scopes).toEqual([
      "ext.acme-mcp.admin",
    ]);
  });

  it("never classifies by tool-name pattern", () => {
    for (const tool of ["list_events", "get_thing", "search_x", "send_mail", "delete_all"]) {
      expect(classifyCall({ source: "mcp", tool, slug: "s" }).scopes).toEqual(["ext.s.admin"]);
    }
  });
});

describe("batch actions", () => {
  const p = policy({
    mappings: [{ match: { source: "connector", app: "m", tool: "read_*" }, scopes: ["mail.read"] }],
  });

  it("classifies each named action and unions the scopes", () => {
    const result = classifyCall(
      { source: "connector", tool: "batch", slug: "m", batchActions: ["read_a", "read_b", "wipe"] },
      p,
    );
    expect(result.scopes).toEqual(["mail.read", "ext.m.admin"]);
    expect(result.unmapped).toBe(true);
  });

  it("gives an unidentified action the top scope", () => {
    const result = classifyCall(
      { source: "connector", tool: "batch", slug: "m", batchActions: ["read_a", undefined] },
      p,
    );
    expect(result.scopes).toEqual(["mail.read", "ext.m.admin"]);
  });
});
