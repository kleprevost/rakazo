# Today (Mission Control) and Needs Attention

Track A of the AI Employee Experience wave. Goal: Rakazo reads as a place to supervise a workforce,
so the first thing a user sees is work and outcomes, not a list of chats.

## User story

As someone who manages several bots, I open Today and see, in one place and without refreshing:

- what needs me (approvals, bot questions, failed runs and routines) and can act on it directly,
- what my bots are working on right now,
- what they finished recently, with the files they produced,
- which routines run next.

Every row links to its source: the bot or group chat, or the artifact.

## Data sources (read-only, no new tables, no migration)

| Need | Source |
| --- | --- |
| Running and waiting runs | `Run` (`packages/db/prisma/schema.prisma:959`), `ACTIVE_RUN_STATUSES` (`packages/core/src/run-state.ts:14`) |
| Same predicate as the sidebar activity list | `listSpaceRuns` (`apps/api/src/runs.ts:58`), `activityPreview` (`apps/api/src/runs.ts:21`) |
| Approvals and questions | Pending `ask` block on a message of a `waiting_input` run (`packages/contracts/src/events.ts:115`, `packages/core/src/answerable-ask.ts:13`); an approval has `approvalEffectId` |
| Answering an ask | `threads.answer` (`apps/api/src/routes/threads.ts:637`), unchanged |
| Failed runs and routines | `Run` with `status = failed`; `runFailureError` text as in routine history (`apps/api/src/routine-runs.ts:8`) |
| Retrying a routine | `routines.testRun` (`apps/api/src/routes/routines.ts:333`), unchanged |
| Upcoming routine runs | `Routine` (`schema.prisma:1180`): `active`, `nextRunAt` |
| Deliverables | `Artifact` (`schema.prisma:1550`) joined by `runId` |
| Polling pattern | `ActivityList` (`apps/web/src/pages/ActivityList.tsx:76`) |

Excluded: archived bots and background ticket runs (`BACKGROUND_RUN_TRIGGERS`), exactly like the
activity list.

## Contract: `today.summary`

`packages/contracts/src/today.ts`, wired in `rpc.ts`; handler `apps/api/src/today.ts`. No input;
the signed-in actor (user + space) is the only scope, and every read filters on both.

```
TodaySummary {
  generatedAt,
  counts: { working, waiting, attention, completed },
  attention: (approval | question | failed_run | failed_routine)[],
  active:    TodayRun[],      // running, queued, waiting on the user
  completed: TodayRun[],      // last 24h, with artifacts (max 3 each)
  upcoming:  { routineId, name, botId, botName, groupId, nextRunAt }[]
}
```

Rules:

- An `approval` carries the card's own `allow` and `deny` actions and the `messageId`; the page
  answers through `threads.answer`, so authorization stays where it is. "Always allow" and secret
  requests are never offered here, so those degrade to a `question` that opens the chat.
- A failed run or routine stays listed for 3 days until something newer has run in the same routine
  or chat; one entry per routine or chat. `failed_routine` offers Retry via `routines.testRun` with
  a nonce derived from the failed run, so a double click starts one run.
- Completed lists runs that started without a person typing (routine, webhook, spawn, bot message,
  cloud agent) or that produced an artifact. Plain chat replies are not "work done".
- Lists are bounded (50 active, 10 completed, 20 failures, 10 upcoming).

## UI

`apps/web/src/pages/Today.tsx`, route `/app/today`, entry in the account menu (one item). Only
non-empty sections render: Needs attention, Working, Done, Coming up; counts sit in the headings.

- Loading: the shared page spinner.
- Empty: one line, "Nothing today".
- Error: the error text and Try again (polling stops after a refused read, like the activity list).
- Populated: rows link to the chat or artifact; approvals show Allow/Deny, failed routines Retry;
  an action failure shows inline on its row.

Live updates: the summary polls every 10 seconds while the page is open and on window focus; an
answered approval or retry invalidates it at once. The app has per-thread event streams only, so a
space-wide stream is the follow-up if polling proves too coarse.

## In this PR / later

In: contract, read model, route, web page, nav entry, API unit tests (scoping, aggregation,
supersession), web tests (loading, empty, error, populated, actions).

Later: make Today the landing page (it changes first-run and deep-link behavior, so it is a
separate decision); space-wide event stream; dismiss/snooze for failures; per-bot filter; links
from a row to the exact message; unanswered group asks for users who are not the run owner.

Navigation is a nav entry only: landing-page behavior depends on the Shell route defaults and
onboarding, which other tracks are touching.

## Mobile

Deferred. The contract is shared, so a native screen is cheap on the data side, but AGENTS.md
requires native-first SwiftUI/Expo UI (header items, context menus, native lists) rather than a
port of the web layout, and the answer/retry actions need the mobile thread cache to stay
consistent. That is a separate PR that reuses `today.summary` as is.

## Tests

- `apps/api/src/today.test.ts`: empty summary, actor scoping on every read, working/waiting split,
  approval vs secret vs plain question vs answered ask, cross-thread message ignored, failure
  dedupe and supersession, completed filter and artifacts, upcoming routines.
- `apps/web/src/pages/Today.test.tsx`: loading, empty, error and retry, populated links, approval
  answer, routine retry with failure.
