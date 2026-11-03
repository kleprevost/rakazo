import type { Actor, Bot } from "@rakazo/contracts";
import { describe, expect, it, vi } from "vitest";
import type { HireServices } from "./role-templates.js";
import { hireRole, listRoleTemplates } from "./role-templates.js";

const actor = { userId: "u1", spaceId: "s1" } as Actor;

function harness(existingSkills: string[] = []) {
  const skills: { name: string; content: string }[] = [];
  const routines: { name: string; active: boolean; botId: string }[] = [];
  const tx = {
    agentSkill: {
      findFirst: vi.fn(async ({ where }: { where: { name: { equals: string } } }) =>
        existingSkills.includes(where.name.equals) ? { id: "x" } : null,
      ),
      create: vi.fn(async ({ data }: { data: { name: string; content: string } }) => {
        skills.push(data);
        return data;
      }),
    },
    routine: {
      create: vi.fn(
        async ({ data }: { data: { name: string; active: boolean; botId: string } }) => {
          routines.push(data);
          return { id: `r${routines.length}`, ...data };
        },
      ),
    },
  };
  const createBot = vi.fn(
    async (
      _actor: Actor,
      input: {
        name: string;
        instructions: string;
        seed?: (tx: never, id: string) => Promise<void>;
      },
    ) => {
      await input.seed?.(tx as never, "bot1");
      return { id: "bot1", name: input.name, threadId: "t1" } as unknown as Bot;
    },
  );
  const announceRoutine = vi.fn(async () => {});
  const services = {
    prisma: { user: { findUnique: vi.fn(async () => ({ timezone: "Europe/Paris" })) } },
    createBot,
    assertRoutineSchedule: vi.fn(),
    routineNextRunAt: vi.fn(() => null),
    routineRowData: vi.fn((_a: Actor, input: { name: string; active: boolean; botId: string }) => ({
      name: input.name,
      active: input.active,
      botId: input.botId,
    })),
    announceRoutine,
  } as unknown as HireServices;
  return { services, createBot, skills, routines, announceRoutine };
}

describe("listRoleTemplates", () => {
  it("lists every template with what policy blocks", () => {
    const items = listRoleTemplates({ version: 1, bots: { allowRoutines: false } });
    expect(items.length).toBeGreaterThanOrEqual(4);
    const executive = items.find((item) => item.template.id === "executive-assistant");
    expect(executive?.blocked).toContainEqual({
      part: "routines",
      ref: "",
      rule: "bots.allowRoutines",
    });
    const research = items.find((item) => item.template.id === "research-analyst");
    expect(research?.blocked).toEqual([]);
  });
});

describe("hireRole", () => {
  it("creates the bot with template instructions, skills and a paused routine", async () => {
    const h = harness();
    const result = await hireRole(
      h.services,
      actor,
      { templateId: "executive-assistant" },
      undefined,
    );
    expect(result.bot.id).toBe("bot1");
    expect(result.bot.name).toBe("Executive Assistant");
    expect(result.starterTask).toContain("briefing");
    expect(result.blocked).toEqual([]);
    const input = h.createBot.mock.calls[0]?.[1];
    expect(input?.instructions).toContain("Always ask me and wait for a yes");
    expect(h.skills.map((skill) => skill.name)).toEqual(["daily-briefing", "meeting-prep"]);
    expect(h.skills[0]?.content.startsWith("---\nname: daily-briefing")).toBe(true);
    expect(h.routines).toEqual([{ name: "Morning briefing", active: false, botId: "bot1" }]);
    expect(h.announceRoutine).toHaveBeenCalledTimes(1);
  });

  it("uses the chosen name and keeps skills that already exist", async () => {
    const h = harness(["daily-briefing"]);
    await hireRole(
      h.services,
      actor,
      { templateId: "executive-assistant", name: "Ada" },
      undefined,
    );
    expect(h.createBot.mock.calls[0]?.[1].name).toBe("Ada");
    expect(h.skills.map((skill) => skill.name)).toEqual(["meeting-prep"]);
  });

  it("leaves out routines that central policy refuses and reports them", async () => {
    const h = harness();
    const result = await hireRole(
      h.services,
      actor,
      { templateId: "executive-assistant" },
      { version: 1, bots: { allowRoutines: false } },
    );
    expect(h.routines).toEqual([]);
    expect(h.announceRoutine).not.toHaveBeenCalled();
    expect(result.blocked.map((item) => item.part)).toContain("routines");
    expect(h.skills.length).toBe(2);
  });

  it("rejects an unknown template before creating anything", async () => {
    const h = harness();
    await expect(
      hireRole(h.services, actor, { templateId: "nobody-here" }, undefined),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(h.createBot).not.toHaveBeenCalled();
  });
});
