import { describe, expect, it, vi } from "vitest";
import { isRunTainted } from "./run-context.js";

/** Attempts of the run by status, filtered the way the Prisma `where` asks. */
function runWith(statuses: string[], outsideMessage = false) {
  const count = vi.fn(
    async ({ where }: { where: { status?: { not: string } } }) =>
      statuses.filter((status) => status !== where.status?.not).length,
  );
  return {
    runId: "run-1",
    state: { tainted: false, earlierAttempt: undefined },
    deps: { prisma: { attempt: { count } } },
    trust: { receivedOutsideMessage: async () => outsideMessage },
  } as never;
}

describe("isRunTainted", () => {
  it("does not taint a first job the owner gave after the creation intro", async () => {
    // The intro attempt (answered) and the attempt carrying the owner's job.
    expect(await isRunTainted(runWith(["intro_answered", "running"]))).toBe(false);
  });

  it("taints a retried run, whose earlier attempt may have read outside content", async () => {
    expect(await isRunTainted(runWith(["interrupted", "running"]))).toBe(true);
    expect(await isRunTainted(runWith(["intro_answered", "interrupted", "running"]))).toBe(true);
  });

  it("taints a run that took in a channel or webhook message", async () => {
    expect(await isRunTainted(runWith(["running"], true))).toBe(true);
  });
});
