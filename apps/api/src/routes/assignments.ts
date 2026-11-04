import { ORPCError } from "@orpc/server";
import { createAssignment, getAssignment, getAssignmentWork, listAssignments } from "@rakazo/db";
import type { RouterContext } from "./context.js";
import { sendThread } from "./threads.js";

/** Independent jobs per employee: each has its own conversation, runs and files. */
export function assignmentsRoutes(ctx: RouterContext) {
  const { deps, authed, codexCatalog } = ctx;
  return {
    assignments: {
      create: authed.assignments.create.handler(async ({ context, input }) => {
        const { actor } = context;
        const { assignment, created } = await createAssignment(deps.prisma, actor, input);
        if (assignment.botId !== input.botId) {
          throw new ORPCError("CONFLICT", { message: "That request was used for another job." });
        }
        try {
          // The brief is the thread's first message and starts its first run through the same
          // send every chat uses. Its nonce makes a repeated create return the same message.
          await sendThread(deps, codexCatalog, actor, {
            assignmentId: assignment.id,
            text: input.brief,
            clientNonce: `brief:${input.clientNonce}`,
          });
        } catch (error) {
          // A refused first send (no model, a suspended employee) leaves no empty job behind.
          if (created) {
            await deps.prisma.thread.deleteMany({
              where: { id: assignment.threadId, userId: actor.userId, messages: { none: {} } },
            });
          }
          throw error;
        }
        return getAssignment(deps.prisma, actor, assignment.id);
      }),
      list: authed.assignments.list.handler(({ context, input }) =>
        listAssignments(deps.prisma, context.actor, input),
      ),
      get: authed.assignments.get.handler(({ context, input }) =>
        getAssignmentWork(deps.prisma, context.actor, input.assignmentId),
      ),
    },
  };
}
