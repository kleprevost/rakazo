import { useLingui } from "@lingui/react/macro";
import type { WorkPhase } from "@rakazo/contracts";
import { useMemo } from "react";

export function useWorkPhaseLabels(): Record<WorkPhase, string> {
  const { t } = useLingui();
  return useMemo(
    () => ({
      ready: t`To do`,
      running: t`Running`,
      waiting: t`Waiting`,
      review: t`In review`,
      done: t`Done`,
      failed: t`Failed`,
      cancelled: t`Cancelled`,
    }),
    [t],
  );
}

/** A single run reads as the phase its status stands for. */
export function runPhase(status: string): WorkPhase {
  if (status === "completed") return "done";
  if (status === "failed") return "failed";
  if (status === "cancelled") return "cancelled";
  if (status.startsWith("waiting")) return "waiting";
  return "running";
}
