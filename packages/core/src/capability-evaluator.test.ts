import type { CapabilityGrant, Policy } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import type { CapabilitySnapshot } from "./capability-evaluator.js";
import {
  capabilityResourceMatches,
  evaluateCall,
  evaluateCapability,
} from "./capability-evaluator.js";

const NOW = new Date("2026-06-01T12:00:00Z");
const PAST = new Date("2026-05-01T00:00:00Z");
const FUTURE = new Date("2026-07-01T00:00:00Z");

const grant = (
  over: Partial<CapabilityGrant> & Pick<CapabilityGrant, "scope">,
): CapabilityGrant => ({
  id: `g-${over.scope}`,
  kind: "bot",
  effect: "allow",
  createdVia: "admin",
  ...over,
});

const snap = (over: Partial<CapabilitySnapshot> = {}): CapabilitySnapshot => ({
  now: NOW,
  principal: { actingUserId: "alice" },
  grants: [],
  ...over,
});

const policy = (capabilities: NonNullable<Policy["capabilities"]>): Policy => ({
  version: 1,
  capabilities,
});

const decide = (s: CapabilitySnapshot, scopes: string[], rest = {}) =>
  evaluateCapability(s, { scopes, ...rest });

describe("grants", () => {
  it("allows a call with no scopes and denies a scope with no grant", () => {
    expect(decide(snap(), []).outcome).toBe("allow");
    expect(decide(snap(), ["mail.read"])).toMatchObject({ outcome: "deny", rule: "no_grant" });
  });

  it("allows with a covering grant, by exact scope or domain wildcard", () => {
    for (const scope of ["mail.read", "mail.*"]) {
      expect(decide(snap({ grants: [grant({ scope })] }), ["mail.read"]).outcome).toBe("allow");
    }
    expect(decide(snap({ grants: [grant({ scope: "mail.read" })] }), ["mail.send"]).outcome).toBe(
      "deny",
    );
  });

  it("does not let verbs imply each other", () => {
    const s = snap({ grants: [grant({ scope: "files.write" })] });
    expect(decide(s, ["files.delete"]).outcome).toBe("deny");
    expect(decide(s, ["calendar.write"]).outcome).toBe("deny");
  });

  it("requires every scope of a multi-scope call", () => {
    const s = snap({ grants: [grant({ scope: "mail.read" })] });
    expect(decide(s, ["mail.read", "files.write"])).toMatchObject({ outcome: "deny" });
    const both = snap({ grants: [grant({ scope: "mail.read" }), grant({ scope: "files.write" })] });
    expect(decide(both, ["mail.read", "files.write"]).outcome).toBe("allow");
  });

  it("lets a deny row beat any allow, and an ask row cap at ask", () => {
    const denied = snap({
      grants: [grant({ scope: "mail.*" }), grant({ id: "d", scope: "mail.send", effect: "deny" })],
    });
    expect(decide(denied, ["mail.send"])).toMatchObject({ outcome: "deny", rule: "grant_deny" });
    expect(decide(denied, ["mail.read"]).outcome).toBe("allow");
    const asked = snap({
      grants: [grant({ scope: "mail.*" }), grant({ id: "a", scope: "mail.send", effect: "ask" })],
    });
    expect(decide(asked, ["mail.send"])).toMatchObject({ outcome: "ask", rule: "grant_ask" });
    const onlyAsk = snap({ grants: [grant({ scope: "mail.send", effect: "ask" })] });
    expect(decide(onlyAsk, ["mail.send"]).outcome).toBe("deny");
  });
});

describe("expiry and revocation", () => {
  it("ignores expired and revoked grants and says why in the trace", () => {
    const expired = snap({ grants: [grant({ id: "e", scope: "mail.read", expiresAt: PAST })] });
    const result = decide(expired, ["mail.read"]);
    expect(result).toMatchObject({ outcome: "deny", rule: "no_grant" });
    expect(result.trace).toContainEqual(
      expect.objectContaining({ rule: "e", effect: "none", detail: "expired" }),
    );
    const revoked = snap({ grants: [grant({ id: "r", scope: "mail.read", revokedAt: PAST })] });
    expect(decide(revoked, ["mail.read"]).trace).toContainEqual(
      expect.objectContaining({ rule: "r", detail: "revoked" }),
    );
  });

  it("honors a grant until the instant it expires", () => {
    const s = (expiresAt: Date) => snap({ grants: [grant({ scope: "mail.read", expiresAt })] });
    expect(decide(s(FUTURE), ["mail.read"]).outcome).toBe("allow");
    expect(decide(s(NOW), ["mail.read"]).outcome).toBe("deny");
  });

  it("lets restrictions expire too", () => {
    const s = snap({
      grants: [
        grant({ scope: "mail.*" }),
        grant({ id: "d", scope: "mail.send", effect: "deny", expiresAt: PAST }),
      ],
    });
    expect(decide(s, ["mail.send"]).outcome).toBe("allow");
  });

  it("records the expiry of a live grant in the trace", () => {
    const result = decide(snap({ grants: [grant({ scope: "mail.read", expiresAt: FUTURE })] }), [
      "mail.read",
    ]);
    expect(result.trace[0]).toMatchObject({ effect: "allow", expiresAt: FUTURE.toISOString() });
  });
});

describe("resource limits", () => {
  const cal = grant({ scope: "calendar.read", resource: { kind: "resource_arg", match: "team" } });

  it("allows the named resource and denies another", () => {
    const s = snap({ grants: [cal] });
    expect(decide(s, ["calendar.read"], { resources: { resource_arg: "team" } }).outcome).toBe(
      "allow",
    );
    expect(decide(s, ["calendar.read"], { resources: { resource_arg: "boss" } })).toMatchObject({
      outcome: "deny",
      rule: "resource",
    });
  });

  it("denies when the call has no resource the classifier could read", () => {
    expect(decide(snap({ grants: [cal] }), ["calendar.read"], { resources: {} })).toMatchObject({
      outcome: "deny",
      rule: "resource",
    });
    // A resource of another kind does not stand in.
    expect(
      decide(snap({ grants: [cal] }), ["calendar.read"], { resources: { host: "team" } }).outcome,
    ).toBe("deny");
  });

  it("falls through to an unrestricted grant", () => {
    const s = snap({ grants: [cal, grant({ id: "any", scope: "calendar.*" })] });
    expect(decide(s, ["calendar.read"], { resources: { resource_arg: "boss" } }).outcome).toBe(
      "allow",
    );
  });

  it("applies a restriction whose resource cannot be read (fail closed)", () => {
    const s = snap({
      grants: [
        grant({ scope: "web.*" }),
        grant({
          id: "d",
          scope: "web.fetch",
          effect: "deny",
          resource: { kind: "host", match: "evil.com" },
        }),
      ],
    });
    expect(decide(s, ["web.fetch"], { resources: {} }).outcome).toBe("deny");
    expect(decide(s, ["web.fetch"], { resources: { host: "evil.com" } }).outcome).toBe("deny");
    expect(decide(s, ["web.fetch"], { resources: { host: "good.com" } }).outcome).toBe("allow");
  });

  it("matches each resource kind", () => {
    const m = capabilityResourceMatches;
    expect(m({ kind: "connection", match: "c1" }, "c1")).toBe(true);
    expect(m({ kind: "connection", match: "c1" }, "C1")).toBe(false);
    expect(m({ kind: "mcp_server", match: "s1" }, "s2")).toBe(false);
    expect(m({ kind: "host", match: "*.example.com" }, "a.example.com")).toBe(true);
    expect(m({ kind: "host", match: "*.example.com" }, "example.com")).toBe(false);
    expect(m({ kind: "host", match: "example.com" }, "evil-example.com")).toBe(false);
    expect(m({ kind: "recipient_domain", match: "corp.test" }, "corp.test")).toBe(true);
    expect(m({ kind: "host", match: "x" }, undefined)).toBe(false);
  });

  it("matches paths by prefix and refuses traversal", () => {
    const m = (match: string, value: string) =>
      capabilityResourceMatches({ kind: "path", match }, value);
    expect(m("work", "work/a.txt")).toBe(true);
    expect(m("work/", "work/sub/a.txt")).toBe(true);
    expect(m("work", "work")).toBe(true);
    expect(m("work", "workshop/a.txt")).toBe(false);
    expect(m("work", "work/../secrets")).toBe(false);
    expect(m("work", "other/a.txt")).toBe(false);
  });
});

describe("owner grants versus admin grants", () => {
  it("lets an owner grant read and fetch scopes", () => {
    for (const scope of ["mail.read", "web.fetch", "ext.acme.read"]) {
      const s = snap({ grants: [grant({ scope, createdVia: "owner" })] });
      expect(decide(s, [scope]).outcome).toBe("allow");
    }
  });

  it("ignores an owner's write, send, spend or wildcard allow", () => {
    for (const scope of [
      "mail.send",
      "calendar.write",
      "spend.purchase",
      "mail.*",
      "ext.acme.write",
    ]) {
      const s = snap({ grants: [grant({ id: "o", scope, createdVia: "owner" })] });
      const target = scope.endsWith("*") ? scope.replace("*", "read") : scope;
      const result = decide(s, [target]);
      expect(result.outcome, scope).toBe("deny");
      expect(result.trace).toContainEqual(
        expect.objectContaining({ rule: "o", effect: "none", detail: "owner_not_permitted" }),
      );
    }
  });

  it("honors an owner's write scope that the admin allow-list names", () => {
    const p = policy({ ownerGrantable: ["calendar.write", "docs.*"] });
    const s = (scope: string) =>
      snap({ policy: p, grants: [grant({ scope, createdVia: "owner" })] });
    expect(decide(s("calendar.write"), ["calendar.write"]).outcome).toBe("allow");
    expect(decide(s("docs.*"), ["docs.delete"]).outcome).toBe("allow");
    expect(decide(s("mail.send"), ["mail.send"]).outcome).toBe("deny");
    // A listed domain wildcard does not widen a narrower list entry.
    expect(decide(s("calendar.*"), ["calendar.write"]).outcome).toBe("deny");
  });

  it("always honors an owner's own restriction", () => {
    const s = snap({
      grants: [
        grant({ scope: "mail.*", createdVia: "admin" }),
        grant({ id: "d", scope: "mail.send", effect: "deny", createdVia: "owner" }),
      ],
    });
    expect(decide(s, ["mail.send"]).outcome).toBe("deny");
  });

  it("accepts admin and policy grants for any scope", () => {
    for (const createdVia of ["admin", "policy"] as const) {
      const s = snap({ grants: [grant({ scope: "spend.purchase", createdVia })] });
      expect(decide(s, ["spend.purchase"]).outcome).toBe("allow");
    }
  });
});

describe("org ceiling", () => {
  const all = grant({ scope: "mail.*" });

  it("denies a scope listed in capabilities.deny whatever the grants say", () => {
    const s = snap({ policy: policy({ deny: ["mail.send"] }), grants: [all] });
    expect(decide(s, ["mail.send"])).toMatchObject({ outcome: "deny", rule: "capabilities.deny" });
    expect(decide(s, ["mail.read"]).outcome).toBe("allow");
  });

  it("denies a scope outside the ceiling", () => {
    const s = snap({ policy: policy({ ceiling: ["mail.read", "calendar.*"] }), grants: [all] });
    expect(decide(s, ["mail.send"])).toMatchObject({
      outcome: "deny",
      rule: "capabilities.ceiling",
    });
    expect(decide(s, ["mail.read"]).outcome).toBe("allow");
  });

  it("accepts *.* as the widest ceiling and lets deny carve out of it", () => {
    const s = snap({ policy: policy({ ceiling: ["*.*"], deny: ["ext.*"] }), grants: [all] });
    expect(decide(s, ["mail.send"]).outcome).toBe("allow");
    expect(decide(s, ["ext.acme.read"]).outcome).toBe("deny");
  });

  it("caps alwaysAsk at ask, but not below a deny", () => {
    const p = policy({ alwaysAsk: ["mail.send"] });
    expect(decide(snap({ policy: p, grants: [all] }), ["mail.send"])).toMatchObject({
      outcome: "ask",
      rule: "capabilities.alwaysAsk",
    });
    expect(decide(snap({ policy: p }), ["mail.send"]).outcome).toBe("deny");
  });

  it("passes when the section or the policy is absent", () => {
    for (const policyValue of [undefined, { version: 1 } as Policy, policy({})]) {
      expect(decide(snap({ policy: policyValue, grants: [all] }), ["mail.send"]).outcome).toBe(
        "allow",
      );
    }
  });
});

describe("quarantine", () => {
  it("is a hard stop that ignores grants, ceiling and approvals", () => {
    const s = snap({
      quarantine: { id: "q1" },
      grants: [grant({ scope: "*.*" as never }), grant({ scope: "mail.*" })],
      approval: "allow",
    });
    const result = decide(s, ["mail.read"]);
    expect(result).toMatchObject({ outcome: "deny", rule: "quarantine" });
    expect(result.trace).toEqual([
      { layer: "quarantine", rule: "quarantine", effect: "deny", detail: "q1" },
    ]);
  });

  it("denies a call that needs no scope", () => {
    expect(decide(snap({ quarantine: { id: "q1" } }), []).outcome).toBe("deny");
  });

  it("blocks use of a personal connection (the delegation is not consulted)", () => {
    const s = snap({
      quarantine: { id: "q1" },
      grants: [grant({ kind: "delegation", principalUserId: "alice", scope: "calendar.read" })],
    });
    const result = decide(s, ["calendar.read"], {
      credential: { kind: "personal", userId: "alice" },
    });
    expect(result).toMatchObject({ outcome: "deny", rule: "quarantine" });
  });
});

describe("principal and delegation", () => {
  const delegation = grant({
    id: "del",
    kind: "delegation",
    principalUserId: "alice",
    scope: "calendar.read",
  });
  const personal = (userId: string) => ({ credential: { kind: "personal" as const, userId } });

  it("allows the acting user's own delegation, which serves as the bot grant too", () => {
    expect(
      decide(snap({ grants: [delegation] }), ["calendar.read"], personal("alice")).outcome,
    ).toBe("allow");
  });

  it("denies a personal credential of another user, however it is named", () => {
    const s = snap({ grants: [delegation, grant({ scope: "calendar.read" })] });
    expect(decide(s, ["calendar.read"], personal("bob"))).toMatchObject({
      outcome: "deny",
      rule: "principal_mismatch",
    });
  });

  it("does not use someone else's delegation for the acting user's run", () => {
    const s = snap({ principal: { actingUserId: "bob" }, grants: [delegation] });
    expect(decide(s, ["calendar.read"], personal("bob"))).toMatchObject({ outcome: "deny" });
    expect(decide(s, ["calendar.read"], personal("alice")).rule).toBe("principal_mismatch");
  });

  it("requires the delegation for a personal credential even with a bot grant", () => {
    const s = snap({ grants: [grant({ scope: "calendar.read" })] });
    expect(decide(s, ["calendar.read"], personal("alice"))).toMatchObject({
      outcome: "deny",
      rule: "not_delegated",
    });
    expect(decide(s, ["calendar.read"]).outcome).toBe("allow");
  });

  it("applies a delegation's own resource and expiry", () => {
    const narrow = grant({
      ...delegation,
      resource: { kind: "connection", match: "c1" },
      expiresAt: FUTURE,
    });
    const s = snap({ grants: [narrow] });
    const call = (connection: string) =>
      decide(s, ["calendar.read"], { ...personal("alice"), resources: { connection } });
    expect(call("c1").outcome).toBe("allow");
    expect(call("c2")).toMatchObject({ outcome: "deny", rule: "resource" });
  });

  it("keeps shared identities separate from personal delegation", () => {
    const shared = grant({
      id: "sh",
      kind: "shared_identity",
      sharedIdentityId: "team-inbox",
      scope: "mail.read",
    });
    const credential = { kind: "shared" as const, identityId: "team-inbox" };
    const run = { principal: { actingUserId: "alice", sharedIdentityId: "team-inbox" } };
    expect(decide(snap({ ...run, grants: [shared] }), ["mail.read"], { credential }).outcome).toBe(
      "allow",
    );
    // Without the explicit grant, a delegation of the user is not a fallback.
    const fallback = snap({
      ...run,
      grants: [grant({ kind: "delegation", principalUserId: "alice", scope: "mail.read" })],
    });
    expect(decide(fallback, ["mail.read"], { credential })).toMatchObject({
      outcome: "deny",
      rule: "no_grant",
    });
    // A run with no shared identity can never use it.
    expect(decide(snap({ grants: [shared] }), ["mail.read"], { credential })).toMatchObject({
      outcome: "deny",
      rule: "principal_mismatch",
    });
    // And the shared grant is not a personal delegation.
    expect(decide(snap({ ...run, grants: [shared] }), ["mail.read"], personal("alice")).rule).toBe(
      "not_delegated",
    );
  });
});

describe("approvals", () => {
  const allowed = snap({ grants: [grant({ scope: "mail.*" })] });

  it("cannot create access or lift an ask", () => {
    expect(decide({ ...allowed, grants: [], approval: "allow" }, ["mail.send"]).outcome).toBe(
      "deny",
    );
    const asked = {
      ...allowed,
      policy: policy({ alwaysAsk: ["mail.send"] }),
      approval: "allow" as const,
    };
    expect(decide(asked, ["mail.send"]).outcome).toBe("ask");
  });

  it("turns an allow into an ask, and a block into a deny", () => {
    expect(decide({ ...allowed, approval: "ask" }, ["mail.send"])).toMatchObject({
      outcome: "ask",
      rule: "approval_ask",
    });
    expect(decide({ ...allowed, approval: "block" }, ["mail.send"])).toMatchObject({
      outcome: "deny",
      rule: "approval_block",
    });
  });

  it("applies to a call with no scopes too", () => {
    expect(decide(snap({ approval: "block" }), []).outcome).toBe("deny");
    expect(decide(snap({ approval: "ask" }), []).outcome).toBe("ask");
  });
});

describe("precedence", () => {
  // Layers, strongest first: quarantine, ceiling, principal/grants, approvals.
  it("reports the first deciding rule in layer order", () => {
    const s = snap({
      policy: policy({ deny: ["mail.send"] }),
      approval: "block",
      grants: [],
    });
    const result = decide(s, ["mail.send"]);
    expect(result.rule).toBe("capabilities.deny");
    expect(result.trace.map((entry) => entry.layer)).toEqual(["ceiling", "grant", "approval"]);
  });

  it("lets deny beat ask across layers", () => {
    const s = snap({
      policy: policy({ alwaysAsk: ["mail.send"] }),
      grants: [grant({ scope: "mail.read" })],
    });
    expect(decide(s, ["mail.send"]).outcome).toBe("deny");
  });

  it("lets nothing turn a deny into an allow", () => {
    const s = snap({
      policy: policy({ ceiling: ["calendar.*"] }),
      grants: [grant({ scope: "mail.*", createdVia: "policy" })],
      approval: "allow",
    });
    expect(decide(s, ["mail.send"]).outcome).toBe("deny");
  });
});

describe("trace shape", () => {
  it("contains scope names, ids and rule names only", () => {
    const result = decide(
      snap({
        policy: policy({ alwaysAsk: ["mail.send"] }),
        grants: [grant({ id: "grant_01", scope: "mail.*", expiresAt: FUTURE })],
      }),
      ["mail.send"],
      { resources: { resource_arg: "SECRET-VALUE" } },
    );
    expect(result.trace).toEqual([
      { layer: "ceiling", rule: "capabilities.alwaysAsk", scope: "mail.send", effect: "ask" },
      {
        layer: "grant",
        rule: "grant_01",
        scope: "mail.send",
        effect: "allow",
        source: "admin",
        expiresAt: FUTURE.toISOString(),
      },
    ]);
    expect(JSON.stringify(result)).not.toContain("SECRET-VALUE");
  });
});

describe("acceptance A2 at the evaluator level", () => {
  const p = policy({
    mappings: [
      {
        match: { source: "mcp", server: "cal-*", tool: "list_*" },
        scopes: ["calendar.read"],
        resourceArg: "calendarId",
      },
      { match: { source: "mcp", server: "cal-*", tool: "create_*" }, scopes: ["calendar.write"] },
      { match: { source: "connector", app: "mail", tool: "send_*" }, scopes: ["mail.send"] },
    ],
  });
  const readOnly = grant({
    id: "del",
    kind: "delegation",
    principalUserId: "alice",
    scope: "calendar.read",
    resource: { kind: "resource_arg", match: "team" },
    createdVia: "owner",
  });
  const run = (over: Partial<CapabilitySnapshot> = {}) =>
    snap({ policy: p, grants: [readOnly], ...over });
  const mcp = (tool: string, extra: object = {}) => ({
    source: "mcp" as const,
    tool,
    slug: "cal-main",
    serverId: "srv1",
    connectionId: "alice-conn",
    ...extra,
  });
  const alice = { kind: "personal" as const, userId: "alice" };

  it("reads the approved calendar", () => {
    const result = evaluateCall(run(), mcp("list_events", { args: { calendarId: "team" } }), alice);
    expect(result.outcome).toBe("allow");
    expect(result.classification.scopes).toEqual(["calendar.read"]);
  });

  it("denies another calendar", () => {
    expect(
      evaluateCall(run(), mcp("list_events", { args: { calendarId: "boss" } }), alice),
    ).toMatchObject({
      outcome: "deny",
      rule: "resource",
    });
  });

  it("cannot write or send even if asked", () => {
    expect(
      evaluateCall(run(), mcp("create_event", { args: { calendarId: "team" } }), alice),
    ).toMatchObject({
      outcome: "deny",
      rule: "no_grant",
    });
    expect(
      evaluateCall(run(), { source: "connector", tool: "send_mail", slug: "mail" }, alice),
    ).toMatchObject({ outcome: "deny", rule: "no_grant" });
  });

  it("denies an unmapped tool whose annotation lies about being read-only", () => {
    const result = evaluateCall(
      run(),
      { source: "mcp", tool: "send_email", slug: "mailer", annotations: { readOnlyHint: true } },
      alice,
    );
    expect(result).toMatchObject({ outcome: "deny", rule: "no_grant" });
    expect(result.classification.scopes).toEqual(["ext.mailer.read"]);
  });

  it("denies another user's credential, and a run started by someone else", () => {
    const bob = { kind: "personal" as const, userId: "bob" };
    expect(
      evaluateCall(run(), mcp("list_events", { args: { calendarId: "team" } }), bob).rule,
    ).toBe("principal_mismatch");
    const bobsRun = run({ principal: { actingUserId: "bob" } });
    expect(
      evaluateCall(bobsRun, mcp("list_events", { args: { calendarId: "team" } }), bob),
    ).toMatchObject({
      outcome: "deny",
    });
  });

  it("denies built-in write and send style tools the bot was never granted", () => {
    for (const tool of ["write_file", "shell", "request_purchase", "user_computer_shell"]) {
      expect(evaluateCall(run(), { source: "builtin", tool }).outcome, tool).toBe("deny");
    }
    expect(evaluateCall(run(), { source: "builtin", tool: "ask_user" }).outcome).toBe("allow");
  });
});

describe("acceptance: quarantined bot", () => {
  it("is denied everywhere, including tools that need no scope", () => {
    const s = snap({
      quarantine: { id: "q1" },
      grants: [grant({ scope: "files.*" }), grant({ scope: "web.*" })],
    });
    for (const tool of ["read_file", "web_fetch", "ask_user", "shell"]) {
      expect(evaluateCall(s, { source: "builtin", tool })).toMatchObject({
        outcome: "deny",
        rule: "quarantine",
      });
    }
    expect(evaluateCall(s, { source: "mcp", tool: "x", slug: "a" }).rule).toBe("quarantine");
  });
});
