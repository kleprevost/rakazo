# Computer fleet manager (design)

Design; build plan PR 1 (read-only inventory), PR 2 (observation), PR 3 (image governance) and PR 4 (operations engine) are implemented. An Admin page where operators see every bot computer in
the install and act on them, one or in bulk: recreate from an approved image without losing the
home folder, terminate, quarantine, hibernate, wake. Provider-neutral. It works first with the Docker
supervisor on the ACA + VM deployment ([aca-vm.md](../aca-vm.md)) and later with the Kubernetes
provider on AKS with Kata microVMs ([azure-aks.md](../azure-aks.md)). Same gate and shell as the rest
of the Admin section ([admin.md](./admin.md)); composes with bot suspend ([suspend.md](./suspend.md)).

Acceptance test: **an admin recreates a bot's computer from a fresh image without losing its home
folder, and sees the per-computer outcome.**

## 1. Current state

References are to this checkout; the older line numbers in `aca-vm.md` have drifted.

### Records
- `Computer` (`packages/db/prisma/schema.prisma:1437`): one row per computer, Team (shared by the
  space's bots, `bots Bot[]` at 1483) or Private. Holds `kind` (provider kind), opaque `providerRef`,
  `state` (`stopped | booting | running | suspending | error | quarantined`), `homeKey`,
  `homeRevision`/`homeRevisionAt` (last checkpoint), `restorePending`, `runningSince`, disk
  used/free, control and execution-lease fields, `maintenanceId` (computer-wide reservation).
- `ComputerUpdate` (1421): the durable maintenance job (`action` update/recover, `status`, `stage`).
- `ComputerRun` (1514): one row per stretch a computer ran, with `endReason` (including
  `replaced`) and `lastSeenAt`. This is already the restart history; it outlives the computer.
- `ComputerExecutionLease` (1538): per-bot fenced leases, so bots on a Team computer run concurrently.
- `AgentHome` (1393) is a per-bot revision row; the computer-level truth is `Computer.homeKey` plus
  `homeRevision`. No row records which image a computer runs.

### Provider interface
`SandboxProvider` (`packages/adapter-kit/src/interfaces.ts:99-243`) requires `describe`, `provision`,
`prepare`, `execute`, `connectScreen`, `sendInput`, `observe`, `act`, file ops,
`exportWorkspace`/`importWorkspace`, `snapshot`, `stop`, `destroy`. Optional: `ownsReference`,
`billsWhileRunning`, `isRunning` (read-only probe, 149), `isStopped` (154), `hasMountedHome` (156),
`provisionKind`, `keepAlive`, `releaseScreen`, `connectTerminal`, `pageBrowser`,
`cancelRunWork`, `inspectBackgroundWork`. `SandboxCapabilities` (`types.ts:253`) has only
`graphical, pty, snapshots, takeover, persistentHome, multiScreen`. `ComputerRef` (`types.ts:100`)
carries no image, resource, isolation or health data.

Nothing in the interface can list computers, report an image, usage or isolation mode, or
change network policy. The only read paths are `isRunning`/`isStopped`.

### Docker supervisor (`infra/sandboxes/supervisor/src/index.ts`)
- Bearer auth on `/computers*` (206-217); `/health` open and reports the configured image (204).
- `POST /computers` (221): under a per-bot lifecycle lock it compares the running container's image
  id with the supervisor's single `COMPUTER_IMAGE` (261, 291) and silently replaces on mismatch
  (also on DNS, mount, network, user drift, 300-305). So a new image reaches a computer only when it
  next provisions; the image is global per supervisor, not per request.
- `GET /computers/:id` (421) returns only `{ id, running, image }` (the tag string, not a digest).
  `POST /:id/stop` (1164), `DELETE /:id` (1204; container only, the home is a host bind mount).
- Containers carry labels `rakazo.managed`, `rakazo.botId`, `rakazo.spaceId`
  (`computer-spec.ts:587-590`). There is no list, stats or per-container network endpoint.
- Egress is host-wide: `SANDBOX_COMPUTER_EGRESS=restricted` plus the iptables script match per-bot
  `rakazo-c*` bridges ([self-host-docker-computers.md](../../self-host-docker-computers.md)).
  Policy `computers.egress` is documented as not enforced ([central-policy.md](../central-policy.md):78).

### Kubernetes provider (`packages/adapters/src/kubernetes-sandbox.ts`)
One pod per computer, labelled `rakazo-bot-id` (42), `runtimeClassName` from config (619; Kata on
AKS). Implements `isRunning` (235) and `hasMountedHome` (241), `connectTerminal` (307). RBAC grants
pods `create/get/delete` and `pods/exec` only ([self-host-sandbox-providers.md](../../self-host-sandbox-providers.md)),
so it cannot list or patch pods today. Image is one env var for all pods.

### Lifecycle, update and idle
- `provisionComputer` (`computer-lifecycle.ts:169`) refuses `quarantined` (186) and a foreign
  `maintenanceId` (188).
- `replaceComputer` (977), modes `recover | reset | update`: refuses while an execution lease, a live
  run or live user control exists (`ComputerBusyError`); claims `suspending` with a compare-and-set
  on `updatedAt` (1074); for `update` checkpoints first via `checkpointComputerWorkspace` and records
  `homeRevision` (1203-1228); then `releaseScreen`, `destroy`, row to `stopped` (1241), then
  `provisionComputer` again (1266). A failure before teardown leaves a running computer running
  (1268-1273). A gone sandbox restores from the last revision.
- `queueComputerUpdate`/`performComputerUpdate`/`reconcileComputerUpdates`
  (`computer-update.ts:53, 519, 608`): `queued -> running` claimed by `updateMany` (520), a 30 s
  heartbeat (530), republish of queued rows and failing of stale ones by a reconciler, and "never
  replay a destructive operation on redelivery" (524). `computerSupportsUpdate` (`computer-lifecycle.ts:960`)
  excludes `desktop`, `wuying`, `none`. Jobs `computer.update` and `computer.sleep` are registered at
  `adapter-kit/src/background-jobs.ts:17-18`, handled at `background-job-handlers.ts:166-169`.
- Idle sleep: `sleepComputerIfIdle` (`computer-idle.ts:422`, default idle 10 min, `sandboxIdleMs` 328)
  saves then stops; `createIdleComputerSweeper` (933) enqueues one sleep job per running computer.
  This is hibernate today; the home is saved, then the machine stopped.
- Safety quarantine already exists with a different meaning: `HostAwareSandbox.onUnsafeStop`
  (`host-aware-sandbox.ts:99-118`) sets `state = quarantined` when a stop could not be confirmed,
  and `provisionComputer` then refuses until Recover. It is not network isolation.

### Home and checkpoints
The workspace is the durable boundary ([computer-runtime.md](../../computer-runtime.md#persistence)):
Docker bind-mounts `DATA_DIR/homes/<homeKey>` so destroying the container never touches files and a
checkpoint only advances the revision marker; remote providers export the workspace into
`AgentHomeStore` (`LocalAgentHomeStore` `home.ts:35`, `ObjectAgentHomeStore` encrypts per home).
Browser profiles live under `.browser-profiles` in the home, so the browser identity survives
replacement (Team computers share one canonical identity, VISION.md:32-36). Homes over 5 GiB or one
million files cannot be saved and "stay running unsaved" (computer-runtime.md:98). System packages
outside the home are lost on replacement.

### Admin today
`admin.*` procedures in `packages/contracts/src/admin.ts`, `requireAdmin` (`apps/api/src/admins.ts:25`),
`admin.bots.suspend/resume` (`admin.ts:148`, `apps/api/src/bot-suspension.ts:38,139`), security events
via `recordSecurityEvent`. Suspend deliberately leaves the computer running (suspend.md "Computer").
Owners have Stop/Update/Recover/Reset per computer ([computer.md](../../computer.md)); no admin
computer view or cross-install operation exists. No image allow-list exists in central policy.

## 2. Principles

1. Reuse the existing replace/update/sleep machinery for every destructive step. The fleet layer
   adds targeting, governance, concurrency and reporting; it adds no second teardown path.
2. Provider-neutral contracts. Names like `container`/`microvm`; adapters translate (runtime class,
   `docker inspect`). Vendor names never appear in contracts, columns or UI copy.
3. Optional capabilities with explicit flags. A provider without one reports the item
   `unsupported`; nothing silently skips.
4. Postgres is the coordination layer: claims and leases per item, no global slot, no queue hop on
   the hot path.
5. Additive migrations only. The previous release ignores every new column and table.

## 3. Provider extensions (all optional)

Extend `SandboxCapabilities` with a `fleet` object of booleans; the UI greys actions from it.

```ts
fleet?: {
  inspect: boolean;          // inspect(): image, isolation, usage, health for one computer
  list: boolean;             // listManaged(): every computer the provider holds (orphan detection)
  imageSelection: boolean;   // provision({ image }) honored, else the provider's single image
  networkIsolation: boolean; // isolateNetwork()
  usage: boolean;            // inspect() fills cpu/memory (some providers cannot)
}
```

New optional methods on `SandboxProvider`:

```ts
inspect?(computer: ComputerRef, ctx): Promise<ComputerInspection>;
listManaged?(ctx): AsyncIterable<ComputerInspection & { botId?: string; spaceId?: string }>;
isolateNetwork?(computer: ComputerRef, mode: "isolated" | "normal", ctx): Promise<void>;
// provision() request gains: image?: { ref: string; digest: string }

interface ComputerInspection {
  runtime: "running" | "stopped" | "gone";
  image?: { ref: string; digest?: string };       // digest = the content digest actually running
  isolation: "container" | "microvm" | "vm" | "host" | "unknown";
  startedAt?: string;
  restartCount?: number;                          // provider-visible restarts of the same machine
  usage?: { cpuMillis?: number; memoryBytes?: number; memoryLimitBytes?: number; pids?: number };
  egress?: { mode: "open" | "restricted" | "isolated" | "unknown"; enforced: boolean };
  health?: "ok" | "degraded" | "unreachable";
}
```

Per adapter:

| Capability | Docker supervisor | Kubernetes | Remote (E2B, Daytona, ...) |
| --- | --- | --- | --- |
| `inspect` image digest | `docker inspect` `Image` plus image `RepoDigests`; new `GET /computers/:id/inspect` | `status.containerStatuses[].imageID` | not exposed; `unknown` |
| isolation | `container` (`Runtime` from inspect) | `microvm` when `runtimeClassName` is set to a VM class, else `container`; mapping is adapter config | provider-declared constant |
| usage | `docker stats` one shot, bounded | metrics API if present, else absent | absent |
| `list` | new `GET /computers` filtered by `rakazo.managed` | list pods by label (needs `list`) | absent |
| `imageSelection` | `POST /computers` body `image`, validated by the supervisor against `SUPERVISOR_ALLOWED_IMAGES` | pod spec image | absent (template ids) |
| `networkIsolation` | supervisor moves the container to an `internal` per-bot network it also joins (control and screen keep working, no external route) | patch pod label read by an operator-supplied deny-egress NetworkPolicy; RBAC gains `pods: patch, list` | absent |

Supervisor additions stay behind the existing bearer token and `x-rakazo-bot-id`/`space-id` identity
check (`managedContainer`, the same helper `GET /computers/:id` uses). Batch inspect
(`POST /computers/inspect`, ids in body, concurrency 4 inside the supervisor) avoids N docker calls
per sweep. The conformance suite in `adapters` gains offline tests for each optional capability
against the fake provider and a recorded supervisor, so a new provider proves it the same way.

## 4. Data model (additive migrations)

```
computers (new nullable columns)
  imageRef, imageDigest        what the last provision launched (authoritative for governance)
  isolation                    "container" | "microvm" | ...
  adminQuarantinedAt, adminQuarantinedByUserId, adminQuarantineReason(<=200)

computer_observations         (computerId PK, FK cascade)  -- written only by the observer
  observedAt, runtime, imageRef, imageDigest, isolation, restartCount, startedAt,
  cpuMillis, memoryBytes, memoryLimitBytes, pids, egressMode, egressEnforced, health

computer_fleet_operations
  id, kind (recreate|terminate|quarantine|release|hibernate|wake), status
  (queued|running|completed|completed_with_failures|cancelled), actorUserId (plain id),
  reason, params json (imageDigest, whenBusy, suspendBots), maxParallel,
  haltAfterFailures, createdAt, finishedAt

computer_fleet_items          unique (operationId, computerId); index (status, claimExpiresAt)
  id, operationId, computerId (plain id, survives delete), kind, status
  (pending|claimed|running|succeeded|failed|skipped|interrupted|cancelled),
  claimId, claimExpiresAt, attempt, outcome (code), stage, computerUpdateId,
  imageDigestBefore/After, homeRevisionBefore/After, startedAt, finishedAt

computer_updates (new nullable) targetImageDigest, idempotencyKey unique
```

Decisions:
- **Admin quarantine is a separate flag, not `state = 'quarantined'`.** The existing state means
  "unconfirmed stop, needs Recover" and blocks provisioning for another reason (see section 1).
  Reusing the word would corrupt both meanings; the UI shows both as distinct badges.
- Observations are a separate table so the high-write poller never touches the hot `computers` row
  (whose `updatedAt` is a compare-and-set token, `computer-lifecycle.ts:1074`).
- Restart history = `computer_runs` (existing) plus `restartCount` from the observation. No new table.
- Allowed images live in **central policy** (policy-as-code, as admin.md already states), not the DB:
  ```yaml
  computers:
    images:
      golden: { docker: "registry.example/rakazo/computer@sha256:...", kubernetes: "..." }
      allow:  ["sha256:...", "sha256:..."]   # includes golden
      enforce: report | block_new | recreate_when_idle   # default report
  ```
  A DB-managed list was rejected: it would add an editing surface and a second source of truth.
  Non-compliant = observed or recorded digest not in `allow`, or an image with no digest (tag-only).
- A partial unique index (raw SQL, as `computer_runs_open_idx` does) allows one non-terminal item per
  computer, so two operations cannot target the same computer at once.

## 5. Operations

| Operation | Semantics | Reuses | Needs |
| --- | --- | --- | --- |
| recreate | Save home, destroy, provision from the golden (or chosen allowed) image, verify | `queueComputerUpdate` (`update` mode) with `targetImageDigest` | `imageSelection` for non-default image; otherwise rebuild with the configured image |
| terminate | Save home, destroy machine, state `stopped`. Home kept; it comes back on next use unless quarantined or suspended | `replaceComputer` minus the provision step; `sandbox.destroy` | none |
| quarantine | Set `adminQuarantinedAt`, isolate network, refuse new work; optional `suspendBots` calls `suspendBot` for every bot on it | new gate, `suspendBot` (`bot-suspension.ts:38`) | `networkIsolation`; without it, choose `stop` fallback or item is `unsupported` |
| release | Clear flag, restore network. Does not resume bots: resume is its own admin decision | `resumeBot` | same |
| hibernate | Save and stop now instead of after idle | `sleepComputerIfIdle` path, forced | none |
| wake | Provision with no run | `provisionComputer` | none |

`recreate` and `terminate` never cancel runs. `whenBusy: skip` (default) marks the item
`skipped_busy`; `whenBusy: wait` retries with backoff up to a timeout. Cancelling runs is only
available through the explicit quarantine-with-suspend path, which already has the safe primitive.

### Recreate and the home folder
1. Item claims the computer: creates or fetches the `ComputerUpdate` keyed by `idempotencyKey = item.id`
   (a replayed item finds the same update, never a second teardown), setting `maintenanceId`, which
   already excludes new leases, takeover, idle sleep and mode changes (computer-runtime.md "Computer maintenance").
2. `replaceComputer(update)` checkpoints before teardown. If the checkpoint fails and the sandbox
   is not gone, nothing is destroyed and the item fails `failed_checkpoint`; the computer keeps
   running. If the home exceeds the save limits the item fails `failed_home_too_large` the same way.
3. Destroy, then provision with `image = golden`. Docker keeps the bind-mounted files untouched;
   remote providers import the checkpoint before use.
4. Verify and record `homeRevisionBefore/After`, `imageDigestAfter`. Verification: the new
   `homeRevision` equals or follows the saved one and is not `empty` when it was not; `inspect` (when
   supported) reports the target digest; the home path still lists the `.browser-profiles` directory.
   A mismatch is `failed_verify` with the old revision retained, not a silent success.
5. A failure after teardown leaves `state = error` with the home saved; retry runs provision only.

### Operation state machine

```
operation: queued -> running -> completed | completed_with_failures | cancelled
item:      pending -> claimed -> running -> succeeded
                         |          |-> failed (code) | interrupted
                         |-> skipped (busy|unsupported|noop_compliant|halted)
           pending|claimed -> cancelled (operation cancelled)
```

### Concurrency and multi-instance safety
- Creating an operation is one transaction: operation row plus all items. API instances only insert.
- Item start: a `computer.fleet.item` job per item with `replaceKey`, so redelivery collapses.
  The worker claims with `UPDATE ... WHERE status = 'pending' (or claim expired)` returning one row,
  sets `claimId`/`claimExpiresAt = now + 2 min`, extends it from a 30 s heartbeat (same pattern as
  `computer-update.ts:530`) and finishes with a compare-and-set on `claimId`. A lost claim aborts
  the worker's signal.
- Bulk limits: each operation carries `maxParallel` (default 3, max 10) as a rolling window: when an
  item finishes the next pending one is enqueued. This limits one operation's blast radius and the
  provider's pull and create load. It is not a global slot; unrelated work (runs, other operations on
  other computers) never waits. Providers add their own limit where they have one (the supervisor
  already serialises per bot and per space).
- Canary and halt: the first item runs alone; `haltAfterFailures` (default 2) stops enqueueing and
  marks the rest `skipped_halted`.
- Reconciler (modelled on `reconcileComputerUpdates`, `computer-update.ts:608`) republishes pending
  items whose job was lost and marks expired `running` items `interrupted`. An interrupted item is
  never replayed destructively; it follows its `ComputerUpdate`, whose own reconciler and the
  server-owner "Release computer" action already define recovery.
- Observer: a sweeper like `createIdleComputerSweeper` (`computer-idle.ts:933`) enqueues one
  `computer.fleet.observe` per computer with `keepExisting`, default every 60 s; `list` finds
  provider machines with no row (reported only, never deleted).

## 6. Admin UI sketch (`/admin/computers`, web and Electron; no mobile, as admin.md)

```
Computers                                     [Image: all v] [State v] [Provider v]  search
  Needs attention: 3 not on an approved image   2 failed   1 quarantined
 [ ] Bot / owner        Provider  Isolation  State       Image        Heartbeat  Egress      Health
 [ ] Ana's assistant    docker    container  running     sha256:ab12  12s ago    restricted  ok
 [ ] Ops (team, 4 bots) k8s       microvm    hibernated  sha256:77aa  2h ago     isolated    ok
 [x] Finance bot        docker    container  running     sha256:09f1  4m ago     open        degraded
 Selected 2   [Recreate] [Hibernate] [Wake] [Quarantine] [Terminate]
```

- Row opens a side panel: bots on it (names, owner only), image and golden, restart history from
  `computer_runs`, usage, disk, last operation outcomes.
- An action opens a confirmation listing the targets; destructive ones require typing the count.
  Unsupported actions are disabled with a one-line reason from the capability flags.
- Operation page `/admin/computers/operations/:id`: a progress bar and one row per computer with its
  outcome code and stage, `Retry failed`, `Cancel`. Same page after reload: state is server-side.
- Copy stays minimal; every visible string is listed in the implementing PR with its justification
  (AGENTS.md). This design adds none.

## 7. Audit events

Recorded with `recordSecurityEvent` (actor = admin, space = the computer's space):
`computer.fleet.operation.created|completed|cancelled`, `computer.fleet.item.succeeded|failed|skipped`,
`computer.recreated`, `computer.terminated`, `computer.hibernated`, `computer.woken`,
`computer.quarantined`, `computer.released`, `computer.image.noncompliant` (on transition only, once
per digest). Metadata: operation id, computer id, bot ids, provider kind, image digests, home revision
ids, outcome code. Never: paths, file names, provider error text, tokens, screen or terminal URLs.
`bot.suspended` events from a composed quarantine keep their existing shape.

## 8. Security invariants (each is a test)

1. Every `admin.computers.*` procedure calls `requireAdmin` first; non-admin and unverified-email
   admin get `FORBIDDEN` (table-driven over all procedures).
2. List and detail output schemas are explicit; a test pins the fields and asserts absence of home
   paths, `screenUrl`, control tokens, `homeStorageKey`, env, mounts, message content.
3. A recreate whose checkpoint fails leaves the old computer running and untouched
   (`failed_checkpoint`); no `destroy` call is made (spy on the provider).
4. After a successful recreate, a marker file and a `.browser-profiles` entry written before the
   operation are present after, and `homeRevision` is never `empty` if it was not before.
5. Replaying a claimed item (duplicate job, second API instance, worker crash) never creates a second
   `ComputerUpdate` or calls `destroy` twice (idempotency key; run with two concurrent claimants).
6. Two operations cannot hold a non-terminal item for the same computer (partial unique index);
   the second reports the conflict.
7. `maxParallel` is honored: with N pending and limit K, never more than K items are `claimed|running`
   (property test with a gated fake provider); unrelated computers outside the operation are unaffected.
8. A recreate never cancels a run or interrupts live user control; a busy computer yields
   `skipped_busy` or waits.
9. A quarantined computer refuses `provisionComputer`, execution-lease acquisition, takeover, screen
   and terminal capabilities, and hibernate-wake from any source until released.
10. Quarantine on a provider without `networkIsolation` is reported `unsupported` (or applies the
    explicit `stop` fallback); it is never reported `succeeded` without isolation.
11. Quarantine with `suspendBots` suspends every bot on a Team computer; release does not resume
    them.
12. Provisioning an image not in `allow` is refused when `enforce != report`, by the API and
    independently by the supervisor allow-list; a tag-only reference is refused.
13. Unsupported capability => `skipped_unsupported` with the missing flag named; no operation falls
    back to a different action.
14. Every item transition writes exactly one audit event of the matching type; audit metadata passes
    the content-free check used for `securityEventMetadata`.
15. Terminate keeps the home: after it, `home.readFile` of the marker succeeds and the next wake
    restores it. Home deletion is not part of this feature.
16. Observation staleness: a computer unseen for 3 intervals reports `health = unknown`, never `ok`.

## 9. Build plan (each PR independently mergeable, with tests)

1. **Read-only inventory.** `admin.computers.list` from existing columns (kind, state, bots and
   owners, `runningSince`, `computer_runs` last activity) plus the Admin page. As built: the optional
   `fleet.inspect` capability flag and `inspect()` (image reference and isolation) on the Docker and
   Kubernetes providers, reusing the supervisor's existing `GET /computers/:id`; a computer on a
   provider without it reports `skipped_unsupported`. No migration, no new supervisor endpoint.
   `get` and the detail panel wait for PR 2. Tests: invariants 1, 2.
2. **Observation.** As built: `ComputerInspection` gains the running digest, `startedAt`,
   `restartCount`, `usage`, `egress` and `health`, and the `fleet` flags gain `usage`. Docker: the
   supervisor's `GET /computers/:id/inspect` (digest from `RepoDigests`, one-shot stats, restart
   count, health, egress mode) and the batch `POST /computers/inspect` (ids with identity in the
   body, at most 100, concurrency 4), behind the existing bearer token; the provider's optional
   `inspectMany` uses it. Kubernetes `inspect` reports the image digest, restarts, start time and
   readiness. `ConfiguredSandbox` now forwards `inspect`/`inspectMany` (it did not before, so a
   deployment with saved connections reported every computer unavailable). Additive migration
   `computer_observations` (own table, row-security system-only, cascade on delete), written by
   `createFleetObserver` on the reconciler tick about once a minute: it lists computers that may be
   up on the configured provider, asks the provider (batched when offered), and upserts; a
   computer it cannot reach keeps its old row and goes stale. `admin.computers.get` returns the list
   row plus the observation, disk and the last 20 `computer_runs` stretches (the restart history);
   `list` adds `health`, which is `unknown` for a stopped computer, a missing observation or one
   older than three intervals (invariant 16). The page gains a Health column and a detail sheet.
   Deviations: the observer runs inside the leader-held reconciler pass instead of one
   `computer.fleet.observe` job per computer, which adds no job type and still has a single
   observer; the `computers` image and isolation columns are not added (nothing reads them before
   governance, PR 3, where the provisioned digest becomes authoritative); `list` (orphan detection)
   stays in PR 8. Tests: supervisor shaping and endpoint auth, Docker and Kubernetes adapters,
   the observer and staleness, admin shaping and authorization, web states, and a Postgres test
   for the observer table.
3. **Image governance.** As built: `computers.images.allow` in the policy schema, a list of
   `{ digest, tag? }` (full `sha256:` digests only; the tag is display text, never matched).
   `provision()` gains an optional `image: { ref, digest }` and the `fleet.imageSelection`
   capability flag (Docker and the fake provider). A named image is accepted only when its digest is
   listed and `ref` is pinned to it (`repo@sha256:...`), so a tag cannot stand in; with no list
   nothing is approved. `provisionComputer` takes the image as a final argument and checks it before
   reading the computer or calling the provider (`computers.images`, `FORBIDDEN`/policy), recording
   `computer.image_refused` with the digest only. The supervisor re-checks independently: it loads
   the same `RAKAZO_POLICY_FILE` (mounted on the VM at `/data/policy.yaml`) and answers 403
   `image not approved` otherwise, so no list travels in a request and no new trust path exists;
   it then pulls and starts exactly that reference. Additive migration: nullable
   `computers.imageRef` and `imageDigest`, written by `provisionComputer` when a start names an
   image (null otherwise). `admin.computers.list/get` return `imageCompliance`
   (`approved | not_approved | unknown`, null without a list) from the last observation, else the
   recorded image; a missing digest (tag only) is `not_approved`. `list` takes
   `imageCompliance: "not_approved"`, applied in the query, and the page shows a "Not approved"
   badge and a toggle only when a list exists. Deviations: `enforce` is not in the schema. A named
   image is always checked, and the configured default image is only reported on, because its
   digest is not known before it starts; `block_new` and `recreate_when_idle` follow with PR 9. The
   `isolation` column is not added (nothing reads it). The "needs attention" strip and the
   transition-only `computer.image.noncompliant` event are not built. A running computer that is
   re-provisioned is reused, so a named image takes effect on a start or on Recreate (PR 5), and a
   later start without one returns the supervisor to its configured image. Tests: 12 (policy schema,
   evaluator, provisioning refusal and audit, supervisor loader and 403, compliance flags and the
   filter against Postgres, web).
4. **Fleet engine with hibernate and wake.** As built: additive migration `computer_fleet_operations`
   and `computer_fleet_items` (system-only row security, items keyed by a plain `computerId`) and a
   partial unique index allowing one `queued|running` item per computer. An operation
   (`hibernate | wake`, `maxParallel` default 3 and at most 10, `haltAfterFailures` default 2) is
   created in one transaction; a computer already held by another unfinished item is recorded
   `skipped_busy` (`operation_in_progress`), so two operations never act on one computer. Items
   run as `computer.fleet-item` jobs (replace key per item). A worker claims an item with the
   operation row locked (`FOR UPDATE`), which counts the window and sets a 2 minute `claimId`
   lease renewed every 30 s, so instances and the worker never exceed `maxParallel` together and
   unrelated operations never wait. The first item runs alone (canary), then the window is
   `maxParallel`. Finishing compare-and-sets on `claimId`, then settles: once `haltAfterFailures`
   items failed the rest become `halted`, and when nothing is left the operation is `completed` or
   `completed_with_failures`, and the next items are published. The leader-held reconciler
   re-queues items whose claim expired (hibernate and wake are safe to replay) and marks them
   `interrupted` after three attempts. Item statuses: `queued | running | succeeded | failed |
   skipped_unsupported | skipped_busy | halted | interrupted`, with a short outcome code and never
   provider text. Hibernate reuses the idle-sleep check (`sleepComputerWithOutcome`, the same
   code path as `sleepComputerIfIdle`, now able to report how it ended): a computer with a live
   run, execution lease, user control, takeover grace or background work is `skipped_busy` and
   left running, which is Decision 2 (idle-only; nothing is forced or cancelled). Wake reuses
   `provisionComputer` with no run and schedules the usual idle sleep afterwards. A computer on
   another provider than the configured one, or a native desktop, is `skipped_unsupported`. Audit:
   `computer.fleet.operation.created|completed`, `computer.fleet.item.succeeded|failed|skipped`
   (one per item transition), and `computer.hibernated|woken` when the state really changed.
   `admin.computers.operations.create|list|get` are `requireAdmin` procedures; the Computers page
   gains row selection with Hibernate and Wake, an Operations table that polls while one is
   unfinished, and a per-computer outcome sheet. Deviations: no cancel or retry yet; there is no
   `params` or `reason` column (nothing reads them before recreate); a hibernated computer shows
   as "Hibernated" (state `suspended`). Tests: 5, 6, 7, 13, 14 (Postgres tests for claims,
   concurrent workers, the window, halt, replay, busy and unsupported items; admin shaping and
   authorization; web progress states).
5. **Recreate.** As built: additive migration (nullable `imageDigest` on operations; per-item
   `imageDigestBefore/After`, `homeRevisionBefore/After`, `browserProfilesBefore`,
   `computerUpdateId`; `computer_updates.targetImageDigest` and a unique `idempotencyKey`).
   A `recreate` operation optionally names an approved image digest. Creation refuses a digest
   that is not on `computers.images.allow` (`FORBIDDEN`, `computer.image_refused`), and the
   update checks again before it touches the computer, so a digest withdrawn in between fails the
   item with nothing destroyed. Each item queues one `ComputerUpdate` keyed by the item id through
   `queueComputerUpdate` (`update` mode), which refuses a busy computer (live run, lease or
   control), so busy items are `skipped_busy` and nothing is cancelled (Decision 2). A replayed
   item finds that update and follows it, never queueing or destroying twice. `replaceComputer`
   checkpoints first: a failed save is `failed_checkpoint` and the computer keeps running. The
   named digest becomes a reference pinned to it in the repository the computer already runs from
   (recorded image, else last observation, else `inspect`), since policy approves digests and a
   digest names the same content wherever it is pulled. After provisioning the item verifies the
   recorded and inspected digest, that a non-empty home stayed non-empty and that no
   `.browser-profiles` entries were lost, else `failed_verify`; it records before and after and
   writes `computer.recreated`. Without a digest the provider's own image is used. A provider
   without image selection is `skipped_unsupported` only when a digest was named; a computer that is
   not running is `skipped_unsupported` (`not_running`). The Computers page gains Recreate beside
   Hibernate and Wake, with an image picker from the policy once something is selected and a list
   exists; the operation sheet shows the short image digest and the two failure outcomes. Deviations:
   no `failed_home_too_large` (a save failure is `failed_checkpoint`), no typed-count confirmation
   (nothing is lost), no Docker opt-in variant. **Acceptance test**
   (`fleet-recreate.postgres.test.ts`). Tests: 3, 4, 8.
6. **Terminate.** Tests: 15 and busy handling.
7. **Quarantine and release.** Flag, gates, Docker `networkIsolation`, optional suspend composition,
   Kubernetes label patch and RBAC change documented. Tests: 9, 10, 11.
8. **Kubernetes parity and orphans.** `list`, usage, orphan report, AKS notes in `azure-aks.md`.
9. Follow-up: signature verification (a provider-neutral `ImageVerifier` called before provision, with
   the Docker supervisor and an admission policy as adapters), `recreate_when_idle` enforcement.

### Acceptance test (PR 5)
Postgres test with `FakeSandboxProvider`, `LocalAgentHomeStore` and the real job runner: seed a running
computer on image A with a marker file and a browser-profile entry in its home; as admin create a
`recreate` operation to image B (golden); run the job. Assert the item is `succeeded` with
`imageDigestAfter = B`, `providerRef` changed, marker and profile present, `homeRevision` advanced
and recorded before/after, one `computer.recreated` event, and that `admin.computers.operation.get`
returns the per-computer outcome. Negative case: make the checkpoint throw and assert
`failed_checkpoint` and an untouched running computer. An opt-in Docker variant mirrors
`team-desktops.docker.test.ts` against a real supervisor (not in CI by default).

## 10. Risks and decisions

Risks
- **Team computers are shared.** Recreating or quarantining one affects every bot on it; the UI lists
  them and the confirmation names the count.
- **Digest comparability.** Docker's `info.Image` is an image id, not a registry digest; a locally
  built or tag-pulled image has no `RepoDigests`. Governance needs digest-pinned references, so
  `golden` must be digest-pinned and tag-only is non-compliant.
- **Docker network isolation** relies on the per-bot bridge model; the `SANDBOX_SCREEN_NETWORK=internal`
  topology shares one network, where per-computer isolation is not possible (the capability reports
  false there).
- **Observation load** on a single VM supervisor: bounded by batch inspect and the sweep interval.
- **One VM is a single point of failure**; the fleet page makes the capacity problem visible but does
  not solve it.
- Remote providers do not expose image digests; they show `unknown` and cannot be policed.
- Homes over the save limits can never be recreated safely; the operation refuses them by design.

## Decisions

Settled by the maintainer; this and later PRs follow them.

1. **Admin quarantine is a separate flag** (`adminQuarantinedAt`, section 4) from the existing
   automatic safety `quarantined` state. The safety state is not renamed.
2. **No force-recreate.** Recreate and terminate are idle-only. To recreate a busy computer the
   operator suspends the bot first (the existing suspend cancels its runs), then recreates.
3. **The allowed-image list lives in the central policy file**, not the database. A per-request
   supervisor `image` is accepted only if its digest is on that list; the supervisor keeps its own
   copy of the check (invariant 12).

Restart history stays `computer_runs` stretches (section 4) until a provider reports `restartCount`
(PR 2: `restartCount` is shown beside the stretches in the detail sheet).
