import { ORPCError } from "@orpc/server";
import type { Actor } from "@rakazo/contracts";
import type { createRepos } from "@rakazo/db";
import { recordSecurityEvent } from "@rakazo/db";
import { authorize } from "./employees.js";
import type { RouterDeps } from "./router.js";

type InstanceDeps = Pick<RouterDeps, "prisma" | "env">;

const isUniqueViolation = (error: unknown) =>
  typeof error === "object" && error !== null && (error as { code?: unknown }).code === "P2002";

/**
 * Gives the caller their own instance of an employee: a full bot in their own space, owned by
 * them, so its thread, memory, computer and secrets are theirs alone. It copies nothing from the
 * definition or from anyone else's instance, and repeating it returns the same bot. Asked in
 * this order: may they use the employee, do they already have an instance, is the feature on.
 */
export async function addInstance(
  deps: InstanceDeps,
  repos: Pick<ReturnType<typeof createRepos>, "createBot">,
  actor: Actor,
  input: { employeeId: string },
): Promise<{ botId: string; created: boolean }> {
  const { employeeId } = input;
  const { employee } = await authorize(deps.prisma, actor.userId, employeeId, "use");
  const existing = () =>
    deps.prisma.bot.findFirst({
      where: { employeeId, userId: actor.userId },
      select: { id: true },
    });
  const found = await existing();
  if (found) return { botId: found.id, created: false };
  if (!deps.env.sharedEmployeesEnabled)
    throw new ORPCError("FORBIDDEN", { message: "Shared employees are not turned on" });
  // True only in the request whose transaction linked the bot; a concurrent twin gets the same bot back.
  let linked = false;
  try {
    const bot = await repos.createBot(actor, {
      name: employee.name,
      description: employee.description,
      instructions: "",
      notifyOnFinish: true,
      spawnKey: `employee-${employeeId}`,
      // Set in the creation transaction: a second request for the same person fails on the
      // one-instance-per-person index and rolls back, so no half-linked bot is left behind.
      seed: async (tx, botId) => {
        await tx.bot.update({
          where: { id: botId },
          data: { employeeId, crossSpaceCommunication: false, memoryScope: "isolated" },
        });
        linked = true;
      },
    });
    if (linked) {
      await recordSecurityEvent({
        type: "employee.instance_created",
        userId: actor.userId,
        spaceId: actor.spaceId,
        metadata: { employeeId, botId: bot.id },
      });
    }
    return { botId: bot.id, created: linked };
  } catch (error) {
    // Lost a race with this person's other request: theirs is the instance.
    const winner = isUniqueViolation(error) ? await existing() : null;
    if (!winner) throw error;
    return { botId: winner.id, created: false };
  }
}
