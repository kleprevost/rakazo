/** The metadata `GET /computers/:id/inspect` returns. Never paths, env, mounts or tokens. */
export interface SupervisorInspection {
  id: string;
  running: boolean;
  image: string;
  imageDigest?: string;
  startedAt?: string;
  restartCount: number;
  health?: "ok" | "degraded";
  usage?: { cpuMillis?: number; memoryBytes?: number; memoryLimitBytes?: number; pids?: number };
  egress: { mode: "open" | "restricted"; enforced: boolean };
}

type InspectedContainer = {
  State: { Running?: boolean; StartedAt?: string; Health?: { Status?: string } };
  RestartCount?: number;
  Config: { Image: string };
};

type ContainerStats = {
  cpu_stats?: {
    cpu_usage?: { total_usage?: number };
    system_cpu_usage?: number;
    online_cpus?: number;
  };
  precpu_stats?: { cpu_usage?: { total_usage?: number }; system_cpu_usage?: number };
  memory_stats?: { usage?: number; limit?: number; stats?: Record<string, number> };
  pids_stats?: { current?: number };
};

const finite = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0;

/** Docker reports a digest only for an image that came from a registry; a local build has none. */
export function imageDigestFrom(repoDigests: readonly string[] | undefined): string | undefined {
  const digest = repoDigests?.map((entry) => entry.split("@")[1]).find((value) => value);
  return digest && /^sha256:[0-9a-f]{64}$/.test(digest) ? digest : undefined;
}

/** CPU in millicores over the sample window and memory without page cache, as `docker stats` shows. */
export function usageFromStats(stats: ContainerStats | undefined) {
  if (!stats) return undefined;
  const usage: NonNullable<SupervisorInspection["usage"]> = {};
  const cpuDelta =
    (stats.cpu_stats?.cpu_usage?.total_usage ?? Number.NaN) -
    (stats.precpu_stats?.cpu_usage?.total_usage ?? Number.NaN);
  const systemDelta =
    (stats.cpu_stats?.system_cpu_usage ?? Number.NaN) -
    (stats.precpu_stats?.system_cpu_usage ?? Number.NaN);
  if (finite(cpuDelta) && systemDelta > 0)
    usage.cpuMillis = Math.round(
      (cpuDelta / systemDelta) * (stats.cpu_stats?.online_cpus ?? 1) * 1000,
    );
  const memory = stats.memory_stats;
  if (finite(memory?.usage)) {
    const cache = memory.stats?.inactive_file ?? memory.stats?.cache ?? 0;
    usage.memoryBytes = Math.max(0, memory.usage - (finite(cache) ? cache : 0));
  }
  if (finite(memory?.limit)) usage.memoryLimitBytes = memory.limit;
  if (finite(stats.pids_stats?.current)) usage.pids = stats.pids_stats.current;
  return Object.keys(usage).length > 0 ? usage : undefined;
}

export function shapeInspection(
  id: string,
  info: InspectedContainer,
  extra: {
    imageDigest?: string | undefined;
    stats?: ContainerStats | undefined;
    egressRestricted: boolean;
  },
): SupervisorInspection {
  const running = Boolean(info.State.Running);
  const usage = running ? usageFromStats(extra.stats) : undefined;
  return {
    id,
    running,
    image: info.Config.Image,
    ...(extra.imageDigest ? { imageDigest: extra.imageDigest } : {}),
    ...(running && info.State.StartedAt && !info.State.StartedAt.startsWith("0001")
      ? { startedAt: info.State.StartedAt }
      : {}),
    restartCount: info.RestartCount ?? 0,
    ...(running
      ? {
          health:
            info.State.Health?.Status === "unhealthy" ? ("degraded" as const) : ("ok" as const),
        }
      : {}),
    ...(usage ? { usage } : {}),
    egress: extra.egressRestricted
      ? { mode: "restricted", enforced: true }
      : { mode: "open", enforced: false },
  };
}
