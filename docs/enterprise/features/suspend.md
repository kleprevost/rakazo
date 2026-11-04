# Suspend and resume an AI employee

An admin can stop an AI employee outright: it takes no new work, its running work is cancelled,
and everything comes back on resume. Not linked from the public docs site.

## Who can do it
Deployment admins only (`requireAdmin`, the same gate as the rest of the Admin section). The owner
is deliberately excluded. Owners already have Stop and Archive for their own bots, so a second
owner control adds nothing; and an owner who could resume would undo the admin's decision, which
makes suspend useless as a security control. If owner self-pause is wanted later it should be a
separate flag, not this one.

## Data
Migration `20261123120000_bot_suspended`: `bots.suspendedAt` and `bots.suspendedByUserId`, both
nullable with no default. The previous release ignores them, so it keeps working through the
rollout. `suspendedByUserId` is a plain id, not a foreign key, so deleting the admin changes
nothing. Postgres test: `apps/api/src/bot-suspension.postgres.test.ts` (also checks the columns).

## Procedures (`admin.bots.*`, `apps/api/src/bot-suspension.ts`)
- `suspend({ botId, reason? })`: marks the bot, cancels all its active runs, returns the count.
  Idempotent; a second call keeps the first time. `reason` is up to 200 characters.
- `resume({ botId })`: clears both columns. Idempotent.
- `admin.bots.list` gained `suspendedAt`. `Bot.suspendedAt` (optional) tells the main app.
- Both record a security event, `bot.suspended` / `bot.resumed`: actor is the admin, the bot's
  space, metadata `botId`, `ownerId`, and for suspend `cancelledRuns` and `reason`. Both also land
  in the organization audit log through the usual security-event path.

## Where it is enforced
Every run, from any source, is a `Run` row the worker executes through one function, so the gate
sits where central policy's run gates sit, in `continueRun` of `packages/adapters/src/executor.ts`,
right before the policy and budget checks and before any model call or computer start:

| Source | What happens while suspended |
| --- | --- |
| User message or follow-up | Refused at send with `FORBIDDEN` "Suspended by your organization" (a stop message still goes through); anything already queued fails at the gate |
| Routine and schedule | `wakeRoutine` skips the due occurrence, moves `nextRunAt` to the next future one and queues the next wake. Nothing fires, no failure notice. Retries fail at the gate |
| Webhook, messaging channel | Run is created, fails at the gate with the same message |
| Peer and fleet delegation (`bot_message`) | Fails at the gate; the sender gets the normal "could not complete the delegated request" with the message |
| Ticket wake | Skipped before the run exists, so the ticket status is not moved |
| Subagent spawn | A spawn run belongs to the child bot; a suspended parent cannot run to start one, and a suspended child fails at the gate |
| Resume of a waiting run | Same gate, so a run waiting for input cannot continue |

The gate fails the run with a terminal error and does not back the routine off (it is not an
account failure). The message is localized in the web app like the policy message.

## Runs in progress
`suspend` cancels the bot's `queued`, `leased`, `running` and waiting runs in one transaction with
the same primitive Stop uses (`cancelRunsInTransaction`), clears pending steering, writes a
`run.cancelled` event per run and cancels their jobs. After commit it runs Stop's teardown
(`finishThreadStop`): cancels run work on the computer, releases the screen, ends the execution
leases. A worker mid-turn loses its lease and aborts.

## Computer
Only the run work and screen lease are released. The computer is not stopped: it follows its
normal idle lifecycle, and nothing can start work on it for this bot. Stopping it immediately
(as Archive does) was left out to avoid a second teardown path; add it if cost matters.

## Resume
Routines keep their schedule while suspended, so resume needs no repair and cannot burst. A
one-shot routine that fell due while suspended is dropped (the existing behavior for any missed
one-shot). Cancelled runs are not restored; the user sends the message again.

## UI
- Admin, AI employees (`/admin/bots`): a "Suspended" badge and a Suspend / Resume button per row;
  suspend asks for a confirming second click.
- Main app: the chat header shows "Suspended" under the bot's name.
- Mobile: deferred. It has no admin surface, and its sends already fail with the server message;
  no cheap status indicator exists for a new state.

## Quarantine
A stronger stop for incidents lives in [capability-broker.md](./capability-broker.md): it composes
with suspend (same cancellation primitive, same gates) but is its own state and also removes the
bot's own credentials.

## Not covered
- Child bots (`spawn_bot`) are separate AI employees; suspend each one, they are all in the list.
- Group chats: a message to a group containing a suspended bot creates its run, which fails at
  the gate; the send itself is not refused.
- A reason field in the UI; the procedure accepts one.
