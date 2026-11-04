import { randomUUID } from "node:crypto";
import {
  botBlockedNow,
  classifyInputForTool,
  recordShadowDecision,
  setActivePolicy,
} from "@rakazo/adapters";
import type { Actor } from "@rakazo/contracts";
import { evaluateCall } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import {
  asSystem,
  createDb,
  installAuditEventStore,
  installSecurityEventStore,
  loadBotCapabilityGrants,
  runAsSystem,
  runAsTenant,
} from "@rakazo/db";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  listCapabilityGrants,
  revokeCapabilityGrant,
  setCapabilityGrant,
  setCapabilityMode,
} from "./capability-grants.js";

const databaseUrl = process.env.DATABASE_URL;
const enabled = process.env.VERIFY_DATABASE === "1" && Boolean(databaseUrl);

const NAMES = ["owner", "peer", "admin"] as const;
type Name = (typeof NAMES)[number];

describe.skipIf(!enabled)("capability grants (PostgreSQL, runtime role)", () => {
  const suffix = randomUUID().slice(0, 8);
  const organizationId = `cg-org-${suffix}`;
  let prisma: PrismaClient;
  let system: PrismaClient;
  let close: () => Promise<void>;
  let employeeId: string;
  const actors = {} as Record<Name, Actor>;
  const botIds = {} as Record<Name, string>;

  const deps = () =>
    ({
      prisma,
      env: { adminEmails: [actors.admin.email], ssoAdminEnabled: false },
      auth: { isSsoAdmin: () => false },
    }) as never;
  const as = <T>(name: Name, fn: (actor: Actor) => Promise<T>) =>
    runAsTenant(actors[name], () => fn(actors[name]));
  const code = async (promise: Promise<unknown>) => {
    try {
      await promise;
      return "ok";
    } catch (error) {
      return (error as { code?: string }).code ?? "error";
    }
  };
  const set = (name: Name, input: Record<string, unknown>) =>
    as(name, (actor) =>
      setCapabilityGrant(deps(), actor, {
        botId: botIds.owner,
        effect: "allow",
        ...input,
      } as never),
    );
  const list = (
    name: Name,
    target: { botId?: string; employeeId?: string } = { botId: botIds.owner },
  ) => as(name, (actor) => listCapabilityGrants(deps(), actor, target));
  const revoke = (name: Name, id: string) =>
    as(name, (actor) => revokeCapabilityGrant(deps(), actor, { id }));
  const rows = () => system.capabilityGrant.findMany({ where: { botId: botIds.owner } });

  beforeAll(async () => {
    const db = createDb(databaseUrl!);
    prisma = db.prisma;
    system = asSystem(prisma);
    installSecurityEventStore(prisma);
    installAuditEventStore(prisma);
    close = async () => {
      installSecurityEventStore(undefined);
      installAuditEventStore(undefined);
      await prisma.$disconnect();
      await db.pool.end();
    };
    await system.organization.create({
      data: { id: organizationId, name: "Grants", slug: organizationId, createdAt: new Date() },
    });
    for (const name of NAMES) {
      const id = `cg-${name}-${suffix}`;
      const spaceId = `cg-space-${name}-${suffix}`;
      await system.user.create({
        data: { id, name, email: `${id}@rakazo.test`, emailVerified: true },
      });
      const createdAt = new Date();
      await system.member.create({
        data: { id: `${id}-member`, organizationId, userId: id, role: "member", createdAt },
      });
      await system.space.create({
        data: { id: spaceId, organizationId, name, createdByUserId: id },
      });
      await system.spaceMember.create({
        data: { id: `${spaceId}-member`, spaceId, organizationId, userId: id, createdAt },
      });
      actors[name] = { userId: id, spaceId, email: `${id}@rakazo.test`, isDeploymentOwner: false };
      botIds[name] = `cg-bot-${name}-${suffix}`;
      await system.bot.create({
        data: { id: botIds[name], spaceId, userId: id, name: `${name} bot`, color: "#000" },
      });
    }
    const employee = await system.employee.create({
      data: { name: "Billing", createdByUserId: actors.admin.userId },
    });
    employeeId = employee.id;
    await system.bot.update({ where: { id: botIds.owner }, data: { employeeId } });
    await system.employeeEntitlement.create({
      data: { employeeId, userId: actors.owner.userId, role: "collaborator", source: "grant" },
    });
  });

  afterEach(async () => {
    setActivePolicy(undefined);
    await system.securityEvent.deleteMany({
      where: { userId: { in: NAMES.map((name) => `cg-${name}-${suffix}`) } },
    });
    await system.auditEvent.deleteMany({ where: { organizationId } });
    await system.capabilityGrant.deleteMany({
      where: { OR: [{ botId: { in: Object.values(botIds) } }, { employeeId }] },
    });
    await system.bot.update({ where: { id: botIds.owner }, data: { capabilityMode: null } });
  });

  afterAll(async () => {
    if (system) {
      await system.auditEvent.deleteMany({ where: { organizationId } });
      await system.securityEvent.deleteMany({
        where: { userId: { in: NAMES.map((name) => `cg-${name}-${suffix}`) } },
      });
      await system.employee.deleteMany({ where: { createdByUserId: { startsWith: "cg-" } } });
      await system.organization.deleteMany({ where: { id: organizationId } });
      await system.user.deleteMany({
        where: { id: { startsWith: "cg-" }, email: { endsWith: "@rakazo.test" } },
      });
    }
    await close?.();
  });

  it("lets a bot's owner grant a read scope, as a delegation of their own credentials", async () => {
    const grant = await set("owner", { scope: "calendar.read" });
    expect(grant).toMatchObject({
      kind: "delegation",
      scope: "calendar.read",
      effect: "allow",
      principalUserId: actors.owner.userId,
      createdVia: "owner",
      inherited: false,
    });
    expect((await list("owner")).grants.map((g) => g.id)).toEqual([grant.id]);
  });

  it("keeps non-read allows for an admin unless central policy lists the scope", async () => {
    for (const scope of ["mail.send", "files.write", "spend.purchase", "mail.*", "calendar.*"]) {
      expect(await code(set("owner", { scope })), scope).toBe("FORBIDDEN");
    }
    expect(await rows()).toHaveLength(0);
    setActivePolicy({ version: 1, capabilities: { ownerGrantable: ["files.write"] } });
    expect(await code(set("owner", { scope: "files.write" }))).toBe("ok");
    expect(await code(set("owner", { scope: "mail.send" }))).toBe("FORBIDDEN");
    setActivePolicy(undefined);
    const admin = await set("admin", { scope: "mail.send", kind: "bot" });
    expect(admin).toMatchObject({ kind: "bot", createdVia: "admin", principalUserId: null });
  });

  it("always lets an owner restrict further, even on a scope they could not grant", async () => {
    expect(await code(set("owner", { scope: "mail.send", effect: "ask" }))).toBe("ok");
    expect(await code(set("owner", { scope: "files.delete", effect: "deny" }))).toBe("ok");
  });

  it("answers a stranger as if the bot did not exist, and keeps employee grants for admins", async () => {
    expect(await code(list("peer"))).toBe("NOT_FOUND");
    expect(await code(set("peer", { scope: "calendar.read" }))).toBe("NOT_FOUND");
    const grant = await set("owner", { scope: "calendar.read" });
    expect(await code(revoke("peer", grant.id))).toBe("NOT_FOUND");
    expect(
      await code(
        as("owner", (a) =>
          setCapabilityGrant(deps(), a, { employeeId, scope: "calendar.read", effect: "allow" }),
        ),
      ),
    ).toBe("FORBIDDEN");
    expect(await code(list("owner", { employeeId }))).toBe("FORBIDDEN");
    expect(await rows()).toHaveLength(1);
  });

  it("lets an admin set bot grants on any bot but never delegate someone else's credentials", async () => {
    expect(await code(set("admin", { scope: "calendar.read", kind: "delegation" }))).toBe(
      "FORBIDDEN",
    );
    expect(await code(set("admin", { scope: "calendar.read" }))).toBe("ok");
    const [row] = await rows();
    expect(row).toMatchObject({ kind: "bot", createdVia: "admin", principalUserId: null });
  });

  it("attaches a grant to an employee and every instance inherits it", async () => {
    const grant = await as("admin", (a) =>
      setCapabilityGrant(deps(), a, { employeeId, scope: "tickets.write", effect: "allow" }),
    );
    expect(grant).toMatchObject({ kind: "bot", createdVia: "admin" });
    const own = await list("owner");
    expect(own.grants).toEqual([expect.objectContaining({ id: grant.id, inherited: true })]);
    expect((await list("admin", { employeeId })).grants).toHaveLength(1);
    const loaded = await runAsSystem("test", () =>
      loadBotCapabilityGrants(prisma, { id: botIds.owner, employeeId }),
    );
    expect(loaded.map((g) => g.id)).toEqual([grant.id]);
    // The same row does not reach a bot that is not an instance of the employee.
    const other = await runAsSystem("test", () =>
      loadBotCapabilityGrants(prisma, { id: botIds.peer, employeeId: null }),
    );
    expect(other).toEqual([]);
    expect(
      await system.capabilityGrant.count({ where: { employeeId, botId: null, spaceId: null } }),
    ).toBe(1);
  });

  it("holds an allow to the organization's ceiling and deny list, but not a restriction", async () => {
    setActivePolicy({
      version: 1,
      capabilities: { ceiling: ["calendar.read", "tickets.*"], deny: ["tickets.delete"] },
    });
    expect(await code(set("admin", { scope: "calendar.read" }))).toBe("ok");
    expect(await code(set("admin", { scope: "mail.read" }))).toBe("BAD_REQUEST");
    expect(await code(set("admin", { scope: "tickets.delete" }))).toBe("BAD_REQUEST");
    expect(await code(set("admin", { scope: "mail.send", effect: "deny" }))).toBe("ok");
  });

  it("rejects an expiry in the past, ignores an expired grant, and moves the expiry of a repeat", async () => {
    expect(
      await code(
        set("owner", {
          scope: "ext.cal.read",
          expiresAt: new Date(Date.now() - 1000).toISOString(),
        }),
      ),
    ).toBe("BAD_REQUEST");
    const soon = new Date(Date.now() + 3_600_000).toISOString();
    const first = await set("owner", { scope: "ext.cal.read", expiresAt: soon });
    const later = new Date(Date.now() + 7_200_000).toISOString();
    const again = await set("owner", { scope: "ext.cal.read", expiresAt: later });
    expect(again.id).toBe(first.id);
    expect(again.expiresAt).toBe(later);
    expect(await rows()).toHaveLength(1);
    // Once it lapses the evaluator does not honor it, though the row is still read.
    const [granted] = await runAsSystem("test", () =>
      loadBotCapabilityGrants(prisma, { id: botIds.owner, employeeId: null }),
    );
    const decide = (now: Date) =>
      evaluateCall(
        { now, principal: { actingUserId: actors.owner.userId }, grants: granted ? [granted] : [] },
        { source: "mcp", tool: "list", slug: "cal", annotations: { readOnlyHint: true } },
        { kind: "personal", userId: actors.owner.userId },
      );
    expect(decide(new Date()).outcome).toBe("allow");
    expect(decide(new Date(Date.now() + 3 * 3_600_000))).toMatchObject({ outcome: "deny" });
  });

  it("revokes idempotently, hides revoked rows, and keeps an admin's restriction from the owner", async () => {
    const grant = await set("owner", { scope: "calendar.read" });
    await revoke("owner", grant.id);
    await revoke("owner", grant.id);
    expect((await list("owner")).grants).toEqual([]);
    const [kept] = await rows();
    expect(kept?.revokedAt).toBeInstanceOf(Date);
    expect(kept?.revokedReason).toMatch(/^owner:/);
    expect(
      await runAsSystem("test", () =>
        loadBotCapabilityGrants(prisma, { id: botIds.owner, employeeId: null }),
      ),
    ).toEqual([]);

    const deny = await set("admin", { scope: "mail.send", effect: "deny" });
    expect(await code(revoke("owner", deny.id))).toBe("FORBIDDEN");
    expect(await code(revoke("admin", deny.id))).toBe("ok");
    expect(await code(revoke("owner", "missing"))).toBe("NOT_FOUND");
    expect(
      await system.capabilityGrant.count({ where: { botId: botIds.owner, revokedAt: null } }),
    ).toBe(0);
  });

  it("limits the shadow switch to admins and shows it on the bot", async () => {
    const input = { botId: botIds.owner, mode: "shadow" as const };
    expect(await code(as("owner", (a) => setCapabilityMode(deps(), a, input)))).toBe("FORBIDDEN");
    await as("admin", (a) => setCapabilityMode(deps(), a, input));
    expect((await list("owner")).mode).toBe("shadow");
    expect(
      (await runAsSystem("test", () => botBlockedNow(prisma, botIds.owner))).capabilityMode,
    ).toBe("shadow");
    await as("admin", (a) => setCapabilityMode(deps(), a, { ...input, mode: null }));
    expect((await list("owner")).mode).toBeNull();
  });

  it("records security events for changes, without the resource", async () => {
    await set("owner", { scope: "docs.read", resource: { kind: "path", match: "/private/notes" } });
    const events = await system.securityEvent.findMany({
      where: { userId: actors.owner.userId, type: "capability.grant_set" },
    });
    expect(events).toHaveLength(1);
    expect(JSON.stringify(events[0]?.metadata)).not.toContain("/private/notes");
  });

  it("enforces the table's checks and row-level security", async () => {
    const base = {
      scope: "calendar.read",
      createdByUserId: actors.admin.userId,
      createdVia: "admin",
    };
    // An employee row cannot be a delegation, a bot row needs its Space, a delegation needs a principal.
    const bad = [
      { ...base, employeeId, kind: "delegation", principalUserId: actors.owner.userId },
      { ...base, botId: botIds.owner, kind: "bot" },
      { ...base, botId: botIds.owner, spaceId: actors.owner.spaceId, kind: "delegation" },
      { ...base, botId: botIds.owner, spaceId: actors.owner.spaceId, kind: "bot", effect: "maybe" },
    ];
    for (const data of bad) {
      expect(await code(system.capabilityGrant.create({ data })), JSON.stringify(data)).not.toBe(
        "ok",
      );
    }
    await set("owner", { scope: "calendar.read" });
    await as("admin", (a) =>
      setCapabilityGrant(deps(), a, { employeeId, scope: "tickets.read", effect: "allow" }),
    );
    // Another Space sees neither the bot's rows nor an employee's it is not entitled to.
    const peerSees = await as("peer", () => prisma.capabilityGrant.findMany());
    expect(peerSees).toEqual([]);
    // The owner sees their bot's rows and the employee's they are entitled to, and cannot write the latter.
    const ownerSees = await as("owner", () => prisma.capabilityGrant.findMany());
    expect(ownerSees.map((row) => row.scope).sort()).toEqual(["calendar.read", "tickets.read"]);
    expect(
      await code(
        as("owner", () =>
          prisma.capabilityGrant.updateMany({
            where: { employeeId },
            data: { scope: "tickets.write" },
          }),
        ),
      ),
    ).toBe("ok");
    expect(
      await system.capabilityGrant.count({ where: { employeeId, scope: "tickets.write" } }),
    ).toBe(0);
    expect(
      await code(
        as("peer", () =>
          prisma.capabilityGrant.create({
            data: { ...base, botId: botIds.owner, spaceId: actors.owner.spaceId, kind: "bot" },
          }),
        ),
      ),
    ).not.toBe("ok");
  });

  it("records one shadow audit event per decision in the organization's log, with the rule trace and no arguments", async () => {
    await as("admin", (a) => setCapabilityMode(deps(), a, { botId: botIds.owner, mode: "shadow" }));
    await set("owner", { scope: "web.fetch" });
    const bot = { id: botIds.owner, name: "owner bot", employeeId, capabilityMode: "shadow" };
    const common = {
      prisma,
      bot,
      spaceId: actors.owner.spaceId,
      userId: actors.owner.userId,
      runId: `run-${suffix}`,
      surface: "gate" as const,
    };
    await as("owner", async () => {
      await recordShadowDecision({
        ...common,
        call: classifyInputForTool({
          name: "web_fetch",
          args: { url: "https://x.example/SECRET" },
        }),
      });
      await recordShadowDecision({
        ...common,
        call: classifyInputForTool({
          name: "write_file",
          args: { path: "/SECRET", content: "SECRET" },
        }),
      });
      await recordShadowDecision({
        ...common,
        call: classifyInputForTool({
          name: "mcp__cal__create_event",
          args: { title: "SECRET" },
          route: {
            connectorId: "mcp",
            toolName: "create_event",
            resourceId: "srv",
            catalogGroup: "cal",
          },
          tool: { readOnly: false },
        }),
      });
    });
    const events = await system.auditEvent.findMany({
      where: { organizationId, action: "capability.shadow" },
      orderBy: { createdAt: "asc" },
    });
    expect(events.map((e) => (e.metadata as Record<string, unknown>).decision)).toEqual([
      "allow",
      "deny",
      "deny",
    ]);
    expect(events.map((e) => e.targetId)).toEqual(["web_fetch", "write_file", "create_event"]);
    expect(events[1]?.metadata).toMatchObject({
      rule: "no_grant",
      scopes: "files.write",
      surface: "gate",
    });
    expect(events[2]?.metadata).toMatchObject({ scopes: "ext.cal.write", source: "mcp" });
    expect(JSON.stringify(events.map((e) => e.metadata))).not.toContain("SECRET");
  });
});
