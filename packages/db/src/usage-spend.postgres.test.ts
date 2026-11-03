import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PrismaClient } from "./client.js";
import { createDb } from "./client.js";
import { asSystem } from "./row-security.js";
import { periodSpendUsd } from "./usage-spend.js";

const databaseUrl = process.env.DATABASE_URL;
const describePostgres =
  process.env.VERIFY_DATABASE && databaseUrl ? describe.sequential : describe.skip;

describePostgres("period spend for budgets (PostgreSQL)", () => {
  const suffix = `${process.pid}-${Date.now()}`;
  const organizationId = `spend-org-${suffix}`;
  const spaces = [`spend-space-a-${suffix}`, `spend-space-b-${suffix}`];
  const [alice, bob] = [`spend-alice-${suffix}`, `spend-bob-${suffix}`];
  const [botA, botB] = [`spend-bot-a-${suffix}`, `spend-bot-b-${suffix}`];
  // A period nothing else in a shared test database writes to.
  const since = new Date("2099-01-01T00:00:00Z");
  let db: ReturnType<typeof createDb>;
  let prisma: PrismaClient;

  beforeAll(async () => {
    db = createDb(databaseUrl!);
    prisma = asSystem(db.prisma);
    await prisma.organization.create({
      data: { id: organizationId, name: "Spend Org", slug: organizationId, createdAt: new Date() },
    });
    for (const id of spaces) {
      await prisma.space.create({ data: { id, organizationId, name: id } });
    }
    const row = (
      spaceId: string,
      userId: string,
      botId: string | null,
      costUsd: number | null,
      createdAt: string,
    ) => ({
      spaceId,
      userId,
      botId,
      provider: "p",
      model: "m",
      costUsd,
      createdAt: new Date(createdAt),
    });
    await prisma.usageRecord.createMany({
      data: [
        row(spaces[0]!, alice, botA, 1.5, "2099-01-10T00:00:00Z"),
        row(spaces[1]!, alice, botB, 2, "2099-01-11T00:00:00Z"),
        row(spaces[0]!, bob, botA, 4, "2099-01-12T00:00:00Z"),
        row(spaces[0]!, bob, null, null, "2099-01-12T00:00:00Z"),
        // Before the period: never counted.
        row(spaces[0]!, alice, botA, 100, "2098-12-31T23:59:59Z"),
      ],
    });
  });

  afterAll(async () => {
    await prisma.usageRecord.deleteMany({ where: { spaceId: { in: spaces } } });
    await prisma.organization.deleteMany({ where: { id: organizationId } });
    await db.prisma.$disconnect();
    await db.pool.end();
  });

  it("sums the period across Spaces for the organization, one user and one bot", async () => {
    // The caller's own client has no tenant context; the spend read must not depend on one.
    await expect(periodSpendUsd(db.prisma, { userId: alice, botId: botA, since })).resolves.toEqual(
      { organization: 7.5, user: 3.5, bot: 5.5 },
    );
    await expect(periodSpendUsd(db.prisma, { userId: bob, botId: botB, since })).resolves.toEqual({
      organization: 7.5,
      user: 4,
      bot: 2,
    });
  });

  it("is zero for an unknown user and a run with no bot", async () => {
    await expect(
      periodSpendUsd(db.prisma, { userId: "nobody", botId: null, since }),
    ).resolves.toEqual({ organization: 7.5, user: 0, bot: 0 });
  });
});
