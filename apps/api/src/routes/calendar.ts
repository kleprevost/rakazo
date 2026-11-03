import { calendarRange } from "../calendar.js";
import type { RouterContext } from "./context.js";

export function calendarRoutes(ctx: RouterContext) {
  const { deps, authed } = ctx;
  return {
    calendar: {
      range: authed.calendar.range.handler(({ context, input }) =>
        calendarRange(deps.prisma, context.actor, input),
      ),
    },
  };
}
