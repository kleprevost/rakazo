import {
  listCapabilityGrants,
  revokeCapabilityGrant,
  setCapabilityGrant,
  setCapabilityMode,
} from "../capability-grants.js";
import type { RouterContext } from "./context.js";

/** Capability grants and the shadow switch. Each handler authorizes before it reads or writes. */
export function capabilityGrantsRoutes(ctx: RouterContext) {
  const { deps, authed } = ctx;
  return {
    capabilityGrants: {
      list: authed.capabilityGrants.list.handler(({ context, input }) =>
        listCapabilityGrants(deps, context.actor, input),
      ),
      set: authed.capabilityGrants.set.handler(({ context, input }) =>
        setCapabilityGrant(deps, context.actor, input),
      ),
      revoke: authed.capabilityGrants.revoke.handler(({ context, input }) =>
        revokeCapabilityGrant(deps, context.actor, input),
      ),
      setMode: authed.capabilityGrants.setMode.handler(({ context, input }) =>
        setCapabilityMode(deps, context.actor, input),
      ),
    },
  };
}
