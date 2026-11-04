/**
 * What a run of an employee instance is made of: the published definition plus the person's own
 * bot. Pure, so the rules are testable without a database. The definition may only narrow what the
 * person's bot can do, never widen it, and it never carries anything from another person's data.
 */

export type EmployeeRunVersion = {
  role: string;
  instructions: string;
  capabilityPolicy: Record<string, unknown>;
  modelPolicy: Record<string, unknown>;
};

export type EmployeeRunBot = {
  description: string;
  instructions: string;
  disabledBuiltinTools: string[];
  modelProvider: string | null;
  modelId: string | null;
  thinkingLevel: string | null;
};

export type ComposedEmployeeBot = {
  description: string;
  instructions: string;
  disabledBuiltinTools: string[];
  modelProvider: string | null;
  modelId: string | null;
  thinkingLevel: string | null;
  /** Instances never talk to bots in other spaces, and keep their memory to themselves. */
  crossSpaceCommunication: false;
  memoryScope: "isolated";
};

const text = (value: unknown): string | null =>
  typeof value === "string" && value.trim() ? value.trim() : null;

const names = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];

/**
 * The person's own note on top of the definition. A copy of a published definition (the bot an
 * Owner shared in place still holds its original text) is not a note, so it is dropped rather
 * than repeated.
 */
function personalAddendum(own: string, publishedInstructions: readonly string[]): string {
  const note = own.trim();
  if (!note) return "";
  return publishedInstructions.some((published) => published.trim() === note) ? "" : note;
}

/**
 * Role and instructions come from the version; the person's note follows it. Tools the version
 * switches off stay off for everyone. A model policy fills in only where the person chose no
 * model of their own.
 */
export function composeEmployeeBot(
  bot: EmployeeRunBot,
  version: EmployeeRunVersion,
  publishedInstructions: readonly string[],
): ComposedEmployeeBot {
  const note = personalAddendum(bot.instructions, publishedInstructions);
  const definition = version.instructions.trim();
  const instructions = [
    definition,
    note ? `Your own notes from the person you work with, private to them:\n${note}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
  const policyProvider = text(version.modelPolicy.modelProvider);
  const policyModel = text(version.modelPolicy.modelId);
  const ownModel = Boolean(bot.modelProvider && bot.modelId);
  const usePolicyModel = !ownModel && policyProvider !== null && policyModel !== null;
  return {
    description: text(version.role) ?? bot.description,
    instructions,
    disabledBuiltinTools: [
      ...new Set([
        ...bot.disabledBuiltinTools,
        ...names(version.capabilityPolicy.disabledBuiltinTools),
      ]),
    ],
    modelProvider: usePolicyModel ? policyProvider : bot.modelProvider,
    modelId: usePolicyModel ? policyModel : bot.modelId,
    thinkingLevel: bot.thinkingLevel ?? text(version.modelPolicy.thinkingLevel),
    crossSpaceCommunication: false,
    memoryScope: "isolated",
  };
}
