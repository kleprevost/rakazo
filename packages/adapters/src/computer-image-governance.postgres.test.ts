import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AdapterContext, JobPublisher } from "@rakazo/adapter-kit";
import type { PrismaClient, ThreadEvents } from "@rakazo/db";
import { asSystem, createDb, runAsTenant } from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { provisionComputer } from "./computer-lifecycle.js";
import { FakeSandboxProvider } from "./fake-sandbox.js";
import { LocalAgentHomeStore } from "./home.js";
import { setActivePolicy } from "./policy-runtime.js";

const url = process.env.DATABASE_URL;
const describePostgres =
  process.env.VERIFY_DATABASE === "1" && url ? describe.sequential : describe.skip;

describePostgres("computer image governance (PostgreSQL)", () => {
  const stamp = randomUUID();
  const digest = `sha256:${"c".repeat(64)}`;
  const image = { ref: `registry.example/computer@${digest}`, digest };
  let db: ReturnType<typeof createDb>;
  let system: PrismaClient;
  let dataDir: string;

  beforeAll(async () => {
    db = createDb(url!);
    system = asSystem(db.prisma);
    dataDir = await mkdtemp(path.join(tmpdir(), "rakazo-image-governance-"));
    await system.user.create({
      data: {
        id: stamp,
        name: "Image Owner",
        email: `${stamp}@example.test`,
        emailVerified: false,
      },
    });
    await system.organization.create({
      data: { id: stamp, name: "Images", slug: stamp, createdAt: new Date() },
    });
    await system.space.create({ data: { id: stamp, organizationId: stamp, name: "Images" } });
    await system.computer.create({
      data: {
        id: stamp,
        spaceId: stamp,
        userId: stamp,
        scopeKey: stamp,
        homeKey: stamp,
        kind: "fake",
      },
    });
  });

  afterAll(async () => {
    setActivePolicy(undefined);
    if (db) {
      await system.organization.deleteMany({ where: { id: stamp } });
      await system.user.deleteMany({ where: { id: stamp } });
      await db.prisma.$disconnect();
      await db.pool.end();
    }
    if (dataDir) await rm(dataDir, { recursive: true, force: true });
  });

  it("starts from an approved image and records it, then clears it on a start without one", async () => {
    const sandbox = new FakeSandboxProvider();
    const deps = {
      prisma: db.prisma,
      sandbox,
      home: new LocalAgentHomeStore(dataDir),
      jobs: { enqueue: vi.fn().mockResolvedValue(undefined) } as unknown as JobPublisher,
      events: { append: vi.fn().mockResolvedValue({}) } as unknown as ThreadEvents,
      dataDir,
    };
    const tenant = { spaceId: stamp, userId: stamp };
    const context: AdapterContext = {
      operationId: "image-governance-test",
      traceId: "image-governance-test",
      ...tenant,
      signal: new AbortController().signal,
    };
    const start = (named?: typeof image) =>
      runAsTenant(tenant, () => provisionComputer(deps, stamp, context, "none", undefined, named));

    // Unlisted: refused, and nothing was provisioned.
    setActivePolicy({ version: 1, computers: { images: { allow: [] } } });
    await expect(start(image)).rejects.toMatchObject({ rule: "computers.images" });
    expect(sandbox.requestedImages).toEqual([]);
    expect(
      (await system.computer.findUniqueOrThrow({ where: { id: stamp } })).imageDigest,
    ).toBeNull();

    // Listed: the provider is asked for exactly that image and the row records it.
    setActivePolicy({ version: 1, computers: { images: { allow: [{ digest }] } } });
    await start(image);
    expect(sandbox.requestedImages).toEqual([image]);
    expect(await system.computer.findUniqueOrThrow({ where: { id: stamp } })).toMatchObject({
      state: "running",
      imageRef: image.ref,
      imageDigest: digest,
    });

    // Absent policy: a start that names no image is untouched by governance.
    setActivePolicy(undefined);
    await system.computer.update({ where: { id: stamp }, data: { state: "stopped" } });
    await start();
    expect(await system.computer.findUniqueOrThrow({ where: { id: stamp } })).toMatchObject({
      state: "running",
      imageRef: null,
      imageDigest: null,
    });
  });
});
