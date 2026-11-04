import { getAssignmentWork, listAssignments } from "@rakazo/db";
import type { RouterContext } from "./context.js";

/** Independent jobs per employee. Reads only so far: nothing creates an assignment yet. */
export function assignmentsRoutes(ctx: RouterContext) {
  const { deps, authed } = ctx;
  return {
    assignments: {
      list: authed.assignments.list.handler(({ context, input }) =>
        listAssignments(deps.prisma, context.actor, input),
      ),
      get: authed.assignments.get.handler(({ context, input }) =>
        getAssignmentWork(deps.prisma, context.actor, input.assignmentId),
      ),
    },
  };
}
