import { adminComputer, adminComputers } from "../admin-computers.js";
import {
  adminAudit,
  adminBots,
  adminEndSessions,
  adminOverview,
  adminPolicy,
  adminUsers,
} from "../admin-console.js";
import { revokeCredentials } from "../admin-credential-revocation.js";
import {
  adminCreateFleetOperation,
  adminFleetOperation,
  adminFleetOperations,
} from "../admin-fleet-operations.js";
import { liftQuarantine, listQuarantines, startQuarantine } from "../bot-quarantine.js";
import { resumeBot, suspendBot } from "../bot-suspension.js";
import { adminCapabilities } from "../capability-insight.js";
import { quarantineComputers, releaseComputers } from "../computer-quarantine.js";
import type { RouterContext } from "./context.js";

/** The deployment admin console. Each handler checks `requireAdminRole` before reading anything. */
export function adminRoutes(ctx: RouterContext) {
  const { deps, authed } = ctx;
  return {
    admin: {
      overview: authed.admin.overview.handler(({ context }) =>
        adminOverview(deps, context.actor.userId),
      ),
      users: {
        list: authed.admin.users.list.handler(({ context, input }) =>
          adminUsers(deps, context.actor.userId, input),
        ),
        endSessions: authed.admin.users.endSessions.handler(({ context, input }) =>
          adminEndSessions(deps, context.actor.userId, input.userId),
        ),
      },
      bots: {
        list: authed.admin.bots.list.handler(({ context, input }) =>
          adminBots(deps, context.actor.userId, input),
        ),
        suspend: authed.admin.bots.suspend.handler(({ context, input }) =>
          suspendBot(deps, context.actor.userId, input),
        ),
        resume: authed.admin.bots.resume.handler(({ context, input }) =>
          resumeBot(deps, context.actor.userId, input.botId),
        ),
      },
      quarantine: {
        list: authed.admin.quarantine.list.handler(({ context }) =>
          listQuarantines(deps, context.actor.userId),
        ),
        start: authed.admin.quarantine.start.handler(({ context, input }) =>
          startQuarantine(deps, context.actor.userId, input),
        ),
        lift: authed.admin.quarantine.lift.handler(({ context, input }) =>
          liftQuarantine(deps, context.actor.userId, input.id),
        ),
      },
      credentials: {
        revoke: authed.admin.credentials.revoke.handler(({ context, input }) =>
          revokeCredentials(deps, context.actor.userId, input),
        ),
      },
      capabilities: {
        list: authed.admin.capabilities.list.handler(({ context, input }) =>
          adminCapabilities(deps, context.actor.userId, input),
        ),
      },
      computers: {
        list: authed.admin.computers.list.handler(({ context, input }) =>
          adminComputers(deps, context.actor.userId, input),
        ),
        get: authed.admin.computers.get.handler(({ context, input }) =>
          adminComputer(deps, context.actor.userId, input.computerId),
        ),
        quarantine: authed.admin.computers.quarantine.handler(({ context, input }) =>
          quarantineComputers(deps, context.actor.userId, input),
        ),
        release: authed.admin.computers.release.handler(({ context, input }) =>
          releaseComputers(deps, context.actor.userId, input),
        ),
        operations: {
          create: authed.admin.computers.operations.create.handler(({ context, input }) =>
            adminCreateFleetOperation(deps, context.actor.userId, input),
          ),
          list: authed.admin.computers.operations.list.handler(({ context, input }) =>
            adminFleetOperations(deps, context.actor.userId, input),
          ),
          get: authed.admin.computers.operations.get.handler(({ context, input }) =>
            adminFleetOperation(deps, context.actor.userId, input.operationId),
          ),
        },
      },
      policy: authed.admin.policy.handler(({ context }) => adminPolicy(deps, context.actor.userId)),
      audit: authed.admin.audit.handler(({ context, input }) =>
        adminAudit(deps, context.actor.userId, input),
      ),
    },
  };
}
