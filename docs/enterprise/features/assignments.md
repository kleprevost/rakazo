# Independent assignments per employee

Roadmap Wave 4, item 2. Status: design, nothing built. Today an employee has one chat; two jobs
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
- New table `assignments`: `id`, `spaceId`, `botId`, `userId` (creator), `threadId` (unique, FK to
  `threads`), `ticketId` (nullable, unique), `title`, `clientNonce`, `cancelledAt`, `archivedAt`,
  `createdAt`, `updatedAt`. Unique `(spaceId, clientNonce)` makes create idempotent.
  Indexes: `(spaceId, botId, archivedAt, updatedAt)` and `(spaceId, userId, updatedAt)`.
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

## Open questions
- Should creating an assignment require `TICKET_BOARD_ENABLED`, or stand alone from PR 2?
  This design assumes tickets drive creation until PR 8 to avoid a second flag.
- Visibility on shared employees: may a collaborator see an assignment created by another
  collaborator, or only the creator and managers?
- Do assignment threads share the employee's chat history for the model (memory and recent
  context), or start clean with only the brief and memory? The design assumes clean plus memory.
- Is "Queued" on a dedicated computer acceptable for parallel jobs, or should such employees refuse
  a second concurrent assignment?
- Do routine and bot-initiated runs ever belong to an assignment, or only runs a person started?
