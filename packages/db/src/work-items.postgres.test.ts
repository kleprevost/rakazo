import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ensureBoard } from "./board.js";
import type { PrismaClient } from "./client.js";
import { createDb } from "./client.js";
import { finalizeRun } from "./events.js";
import { provisionMessagingIdentity } from "./messaging.js";
import { asSystem, runAsSystem, runAsTenant } from "./row-security.js";
import { getTicketWork, listWorkItems } from "./work-items.js";

const databaseUrl = process.env.DATABASE_URL;
const describePostgres =
  process.env.VERIFY_DATABASE === "1" && databaseUrl ? describe.sequential : describe.skip;

describePostgres("work items (PostgreSQL)", () => {
  let prisma: PrismaClient;
  let system: PrismaClient;
  let close: () => Promise<void>;
  let provisioned = false;
  let userId: string;
  let spaceId: string;
  let botId: string;
  let threadId: string;
  let boardId: string;
  let number = 0;
  const address = `+1555${Math.floor(Math.random() * 9_000_000 + 1_000_000)}`;

  beforeAll(async () => {
    const db = createDb(databaseUrl!);
    prisma = db.prisma;
    system = asSystem(prisma);
    close = async () => {
      try {
        await db.prisma.$disconnect();
      } finally {
        await db.pool.end();
      }
    };
    ({ userId, spaceId, botId, threadId } = await runAsSystem("test fixture", () =>
      provisionMessagingIdentity(
        prisma,
        { provider: "sendblue", address },
        { signupsEnabled: undefined, signupAllowlist: undefined },
      ),
    ));
    provisioned = true;
    boardId = (await runAsTenant({ spaceId, userId }, () => ensureBoard(prisma, spaceId))).id;
  });

  afterAll(async () => {
    try {
      if (prisma && provisioned) {
        await system.messagingIdentity.deleteMany({ where: { provider: "sendblue", address } });
        await system.organization.deleteMany({ where: { id: spaceId } });
        await system.user.deleteMany({ where: { id: userId } });
      }
    } finally {
      await close?.();
    }
  });

  async function workedTicket(status: string, runStatus: string) {
    number += 1;
    const ticket = await system.ticket.create({
      data: { spaceId, boardId, number, title: `Work ${number}`, status, assigneeBotId: botId },
    });
    const task = await system.task.create({
      data: {
        spaceId,
        botId,
        threadId,
        userId,
        prompt: "work",
        status: "running",
        ticketId: ticket.id,
      },
    });
    const run = await system.run.create({
      data: {
        spaceId,
        botId,
        threadId,
        taskId: task.id,
        userId,
        status: runStatus,
        trigger: "tickets",
        startedAt: new Date(),
        leaseOwner: "worker-1",
        leaseFence: 1,
      },
    });
    return { ticket, task, run };
  }

  it("lists the runs and artifacts linked to a ticket", async () => {
    const { ticket, run } = await workedTicket("doing", "waiting_input");
    await system.artifact.create({
      data: {
        spaceId,
        botId,
        userId,
        runId: run.id,
        name: "report.md",
        mimeType: "text/markdown",
        size: 3,
        hash: "h",
        storageKey: `work-items/${run.id}`,
      },
    });
    const work = await runAsTenant({ spaceId, userId }, () =>
      getTicketWork(prisma, spaceId, ticket),
    );
    expect(work.phase).toBe("waiting");
    expect(work.runs.map((item) => item.id)).toEqual([run.id]);
    expect(work.artifacts.map((item) => item.name)).toEqual(["report.md"]);
    const items = await runAsTenant({ spaceId, userId }, () =>
      listWorkItems(prisma, spaceId, { phases: ["waiting"] }),
    );
    expect(items.map((item) => item.id)).toContain(ticket.id);
  });

  it("moves a worked ticket to review when its run completes", async () => {
    const { ticket, task, run } = await workedTicket("doing", "running");
    const attempt = await system.attempt.create({
      data: { runId: run.id, fence: 1, status: "running" },
    });
    await runAsTenant({ spaceId, userId }, () =>
      finalizeRun(prisma, {
        spaceId,
        threadId,
        botId,
        runId: run.id,
        taskId: task.id,
        attemptId: attempt.id,
        leaseOwner: "worker-1",
        leaseFence: 1,
        outcome: "completed",
        blocks: [{ kind: "text", text: "Done." }],
      }),
    );
    expect((await system.ticket.findUniqueOrThrow({ where: { id: ticket.id } })).status).toBe(
      "review",
    );
  });

  it("blocks a worked ticket when its run fails but leaves a finished one alone", async () => {
    const failing = await workedTicket("doing", "running");
    const finished = await workedTicket("done", "running");
    for (const item of [failing, finished]) {
      const attempt = await system.attempt.create({
        data: { runId: item.run.id, fence: 1, status: "running" },
      });
      await runAsTenant({ spaceId, userId }, () =>
        finalizeRun(prisma, {
          spaceId,
          threadId,
          botId,
          runId: item.run.id,
          taskId: item.task.id,
          attemptId: attempt.id,
          leaseOwner: "worker-1",
          leaseFence: 1,
          outcome: "failed",
          error: "boom",
        }),
      );
    }
    expect(
      (await system.ticket.findUniqueOrThrow({ where: { id: failing.ticket.id } })).status,
    ).toBe("blocked");
    expect(
      (await system.ticket.findUniqueOrThrow({ where: { id: finished.ticket.id } })).status,
    ).toBe("done");
    const work = await runAsTenant({ spaceId, userId }, () =>
      getTicketWork(prisma, spaceId, failing.ticket),
    );
    expect(work.phase).toBe("failed");
  });
});
