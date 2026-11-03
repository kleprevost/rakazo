# Work items

An assignment to an AI employee is a trackable unit of work, not a stretch of chat. A work item is
a ticket on the existing board: it has an owner (the human who created it), an assignee (the bot),
a status, the runs that worked on it, and the files those runs produced. Rakazo's "one visible
conversation per bot" stays: a ticket never opens a second thread. The bot works in its own
thread without posting a message, and keeps progress in ticket comments.

## What exists upstream
- `Ticket`/`TicketComment`/`Board` (`packages/db/src/board.ts`, `packages/contracts/src/board.ts`),
  one board per space, tickets numbered `RAK-n`. Statuses: `todo`, `doing`, `review`, `blocked`,
  `done`, `closed`.
- `TICKET_BOARD_ENABLED` (API + worker, default off) gates the `boards.*`/`tickets.*` routes, the bot
  ticket tools, the ticket wake and the web route `/app/board`. Mobile only receives the flag.
- Creating a ticket or reassigning it calls `wakeTicketAssignee`, which queues a run
  (`trigger: "tickets"`) in the assignee's thread. The bot reads the ticket with `ticket_get`, writes
  comments and sets status with `ticket_update`. `boards.subscribe` pushes "board changed" signals.
- Before this change nothing linked a ticket to its runs, so run history, files and approvals were
  only reachable by reading the chat.

## Lifecycle
Existing statuses are kept as the stored value (people and the bot set them; the board columns use
them). A derived `phase` combines the status with the newest linked run, so no new status is needed:

| Phase | Derived from |
|---|---|
| Ready | `todo`, no run yet |
| Running | latest run queued/leased/running, or status `doing` |
| Waiting | latest run `waiting_input`/`waiting_takeover` (ask or approval card), or status `blocked` |
| Review | status `review`, or latest run completed while the ticket was still open |
| Done | `done` |
| Failed | latest run failed |
| Cancelled | `closed` ("Won't do") |

Why no new statuses: a stored phase would duplicate run state and drift on the many paths that
change runs (cancel, expiry, takeover). Reading the run avoids touching those hot paths.
Backlog is not modelled: a ticket is always created with an assignee, so every open ticket is ready.

Automatic status writes (only when the status is still `todo`/`doing`, so a person's or bot's choice
wins): waking the assignee moves `todo` to `doing`; a finished run moves the ticket to `review`; a
failed run moves it to `blocked`. Each write publishes a board signal.

## Linkage
- ticket to runs: `Task.ticketId` (nullable, set by the wake). A ticket's runs are the runs of its
  tasks. Runs that the bot starts for other reasons are not linked.
- runs to artifacts: `Artifact.runId` already exists; a ticket's files are the artifacts of its runs.
- runs to approvals: an approval is an ask on a run, so a waiting run is the pending approval. Per
  approval detail (`ExternalEffect` rows) is not listed per ticket yet.
- No new table. One additive migration: `tasks.ticketId` with an index and `ON DELETE SET NULL`.

## Read functions (for the Today dashboard)
`packages/db/src/work-items.ts`:
- `listWorkItems(prisma, spaceId, { assigneeBotId?, createdByUserId?, phases? })` returns tickets
  with `phase`, newest activity first.
- `getTicketWork(prisma, spaceId, ticket)` returns the phase, runs and artifacts of one ticket.
- `workPhase(status, latestRunStatus)` in `@rakazo/contracts` is the pure mapping.
Call these under the caller's tenant context. `tickets.work` is the API route for one ticket.

## In this PR
Migration and wake link; status follows the run; `tickets.work`; ticket dialog shows its phase, runs
and file links; `TICKET_BOARD_ENABLED=true` in `infra/azure/aca` (API and VM worker). Upstream's
default in code stays off.

## Later
- Deadline (`dueAt`) and progress (a checklist or percent the bot reports), plus the human owner as a
  filterable field on the board.
- Phase on board cards and a "mine" filter; a Backlog state for unassigned tickets.
- Per-approval listing and approve/deny from the ticket.
- Linking runs the bot starts on its own (routine, chat) to a ticket by reference.
- Status writes on waiting transitions (today derived on read).

## Mobile plan
Mobile has no board screen. Add a native list of work items (Today and the bot screen first) backed
by `listWorkItems`, with a native detail sheet for runs and files. The contracts are shared, so
mobile needs only a screen and its catalog strings.
