import { ORPCError } from "@orpc/server";
import type { AdapterContext } from "@rakazo/adapter-kit";
import type { AdminCredentialRevocation } from "@rakazo/contracts";
import {
  deleteUnreferencedCredentialSecret,
  modelCredentialProviderFilter,
  recordSecurityEvent,
  runAsSystem,
} from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import { requireAdminRole } from "./admins.js";
import type { RouterDeps } from "./router.js";

type RevocationDeps = Pick<RouterDeps, "prisma" | "connectors" | "oauthLogins"> & {
  env: Pick<
    RouterDeps["env"],
    "adminEmails" | "ssoAdminEnabled" | "operatorEmails" | "ssoOperatorRolesEnabled"
  >;
  auth: Pick<RouterDeps["auth"], "isSsoAdmin">;
};

const system = <T>(what: string, fn: () => Promise<T>) =>
  runAsSystem(`credential revocation: ${what}`, fn);

const NONE: AdminCredentialRevocation = {
  connections: 0,
  providerUnconfirmed: 0,
  mcpServers: 0,
  mcpAssignments: 0,
  vaultItems: 0,
  botSecrets: 0,
  modelConnections: 0,
  voiceConnections: 0,
};

/**
 * An admin removes an account's stored credentials, or one bot's own, so the very next call
 * fails: connected apps are marked revoked (and revoked at their provider where it can), MCP
 * servers lose their sign-in and secrets and bump their revision so live sessions end, and vault,
 * bot-secret, model and voice connections are deleted with their stored secrets. It reuses what
 * disconnecting does for each, so nothing is left half-removed. Security role only, never on
 * your own account, and one `credential.revoked` event carries counts and ids, never values.
 * Quarantine does not call this: it never revokes a personal connection by itself.
 */
export async function revokeCredentials(
  deps: RevocationDeps,
  actorId: string,
  input: { userId?: string | undefined; botId?: string | undefined },
): Promise<AdminCredentialRevocation> {
  await requireAdminRole(deps, actorId, "security");
  const bot = input.botId
    ? await system("find bot", () =>
        deps.prisma.bot.findUnique({
          where: { id: input.botId },
          select: { id: true, userId: true, spaceId: true },
        }),
      )
    : null;
  if (input.botId && !bot) throw new ORPCError("NOT_FOUND", { message: "AI employee not found" });
  const userId = bot?.userId ?? input.userId ?? "";
  if (!bot) {
    if (userId === actorId)
      throw new ORPCError("BAD_REQUEST", { message: "Not available on your own account" });
    const user = await system("find user", () =>
      deps.prisma.user.findUnique({ where: { id: userId }, select: { id: true } }),
    );
    if (!user) throw new ORPCError("NOT_FOUND", { message: "User not found" });
  }
  const counts = bot
    ? await system("revoke a bot's credentials", () => revokeBot(deps, bot.id))
    : await revokeUser(deps, userId);
  await recordSecurityEvent({
    type: "credential.revoked",
    userId,
    ...(bot ? { spaceId: bot.spaceId } : {}),
    metadata: {
      via: "admin",
      adminId: actorId,
      ...(bot ? { botId: bot.id } : {}),
      ...counts,
    },
  });
  return counts;
}

async function revokeBot(deps: RevocationDeps, botId: string): Promise<AdminCredentialRevocation> {
  const secrets = await deps.prisma.botSecret.deleteMany({ where: { botId } });
  const assignments = await deps.prisma.botMcpServer.deleteMany({ where: { botId } });
  return { ...NONE, botSecrets: secrets.count, mcpAssignments: assignments.count };
}

async function revokeUser(
  deps: RevocationDeps,
  userId: string,
): Promise<AdminCredentialRevocation> {
  const counts = { ...NONE };
  const prisma = deps.prisma;

  // Connected apps: local status first, so the next run no longer sees them.
  const connections = await system("list connections", () =>
    prisma.connection.findMany({
      where: { userId, status: { in: ["connected", "pending", "error"] } },
      select: { id: true, spaceId: true, connectorId: true, provider: true, providerRef: true },
    }),
  );
  if (connections.length) {
    await system("revoke connections", () =>
      prisma.connection.updateMany({
        where: { id: { in: connections.map((row) => row.id) } },
        data: { status: "revoked" },
      }),
    );
    counts.connections = connections.length;
    const remote = new Map<string, (typeof connections)[number]>();
    for (const row of connections)
      remote.set(`${row.connectorId}\u0000${row.providerRef || row.provider}`, row);
    for (const row of remote.values()) {
      const connector = deps.connectors.managed(row.connectorId);
      const context: AdapterContext = {
        operationId: `credential-revoke:${userId}`,
        traceId: `credential-revoke:${userId}`,
        spaceId: row.spaceId,
        userId,
        signal: AbortSignal.timeout(30_000),
      };
      try {
        if (!connector) throw new Error("connector not configured");
        await connector.revoke(row.providerRef || row.provider, context);
      } catch (error) {
        counts.providerUnconfirmed += 1;
        getLogger().warn("credential revocation: provider did not confirm", {
          "connector.id": row.connectorId,
          "error.message": error instanceof Error ? error.message.slice(0, 120) : "error",
        });
      }
    }
  }

  // MCP servers: drop the sign-in and secrets; the revision bump ends live sessions everywhere.
  const servers = await system("list MCP servers", () =>
    prisma.mcpServer.findMany({
      where: { userId, secretId: { not: null } },
      select: { id: true, secretId: true },
    }),
  );
  for (const server of servers) {
    await system("clear an MCP server's credentials", () =>
      prisma.$transaction(async (tx) => {
        const cleared = await tx.mcpServer.updateMany({
          where: { id: server.id, secretId: server.secretId },
          data: { secretId: null, revision: { increment: 1 } },
        });
        if (cleared.count && server.secretId)
          await tx.secret.deleteMany({ where: { id: server.secretId } });
      }),
    );
    counts.mcpServers += 1;
  }
  await system("end pending MCP sign-ins", () =>
    prisma.mcpOAuthSession.deleteMany({ where: { userId } }),
  );

  // The vault and bot secrets.
  counts.vaultItems = (
    await system("delete vault items", () =>
      prisma.vaultCredential.deleteMany({ where: { userId } }),
    )
  ).count;
  counts.botSecrets = (
    await system("delete bot secrets", () => prisma.botSecret.deleteMany({ where: { userId } }))
  ).count;

  // Model and voice connections, the way disconnecting removes them.
  const models = await system("list model connections", () =>
    prisma.userModelCredential.findMany({ where: { userId } }),
  );
  for (const provider of new Set(models.map((row) => row.provider)))
    await deps.oauthLogins.cancelProvider({ userId, provider });
  if (models.length) {
    await system("delete model connections", () =>
      prisma.$transaction(async (tx) => {
        for (const provider of new Set(models.map((row) => row.provider))) {
          const roleRows = { userId, provider: modelCredentialProviderFilter(provider) };
          await tx.userModelRoleChoice.deleteMany({ where: roleRows });
          await tx.spaceModelRoleChoice.deleteMany({ where: roleRows });
        }
        await tx.userModelCredential.deleteMany({
          where: { userId, id: { in: models.map((row) => row.id) } },
        });
        for (const row of models)
          await deleteUnreferencedCredentialSecret(tx, {
            credentialKind: "model",
            credentialId: row.id,
            secretId: row.secretId,
          });
      }),
    );
    counts.modelConnections = models.length;
  }
  const voices = await system("list voice connections", () =>
    prisma.userVoiceCredential.findMany({ where: { userId } }),
  );
  if (voices.length) {
    await system("delete voice connections", () =>
      prisma.$transaction(async (tx) => {
        await tx.userVoiceCredential.deleteMany({
          where: { userId, id: { in: voices.map((row) => row.id) } },
        });
        for (const row of voices)
          await deleteUnreferencedCredentialSecret(tx, {
            credentialKind: "voice",
            credentialId: row.id,
            secretId: row.secretId,
          });
      }),
    );
    counts.voiceConnections = voices.length;
  }
  return counts;
}
