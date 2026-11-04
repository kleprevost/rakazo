/**
 * Publishing a taught skill: what a version freezes, how two versions differ for a reviewer, and
 * which version a person runs. Pure and deterministic; the API and the executor both call it.
 */

export type SkillPlaybookText = {
  whenToUse: string;
  inputs: string[];
  steps: string[];
  howToCheck: string;
  whatToReturn: string;
  approvalBoundaries: string;
  failureHandling: string;
};

/** The only content a published version carries. No recording, transcript or memory. */
export type SkillSnapshot = {
  name: string;
  description: string;
  playbook: SkillPlaybookText;
};

export const SKILL_SNAPSHOT_FIELDS = [
  "name",
  "whenToUse",
  "inputs",
  "steps",
  "howToCheck",
  "whatToReturn",
  "approvalBoundaries",
  "failureHandling",
] as const;
export type SkillSnapshotField = (typeof SKILL_SNAPSHOT_FIELDS)[number];

export type SkillDiffLine = { op: "same" | "add" | "remove"; text: string };
export type SkillDiffField = { field: SkillSnapshotField; lines: SkillDiffLine[] };

/** Builds the frozen content from a saved taught skill's name, goal and playbook. */
export function snapshotTaughtSkill(skill: {
  name: string;
  goal: string;
  playbook: SkillPlaybookText;
}): SkillSnapshot {
  const name = (skill.name || skill.goal).trim().slice(0, 80);
  return {
    name,
    description: (skill.playbook.whenToUse || skill.goal).trim().slice(0, 2000),
    playbook: skill.playbook,
  };
}

function fieldLines(snapshot: SkillSnapshot | null, field: SkillSnapshotField): string[] {
  if (!snapshot) return [];
  if (field === "name") return [snapshot.name];
  const value = snapshot.playbook[field];
  const lines = Array.isArray(value) ? value : value.split("\n");
  return lines.filter((line) => line.length > 0);
}

/** Longest-common-subsequence line diff, in reading order. */
function diffLines(before: string[], after: string[]): SkillDiffLine[] {
  const table = Array.from({ length: before.length + 1 }, () =>
    new Array<number>(after.length + 1).fill(0),
  );
  for (let i = before.length - 1; i >= 0; i--) {
    for (let j = after.length - 1; j >= 0; j--) {
      table[i]![j] =
        before[i] === after[j]
          ? table[i + 1]![j + 1]! + 1
          : Math.max(table[i + 1]![j]!, table[i]![j + 1]!);
    }
  }
  const lines: SkillDiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < before.length || j < after.length) {
    if (i < before.length && j < after.length && before[i] === after[j]) {
      lines.push({ op: "same", text: before[i]! });
      i++;
      j++;
    } else if (
      j < after.length &&
      (i === before.length || table[i]![j + 1]! >= table[i + 1]![j]!)
    ) {
      lines.push({ op: "add", text: after[j]! });
      j++;
    } else {
      lines.push({ op: "remove", text: before[i]! });
      i++;
    }
  }
  return lines;
}

/**
 * What changed from the previous published version, for the fields that changed only. With no
 * previous version every non-empty field is an addition, so a first review reads the whole text.
 */
export function diffSkillSnapshots(
  previous: SkillSnapshot | null,
  next: SkillSnapshot,
): SkillDiffField[] {
  const fields: SkillDiffField[] = [];
  for (const field of SKILL_SNAPSHOT_FIELDS) {
    const lines = diffLines(fieldLines(previous, field), fieldLines(next, field));
    if (lines.some((line) => line.op !== "same")) fields.push({ field, lines });
  }
  return fields;
}

export type PublishedAudience = {
  skillId: string;
  subjectKind: "user" | "claim" | "all";
  subjectValue: string;
  versionId: string;
  versionNumber: number;
};

const SPECIFICITY = { user: 3, claim: 2, all: 1 } as const;

/**
 * The one version of each skill a person runs: their own pin beats a group pin, which beats
 * "everyone". Between group pins the newer version wins. Audiences that do not name the person
 * are ignored, so the caller can pass any superset.
 */
export function pinnedVersionsFor(
  audiences: readonly PublishedAudience[],
  person: { userId: string; claims: readonly string[] },
): Map<string, string> {
  const best = new Map<string, PublishedAudience>();
  for (const audience of audiences) {
    const applies =
      audience.subjectKind === "all" ||
      (audience.subjectKind === "user" && audience.subjectValue === person.userId) ||
      (audience.subjectKind === "claim" && person.claims.includes(audience.subjectValue));
    if (!applies) continue;
    const current = best.get(audience.skillId);
    const better =
      !current ||
      SPECIFICITY[audience.subjectKind] > SPECIFICITY[current.subjectKind] ||
      (audience.subjectKind === current.subjectKind &&
        audience.versionNumber > current.versionNumber);
    if (better) best.set(audience.skillId, audience);
  }
  return new Map([...best].map(([skillId, audience]) => [skillId, audience.versionId]));
}
