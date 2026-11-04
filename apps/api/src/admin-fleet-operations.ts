import { ORPCError } from "@orpc/server";
import {
  createFleetOperation,
  FleetConflictError,
  FleetImageNotApprovedError,
} from "@rakazo/adapters";
import type { FleetOperation, FleetOperationDetail } from "@rakazo/contracts";
import { runAsSystem } from "@rakazo/db";
import { requireAdminRole } from "./admins.js";
import type { RouterDeps } from "./router.js";

type FleetDeps = Pick<RouterDeps, "prisma" | "jobs"> & {
  env: Pick<
    RouterDeps["env"],
    "adminEmails" | "ssoAdminEnabled" | "operatorEmails" | "ssoOperatorRolesEnabled"
  >;
  auth: Pick<RouterDeps["auth"], "isSsoAdmin">;
};

const system = <T>(what: string, fn: () => Promise<T>) =>
  runAsSystem(`admin fleet operations: ${what}`, fn);

type OperationRow = {
  id: string;
  kind: string;
  imageDigest: string | null;
  status: string;
  createdAt: Date;
  finishedAt: Date | null;
  maxParallel: number;
  haltAfterFailures: number;
};

const shape = (row: OperationRow, counts: Record<string, number>): FleetOperation => ({
  id: row.id,
  kind: row.kind as FleetOperation["kind"],
  imageDigest: row.imageDigest,
  status: row.status as FleetOperation["status"],
  createdAt: row.createdAt.toISOString(),
  finishedAt: row.finishedAt?.toISOString() ?? null,
  maxParallel: row.maxParallel,
  haltAfterFailures: row.haltAfterFailures,
  counts: counts as FleetOperation["counts"],
});

export async function adminCreateFleetOperation(
  deps: FleetDeps,
  actorId: string,
  input: Omit<Parameters<typeof createFleetOperation>[1], "actorUserId">,
): Promise<{ id: string }> {
  await requireAdminRole(deps, actorId, "fleet");
  try {
    return await createFleetOperation(deps, { ...input, actorUserId: actorId });
  } catch (error) {
    if (error instanceof FleetConflictError)
      throw new ORPCError("CONFLICT", { message: error.message });
    if (error instanceof FleetImageNotApprovedError)
      throw new ORPCError("FORBIDDEN", { message: error.message });
    if (error instanceof Error && error.message === "Computer not found")
      throw new ORPCError("NOT_FOUND", { message: error.message });
    throw error;
  }
}

export async function adminFleetOperations(
  deps: FleetDeps,
  actorId: string,
  input: { limit: number },
): Promise<{ operations: FleetOperation[] }> {
  await requireAdminRole(deps, actorId, ["security", "fleet", "auditor"]);
  const rows = await system("list", () =>
    deps.prisma.computerFleetOperation.findMany({
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: input.limit,
    }),
  );
  const grouped = await system("count items", () =>
    deps.prisma.computerFleetItem.groupBy({
      by: ["operationId", "status"],
      where: { operationId: { in: rows.map((row) => row.id) } },
      _count: { _all: true },
    }),
  );
  return {
    operations: rows.map((row) =>
      shape(
        row,
        Object.fromEntries(
          grouped
            .filter((group) => group.operationId === row.id)
            .map((group) => [group.status, group._count._all]),
        ),
      ),
    ),
  };
}

export async function adminFleetOperation(
  deps: FleetDeps,
  actorId: string,
  operationId: string,
): Promise<FleetOperationDetail> {
  await requireAdminRole(deps, actorId, ["security", "fleet", "auditor"]);
  const row = await system("read", () =>
    deps.prisma.computerFleetOperation.findUnique({
      where: { id: operationId },
      include: { items: { orderBy: [{ createdAt: "asc" }, { id: "asc" }] } },
    }),
  );
  if (!row) throw new ORPCError("NOT_FOUND", { message: "Operation not found" });
  const computers = await system("read computers", () =>
    deps.prisma.computer.findMany({
      where: { id: { in: row.items.map((item) => item.computerId) } },
      select: {
        id: true,
        space: { select: { name: true } },
        bots: { select: { name: true }, orderBy: { name: "asc" } },
      },
    }),
  );
  const byId = new Map(computers.map((computer) => [computer.id, computer]));
  const counts: Record<string, number> = {};
  for (const item of row.items) counts[item.status] = (counts[item.status] ?? 0) + 1;
  return {
    ...shape(row, counts),
    items: row.items.map((item) => ({
      computerId: item.computerId,
      spaceName: byId.get(item.computerId)?.space.name ?? null,
      bots: byId.get(item.computerId)?.bots.map((bot) => bot.name) ?? [],
      status: item.status as FleetOperationDetail["items"][number]["status"],
      outcome: item.outcome,
      imageDigestBefore: item.imageDigestBefore,
      imageDigestAfter: item.imageDigestAfter,
      homeRevisionBefore: item.homeRevisionBefore,
      homeRevisionAfter: item.homeRevisionAfter,
      finishedAt: item.finishedAt?.toISOString() ?? null,
    })),
  };
}
