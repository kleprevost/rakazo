import { randomUUID } from "node:crypto";
import type {
  AdapterContext,
  ConnectorCall,
  ConnectorEvent,
  ConnectorProvider,
} from "@rakazo/adapter-kit";
import {
  BrokeredConnector,
  ConnectorRegistry,
  capabilityGate,
  classifyInputForCall,
  reconcileManagedConnection,
  setActivePolicy,
} from "@rakazo/adapters";
import type { Actor } from "@rakazo/contracts";
import { CAPABILITY_DENIED_MESSAGE } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import {
  asSystem,
  createDb,
  findModelCredentialById,
  installAuditEventStore,
  installSecurityEventStore,
  runAsSystem,
  runAsTenant,
} from "@rakazo/db";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  revokeCapabilityGrant,
  setCapabilityGrant,
  setCapabilityMode,
} from "./capability-grants.js";

const databaseUrl = process.env.DATABASE_URL;
const enabled = process.env.VERIFY_DATABASE === "1" && Boolean(databaseUrl);

const NAMES = ["ann", "ben", "admin"] as const;
type Name = (typeof NAMES)[number];

/** Answers every call, and records which connected account served it. */
class CalendarConnector implements ConnectorProvider {
  served: Array<{ tool: string; connectionId: string | undefined }> = [];

  describe() {
    return {
      id: "composio",
      contractVersion: "1",
      adapterVersion: "1",
      capabilities: { discover: false, oauth: false, secretsBrokered: false },
    };
  }

  async discoverTools() {
    return [];
  }

  async *execute(call: ConnectorCall, context: AdapterContext): AsyncIterable<ConnectorEvent> {
    this.served.push({ tool: call.tool, connectionId: context.connectedConnections?.[0]?.id });
    yield { type: "result", data: { ok: true } };
  }
}

/**
 * Release gate for the capability broker: two people share one employee, each through an
 * instance of their own, and each delegates calendar.read only. Credential resolution follows
 * the acting requester, writes and sends are refused, and a revoked grant ends access at once.
 */
describe.skipIf(!enabled)("capability broker release gate (PostgreSQL, runtime role)", () => {
  const suffix = randomUUID().slice(0, 8);
  const organizationId = `cb-org-${suffix}`;
  let prisma: PrismaClient;
  let system: PrismaClient;
  let close: () => Promise<void>;
  const actors = {} as Record<Name, Actor>;
  const botIds = {} as Record<Name, string>;
  const inner = new CalendarConnector();
  let connector: BrokeredConnector;

  const deps = () =>
    ({
      prisma,
      env: { adminEmails: [actors.admin.email], ssoAdminEnabled: false },
      auth: { isSsoAdmin: () => false },
    }) as never;
  const as = <T>(name: Name, fn: (actor: Actor) => Promise<T>) =>
    runAsTenant(actors[name], () => fn(actors[name]));
  const connectionOf = (name: Name) => `cb-conn-${name}-${suffix}`;

  const context = (name: Name, connections: Name[] = [name]): AdapterContext => ({
    operationId: "op",
    traceId: "op",
    spaceId: actors[name].spaceId,
    userId: actors[name].userId,
    botId: botIds[name],
    signal: new AbortController().signal,
    connectedConnections: connections.map((owner) => ({
      id: connectionOf(owner),
      connectorId: "composio",
      externalId: "calendar",
      displayName: "Calendar",
    })),
  });

  /** One routine-style call by `name`'s bot; `via` names the connection the call selects. */
  async function call(name: Name, tool: string, via: Name = name) {
    const before = inner.served.length;
    const events: ConnectorEvent[] = [];
    await runAsSystem("release gate call", async () => {
      for await (const event of connector.execute(
        {
          tool,
          args: { title: "SECRET" },
          executionId: randomUUID(),
          route: { connectorId: "composio", toolName: tool, connectionId: connectionOf(via) },
        },
        // The run's connected accounts are the acting user's own, whatever the call names.
        context(name),
      )) {
        events.push(event);
      }
    });
    const refused = events.find((event) => event.type === "error");
    return {
      served: inner.served.length > before,
      error: refused?.type === "error" ? refused.message : undefined,
    };
  }

  async function denials() {
    const events = await system.securityEvent.findMany({
      where: { type: "capability.denied" },
      orderBy: { createdAt: "asc" },
    });
    return events.map((event) => event.metadata as Record<string, unknown>);
  }

  const grantRead = (name: Name) =>
    as(name, (actor) =>
      setCapabilityGrant(deps(), actor, {
        botId: botIds[name],
        scope: "calendar.read",
        effect: "allow",
      } as never),
    );

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
    connector = new BrokeredConnector(new ConnectorRegistry([inner]), prisma);
    await system.organization.create({
      data: { id: organizationId, name: "Broker", slug: organizationId, createdAt: new Date() },
    });
    for (const name of NAMES) {
      const id = `cb-${name}-${suffix}`;
      const spaceId = `cb-space-${name}-${suffix}`;
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
      botIds[name] = `cb-bot-${name}-${suffix}`;
      await system.bot.create({
        data: { id: botIds[name], spaceId, userId: id, name: `${name} bot`, color: "#000" },
      });
    }
    const employee = await system.employee.create({
      data: { name: "Scheduler", createdByUserId: actors.admin.userId },
    });
    for (const name of ["ann", "ben"] as const) {
      await system.bot.update({ where: { id: botIds[name] }, data: { employeeId: employee.id } });
      await system.employeeEntitlement.create({
        data: {
          employeeId: employee.id,
          userId: actors[name].userId,
          role: "collaborator",
          source: "grant",
        },
      });
    }
    for (const name of ["ann", "ben"] as const) {
      await as("admin", (actor) =>
        setCapabilityMode(deps(), actor, { botId: botIds[name], mode: "enforce" }),
      );
    }
  });

  afterEach(async () => {
    setActivePolicy(undefined);
    inner.served.length = 0;
    await system.securityEvent.deleteMany({
      where: { userId: { in: NAMES.map((name) => `cb-${name}-${suffix}`) } },
    });
    await system.capabilityGrant.deleteMany({ where: { botId: { in: Object.values(botIds) } } });
  });

  afterAll(async () => {
    if (system) {
      await system.auditEvent.deleteMany({ where: { organizationId } });
      await system.securityEvent.deleteMany({
        where: { userId: { in: NAMES.map((name) => `cb-${name}-${suffix}`) } },
      });
      await system.employee.deleteMany({ where: { createdByUserId: { startsWith: "cb-" } } });
      await system.organization.deleteMany({ where: { id: organizationId } });
      await system.user.deleteMany({
        where: { id: { startsWith: "cb-" }, email: { endsWith: "@rakazo.test" } },
      });
    }
    await close?.();
  });

  const mappings = () =>
    setActivePolicy({
      version: 1,
      capabilities: {
        mappings: [
          {
            match: { source: "connector", app: "calendar", tool: "list_*" },
            scopes: ["calendar.read"],
          },
          {
            match: { source: "connector", app: "calendar", tool: "create_*" },
            scopes: ["calendar.write"],
          },
          {
            match: { source: "connector", app: "calendar", tool: "send_*" },
            scopes: ["mail.send"],
          },
        ],
      },
    });

  it("lets each user read through their own connection, and refuses writes, sends and the other user's connection", async () => {
    mappings();
    await grantRead("ann");
    await grantRead("ben");

    expect(await call("ann", "list_events")).toEqual({ served: true, error: undefined });
    expect(await call("ben", "list_events")).toEqual({ served: true, error: undefined });
    // Each read was served by the acting user's own connected account.
    expect(inner.served.map((s) => s.connectionId)).toEqual([
      connectionOf("ann"),
      connectionOf("ben"),
    ]);

    for (const name of ["ann", "ben"] as const) {
      for (const tool of ["create_event", "send_invite"]) {
        expect(await call(name, tool), `${name} ${tool}`).toEqual({
          served: false,
          error: CAPABILITY_DENIED_MESSAGE,
        });
      }
    }
    // A call that selects the other user's connection is refused, even for a permitted read.
    expect(await call("ann", "list_events", "ben")).toEqual({
      served: false,
      error: CAPABILITY_DENIED_MESSAGE,
    });
    expect(await call("ben", "list_events", "ann")).toEqual({
      served: false,
      error: CAPABILITY_DENIED_MESSAGE,
    });
    expect(inner.served).toHaveLength(2);

    const events = await denials();
    expect(events.map((event) => event.rule)).toEqual([
      "no_grant",
      "no_grant",
      "no_grant",
      "no_grant",
      "principal_mismatch",
      "principal_mismatch",
    ]);
    expect(events.map((event) => event.scopes)).toEqual([
      "calendar.write",
      "mail.send",
      "calendar.write",
      "mail.send",
      // The other user's account is not among the requester's, so the app is not even identified.
      "ext.composio.admin",
      "ext.composio.admin",
    ]);
    // Scope and rule only: nothing the call carried is recorded.
    expect(JSON.stringify(events)).not.toContain("SECRET");
  });

  it("denies the very next call after a grant is revoked, and only for that user", async () => {
    mappings();
    const ann = await grantRead("ann");
    await grantRead("ben");
    expect((await call("ann", "list_events")).served).toBe(true);

    await as("ann", (actor) => revokeCapabilityGrant(deps(), actor, { id: ann.id }));
    expect(await call("ann", "list_events")).toEqual({
      served: false,
      error: CAPABILITY_DENIED_MESSAGE,
    });
    expect((await call("ben", "list_events")).served).toBe(true);

    // The run path agrees: the check made at the instant before the effect refuses too.
    const verdict = await runAsSystem("release gate recheck", () =>
      capabilityGate({
        prisma,
        bot: { id: botIds.ann, name: "ann bot", employeeId: null, capabilityMode: "enforce" },
        spaceId: actors.ann.spaceId,
        userId: actors.ann.userId,
        surface: "recheck",
        call: classifyInputForCall({
          name: "list_events",
          args: {},
          route: { connectorId: "composio", toolName: "list_events" },
          appSlug: "calendar",
        }),
      }),
    );
    expect(verdict).toEqual({ outcome: "deny", rule: "no_grant" });
  });

  it("denies a run started by one user that names the other user's connection", async () => {
    mappings();
    await grantRead("ann");
    const verdict = await runAsSystem("release gate gate", () =>
      capabilityGate({
        prisma,
        bot: { id: botIds.ann, name: "ann bot", employeeId: null, capabilityMode: "enforce" },
        spaceId: actors.ann.spaceId,
        userId: actors.ann.userId,
        surface: "gate",
        connections: [{ id: connectionOf("ann") }],
        call: classifyInputForCall({
          name: "list_events",
          args: {},
          route: {
            connectorId: "composio",
            toolName: "list_events",
            connectionId: connectionOf("ben"),
          },
          appSlug: "calendar",
        }),
      }),
    );
    expect(verdict).toEqual({ outcome: "deny", rule: "principal_mismatch" });
  });

  it("refuses another user's credential at the lookup itself, with the gate out of the way", async () => {
    const annSpace = actors.ann.spaceId;
    const benConnection = `cb-forged-conn-${suffix}`;
    const annConnection = `cb-own-conn-${suffix}`;
    const benModel = `cb-forged-model-${suffix}`;
    const annModel = `cb-own-model-${suffix}`;
    // Ben's rows sit in Ann's Space: only the owner check stands between Ann's run and them.
    await system.connection.createMany({
      data: [
        {
          id: benConnection,
          spaceId: annSpace,
          userId: actors.ben.userId,
          provider: "calendar",
          displayName: "Calendar",
          status: "connected",
        },
        {
          id: annConnection,
          spaceId: annSpace,
          userId: actors.ann.userId,
          provider: "calendar",
          displayName: "Calendar",
          status: "connected",
        },
      ],
    });
    await system.userModelCredential.createMany({
      data: [
        { id: benModel, userId: actors.ben.userId, provider: "openai", label: "b", secretId: "s1" },
        { id: annModel, userId: actors.ann.userId, provider: "openai", label: "a", secretId: "s2" },
      ],
    });
    try {
      const run = { spaceId: annSpace, userId: actors.ann.userId };
      const ctx = context("ann");
      // Gate bypassed: the lookups are called directly as Ann's run, naming Ben's ids.
      const outcome = await as("ann", async () => ({
        forgedConnection: await reconcileManagedConnection(
          prisma,
          undefined,
          run,
          ctx,
          benConnection,
        ),
        ownConnection: await reconcileManagedConnection(prisma, undefined, run, ctx, annConnection),
        ownModel: await findModelCredentialById(prisma, run, annModel),
      }));
      // Row security already hides Ben's row from Ann's session; as the system the owner check
      // alone has to refuse it.
      const forgedModel = await runAsSystem("release gate model lookup", () =>
        findModelCredentialById(prisma, run, benModel),
      );
      expect(outcome.forgedConnection).toBe("missing");
      expect(outcome.ownConnection).toBe("connected");
      expect(forgedModel).toBeNull();
      expect(outcome.ownModel?.id).toBe(annModel);

      expect(await denials()).toEqual([
        expect.objectContaining({
          rule: "principal_mismatch",
          surface: "credential",
          kind: "connection",
          resourceId: benConnection,
        }),
        expect.objectContaining({
          rule: "principal_mismatch",
          surface: "credential",
          kind: "model_connection",
          resourceId: benModel,
        }),
      ]);
    } finally {
      await system.connection.deleteMany({ where: { id: { in: [benConnection, annConnection] } } });
      await system.userModelCredential.deleteMany({ where: { id: { in: [benModel, annModel] } } });
    }
  });
});
