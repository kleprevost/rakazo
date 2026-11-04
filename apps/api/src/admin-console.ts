import { ORPCError } from "@orpc/server";
import { activePolicy } from "@rakazo/adapters";
import type {
  AdminAuditInput,
  AdminAuditPage,
  AdminBotPage,
  AdminOverview,
  AdminPolicyView,
  AdminUserPage,
} from "@rakazo/contracts";
import { budgetPeriodStart } from "@rakazo/core";
import { listSecurityEvents, quarantineCovers, recordSecurityEvent, runAsSystem } from "@rakazo/db";
import { requireAdmin } from "./admins.js";
import type { RouterDeps } from "./router.js";

type ConsoleDeps = Pick<RouterDeps, "prisma"> & {
  env: Pick<
    RouterDeps["env"],
    | "adminEmails"
    | "ssoAdminEnabled"
    | "defaultProvider"
    | "defaultModel"
    | "sandboxProvider"
    | "authModes"
    | "policyHash"
  >;
  auth: Pick<RouterDeps["auth"], "isSsoAdmin" | "$context">;
  billing?: Pick<NonNullable<RouterDeps["billing"]>, "modelCreditsEnabled">;
};

/** Spend rows listed per scope on the policy page: the biggest spenders. */
const TOP_SPENDERS = 25;
const DENIED_EVENTS = 20;

const system = <T>(what: string, fn: () => Promise<T>) => runAsSystem(`admin console: ${what}`, fn);

function modelOf(provider: string | null, model: string | null) {
  return provider && model ? `${provider}/${model}` : null;
}

export async function adminOverview(deps: ConsoleDeps, actorId: string): Promise<AdminOverview> {
  await requireAdmin(deps, actorId);
  const policy = activePolicy();
  const [userCount, botCount] = await system("overview counts", () =>
    Promise.all([deps.prisma.user.count(), deps.prisma.bot.count()]),
  );
  return {
    auth: deps.env.authModes ?? { password: true, sso: false, easyAuth: false },
    defaultModel: `${deps.env.defaultProvider}/${deps.env.defaultModel}`,
    computerProvider: deps.env.sandboxProvider,
    policy: {
      loaded: Boolean(policy),
      version: policy?.version ?? null,
      hash: policy ? (deps.env.policyHash ?? null) : null,
    },
    modelCredits: Boolean(deps.billing?.modelCreditsEnabled),
    userCount,
    botCount,
  };
}

export async function adminUsers(
  deps: ConsoleDeps,
  actorId: string,
  input: { cursor?: string; limit: number },
): Promise<AdminUserPage> {
  await requireAdmin(deps, actorId);
  const rows = await system("list users", () =>
    deps.prisma.user.findMany({
      select: { id: true, name: true, email: true, emailVerified: true, createdAt: true },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: input.limit + 1,
      ...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
    }),
  );
  const page = rows.slice(0, input.limit);
  const ids = page.map((user) => user.id);
  const [sso, sessions, signIns] = await system("user sign-ins", () =>
    Promise.all([
      deps.prisma.account.findMany({
        where: { userId: { in: ids }, providerId: "oidc" },
        select: { userId: true },
      }),
      deps.prisma.session.groupBy({
        by: ["userId"],
        where: { userId: { in: ids } },
        _max: { createdAt: true },
      }),
      deps.prisma.securityEvent.groupBy({
        by: ["userId"],
        where: { userId: { in: ids }, type: "auth.sign_in" },
        _max: { createdAt: true },
      }),
    ]),
  );
  const linked = new Set(sso.map((account) => account.userId));
  const lastSeen = new Map<string, Date>();
  for (const row of [...sessions, ...signIns]) {
    const at = row._max.createdAt;
    if (row.userId && at && at > (lastSeen.get(row.userId) ?? new Date(0)))
      lastSeen.set(row.userId, at);
  }
  const admins = deps.env.adminEmails ?? [];
  const users = await Promise.all(
    page.map(async (user) => {
      // Same rule as `isAdmin`: a verified email on the list, or a verified SSO admin claim.
      const adminVia: "email" | "sso" | null = !user.emailVerified
        ? null
        : admins.includes(user.email.toLowerCase())
          ? "email"
          : deps.env.ssoAdminEnabled && (await deps.auth.isSsoAdmin(user.id))
            ? "sso"
            : null;
      return {
        id: user.id,
        name: user.name,
        email: user.email,
        createdAt: user.createdAt.toISOString(),
        adminVia,
        ssoLinked: linked.has(user.id),
        lastSignInAt: lastSeen.get(user.id)?.toISOString() ?? null,
        isSelf: user.id === actorId,
      };
    }),
  );
  return { users, nextCursor: rows.length > input.limit ? (page.at(-1)?.id ?? null) : null };
}

/** Signs one account out everywhere, the way an SSO revalidation does. */
export async function adminEndSessions(
  deps: ConsoleDeps,
  actorId: string,
  userId: string,
): Promise<{ ended: number }> {
  await requireAdmin(deps, actorId);
  if (userId === actorId)
    throw new ORPCError("BAD_REQUEST", { message: "Use sign out for your own account" });
  const target = await system("find user", () =>
    deps.prisma.user.findUnique({ where: { id: userId }, select: { id: true } }),
  );
  if (!target) throw new ORPCError("NOT_FOUND", { message: "User not found" });
  const { internalAdapter } = await deps.auth.$context;
  const sessions = await internalAdapter.listSessions(userId);
  if (sessions.length)
    await internalAdapter.deleteSessions(sessions.map((session) => session.token));
  await recordSecurityEvent({
    type: "auth.session.revoked",
    userId,
    metadata: { via: "admin", adminId: actorId, count: sessions.length },
  });
  return { ended: sessions.length };
}

export async function adminBots(
  deps: ConsoleDeps,
  actorId: string,
  input: { cursor?: string; limit: number },
  now = new Date(),
): Promise<AdminBotPage> {
  await requireAdmin(deps, actorId);
  const rows = await system("list bots", () =>
    deps.prisma.bot.findMany({
      select: {
        id: true,
        name: true,
        userId: true,
        modelProvider: true,
        modelId: true,
        archivedAt: true,
        suspendedAt: true,
        spaceId: true,
        groupMembers: { select: { groupId: true } },
        space: { select: { name: true } },
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: input.limit + 1,
      ...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
    }),
  );
  const page = rows.slice(0, input.limit);
  const botIds = page.map((bot) => bot.id);
  const [quarantines, owners, activity, spend] = await system("bot details", () =>
    Promise.all([
      deps.prisma.quarantine.findMany({
        where: { liftedAt: null },
        select: { scopeKind: true, scopeId: true, createdAt: true },
        orderBy: { createdAt: "asc" },
      }),
      deps.prisma.user.findMany({
        where: { id: { in: [...new Set(page.map((bot) => bot.userId))] } },
        select: { id: true, name: true, email: true },
      }),
      deps.prisma.run.groupBy({
        by: ["botId"],
        where: { botId: { in: botIds } },
        _max: { createdAt: true },
      }),
      deps.prisma.usageRecord.groupBy({
        by: ["botId"],
        where: { botId: { in: botIds }, createdAt: { gte: budgetPeriodStart(now) } },
        _sum: { costUsd: true },
      }),
    ]),
  );
  const ownerById = new Map(owners.map((owner) => [owner.id, owner]));
  const lastActive = new Map(activity.map((row) => [row.botId, row._max.createdAt]));
  const spent = new Map(spend.map((row) => [row.botId, row._sum.costUsd ?? 0]));
  return {
    bots: page.map((bot) => ({
      id: bot.id,
      name: bot.name,
      ownerName: ownerById.get(bot.userId)?.name ?? null,
      ownerEmail: ownerById.get(bot.userId)?.email ?? null,
      spaceName: bot.space.name,
      model: modelOf(bot.modelProvider, bot.modelId),
      lastActiveAt: lastActive.get(bot.id)?.toISOString() ?? null,
      monthlySpendUsd: spent.get(bot.id) ?? 0,
      archived: bot.archivedAt !== null,
      suspendedAt: bot.suspendedAt?.toISOString() ?? null,
      quarantinedAt:
        quarantines
          .find((quarantine) =>
            quarantineCovers(quarantine, {
              id: bot.id,
              spaceId: bot.spaceId,
              groupIds: bot.groupMembers.map((member) => member.groupId),
            }),
          )
          ?.createdAt.toISOString() ?? null,
    })),
    nextCursor: rows.length > input.limit ? (page.at(-1)?.id ?? null) : null,
  };
}

async function emailsById(deps: ConsoleDeps, ids: Array<string | null>) {
  const wanted = [...new Set(ids.filter((id): id is string => Boolean(id)))];
  if (!wanted.length) return new Map<string, string>();
  const users = await system("resolve users", () =>
    deps.prisma.user.findMany({ where: { id: { in: wanted } }, select: { id: true, email: true } }),
  );
  return new Map(users.map((user) => [user.id, user.email]));
}

export async function adminPolicy(
  deps: ConsoleDeps,
  actorId: string,
  now = new Date(),
): Promise<AdminPolicyView> {
  await requireAdmin(deps, actorId);
  const policy = activePolicy();
  const since = budgetPeriodStart(now);
  const where = { createdAt: { gte: since } };
  const [total, byUser, byBot, denied] = await system("policy and spend", () =>
    Promise.all([
      deps.prisma.usageRecord.aggregate({ where, _sum: { costUsd: true } }),
      deps.prisma.usageRecord.groupBy({
        by: ["userId"],
        where,
        _sum: { costUsd: true },
        orderBy: { _sum: { costUsd: "desc" } },
        take: TOP_SPENDERS,
      }),
      deps.prisma.usageRecord.groupBy({
        by: ["botId"],
        where: { ...where, botId: { not: null } },
        _sum: { costUsd: true },
        orderBy: { _sum: { costUsd: "desc" } },
        take: TOP_SPENDERS,
      }),
      listSecurityEvents(deps.prisma, { type: "policy.denied", limit: DENIED_EVENTS }),
    ]),
  );
  const botIds = byBot.flatMap((row) => (row.botId ? [row.botId] : []));
  const bots = botIds.length
    ? await system("name bots", () =>
        deps.prisma.bot.findMany({
          where: { id: { in: botIds } },
          select: { id: true, name: true },
        }),
      )
    : [];
  const botNames = new Map(bots.map((bot) => [bot.id, bot.name]));
  const emails = await emailsById(deps, [
    ...byUser.map((row) => row.userId),
    ...denied.map((event) => event.userId),
  ]);
  const text = (value: unknown) => (typeof value === "string" ? value : null);
  const budgets = policy?.budgets;
  return {
    loaded: Boolean(policy),
    version: policy?.version ?? null,
    hash: policy ? (deps.env.policyHash ?? null) : null,
    policy: policy ?? null,
    spend: {
      periodStart: since.toISOString(),
      organizationUsd: total._sum.costUsd ?? 0,
      users: byUser.map((row) => ({
        id: row.userId,
        label: emails.get(row.userId) ?? row.userId,
        spentUsd: row._sum.costUsd ?? 0,
      })),
      // A deleted bot keeps its spend; its id stands in for the name.
      bots: byBot.flatMap((row) =>
        row.botId
          ? [
              {
                id: row.botId,
                label: botNames.get(row.botId) ?? row.botId,
                spentUsd: row._sum.costUsd ?? 0,
              },
            ]
          : [],
      ),
    },
    limits: {
      organizationUsd: budgets?.organizationUsd ?? null,
      perUserUsd: budgets?.perUserUsd ?? null,
      perBotUsd: budgets?.perBotUsd ?? null,
    },
    denied: denied.map((event) => ({
      id: event.id,
      createdAt: event.createdAt,
      userEmail: event.userId ? (emails.get(event.userId) ?? null) : null,
      rule: text(event.metadata.rule),
      subject: text(event.metadata.subject),
      surface: text(event.metadata.surface),
    })),
  };
}

export async function adminAudit(
  deps: ConsoleDeps,
  actorId: string,
  input: AdminAuditInput,
): Promise<AdminAuditPage> {
  await requireAdmin(deps, actorId);
  const empty: AdminAuditPage = { events: [], nextCursor: null };
  let userId: string | undefined;
  if (input.user?.trim()) {
    const user = await system("find user by email", () =>
      deps.prisma.user.findFirst({
        where: { email: { equals: input.user?.trim(), mode: "insensitive" } },
        select: { id: true },
      }),
    );
    if (!user) return empty;
    userId = user.id;
  }
  const rows = await system("read security events", () =>
    listSecurityEvents(deps.prisma, {
      type: input.type,
      userId,
      from: input.from ? new Date(input.from) : undefined,
      to: input.to ? new Date(input.to) : undefined,
      cursor: input.cursor,
      limit: input.limit + 1,
    }),
  );
  const page = rows.slice(0, input.limit);
  const emails = await emailsById(
    deps,
    page.map((event) => event.userId),
  );
  return {
    events: page.map((event) => ({
      id: event.id,
      type: event.type,
      createdAt: event.createdAt,
      userEmail: event.userId ? (emails.get(event.userId) ?? null) : null,
      ip: event.ip,
      metadata: event.metadata,
    })),
    nextCursor: rows.length > input.limit ? (page.at(-1)?.id ?? null) : null,
  };
}
