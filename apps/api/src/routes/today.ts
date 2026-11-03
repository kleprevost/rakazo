import { todaySummary } from "../today.js";
import type { RouterContext } from "./context.js";

export function todayRoutes(ctx: RouterContext) {
  const { deps, authed } = ctx;
  return {
    today: {
      summary: authed.today.summary.handler(({ context }) =>
        todaySummary(deps.prisma, context.actor, new Date(), {
          workItems: deps.env?.ticketBoardEnabled === true,
        }),
      ),
    },
  };
}
