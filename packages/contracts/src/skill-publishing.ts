import { oc } from "@orpc/contract";
import * as z from "zod";
import { SkillPlaybookSchema } from "./domain.js";
import { Id, IsoDate } from "./ids.js";

export const SKILL_VERSION_STATUSES = ["submitted", "approved", "rejected", "withdrawn"] as const;
export const SkillVersionStatusSchema = z.enum(SKILL_VERSION_STATUSES);
export type SkillVersionStatus = z.infer<typeof SkillVersionStatusSchema>;

/** Who a version is pinned for. `all` is every signed-in person on the deployment. */
export const SKILL_AUDIENCE_KINDS = ["user", "claim", "all"] as const;
export const SkillAudienceKindSchema = z.enum(SKILL_AUDIENCE_KINDS);
export type SkillAudienceKind = z.infer<typeof SkillAudienceKindSchema>;

export const SkillAudienceInputSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("user"), value: Id.max(256) }),
  z.object({ kind: z.literal("claim"), value: z.string().min(1).max(256) }),
  z.object({ kind: z.literal("all") }),
]);
export type SkillAudienceInput = z.infer<typeof SkillAudienceInputSchema>;

export const SkillDiffSchema = z.array(
  z.object({
    field: z.enum([
      "name",
      "whenToUse",
      "inputs",
      "steps",
      "howToCheck",
      "whatToReturn",
      "approvalBoundaries",
      "failureHandling",
    ]),
    lines: z.array(z.object({ op: z.enum(["same", "add", "remove"]), text: z.string() })),
  }),
);
export type SkillDiff = z.infer<typeof SkillDiffSchema>;

export const SkillVersionSchema = z.object({
  id: Id,
  skillId: Id,
  number: z.number().int(),
  status: SkillVersionStatusSchema,
  name: z.string(),
  description: z.string(),
  playbook: SkillPlaybookSchema,
  submittedAt: IsoDate,
  decidedAt: IsoDate.nullable(),
  reason: z.string().nullable(),
});
export type SkillVersion = z.infer<typeof SkillVersionSchema>;

/** The author's own submissions. Playbook text is theirs already, so it is not repeated. */
export const SkillSubmissionSchema = z.object({
  versionId: Id,
  skillId: Id,
  number: z.number().int(),
  name: z.string(),
  status: SkillVersionStatusSchema,
  submittedAt: IsoDate,
  reason: z.string().nullable(),
});
export type SkillSubmission = z.infer<typeof SkillSubmissionSchema>;

export const SkillReviewItemSchema = z.object({
  versionId: Id,
  skillId: Id,
  number: z.number().int(),
  name: z.string(),
  authorName: z.string(),
  submittedAt: IsoDate,
});
export type SkillReviewItem = z.infer<typeof SkillReviewItemSchema>;

export const SkillReviewSchema = z.object({
  version: SkillVersionSchema,
  authorName: z.string(),
  /** The approved version this one replaces, or null for a first version. */
  previousNumber: z.number().int().nullable(),
  diff: SkillDiffSchema,
});
export type SkillReview = z.infer<typeof SkillReviewSchema>;

export const SkillAudienceSchema = z.object({
  id: Id,
  kind: SkillAudienceKindSchema,
  value: z.string(),
  versionId: Id,
  versionNumber: z.number().int(),
});
export type SkillAudience = z.infer<typeof SkillAudienceSchema>;

export const PublishedSkillSchema = z.object({
  id: Id,
  name: z.string(),
  versions: z.array(SkillVersionSchema.omit({ playbook: true })),
  audiences: z.array(SkillAudienceSchema),
});
export type PublishedSkill = z.infer<typeof PublishedSkillSchema>;

const Ok = z.object({ ok: z.literal(true) });

/**
 * Publishing a taught skill. `submit`, `mine` and `withdraw` belong to the author; everything
 * else is for a deployment admin with the platform role. Publishing pins text; it never grants
 * a tool, connection or credential.
 */
export const skillPublishingContract = {
  submit: oc
    .input(z.object({ skillId: Id }))
    .output(z.object({ versionId: Id, number: z.number().int() })),
  mine: oc.input(z.object({})).output(z.array(SkillSubmissionSchema)),
  withdraw: oc.input(z.object({ versionId: Id })).output(Ok),
  review: {
    list: oc.input(z.object({})).output(z.array(SkillReviewItemSchema)),
    get: oc.input(z.object({ versionId: Id })).output(SkillReviewSchema),
    decide: oc
      .input(
        z.object({
          versionId: Id,
          decision: z.enum(["approve", "reject"]),
          reason: z.string().max(500).optional(),
        }),
      )
      .output(Ok),
  },
  catalog: oc.input(z.object({})).output(z.array(PublishedSkillSchema)),
  /** Pins an approved version for an audience. Pinning an older version there is a rollback. */
  publish: oc
    .input(z.object({ skillId: Id, versionId: Id, audience: SkillAudienceInputSchema }))
    .output(SkillAudienceSchema),
  unpublish: oc.input(z.object({ audienceId: Id })).output(Ok),
  /** Moves every audience pinned above this version back to it, effective on the next run. */
  rollback: oc
    .input(z.object({ skillId: Id, versionId: Id }))
    .output(z.object({ moved: z.number().int() })),
};
