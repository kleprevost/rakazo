import { randomUUID } from "node:crypto";
import type { DirectoryClaimsResult, DirectorySubject } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import { asSystem, createDb, installSecurityEventStore } from "@rakazo/db";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { runDirectorySync } from "./directory-sync.js";

const databaseUrl = process.env.DATABASE_URL;
const enabled = process.env.VERIFY_DATABASE === "1" && Boolean(databaseUrl);

const HOUR = 3_600_000;
const intervalMs = HOUR;

describe.skipIf(!enabled)("directory group sync (PostgreSQL)", () => {
  let prisma: PrismaClient;
  let system: PrismaClient;
  let close: () => Promise<void>;
  let employeeId: string;
  let suffix: string;
  const users: string[] = [];
  const answers = new Map<string, DirectoryClaimsResult | Error>();
  const asked: string[] = [];
  const source = {
    claimsFor: vi.fn(async (subject: DirectorySubject) => {
      asked.push(subject.userId);
      const answer = answers.get(subject.userId);
      if (answer instanceof Error) throw answer;
      if (!answer) throw new Error("no answer prepared");
      return answer;
    }),
  };
  const sync = (now = new Date()) =>
    runDirectorySync({ prisma, source, intervalMs, now: () => now });

  beforeAll(() => {
    const db = createDb(databaseUrl!);
    prisma = db.prisma;
    system = asSystem(prisma);
    installSecurityEventStore(prisma);
    close = async () => {
      installSecurityEventStore(undefined);
      await prisma.$disconnect();
      await db.pool.end();
    };
  });
  beforeEach(async () => {
    suffix = randomUUID();
    users.length = 0;
    answers.clear();
    asked.length = 0;
    employeeId = `emp-${suffix}`;
    await system.employee.create({
      data: { id: employeeId, name: "Sync", createdByUserId: "creator", status: "published" },
    });
    await system.employeeGrant.create({
      data: {
        employeeId,
        subjectKind: "claim",
        subjectValue: `group-${suffix}`,
        role: "viewer",
        grantedBy: "creator",
      },
    });
  });
  afterEach(async () => {
    await system.employee.deleteMany({ where: { id: employeeId } });
    await system.securityEvent.deleteMany({ where: { userId: { in: users } } });
    await system.user.deleteMany({ where: { id: { in: users } } });
  });
  afterAll(async () => {
    await close?.();
  });

  /** A person whose last read was `ageMs` ago and who holds the grant's group. */
  async function person(
    name: string,
    ageMs: number,
    extra: { truncated?: boolean; deprovisioned?: boolean; holds?: boolean } = {},
  ) {
    const id = `sync-${name}-${suffix}`;
    users.push(id);
    await system.user.create({
      data: {
        id,
        name,
        email: `${id}@example.test`,
        emailVerified: true,
        deprovisionedAt: extra.deprovisioned ? new Date() : null,
      },
    });
    const holds = extra.holds ?? true;
    await system.userDirectoryClaim.create({
      data: {
        userId: id,
        values: holds ? [`group-${suffix}`] : [],
        truncated: extra.truncated ?? false,
        refreshedAt: new Date(Date.now() - ageMs),
      },
    });
    if (holds && !extra.deprovisioned)
      await system.employeeEntitlement.create({
        data: { employeeId, userId: id, role: "viewer", source: "claim" },
      });
    return id;
  }
  const claim = (id: string) =>
    system.userDirectoryClaim.findUniqueOrThrow({ where: { userId: id } });
  const entitled = async (id: string) =>
    (await system.employeeEntitlement.count({ where: { userId: id } })) > 0;

  it("removes access when the directory no longer lists the group, and adds it when it does", async () => {
    const left = await person("left", 2 * HOUR);
    const joined = await person("joined", 2 * HOUR, { holds: false });
    answers.set(left, { status: "found", values: ["other"] });
    answers.set(joined, { status: "found", values: [`group-${suffix}`, "other"] });

    await sync();

    expect(await entitled(left)).toBe(false);
    expect((await claim(left)).values).toEqual(["other"]);
    expect(await entitled(joined)).toBe(true);
    expect((await claim(joined)).truncated).toBe(false);
  });

  it("leaves people who are not due, and deprovisioned accounts, alone", async () => {
    const fresh = await person("fresh", 5 * 60_000);
    const gone = await person("gone", 3 * HOUR, { deprovisioned: true });
    await sync();
    expect(asked).not.toContain(fresh);
    expect(asked).not.toContain(gone);
    expect((await claim(gone)).values).toEqual([`group-${suffix}`]);
  });

  it("marks claims stale on any failure and never widens access", async () => {
    const failing = await person("failing", 2 * HOUR);
    const noAnswer = await person("noanswer", 2 * HOUR, { holds: false });
    answers.set(failing, new Error("directory unavailable"));
    answers.set(noAnswer, new Error("throttled"));
    const deferred = vi.fn();

    const result = await runDirectorySync({
      prisma,
      source,
      intervalMs,
      onDeferred: deferred,
    });

    expect(result.stale).toBeGreaterThanOrEqual(2);
    for (const id of [failing, noAnswer]) {
      expect(await claim(id)).toMatchObject({ values: [], truncated: true });
      expect(await entitled(id)).toBe(false);
    }
    expect(deferred).toHaveBeenCalled();
  });

  it("treats a person the directory does not know as holding no groups", async () => {
    const id = await person("unknown", 2 * HOUR);
    answers.set(id, { status: "missing" });
    await sync();
    expect(await claim(id)).toMatchObject({ values: [], truncated: false });
    expect(await entitled(id)).toBe(false);
  });

  it("retries stale claims sooner than the full interval, and a good read restores them", async () => {
    const id = await person("stale", 20 * 60_000, { truncated: true, holds: false });
    answers.set(id, { status: "found", values: [`group-${suffix}`] });
    await sync();
    expect(asked).toContain(id);
    expect(await claim(id)).toMatchObject({ truncated: false });
    expect(await entitled(id)).toBe(true);

    const recent = await person("recent-stale", 2 * 60_000, { truncated: true, holds: false });
    answers.set(recent, { status: "found", values: [] });
    await sync();
    expect(asked.filter((asked) => asked === recent)).toHaveLength(0);
  });

  it("reads each person once when several instances run at the same time", async () => {
    const ids = await Promise.all(["a", "b", "c", "d"].map((n) => person(n, 2 * HOUR)));
    for (const id of ids) answers.set(id, { status: "found", values: [] });
    await Promise.all([sync(), sync(), sync()]);
    for (const id of ids) expect(asked.filter((who) => who === id)).toHaveLength(1);
  });
});
