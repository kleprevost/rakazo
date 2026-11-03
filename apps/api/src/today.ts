import type {
  Actor,
  TodayArtifact,
  TodayAttention,
  TodaySummary,
  TodayWorkItem,
} from "@rakazo/contracts";
import {
  MessageBlock,
  TODAY_COMPLETED_WINDOW_HOURS,
  TODAY_FAILED_WINDOW_DAYS,
  TODAY_WORK_PHASES,
} from "@rakazo/contracts";
import {
  ACTIVE_RUN_STATUSES,
  BACKGROUND_RUN_TRIGGERS,
  runFailureError,
  WORKING_RUN_STATUSES,
} from "@rakazo/core";
import type { Prisma, PrismaClient } from "@rakazo/db";
import { listWorkItems } from "@rakazo/db";
import { activityPreview } from "./runs.js";

const ACTIVE_LIMIT = 50;
const COMPLETED_FETCH = 50;
const COMPLETED_LIMIT = 10;
const FAILED_LIMIT = 20;
const UPCOMING_LIMIT = 10;
const ARTIFACTS_PER_RUN = 3;
const WORK_LIMIT = 20;
const ASK_TEXT_MAX = 300;
/** Chat replies are not "work done"; these runs started without a person typing. */
const AUTONOMOUS_TRIGGERS = ["routine", "webhook", "spawn", "bot_message", "cloud_agent"];
/** Quick actions are limited to the plain yes/no of an approval card. */
const QUICK_ACTION_IDS = ["allow", "deny"];

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

type RunRow = Awaited<ReturnType<typeof loadRuns>>[number];

function loadRuns(
  prisma: PrismaClient,
  actor: Actor,
  where: Prisma.RunWhereInput,
  order: "updatedAt" | "completedAt",
  take: number,
) {
  return prisma.run.findMany({
    where: {
      spaceId: actor.spaceId,
      userId: actor.userId,
      bot: { archivedAt: null },
      // Background ticket work belongs on the board.
      trigger: { notIn: [...BACKGROUND_RUN_TRIGGERS] },
      ...where,
    },
    include: {
      bot: { select: { name: true } },
      task: { select: { prompt: true } },
      routine: { select: { name: true } },
      sourceMessage: { select: { blocks: true } },
      thread: { select: { groupId: true } },
    },
    orderBy: [{ [order]: "desc" }, { id: "desc" }],
    take,
  });
}

function runBase(row: RunRow) {
  return {
    runId: row.id,
    botId: row.botId,
    botName: row.bot.name,
    groupId: row.thread.groupId,
  };
}

function runTitle(row: RunRow): string {
  return (
    row.routine?.name ||
    activityPreview({
      trigger: row.trigger,
      prompt: row.task.prompt,
      sourceBlocks: row.sourceMessage?.blocks,
    }).promptSnippet
  );
}

function runDto(row: RunRow, artifacts: Map<string, TodayArtifact[]>, finished: boolean) {
  return {
    ...runBase(row),
    status: row.status as TodaySummary["active"][number]["status"],
    trigger: row.trigger as TodaySummary["active"][number]["trigger"],
    title: runTitle(row),
    routineId: row.routineId,
    at: (finished ? (row.completedAt ?? row.updatedAt) : row.updatedAt).toISOString(),
    artifacts: artifacts.get(row.id) ?? [],
  };
}

/** The newest unanswered ask in each waiting run, which is what the user is being asked. */
async function pendingAsks(prisma: PrismaClient, rows: RunRow[]) {
  const asks = new Map<
    string,
    { messageId: string; block: Extract<MessageBlock, { kind: "ask" }> }
  >();
  if (rows.length === 0) return asks;
  const threadByRun = new Map(rows.map((row) => [row.id, row.threadId]));
  const messages = await prisma.message.findMany({
    where: { runId: { in: [...threadByRun.keys()] }, role: "bot" },
    select: { id: true, runId: true, threadId: true, blocks: true },
    orderBy: { seq: "desc" },
    take: rows.length * 20,
  });
  for (const message of messages) {
    if (!message.runId || asks.has(message.runId)) continue;
    if (threadByRun.get(message.runId) !== message.threadId) continue;
    if (!Array.isArray(message.blocks)) continue;
    for (const raw of message.blocks as unknown[]) {
      if ((raw as { kind?: unknown } | null)?.kind !== "ask") continue;
      const parsed = MessageBlock.safeParse(raw);
      if (!parsed.success || parsed.data.kind !== "ask" || parsed.data.status === "answered")
        continue;
      asks.set(message.runId, { messageId: message.id, block: parsed.data });
      break;
    }
  }
  return asks;
}

function clip(text: string, max = ASK_TEXT_MAX): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length <= max ? oneLine : `${oneLine.slice(0, max - 1)}…`;
}

/** A failed run stays on the list until something newer has run in its chat or routine. */
async function supersededKeys(prisma: PrismaClient, actor: Actor, failed: RunRow[]) {
  const key = (row: RunRow) => row.routineId ?? row.threadId;
  const keys = new Map<string, Date>();
  for (const row of failed) {
    const at = keys.get(key(row));
    if (!at || row.createdAt > at) keys.set(key(row), row.createdAt);
  }
  if (keys.size === 0) return new Set<string>();
  const ids = [...keys.keys()];
  const newer = await prisma.run.findMany({
    where: {
      spaceId: actor.spaceId,
      userId: actor.userId,
      status: { in: ["completed", ...ACTIVE_RUN_STATUSES] },
      createdAt: { gt: new Date(Math.min(...[...keys.values()].map((d) => d.getTime()))) },
      OR: [{ routineId: { in: ids } }, { routineId: null, threadId: { in: ids } }],
    },
    select: { routineId: true, threadId: true, createdAt: true },
  });
  const superseded = new Set<string>();
  for (const row of newer) {
    const k = row.routineId ?? row.threadId;
    const failedAt = keys.get(k);
    if (failedAt && row.createdAt > failedAt) superseded.add(k);
  }
  return superseded;
}

async function artifactsByRun(prisma: PrismaClient, actor: Actor, runIds: string[]) {
  const byRun = new Map<string, TodayArtifact[]>();
  if (runIds.length === 0) return byRun;
  const rows = await prisma.artifact.findMany({
    where: { spaceId: actor.spaceId, userId: actor.userId, runId: { in: runIds } },
    select: { id: true, runId: true, name: true, mimeType: true },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
  });
  for (const row of rows) {
    if (!row.runId) continue;
    const list = byRun.get(row.runId) ?? [];
    if (list.length < ARTIFACTS_PER_RUN)
      list.push({ id: row.id, name: row.name, mimeType: row.mimeType });
    byRun.set(row.runId, list);
  }
  return byRun;
}

/**
 * Open assignments the user created or that sit with one of their bots. Another user's bot is
 * never named, so a ticket handed to a colleague's bot shows without an assignee.
 */
async function workItems(prisma: PrismaClient, actor: Actor): Promise<TodayWorkItem[]> {
  const items = await listWorkItems(prisma, actor.spaceId, {
    involvingUserId: actor.userId,
    phases: [...TODAY_WORK_PHASES],
  });
  const shown = items.slice(0, WORK_LIMIT);
  const botIds = [
    ...new Set(shown.flatMap((item) => (item.assigneeBotId ? [item.assigneeBotId] : []))),
  ];
  const bots = botIds.length
    ? await prisma.bot.findMany({
        where: { id: { in: botIds }, spaceId: actor.spaceId, userId: actor.userId },
        select: { id: true, name: true },
      })
    : [];
  const names = new Map(bots.map((bot) => [bot.id, bot.name]));
  return shown.flatMap((item) =>
    item.phase === "running" ||
    item.phase === "waiting" ||
    item.phase === "review" ||
    item.phase === "failed"
      ? [
          {
            id: item.id,
            ref: item.ref,
            title: item.title,
            phase: item.phase,
            botId: item.assigneeBotId && names.has(item.assigneeBotId) ? item.assigneeBotId : null,
            botName: (item.assigneeBotId && names.get(item.assigneeBotId)) || null,
            at: item.updatedAt,
          },
        ]
      : [],
  );
}

/**
 * A read model over runs, asks, routines and artifacts for one signed-in user in one space.
 * Every query is scoped to the actor's space and user, so it shows only that user's bots.
 */
export async function todaySummary(
  prisma: PrismaClient,
  actor: Actor,
  now = new Date(),
  options: { workItems?: boolean } = {},
): Promise<TodaySummary> {
  const completedSince = new Date(now.getTime() - TODAY_COMPLETED_WINDOW_HOURS * HOUR_MS);
  const failedSince = new Date(now.getTime() - TODAY_FAILED_WINDOW_DAYS * DAY_MS);
  const [active, completedRaw, failedRaw, routines, work] = await Promise.all([
    loadRuns(
      prisma,
      actor,
      { status: { in: [...ACTIVE_RUN_STATUSES] } },
      "updatedAt",
      ACTIVE_LIMIT,
    ),
    loadRuns(
      prisma,
      actor,
      { status: "completed", completedAt: { gte: completedSince } },
      "completedAt",
      COMPLETED_FETCH,
    ),
    loadRuns(
      prisma,
      actor,
      { status: "failed", updatedAt: { gte: failedSince } },
      "updatedAt",
      FAILED_LIMIT * 2,
    ),
    prisma.routine.findMany({
      where: {
        spaceId: actor.spaceId,
        userId: actor.userId,
        active: true,
        nextRunAt: { not: null },
        bot: { archivedAt: null },
      },
      include: { bot: { select: { name: true } }, thread: { select: { groupId: true } } },
      orderBy: [{ nextRunAt: "asc" }, { id: "asc" }],
      take: UPCOMING_LIMIT,
    }),
    options.workItems ? workItems(prisma, actor) : [],
  ]);

  const waitingInput = active.filter((row) => row.status === "waiting_input");
  const [asks, superseded, completedArtifacts] = await Promise.all([
    pendingAsks(prisma, waitingInput),
    supersededKeys(prisma, actor, failedRaw),
    artifactsByRun(
      prisma,
      actor,
      completedRaw.map((row) => row.id),
    ),
  ]);

  const attention: TodayAttention[] = [];
  for (const row of waitingInput) {
    const ask = asks.get(row.id);
    if (!ask) continue;
    const base = {
      ...runBase(row),
      key: `ask:${ask.messageId}`,
      title: runTitle(row),
      at: row.updatedAt.toISOString(),
      messageId: ask.messageId,
    };
    const actions = (ask.block.actions ?? []).filter((action) =>
      QUICK_ACTION_IDS.includes(action.id),
    );
    if (
      ask.block.approvalEffectId &&
      ask.block.input !== "secret" &&
      QUICK_ACTION_IDS.every((id) => actions.some((action) => action.id === id))
    ) {
      attention.push({
        ...base,
        kind: "approval",
        text: clip(ask.block.text),
        actions: actions.map(({ id, label }) => ({ id, label })),
      });
    } else {
      attention.push({ ...base, kind: "question", text: clip(ask.block.text) });
    }
  }
  const failed = failedRaw
    .filter((row) => !superseded.has(row.routineId ?? row.threadId))
    // One entry per routine or chat: the newest failure stands for the rest.
    .filter(
      (row, index, rows) =>
        rows.findIndex(
          (other) => (other.routineId ?? other.threadId) === (row.routineId ?? row.threadId),
        ) === index,
    )
    .slice(0, FAILED_LIMIT);
  for (const row of failed) {
    const base = {
      ...runBase(row),
      key: `failed:${row.id}`,
      title: runTitle(row),
      at: (row.completedAt ?? row.updatedAt).toISOString(),
      error: runFailureError({ type: "run.failed", payload: { error: row.error } }),
    };
    attention.push(
      row.routineId
        ? { ...base, kind: "failed_routine", routineId: row.routineId }
        : { ...base, kind: "failed_run" },
    );
  }

  const completedAll = completedRaw.filter(
    (row) => AUTONOMOUS_TRIGGERS.includes(row.trigger) || completedArtifacts.has(row.id),
  );
  const completed = completedAll.slice(0, COMPLETED_LIMIT);
  const working = active.filter((row) =>
    (WORKING_RUN_STATUSES as readonly string[]).includes(row.status),
  );

  return {
    generatedAt: now.toISOString(),
    counts: {
      working: working.length,
      waiting: active.length - working.length,
      attention: attention.length,
      completed: completedAll.length,
    },
    attention,
    active: active.map((row) => runDto(row, new Map(), false)),
    completed: completed.map((row) => runDto(row, completedArtifacts, true)),
    upcoming: routines.flatMap((row) =>
      row.nextRunAt
        ? [
            {
              botId: row.botId,
              botName: row.bot.name,
              groupId: row.thread?.groupId ?? null,
              routineId: row.id,
              name: row.name,
              nextRunAt: row.nextRunAt.toISOString(),
            },
          ]
        : [],
    ),
    work,
  };
}
