import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getAssignmentWork, listAssignments } from "./assignments.js";
import type { PrismaClient } from "./client.js";
import { createDb } from "./client.js";
import { exportContent } from "./content-export.js";
import { provisionMessagingIdentity } from "./messaging.js";
import { asSystem, runAsSystem, runAsTenant } from "./row-security.js";
import { IsolationError } from "./scope.js";
import { getTicketWork } from "./work-items.js";

const databaseUrl = process.env.DATABASE_URL;
const describePostgres =
  process.env.VERIFY_DATABASE === "1" && databaseUrl ? describe.sequential : describe.skip;

type Person = { userId: string; spaceId: string; botId: string; threadId: string; address: string };

describePostgres("assignments (PostgreSQL)", () => {
  let prisma: PrismaClient;
  let system: PrismaClient;
  let close: () => Promise<void>;
  const people: Person[] = [];
  let creator: Person;
  let manager: Person;
  let collaborator: Person;
  let stranger: Person;
  let employeeId: string;
  let nonce = 0;

  async function person(): Promise<Person> {
    const address = `+1556${Math.floor(Math.random() * 9_000_000 + 1_000_000)}`;
    const identity = await runAsSystem("test fixture", () =>
      provisionMessagingIdentity(
        prisma,
        { provider: "sendblue", address },
        { signupsEnabled: undefined, signupAllowlist: undefined },
      ),
    );
    const { userId, spaceId, botId, threadId } = identity;
    people.push({ userId, spaceId, botId, threadId, address });
    return people.at(-1)!;
  }

  /** An assignment owned by `who`: its own botId-null thread, optionally with runs. */
  async function assignment(
    who: Person,
    options: { runs?: string[]; cancelled?: boolean; ticketStatus?: string } = {},
  ) {
    nonce += 1;
    const thread = await system.thread.create({
      data: { spaceId: who.spaceId, userId: who.userId },
    });
    let ticketId: string | undefined;
    if (options.ticketStatus) {
      const board = await system.board.upsert({
        where: { spaceId: who.spaceId },
        update: {},
        create: { spaceId: who.spaceId },
      });
      ticketId = (
        await system.ticket.create({
          data: {
            spaceId: who.spaceId,
            boardId: board.id,
            number: nonce,
            title: `T${nonce}`,
            status: options.ticketStatus,
          },
        })
      ).id;
    }
    const row = await system.assignment.create({
      data: {
        spaceId: who.spaceId,
        botId: who.botId,
        userId: who.userId,
        employeeId: who === creator ? employeeId : null,
        threadId: thread.id,
        ticketId,
        title: `Job ${nonce}`,
        clientNonce: `nonce-${nonce}-${Math.random()}`,
        cancelledAt: options.cancelled ? new Date() : null,
      },
    });
    const task = await system.task.create({
      data: {
        spaceId: who.spaceId,
        botId: who.botId,
        threadId: thread.id,
        userId: who.userId,
        prompt: "job",
        status: "running",
        ticketId,
      },
    });
    const runIds: string[] = [];
    for (const status of options.runs ?? []) {
      const run = await system.run.create({
        data: {
          spaceId: who.spaceId,
          botId: who.botId,
          threadId: thread.id,
          taskId: task.id,
          userId: who.userId,
          status,
          trigger: "assignment",
        },
      });
      runIds.push(run.id);
      await system.artifact.create({
        data: {
          spaceId: who.spaceId,
          botId: who.botId,
          userId: who.userId,
          runId: run.id,
          name: `file-${run.id}.md`,
          mimeType: "text/markdown",
          size: 1,
          hash: "h",
          storageKey: `assignments/${run.id}`,
        },
      });
    }
    return { row, thread, runIds };
  }

  const asCreator = <T>(fn: () => Promise<T>) =>
    runAsTenant({ spaceId: creator.spaceId, userId: creator.userId }, fn);

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
    creator = await person();
    manager = await person();
    collaborator = await person();
    stranger = await person();
    // The creator's bot is an instance of a shared employee; the manager and a collaborator are
    // entitled to the same employee, each in their own space.
    employeeId = (
      await system.employee.create({ data: { name: "Shared", createdByUserId: manager.userId } })
    ).id;
    await system.bot.update({ where: { id: creator.botId }, data: { employeeId } });
    for (const [who, role] of [
      [creator, "collaborator"],
      [manager, "manager"],
      [collaborator, "collaborator"],
    ] as const) {
      await system.employeeEntitlement.create({
        data: { employeeId, userId: who.userId, role, source: "grant" },
      });
    }
  });

  afterAll(async () => {
    try {
      if (prisma) {
        await system.employee.deleteMany({ where: { id: employeeId } });
        for (const who of people) {
          await system.messagingIdentity.deleteMany({
            where: { provider: "sendblue", address: who.address },
          });
          await system.organization.deleteMany({ where: { id: who.spaceId } });
          await system.user.deleteMany({ where: { id: who.userId } });
        }
      }
    } finally {
      await close?.();
    }
  });

  it("returns each assignment's own runs and files, never another thread's", async () => {
    const a = await assignment(creator, { runs: ["completed", "waiting_input"] });
    const b = await assignment(creator, { runs: ["running"] });
    // The employee's primary chat has a run too.
    const primaryTask = await system.task.create({
      data: {
        spaceId: creator.spaceId,
        botId: creator.botId,
        threadId: creator.threadId,
        userId: creator.userId,
        prompt: "chat",
        status: "running",
      },
    });
    await system.run.create({
      data: {
        spaceId: creator.spaceId,
        botId: creator.botId,
        threadId: creator.threadId,
        taskId: primaryTask.id,
        userId: creator.userId,
        status: "failed",
        trigger: "user_message",
      },
    });

    const workA = await asCreator(() => getAssignmentWork(prisma, creator, a.row.id));
    const workB = await asCreator(() => getAssignmentWork(prisma, creator, b.row.id));
    expect(workA.runs.map((run) => run.id).sort()).toEqual([...a.runIds].sort());
    expect(workA.runs.every((run) => run.threadId === a.thread.id)).toBe(true);
    expect(workA.artifacts.map((file) => file.runId).sort()).toEqual([...a.runIds].sort());
    expect(workA.phase).toBe("waiting");
    expect(workB.runs.map((run) => run.id)).toEqual(b.runIds);
    expect(workB.artifacts).toHaveLength(1);
    expect(workB.phase).toBe("running");
    expect(workA.botId).toBe(workB.botId);
  });

  it("derives the phase from the ticket, cancellation and the newest run", async () => {
    const done = await assignment(creator, { ticketStatus: "done", runs: ["completed"] });
    const cancelled = await assignment(creator, { cancelled: true, runs: ["running"] });
    const failed = await assignment(creator, { runs: ["failed"] });
    const fresh = await assignment(creator);
    const phases = await asCreator(async () => ({
      done: (await getAssignmentWork(prisma, creator, done.row.id)).phase,
      cancelled: (await getAssignmentWork(prisma, creator, cancelled.row.id)).phase,
      failed: (await getAssignmentWork(prisma, creator, failed.row.id)).phase,
      fresh: (await getAssignmentWork(prisma, creator, fresh.row.id)).phase,
    }));
    expect(phases).toEqual({
      done: "done",
      cancelled: "cancelled",
      failed: "failed",
      fresh: "ready",
    });
  });

  it("names a ticket's assignment in its work only to the person who owns it", async () => {
    const job = await assignment(creator, { ticketStatus: "doing", runs: ["running"] });
    const ticket = { id: job.row.ticketId!, status: "doing" };
    const own = await asCreator(() =>
      getTicketWork(prisma, creator.spaceId, ticket, creator.userId),
    );
    expect(own.assignmentId).toBe(job.row.id);
    const other = await asCreator(() =>
      getTicketWork(prisma, creator.spaceId, ticket, collaborator.userId),
    );
    expect(other.assignmentId).toBeNull();
    const none = await asCreator(() => getTicketWork(prisma, creator.spaceId, ticket));
    expect(none.assignmentId).toBeNull();
  });

  it("lists active and archived assignments in pages, filtered by employee", async () => {
    const mine = await assignment(creator);
    await system.assignment.update({
      where: { id: mine.row.id },
      data: { archivedAt: new Date() },
    });
    const active = await asCreator(() =>
      listAssignments(prisma, creator, { state: "active", limit: 2 }),
    );
    expect(active.items).toHaveLength(2);
    expect(active.nextCursor).not.toBeNull();
    const next = await asCreator(() =>
      listAssignments(prisma, creator, { state: "active", limit: 100, cursor: active.nextCursor! }),
    );
    const seen = [...active.items, ...next.items].map((item) => item.id);
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen).not.toContain(mine.row.id);
    const archived = await asCreator(() =>
      listAssignments(prisma, creator, { state: "archived", botId: creator.botId, limit: 10 }),
    );
    expect(archived.items.map((item) => item.id)).toEqual([mine.row.id]);
    const none = await asCreator(() =>
      listAssignments(prisma, creator, { state: "active", botId: "other-bot", limit: 10 }),
    );
    expect(none.items).toEqual([]);
  });

  it("hides rows from other spaces and from collaborators of the same employee", async () => {
    const { row } = await assignment(creator);
    for (const other of [stranger, collaborator]) {
      const visible = await runAsTenant(other, () =>
        prisma.assignment.findMany({ where: { id: row.id } }),
      );
      expect(visible).toEqual([]);
      await expect(
        runAsTenant(other, () => getAssignmentWork(prisma, other, row.id)),
      ).rejects.toBeInstanceOf(IsolationError);
    }
    // Same space, different person: the row is still not theirs.
    const sameSpace = await runAsTenant({ spaceId: creator.spaceId, userId: stranger.userId }, () =>
      prisma.assignment.findMany({ where: { id: row.id } }),
    );
    expect(sameSpace).toEqual([]);
  });

  it("rejects writes into another person's space or rows", async () => {
    const { row, thread } = await assignment(creator);
    await expect(
      runAsTenant(stranger, () =>
        prisma.assignment.create({
          data: {
            spaceId: creator.spaceId,
            botId: creator.botId,
            userId: stranger.userId,
            threadId: thread.id,
            title: "x",
            clientNonce: `intruder-${Math.random()}`,
          },
        }),
      ),
    ).rejects.toThrow();
    const changed = await runAsTenant(stranger, () =>
      prisma.assignment.updateMany({ where: { id: row.id }, data: { title: "hijacked" } }),
    );
    expect(changed.count).toBe(0);
    const removed = await runAsTenant(stranger, () =>
      prisma.assignment.deleteMany({ where: { id: row.id } }),
    );
    expect(removed.count).toBe(0);
  });

  it("lets an Owner or Manager of the employee read the row but nothing else", async () => {
    const { row, thread } = await assignment(creator, { runs: ["running"] });
    const seen = await runAsTenant(manager, () =>
      prisma.assignment.findMany({ where: { id: row.id } }),
    );
    expect(seen.map((item) => item.id)).toEqual([row.id]);
    // The transcript and runs stay private to the creator.
    expect(
      await runAsTenant(manager, () => prisma.thread.findMany({ where: { id: thread.id } })),
    ).toEqual([]);
    expect(
      await runAsTenant(manager, () => prisma.run.findMany({ where: { threadId: thread.id } })),
    ).toEqual([]);
    // Read-only, and the creator-scoped read model does not widen.
    const changed = await runAsTenant(manager, () =>
      prisma.assignment.updateMany({ where: { id: row.id }, data: { title: "taken" } }),
    );
    expect(changed.count).toBe(0);
    await expect(
      runAsTenant(manager, () => getAssignmentWork(prisma, manager, row.id)),
    ).rejects.toBeInstanceOf(IsolationError);
  });

  it("stops showing a revoked manager the row", async () => {
    const { row } = await assignment(creator);
    await system.employeeEntitlement.update({
      where: { employeeId_userId_source: { employeeId, userId: manager.userId, source: "grant" } },
      data: { role: "collaborator" },
    });
    try {
      const seen = await runAsTenant(manager, () =>
        prisma.assignment.findMany({ where: { id: row.id } }),
      );
      expect(seen).toEqual([]);
    } finally {
      await system.employeeEntitlement.update({
        where: {
          employeeId_userId_source: { employeeId, userId: manager.userId, source: "grant" },
        },
        data: { role: "manager" },
      });
    }
  });

  it("keeps the employee's primary thread lookups on the primary chat", async () => {
    await assignment(creator);
    const primary = await asCreator(() =>
      prisma.thread.findFirst({ where: { botId: creator.botId } }),
    );
    expect(primary?.id).toBe(creator.threadId);
    const orphans = await system.thread.count({
      where: { spaceId: creator.spaceId, botId: null, groupId: null, assignment: null },
    });
    expect(orphans).toBe(0);
  });

  it("exports an assignment thread as the employee's own conversation", async () => {
    const { thread } = await assignment(creator);
    await system.message.create({
      data: {
        threadId: thread.id,
        seq: 0,
        role: "user",
        blocks: [{ kind: "text", text: "do the thing" }],
      },
    });
    await system.thread.update({
      where: { id: thread.id },
      data: { historyCompactionSummary: "summary of the job" },
    });
    const records = await runAsSystem("test export", async () => {
      const out: Array<{ type: string; historyCompactionSummary?: string | null }> = [];
      for await (const record of exportContent(prisma, {
        botId: creator.botId,
        threadId: thread.id,
      }))
        out.push(record);
      return out;
    });
    expect(records.find((record) => record.type === "thread")?.historyCompactionSummary).toBe(
      "summary of the job",
    );
    expect(records.filter((record) => record.type === "message")).toHaveLength(1);
  });

  it("deletes an assignment's thread when the thread goes, and the row with it", async () => {
    const { row, thread } = await assignment(creator);
    await system.thread.delete({ where: { id: thread.id } });
    expect(await system.assignment.findUnique({ where: { id: row.id } })).toBeNull();
  });

  it("makes create idempotent per space and nonce", async () => {
    const { row } = await assignment(creator);
    const thread = await system.thread.create({
      data: { spaceId: creator.spaceId, userId: creator.userId },
    });
    await expect(
      system.assignment.create({
        data: {
          spaceId: creator.spaceId,
          botId: creator.botId,
          userId: creator.userId,
          threadId: thread.id,
          title: "dup",
          clientNonce: row.clientNonce,
        },
      }),
    ).rejects.toThrow();
    await system.thread.delete({ where: { id: thread.id } });
  });
});
