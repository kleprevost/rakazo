import { activePolicy } from "@rakazo/adapters";
import { hireRole, listRoleTemplates } from "../role-templates.js";
import { mapSpaceLifecycleError } from "./bots.js";
import type { RouterContext } from "./context.js";

export function roleTemplatesRoutes(ctx: RouterContext) {
  const { repos, deps, agentImportServices, authed } = ctx;
  return {
    roleTemplates: {
      list: authed.roleTemplates.list.handler(async () => listRoleTemplates(activePolicy())),
      hire: authed.roleTemplates.hire.handler(async ({ context, input }) => {
        try {
          return await hireRole(
            {
              prisma: deps.prisma,
              createBot: repos.createBot,
              assertRoutineSchedule: agentImportServices.assertRoutineSchedule,
              routineNextRunAt: agentImportServices.routineNextRunAt,
              routineRowData: agentImportServices.routineRowData,
              announceRoutine: agentImportServices.announceRoutine,
            },
            context.actor,
            input,
            activePolicy(),
          );
        } catch (error) {
          throw mapSpaceLifecycleError(error);
        }
      }),
    },
  };
}
