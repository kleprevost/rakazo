import { describe, expect, it } from "vitest";
import { imageDigestFrom, shapeInspection, usageFromStats } from "./computer-inspection.js";

const digest = `sha256:${"a".repeat(64)}`;

describe("computer inspection", () => {
  it("reads a registry digest and ignores a local build", () => {
    expect(imageDigestFrom([`registry.example/rakazo/computer@${digest}`])).toBe(digest);
    expect(imageDigestFrom([])).toBeUndefined();
    expect(imageDigestFrom(undefined)).toBeUndefined();
    expect(imageDigestFrom(["registry.example/rakazo/computer@latest"])).toBeUndefined();
  });

  it("computes CPU millicores and cache-free memory", () => {
    expect(
      usageFromStats({
        cpu_stats: { cpu_usage: { total_usage: 600 }, system_cpu_usage: 2000, online_cpus: 2 },
        precpu_stats: { cpu_usage: { total_usage: 400 }, system_cpu_usage: 1000 },
        memory_stats: { usage: 1000, limit: 4000, stats: { inactive_file: 200 } },
        pids_stats: { current: 7 },
      }),
    ).toEqual({ cpuMillis: 400, memoryBytes: 800, memoryLimitBytes: 4000, pids: 7 });
  });

  it("omits what the sample cannot give", () => {
    expect(usageFromStats(undefined)).toBeUndefined();
    expect(usageFromStats({ cpu_stats: { cpu_usage: { total_usage: 5 } } })).toBeUndefined();
  });

  it("shapes only metadata and drops usage and health for a stopped container", () => {
    const running = shapeInspection(
      "c1",
      {
        State: {
          Running: true,
          StartedAt: "2026-01-01T00:00:00Z",
          Health: { Status: "unhealthy" },
        },
        RestartCount: 2,
        Config: { Image: "registry.example/rakazo/computer:1", Env: ["SECRET=1"] } as never,
      },
      { imageDigest: digest, egressRestricted: true, stats: { pids_stats: { current: 3 } } },
    );
    expect(running).toEqual({
      id: "c1",
      running: true,
      image: "registry.example/rakazo/computer:1",
      imageDigest: digest,
      startedAt: "2026-01-01T00:00:00Z",
      restartCount: 2,
      health: "degraded",
      usage: { pids: 3 },
      egress: { mode: "restricted", enforced: true },
    });
    expect(
      shapeInspection(
        "c1",
        { State: { Running: false, StartedAt: "0001-01-01T00:00:00Z" }, Config: { Image: "x" } },
        { egressRestricted: false, stats: { pids_stats: { current: 3 } } },
      ),
    ).toEqual({
      id: "c1",
      running: false,
      image: "x",
      restartCount: 0,
      egress: { mode: "open", enforced: false },
    });
  });
});
