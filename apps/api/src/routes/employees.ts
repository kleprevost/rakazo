import {
  getEmployee,
  listEmployees,
  listGrants,
  publishVersion,
  removeGrant,
  rollbackVersion,
  saveDraft,
  setGrant,
  shareBot,
} from "../employees.js";
import type { RouterContext } from "./context.js";

/** Employee definitions and who may use them. Each handler asks the access evaluator first. */
export function employeesRoutes(ctx: RouterContext) {
  const { deps, authed } = ctx;
  return {
    employees: {
      list: authed.employees.list.handler(({ context }) => listEmployees(deps, context.actor)),
      get: authed.employees.get.handler(({ context, input }) =>
        getEmployee(deps, context.actor, input.employeeId),
      ),
      share: authed.employees.share.handler(({ context, input }) =>
        shareBot(deps, context.actor, input),
      ),
      versions: {
        saveDraft: authed.employees.versions.saveDraft.handler(({ context, input }) =>
          saveDraft(deps, context.actor, input),
        ),
        publish: authed.employees.versions.publish.handler(({ context, input }) =>
          publishVersion(deps, context.actor, input),
        ),
        rollback: authed.employees.versions.rollback.handler(({ context, input }) =>
          rollbackVersion(deps, context.actor, input),
        ),
      },
      grants: {
        list: authed.employees.grants.list.handler(({ context, input }) =>
          listGrants(deps, context.actor, input.employeeId),
        ),
        set: authed.employees.grants.set.handler(({ context, input }) =>
          setGrant(deps, context.actor, input),
        ),
        remove: authed.employees.grants.remove.handler(({ context, input }) =>
          removeGrant(deps, context.actor, input),
        ),
      },
    },
  };
}
