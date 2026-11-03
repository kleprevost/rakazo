import type { Actor, Bot } from "@rakazo/contracts";
import { describe, expect, it, vi } from "vitest";
import type { HireServices } from "./role-templates.js";
import { hireRole, listRoleTemplates } from "./role-templates.js";

const actor = { userId: "u1", spaceId: "s1" } as Actor;

function harness(existingSkills: string[] = [], sendFails?: string) {
  /** Saved first messages by nonce, as the thread's unique (threadId, clientNonce) keeps them. */
  const starterMessages = new Map<string, string>();
  const botsByKey = new Map<string, Bot>();
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
        spawnKey?: string;
        seed?: (tx: never, id: string) => Promise<void>;
      },
    ) => {
      const existing = input.spawnKey ? botsByKey.get(input.spawnKey) : undefined;
      if (existing) return existing;
      await input.seed?.(tx as never, "bot1");
      const bot = { id: "bot1", name: input.name, threadId: "t1" } as unknown as Bot;
      if (input.spawnKey) botsByKey.set(input.spawnKey, bot);
      return bot;
    },
  );
  const sendStarter = vi.fn(async (_a: Actor, _botId: string, text: string, nonce: string) => {
    if (sendFails) throw new Error(sendFails);
    if (!starterMessages.has(nonce)) starterMessages.set(nonce, text);
  });
  const announceRoutine = vi.fn(async () => {});
  const services = {
    prisma: { user: { findUnique: vi.fn(async () => ({ timezone: "Europe/Paris" })) } },
    createBot,
    sendStarter,
    assertRoutineSchedule: vi.fn(),
    routineNextRunAt: vi.fn(() => null),
    routineRowData: vi.fn((_a: Actor, input: { name: string; active: boolean; botId: string }) => ({
      name: input.name,
      active: input.active,
      botId: input.botId,
    })),
    announceRoutine,
  } as unknown as HireServices;
  return { services, createBot, sendStarter, starterMessages, skills, routines, announceRoutine };
}

const key = "hire-attempt-0001";

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
      { templateId: "executive-assistant", idempotencyKey: key },
      undefined,
    );
    expect(result.bot.id).toBe("bot1");
    expect(result.bot.name).toBe("Executive Assistant");
    expect(result.starter).toEqual({ status: "queued" });
    expect([...h.starterMessages.values()][0]).toContain("briefing");
    expect(result.blocked).toEqual([]);
    const input = h.createBot.mock.calls[0]?.[1];
    expect(input?.instructions).toContain("Always ask me and wait for a yes");
    expect(h.skills.map((skill) => skill.name)).toEqual(["executive-briefing", "meeting-prep"]);
    expect(h.skills[0]?.content.startsWith("---\nname: executive-briefing")).toBe(true);
    expect(h.routines).toEqual([{ name: "Morning briefing", active: false, botId: "bot1" }]);
    expect(h.announceRoutine).toHaveBeenCalledTimes(1);
  });

  it("uses the chosen name and keeps skills that already exist", async () => {
    const h = harness(["executive-briefing"]);
    await hireRole(
      h.services,
      actor,
      { templateId: "executive-assistant", name: "Ada", idempotencyKey: key },
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
      { templateId: "executive-assistant", idempotencyKey: key },
      { version: 1, bots: { allowRoutines: false } },
    );
    expect(h.routines).toEqual([]);
    expect(h.announceRoutine).not.toHaveBeenCalled();
    expect(result.blocked.map((item) => item.part)).toContain("routines");
    expect(h.skills.length).toBe(2);
  });

  it("returns the same bot and one starter message when the same key is retried", async () => {
    const h = harness();
    const input = { templateId: "executive-assistant", idempotencyKey: key };
    const first = await hireRole(h.services, actor, input, undefined);
    const second = await hireRole(h.services, actor, input, undefined);
    expect(second.bot.id).toBe(first.bot.id);
    expect(h.createBot.mock.calls.map(([, call]) => call.spawnKey)).toEqual([
      `hire:u1:${key}`,
      `hire:u1:${key}`,
    ]);
    expect(h.starterMessages.size).toBe(1);
    expect(h.routines.length).toBe(1);
  });

  it("reports a starter that could not be queued", async () => {
    const down = harness([], "Set up a model to start chatting.");
    const failed = await hireRole(
      down.services,
      actor,
      { templateId: "executive-assistant", idempotencyKey: key },
      undefined,
    );
    expect(failed.bot.id).toBe("bot1");
    expect(failed.starter).toEqual({
      status: "failed",
      reason: "Set up a model to start chatting.",
    });
    expect(down.sendStarter.mock.calls[0]?.[3]).toBe(`hire-starter:${key}`);
  });

  it("rejects an unknown template before creating anything", async () => {
    const h = harness();
    await expect(
      hireRole(h.services, actor, { templateId: "nobody-here", idempotencyKey: key }, undefined),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(h.createBot).not.toHaveBeenCalled();
  });
});
