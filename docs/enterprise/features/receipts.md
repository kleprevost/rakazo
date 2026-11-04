# Automation receipts and exceptions

Wave 4, item 3. Goal: a routine that runs unattended leaves a visible outcome for every firing,
stays quiet when there is nothing to say, and never lets a broken check pass as a clean one.

## Outcomes

| Outcome | Meaning | Notifies | Today | Calendar |
| --- | --- | --- | --- | --- |
| `no_change` | Clean check, nothing to report | no | not listed | "No change" |
| `action_needed` | The bot found something and told the user | once, as the run's completion already does | the chat; runs list under Done | "Action needed" |
| `failed` | The check could not be completed (source, provider or tool error) | as a failed run already does | exception | "Failed" |
| `missed` | A scheduled firing that did not run | no | exception | "Missed" |

## Where each outcome comes from

Only structured signals decide; no text is read.

- Change check (`tickRoutineWatch`, no model): a baseline or unchanged result is `no_change`. A
  `RoutineWatchError` (command exit, tool error, missing path, no integration) is `failed` with its
  reason, and the routine is paused as it was before. `RoutineWatchRetry` (computer busy) is a
  passing delay and records nothing. A changed result starts a run, and the run decides.
- Run (`completeRun` / `failRun`): a failed run is `failed`. A completed run is `action_needed` when
  the model said anything (final text or a progress message) and `no_change` when it chose silence
  (the exact `NO_RESPONSE` reply, the existing explicit quiet decision). A silent run during which
  an `agent.tool.completed` event has `outcome: "error"` is `failed`: it did not check cleanly.
- Missed: the scheduler skipped an occurrence. Two cases: a suspended or quarantined bot at wake
  time (`wakeRoutine`), and occurrences that came due between a late firing and the next one armed
  (the worker was away), at most 10 per wake.

## Storage

One additive table, `routine_receipts` (migration `20261204120000`), with row-level security like
other Space tables. Run and event rows only exist for firings that started a run, so quiet checks and
misses need their own record.

```
RoutineReceipt { id, spaceId, userId, botId, routineId, runId? (unique),
                 scheduledFor, outcome, detail?, createdAt }   unique (routineId, scheduledFor)
```

- `scheduledFor` is when the firing was due: the timer nonce, else the `routine.fired` event's
  `scheduledFor` (change checks), else the run's start (manual runs). The unique key makes a
  repeated wake or completion record once.
- `detail` is a clipped one-liner: the watch error, run error or tool error (already sanitized).
- Writes are best effort and never change the run or schedule they describe.
- `no_change` rows older than 35 days are pruned as new ones arrive; other outcomes are kept.

## Read models (no new procedures)

- `today.summary`: new attention kind `routine_exception` (`failed` | `missed`, routine, detail).
  It lists receipts without a failed run (a failed run is already a `failed_routine`), newest per
  routine, for the 3-day failure window, and clears when a later firing of the same routine was
  `no_change` or `action_needed`. Completed routine runs whose receipt is `no_change` leave Done.
- `calendar.range`: `past` entries for firings gain the outcomes above (a run with a receipt shows
  the receipt; a run without one keeps its status), and `runId` is null for a firing that started no
  run. Quiet checks and misses of event-triggered routines place that routine on the grid.

## Copy

"No change", "Action needed" (Calendar), "Missed" (Calendar, and Today after the routine name).
"Failed" already existed. Today shows the check's reason for a failure and adds no other text.

## Mobile

Degrades safely. Neither Today nor the Calendar has a native screen yet, and no mobile code reads
these contracts, so nothing breaks. The receipts arrive with the same `today.summary` and
`calendar.range` when those screens are built.

## Not in this PR

A failed change check still pauses the routine, as before; resuming after a transient outage is a
product decision. Occurrences skipped while the platform was fully down are only recorded when the
routine next fires. No receipts for webhook, git or message triggers (they have no schedule).
