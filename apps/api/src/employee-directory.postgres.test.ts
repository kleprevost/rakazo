import { randomUUID } from "node:crypto";
import type { Actor } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import {
  asSystem,
  createDb,
  createRepos,
  installSecurityEventStore,
  runAsTenant,
} from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { decideRequest, listDirectory, listRequests, requestAccess } from "./employee-directory.js";
import { addInstance } from "./employee-instances.js";
import { setGrant, shareBot } from "./employees.js";

const databaseUrl = process.env.DATABASE_URL;
const enabled = process.env.VERIFY_DATABASE === "1" && Boolean(databaseUrl);

const NAMES = ["owner", "manager", "collab", "viewer", "outsider", "second", "hidden"] as const;
type Name = (typeof NAMES)[number];

describe.skipIf(!enabled)(
  "employee directory and access requests (PostgreSQL, runtime role)",
  () => {
    const suffix = randomUUID().slice(0, 8);
    const organizationId = `emp6-org-${suffix}`;
    let prisma: PrismaClient;
    let system: PrismaClient;
    let close: () => Promise<void>;
    let listedId: string;
    let unlistedId: string;
    let flagOn = true;
    const actors = {} as Record<Name, Actor>;
    const botIds = {} as Record<Name, string>;

    const deps = () => ({ prisma, env: { sharedEmployeesEnabled: flagOn } as never });
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
    const directory = (name: Name) => as(name, (actor) => listDirectory(deps(), actor));
    const request = (name: Name, employeeId = listedId) =>
      as(name, (actor) => requestAccess(deps(), actor, { employeeId }));
    const pending = (name: Name, employeeId = listedId) =>
      as(name, (actor) => listRequests(deps(), actor, { employeeId }));
    const requestIdOf = async (name: Name) =>
      (
        await system.employeeAccessRequest.findFirstOrThrow({
          where: { employeeId: listedId, requesterUserId: actors[name].userId, status: "pending" },
        })
      ).id;
    const decide = async (by: Name, of: Name, decision: "approve" | "deny") =>
      as(by, async (actor) =>
        decideRequest(deps(), actor, {
          employeeId: listedId,
          requestId: await requestIdOf(of),
          decision,
        }),
      );

    beforeAll(async () => {
      const db = createDb(databaseUrl!);
      prisma = db.prisma;
      system = asSystem(prisma);
      installSecurityEventStore(prisma);
      close = async () => {
        installSecurityEventStore(undefined);
        await prisma.$disconnect();
        await db.pool.end();
      };
      await system.organization.create({
        data: {
          id: organizationId,
          name: "Directory",
          slug: organizationId,
          createdAt: new Date(),
        },
      });
      for (const name of NAMES) {
        const id = `emp6-${name}-${suffix}`;
        const spaceId = `emp6-space-${name}-${suffix}`;
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
        actors[name] = {
          userId: id,
          spaceId,
          email: `${id}@rakazo.test`,
          isDeploymentOwner: false,
        };
        botIds[name] = `emp6-bot-${name}-${suffix}`;
        await system.bot.create({
          data: {
            id: botIds[name],
            spaceId,
            userId: id,
            name: `${name} bot`,
            description: "Answers invoices",
            instructions: `Private instructions of ${name}`,
            color: "#000",
          },
        });
      }
      listedId = (await as("owner", (actor) => shareBot(deps(), actor, { botId: botIds.owner })))
        .employeeId;
      unlistedId = (
        await as("hidden", (actor) => shareBot(deps(), actor, { botId: botIds.hidden }))
      ).employeeId;
      await system.employee.update({ where: { id: listedId }, data: { listing: "listed" } });
      await as("owner", (actor) =>
        setGrant(deps(), actor, {
          employeeId: listedId,
          subjectKind: "user",
          subjectValue: actors.manager.userId,
          role: "manager",
        }),
      );
      await as("owner", (actor) =>
        setGrant(deps(), actor, {
          employeeId: listedId,
          subjectKind: "user",
          subjectValue: actors.collab.userId,
          role: "collaborator",
        }),
      );
      await as("owner", (actor) =>
        setGrant(deps(), actor, {
          employeeId: listedId,
          subjectKind: "user",
          subjectValue: actors.viewer.userId,
          role: "viewer",
        }),
      );
    });

    afterAll(async () => {
      if (system) {
        await system.securityEvent.deleteMany({
          where: { userId: { in: NAMES.map((name) => `emp6-${name}-${suffix}`) } },
        });
        await system.employee.deleteMany({ where: { createdByUserId: { startsWith: "emp6-" } } });
        await system.organization.deleteMany({ where: { id: organizationId } });
        await system.user.deleteMany({
          where: { id: { startsWith: "emp6-" }, email: { endsWith: "@rakazo.test" } },
        });
      }
      await close?.();
    });

    it("shows a stranger only listed employees, and never an unlisted one", async () => {
      const seen = await directory("outsider");
      expect(seen).toEqual([
        {
          id: listedId,
          name: "owner bot",
          description: "Answers invoices",
          ownerName: "owner",
          role: null,
          canUse: false,
          requested: false,
        },
      ]);
      // The unlisted employee's own owner still sees it, with their role, next to the listed one.
      expect((await directory("hidden")).map((entry) => [entry.id, entry.role]).sort()).toEqual(
        [
          [listedId, null],
          [unlistedId, "owner"],
        ].sort(),
      );
    });

    it("shows entitled people their role and whether they can add it", async () => {
      const byName = async (name: Name) => (await directory(name)).find((e) => e.id === listedId);
      expect(await byName("collab")).toMatchObject({ role: "collaborator", canUse: true });
      expect(await byName("viewer")).toMatchObject({ role: "viewer", canUse: false });
      expect(await byName("owner")).toMatchObject({ role: "owner", canUse: true });
    });

    it("hides retired and draft employees from the directory", async () => {
      await system.employee.update({ where: { id: listedId }, data: { status: "retired" } });
      expect(await directory("outsider")).toEqual([]);
      expect(await directory("collab")).toEqual([]);
      await system.employee.update({ where: { id: listedId }, data: { status: "published" } });
      await system.employee.update({ where: { id: listedId }, data: { suspendedAt: new Date() } });
      expect(await directory("outsider")).toEqual([]);
      await system.employee.update({ where: { id: listedId }, data: { suspendedAt: null } });
    });

    it("refuses everything when the feature is off", async () => {
      flagOn = false;
      try {
        expect(await code(directory("outsider"))).toBe("FORBIDDEN");
        expect(await code(request("outsider"))).toBe("FORBIDDEN");
        expect(await code(pending("owner"))).toBe("FORBIDDEN");
      } finally {
        flagOn = true;
      }
      expect(await system.employeeAccessRequest.count({ where: { employeeId: listedId } })).toBe(0);
    });

    it("answers an unlisted or unknown employee as not found", async () => {
      expect(await code(request("outsider", unlistedId))).toBe("NOT_FOUND");
      expect(await code(request("outsider", "missing-employee"))).toBe("NOT_FOUND");
    });

    it("refuses a request from someone who already has access", async () => {
      expect(await code(request("viewer"))).toBe("CONFLICT");
      expect(await code(request("collab"))).toBe("CONFLICT");
    });

    it("opens one request per person and repeating it changes nothing", async () => {
      await request("outsider");
      await request("outsider");
      await request("second");
      expect(
        await system.employeeAccessRequest.count({
          where: { employeeId: listedId, requesterUserId: actors.outsider.userId },
        }),
      ).toBe(1);
      expect((await directory("outsider"))[0]).toMatchObject({ requested: true, role: null });
      const events = await system.securityEvent.findMany({
        where: { type: "employee.access_requested", userId: actors.outsider.userId },
      });
      expect(events).toHaveLength(1);
      expect(Object.keys(events[0]!.metadata as object).sort()).toEqual([
        "employeeId",
        "requestId",
      ]);
    });

    it("lets only Owners and Managers see and decide requests", async () => {
      expect((await pending("owner")).map((r) => r.requesterName).sort()).toEqual([
        "outsider",
        "second",
      ]);
      expect((await pending("manager")).length).toBe(2);
      expect(await code(pending("collab"))).toBe("FORBIDDEN");
      expect(await code(pending("viewer"))).toBe("FORBIDDEN");
      expect(await code(pending("outsider"))).toBe("NOT_FOUND");
      expect(await code(decide("collab", "outsider", "approve"))).toBe("FORBIDDEN");
      expect(await code(decide("outsider", "second", "approve"))).toBe("NOT_FOUND");
      expect(await code(decide("outsider", "outsider", "approve"))).toBe("NOT_FOUND");
      expect(
        await system.employeeEntitlement.count({ where: { userId: actors.outsider.userId } }),
      ).toBe(0);
    });

    it("scopes request rows by row-level security", async () => {
      const rows = (name: Name) =>
        as(name, () => prisma.employeeAccessRequest.findMany({ where: { employeeId: listedId } }));
      expect((await rows("outsider")).map((r) => r.requesterUserId)).toEqual([
        actors.outsider.userId,
      ]);
      expect(await rows("collab")).toEqual([]);
      expect(await rows("viewer")).toEqual([]);
      expect((await rows("manager")).length).toBe(2);
      // The runtime role cannot write them directly.
      const forged = await as("outsider", () =>
        prisma.employeeAccessRequest.updateMany({
          where: { requesterUserId: actors.outsider.userId },
          data: { status: "approved" },
        }),
      );
      expect(forged.count).toBe(0);
      expect(
        await code(
          as("outsider", () =>
            prisma.employeeAccessRequest.create({
              data: { employeeId: unlistedId, requesterUserId: actors.outsider.userId },
            }),
          ),
        ),
      ).not.toBe("ok");
      expect(
        (
          await system.employeeAccessRequest.findFirstOrThrow({
            where: { id: await requestIdOf("outsider") },
          })
        ).status,
      ).toBe("pending");
    });

    it("approval by a Manager grants access, reconciles entitlements and allows adding an instance", async () => {
      await decide("manager", "outsider", "approve");
      expect(
        await system.employeeEntitlement.findMany({
          where: { employeeId: listedId, userId: actors.outsider.userId },
          select: { role: true, source: true },
        }),
      ).toEqual([{ role: "collaborator", source: "grant" }]);
      expect((await directory("outsider"))[0]).toMatchObject({
        role: "collaborator",
        canUse: true,
        requested: false,
      });

      const added = await as("outsider", (actor) =>
        addInstance(deps(), createRepos(prisma, {}), actor, { employeeId: listedId }),
      );
      expect(added.created).toBe(true);
      const bot = await system.bot.findUniqueOrThrow({ where: { id: added.botId } });
      expect(bot).toMatchObject({ employeeId: listedId, userId: actors.outsider.userId });

      const closed = await system.employeeAccessRequest.findFirstOrThrow({
        where: { employeeId: listedId, requesterUserId: actors.outsider.userId },
      });
      expect(closed).toMatchObject({ status: "approved", decidedBy: actors.manager.userId });
      const event = await system.securityEvent.findFirstOrThrow({
        where: { type: "employee.access_decided", userId: actors.manager.userId },
      });
      expect(event.metadata).toEqual({
        employeeId: listedId,
        requestId: closed.id,
        requesterId: actors.outsider.userId,
        decision: "approve",
      });
    });

    it("denial closes the request without any access, and the person may ask again", async () => {
      await decide("owner", "second", "deny");
      expect(
        await system.employeeEntitlement.count({ where: { userId: actors.second.userId } }),
      ).toBe(0);
      expect(
        await code(
          as("second", (actor) =>
            addInstance(deps(), createRepos(prisma, {}), actor, { employeeId: listedId }),
          ),
        ),
      ).toBe("NOT_FOUND");
      expect((await directory("second"))[0]).toMatchObject({ role: null, requested: false });
      expect(await pending("owner")).toEqual([]);
      await request("second");
      expect(await pending("owner")).toHaveLength(1);
    });

    it("refuses to decide a request twice", async () => {
      const id = await requestIdOf("second");
      await decide("manager", "second", "deny");
      const again = as("manager", (actor) =>
        decideRequest(deps(), actor, { employeeId: listedId, requestId: id, decision: "approve" }),
      );
      expect(await code(again)).toBe("CONFLICT");
      expect(
        await system.employeeEntitlement.count({ where: { userId: actors.second.userId } }),
      ).toBe(0);
    });

    it("never lowers a role the person already holds when approving", async () => {
      await system.employeeAccessRequest.create({
        data: { employeeId: listedId, requesterUserId: actors.viewer.userId },
      });
      // A pending request from a Viewer (made before they were granted a role) must not demote a Manager-level person.
      await system.employeeGrant.update({
        where: {
          employeeId_subjectKind_subjectValue: {
            employeeId: listedId,
            subjectKind: "user",
            subjectValue: actors.viewer.userId,
          },
        },
        data: { role: "manager" },
      });
      await system.employeeEntitlement.updateMany({
        where: { employeeId: listedId, userId: actors.viewer.userId },
        data: { role: "manager" },
      });
      await decide("owner", "viewer", "approve");
      expect(
        (
          await system.employeeGrant.findFirstOrThrow({
            where: { employeeId: listedId, subjectValue: actors.viewer.userId },
          })
        ).role,
      ).toBe("manager");
    });
  },
);
