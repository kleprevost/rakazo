import type { AdapterContext, ComputerInspection, SandboxProvider } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import { runAsSystem } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import { toComputerRef } from "./computer-support.js";

export const FLEET_OBSERVE_INTERVAL_MS = 60_000;
/** A computer unseen for this many intervals reports `unknown` health, never `ok`. */
export const FLEET_STALE_INTERVALS = 3;
const PAGE_SIZE = 100;
const PARALLEL = 4;
const REPORT_TIMEOUT_MS = 20_000;
const OBSERVED_STATES = ["booting", "running", "suspending", "error"];

/** The health to show for a stored observation: stale or missing is `unknown`. */
export function observedHealth(
  observation: { observedAt: Date; health: string | null } | null | undefined,
  now: Date,
  intervalMs = FLEET_OBSERVE_INTERVAL_MS,
): "ok" | "degraded" | "unreachable" | "unknown" {
  if (!observation?.health) return "unknown";
  if (now.getTime() - observation.observedAt.getTime() > FLEET_STALE_INTERVALS * intervalMs)
    return "unknown";
  return observation.health === "ok" ||
    observation.health === "degraded" ||
    observation.health === "unreachable"
    ? observation.health
    : "unknown";
}

function observationData(report: ComputerInspection, observedAt: Date) {
  return {
    observedAt,
    runtime: report.runtime,
    imageRef: report.image?.ref ?? null,
    imageDigest: report.image?.digest ?? null,
    isolation: report.isolation,
    restartCount: report.restartCount ?? null,
    startedAt: report.startedAt ? new Date(report.startedAt) : null,
    cpuMillis: report.usage?.cpuMillis ?? null,
    memoryBytes: report.usage?.memoryBytes ?? null,
    memoryLimitBytes: report.usage?.memoryLimitBytes ?? null,
    pids: report.usage?.pids ?? null,
    egressMode: report.egress?.mode ?? null,
    egressEnforced: report.egress?.enforced ?? null,
    health: report.health ?? null,
  };
}

type Target = {
  id: string;
  homeKey: string;
  kind: string;
  providerRef: string | null;
  spaceId: string;
  userId: string;
};

async function reportsFor(
  sandbox: SandboxProvider,
  targets: Target[],
  context: AdapterContext,
): Promise<Map<string, ComputerInspection | null>> {
  const refs = targets.map((target) => ({
    computer: toComputerRef(target),
    spaceId: target.spaceId,
  }));
  if (sandbox.inspectMany) {
    try {
      const batch = await sandbox.inspectMany(refs, context);
      return new Map(
        targets.map((target) => [target.id, batch.get(toComputerRef(target).id) ?? null]),
      );
    } catch (error) {
      getLogger().warn("fleet.observe_batch_failed", { error });
    }
  }
  const out = new Map<string, ComputerInspection | null>();
  const queue = [...targets];
  await Promise.all(
    Array.from({ length: PARALLEL }, async () => {
      for (let next = queue.shift(); next; next = queue.shift()) {
        out.set(
          next.id,
          (await sandbox
            .inspect?.(toComputerRef(next), { ...context, spaceId: next.spaceId })
            .catch(() => null)) ?? null,
        );
      }
    }),
  );
  return out;
}

/**
 * Stores the provider's latest report on every computer that may be up, about once a minute, in
 * its own table so the hot `computers` row is never written. A computer the provider cannot be
 * asked about keeps its old row and goes stale. Runs on the reconciler tick, which only one
 * instance holds at a time; a provider without `fleet.inspect` is not asked at all.
 */
export function createFleetObserver(
  deps: { prisma: PrismaClient; sandbox: SandboxProvider },
  options: { intervalMs?: number } = {},
): () => Promise<void> {
  const intervalMs = options.intervalMs ?? FLEET_OBSERVE_INTERVAL_MS;
  let lastRun: number | undefined;
  return async () => {
    const now = Date.now();
    if (lastRun !== undefined && now - lastRun < intervalMs) return;
    lastRun = now;
    const description = deps.sandbox.describe();
    if (!description.capabilities.fleet?.inspect || !deps.sandbox.inspect) return;
    // Every instance runs this tick; one lease row lets a single instance sweep per interval. A
    // holder that dies just lets the lease expire, and a later tick elsewhere takes over.
    const claimed = await runAsSystem(
      "fleet observer: claim sweep",
      () =>
        deps.prisma.$queryRaw<Array<{ id: string }>>`
        INSERT INTO "computer_observer_leases" ("id", "claimedUntil")
        VALUES ('fleet-observer', ${new Date(now + intervalMs)})
        ON CONFLICT ("id") DO UPDATE SET "claimedUntil" = EXCLUDED."claimedUntil"
        WHERE "computer_observer_leases"."claimedUntil" <= ${new Date(now)}
        RETURNING "id"`,
    );
    if (claimed.length === 0) return;
    let cursor: string | undefined;
    for (;;) {
      const page: Target[] = await runAsSystem("fleet observer: list computers", () =>
        deps.prisma.computer.findMany({
          where: {
            kind: description.id,
            providerRef: { not: null },
            state: { in: OBSERVED_STATES },
          },
          select: {
            id: true,
            homeKey: true,
            kind: true,
            providerRef: true,
            spaceId: true,
            userId: true,
          },
          orderBy: { id: "asc" },
          take: PAGE_SIZE,
          ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
        }),
      );
      if (page.length === 0) return;
      cursor = page.at(-1)?.id;
      const signal = AbortSignal.timeout(REPORT_TIMEOUT_MS);
      const reports = await reportsFor(deps.sandbox, page, {
        operationId: "fleet.observe",
        traceId: "fleet.observe",
        spaceId: "",
        userId: "",
        signal,
      });
      const observedAt = new Date();
      await runAsSystem("fleet observer: store reports", () =>
        Promise.all(
          page.map((target) => {
            const report = reports.get(target.id);
            if (!report) return undefined;
            const data = observationData(report, observedAt);
            return deps.prisma.computerObservation
              .upsert({
                where: { computerId: target.id },
                create: { computerId: target.id, ...data },
                update: data,
              })
              .catch((error: unknown) => {
                // The computer may have been deleted since it was listed.
                getLogger().warn("fleet.observe_store_failed", { "computer.id": target.id, error });
              });
          }),
        ),
      );
      if (page.length < PAGE_SIZE) return;
    }
  };
}
