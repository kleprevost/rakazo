import { activePolicy } from "@rakazo/adapters";
import { hireRole, listRoleTemplates } from "../role-templates.js";
import { mapSpaceLifecycleError } from "./bots.js";
import type { RouterContext } from "./context.js";
import { sendThread } from "./threads.js";

export function roleTemplatesRoutes(ctx: RouterContext) {
  const { repos, deps, agentImportServices, authed, codexCatalog } = ctx;
  return {
    roleTemplates: {
      list: authed.roleTemplates.list.handler(async () => listRoleTemplates(activePolicy())),
      hire: authed.roleTemplates.hire.handler(async ({ context, input }) => {
        try {
          return await hireRole(
            {
              prisma: deps.prisma,
              createBot: repos.createBot,
              sendStarter: (actor, botId, text, clientNonce) =>
                sendThread(deps, codexCatalog, actor, {
                  botId,
                  text,
                  clientNonce,
                  imageHandling: "confirm",
                }),
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
