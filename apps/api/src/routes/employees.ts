import {
  decideRequest,
  listDirectory,
  listRequests,
  requestAccess,
} from "../employee-directory.js";
import { addInstance } from "../employee-instances.js";
import {
  decideProposal,
  listKnowledge,
  listOwnProposals,
  listProposals,
  proposeKnowledge,
  retireKnowledge,
  setKnowledge,
  withdrawProposal,
} from "../employee-knowledge.js";
import {
  getEmployee,
  listEmployees,
  listGrants,
  publishVersion,
  removeGrant,
  rollbackVersion,
  saveDraft,
  searchPeople,
  setGrant,
  shareBot,
} from "../employees.js";
import type { RouterContext } from "./context.js";

/** Employee definitions and who may use them. Each handler asks the access evaluator first. */
export function employeesRoutes(ctx: RouterContext) {
  const { deps, repos, authed } = ctx;
  return {
    employees: {
      list: authed.employees.list.handler(({ context }) => listEmployees(deps, context.actor)),
      get: authed.employees.get.handler(({ context, input }) =>
        getEmployee(deps, context.actor, input.employeeId),
      ),
      share: authed.employees.share.handler(({ context, input }) =>
        shareBot(deps, context.actor, input),
      ),
      addInstance: authed.employees.addInstance.handler(({ context, input }) =>
        addInstance(deps, repos, context.actor, input),
      ),
      directory: authed.employees.directory.handler(({ context }) =>
        listDirectory(deps, context.actor),
      ),
      requests: {
        create: authed.employees.requests.create.handler(({ context, input }) =>
          requestAccess(deps, context.actor, input),
        ),
        list: authed.employees.requests.list.handler(({ context, input }) =>
          listRequests(deps, context.actor, input),
        ),
        decide: authed.employees.requests.decide.handler(({ context, input }) =>
          decideRequest(deps, context.actor, input),
        ),
      },
      knowledge: {
        list: authed.employees.knowledge.list.handler(({ context, input }) =>
          listKnowledge(deps, context.actor, input),
        ),
        propose: authed.employees.knowledge.propose.handler(({ context, input }) =>
          proposeKnowledge(deps, context.actor, input),
        ),
        set: authed.employees.knowledge.set.handler(({ context, input }) =>
          setKnowledge(deps, context.actor, input),
        ),
        retire: authed.employees.knowledge.retire.handler(({ context, input }) =>
          retireKnowledge(deps, context.actor, input),
        ),
        proposals: {
          list: authed.employees.knowledge.proposals.list.handler(({ context, input }) =>
            listProposals(deps, context.actor, input),
          ),
          mine: authed.employees.knowledge.proposals.mine.handler(({ context, input }) =>
            listOwnProposals(deps, context.actor, input),
          ),
          decide: authed.employees.knowledge.proposals.decide.handler(({ context, input }) =>
            decideProposal(deps, context.actor, input),
          ),
          withdraw: authed.employees.knowledge.proposals.withdraw.handler(({ context, input }) =>
            withdrawProposal(deps, context.actor, input),
          ),
        },
      },
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
      people: {
        search: authed.employees.people.search.handler(({ context, input }) =>
          searchPeople(deps, context.actor, input),
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
