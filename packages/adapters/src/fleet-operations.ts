import { randomUUID } from "node:crypto";
import type { AgentHomeStore, JobPublisher, SandboxProvider } from "@rakazo/adapter-kit";
import { fleetItemJob, SandboxAllowanceUsedError } from "@rakazo/adapter-kit";
import {
  FLEET_DEFAULT_HALT_AFTER,
  FLEET_DEFAULT_PARALLEL,
  FLEET_MAX_PARALLEL,
} from "@rakazo/contracts";
import type { PrismaClient, ThreadEvents } from "@rakazo/db";
import { recordSecurityEvent, runAsSystem, runAsTenant } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import { scheduleComputerSleep, sleepComputerWithOutcome } from "./computer-idle.js";
import { ComputerBusyError, provisionComputer } from "./computer-lifecycle.js";
import type { RecreateResult } from "./fleet-recreate.js";
import { recreateComputer } from "./fleet-recreate.js";
import { terminateComputer } from "./fleet-terminate.js";
import { assertComputerImageAllowed } from "./policy-capabilities.js";
import { PolicyDeniedError } from "./policy-runtime.js";

export type FleetOperationKind = "hibernate" | "wake" | "recreate" | "terminate";

/** How long a worker owns an item before another may take it, and how often it renews. */
export const FLEET_CLAIM_MS = 2 * 60_000;
export const FLEET_HEARTBEAT_MS = 30_000;
/** An item whose worker died this many times is left `interrupted` instead of run again. */
export const FLEET_MAX_ATTEMPTS = 3;
const OPEN = ["queued", "running"];
const CHANGED_EVENT = {
  hibernate: "computer.hibernated",
  wake: "computer.woken",
  recreate: "computer.recreated",
  terminate: "computer.terminated",
} as const;
const OPERATIONS_PER_PASS = 100;

const system = <T>(what: string, fn: () => Promise<T>) =>
  runAsSystem(`fleet operations: ${what}`, fn);

/** Native desktop computers and `none` have no provider runtime to stop or start. */
export function computerSupportsHibernate(kind: string): boolean {
  return kind !== "desktop" && kind !== "none";
}

type EngineDeps = { prisma: PrismaClient; jobs: JobPublisher };
type RunDeps = EngineDeps & {
  sandbox: SandboxProvider;
  home: AgentHomeStore;
  events: ThreadEvents;
  dataDir?: string;
  /** How often a recreate checks on its computer update; tests shorten it. */
  pollMs?: number;
};

/** The chosen image is not on the policy's approved list. */
export class FleetImageNotApprovedError extends Error {
  constructor() {
    super("That image is not approved");
    this.name = "FleetImageNotApprovedError";
  }
}

export class FleetConflictError extends Error {
  constructor() {
    super("Another operation is changing these computers");
    this.name = "FleetConflictError";
  }
}

const isUniqueViolation = (error: unknown) =>
  Boolean(error && typeof error === "object" && "code" in error && error.code === "P2002");

/**
 * Records an operation with one item per computer in one transaction, then starts the first
 * items. A computer that already has an unfinished item elsewhere is recorded as `skipped_busy`,
 * so two operations never act on one computer at once; the partial unique index backs that up
 * when two creates race.
 */
export async function createFleetOperation(
  deps: EngineDeps,
  input: {
    actorUserId: string;
    kind: FleetOperationKind;
    computerIds: string[];
    /** Recreate only: an approved image digest; without one the provider's own image is used. */
    imageDigest?: string;
    maxParallel?: number;
    haltAfterFailures?: number;
  },
): Promise<{ id: string }> {
  const computerIds = [...new Set(input.computerIds)];
  if (input.imageDigest) {
    if (input.kind !== "recreate") throw new Error("Only a recreate can name an image");
    // Refused here so nothing is queued for an image the policy does not approve; the update
    // checks again before it touches a computer.
    try {
      await assertComputerImageAllowed(
        { ref: `approved@${input.imageDigest}`, digest: input.imageDigest },
        { userId: input.actorUserId, surface: "computer" },
      );
    } catch (error) {
      if (error instanceof PolicyDeniedError) throw new FleetImageNotApprovedError();
      throw error;
    }
  }
  const maxParallel = Math.min(
    Math.max(1, input.maxParallel ?? FLEET_DEFAULT_PARALLEL),
    FLEET_MAX_PARALLEL,
  );
  const create = () =>
    system("create operation", () =>
      deps.prisma.$transaction(async (tx) => {
        const known = await tx.computer.findMany({
          where: { id: { in: computerIds } },
          select: { id: true },
        });
        if (known.length !== computerIds.length) throw new Error("Computer not found");
        const held = await tx.computerFleetItem.findMany({
          where: { computerId: { in: computerIds }, status: { in: OPEN } },
          select: { computerId: true },
        });
        const heldIds = new Set(held.map((item) => item.computerId));
        return tx.computerFleetOperation.create({
          data: {
            kind: input.kind,
            imageDigest: input.imageDigest ?? null,
            actorUserId: input.actorUserId,
            maxParallel,
            haltAfterFailures: Math.max(1, input.haltAfterFailures ?? FLEET_DEFAULT_HALT_AFTER),
            items: {
              create: computerIds.map((computerId) =>
                heldIds.has(computerId)
                  ? {
                      computerId,
                      status: "skipped_busy",
                      outcome: "operation_in_progress",
                      finishedAt: new Date(),
                    }
                  : { computerId },
              ),
            },
          },
          select: { id: true },
        });
      }),
    );
  let operation: { id: string };
  try {
    operation = await create();
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    // A concurrent create took a computer between the check and the insert; look again once.
    try {
      operation = await create();
    } catch (retry) {
      if (isUniqueViolation(retry)) throw new FleetConflictError();
      throw retry;
    }
  }
  await recordSecurityEvent({
    type: "computer.fleet.operation.created",
    userId: input.actorUserId,
    metadata: {
      kind: "computer",
      operation: input.kind,
      operationId: operation.id,
      computers: computerIds.length,
      ...(input.imageDigest ? { imageDigest: input.imageDigest } : {}),
    },
  });
  await settleFleetOperation(deps, operation.id);
  return operation;
}

/** The items allowed to run at once: the first one runs alone, then `maxParallel`. */
const windowFor = (operation: { maxParallel: number }, ran: number) =>
  ran === 0 ? 1 : operation.maxParallel;

/**
 * Publishes a job for as many queued items as the operation's window has room for. A job that
 * finds the window full does nothing; the next finishing item or the reconciler publishes it
 * again, so a lost job only delays an item.
 */
export async function dispatchFleetOperation(deps: EngineDeps, operationId: string): Promise<void> {
  const next = await system("find items to start", async () => {
    const operation = await deps.prisma.computerFleetOperation.findUnique({
      where: { id: operationId },
    });
    if (!operation || operation.finishedAt) return [];
    const [running, ran] = await Promise.all([
      deps.prisma.computerFleetItem.count({
        where: { operationId, status: "running", claimExpiresAt: { gt: new Date() } },
      }),
      deps.prisma.computerFleetItem.count({
        where: { operationId, startedAt: { not: null }, finishedAt: { not: null } },
      }),
    ]);
    const room = windowFor(operation, ran) - running;
    if (room <= 0) return [];
    return deps.prisma.computerFleetItem.findMany({
      where: { operationId, status: "queued" },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      take: room,
      select: { id: true },
    });
  });
  await Promise.all(next.map((item) => deps.jobs.enqueue(fleetItemJob(item.id))));
}

type Transition = {
  type: "computer.fleet.item.skipped" | "computer.fleet.operation.completed";
  computerId?: string;
  outcome?: string;
  status: string;
};

/**
 * Halts the rest of an operation once enough items failed, finishes it when nothing is left to
 * run, and starts the next items. Safe to call from any instance at any time: the operation row
 * is locked while it decides, and a finished operation is left alone.
 */
export async function settleFleetOperation(deps: EngineDeps, operationId: string): Promise<void> {
  const settled = await system("settle operation", () =>
    deps.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM computer_fleet_operations WHERE id = ${operationId} FOR UPDATE`;
      const operation = await tx.computerFleetOperation.findUnique({ where: { id: operationId } });
      if (!operation || operation.finishedAt) return null;
      const transitions: Transition[] = [];
      const failures = await tx.computerFleetItem.count({
        where: { operationId, status: { in: ["failed", "interrupted"] } },
      });
      if (failures >= operation.haltAfterFailures) {
        const queued = await tx.computerFleetItem.findMany({
          where: { operationId, status: "queued" },
          select: { id: true, computerId: true },
        });
        const halted = await tx.computerFleetItem.updateMany({
          where: { id: { in: queued.map((item) => item.id) }, status: "queued" },
          data: { status: "halted", outcome: "halted", finishedAt: new Date() },
        });
        if (halted.count > 0)
          for (const item of queued)
            transitions.push({
              type: "computer.fleet.item.skipped",
              computerId: item.computerId,
              outcome: "halted",
              status: "halted",
            });
      }
      const open = await tx.computerFleetItem.count({
        where: { operationId, status: { in: OPEN } },
      });
      if (open === 0) {
        const bad = await tx.computerFleetItem.count({
          where: { operationId, status: { in: ["failed", "interrupted", "halted"] } },
        });
        const status = bad > 0 ? "completed_with_failures" : "completed";
        await tx.computerFleetOperation.update({
          where: { id: operationId },
          data: { status, finishedAt: new Date() },
        });
        transitions.push({ type: "computer.fleet.operation.completed", status });
      }
      return { operation, transitions };
    }),
  );
  if (!settled) return;
  for (const transition of settled.transitions)
    await recordSecurityEvent({
      type: transition.type,
      userId: settled.operation.actorUserId,
      metadata: {
        kind: "computer",
        operation: settled.operation.kind,
        operationId,
        status: transition.status,
        computerId: transition.computerId,
        outcome: transition.outcome,
      },
    });
  await dispatchFleetOperation(deps, operationId);
}

type Claimed = {
  itemId: string;
  claimId: string;
  operationId: string;
  computerId: string;
  kind: FleetOperationKind;
  imageDigest: string | null;
  actorUserId: string;
};

/**
 * Takes one item for this worker, or nothing when it is finished, owned by a live claim, or the
 * operation's window is full. The operation row is locked while the window is counted, so two
 * instances can never exceed `maxParallel` together; other operations are never touched.
 */
async function claimFleetItem(deps: EngineDeps, itemId: string): Promise<Claimed | null> {
  return system("claim item", async () => {
    const peek = await deps.prisma.computerFleetItem.findUnique({
      where: { id: itemId },
      select: { operationId: true },
    });
    if (!peek) return null;
    return deps.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM computer_fleet_operations WHERE id = ${peek.operationId} FOR UPDATE`;
      const now = new Date();
      const item = await tx.computerFleetItem.findUnique({
        where: { id: itemId },
        include: { operation: true },
      });
      if (!item || item.operation.finishedAt) return null;
      const takeable =
        item.status === "queued" ||
        (item.status === "running" && (item.claimExpiresAt?.getTime() ?? 0) <= now.getTime());
      if (!takeable) return null;
      if (item.attempt >= FLEET_MAX_ATTEMPTS) return null;
      const [running, ran] = await Promise.all([
        tx.computerFleetItem.count({
          where: {
            operationId: item.operationId,
            id: { not: itemId },
            status: "running",
            claimExpiresAt: { gt: now },
          },
        }),
        tx.computerFleetItem.count({
          where: {
            operationId: item.operationId,
            startedAt: { not: null },
            finishedAt: { not: null },
          },
        }),
      ]);
      if (running >= windowFor(item.operation, ran)) return null;
      const claimId = randomUUID();
      await tx.computerFleetItem.update({
        where: { id: itemId },
        data: {
          status: "running",
          claimId,
          claimExpiresAt: new Date(now.getTime() + FLEET_CLAIM_MS),
          attempt: { increment: 1 },
          startedAt: item.startedAt ?? now,
        },
      });
      if (item.operation.status === "queued")
        await tx.computerFleetOperation.update({
          where: { id: item.operationId },
          data: { status: "running" },
        });
      return {
        itemId,
        claimId,
        operationId: item.operationId,
        computerId: item.computerId,
        kind: item.operation.kind as FleetOperationKind,
        imageDigest: item.operation.imageDigest,
        actorUserId: item.operation.actorUserId,
      };
    });
  });
}

type Result = RecreateResult;

async function executeItem(deps: RunDeps, claimed: Claimed, signal: AbortSignal): Promise<Result> {
  if (claimed.kind === "recreate") return recreateComputer(deps, claimed, signal);
  if (claimed.kind === "terminate") return terminateComputer(deps, claimed, signal);
  const computer = await system("read computer", () =>
    deps.prisma.computer.findUnique({
      where: { id: claimed.computerId },
      select: {
        id: true,
        kind: true,
        state: true,
        spaceId: true,
        userId: true,
        adminQuarantinedAt: true,
        bots: { where: { archivedAt: null }, select: { id: true, userId: true }, take: 1 },
      },
    }),
  );
  if (!computer) return { status: "failed", outcome: "computer_missing" };
  if (!computerSupportsHibernate(computer.kind))
    return { status: "skipped_unsupported", outcome: "provider_unsupported" };
  if (computer.kind !== deps.sandbox.describe().id)
    return { status: "skipped_unsupported", outcome: "provider_unavailable" };
  const tenant = { spaceId: computer.spaceId, userId: computer.userId };
  if (claimed.kind === "hibernate") {
    if (computer.state === "suspended" || computer.state === "stopped")
      return { status: "succeeded", outcome: "already_hibernated" };
    const outcome = await runAsTenant(tenant, () =>
      sleepComputerWithOutcome(deps, computer.id, { now: true }),
    );
    if (outcome === "suspended")
      return { status: "succeeded", outcome: "hibernated", changed: true };
    if (outcome === "busy") return { status: "skipped_busy", outcome: "busy" };
    if (outcome === "deferred") return { status: "failed", outcome: "deferred" };
    return { status: "failed", outcome: "not_running" };
  }
  if (computer.adminQuarantinedAt) return { status: "skipped_unsupported", outcome: "quarantined" };
  if (computer.state === "running") return { status: "succeeded", outcome: "already_running" };
  if (computer.state === "booting" || computer.state === "suspending")
    return { status: "skipped_busy", outcome: "busy" };
  if (computer.state !== "suspended" && computer.state !== "stopped")
    return { status: "failed", outcome: "needs_recovery" };
  const bot = computer.bots[0];
  if (!bot) return { status: "failed", outcome: "no_bot" };
  try {
    await runAsTenant(tenant, async () => {
      await provisionComputer(
        deps,
        computer.id,
        {
          operationId: `fleet:${claimed.itemId}`,
          traceId: `fleet:${claimed.itemId}`,
          botId: bot.id,
          spaceId: computer.spaceId,
          userId: bot.userId,
          signal,
        },
        "none",
      );
      // Nothing runs on it yet, so let it go back to sleep when it stays idle.
      scheduleComputerSleep(deps.jobs, computer.id);
    });
  } catch (error) {
    if (error instanceof ComputerBusyError) return { status: "skipped_busy", outcome: "busy" };
    if (error instanceof SandboxAllowanceUsedError)
      return { status: "failed", outcome: "allowance_used" };
    // Provider errors can carry credentials or private URLs; log them, store only a code.
    getLogger().error("fleet.wake_failed", error, { "computer.id": computer.id });
    return { status: "failed", outcome: "failed" };
  }
  return { status: "succeeded", outcome: "woken", changed: true };
}

/**
 * Runs one item: claims it, keeps the claim alive while the work runs, records the outcome and
 * moves the operation on. A duplicate delivery, a second instance or a stale worker finds the
 * item taken or finished and does nothing, so a computer is never stopped or started twice.
 */
export async function runFleetItem(deps: RunDeps, itemId: string): Promise<void> {
  const claimed = await claimFleetItem(deps, itemId);
  if (!claimed) return;
  const controller = new AbortController();
  const heartbeat = setInterval(() => {
    void system("renew claim", () =>
      deps.prisma.computerFleetItem.updateMany({
        where: { id: itemId, claimId: claimed.claimId, status: "running" },
        data: { claimExpiresAt: new Date(Date.now() + FLEET_CLAIM_MS) },
      }),
    ).then(
      (renewed) => {
        if (renewed.count !== 1) controller.abort();
      },
      () => controller.abort(),
    );
  }, FLEET_HEARTBEAT_MS);
  let result: Result;
  try {
    result = await executeItem(deps, claimed, controller.signal);
  } catch (error) {
    getLogger().error("fleet.item_failed", error, { "fleet.item.id": itemId });
    result = { status: "failed", outcome: "failed" };
  } finally {
    clearInterval(heartbeat);
  }
  const finished = await system("finish item", () =>
    deps.prisma.computerFleetItem.updateMany({
      where: { id: itemId, claimId: claimed.claimId, status: "running" },
      data: {
        status: result.status,
        outcome: result.outcome,
        finishedAt: new Date(),
        claimId: null,
        claimExpiresAt: null,
      },
    }),
  );
  // The claim was lost to a newer owner, who records the outcome instead.
  if (finished.count !== 1) return;
  const computer = await system("read computer for audit", () =>
    deps.prisma.computer.findUnique({
      where: { id: claimed.computerId },
      select: { spaceId: true, kind: true },
    }),
  );
  const base = {
    userId: claimed.actorUserId,
    spaceId: computer?.spaceId ?? null,
  };
  const metadata = {
    kind: "computer",
    operation: claimed.kind,
    operationId: claimed.operationId,
    computerId: claimed.computerId,
    provider: computer?.kind,
    outcome: result.outcome,
  };
  await recordSecurityEvent({
    ...base,
    type:
      result.status === "succeeded"
        ? "computer.fleet.item.succeeded"
        : result.status === "failed"
          ? "computer.fleet.item.failed"
          : "computer.fleet.item.skipped",
    metadata,
  });
  if (result.changed) {
    // Recreate and terminate also say what the home and image were before and after.
    const recorded = ["recreate", "terminate"].includes(claimed.kind)
      ? await system("read item before", () =>
          deps.prisma.computerFleetItem.findUnique({
            where: { id: itemId },
            select: { imageDigestBefore: true, homeRevisionBefore: true },
          }),
        )
      : null;
    await recordSecurityEvent({
      ...base,
      type: CHANGED_EVENT[claimed.kind],
      metadata: recorded
        ? {
            ...metadata,
            homeRevisionBefore: recorded.homeRevisionBefore ?? null,
            homeRevisionAfter: result.record?.homeRevisionAfter ?? null,
            ...(claimed.kind === "recreate"
              ? {
                  imageDigestBefore: recorded.imageDigestBefore ?? null,
                  imageDigestAfter: result.record?.imageDigestAfter ?? null,
                }
              : {}),
          }
        : metadata,
    });
  }
  await settleFleetOperation(deps, claimed.operationId);
}

/**
 * Repairs what a crash leaves behind: an item whose worker stopped renewing goes back to the
 * queue (hibernate and wake are safe to run again), or is marked `interrupted` after too many
 * tries; unfinished operations are settled and their next items republished. Idempotent, so every
 * instance may run it; the leader-held reconciler pass does.
 */
export async function reconcileFleetOperations(deps: EngineDeps): Promise<void> {
  const now = new Date();
  const expired = await system("find expired claims", () =>
    deps.prisma.computerFleetItem.findMany({
      where: { status: "running", claimExpiresAt: { lte: now } },
      select: { id: true, attempt: true, operationId: true },
      take: 500,
    }),
  );
  for (const item of expired)
    await system("release expired claim", () =>
      deps.prisma.computerFleetItem.updateMany({
        where: { id: item.id, status: "running", claimExpiresAt: { lte: now } },
        data:
          item.attempt >= FLEET_MAX_ATTEMPTS
            ? {
                status: "interrupted",
                outcome: "interrupted",
                finishedAt: now,
                claimId: null,
                claimExpiresAt: null,
              }
            : { status: "queued", claimId: null, claimExpiresAt: null },
      }),
    );
  const operations = await system("find unfinished operations", () =>
    deps.prisma.computerFleetOperation.findMany({
      where: { finishedAt: null },
      orderBy: { createdAt: "asc" },
      take: OPERATIONS_PER_PASS,
      select: { id: true },
    }),
  );
  for (const operation of operations) await settleFleetOperation(deps, operation.id);
}
