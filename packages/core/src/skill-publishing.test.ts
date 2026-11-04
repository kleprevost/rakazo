import { describe, expect, it } from "vitest";
import type { SkillPlaybookText, SkillSnapshot } from "./skill-publishing.js";
import { diffSkillSnapshots, pinnedVersionsFor, snapshotTaughtSkill } from "./skill-publishing.js";

const playbook = (over: Partial<SkillPlaybookText> = {}): SkillPlaybookText => ({
  whenToUse: "Weekly export",
  inputs: [],
  steps: ["Open the CRM", "Export the list", "Drop it in the folder"],
  howToCheck: "The file exists",
  whatToReturn: "The file name",
  approvalBoundaries: "Ask before sending",
  failureHandling: "Stop and ask",
  ...over,
});
const snap = (over: Partial<SkillPlaybookText> = {}, name = "Export"): SkillSnapshot => ({
  name,
  description: "Weekly export",
  playbook: playbook(over),
});

describe("snapshotTaughtSkill", () => {
  it("falls back to the goal and carries only the playbook text", () => {
    const result = snapshotTaughtSkill({ name: "", goal: "Export the list", playbook: playbook() });
    expect(result.name).toBe("Export the list");
    expect(Object.keys(result).sort()).toEqual(["description", "name", "playbook"]);
  });
});

describe("diffSkillSnapshots", () => {
  it("shows only the fields that changed, line by line", () => {
    const diff = diffSkillSnapshots(
      snap(),
      snap({
        steps: ["Open the CRM", "Filter to this week", "Export the list", "Drop it in the folder"],
      }),
    );
    expect(diff.map((entry) => entry.field)).toEqual(["steps"]);
    expect(diff[0]!.lines).toEqual([
      { op: "same", text: "Open the CRM" },
      { op: "add", text: "Filter to this week" },
      { op: "same", text: "Export the list" },
      { op: "same", text: "Drop it in the folder" },
    ]);
  });

  it("marks removals and an unchanged skill has no diff", () => {
    const diff = diffSkillSnapshots(snap(), snap({ steps: ["Open the CRM", "Export the list"] }));
    expect(diff[0]!.lines.filter((line) => line.op === "remove")).toEqual([
      { op: "remove", text: "Drop it in the folder" },
    ]);
    expect(diffSkillSnapshots(snap(), snap())).toEqual([]);
  });

  it("reads a first version as all additions", () => {
    const diff = diffSkillSnapshots(null, snap());
    expect(diff.find((entry) => entry.field === "steps")!.lines.every((l) => l.op === "add")).toBe(
      true,
    );
  });
});

describe("pinnedVersionsFor", () => {
  const audience = (
    subjectKind: "user" | "claim" | "all",
    subjectValue: string,
    versionNumber: number,
  ) => ({
    skillId: "s1",
    subjectKind,
    subjectValue,
    versionId: `v${versionNumber}`,
    versionNumber,
  });
  const person = { userId: "u1", claims: ["pilot"] };

  it("prefers the person's own pin, then a group, then everyone", () => {
    const all = audience("all", "*", 1);
    const group = audience("claim", "pilot", 2);
    const own = audience("user", "u1", 3);
    expect(pinnedVersionsFor([all], person).get("s1")).toBe("v1");
    expect(pinnedVersionsFor([all, group], person).get("s1")).toBe("v2");
    expect(pinnedVersionsFor([all, group, own], person).get("s1")).toBe("v3");
  });

  it("ignores audiences that do not name the person", () => {
    const other = [audience("user", "u2", 2), audience("claim", "other", 2)];
    expect(pinnedVersionsFor(other, person).size).toBe(0);
  });
});
