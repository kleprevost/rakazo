import type { ComputerInspection, SandboxProvider } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { createFleetObserver, observedHealth } from "./fleet-observer.js";

const row = (id: string) => ({
  id,
  homeKey: `home-${id}`,
  kind: "docker",
  providerRef: `ref-${id}`,
  spaceId: `space-${id}`,
  userId: "user",
});

function setup(options: {
  computers?: ReturnType<typeof row>[];
  sandbox?: Record<string, unknown>;
  fleet?: { inspect: boolean };
}) {
  const upsert = vi.fn(async () => ({}));
  const findMany = vi.fn(async () => options.computers ?? [row("a"), row("b")]);
  const prisma = {
    computer: { findMany },
    computerObservation: { upsert },
  } as unknown as PrismaClient;
  const sandbox = {
    describe: () => ({
      id: "docker",
      contractVersion: "1",
      adapterVersion: "0",
      capabilities: { fleet: options.fleet ?? { inspect: true } },
    }),
    inspect: vi.fn(
      async (): Promise<ComputerInspection> => ({
        runtime: "running",
        image: { ref: "img:1", digest: `sha256:${"b".repeat(64)}` },
        isolation: "container",
        usage: { cpuMillis: 5 },
        health: "ok",
      }),
    ),
    ...options.sandbox,
  } as unknown as SandboxProvider;
  return { prisma, sandbox, upsert, findMany };
}

describe("fleet observer", () => {
  it("stores one observation per running computer", async () => {
    const { prisma, sandbox, upsert } = setup({});
    await createFleetObserver({ prisma, sandbox })();
    expect(upsert).toHaveBeenCalledTimes(2);
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { computerId: "a" },
        create: expect.objectContaining({
          computerId: "a",
          runtime: "running",
          imageDigest: `sha256:${"b".repeat(64)}`,
          cpuMillis: 5,
          health: "ok",
        }),
      }),
    );
  });

  it("asks nothing of a provider without the inspect capability", async () => {
    const { prisma, sandbox, upsert, findMany } = setup({ fleet: { inspect: false } });
    await createFleetObserver({ prisma, sandbox })();
    expect(findMany).not.toHaveBeenCalled();
    expect(upsert).not.toHaveBeenCalled();
    expect(sandbox.inspect).not.toHaveBeenCalled();
  });

  it("uses one batched call when the provider offers it", async () => {
    const inspectMany = vi.fn(
      async () =>
        new Map<string, ComputerInspection | null>([
          ["ref-a", { runtime: "stopped", isolation: "container" }],
          ["ref-b", null],
        ]),
    );
    const { prisma, sandbox, upsert } = setup({ sandbox: { inspectMany } });
    await createFleetObserver({ prisma, sandbox })();
    expect(inspectMany).toHaveBeenCalledTimes(1);
    expect(sandbox.inspect).not.toHaveBeenCalled();
    // The computer the provider could not report on keeps its old row, so it goes stale.
    expect(upsert).toHaveBeenCalledTimes(1);
  });

  it("falls back to single reports and leaves a failing computer stale", async () => {
    const inspect = vi.fn(async (computer: { id: string }) => {
      if (computer.id === "ref-b") throw new Error("unreachable");
      return { runtime: "running", isolation: "container" } as ComputerInspection;
    });
    const { prisma, sandbox, upsert } = setup({
      sandbox: {
        inspect,
        inspectMany: async () => {
          throw new Error("batch down");
        },
      },
    });
    await createFleetObserver({ prisma, sandbox })();
    expect(upsert).toHaveBeenCalledTimes(1);
  });

  it("waits out its interval between passes", async () => {
    const { prisma, sandbox, findMany } = setup({});
    const observe = createFleetObserver({ prisma, sandbox }, { intervalMs: 60_000 });
    await observe();
    await observe();
    expect(findMany).toHaveBeenCalledTimes(1);
  });
});

describe("observed health", () => {
  const now = new Date("2026-03-01T00:10:00Z");
  const at = (secondsAgo: number) => new Date(now.getTime() - secondsAgo * 1000);

  it("reports what the provider said while the observation is fresh", () => {
    expect(observedHealth({ observedAt: at(30), health: "ok" }, now)).toBe("ok");
    expect(observedHealth({ observedAt: at(179), health: "degraded" }, now)).toBe("degraded");
    expect(observedHealth({ observedAt: at(30), health: "unreachable" }, now)).toBe("unreachable");
  });

  it("is unknown, never ok, after three missed intervals", () => {
    expect(observedHealth({ observedAt: at(181), health: "ok" }, now)).toBe("unknown");
    expect(observedHealth({ observedAt: at(30), health: "ok" }, now, 5_000)).toBe("unknown");
  });

  it("is unknown without an observation or a health report", () => {
    expect(observedHealth(null, now)).toBe("unknown");
    expect(observedHealth(undefined, now)).toBe("unknown");
    expect(observedHealth({ observedAt: at(1), health: null }, now)).toBe("unknown");
    expect(observedHealth({ observedAt: at(1), health: "garbage" }, now)).toBe("unknown");
  });
});
