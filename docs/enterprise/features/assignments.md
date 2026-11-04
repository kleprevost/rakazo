# Independent assignments per employee

Roadmap Wave 4, item 2. Status: design; PR 1 (table, read model, audit), PR 2 (create, thread targeting, ticket wake) PR 3 (web and desktop surface) and PR 4 (steer) built. Today an employee has one chat; two jobs
given to it share that thread, its history and its single stream of approvals. This makes each job
its own addressable unit while the employee, its memory and its tools stay one.

## Goal
An assignment is one job given to one employee. It has its own conversation, status, run history,
approvals and files. A person can create, search, resume, steer (queue an instruction for that
assignment only), cancel and archive it. Two assignments on one employee never share a
conversation, and Today and Board open the same assignment page. Branch and rewind are out of scope.

## What exists (verified in the schema and code)
- `Thread.botId` is `@unique`: a bot has exactly one primary thread. Messages, events (`seq` per
  thread), runs, tasks and steering messages all hang off a thread.
- `wakeTicketAssignee` (`packages/adapters/src/ticket-wake.ts`) creates a `Task` and a `Run` in the
  bot's primary thread. A ticket's "conversation" is therefore the shared chat, and its linked work
  is found through `Task.ticketId` (`docs/enterprise/features/work-items.md`).
- Run isolation is already by thread. A new message only steers or waits behind runs with the same
  `threadId` and `botId` (`sendUserMessage`, `createPendingSteeringRun` in `packages/db/src/events.ts`),
  and a pending steering message belongs to a message in one thread. A second thread for the same
  bot therefore runs concurrently with no change to the run engine.
- `Artifact.runId`, ask and approval cards as messages of a `waiting_input` run, and the
  `workPhase` mapping give files, approvals and status per run. Today builds on the same data.
- `Message.searchTokens` is a blind index over encrypted blocks, so content search needs no plaintext.
- `threadTarget` (`packages/contracts/src/rpc.ts`) addresses a thread by `botId` or `groupId`.
- Execution limits sit on the computer, not the thread: per-bot fenced `ComputerExecutionLease`,
  and a dedicated computer serializes its runs (`computer-idle.ts`).

## Design
### Data (additive only)
- New table `assignments`: `id`, `spaceId`, `botId`, `userId` (creator), `employeeId` (copied from the bot, nullable), `threadId` (unique, FK to
  `threads`), `ticketId` (nullable, unique), `title`, `clientNonce`, `cancelledAt`, `archivedAt`,
  `createdAt`, `updatedAt`. Unique `(spaceId, clientNonce)` makes create idempotent.
  Indexes: `(spaceId, botId, archivedAt, updatedAt)`, `(spaceId, userId, updatedAt)` and `(employeeId)`.
- Each assignment owns a new `Thread` with `botId` null, so every "bot's primary thread" lookup keeps
  returning the primary chat and never an assignment. `Run`, `Message`, `Event`, `Task` and
  `SteeringMessage` are unchanged and already carry `botId`.
- No stored status. The phase is derived on read from `cancelledAt`, `archivedAt`, the linked ticket
  status and the newest run in the thread, using the existing `workPhase`. A stored phase would
  drift across the many paths that change runs.
- Approvals and files are not copied: they are the cards and artifacts of the thread's runs.
- A ticket maps to at most one assignment. Tickets without one keep working as today.

### Security and RLS
- `assignments` ships with `*_tenant` (`spaceId`) and `*_system` policies in the same migration, as
  `threads` does. Row policy is the tenant boundary; the router applies the person boundary.
- Visibility: the creator, plus those who may already open the employee's chat (owner and
  managers of a shared employee, per `shared-employees.md`). A viewer cannot steer or cancel.
  Every new protected call is added to `exhaustiveProtectedCalls` in the testkit.
- Search runs under the caller's tenant context and filters on the same visibility rule.

### API (shared contracts, no vendor names)
- `assignments.create({ botId, title, brief, clientNonce })` makes the thread, a first message and a
  run in one transaction, then enqueues `runContinueJob` after commit, the way the ticket wake does.
  Nothing waits on a queue slot or a per-space counter.
- `assignments.list({ botId?, state: active|archived, query?, cursor })`, `assignments.get`.
- `threadTarget` gains `assignmentId` (exactly one of bot, group, assignment), so `threads.get`,
  `send`, `subscribe`, `answer` and `stop` serve assignments with the existing transcript, cards and
  streaming. No second chat implementation.
- `assignments.steer({ assignmentId, text })` stores a `SteeringMessage` in that thread only, so it
  lands in the live run or starts one continuation for that assignment.
- `assignments.cancel` stops the live runs of the thread (the `threads.stop` path scoped to the
  thread) and sets `cancelledAt`. `archive` refuses while a run is live; it sets `archivedAt`,
  hides the assignment from default lists, keeps all data, and `unarchive` reverses it.
- `resume` is `threads.send` on a finished assignment: a new run in the same thread, cleared
  `cancelledAt`. The previous runs stay as history.

### Concurrency
- Per-thread ordering is the existing rule: one live turn per thread, further messages steer or wait.
  Different assignments do not wait on each other. The run lease and fence in Postgres stay the only
  claim mechanism; nothing new is a global slot, single-flight loop or in-process queue.
- Limits stay where a resource is scarce: the bot's computer lease and the provider's rate limit.
  A bot on a dedicated computer still runs one turn at a time on it, so two assignments there
  interleave rather than run in parallel. This is stated in the UI as the phase "Queued", not hidden.
- Several instances: create is idempotent by `clientNonce`; cancel, archive and resume use
  compare-and-set updates on `cancelledAt`/`archivedAt` and the existing run status transitions.

### Clients
- Web and Electron (same UI): route `/app/a/:assignmentId` reuses the thread view; an
  "Assignments" list on the employee page (search box, active/archived). Today rows and Board
  tickets link to this route; a ticket without an assignment still opens the board dialog.
- Mobile: native list on the bot screen and `assignment` route that reuses `thread.tsx` with an
  `assignmentId`; native menu for cancel and archive. Until it ships, Today and Board on mobile
  open the employee chat as now, which is the explicit degradation.
- Copy is minimal: no explainer text, the list appears only once an employee has an assignment.
- Reference idea only (per-bot searchable task conversations): a task list per bot where each row
  reopens its own conversation and search finds a past task. We adopt that shape on our own model;
  we copy no code or naming.

### Rollout safety
Production keeps the old API and worker alive after migrations. An old worker may pick up a run in
an assignment thread, and about 15 call sites read `thread.botId`. So PR 1 audits them and switches
them to `run.botId`/`assignment.botId` before any code creates an assignment thread, and creation is
turned on in a later PR. All migrations only add a table and a nullable relation.

## Non-goals
Branch and rewind; sharing one assignment between employees (that is the handoff item); moving a
message between threads; a per-bot concurrency cap (add only if the computer limit proves too weak).

## PR sequence
Each PR is one feature, tested offline, and mergeable alone.

1. **Assignment table and read model.** Migration, RLS, `assignments.list/get` returning phase,
   runs and files over the existing `getTicketWork` logic; the `thread.botId` audit. Nothing creates
   rows yet. Acceptance: under the non-owner `rakazo_app` login another space sees no rows and
   cannot insert; migration applies with the previous release's code; `exhaustiveProtectedCalls`
   typechecks; read of a seeded assignment returns its own runs and artifacts only.
2. **Two independent jobs on one employee (first milestone).** `assignments.create`,
   `threadTarget.assignmentId`, ticket wake creates an assignment and runs in its thread. Acceptance
   (offline testkit flow with the fake model): create A and B on bot X; both runs are live at once
   with distinct `threadId`; a message sent to A is absent from B and from the primary chat; an
   approval raised in A leaves B running and answering it resumes only A; `stop` on A leaves B
   alive; a repeated `create` with the same nonce returns the first assignment; the primary chat
   still works; an old-release worker run in an assignment thread completes.
3. **Web and desktop surface.** Route `/app/a/:id`, employee Assignments list, Today and Board link
   to it. Acceptance: Today attention and work rows and the Board ticket dialog produce the same
   href for the same assignment; waiting runs appear in "Needs attention"; the E2E screenshot of
   two assignments on one employee is attached to the PR.
4. **Steer.** `assignments.steer`. Acceptance: an instruction queued while A is running reaches A's
   run only; queued while A waits on an approval it is delivered after the answer; B is untouched;
   it survives a worker restart (claimed once, not twice).
5. **Cancel, archive, resume.** Acceptance: cancel stops A's live runs and not B's; archive is
   refused with a live run and hides A from the default list while keeping transcript, runs and
   files; sending to a finished or cancelled A starts a new run in the same thread; two racing
   cancels or archives end in one state.
6. **Search.** `assignments.list({ query })` over titles and the message blind index. Acceptance:
   finds A by a word only in its transcript, not B; respects visibility and archived filter; makes
   no plaintext copy of encrypted content.
7. **Mobile.** Native list, detail via `thread.tsx`, native cancel/archive menu, catalog strings.
   Acceptance: component tests for list and actions; Today and Board links open the assignment.
8. **Standalone creation (optional).** Create an assignment without a ticket from the employee page
   and from the chat ("make this its own assignment"), after the board flag question below is settled.

## Decisions
These replace the open questions the first draft carried.
1. **Assignments stand alone.** `assignments.create` works without `TICKET_BOARD_ENABLED`. A ticket
   wake also creates one when the board is on, so the essential part of PR 8 moves into PR 2. Only
   the creation UI stays for later.
2. **Visibility on shared employees** is the creator, plus the Owners and Managers of the employee
   (never Collaborators or Viewers). Row-level security enforces it. The row carries a copied
   `employeeId` so the policy reads `employee_entitlements` and never `bots` or `threads` on a
   manager's behalf. A manager sees the assignment row (title, bot, ticket link); the thread,
   messages and runs keep their own policies and stay private to the creator, as
   `shared-employees.md` requires. Writes are the creator's only.
3. **An assignment thread starts clean**: the brief plus the employee's memory, not the chat history.
4. **Dedicated-computer employees show "Queued"**; a second assignment is not refused.
5. **Routine and bot-initiated runs may belong to an assignment.** Runs, tasks and messages already
   carry `botId` and any `threadId`, so no column is needed: a routine whose `threadId` is an
   assignment's thread fires in it. PR 1 makes the routine target checks accept such a thread;
   attaching a routine to an assignment is a later PR.

## PR 1 notes
- `threads_owner_chk` demanded exactly one of `botId`, `groupId`, `externalConversationId`. The
  migration relaxes it to at most one so an assignment thread can have none. Loosening a check
  cannot break the previous release.
- Audit of code that reads a thread's `botId` (an assignment thread has none; the owner is
  `assignment.botId`, and runs, messages and tasks keep their own `botId`):
  - Changed: MCP approval cards and the connect-then-continue run (an approval raised in an
    assignment thread must be found and answered), history compaction (the thread is compacted for
    its employee instead of being skipped), content export (the thread is not treated as another
    bot's, so its summary and user messages are exported), routine target checks, and bot deletion
    (deletes the bot's assignment threads, which the cascade would miss).
  - Safe as is: primary-chat lookups by `botId` (they never return an assignment thread), calls
    (they require the employee's own one-to-one chat and refuse here), Today, calendar, stuck-work
    and notifications (they read `run.botId`).
  - Known gap, for the PR that turns creation on: account export and import cover bot and group
    threads only, so assignment threads are not yet exported.

## PR 2 notes
- `assignments.create` is two idempotent steps instead of one transaction: the assignment and its
  empty thread commit first (unique `(spaceId, clientNonce)`), then the brief goes through the same
  send every chat uses (message nonce `brief:<clientNonce>`), so there is one send implementation
  for model checks, suspension, attachments, steering and enqueueing. A first send that is refused
  removes the empty assignment; a retry with the same nonce finishes whatever the first call left.
- `threadTarget.assignmentId` is accepted by `threads.head/get/messages/subscribe/send/
  sendWithRoutines/react/stop/followUp/answer/markRead/markUnread`. The target resolves to the
  employee as a bot target whose `threadId` is the assignment's thread, and every one of those
  paths already scopes by thread. `clear`, calls and artifact uploads still take a bot or group.
- A ticket wake runs in the ticket's assignment, creating it on the first wake. A reassigned
  ticket detaches the earlier assignment (it keeps its history) and starts one for the new
  employee. The run keeps trigger `tickets`, which the chat snapshot treats as background work
  (only its waiting states surface); the assignment page in PR 3 lists these runs itself.
- Concurrency: nothing new limits runs, but the design was wrong that a second thread runs in
  parallel with no change. The executor takes one execution lease per (computer, bot), and the
  default computer scope is `team`, so two jobs of one employee are both live and independently
  addressable while the second run is requeued until the first finishes or pauses. This is the
  "Queued" case of decision 4 and applies to dedicated computers too. Running them in parallel on
  one computer would mean keying the lease by run, a non-additive change to an existing unique
  index that the previous release still relies on, so it is left for its own PR.

## PR 3 notes
- Route `/app/a/:assignmentId` is its own page, not a mode of the shell. It reuses the chat's
  `Transcript`, `Composer` and `useComposerActions` (which now takes an optional `assignmentId` and
  addresses sends, answers, reactions and stop to that thread), with a small thread hook that
  loads, subscribes and pages older messages through `threadTarget.assignmentId`.
- The status in the header opens to the assignment's runs and files. A ticket run keeps trigger
  `tickets`, which a chat snapshot hides while it works, so the page takes "running" and the Stop
  control from `assignments.get` runs. A newest run still in `queued` reads as Queued.
- Today runs, attention rows and work items, and the board ticket's work, carry `assignmentId` and
  link to the page; a ticket without an assignment still opens the board dialog. The assignment
  id is named only to its creator, so the link always opens.
- The employee panel shows an Assignments tab once the employee has an assignment. Archive and
  search come with PR 5 and PR 6.
- Mobile is unchanged: Today and Board rows open the employee chat until PR 7.

## PR 4 notes
- `assignments.steer({ assignmentId, text, clientNonce })` is the creator's own call; a manager who can see the row is refused. It writes one message in the assignment's thread and one pending `SteeringMessage`, in one transaction under the thread lock, so it touches no other thread.
- Where the instruction goes: the live run of the thread (any trigger except the creation intro, so a ticket run takes it too) reads it on its next turn; a run paused on a question or approval keeps it until the answer resumes the run, and the text is never taken as that answer (a plain send would answer the question). With nothing live, one `follow_up` continuation starts for it through `createPendingSteeringRun`. An archived or stopped assignment is refused; resume is a send.
- A repeated `clientNonce` returns the first message and run. Claiming, replay after a restart, and requeue after a cancelled run are the existing steering code, unchanged.
- No web change: the assignment page composer already steers a live run through `threads.send`; `steer` is the explicit call for clients that must not answer a pending question or start a run by accident.
