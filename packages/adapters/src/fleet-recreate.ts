import type { AdapterContext, SandboxProvider } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import { runAsSystem, runAsTenant } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import { ComputerBusyError, computerSupportsUpdate } from "./computer-lifecycle.js";
import { toComputerRef } from "./computer-support.js";
import { queueComputerUpdate } from "./computer-update.js";

const TERMINAL_UPDATE = ["completed", "failed", "dismissed", "interrupted"];
const POLL_MS = 1_000;
/** Longest a recreate waits for its update; the item's claim is renewed meanwhile. */
const WAIT_MS = 30 * 60_000;
const PROFILES = ".browser-profiles";

type Deps = Pick<Parameters<typeof queueComputerUpdate>[0], "prisma" | "jobs" | "events"> & {
  sandbox: SandboxProvider;
  pollMs?: number;
};

export type RecreateItem = {
  itemId: string;
  claimId: string;
  computerId: string;
  /** An approved image digest; null keeps the provider's own image. */
  imageDigest: string | null;
};

export type RecreateResult = {
  status: "succeeded" | "failed" | "skipped_unsupported" | "skipped_busy";
  outcome: string;
  changed?: boolean;
  /** Before and after, for the audit event. */
  record?: { imageDigestAfter?: string | null; homeRevisionAfter?: string };
};

const system = <T>(what: string, fn: () => Promise<T>) =>
  runAsSystem(`fleet recreate: ${what}`, fn);

/**
 * Rebuilds one idle computer from a fresh image without touching its home. The work is the
 * existing computer update (save the home, destroy, provision), queued under the item's id so a
 * replayed item follows the same update instead of tearing the computer down twice. The update
 * refuses a busy computer and never cancels a run, so a busy computer is skipped. Afterwards the
 * image, the saved home and the browser profiles are checked, and the before and after are
 * recorded on the item.
 */
export async function recreateComputer(
  deps: Deps,
  item: RecreateItem,
  signal: AbortSignal,
): Promise<RecreateResult> {
  const computer = await system("read computer", () =>
    deps.prisma.computer.findUnique({
      where: { id: item.computerId },
      select: {
        id: true,
        kind: true,
        state: true,
        spaceId: true,
        userId: true,
        homeKey: true,
        providerRef: true,
        homeRevision: true,
        imageDigest: true,
        observation: { select: { imageDigest: true } },
        bots: { where: { archivedAt: null }, select: { id: true, userId: true }, take: 1 },
      },
    }),
  );
  if (!computer) return { status: "failed", outcome: "computer_missing" };
  const descriptor = deps.sandbox.describe();
  if (!computerSupportsUpdate(computer.kind))
    return { status: "skipped_unsupported", outcome: "provider_unsupported" };
  if (computer.kind !== descriptor.id)
    return { status: "skipped_unsupported", outcome: "provider_unavailable" };
  if (item.imageDigest && !descriptor.capabilities.fleet?.imageSelection)
    return { status: "skipped_unsupported", outcome: "image_selection_unsupported" };
  const bot = computer.bots[0];
  const tenant = { spaceId: computer.spaceId, userId: computer.userId };
  const context: AdapterContext = {
    operationId: `fleet:${item.itemId}`,
    traceId: `fleet:${item.itemId}`,
    spaceId: computer.spaceId,
    userId: bot?.userId ?? computer.userId,
    ...(bot ? { botId: bot.id } : {}),
    signal,
  };
  const profiles = async () => {
    if (!computer.providerRef) return null;
    try {
      return (await deps.sandbox.listFiles(toComputerRef(computer), PROFILES, context)).length;
    } catch {
      return null;
    }
  };
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
    if (computer.state !== "running")
      return { status: "skipped_unsupported", outcome: "not_running" };
    if (!bot) return { status: "failed", outcome: "no_bot" };
    await record({
      imageDigestBefore: computer.observation?.imageDigest ?? computer.imageDigest,
      homeRevisionBefore: computer.homeRevision,
      browserProfilesBefore: await profiles(),
    });
    try {
      const queued = await runAsTenant(tenant, () =>
        queueComputerUpdate(deps, computer.id, bot.id, "update", {
          ...(item.imageDigest ? { targetImageDigest: item.imageDigest } : {}),
          idempotencyKey: item.itemId,
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
    // The stage says how far it got: before "recreating" the old computer was never destroyed.
    const outcome =
      finished.status === "interrupted"
        ? "interrupted"
        : finished.stage === "saving"
          ? "failed_checkpoint"
          : finished.stage === "recreating"
            ? "failed_provision"
            : "failed";
    return { status: "failed", outcome };
  }
  return verify(deps, item, context, profiles);
}

export async function waitForUpdate(
  deps: Pick<Deps, "prisma" | "pollMs">,
  tenant: { spaceId: string; userId: string },
  updateId: string,
  signal: AbortSignal,
) {
  const until = Date.now() + WAIT_MS;
  while (Date.now() < until) {
    signal.throwIfAborted();
    const update = await runAsTenant(tenant, () =>
      deps.prisma.computerUpdate.findUnique({
        where: { id: updateId },
        select: { status: true, stage: true },
      }),
    );
    if (!update || TERMINAL_UPDATE.includes(update.status))
      return update ?? { status: "failed", stage: "" };
    await new Promise((resolve) => setTimeout(resolve, deps.pollMs ?? POLL_MS));
  }
  return null;
}

/**
 * The replacement must run the image asked for, hold a saved home when the old one did, and
 * still have the browser profiles it had. A mismatch fails the item and says so; it is never
 * reported as a success.
 */
async function verify(
  deps: Deps,
  item: RecreateItem,
  context: AdapterContext,
  profilesNow: () => Promise<number | null>,
): Promise<RecreateResult> {
  const [after, before] = await Promise.all([
    system("read computer", () =>
      deps.prisma.computer.findUnique({
        where: { id: item.computerId },
        select: {
          kind: true,
          homeKey: true,
          providerRef: true,
          homeRevision: true,
          imageDigest: true,
        },
      }),
    ),
    system("read item", () =>
      deps.prisma.computerFleetItem.findUnique({
        where: { id: item.itemId },
        select: { homeRevisionBefore: true, browserProfilesBefore: true },
      }),
    ),
  ]);
  if (!after) return { status: "failed", outcome: "computer_missing" };
  let runningDigest: string | null = null;
  if (after.providerRef && deps.sandbox.describe().capabilities.fleet?.inspect) {
    try {
      runningDigest =
        (await deps.sandbox.inspect?.(toComputerRef(after), context))?.image?.digest ?? null;
    } catch (error) {
      getLogger().warn("fleet.recreate_inspect_failed", { "computer.id": item.computerId, error });
    }
  }
  const imageDigestAfter = runningDigest ?? after.imageDigest;
  const recorded = { imageDigestAfter, homeRevisionAfter: after.homeRevision };
  const wrongImage =
    item.imageDigest !== null &&
    (after.imageDigest !== item.imageDigest ||
      (runningDigest !== null && runningDigest !== item.imageDigest));
  const lostHome =
    Boolean(before?.homeRevisionBefore) &&
    before?.homeRevisionBefore !== "empty" &&
    after.homeRevision === "empty";
  const profileCount = await profilesNow();
  const lostProfiles =
    before?.browserProfilesBefore != null &&
    before.browserProfilesBefore > 0 &&
    (profileCount ?? 0) < before.browserProfilesBefore;
  await system("record result", () =>
    deps.prisma.computerFleetItem.updateMany({
      where: { id: item.itemId, claimId: item.claimId },
      data: { imageDigestAfter, homeRevisionAfter: after.homeRevision },
    }),
  );
  if (wrongImage || lostHome || lostProfiles)
    return { status: "failed", outcome: "failed_verify", record: recorded };
  return { status: "succeeded", outcome: "recreated", changed: true, record: recorded };
}
