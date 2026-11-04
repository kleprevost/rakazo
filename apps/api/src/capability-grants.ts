import { ORPCError } from "@orpc/server";
import { activePolicy } from "@rakazo/adapters";
import type {
  Actor,
  CapabilityGrantView,
  CapabilityMode,
  CapabilityResource,
} from "@rakazo/contracts";
import {
  CAPABILITY_DOMAIN_VERBS,
  CAPABILITY_READ_VERBS,
  CapabilityResourceSchema,
  capabilityScopeCovers,
} from "@rakazo/contracts";
import type { Prisma } from "@rakazo/db";
import { recordSecurityEvent, runAsSystem } from "@rakazo/db";
import { hasAdminRole, requireAdminRole } from "./admins.js";
import type { RouterDeps } from "./router.js";

/**
 * Persistent capability grants and the per-bot shadow switch. Who may write what follows the
 * broker design: a bot's owner grants read scopes, restricts further (ask, deny) and delegates
 * their own credentials; a write, send, spend or other non-read scope needs an admin unless
 * central policy lists it as owner-grantable; an employee's grants are an admin's. Writes run as
 * system after the checks, so a bot in another Space than the caller's active one is handled
 * the same way. The checks here are the only gate: a row that got in is trusted by the evaluator,
 * which re-checks the owner rule (`owner_not_permitted`) when it reads one.
 */

type Deps = Pick<RouterDeps, "prisma"> & {
  env: Pick<
    RouterDeps["env"],
    "adminEmails" | "ssoAdminEnabled" | "operatorEmails" | "ssoOperatorRolesEnabled"
  >;
  auth: Pick<RouterDeps["auth"], "isSsoAdmin">;
};

export const system = <T>(what: string, fn: () => Promise<T>) =>
  runAsSystem(`capability grants: ${what}`, fn);

/** More than any bot needs; bounds the snapshot every shadow decision loads. */
const MAX_ACTIVE_GRANTS = 200;

type Target = { botId?: string | undefined; employeeId?: string | undefined };
type Row = Prisma.CapabilityGrantGetPayload<object>;

const notFound = () => new ORPCError("NOT_FOUND", { message: "AI employee not found" });

function view(row: Row, inherited: boolean): CapabilityGrantView {
  const resource = CapabilityResourceSchema.safeParse(row.resource);
  return {
    id: row.id,
    kind: row.kind === "delegation" ? "delegation" : "bot",
    scope: row.scope,
    resource: resource.success ? resource.data : null,
    effect: row.effect === "deny" ? "deny" : row.effect === "ask" ? "ask" : "allow",
    principalUserId: row.principalUserId,
    createdVia:
      row.createdVia === "admin" || row.createdVia === "policy" ? row.createdVia : "owner",
    createdByUserId: row.createdByUserId,
    expiresAt: row.expiresAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    inherited,
  };
}

/** Whether a scope only observes. A wildcard covers other verbs, so it never counts. */
function isReadScope(scope: string): boolean {
  const verb = scope.split(".").at(-1) ?? "";
  return verb !== "*" && CAPABILITY_READ_VERBS.includes(verb);
}

export async function loadBot(deps: Deps, botId: string) {
  const bot = await system("find bot", () =>
    deps.prisma.bot.findUnique({
      where: { id: botId },
      select: { id: true, spaceId: true, userId: true, employeeId: true },
    }),
  );
  if (!bot) throw notFound();
  return bot;
}

/** The caller's relation to the target. A stranger gets not found, so ids are not probed. */
export async function authorize(deps: Deps, actor: Actor, target: Target, readOnly = false) {
  const admin = await hasAdminRole(deps, actor.userId, "security");
  // An auditor reads any bot's or employee's grants but never changes them.
  const reader = admin || (readOnly && (await hasAdminRole(deps, actor.userId, "auditor")));
  if (target.employeeId !== undefined) {
    if (!reader) throw new ORPCError("FORBIDDEN", { message: "Admins only" });
    const employee = await system("find employee", () =>
      deps.prisma.employee.findUnique({ where: { id: target.employeeId }, select: { id: true } }),
    );
    if (!employee) throw new ORPCError("NOT_FOUND", { message: "Employee not found" });
    return { admin, owner: false, bot: null, employeeId: employee.id };
  }
  const bot = await loadBot(deps, target.botId ?? "");
  const owner = bot.userId === actor.userId;
  if (!owner && !reader) throw notFound();
  return { admin, owner, bot, employeeId: null };
}

/**
 * Why an allow for this scope may not be written by this author, or null when it may. Only an
 * allow widens access, so only an allow is held to the organization's limits.
 */
function allowProblem(scope: string, admin: boolean): "organization" | "administrator" | null {
  const org = activePolicy()?.capabilities;
  if (
    org?.deny?.some((pattern) => capabilityScopeCovers(pattern, scope)) ||
    (org?.ceiling && !org.ceiling.some((pattern) => capabilityScopeCovers(pattern, scope)))
  ) {
    return "organization";
  }
  const ownerMayGrant =
    isReadScope(scope) ||
    org?.ownerGrantable?.some((pattern) => capabilityScopeCovers(pattern, scope));
  return admin || ownerMayGrant ? null : "administrator";
}

const BUILTIN_SCOPES = Object.entries(CAPABILITY_DOMAIN_VERBS).flatMap(([domain, verbs]) =>
  verbs.map((verb) => `${domain}.${verb}`),
);

export async function listCapabilityGrants(
  deps: Deps,
  actor: Actor,
  target: Target,
): Promise<{
  mode: CapabilityMode | null;
  active: boolean;
  grants: CapabilityGrantView[];
  grantable: string[];
}> {
  const access = await authorize(deps, actor, target, true);
  const { bot } = access;
  const rows = await system("list", () =>
    deps.prisma.capabilityGrant.findMany({
      where: {
        revokedAt: null,
        OR: bot
          ? [{ botId: bot.id }, ...(bot.employeeId ? [{ employeeId: bot.employeeId }] : [])]
          : [{ employeeId: access.employeeId }],
      },
      orderBy: { createdAt: "asc" },
      take: MAX_ACTIVE_GRANTS * 2,
    }),
  );
  const mode = bot
    ? await system("read mode", () =>
        deps.prisma.bot.findUnique({ where: { id: bot.id }, select: { capabilityMode: true } }),
      )
    : null;
  const current =
    mode?.capabilityMode === "shadow" || mode?.capabilityMode === "enforce"
      ? mode.capabilityMode
      : null;
  return {
    mode: current,
    active: current !== null || activePolicy()?.capabilities?.requireGrants === true,
    grants: rows.map((row) => view(row, row.employeeId !== null && bot !== null)),
    grantable: BUILTIN_SCOPES.filter((scope) => allowProblem(scope, access.admin) === null),
  };
}

export async function setCapabilityGrant(
  deps: Deps,
  actor: Actor,
  input: Target & {
    scope: string;
    resource?: CapabilityResource | undefined;
    effect: "allow" | "ask" | "deny";
    kind?: "bot" | "delegation" | undefined;
    expiresAt?: string | undefined;
  },
): Promise<CapabilityGrantView> {
  const access = await authorize(deps, actor, input);
  const { admin, owner, bot } = access;
  const kind = input.kind ?? (bot && owner ? "delegation" : "bot");
  if (kind === "delegation" && !(bot && owner)) {
    throw new ORPCError("FORBIDDEN", {
      message: "Only the owner can delegate their own credentials",
    });
  }
  const expiresAt = input.expiresAt ? new Date(input.expiresAt) : null;
  if (expiresAt && expiresAt.getTime() <= Date.now()) {
    throw new ORPCError("BAD_REQUEST", { message: "The expiry is in the past" });
  }
  const problem = input.effect === "allow" ? allowProblem(input.scope, admin) : null;
  if (problem === "organization") {
    throw new ORPCError("BAD_REQUEST", { message: "Not allowed by your organization" });
  }
  if (problem === "administrator") {
    throw new ORPCError("FORBIDDEN", { message: "This needs an administrator" });
  }
  const createdVia = admin ? "admin" : "owner";
  const data = {
    botId: bot?.id ?? null,
    employeeId: access.employeeId,
    spaceId: bot?.spaceId ?? null,
    kind,
    scope: input.scope,
    resource: (input.resource ?? null) as Prisma.InputJsonValue | null,
    effect: input.effect,
    principalUserId: kind === "delegation" ? actor.userId : null,
    createdByUserId: actor.userId,
    createdVia,
    expiresAt,
  };
  const saved = await system("set", () =>
    deps.prisma.$transaction(async (tx) => {
      const where = bot ? { botId: bot.id } : { employeeId: access.employeeId };
      const active = await tx.capabilityGrant.findMany({
        where: { ...where, revokedAt: null },
        select: {
          id: true,
          kind: true,
          scope: true,
          effect: true,
          resource: true,
          createdVia: true,
          principalUserId: true,
        },
      });
      // The same grant again by the same kind of author only moves its expiry.
      const same = active.find(
        (row) =>
          row.kind === kind &&
          row.scope === input.scope &&
          row.effect === input.effect &&
          row.createdVia === createdVia &&
          row.principalUserId === data.principalUserId &&
          JSON.stringify(row.resource ?? null) === JSON.stringify(input.resource ?? null),
      );
      if (same) {
        return tx.capabilityGrant.update({
          where: { id: same.id },
          data: { expiresAt, createdByUserId: actor.userId },
        });
      }
      if (active.length >= MAX_ACTIVE_GRANTS) {
        throw new ORPCError("BAD_REQUEST", { message: "Too many grants; revoke some first" });
      }
      return tx.capabilityGrant.create({
        data: { ...data, resource: data.resource ?? undefined },
      });
    }),
  );
  await recordSecurityEvent({
    type: "capability.grant_set",
    userId: actor.userId,
    spaceId: bot?.spaceId ?? actor.spaceId,
    metadata: {
      grantId: saved.id,
      botId: bot?.id ?? null,
      employeeId: access.employeeId,
      scope: saved.scope,
      effect: saved.effect,
      kind: saved.kind,
      via: saved.createdVia,
    },
  });
  return view(saved, false);
}

export async function revokeCapabilityGrant(
  deps: Deps,
  actor: Actor,
  input: { id: string; reason?: string | undefined },
): Promise<{ ok: true }> {
  const row = await system("find grant", () =>
    deps.prisma.capabilityGrant.findUnique({ where: { id: input.id } }),
  );
  if (!row) throw new ORPCError("NOT_FOUND", { message: "Grant not found" });
  const access = row.botId
    ? await authorize(deps, actor, { botId: row.botId })
    : await authorize(deps, actor, { employeeId: row.employeeId ?? "" });
  // A restriction an admin set is not the owner's to lift.
  if (!access.admin && row.effect !== "allow" && row.createdVia !== "owner") {
    throw new ORPCError("FORBIDDEN", { message: "Set by an administrator" });
  }
  const revoked = await system("revoke", () =>
    deps.prisma.capabilityGrant.updateMany({
      where: { id: row.id, revokedAt: null },
      data: {
        revokedAt: new Date(),
        revokedReason: `${access.admin ? "admin" : "owner"}:${input.reason ?? "revoked"}`.slice(
          0,
          200,
        ),
      },
    }),
  );
  if (revoked.count === 1) {
    await recordSecurityEvent({
      type: "capability.grant_revoked",
      userId: actor.userId,
      spaceId: row.spaceId ?? actor.spaceId,
      metadata: {
        grantId: row.id,
        botId: row.botId,
        employeeId: row.employeeId,
        scope: row.scope,
        via: access.admin ? "admin" : "owner",
      },
    });
  }
  return { ok: true };
}

export async function setCapabilityMode(
  deps: Deps,
  actor: Actor,
  input: { botId: string; mode: CapabilityMode | null },
): Promise<{ ok: true }> {
  await requireAdminRole(deps, actor.userId, "security");
  const bot = await loadBot(deps, input.botId);
  await system("set mode", () =>
    deps.prisma.bot.update({ where: { id: bot.id }, data: { capabilityMode: input.mode } }),
  );
  await recordSecurityEvent({
    type: "capability.mode_changed",
    userId: actor.userId,
    spaceId: bot.spaceId,
    metadata: { botId: bot.id, mode: input.mode ?? "off" },
  });
  return { ok: true };
}
