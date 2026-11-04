import type { CapabilityGrant } from "@rakazo/contracts";
import { CapabilityGrantSchema, CapabilityResourceSchema } from "@rakazo/contracts";
import type { Prisma, PrismaClient } from "./generated/prisma/client.js";

type GrantRow = Prisma.CapabilityGrantGetPayload<object>;

/**
 * A stored row as the evaluator sees it, or null when it cannot be read. A row that would widen
 * access (an allow) is dropped when anything about it is malformed; a restriction (ask, deny)
 * whose resource cannot be read applies to every resource, the safe side.
 */
export function grantFromRow(row: GrantRow): CapabilityGrant | null {
  const resource =
    row.resource === null ? undefined : CapabilityResourceSchema.safeParse(row.resource);
  if (resource && !resource.success && row.effect === "allow") return null;
  const parsed = CapabilityGrantSchema.safeParse({
    id: row.id,
    kind: row.kind,
    scope: row.scope,
    resource: resource?.success ? resource.data : undefined,
    effect: row.effect,
    principalUserId: row.principalUserId ?? undefined,
    createdVia: row.createdVia,
    expiresAt: row.expiresAt ?? undefined,
    revokedAt: row.revokedAt ?? undefined,
  });
  return parsed.success ? parsed.data : null;
}

/**
 * Every unrevoked grant that applies to a bot: its own rows, and its employee's, which every
 * instance inherits. Expired rows are included so a decision trace can say why one was ignored.
 */
export async function loadBotCapabilityGrants(
  prisma: Pick<PrismaClient, "capabilityGrant">,
  bot: { id: string; employeeId: string | null },
): Promise<CapabilityGrant[]> {
  const rows = await prisma.capabilityGrant.findMany({
    where: {
      revokedAt: null,
      OR: [{ botId: bot.id }, ...(bot.employeeId ? [{ employeeId: bot.employeeId }] : [])],
    },
    orderBy: { createdAt: "asc" },
  });
  return rows.flatMap((row) => grantFromRow(row) ?? []);
}
