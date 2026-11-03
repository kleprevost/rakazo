import { describe, expect, it } from "vitest";
import {
  CapabilityGrantSchema,
  CapabilityMappingSchema,
  CapabilityPolicySchema,
  capabilityScopeCovers,
  capabilitySlug,
  isConcreteScope,
} from "./capabilities.js";
import { PolicySchema } from "./policy.js";

describe("scope taxonomy", () => {
  it("accepts only known domain.verb pairs and ext.<slug>.<verb>", () => {
    for (const scope of [
      "calendar.read",
      "mail.send",
      "web.fetch",
      "ext.acme.admin",
      "computer.host",
    ]) {
      expect(isConcreteScope(scope)).toBe(true);
    }
    for (const scope of [
      "calendar.fetch",
      "mail",
      "mail.read.extra",
      "ext.acme",
      "ext.acme.delete",
      "ext.Acme.read",
      "toString.read",
      "calendar.*",
      "*.*",
    ]) {
      expect(isConcreteScope(scope)).toBe(false);
    }
  });

  it("covers by wildcard at domain level only", () => {
    expect(capabilityScopeCovers("calendar.*", "calendar.write")).toBe(true);
    expect(capabilityScopeCovers("calendar.*", "mail.read")).toBe(false);
    expect(capabilityScopeCovers("ext.acme.*", "ext.acme.read")).toBe(true);
    expect(capabilityScopeCovers("ext.acme.*", "ext.other.read")).toBe(false);
    expect(capabilityScopeCovers("ext.*", "ext.other.read")).toBe(true);
    expect(capabilityScopeCovers("*.*", "spend.purchase")).toBe(true);
    expect(capabilityScopeCovers("files.write", "files.delete")).toBe(false);
  });

  it("builds a safe slug", () => {
    expect(capabilitySlug("Cal Server_1")).toBe("cal-server-1");
    expect(capabilitySlug("")).toBe("unknown");
    expect(capabilitySlug(undefined)).toBe("unknown");
  });
});

describe("grant schema", () => {
  const base = { id: "g1", kind: "bot", scope: "calendar.read", createdVia: "owner" } as const;

  it("defaults the effect to allow and accepts wildcard domains", () => {
    expect(CapabilityGrantSchema.parse(base).effect).toBe("allow");
    expect(CapabilityGrantSchema.safeParse({ ...base, scope: "mail.*" }).success).toBe(true);
  });

  it("rejects *.*, unknown scopes, unknown keys and incomplete delegations", () => {
    expect(CapabilityGrantSchema.safeParse({ ...base, scope: "*.*" }).success).toBe(false);
    expect(CapabilityGrantSchema.safeParse({ ...base, scope: "mail.fly" }).success).toBe(false);
    expect(CapabilityGrantSchema.safeParse({ ...base, extra: 1 }).success).toBe(false);
    expect(CapabilityGrantSchema.safeParse({ ...base, kind: "delegation" }).success).toBe(false);
    expect(CapabilityGrantSchema.safeParse({ ...base, kind: "shared_identity" }).success).toBe(
      false,
    );
    expect(
      CapabilityGrantSchema.safeParse({ ...base, resource: { kind: "vendor", match: "x" } })
        .success,
    ).toBe(false);
  });
});

describe("policy capabilities section", () => {
  it("is optional: a policy without it parses unchanged", () => {
    const parsed = PolicySchema.parse({ version: 1 });
    expect(parsed.capabilities).toBeUndefined();
  });

  it("parses ceiling, deny, alwaysAsk, ownerGrantable and mappings", () => {
    const parsed = PolicySchema.parse({
      version: 1,
      capabilities: {
        requireGrants: true,
        ceiling: ["*.*"],
        deny: ["spend.*", "ext.*"],
        alwaysAsk: ["mail.send"],
        ownerGrantable: ["calendar.write"],
        mappings: [
          {
            match: { source: "mcp", server: "cal-*", tool: "list_*" },
            scopes: ["calendar.read"],
            resourceArg: "calendarId",
          },
          { match: { source: "connector", app: "mail-*", tool: "*send*" }, scopes: ["mail.send"] },
        ],
      },
    });
    expect(parsed.capabilities?.mappings).toHaveLength(2);
  });

  it("is strict at every level", () => {
    const bad = (capabilities: unknown) =>
      PolicySchema.safeParse({ version: 1, capabilities }).success;
    expect(bad({ cieling: ["*.*"] })).toBe(false);
    expect(bad({ ceiling: ["mail.nope"] })).toBe(false);
    expect(bad({ ownerGrantable: ["*.*"] })).toBe(false);
    expect(bad({ mappings: [{ match: { source: "mcp" }, scopes: ["mail.*"] }] })).toBe(false);
    expect(bad({ mappings: [{ match: { source: "mcp" }, scopes: [] }] })).toBe(false);
    expect(bad({ mappings: [{ match: { source: "mcp", app: "x" }, scopes: ["mail.read"] }] })).toBe(
      false,
    );
    expect(
      bad({ mappings: [{ match: { source: "connector", server: "x" }, scopes: ["mail.read"] }] }),
    ).toBe(false);
    expect(
      bad({ mappings: [{ match: { source: "mcp" }, scopes: ["mail.read"], vendor: "x" }] }),
    ).toBe(false);
  });

  it("requires trustAnnotations for readScopes", () => {
    const match = { source: "mcp", server: "x" } as const;
    expect(
      CapabilityMappingSchema.safeParse({ match, scopes: ["mail.send"], readScopes: ["mail.read"] })
        .success,
    ).toBe(false);
    expect(
      CapabilityMappingSchema.safeParse({
        match,
        scopes: ["mail.send"],
        readScopes: ["mail.read"],
        trustAnnotations: true,
      }).success,
    ).toBe(true);
    expect(CapabilityPolicySchema.safeParse({}).success).toBe(true);
  });
});
