import type { Assignment, AssignmentWork, TicketStatus } from "@rakazo/contracts";
import { assignmentPhase } from "@rakazo/contracts";
import { coerceTicketStatus } from "./board.js";
import type { PrismaClient } from "./client.js";
import type { Assignment as AssignmentRow } from "./generated/prisma/client.js";
import { Prisma } from "./generated/prisma/client.js";
import { IsolationError } from "./scope.js";
import { loadWorkRuns } from "./work-items.js";

type Viewer = { spaceId: string; userId: string };

/** Latest run status per thread, one indexed pick each. */
async function latestRunStatuses(
  prisma: PrismaClient,
  threadIds: string[],
): Promise<Map<string, string>> {
  if (threadIds.length === 0) return new Map();
  const rows = await prisma.$queryRaw<Array<{ threadId: string; status: string }>>(
    Prisma.sql`SELECT DISTINCT ON ("threadId") "threadId", "status" FROM "runs"
      WHERE "threadId" IN (${Prisma.join(threadIds)})
      ORDER BY "threadId", "createdAt" DESC, "id" DESC`,
  );
  return new Map(rows.map((row) => [row.threadId, row.status]));
}

async function ticketStatuses(
  prisma: PrismaClient,
  spaceId: string,
  rows: AssignmentRow[],
): Promise<Map<string, TicketStatus>> {
  const ids = rows.flatMap((row) => (row.ticketId ? [row.ticketId] : []));
  if (ids.length === 0) return new Map();
  const tickets = await prisma.ticket.findMany({
    where: { spaceId, id: { in: ids } },
    select: { id: true, status: true },
  });
  return new Map(tickets.map((ticket) => [ticket.id, coerceTicketStatus(ticket.status)]));
}

function toAssignment(
  row: AssignmentRow,
  ticketStatus: TicketStatus | null,
  latestRunStatus: string | null,
): Assignment {
  return {
    id: row.id,
    botId: row.botId,
    threadId: row.threadId,
    ticketId: row.ticketId,
    title: row.title,
    phase: assignmentPhase({ cancelledAt: row.cancelledAt, ticketStatus, latestRunStatus }),
    cancelledAt: row.cancelledAt?.toISOString() ?? null,
    archivedAt: row.archivedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function parseCursor(cursor: string): { updatedAt: Date; id: string } {
  const [time, id] = cursor.split("|");
  const updatedAt = new Date(time ?? "");
  if (!id || Number.isNaN(updatedAt.getTime())) throw new IsolationError("Unknown cursor");
  return { updatedAt, id };
}

/**
 * The viewer's assignment for `clientNonce`, created with its own thread when there is none, so
 * a repeated call returns the first one. The thread belongs to no bot; the employee reaches it
 * through the assignment. Only the employee's owner may give it a job.
 */
export async function createAssignment(
  prisma: PrismaClient,
  viewer: Viewer,
  input: { botId: string; title: string; clientNonce: string; ticketId?: string },
): Promise<{ assignment: AssignmentRow; created: boolean }> {
  const find = () =>
    prisma.assignment.findFirst({
      where: { spaceId: viewer.spaceId, userId: viewer.userId, clientNonce: input.clientNonce },
    });
  const existing = await find();
  if (existing) return { assignment: existing, created: false };
  try {
    const assignment = await prisma.$transaction(async (tx) => {
      const bot = await tx.bot.findFirst({
        where: {
          id: input.botId,
          spaceId: viewer.spaceId,
          userId: viewer.userId,
          archivedAt: null,
        },
        select: { id: true, employeeId: true },
      });
      if (!bot) throw new IsolationError();
      const thread = await tx.thread.create({
        data: { spaceId: viewer.spaceId, userId: viewer.userId },
        select: { id: true },
      });
      return tx.assignment.create({
        data: {
          spaceId: viewer.spaceId,
          botId: bot.id,
          userId: viewer.userId,
          employeeId: bot.employeeId,
          threadId: thread.id,
          ticketId: input.ticketId,
          title: input.title,
          clientNonce: input.clientNonce,
        },
      });
    });
    return { assignment, created: true };
  } catch (error) {
    // A concurrent create with the same nonce won; its rows are the answer, ours rolled back.
    const winner = await find();
    if (winner) return { assignment: winner, created: false };
    throw error;
  }
}

/**
 * The viewer's assignments, newest activity first, with the derived phase. The viewer's own
 * rows only: a manager's wider read access to the table belongs to a later oversight surface.
 */
export async function listAssignments(
  prisma: PrismaClient,
  viewer: Viewer,
  filter: { botId?: string; state: "active" | "archived"; cursor?: string; limit: number },
): Promise<{ items: Assignment[]; nextCursor: string | null }> {
  const after = filter.cursor ? parseCursor(filter.cursor) : undefined;
  const rows = await prisma.assignment.findMany({
    where: {
      spaceId: viewer.spaceId,
      userId: viewer.userId,
      ...(filter.botId ? { botId: filter.botId } : {}),
      archivedAt: filter.state === "archived" ? { not: null } : null,
      ...(after
        ? {
            OR: [
              { updatedAt: { lt: after.updatedAt } },
              { updatedAt: after.updatedAt, id: { lt: after.id } },
            ],
          }
        : {}),
    },
    orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
    take: filter.limit + 1,
  });
  const page = rows.slice(0, filter.limit);
  const [tickets, runs] = await Promise.all([
    ticketStatuses(prisma, viewer.spaceId, page),
    latestRunStatuses(
      prisma,
      page.map((row) => row.threadId),
    ),
  ]);
  const last = page.at(-1);
  return {
    items: page.map((row) =>
      toAssignment(
        row,
        row.ticketId ? (tickets.get(row.ticketId) ?? null) : null,
        runs.get(row.threadId) ?? null,
      ),
    ),
    nextCursor:
      rows.length > filter.limit && last ? `${last.updatedAt.toISOString()}|${last.id}` : null,
  };
}

/** One of the viewer's assignments with the runs in its own thread and their files. */
export async function getAssignmentWork(
  prisma: PrismaClient,
  viewer: Viewer,
  assignmentId: string,
): Promise<AssignmentWork> {
  const row = await prisma.assignment.findFirst({
    where: { id: assignmentId, spaceId: viewer.spaceId, userId: viewer.userId },
  });
  if (!row) throw new IsolationError();
  const [ticket, work] = await Promise.all([
    row.ticketId
      ? prisma.ticket.findFirst({
          where: { id: row.ticketId, spaceId: viewer.spaceId },
          select: { status: true },
        })
      : null,
    loadWorkRuns(prisma, viewer.spaceId, { threadId: row.threadId }),
  ]);
  return {
    ...toAssignment(
      row,
      ticket ? coerceTicketStatus(ticket.status) : null,
      work.runs[0]?.status ?? null,
    ),
    ...work,
  };
}

/** One of the viewer's assignments without its runs. */
export async function getAssignment(
  prisma: PrismaClient,
  viewer: Viewer,
  assignmentId: string,
): Promise<Assignment> {
  const {
    runs: _runs,
    artifacts: _artifacts,
    ...assignment
  } = await getAssignmentWork(prisma, viewer, assignmentId);
  return assignment;
}
