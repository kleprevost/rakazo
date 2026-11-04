import { vi } from "vitest";

type Fn = ((...args: unknown[]) => Promise<unknown>) & { runGates?: true };
type Table = Record<string, Fn | undefined>;
type MockClient = {
  bot?: Table;
  quarantine?: Table;
  capabilityGrant?: Table;
  routine?: Table;
  publishedSkillAudience?: Table;
  userDirectoryClaim?: Table;
  $transaction?: unknown;
};

const BOT_GATE_FIELDS = {
  suspendedAt: null,
  name: "Assistant",
  spaceId: "space-1",
  groupMembers: [],
  capabilityMode: null,
  employeeId: null,
};

/**
 * Gives a mocked client the reads every run start and tool gate makes, answering "allowed":
 * the bot is not suspended, no quarantine covers it, the capability broker is off with no grants, no skill is published to the person, and a routine claim succeeds. A test's own
 * fake for the same method wins, and a bot row it returns is completed with the gate fields it
 * leaves out, so a test of a blocked bot still defines its own answer. A new run-start gate adds
 * its default here, once, in the same change that adds the gate.
 */
export function withRunGates<T>(prisma: T): T {
  const client = prisma as MockClient | null;
  if (!client || typeof client !== "object") return prisma;
  const gate = (target: MockClient) => {
    const bot = target.bot ?? {};
    target.bot = bot;
    const own = bot.findUnique;
    if (!own?.runGates) {
      bot.findUnique = Object.assign(
        own
          ? vi.fn(async (...args: unknown[]) => {
              const row = await own(...args);
              return row && typeof row === "object" ? { ...BOT_GATE_FIELDS, ...row } : row;
            })
          : vi.fn(async () => ({ ...BOT_GATE_FIELDS })),
        { runGates: true as const },
      );
    }
    target.quarantine = { findFirst: vi.fn(async () => null), ...target.quarantine };
    target.capabilityGrant = { findMany: vi.fn(async () => []), ...target.capabilityGrant };
    target.publishedSkillAudience = {
      findMany: vi.fn(async () => []),
      ...target.publishedSkillAudience,
    };
    target.userDirectoryClaim = {
      findUnique: vi.fn(async () => null),
      ...target.userDirectoryClaim,
    };
    target.routine = { updateMany: vi.fn(async () => ({ count: 1 })), ...target.routine };
    return target;
  };
  gate(client);
  const transaction = client.$transaction as Fn | undefined;
  if (typeof transaction === "function") {
    client.$transaction = vi.fn((work: unknown, ...rest: unknown[]) =>
      transaction(
        typeof work === "function"
          ? (tx: MockClient) => (work as (tx: MockClient) => unknown)(gate(tx))
          : work,
        ...rest,
      ),
    );
  }
  return prisma;
}
