import {
  decideReview,
  getReview,
  listCatalog,
  listReviews,
  listSubmissions,
  publishVersion,
  rollbackSkill,
  submitSkill,
  unpublish,
  withdrawSubmission,
} from "../skill-publishing.js";
import type { RouterContext } from "./context.js";

/** Authors submit; platform admins review and pin. Each handler checks its own gate. */
export function skillPublishingRoutes(ctx: RouterContext) {
  const { deps, authed } = ctx;
  return {
    skillPublishing: {
      submit: authed.skillPublishing.submit.handler(({ context, input }) =>
        submitSkill(deps, context.actor, input),
      ),
      mine: authed.skillPublishing.mine.handler(({ context }) =>
        listSubmissions(deps, context.actor),
      ),
      withdraw: authed.skillPublishing.withdraw.handler(({ context, input }) =>
        withdrawSubmission(deps, context.actor, input),
      ),
      review: {
        list: authed.skillPublishing.review.list.handler(({ context }) =>
          listReviews(deps, context.actor),
        ),
        get: authed.skillPublishing.review.get.handler(({ context, input }) =>
          getReview(deps, context.actor, input),
        ),
        decide: authed.skillPublishing.review.decide.handler(({ context, input }) =>
          decideReview(deps, context.actor, input),
        ),
      },
      catalog: authed.skillPublishing.catalog.handler(({ context }) =>
        listCatalog(deps, context.actor),
      ),
      publish: authed.skillPublishing.publish.handler(({ context, input }) =>
        publishVersion(deps, context.actor, input),
      ),
      unpublish: authed.skillPublishing.unpublish.handler(({ context, input }) =>
        unpublish(deps, context.actor, input),
      ),
      rollback: authed.skillPublishing.rollback.handler(({ context, input }) =>
        rollbackSkill(deps, context.actor, input),
      ),
    },
  };
}
