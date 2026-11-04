import { ORPCError } from "@orpc/server";
import type { AdapterContext } from "@rakazo/adapter-kit";
import { activePolicy, observedHealth, toComputerRef } from "@rakazo/adapters";
import type { AdminComputer, AdminComputerDetail, AdminComputerPage } from "@rakazo/contracts";
import { computerImageCompliance } from "@rakazo/core";
import type { Prisma } from "@rakazo/db";
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

/** A computer that is not up has no health to report; otherwise stale observations read `unknown`. */
const healthFor = (
  state: string,
  observation: Parameters<typeof observedHealth>[0],
  now: Date,
): AdminComputer["health"] => (state === "stopped" ? "unknown" : observedHealth(observation, now));

type StoredImage = { imageRef: string | null; imageDigest: string | null };

/** The computer's last known image: the observation when there is one, else what its start asked for. */
const complianceFor = (
  computer: StoredImage,
  observation: StoredImage | null | undefined,
): AdminComputer["imageCompliance"] => {
  const known = observation ?? computer;
  return computerImageCompliance(activePolicy(), {
    ref: known.imageRef,
    digest: known.imageDigest,
  });
};

/** Computers whose last known image is off the policy's list, in the same terms as `complianceFor`. */
function notApprovedWhere(): Prisma.ComputerWhereInput {
  const allow = activePolicy()?.computers?.images?.allow.map((entry) => entry.digest);
  if (!allow) return { id: { in: [] } };
  return {
    OR: [
      { observation: { is: { imageDigest: { notIn: allow } } } },
      { observation: { is: { imageDigest: null, imageRef: { not: null } } } },
      { observation: { is: null }, imageRef: { not: null }, imageDigest: null },
      { observation: { is: null }, imageDigest: { notIn: allow } },
    ],
  };
}

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
  input: { cursor?: string; limit: number; imageCompliance?: "not_approved" },
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
        imageRef: true,
        imageDigest: true,
        spaceId: true,
        userId: true,
        runningSince: true,
        updatedAt: true,
        space: { select: { name: true } },
        bots: { select: { id: true, name: true }, orderBy: { name: "asc" } },
      },
      ...(input.imageCompliance ? { where: notApprovedWhere() } : {}),
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: input.limit + 1,
      ...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
    }),
  );
  const page = rows.slice(0, input.limit);
  const [owners, runs, observations] = await system("computer details", () =>
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
      deps.prisma.computerObservation.findMany({
        where: { computerId: { in: page.map((computer) => computer.id) } },
        select: {
          computerId: true,
          observedAt: true,
          health: true,
          imageRef: true,
          imageDigest: true,
        },
      }),
    ]),
  );
  const observationById = new Map(
    observations.map((observation) => [observation.computerId, observation]),
  );
  const now = new Date();
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
        health: healthFor(computer.state, observationById.get(computer.id), now),
        imageCompliance: complianceFor(computer, observationById.get(computer.id)),
        runningSince: computer.runningSince?.toISOString() ?? null,
        lastActivityAt: last?.toISOString() ?? null,
      };
    }),
    nextCursor: rows.length > input.limit ? (page.at(-1)?.id ?? null) : null,
  };
}

const RUN_HISTORY = 20;

const asNumber = (value: bigint | number | null | undefined) =>
  value === null || value === undefined ? null : Number(value);

/** One computer: the list row plus the latest observation, disk and restart history. */
export async function adminComputer(
  deps: ComputersDeps,
  actorId: string,
  computerId: string,
): Promise<AdminComputerDetail> {
  await requireAdmin(deps, actorId);
  const computer = await system("read computer", () =>
    deps.prisma.computer.findUnique({
      where: { id: computerId },
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
        createdAt: true,
        diskUsedBytes: true,
        diskFreeBytes: true,
        imageRef: true,
        imageDigest: true,
        space: { select: { name: true } },
        bots: { select: { id: true, name: true }, orderBy: { name: "asc" } },
        observation: true,
      },
    }),
  );
  if (!computer) throw new ORPCError("NOT_FOUND", { message: "Computer not found" });
  const [owner, runs, inspected] = await Promise.all([
    system("computer owner", () =>
      deps.prisma.user.findUnique({
        where: { id: computer.userId },
        select: { name: true, email: true },
      }),
    ),
    system("computer runs", () =>
      deps.prisma.computerRun.findMany({
        where: { computerId },
        select: { startedAt: true, endedAt: true, endReason: true, lastSeenAt: true },
        orderBy: { startedAt: "desc" },
        take: RUN_HISTORY,
      }),
    ),
    inspectComputer(deps, computer),
  ]);
  const observation = computer.observation;
  const last = [runs[0]?.startedAt, runs[0]?.endedAt, runs[0]?.lastSeenAt, computer.runningSince]
    .filter((at): at is Date => Boolean(at))
    .sort((a, b) => b.getTime() - a.getTime())[0];
  return {
    id: computer.id,
    kind: computer.kind,
    scope: computer.scope,
    state: computer.state,
    ownerName: owner?.name ?? null,
    ownerEmail: owner?.email ?? null,
    spaceName: computer.space.name,
    bots: computer.bots,
    ...inspected,
    health: healthFor(computer.state, observation, new Date()),
    imageCompliance: complianceFor(computer, observation),
    runningSince: computer.runningSince?.toISOString() ?? null,
    lastActivityAt: last?.toISOString() ?? null,
    createdAt: computer.createdAt.toISOString(),
    imageDigest: observation?.imageDigest ?? computer.imageDigest ?? null,
    disk:
      computer.diskUsedBytes !== null && computer.diskFreeBytes !== null
        ? { usedBytes: Number(computer.diskUsedBytes), freeBytes: Number(computer.diskFreeBytes) }
        : null,
    observation: observation
      ? {
          observedAt: observation.observedAt.toISOString(),
          runtime: observation.runtime as "running" | "stopped" | "gone",
          startedAt: observation.startedAt?.toISOString() ?? null,
          restartCount: observation.restartCount,
          usage:
            observation.cpuMillis === null &&
            observation.memoryBytes === null &&
            observation.pids === null
              ? null
              : {
                  cpuMillis: observation.cpuMillis,
                  memoryBytes: asNumber(observation.memoryBytes),
                  memoryLimitBytes: asNumber(observation.memoryLimitBytes),
                  pids: observation.pids,
                },
          egress:
            observation.egressMode === null || observation.egressEnforced === null
              ? null
              : {
                  mode: observation.egressMode as "open" | "restricted" | "isolated" | "unknown",
                  enforced: observation.egressEnforced,
                },
        }
      : null,
    runs: runs.map((run) => ({
      startedAt: run.startedAt.toISOString(),
      endedAt: run.endedAt?.toISOString() ?? null,
      endReason: run.endReason,
      lastSeenAt: run.lastSeenAt?.toISOString() ?? null,
    })),
  };
}
