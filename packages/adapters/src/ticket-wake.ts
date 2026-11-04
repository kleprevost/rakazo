import { randomUUID } from "node:crypto";
import type { JobPublisher } from "@rakazo/adapter-kit";
import { runContinueJob } from "@rakazo/adapter-kit";
import { isTicketCompletedStatus, TicketStatusSchema } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { activeQuarantineFor } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import { isUniqueViolation } from "./run-messages.js";

const ASSIGNMENT_TITLE_MAX = 200;

/**
 * Assignment wakes only its current owner, without posting a chat message. The work runs in the
 * ticket's own assignment thread, created on the first wake, so a ticket never shares the
 * employee's chat or another job's conversation.
 */
export async function wakeTicketAssignee(
  deps: { prisma: PrismaClient; jobs: JobPublisher; ticketBoardEnabled?: boolean },
  input: { spaceId: string; ticketId: string; botId: string },
): Promise<void> {
  if (!deps.ticketBoardEnabled) return;
  const wake = () =>
    deps.prisma.$transaction(async (tx) => {
      const ticket = await tx.ticket.findFirst({
        where: { id: input.ticketId, spaceId: input.spaceId, assigneeBotId: input.botId },
        include: { board: { select: { ticketPrefix: true } } },
      });
      if (!ticket) return null;
      const status = TicketStatusSchema.safeParse(ticket.status);
      if (!status.success || isTicketCompletedStatus(status.data)) return null;
      const bot = await tx.bot.findFirst({
        where: { id: input.botId, spaceId: input.spaceId, archivedAt: null, suspendedAt: null },
        select: { id: true, userId: true, employeeId: true },
      });
      if (!bot) return null;
      // A quarantined bot is not woken either: the ticket keeps its status.
      if (await activeQuarantineFor(tx, bot.id)) return null;
      let assignment = await tx.assignment.findUnique({ where: { ticketId: ticket.id } });
      if (assignment && assignment.botId !== bot.id) {
        // Reassigned: the earlier job keeps its history but stops tracking this ticket.
        await tx.assignment.update({ where: { id: assignment.id }, data: { ticketId: null } });
        assignment = null;
      }
      if (assignment) {
        await tx.assignment.update({
          where: { id: assignment.id },
          data: { updatedAt: new Date() },
        });
      } else {
        const thread = await tx.thread.create({
          data: { spaceId: input.spaceId, userId: bot.userId },
          select: { id: true },
        });
        assignment = await tx.assignment.create({
          data: {
            spaceId: input.spaceId,
            botId: bot.id,
            userId: bot.userId,
            employeeId: bot.employeeId,
            threadId: thread.id,
            ticketId: ticket.id,
            title: ticket.title.slice(0, ASSIGNMENT_TITLE_MAX),
            clientNonce: `ticket:${ticket.id}:${randomUUID()}`,
          },
        });
      }
      const task = await tx.task.create({
        data: {
          spaceId: input.spaceId,
          botId: bot.id,
          threadId: assignment.threadId,
          userId: bot.userId,
          prompt: `Work on ticket ${ticket.board.ticketPrefix}-${ticket.number}. Read it with ticket_get. Keep progress in ticket comments and update its status with ticket_update. Use ask or approval cards when user input is needed.`,
          status: "queued",
          ticketId: ticket.id,
        },
      });
      if (status.data === "todo") {
        await tx.ticket.update({ where: { id: ticket.id }, data: { status: "doing" } });
      }
      return tx.run.create({
        data: {
          spaceId: input.spaceId,
          botId: bot.id,
          threadId: assignment.threadId,
          userId: bot.userId,
          taskId: task.id,
          trigger: "tickets",
          status: "queued",
        },
      });
    });
  // Two wakes racing to create the ticket's assignment collide on its unique ticket; the loser
  // retries and finds the winner's.
  const run = await wake().catch((error) =>
    isUniqueViolation(error) ? wake() : Promise.reject(error),
  );
  if (!run) return;
  await deps.jobs.enqueue(runContinueJob(run.id)).catch((error) => {
    getLogger().warn("ticket wake deferred to reconciliation", error);
  });
}
