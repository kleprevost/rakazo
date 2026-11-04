import { describe, expect, it, vi } from "vitest";
import { loadPublishedSkills } from "./published-skills.js";

const version = (number: number, name = "Export") => ({
  number,
  name,
  description: "Weekly export",
  playbook: { whenToUse: "Mondays", steps: [`step v${number}`] },
});
const row = (
  subjectKind: string,
  subjectValue: string,
  number: number,
  skillId = "s1",
  name = "Export",
) => ({
  skillId,
  subjectKind,
  subjectValue,
  versionId: `${skillId}-v${number}`,
  version: version(number, name),
});

function fake(rows: unknown[], claims: string[] | null = null) {
  const findMany = vi.fn(async (..._args: unknown[]) => rows);
  return {
    findMany,
    prisma: {
      publishedSkillAudience: { findMany },
      userDirectoryClaim: { findUnique: vi.fn(async () => (claims ? { values: claims } : null)) },
    } as never,
  };
}

describe("loadPublishedSkills", () => {
  it("offers the version pinned for the person, as a saved-skill shape", async () => {
    const { prisma } = fake([row("all", "*", 1), row("user", "u1", 2)]);
    const skills = await loadPublishedSkills(prisma, "u1");
    expect(skills).toHaveLength(1);
    expect(skills[0]).toMatchObject({ name: "Export", goal: "Weekly export" });
    expect(skills[0]!.playbook.steps).toEqual(["step v2"]);
  });

  it("asks only for approved versions and for audiences naming the person or their claims", async () => {
    const { prisma, findMany } = fake([], ["pilot"]);
    await loadPublishedSkills(prisma, "u1");
    expect(findMany.mock.calls[0]![0]).toMatchObject({
      where: {
        version: { status: "approved" },
        OR: [
          { subjectKind: "all" },
          { subjectKind: "user", subjectValue: "u1" },
          { subjectKind: "claim", subjectValue: { in: ["pilot"] } },
        ],
      },
    });
  });

  it("lets a skill the person saved under the same name win", async () => {
    const { prisma } = fake([row("all", "*", 1), row("all", "*", 1, "s2", "Other")]);
    const skills = await loadPublishedSkills(prisma, "u1", new Set(["export"]));
    expect(skills.map((skill) => skill.name)).toEqual(["Other"]);
  });
});
