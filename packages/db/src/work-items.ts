import type { TicketWork, WorkItem, WorkPhase } from "@rakazo/contracts";
import { workPhase } from "@rakazo/contracts";
import { coerceTicketStatus, ensureBoard, toTicketDto } from "./board.js";
import type { PrismaClient } from "./client.js";

const WORK_RUNS_LIMIT = 50;

/**
 * Tickets with their phase, newest activity first. This is the read function for
 * dashboards: filter by assignee bot, creating user, or phase.
 */
export async function listWorkItems(
  prisma: PrismaClient,
  spaceId: string,
  filter: {
    assigneeBotId?: string;
    createdByUserId?: string;
    /** Tickets this user created or that are assigned to a bot this user owns. */
    involvingUserId?: string;
    phases?: WorkPhase[];
  } = {},
): Promise<WorkItem[]> {
  const board = await ensureBoard(prisma, spaceId);
  const rows = await prisma.ticket.findMany({
    where: {
      spaceId,
      boardId: board.id,
      ...(filter.assigneeBotId ? { assigneeBotId: filter.assigneeBotId } : {}),
      ...(filter.createdByUserId ? { createdByUserId: filter.createdByUserId } : {}),
      ...(filter.involvingUserId
        ? {
            OR: [
              { createdByUserId: filter.involvingUserId },
              { assigneeBot: { userId: filter.involvingUserId, spaceId } },
            ],
          }
        : {}),
      // Done and cancelled tickets only ever read as those phases, so open-work lists skip them.
      ...(filter.phases && !filter.phases.some((phase) => phase === "done" || phase === "cancelled")
        ? { status: { notIn: ["done", "closed"] } }
        : {}),
    },
    orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
  });
  if (rows.length === 0) return [];
  const tasks = await prisma.task.findMany({
    where: { spaceId, ticketId: { in: rows.map((row) => row.id) } },
    select: {
      ticketId: true,
      runs: {
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: 1,
        select: { status: true, createdAt: true },
      },
    },
  });
  // The newest run across a ticket's tasks decides its phase.
  const latest = new Map<string, { status: string; createdAt: Date }>();
  for (const task of tasks) {
    const run = task.runs[0];
    if (!task.ticketId || !run) continue;
    const known = latest.get(task.ticketId);
    if (!known || run.createdAt > known.createdAt) latest.set(task.ticketId, run);
  }
  const items = rows.map((row) => ({
    ...toTicketDto(row, board.ticketPrefix),
    phase: workPhase(coerceTicketStatus(row.status), latest.get(row.id)?.status ?? null),
  }));
  const phases = filter.phases;
  return phases ? items.filter((item) => phases.includes(item.phase)) : items;
}

/** One ticket's phase, the runs that worked on it, and the artifacts those runs produced. */
export async function getTicketWork(
  prisma: PrismaClient,
  spaceId: string,
  ticket: { id: string; status: string },
): Promise<TicketWork> {
  const runs = await prisma.run.findMany({
    where: { spaceId, task: { ticketId: ticket.id } },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: WORK_RUNS_LIMIT,
    select: {
      id: true,
      status: true,
      trigger: true,
      error: true,
      threadId: true,
      createdAt: true,
      completedAt: true,
    },
  });
  const artifacts = runs.length
    ? await prisma.artifact.findMany({
        where: { spaceId, runId: { in: runs.map((run) => run.id) } },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        select: {
          id: true,
          name: true,
          mimeType: true,
          version: true,
          runId: true,
          createdAt: true,
        },
      })
    : [];
  return {
    ticketId: ticket.id,
    phase: workPhase(coerceTicketStatus(ticket.status), runs[0]?.status ?? null),
    runs: runs.map((run) => ({
      ...run,
      createdAt: run.createdAt.toISOString(),
      completedAt: run.completedAt ? run.completedAt.toISOString() : null,
    })),
    artifacts: artifacts.flatMap((artifact) =>
      artifact.runId
        ? [{ ...artifact, runId: artifact.runId, createdAt: artifact.createdAt.toISOString() }]
        : [],
    ),
  };
}
