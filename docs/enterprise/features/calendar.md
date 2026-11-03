# Automation calendar

Track F, wave 2 of the AI Employee Experience work. Goal: scheduled work feels continuous and
visible. A user sees, by day or week, when their routines will run and how recent runs went, and can
act on a routine from there.

## User story

As someone whose bots run routines on schedules, I open Calendar and see:

- what will run today or this week (projected from each routine's schedule and timezone),
- what already ran, with the outcome (done, failed, skipped, running) linking to the chat reply,
- routines that no clock starts (webhook, git event, message, change watch) in a side list.

From any item I can pause or resume the routine, run it now, or open its editor.

## Data sources (read-only, no new tables, no migration)

| Need | Source |
| --- | --- |
| Routines, schedule, timezone, next run | `Routine` (`packages/db/prisma/schema.prisma:1180`): `crons`, `timezone`, `active`, `watch`, `nextRunAt` |
| Same scope as the routine list | `listRoutinesDto` (`apps/api/src/routines.ts:128`); history scope in `listRoutineRuns` (`apps/api/src/routine-runs.ts:9`): space, own user, bot not archived |
| How the scheduler picks the next run | `nextRoutineRunDateAcross` (`packages/core/src/cron.ts:436`), called after each fire in `packages/adapters/src/run-routines.ts:174` |
| One-shot (`@once`) | `isOneShotRoutineCrons` (`cron.ts:22`); the armed time is `nextRunAt` |
| Past runs | `Run` (`schema.prisma:959`) by `routineId`; status set in `packages/contracts/src/ids.ts:25` |
| Chat reply a run opens | first bot `Message` of the run, as in `routine-runs.ts:60` |
| Existing actions | `routines.update` (`active`), `routines.testRun` (`packages/contracts/src/rpc.ts:800`) |
| Editor deep link | `/app/<botId>?routine=<id>` (also used by search, `use-sidebar-search.ts:80`) |
| Page pattern | `apps/web/src/pages/Today.tsx` |

## Projection

No cron parsing here. `projectOccurrences` (`apps/api/src/calendar.ts`) mirrors the scheduler:
the stored `nextRunAt` is the first occurrence and each later one is
`nextRoutineRunDateAcross(crons, previous, previous, timezone)`, which is exactly how a finished run
arms the next, including uneven interval phase, several crons and daylight saving. Rules:

- Only active routines with a clock schedule are projected; a paused routine has no future.
- Nothing before now is projected (past days show real runs). A run that is already due is placed at
  its next slot.
- `@once` shows its armed time. A change watch (`watch`) is not a clock, so it goes to the side list.
- Projection assumes runs fire on time; a delayed or backed-off routine shifts when it actually runs.

## Contract: `calendar.range`

`packages/contracts/src/calendar.ts`, wired in `rpc.ts`; handler `apps/api/src/calendar.ts`. Input
`{ from, to }` (ISO). Refused unless `0 < to - from <= 31 days`.

```
CalendarRange {
  from, to,
  routines:    { routineId, name, botId, botName, groupId, active, timezone }[]  // on the grid
  unscheduled: same shape                                                        // side list
  upcoming:    { routineId, at }[]                                               // projected
  past:        { routineId, runId, at, outcome, messageId }[]                    // oldest first
  truncated
}
outcome: success | failed | skipped | running
```

- `success` is a completed run, `failed` a failed one, `running` any active status, `skipped` a
  cancelled run (the run model has no separate skipped state).
- `routines` holds scheduled routines plus any with a run in the range (so a routine that was
  edited to webhook-only still labels its old runs); `unscheduled` holds the rest.
- Scope: the signed-in user's routines in the current space on bots that are not archived, and runs
  read with the same space and user filter. Nothing else is readable.
- Caps: 300 occurrences per routine, 1500 total, 500 past runs (newest kept). Hitting any sets
  `truncated`. The page does not show copy for it yet.

## UI

`apps/web/src/pages/Calendar.tsx`, route `/app/calendar`, one entry in the account menu next to
Today. Header: Day/Week toggle, Today, previous/next. Week is seven day sections (Monday first,
local time) and Day is one; rows are time, outcome for past runs, bot and routine name. The
Event-triggered section lists routines without a time.

- Loading: the shared page spinner. Empty: "Nothing scheduled" (no routines). Error: error text and
  Try again; polling stops after a refused read.
- Populated: a row links to the chat reply (past, with a reply) or the chat; the actions menu has
  Pause/Resume, Run now and Edit; a failed action shows inline and refetches on success.
- Refreshes every minute and on window focus.

New copy: Day, Week, Previous, Next, Actions (accessible name), Pause, Resume, Run now, Nothing
scheduled, Event-triggered. Calendar, Today, Edit, Done, Failed, Skipped, Running, Back and Try again
already existed.

## Mobile

Deferred. The contract is shared; a native screen (native list, context menus for the actions)
should reuse `calendar.range` as is. It is a separate PR because AGENTS.md asks for native-first UI
rather than a port of the web grid.

## Tests

- `apps/api/src/calendar.test.ts`: continuation from `nextRunAt`, spring-forward and fall-back
  wall-clock times, no past projection, `@once`, event-triggered and watch skipped, per-routine cap,
  range limits, actor scoping on every read, merge of past outcomes and side list, past-run cap.
- `apps/web/src/pages/Calendar.test.tsx`: loading, empty, error and retry, populated placement and
  links, week and day navigation ranges.

## Later

Hour-by-hour day grid; "N more" and a visible truncation hint; month view; per-bot filter;
group-owned routines for users who are not the owner; space-wide live updates; drag to reschedule.
