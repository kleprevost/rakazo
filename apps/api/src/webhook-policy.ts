import { assertBotCapabilityAllowed, policyDenied } from "@rakazo/adapters";

/** Whether the policy switches inbound webhooks off. Records the denial; the bot is kept. */
export function webhookDenied(bot: { spaceId: string; userId: string }): Promise<boolean> {
  return policyDenied(() =>
    assertBotCapabilityAllowed("webhooks", {
      userId: bot.userId,
      spaceId: bot.spaceId,
      surface: "webhook",
    }),
  );
}
