import type { SandboxProvider } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import { runAsSystem, runAsTenant } from "@rakazo/db";
import { ComputerBusyError, computerSupportsUpdate } from "./computer-lifecycle.js";
import { queueComputerUpdate } from "./computer-update.js";
import type { RecreateItem, RecreateResult } from "./fleet-recreate.js";
import { waitForUpdate } from "./fleet-recreate.js";

type Deps = Pick<Parameters<typeof queueComputerUpdate>[0], "prisma" | "jobs" | "events"> & {
  sandbox: SandboxProvider;
  pollMs?: number;
};

export type TerminateItem = Omit<RecreateItem, "imageDigest">;

const system = <T>(what: string, fn: () => Promise<T>) =>
  runAsSystem(`fleet terminate: ${what}`, fn);

/**
 * Destroys one idle computer's machine and keeps its home. The work is the existing computer
 * update with no replacement: save the home, destroy, mark the computer stopped, so the next use
 * starts it again from the saved home. It is queued under the item's id, so a replayed item
 * follows the same update and never destroys twice. A busy computer is skipped and a failed save
 * leaves the machine running; nothing is cancelled and nothing is destroyed unsaved.
 */
export async function terminateComputer(
  deps: Deps,
  item: TerminateItem,
  signal: AbortSignal,
): Promise<RecreateResult> {
  const computer = await system("read computer", () =>
    deps.prisma.computer.findUnique({
      where: { id: item.computerId },
      select: {
        kind: true,
        state: true,
        spaceId: true,
        userId: true,
        providerRef: true,
        homeRevision: true,
        bots: { where: { archivedAt: null }, select: { id: true }, take: 1 },
      },
    }),
  );
  if (!computer) return { status: "failed", outcome: "computer_missing" };
  if (!computerSupportsUpdate(computer.kind))
    return { status: "skipped_unsupported", outcome: "provider_unsupported" };
  if (computer.kind !== deps.sandbox.describe().id)
    return { status: "skipped_unsupported", outcome: "provider_unavailable" };
  const tenant = { spaceId: computer.spaceId, userId: computer.userId };
  const record = (data: Parameters<PrismaClient["computerFleetItem"]["updateMany"]>[0]["data"]) =>
    system("record item", () =>
      deps.prisma.computerFleetItem.updateMany({
        where: { id: item.itemId, claimId: item.claimId },
        data,
      }),
    );

  const prior = await runAsTenant(tenant, () =>
    deps.prisma.computerUpdate.findUnique({
      where: { idempotencyKey: item.itemId },
      select: { id: true },
    }),
  );
  let updateId = prior?.id;
  if (!updateId) {
    if (computer.state === "stopped" && !computer.providerRef)
      return { status: "succeeded", outcome: "already_terminated" };
    if (computer.state !== "running")
      return { status: "skipped_unsupported", outcome: "not_running" };
    const bot = computer.bots[0];
    if (!bot) return { status: "failed", outcome: "no_bot" };
    await record({ homeRevisionBefore: computer.homeRevision });
    try {
      const queued = await runAsTenant(tenant, () =>
        queueComputerUpdate(deps, item.computerId, bot.id, "update", {
          idempotencyKey: item.itemId,
          stopOnly: true,
        }),
      );
      updateId = queued.id;
    } catch (error) {
      if (error instanceof ComputerBusyError) return { status: "skipped_busy", outcome: "busy" };
      throw error;
    }
  }
  await record({ computerUpdateId: updateId });

  const finished = await waitForUpdate(deps, tenant, updateId, signal);
  if (!finished) return { status: "failed", outcome: "timeout" };
  if (finished.status !== "completed") {
    // The stage says how far it got: before "recreating" nothing was destroyed.
    const outcome =
      finished.status === "interrupted"
        ? "interrupted"
        : finished.stage === "saving"
          ? "failed_checkpoint"
          : finished.stage === "recreating"
            ? "failed_destroy"
            : "failed";
    return { status: "failed", outcome };
  }
  const [after, before] = await Promise.all([
    system("read computer", () =>
      deps.prisma.computer.findUnique({
        where: { id: item.computerId },
        select: { homeRevision: true },
      }),
    ),
    system("read item", () =>
      deps.prisma.computerFleetItem.findUnique({
        where: { id: item.itemId },
        select: { homeRevisionBefore: true },
      }),
    ),
  ]);
  if (!after) return { status: "failed", outcome: "computer_missing" };
  await record({ homeRevisionAfter: after.homeRevision });
  const recorded = { homeRevisionAfter: after.homeRevision };
  // The home is what survives a terminate; one that was saved and now reads empty is a failure.
  const lostHome =
    Boolean(before?.homeRevisionBefore) &&
    before?.homeRevisionBefore !== "empty" &&
    after.homeRevision === "empty";
  if (lostHome) return { status: "failed", outcome: "failed_verify", record: recorded };
  return { status: "succeeded", outcome: "terminated", changed: true, record: recorded };
}
