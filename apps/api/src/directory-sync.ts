import type { DirectoryClaimsSource } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import {
  claimDueDirectoryClaims,
  markDirectoryClaimsStale,
  recordDirectoryClaims,
} from "@rakazo/db";

const BATCH_SIZE = 25;
const MAX_BATCHES_PER_RUN = 8;
const LEASE_MS = 5 * 60_000;
const RETRY_MS = 10 * 60_000;
/** Reads in flight at once: enough to keep up, few enough not to trip the directory's throttle. */
const CONCURRENCY = 5;

export interface DirectorySyncDeps {
  prisma: PrismaClient;
  source: DirectoryClaimsSource;
  intervalMs: number;
  now?: () => Date;
  signal?: AbortSignal;
  /** Called with the error name when one person could not be read and was marked stale. */
  onDeferred?: (errorName: string) => void;
}

/**
 * Refreshes stored directory claims for people who are due, without waiting for them to sign
 * in. Each person is claimed in Postgres first, so every API instance may run this. A read that
 * fails for any reason replaces the stored claims with "none, truncated" (claim grants confer
 * nothing); nothing on a failure path can add a value.
 */
export async function runDirectorySync(
  deps: DirectorySyncDeps,
): Promise<{ checked: number; stale: number }> {
  const now = deps.now ?? (() => new Date());
  let checked = 0;
  let stale = 0;
  const one = async (subject: { userId: string; email: string }) => {
    try {
      const result = await deps.source.claimsFor(subject, deps.signal);
      await recordDirectoryClaims(
        deps.prisma,
        subject.userId,
        result.status === "found"
          ? { values: result.values, truncated: result.truncated === true }
          : { values: [] },
        { via: "directory_sync", now: now() },
      );
    } catch (error) {
      stale++;
      deps.onDeferred?.(error instanceof Error ? error.name : "unknown");
      await markDirectoryClaimsStale(deps.prisma, subject.userId, {
        via: "directory_sync_failed",
        now: now(),
      }).catch((inner) => deps.onDeferred?.(inner instanceof Error ? inner.name : "unknown"));
    }
  };
  for (let batch = 0; batch < MAX_BATCHES_PER_RUN && !deps.signal?.aborted; batch++) {
    const due = await claimDueDirectoryClaims(deps.prisma, {
      now: now(),
      intervalMs: deps.intervalMs,
      retryMs: RETRY_MS,
      leaseMs: LEASE_MS,
      limit: BATCH_SIZE,
    });
    for (let start = 0; start < due.length; start += CONCURRENCY) {
      await Promise.all(due.slice(start, start + CONCURRENCY).map(one));
      checked += Math.min(CONCURRENCY, due.length - start);
    }
    if (due.length < BATCH_SIZE) break;
  }
  return { checked, stale };
}
