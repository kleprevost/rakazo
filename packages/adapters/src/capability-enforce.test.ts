import type { Policy } from "@rakazo/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";

const recorded = vi.hoisted(() => ({
  audit: [] as Array<Record<string, unknown>>,
  security: [] as Array<Record<string, unknown>>,
}));
vi.mock("@rakazo/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@rakazo/db")>()),
  recordAuditEvent: vi.fn(async (event: Record<string, unknown>) => {
    recorded.audit.push(event);
  }),
  recordSecurityEvent: vi.fn(async (event: Record<string, unknown>) => {
    recorded.security.push(event);
  }),
}));

import { capabilityGate } from "./capability-enforce.js";
import { classifyInputForCall, classifyInputForTool } from "./capability-shadow.js";

type Row = Record<string, unknown>;
const grant = (over: Partial<Row> & { scope: string }): Row => ({
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

function setup(grants: Row[] = [], quarantined = false) {
  const findMany = vi.fn(async (_args: unknown) => grants);
  const prisma = {
    bot: { findUnique: async () => ({ spaceId: "space-1", groupMembers: [] }) },
    quarantine: { findFirst: async () => (quarantined ? { id: "q-1", reason: "x" } : null) },
    capabilityGrant: { findMany },
  };
  return { prisma: prisma as never, findMany };
}

const bot = (capabilityMode: string | null) => ({
  id: "bot-1",
  name: "Ada",
  employeeId: null,
  capabilityMode,
});
const base = { spaceId: "space-1", userId: "user-1", runId: "run-1" };
const read = { source: "builtin", tool: "read_file", args: { path: "/SECRET" } } as const;

beforeEach(() => {
  recorded.audit.length = 0;
  recorded.security.length = 0;
});

describe("capabilityGate", () => {
  it("does nothing, and reads nothing, with the broker off", async () => {
    const { prisma, findMany } = setup();
    const verdict = await capabilityGate({
      ...base,
      prisma,
      bot: bot(null),
      surface: "gate",
      call: read,
    });
    expect(verdict.outcome).toBe("allow");
    expect(findMany).not.toHaveBeenCalled();
  });

  it("allows in shadow, records the would-be denial and does not recheck", async () => {
    const { prisma } = setup();
    const input = { ...base, prisma, bot: bot("shadow"), call: read };
    expect((await capabilityGate({ ...input, surface: "gate" })).outcome).toBe("allow");
    expect((await capabilityGate({ ...input, surface: "recheck" })).outcome).toBe("allow");
    expect(recorded.audit).toHaveLength(1);
    expect(recorded.security).toEqual([]);
  });

  it("denies without a grant in enforce, and records scope and rule only", async () => {
    const { prisma } = setup();
    const verdict = await capabilityGate({
      ...base,
      prisma,
      bot: bot("enforce"),
      surface: "gate",
      call: read,
    });
    expect(verdict).toEqual({ outcome: "deny", rule: "no_grant" });
    expect(recorded.security).toEqual([
      expect.objectContaining({
        type: "capability.denied",
        userId: "user-1",
        metadata: { botId: "bot-1", surface: "gate", rule: "no_grant", scopes: "files.read" },
      }),
    ]);
    expect(JSON.stringify(recorded.security)).not.toContain("SECRET");
  });

  it("allows with a covering grant and honors expiry and revocation on the next call", async () => {
    const live = grant({ scope: "files.read" });
    const input = { ...base, bot: bot("enforce"), surface: "recheck" as const, call: read };
    expect((await capabilityGate({ ...input, prisma: setup([live]).prisma })).outcome).toBe(
      "allow",
    );
    const expired = grant({ scope: "files.read", expiresAt: new Date(Date.now() - 1000) });
    expect((await capabilityGate({ ...input, prisma: setup([expired]).prisma })).rule).toBe(
      "no_grant",
    );
    const revoked = grant({ scope: "files.read", revokedAt: new Date() });
    expect((await capabilityGate({ ...input, prisma: setup([revoked]).prisma })).rule).toBe(
      "no_grant",
    );
  });

  it("lets a deny row win, and turns an ask row into an ask", async () => {
    const input = { ...base, bot: bot("enforce"), surface: "gate" as const, call: read };
    const both = [
      grant({ scope: "files.read" }),
      grant({ id: "d", scope: "files.read", effect: "deny" }),
    ];
    expect((await capabilityGate({ ...input, prisma: setup(both).prisma })).outcome).toBe("deny");
    const ask = [
      grant({ scope: "files.read" }),
      grant({ id: "a", scope: "files.read", effect: "ask" }),
    ];
    expect((await capabilityGate({ ...input, prisma: setup(ask).prisma })).outcome).toBe("ask");
  });

  it("denies a quarantined bot even with a grant", async () => {
    const { prisma } = setup([grant({ scope: "files.read" })], true);
    const verdict = await capabilityGate({
      ...base,
      prisma,
      bot: bot("enforce"),
      surface: "recheck",
      call: read,
    });
    expect(verdict).toEqual({ outcome: "deny", rule: "quarantine" });
  });

  it("fails closed when the grants cannot be read", async () => {
    const { prisma, findMany } = setup();
    findMany.mockRejectedValueOnce(new Error("db down"));
    const verdict = await capabilityGate({
      ...base,
      prisma,
      bot: bot("enforce"),
      surface: "gate",
      call: read,
    });
    expect(verdict).toEqual({ outcome: "deny", rule: "evaluation_failed" });
    expect(recorded.security).toHaveLength(1);
  });

  it("enforces for every bot when central policy requires grants", async () => {
    const policy: Policy = { version: 1, capabilities: { requireGrants: true } };
    const { prisma } = setup();
    const verdict = await capabilityGate({
      ...base,
      prisma,
      bot: bot(null),
      policy,
      surface: "gate",
      call: read,
    });
    expect(verdict.outcome).toBe("deny");
  });

  it("denies an unmapped connector tool whose annotation claims to be read-only", async () => {
    const { prisma } = setup([grant({ scope: "calendar.read" })]);
    const route = { connectorId: "mcp", toolName: "send", resourceId: "srv", catalogGroup: "cal" };
    const call = classifyInputForCall({ name: "send", args: {}, route, tool: { readOnly: true } });
    const verdict = await capabilityGate({
      ...base,
      prisma,
      bot: bot("enforce"),
      surface: "gate",
      call,
    });
    expect(verdict).toEqual({ outcome: "deny", rule: "no_grant" });
    expect(recorded.security[0]?.metadata).toMatchObject({ scopes: "ext.cal.read" });
  });

  it("denies a connector call that names an account the requester does not hold", async () => {
    const { prisma } = setup([
      grant({ scope: "calendar.read", kind: "delegation", principalUserId: "user-1" }),
    ]);
    const policy: Policy = {
      version: 1,
      capabilities: {
        mappings: [{ match: { source: "connector", app: "calendar" }, scopes: ["calendar.read"] }],
      },
    };
    const call = classifyInputForCall({
      name: "list",
      args: {},
      appSlug: "calendar",
      route: { connectorId: "composio", toolName: "list", connectionId: "conn-b" },
    });
    const input = { ...base, prisma, bot: bot("enforce"), policy, surface: "gate" as const, call };
    expect(await capabilityGate({ ...input, connections: [{ id: "conn-a" }] })).toEqual({
      outcome: "deny",
      rule: "principal_mismatch",
    });
    expect((await capabilityGate({ ...input, connections: [{ id: "conn-b" }] })).outcome).toBe(
      "allow",
    );
  });

  it("requires a resource it cannot read to match, denying a resource-scoped grant", async () => {
    const scoped = grant({
      scope: "files.read",
      resource: { kind: "path", match: "/work" },
    });
    const { prisma } = setup([scoped]);
    const inside = classifyInputForTool({ name: "read_file", args: { path: "/work/a.txt" } });
    const outside = classifyInputForTool({ name: "read_file", args: { path: "/etc/passwd" } });
    const missing = classifyInputForTool({ name: "read_file", args: {} });
    const run = (call: typeof inside) =>
      capabilityGate({ ...base, prisma, bot: bot("enforce"), surface: "gate", call });
    expect((await run(inside)).outcome).toBe("allow");
    expect((await run(outside)).outcome).toBe("deny");
    expect((await run(missing)).outcome).toBe("deny");
  });
});
