import { ORPCError } from "@orpc/server";
import { MODEL_REQUIRED_SEND_ERROR } from "@rakazo/core";
import {
  archiveAssignment,
  createAssignment,
  getAssignment,
  getAssignmentWork,
  IsolationError,
  listAssignments,
  unarchiveAssignment,
} from "@rakazo/db";
import { assertBotNotSuspended } from "../bot-suspension.js";
import { assertTeachingSendAllowed } from "../taught-skills.js";
import {
  cancelThreadRuns,
  finishThreadStop,
  resolveThreadTarget,
  steerThreadMessage,
} from "../thread-target.js";
import type { RouterContext } from "./context.js";
import { botsRunOwnModels, modelSetup } from "./shared.js";
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
      steer: authed.assignments.steer.handler(async ({ context, input }) => {
        const { actor } = context;
        // The creator's own job only: another person, or a manager who can see the row, is refused.
        const target = await resolveThreadTarget(deps.prisma, actor, {
          assignmentId: input.assignmentId,
        });
        if (target.kind !== "bot") throw new IsolationError();
        const state = await deps.prisma.assignment.findFirst({
          where: { id: input.assignmentId, spaceId: actor.spaceId, userId: actor.userId },
          select: { cancelledAt: true, archivedAt: true },
        });
        if (!state || state.archivedAt || state.cancelledAt) {
          throw new ORPCError("CONFLICT", { message: "That job is not active." });
        }
        const setup = await modelSetup(deps, actor);
        if (setup.needsModel && !(await botsRunOwnModels(deps, actor, [target.botId]))) {
          throw new ORPCError("BAD_REQUEST", { message: MODEL_REQUIRED_SEND_ERROR });
        }
        await assertTeachingSendAllowed(deps.prisma, actor.spaceId, target.botId);
        await assertBotNotSuspended(deps.prisma, target.botId);
        return steerThreadMessage(deps, actor, target, input);
      }),
      cancel: authed.assignments.cancel.handler(async ({ context, input }) => {
        const { actor } = context;
        const target = await resolveThreadTarget(deps.prisma, actor, {
          assignmentId: input.assignmentId,
        });
        // The thread's live runs stop and the mark is set in one commit. The mark only goes on
        // an unmarked row, so racing cancels end in one state; the stop is the existing one.
        const stop = await deps.prisma.$transaction(async (tx) => {
          const stopped = await cancelThreadRuns(actor, target)(tx);
          await tx.assignment.updateMany({
            where: {
              id: input.assignmentId,
              spaceId: actor.spaceId,
              userId: actor.userId,
              cancelledAt: null,
            },
            data: { cancelledAt: new Date() },
          });
          return stopped;
        });
        await finishThreadStop(deps, actor, target, stop);
        return getAssignment(deps.prisma, actor, input.assignmentId);
      }),
      archive: authed.assignments.archive.handler(async ({ context, input }) => {
        const { actor } = context;
        const result = await archiveAssignment(deps.prisma, actor, input.assignmentId);
        if (result === "live") {
          throw new ORPCError("CONFLICT", { message: "Stop the job before archiving it." });
        }
        return getAssignment(deps.prisma, actor, input.assignmentId);
      }),
      unarchive: authed.assignments.unarchive.handler(async ({ context, input }) => {
        await unarchiveAssignment(deps.prisma, context.actor, input.assignmentId);
        return getAssignment(deps.prisma, context.actor, input.assignmentId);
      }),
    },
  };
}
