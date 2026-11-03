import { ORPCError } from "@orpc/server";
import type {
  Actor,
  Bot,
  HireRoleInput,
  HireRoleOutput,
  Policy,
  RoleTemplate,
  RoleTemplateListItem,
} from "@rakazo/contracts";
import { CreateRoutineInput, isValidTimeZone } from "@rakazo/contracts";
import {
  buildSkillMd,
  evaluateRoleTemplate,
  findRoleTemplate,
  ROLE_TEMPLATES,
  roleTemplateInstructions,
} from "@rakazo/core";
import type { createRepos, Prisma, PrismaClient, Routine } from "@rakazo/db";
import { availableInSpace } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import type { AgentImportServices } from "./agent-import.js";

/** The router's own write paths, so a hired role is validated and scheduled like one made by hand. */
export type HireServices = Pick<
  AgentImportServices,
  "assertRoutineSchedule" | "routineNextRunAt" | "routineRowData" | "announceRoutine"
> & {
  prisma: Pick<PrismaClient, "user">;
  createBot: ReturnType<typeof createRepos>["createBot"];
};

/** Every template, each with the parts central policy refuses. */
export function listRoleTemplates(policy: Policy | undefined): RoleTemplateListItem[] {
  return ROLE_TEMPLATES.map((template) => ({
    template,
    blocked: evaluateRoleTemplate(policy, template),
  }));
}

type Seeded = { routines: Routine[] };

/** Skills are shared with the owner's other bots; one that already exists by name is kept. */
async function seedSkills(tx: Prisma.TransactionClient, actor: Actor, template: RoleTemplate) {
  for (const skill of template.skills) {
    const exists = await tx.agentSkill.findFirst({
      where: { ...availableInSpace(actor), name: { equals: skill.name, mode: "insensitive" } },
      select: { id: true },
    });
    if (exists) continue;
    await tx.agentSkill.create({
      data: {
        spaceId: actor.spaceId,
        userId: actor.userId,
        name: skill.name,
        description: skill.description,
        content: `${buildSkillMd(skill)}\n`,
        source: "user",
      },
    });
  }
}

/**
 * Creates the bot, its skills and its (paused) routines in one transaction, then sends nothing
 * itself: the caller delivers `starterTask` as the bot's first message. Parts central policy
 * refuses are left out and reported, never created.
 */
export async function hireRole(
  services: HireServices,
  actor: Actor,
  input: HireRoleInput,
  policy: Policy | undefined,
): Promise<HireRoleOutput> {
  const template = findRoleTemplate(input.templateId);
  if (!template) throw new ORPCError("NOT_FOUND", { message: "Unknown role." });
  const blocked = evaluateRoleTemplate(policy, template);
  const routinesAllowed = !blocked.some((item) => item.part === "routines");

  let timezone = "UTC";
  if (routinesAllowed && template.routines.length) {
    const saved = (
      await services.prisma.user.findUnique({
        where: { id: actor.userId },
        select: { timezone: true },
      })
    )?.timezone;
    if (saved && isValidTimeZone(saved)) timezone = saved;
  }
  // Validated before anything is written; the bot id replaces the placeholder in the seed.
  const routineInputs = routinesAllowed
    ? template.routines.map((routine) => {
        const parsed = CreateRoutineInput.safeParse({
          botId: "pending",
          name: routine.name,
          prompt: routine.prompt,
          crons: [routine.cron],
          timezone,
          active: false,
        });
        if (!parsed.success) {
          throw new ORPCError("BAD_REQUEST", { message: `Invalid schedule for ${routine.name}.` });
        }
        services.assertRoutineSchedule(parsed.data);
        services.routineNextRunAt(parsed.data);
        return parsed.data;
      })
    : [];

  const seeded: Seeded = { routines: [] };
  const bot: Bot = await services.createBot(actor, {
    name: input.name ?? template.name,
    description: template.description,
    instructions: roleTemplateInstructions(template),
    notifyOnFinish: true,
    computerMode: "team",
    seed: async (tx, botId) => {
      // A serialization retry runs the seed again: start clean.
      seeded.routines = [];
      await seedSkills(tx, actor, template);
      for (const routine of routineInputs) {
        const withBot = { ...routine, botId };
        seeded.routines.push(
          await tx.routine.create({
            data: services.routineRowData(actor, withBot, services.routineNextRunAt(withBot)),
          }),
        );
      }
    },
  });

  const thread = bot.threadId ? { id: bot.threadId } : null;
  for (const row of seeded.routines) {
    await services.announceRoutine(actor, { id: bot.id, thread }, row).catch((error: unknown) => {
      getLogger().error("hired routine notice", error);
    });
  }
  return { bot, starterTask: template.starterTask, blocked };
}
