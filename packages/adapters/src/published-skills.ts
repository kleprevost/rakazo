import { pinnedVersionsFor } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import { parsePlaybook } from "./teaching-session.js";

/** A published skill shaped like a saved taught skill, so a run invokes both the same way. */
export type RunPublishedSkill = {
  name: string;
  goal: string;
  playbook: ReturnType<typeof parsePlaybook>;
};

const MAX_PUBLISHED_SKILLS = 20;

/**
 * The published skills this person runs now: for each skill, the version pinned for them (their
 * own pin, else a group they carry, else everyone). Read at run start, so a publish or rollback
 * applies on the next run and a running turn keeps its text. This only supplies instructions: the
 * run still acts with the runner's own connections and capability grants, and a skill the person
 * saved under the same name wins.
 */
export async function loadPublishedSkills(
  prisma: Pick<PrismaClient, "publishedSkillAudience" | "userDirectoryClaim">,
  userId: string,
  ownNames: ReadonlySet<string> = new Set(),
): Promise<RunPublishedSkill[]> {
  const claims = await prisma.userDirectoryClaim.findUnique({
    where: { userId },
    select: { values: true },
  });
  const claimValues = claims?.values ?? [];
  const rows = await prisma.publishedSkillAudience.findMany({
    where: {
      OR: [
        { subjectKind: "all" },
        { subjectKind: "user", subjectValue: userId },
        ...(claimValues.length > 0
          ? [{ subjectKind: "claim", subjectValue: { in: claimValues } }]
          : []),
      ],
      version: { status: "approved" },
    },
    select: {
      skillId: true,
      subjectKind: true,
      subjectValue: true,
      versionId: true,
      version: { select: { number: true, name: true, description: true, playbook: true } },
    },
    take: 200,
  });
  const pinned = pinnedVersionsFor(
    rows.map((row) => ({
      skillId: row.skillId,
      subjectKind:
        row.subjectKind === "user" || row.subjectKind === "claim" ? row.subjectKind : "all",
      subjectValue: row.subjectValue,
      versionId: row.versionId,
      versionNumber: row.version.number,
    })),
    { userId, claims: claimValues },
  );
  const byVersion = new Map(rows.map((row) => [row.versionId, row.version]));
  const skills: RunPublishedSkill[] = [];
  for (const versionId of pinned.values()) {
    const version = byVersion.get(versionId);
    if (!version || ownNames.has(version.name.toLowerCase())) continue;
    skills.push({
      name: version.name,
      goal: version.description,
      playbook: parsePlaybook(version.playbook),
    });
  }
  return skills.sort((a, b) => a.name.localeCompare(b.name)).slice(0, MAX_PUBLISHED_SKILLS);
}
