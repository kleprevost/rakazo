import {
  adminAudit,
  adminBots,
  adminEndSessions,
  adminOverview,
  adminPolicy,
  adminUsers,
} from "../admin-console.js";
import type { RouterContext } from "./context.js";

/** The deployment admin console. Each handler checks `requireAdmin` before reading anything. */
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
      },
      policy: authed.admin.policy.handler(({ context }) => adminPolicy(deps, context.actor.userId)),
      audit: authed.admin.audit.handler(({ context, input }) =>
        adminAudit(deps, context.actor.userId, input),
      ),
    },
  };
}
