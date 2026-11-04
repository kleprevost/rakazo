import { ORPCError } from "@orpc/server";
import { activePolicy, enforcing, evaluateBotCall, evaluateBotScope } from "@rakazo/adapters";
import type {
  Actor,
  AdminCapabilityPage,
  CapabilityMode,
  CapabilityShadowSummary,
  CapabilitySimulation,
} from "@rakazo/contracts";
import { isBuiltinToolName } from "@rakazo/contracts";
import type { ClassifyInput } from "@rakazo/core";
import { requireAdminRole } from "./admins.js";
import { authorize, system } from "./capability-grants.js";

/*
 * Read-only views of the capability broker: the simulator, the shadow summary and the admin list
 * of bots. Nothing here runs a tool or changes a row. Output carries scope names, ids and rule
 * names only, never the arguments that were simulated.
 */

type Deps = Parameters<typeof authorize>[0];

const SHADOW_ACTION = "capability.shadow";
const WINDOW_MS = 7 * 24 * 60 * 60_000;
/** Denials read to rank scopes: the newest, enough to show what to grant before enforcing. */
const RANKED_EVENTS = 1_000;
const TOP_SCOPES = 8;

/** Domains whose scopes a bot reaches with the acting user's connected account. */
const CONNECTED_DOMAINS = new Set(["calendar", "mail", "contacts", "docs", "tickets", "chat"]);

function modeOf(value: string | null | undefined): CapabilityMode | null {
  return value === "shadow" || value === "enforce" ? value : null;
}

function shadowEvents(botIds: string[], since: Date) {
  return { action: SHADOW_ACTION, actorId: { in: botIds }, createdAt: { gte: since } };
}

export async function simulateCapability(
  deps: Deps,
  actor: Actor,
  input: {
    botId: string;
    tool?: string | undefined;
    server?: string | undefined;
    scope?: string | undefined;
    args?: Record<string, string | number | boolean> | undefined;
  },
): Promise<CapabilitySimulation> {
  const { bot: found } = await authorize(deps, actor, { botId: input.botId }, true);
  const bot = await system("simulate: find bot", () =>
    deps.prisma.bot.findUnique({
      where: { id: found?.id ?? "" },
      select: { id: true, name: true, userId: true, employeeId: true, capabilityMode: true },
    }),
  );
  if (!bot) throw new ORPCError("NOT_FOUND", { message: "AI employee not found" });
  const policy = activePolicy();
  const base = {
    prisma: deps.prisma,
    bot,
    spaceId: actor.spaceId,
    // The requester is the bot's owner, whose own connections a call would use.
    userId: bot.userId,
    policy,
  };
  const mode = modeOf(bot.capabilityMode);
  const enforced = enforcing(mode, policy);
  if (input.scope !== undefined) {
    const domain = input.scope.split(".")[0] ?? "";
    const decision = await evaluateBotScope({
      ...base,
      scope: input.scope,
      personal: domain === "ext" || CONNECTED_DOMAINS.has(domain),
    });
    return { ...decision, scopes: [input.scope], unmapped: false, mode, enforced };
  }
  const tool = input.tool ?? "";
  let call: ClassifyInput;
  if (input.server !== undefined) {
    call = { source: "mcp", tool, slug: input.server, ...(input.args ? { args: input.args } : {}) };
  } else if (isBuiltinToolName(tool)) {
    call = { source: "builtin", tool, ...(input.args ? { args: input.args } : {}) };
  } else {
    throw new ORPCError("BAD_REQUEST", { message: "Name the server for this tool" });
  }
  const decision = await evaluateBotCall({ ...base, call });
  const { scopes, basis, unmapped } = decision.classification;
  return {
    outcome: decision.outcome,
    ...(decision.rule ? { rule: decision.rule } : {}),
    scopes,
    basis,
    unmapped,
    mode,
    enforced,
    trace: decision.trace,
  };
}

export async function capabilityShadowSummary(
  deps: Deps,
  actor: Actor,
  input: { botId: string },
): Promise<CapabilityShadowSummary> {
  await authorize(deps, actor, { botId: input.botId }, true);
  const since = new Date(Date.now() - WINDOW_MS);
  const where = shadowEvents([input.botId], since);
  const decided = (decision: string) =>
    deps.prisma.auditEvent.count({
      where: { ...where, metadata: { path: ["decision"], equals: decision } },
    });
  const [allowed, asked, denied, ranked] = await system("shadow summary", () =>
    Promise.all([
      decided("allow"),
      decided("ask"),
      decided("deny"),
      deps.prisma.auditEvent.findMany({
        where: { ...where, NOT: { metadata: { path: ["decision"], equals: "allow" } } },
        select: { metadata: true },
        orderBy: { createdAt: "desc" },
        take: RANKED_EVENTS,
      }),
    ]),
  );
  const counts = new Map<string, number>();
  for (const { metadata } of ranked) {
    const scopes = (metadata as { scopes?: unknown } | null)?.scopes;
    if (typeof scopes !== "string") continue;
    for (const scope of scopes.split(",").filter(Boolean)) {
      counts.set(scope, (counts.get(scope) ?? 0) + 1);
    }
  }
  return {
    since: since.toISOString(),
    allowed,
    asked,
    denied,
    scopes: [...counts]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, TOP_SCOPES)
      .map(([scope, count]) => ({ scope, count })),
  };
}

export async function adminCapabilities(
  deps: Deps,
  actorId: string,
  input: { cursor?: string | undefined; limit: number },
): Promise<AdminCapabilityPage> {
  await requireAdminRole(deps, actorId, ["security", "auditor"]);
  const rows = await system("admin list", () =>
    deps.prisma.bot.findMany({
      where: { archivedAt: null },
      select: {
        id: true,
        name: true,
        userId: true,
        capabilityMode: true,
        space: { select: { name: true } },
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: input.limit + 1,
      ...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
    }),
  );
  const page = rows.slice(0, input.limit);
  const botIds = page.map((bot) => bot.id);
  const now = new Date();
  const [owners, grants, denied] = await system("admin details", () =>
    Promise.all([
      deps.prisma.user.findMany({
        where: { id: { in: [...new Set(page.map((bot) => bot.userId))] } },
        select: { id: true, email: true },
      }),
      deps.prisma.capabilityGrant.groupBy({
        by: ["botId"],
        where: {
          botId: { in: botIds },
          revokedAt: null,
          OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
        },
        _count: true,
      }),
      deps.prisma.auditEvent.groupBy({
        by: ["actorId"],
        where: {
          ...shadowEvents(botIds, new Date(now.getTime() - WINDOW_MS)),
          metadata: { path: ["decision"], equals: "deny" },
        },
        _count: true,
      }),
    ]),
  );
  const emailById = new Map(owners.map((owner) => [owner.id, owner.email]));
  const grantCount = new Map(grants.map((row) => [row.botId, row._count]));
  const deniedCount = new Map(denied.map((row) => [row.actorId, row._count]));
  return {
    bots: page.map((bot) => ({
      id: bot.id,
      name: bot.name,
      ownerEmail: emailById.get(bot.userId) ?? null,
      spaceName: bot.space.name,
      mode: modeOf(bot.capabilityMode),
      grants: grantCount.get(bot.id) ?? 0,
      wouldDeny: deniedCount.get(bot.id) ?? 0,
    })),
    nextCursor: rows.length > input.limit ? (page.at(-1)?.id ?? null) : null,
  };
}
