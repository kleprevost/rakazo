import type { AdapterContext } from "@rakazo/adapter-kit";
import { toComputerRef } from "@rakazo/adapters";
import type { AdminComputer, AdminComputerPage } from "@rakazo/contracts";
import { runAsSystem } from "@rakazo/db";
import { requireAdmin } from "./admins.js";
import type { RouterDeps } from "./router.js";

type ComputersDeps = Pick<RouterDeps, "prisma" | "sandbox"> & {
  env: Pick<RouterDeps["env"], "adminEmails" | "ssoAdminEnabled">;
  auth: Pick<RouterDeps["auth"], "isSsoAdmin">;
};

/** Computers asked at once, and how long one may take, so a slow provider never stalls the page. */
const INSPECT_PARALLEL = 4;
const INSPECT_TIMEOUT_MS = 5_000;

const system = <T>(what: string, fn: () => Promise<T>) =>
  runAsSystem(`admin computers: ${what}`, fn);

type Inspected = Pick<AdminComputer, "image" | "isolation" | "inspection">;

async function inspectComputer(
  deps: ComputersDeps,
  computer: {
    id: string;
    kind: string;
    state: string;
    homeKey: string;
    providerRef: string | null;
    spaceId: string;
    userId: string;
  },
): Promise<Inspected> {
  const sandbox = deps.sandbox;
  const description = sandbox.describe();
  if (
    description.id !== computer.kind ||
    !description.capabilities.fleet?.inspect ||
    !sandbox.inspect
  )
    return { image: null, isolation: null, inspection: "skipped_unsupported" };
  if (computer.state !== "running" || !computer.providerRef)
    return { image: null, isolation: null, inspection: "not_running" };
  const context: AdapterContext = {
    operationId: `admin-computers-${computer.id}`,
    traceId: `admin-computers-${computer.id}`,
    spaceId: computer.spaceId,
    userId: computer.userId,
    botId: computer.homeKey,
    signal: AbortSignal.timeout(INSPECT_TIMEOUT_MS),
  };
  try {
    const report = await sandbox.inspect(toComputerRef(computer), context);
    return {
      image: report.image?.ref ?? null,
      isolation: report.isolation,
      inspection: "inspected",
    };
  } catch {
    return { image: null, isolation: null, inspection: "unavailable" };
  }
}

async function inBatches<T, R>(items: T[], size: number, fn: (item: T) => Promise<R>) {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += size)
    out.push(...(await Promise.all(items.slice(i, i + size).map(fn))));
  return out;
}

/** Every bot computer, newest first: stored state plus what the provider reports about each. */
export async function adminComputers(
  deps: ComputersDeps,
  actorId: string,
  input: { cursor?: string; limit: number },
): Promise<AdminComputerPage> {
  await requireAdmin(deps, actorId);
  const rows = await system("list computers", () =>
    deps.prisma.computer.findMany({
      select: {
        id: true,
        kind: true,
        scope: true,
        state: true,
        homeKey: true,
        providerRef: true,
        spaceId: true,
        userId: true,
        runningSince: true,
        updatedAt: true,
        space: { select: { name: true } },
        bots: { select: { id: true, name: true }, orderBy: { name: "asc" } },
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: input.limit + 1,
      ...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
    }),
  );
  const page = rows.slice(0, input.limit);
  const [owners, runs] = await system("computer details", () =>
    Promise.all([
      deps.prisma.user.findMany({
        where: { id: { in: [...new Set(page.map((computer) => computer.userId))] } },
        select: { id: true, name: true, email: true },
      }),
      deps.prisma.computerRun.groupBy({
        by: ["computerId"],
        where: { computerId: { in: page.map((computer) => computer.id) } },
        _max: { startedAt: true, endedAt: true, lastSeenAt: true },
      }),
    ]),
  );
  const ownerById = new Map(owners.map((owner) => [owner.id, owner]));
  const lastRun = new Map(runs.map((run) => [run.computerId, run._max]));
  const inspected = await inBatches(page, INSPECT_PARALLEL, (computer) =>
    inspectComputer(deps, computer),
  );
  return {
    computers: page.map((computer, index) => {
      const run = lastRun.get(computer.id);
      const last = [run?.startedAt, run?.endedAt, run?.lastSeenAt, computer.runningSince]
        .filter((at): at is Date => Boolean(at))
        .sort((a, b) => b.getTime() - a.getTime())[0];
      return {
        id: computer.id,
        kind: computer.kind,
        scope: computer.scope,
        state: computer.state,
        ownerName: ownerById.get(computer.userId)?.name ?? null,
        ownerEmail: ownerById.get(computer.userId)?.email ?? null,
        spaceName: computer.space.name,
        bots: computer.bots,
        ...(inspected[index] as Inspected),
        runningSince: computer.runningSince?.toISOString() ?? null,
        lastActivityAt: last?.toISOString() ?? null,
      };
    }),
    nextCursor: rows.length > input.limit ? (page.at(-1)?.id ?? null) : null,
  };
}
