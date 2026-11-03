# Shared AI employees (design)

Design spike, docs only. Goal: one employee definition used by many people in one enterprise
deployment, with every person keeping a private conversation, private memory and their own tool
credentials. Not linked from the public docs site. No application code in this PR.

## Summary of the decision

Do not make `Bot`, `Thread`, `Run` or `Computer` multi-owner. Everything that holds private data
stays single-owner and keeps its current row-level security. Add a **definition layer** above it:

- An **Employee** is a versioned definition (role, instructions, skills, capability policy,
  approved shared knowledge) plus access rules (grants, directory claims).
- Each person who uses an employee gets an **instance**: an ordinary `Bot` row in that person's own
  space, pointing at the employee (`bots.employeeId`). Its thread, memory, computer, browser profile,
  secrets and routines are the existing per-bot rows owned by that person.
- **Shared knowledge** is a separate table, read-only to instances, written only through an
  approval workflow.
- **Autonomous shared work** runs on an optional **service instance**: a bot owned by a non-login
  service principal with its own computer and credentials.

This keeps the private-data invariant true by construction: managers never get a join path to
instance rows, because no managers' query touches them and no policy lets a manager's context see
another user's space. It also means Today, work items, routines, approvals, budgets, export and
deletion keep working per user with little or no change.

## Current state (all references on `origin/main`)

Ownership is a single `userId` everywhere, inside a `spaceId`:

| Thing | Where | Ownership |
| --- | --- | --- |
| Bot | `packages/db/prisma/schema.prisma:721` (`userId` :726) | one user, one space; `computerId` :746 |
| Thread | `schema.prisma:861` (`userId` :871) | one thread per bot (`botId @unique` :865) |
| Group chat | `schema.prisma:826` (`userId` :830) | one user; members are that user's bots |
| Run | `schema.prisma:965` (`userId` :975) | requester; routines/webhooks use the owner |
| Routine | `schema.prisma:1186` (`userId` :1192) | owner's bot, owner's thread |
| Memory | `MemoryDocument` `schema.prisma:1359`, unique `(spaceId, scope, botId, path)` :1374 | per space and bot |
| Agent home / browser profile | `AgentHome` :1393, `BrowserProfile` :1407 | `botId @unique`, plus owner `userId` |
| Computer | `schema.prisma:1437` (`userId` :1442, `scope` default `"team"`) | per space/scope, one owner |
| Credentials | `VaultCredential` :1951, `BotSecret` :1928 (`@@unique([userId, spaceId, botId, name])`) | per user, optionally per space/bot |
| Connections | `Connection` :1316 | per user and space |
| Usage | `UsageRecord` :1636 (`userId`, `botId`, `costUsd`) | attributed to requester and bot |
| Membership | `SpaceMember` :493 (`role` default `"member"`) | only a role; no sharing table |

Enforcement layers an employee design must compose with, not replace:

1. **Actor + space.** `requireMembership` (`packages/db/src/scope.ts:19`) builds the `Actor`
   (`userId`, `spaceId`). `scoped()` (`scope.ts:47`) throws `IsolationError` unless the record's
   `spaceId` equals the actor's and, when the record has a `userId`, it equals the actor's.
   Routes such as `bots.list` (`apps/api/src/routes/bots.ts:253`) filter on both.
2. **Row-level security.** `packages/db/prisma/migrations/20261021140000_row_level_security/
   migration.sql` enables, per table, a `*_tenant` policy on `app.space_id` (user-owned tables also
   on `app.user_id`) and a `*_system` policy on `app.rls_bypass`. The context comes from
   `DbContext` (`packages/db/src/row-security.ts:18`): `runAsTenant` (:33) or the audited
   `runAsSystem` (:42). No context means no rows. Child tables (`messages`, `memory_revisions`)
   check through their parent's `spaceId`.
3. **Directory identity.** OIDC claim mapping is `OIDC_ACCESS_CLAIM` (default `groups`),
   `OIDC_ALLOWED_VALUES`, `OIDC_ADMIN_VALUES` (`apps/api/src/env.ts:237`); admin is derived from
   the ID token stored at last sign-in (`apps/api/src/admins.ts:10`). `OIDC_REVALIDATE_MINUTES`
   re-checks it ([entra-id.md](../entra-id.md)). Entra's `groups` claim overflows above 200
   groups, so app roles remain the recommended source.
4. **Central policy and budgets** are a ceiling evaluated at run start ([central-policy.md](../central-policy.md));
   suspend is a `bots.suspendedAt` gate in `continueRun` ([suspend.md](./suspend.md)).

[today.md](./today.md) "Wave 2" confirms the gap: no sharing table, team visibility "scoped out".
`SpaceMember` roles do not help: a space is one person's workspace in practice (`docs/spaces.md`).

## Concepts and roles

- **Employee**: definition and access rules. Lives in the deployment, not in anyone's space.
- **Instance**: one person's copy of the working state (`Bot` with `employeeId`).
- **Service instance**: optional, one per employee, owned by a service principal.
- **Private employee**: any existing bot with `employeeId = null`. Nothing changes for them.

| Role | Use the employee (own instance) | Edit draft, publish versions | Approve shared knowledge | Manage grants | Delete/transfer |
| --- | --- | --- | --- | --- | --- |
| Viewer | read directory card only; cannot run | no | no | no | no |
| Collaborator | yes | no | propose only | no | no |
| Manager | yes | yes | yes | Collaborator/Viewer grants | no |
| Owner | yes | yes | yes | all roles | yes |

No role includes reading another person's instance. Deployment admins (`requireAdmin`) get
metadata and suspend (below), not content.

## Data model

All changes are additive. Names are final-ish; column types follow the existing style
(`cuid` text ids, `DateTime`).

New tables:

- `employees`: `id`, `name`, `description`, `listing` (`listed|unlisted`), `status`
  (`draft|published|retired`), `currentVersionId`, `suspendedAt`, `suspendedByUserId`,
  `serviceUserId?`, `createdByUserId` (plain id, no FK), `createdAt`, `updatedAt`.
- `employee_versions`: `id`, `employeeId`, `number`, `state` (`draft|published`), `role`,
  `instructions`, `skills` (JSON refs, not copies of private skills), `capabilityPolicy` (JSON, see
  Credentials), `modelPolicy`, `createdBy`, `publishedBy`, `publishedAt`. Published rows are
  immutable; edits create the next draft. Instances follow `currentVersionId`; rollback is
  repointing it.
- `employee_grants`: `employeeId`, `subjectKind` (`user|claim`), `subjectValue` (user id, or a
  directory claim value such as an Entra app role or group id), `role`, `grantedBy`, `expiresAt?`.
  Unique `(employeeId, subjectKind, subjectValue)`.
- `user_directory_claims`: `userId` pk, `values text[]`, `refreshedAt`. Written at SSO sign-in and
  by the revalidation job from the same claim `OIDC_ACCESS_CLAIM` already reads. Storing it
  avoids re-parsing the stored ID token on every request and gives a place to record "claim was
  truncated" (see Risks).
- `employee_entitlements`: `employeeId`, `userId`, `role`, `source` (`grant|claim`), pk
  `(employeeId, userId, source)`. A **materialized** result of grants x claims, recomputed when a
  grant changes, at sign-in, and on revalidation. Plain SQL, so row-level security can use it.
  Effective role is the highest across sources. Removal on claim loss is the same reconcile.
- `employee_access_requests`: `id`, `employeeId`, `requesterUserId`, `requestedRole`, `note`,
  `status` (`pending|approved|denied|withdrawn`), `decidedBy`, `decidedAt`.
- `employee_knowledge`: `id`, `employeeId`, `path`, `content`, `revision`, `state`
  (`approved|retired`), `approvedBy`, timestamps; unique `(employeeId, path)`. Plus
  `employee_knowledge_revisions` mirroring `memory_revisions`.
- `employee_knowledge_proposals`: `id`, `employeeId`, `proposedByUserId` (SetNull on user delete),
  `path`, `proposedContent`, `baseRevision?`, `status` (`pending|approved|rejected|withdrawn`),
  `decidedBy`, `decidedAt`, `reason`. The text is **copied at proposal time**; there is no pointer
  to the source private memory.
- `employee_shared_connections`: see Credentials.

Changed tables (nullable columns, no defaults needed, previous release ignores them):

- `bots.employeeId`, `bots.employeeVersionSeen` (what the instance last ran), `bots.instanceKind`
  (`user|service`). Partial unique index in SQL: `(employeeId, userId) WHERE employeeId IS NOT NULL`
  (Prisma cannot express it; same pattern as `agent_skills_*_lower_key`).
- `usage_records.employeeId` (no FK, like `botId`), so spend rolls up even after an instance is
  deleted.
- `runs.onBehalfOfUserId?` only for service-instance runs (see Execution).

Row-level security for new tables ships in the same migration as each table (the runtime role
gets default privileges, so a table without a policy would otherwise be readable by the app role):

- `employees`, `employee_versions`, `employee_knowledge`: SELECT when `app.rls_bypass` or an
  `employee_entitlements` row exists for `app.user_id` (any role). Writes only through
  `runAsSystem` inside the employee repository, after the application role check (the check cannot
  live only in RLS because Manager vs Collaborator needs grant context; defense in depth is a
  Postgres test per policy).
- `employee_entitlements`, `employee_grants`, `employee_access_requests`: own rows visible to the
  subject; grant rows visible to Owner/Manager of that employee.
- **No policy ever references `bots`, `threads`, `messages`, `memory_documents`, `computers` or
  `vault_credentials` on behalf of a manager.** Those keep their current tenant policies.

### Migration safety

Per AGENTS.md, the previous release stays up after migrations apply.

- Every migration only adds tables or nullable columns. Nothing is dropped, renamed or made
  `NOT NULL`, so no `-- deferred` migration is needed in this feature.
- A bot with `employeeId` set would run in the old release as a plain bot with its personal
  addendum only. Therefore instance creation (PR 3) is behind `SHARED_EMPLOYEES_ENABLED`,
  default off, and is turned on one release after the schema lands. Adding the column alone
  changes no behavior.
- **Backfill: none.** Every existing bot is a private employee (`employeeId IS NULL`) and runs the
  same code path as today. "Share" later converts a bot in place: create `employees` +
  version 1 from the bot's instructions, set `bots.employeeId` on that same bot, mark the caller
  Owner. The owner's existing thread, memory and computer stay attached to it. Zero behavior
  change on the day of upgrade.

## Authorization model

Two independent questions, always asked in this order and each must pass:

1. **Employee access** (new, `packages/core/src/employee-access.ts`, pure): given a user's
   entitlements, may they do `use | edit | publish | approve_knowledge | manage_grants | delete`
   on this employee? Deny by default. Expired grants and missing entitlements fail closed.
2. **Data ownership** (existing): for any thread, message, memory, computer, browser or secret
   read, `scoped(actor, record)` and RLS on `(spaceId, userId)` apply to the instance row exactly
   as for any bot.

Composition rules:

- Employee operations (`employees.*`) take no `botId`, and instance operations (`bots.*`,
  `threads.*`, memory, computer) never accept an `employeeId` as authority. A manager passing an
  instance id gets `IsolationError` from layer 2 because `userId` differs.
- Running an instance re-checks `use` at run start (cheap indexed lookup) next to the suspend
  gate. A user who loses entitlement keeps their data (export, delete) but cannot run it; the
  instance shows "Access removed". Data is not deleted by access loss.
- Effective capabilities are an **intersection**: central policy ceiling, then the employee version
  `capabilityPolicy`, then the user's own settings. The employee can narrow what a user's bot
  may do, and a user can narrow further; nothing widens upward.
- Directory claims never grant Manager or Owner through a claim unless an Owner chose that
  mapping; default claim mappings are Collaborator or Viewer, enforced in the grant API.
- The `use` check happens in the API and worker (`continueRun`), never only in the UI.

## Execution and runtime isolation

- **Per user per employee**: a run of an instance executes on that instance's computer, resolved
  from `bots.computerId` as today (`Computer` is per space and scope, owner `userId`). Different
  users therefore never share a sandbox, home, browser profile (`BrowserProfile` is
  `botId @unique`) or `AgentHome`.
- **Instance creation** copies nothing private. It creates the bot row, empty thread, empty
  memory and no computer until first use.
- **Service instance** (explicitly enabled by an Owner and allowed by central policy): a
  hidden `User` row of kind service (no login, no sessions, excluded from sign-in and billing),
  its own space and bot. Its computer, browser profile and credentials are those of the service
  principal. Triggered work is a `Run` with `userId = service user` and `onBehalfOfUserId` set to
  the human who triggered it (when there is one), for audit and budget attribution only: the
  run never loads that human's memory, credentials or computer.
- **Composition at run start** (executor, near the policy and budget gates): resolve instance ->
  load pinned/current version -> assemble prompt as `version.instructions` + approved shared
  knowledge (read-only, size-bounded like `MEMORY.md`) + the user's personal addendum
  (`Bot.instructions`) + the user's private memory. Shared knowledge never lands in a writable path
  of the computer.
- **No cross-user channels**: instances of the same employee cannot message each other; peer
  messaging remains same-user (`docs/groups.md`), and `crossSpaceCommunication` is forced off for
  instances. Group chats stay single-owner and may contain only the owner's instances.
- Wave 3 "Computer fleet manager" can later manage pools; this design needs only the existing
  one-computer-per-bot rule.

## Credential model

Principle: **a tool call has exactly one credential source, decided in advance, and a mismatch is
a visible error, never a fallback.**

`capabilityPolicy.connections[]` entries on the employee version declare per connector or secret
name a `mode`:

- `user`: the requesting user's delegated credential. Resolved from that user's vault
  (`vault_credentials`, `connections`) and bot secrets; if none exists the run asks the user to
  connect (the existing request card) and waits. It never reads another user's or the service
  principal's credential.
- `shared`: an explicit **shared bot identity**, stored on the service principal's vault and
  recorded in `employee_shared_connections` (`employeeId`, `connectorOrName`, `authorizedByUserId`,
  `scopeSummary`, `allowedRoles`, `revokedAt`). Only an Owner (or Manager if policy allows)
  authorizes; only runs whose requester role is in `allowedRoles`, or service instance runs, may
  use it. Approval cards for shared-identity actions say so.
- `none`: tool unavailable to this employee.

Rules: a `user` entry never resolves to `shared` when the user is missing a credential, and vice
versa; the resolved source is written to the `ExternalEffect`/audit record (source kind, never the
secret). Credential values are never in versions, knowledge, proposals or admin views.
`BotSecret`/`VaultCredential` rows keep their owner `userId`; the shared ones are owned by the
service user so deleting a person never deletes shared access, and deleting the employee deletes
its service principal's credentials. Command variables (shell env, `docs/bot-secrets.md`) are
readable by the bot, so they are allowed in `user` mode only.

## Memory scopes and promotion

| Scope | Storage | Readable by | Writable by |
| --- | --- | --- | --- |
| Private | `memory_documents` on the instance (existing) | that user's instance only | that instance and its user |
| Shared (approved) | `employee_knowledge` | every entitled user's instances at run time | Owner/Manager via approve or direct edit |
| Proposed | `employee_knowledge_proposals` | the proposer, and Owner/Manager reviewers | the proposer (create/withdraw) |

- The existing space-wide "Shared memory" (`docs/memory.md`) is per space and per user and stays
  separate; it is never the shared-knowledge store.
- External memory providers (Supermemory, Serenity, Honcho): for instances the **scope is forced to
  Isolated per instance** and the shared pool option is hidden, otherwise a provider pool silently
  crosses users. Shared knowledge is served from `employee_knowledge`, not a provider.
- **Promotion workflow**: (1) the user, or the employee at the user's request, chooses a private
  note; the UI shows the exact text that will be submitted and lets the user edit it; (2) a
  proposal row stores that text only; (3) a reviewer sees the text, proposer name (configurable:
  hidden by default), diff against the base revision, and runs a deterministic scan for secrets
  (the existing redaction patterns) plus an optional model-assisted PII check, advisory only;
  (4) approve writes a new revision with `approvedBy`; reject keeps a reason; (5) nothing is ever
  auto-promoted, and a bot cannot approve its own user's proposal when that user is the only
  reviewer unless they hold Manager/Owner.
- Retiring or editing approved knowledge takes effect on the next run; running turns keep their
  snapshot. Account deletion: proposals keep text, drop the proposer link; approved knowledge stays.

## Interaction with existing features

- **Routines**: a routine on an instance belongs to that user and runs as them on their
  computer, with their credentials (`user` mode). Employee-level standing routines are defined on
  the version and run only on the service instance with `shared` credentials; they cannot be
  created by Collaborators. Routine creation is gated by central policy `bots.allowRoutines`.
- **Today, work items, calendar**: instance bots are the user's own bots, so `today.summary`,
  tickets and calendar already scope per user ([today.md](./today.md)). Service-run results are
  surfaced to Owners/Managers as work items, not as chat content.
- **Approvals** ([approvals.md](../approvals.md)): the approver is the person whose credentials or
  computer the action uses. For a user instance that is the requesting user. For a service
  instance run, approvers are Owner/Manager (`employee_approvers` can be a later refinement);
  a run triggered by user X on the service instance shows X the outcome but X's approval does not
  authorize shared-identity actions unless the policy lists X's role.
- **Budgets** ([central-policy.md](../central-policy.md#budgets)): each run records
  `userId = requester`, `botId = instance`, `employeeId`. Existing `budgets.user` and `budgets.bot`
  apply unchanged; add `budgets.employee` (sum of `usage_records.employeeId`). Service runs count
  against the employee and, if present, `onBehalfOfUserId`'s budget.
- **Suspend (#38)**: `admin.bots.suspend` stays per bot. Add `employees.suspendedAt`; the gate in
  `continueRun` checks `bot.suspendedAt OR employee.suspendedAt`, and suspending the employee
  cancels active runs of all instances and the service instance with the existing primitive.
  Managers may **pause new instances/publishing**; only admins suspend. Resume restores nothing
  but access.
- **Central policy**: new section `employees: { allowShared: bool, allowServiceInstances: bool,
  maxManagers?, requireApprovalForKnowledge: true }`; all other sections already bound instance
  runs, since they are normal runs.
- **Audit events** (`SecurityEvent`/audit log, metadata only, never content or secrets):
  `employee.created|published|rolled_back|retired`, `employee.grant_added|removed`,
  `employee.entitlements_reconciled` (counts), `employee.access_requested|decided`,
  `employee.instance_added|removed`, `employee.knowledge_proposed|approved|rejected|retired`,
  `employee.shared_connection_authorized|revoked`, `employee.suspended|resumed`.
- **Account deletion and export**: deleting a user cascades their space, so instances, threads,
  memory and credentials go with them; their grants, entitlements, requests cascade; proposals
  lose the proposer id. The last Owner cannot be deleted; deletion transfers to a deployment admin
  triage list. Export contains the user's own instances and proposals, not other people's data
  and not shared knowledge beyond what their runs quoted in their own threads.
- **Messaging apps** (Slack/Teams): a DM links to the requester's instance. A shared channel
  would mix users; not supported until it has its own design (open question).

## UI sketch

Minimal copy (AGENTS.md: every word is UI); progressive disclosure.

- **Directory** (sidebar "Create" menu -> "Browse employees", also web route `/app/employees`):
  cards with name, role line, owner team. Per card one action: "Add" if entitled, "Request access"
  otherwise. Mobile uses a native list and sheet.
- **Add**: creates the instance in the user's current space and opens its chat. No dialog.
- **Sharing dialog** (bot settings -> "Share", Owner/Manager only; the item is absent for private
  bots until "Share" is chosen): people and directory-group picker with a role menu; below, the
  access-request inbox when non-empty. Group entries show the claim value.
- **Versions** (Owner/Manager): draft editor, "Publish", history with "Roll back".
- **Knowledge**: "Suggest for team" on a private memory note (Collaborator+), and a review queue
  for reviewers with approve/reject.
- **Admin console** (`/admin/employees`): name, owner, instance count, last activity, spend,
  suspended flag, Suspend/Resume. No thread, memory or credential content, and no "view as".
- Instance chat header shows the employee name and, under it, only exceptional state
  ("Suspended", "Access removed").

## Security invariants (acceptance criteria)

Each is a test in PR 9 or the PR that introduces the surface. "Postgres" = runs with
`VERIFY_DATABASE=1` as the non-owner runtime role so RLS is enforced.

1. **Two-user acceptance test.** Two Entra users (simulated ID tokens with different group/role
   claims) access the same employee. Each sees only their own chat and memory; approved shared
   knowledge is available to both; a Manager cannot read private threads or use others' credentials.
2. A Manager/Owner context querying `threads`, `messages`, `events`, `memory_documents`,
   `memory_revisions`, `computers`, `vault_credentials`, `bot_secrets`, `browser_profiles` for
   another user's instance returns zero rows (Postgres) and `IsolationError` through the API.
3. No `employees.*` procedure's input or output contains instance thread, message, memory or
   secret content; enforced by a contract test over the schemas plus an import-boundary test that
   the employee repository does not import the thread, message, memory or secret repositories.
4. Admin console endpoints return only metadata columns (allow-list asserted in a test); an admin
   without a grant cannot open an instance chat.
5. Instance of user A and user B never share a `Computer` row, `providerRef`, `AgentHome`,
   `BrowserProfile` or provider memory pool; creating B's instance reuses nothing from A.
6. A `user`-mode connection with no credential for the requester asks for connection and never
   resolves to the shared or another user's credential; a `shared`-mode connection never reads a
   user vault. Both outcomes recorded with source kind in the effect record.
7. A secret scanner finds no credential value in versions, knowledge, proposals, audit events or
   admin responses (fixtures plant canary values).
8. Private memory is never promoted without an explicit user submission; a proposal stores only
   submitted text with no link to source documents; editing the private note afterwards does not
   change the proposal.
9. Only Owner/Manager can approve knowledge; a Collaborator proposing and approving their own
   proposal is refused; a Viewer cannot run.
10. Removing a grant or the claim value (next reconcile) blocks the next run within the
    revalidation interval and leaves the user's data intact and exportable.
11. Claim-sourced grants cannot confer Owner; the last Owner cannot be removed.
12. Employee suspend or admin suspend cancels runs on every instance and blocks every run source
    (same table as [suspend.md](./suspend.md)); managers cannot resume an admin suspend.
13. Central policy denials still apply to instance runs; a version `capabilityPolicy` cannot enable
    a tool central policy denies (intersection test).
14. Spend of a run is attributed to requester, instance bot and employee; service runs to the
    service principal and `onBehalfOfUserId`; budgets enforce all three.
15. A service-instance run never loads the triggering user's memory, credentials or computer.
16. Every migration passes the migration-safety test (`packages/db/src/migration-safety.test.ts`)
    and the previous release's test suite against the new schema.
17. Every grant, publish, approval and shared-credential change writes an audit event with no
    content.

## Build plan (each PR independently mergeable, with its own tests)

1. **Schema foundation**: `employees`, versions, grants, `user_directory_claims`,
   `employee_entitlements`, `bots.employeeId` (unused), RLS policies, contracts, pure access
   evaluator in `core`. Tests: evaluator unit tests, Postgres RLS tests, migration safety. No
   behavior change.
2. **Directory claims + reconcile**: write claims at sign-in and revalidation, recompute
   entitlements from claim grants, audit events. Tests: simulated Entra tokens (roles and groups,
   overflow), revoke on claim loss.
3. **Employee CRUD + versions**: create from scratch or "Share" an existing bot in place, publish,
   rollback, Owner/Manager API, `SHARED_EMPLOYEES_ENABLED` flag (off). Tests: backfill/convert keeps
   thread, memory, computer; roles matrix; boundary test (invariant 3).
4. **Instances + run composition**: add-to-workspace, executor composes version + addendum,
   `use` check at run start, forced isolated memory scope, `crossSpaceCommunication` off. Tests:
   two-user isolation (invariants 2, 5), prompt composition, access removal.
5. **Sharing dialog + grants UI** (web/desktop, native mobile follow-up): user and claim grants,
   role limits. Tests: web component tests, API role matrix.
6. **Directory + access requests**: listing, request/approve/deny, notifications through existing
   needs-attention. Tests: visibility of unlisted employees, request lifecycle.
7. **Shared knowledge + proposals**: tables, read path into prompt, propose/review UI, secret scan.
   Tests: invariants 7, 8, 9; revision conflicts.
8. **Credential modes**: `capabilityPolicy.connections`, user-mode connect cards, never-fallback
   resolution and effect source record. Tests: invariant 6 with fake connectors.
9. **Governance hooks**: employee suspend, `budgets.employee` and `usage_records.employeeId`,
   `employees` policy section, admin metadata console, audit completeness, deletion/export
   handling. Tests: invariants 4, 12, 13, 14, 17.
10. **Service instance + shared connections + standing routines + manager approvals** (behind a
    second flag and policy `allowServiceInstances`). Tests: invariants 6, 15; deterministic fake
    runtime.
11. **Acceptance suite**: the end-to-end two-user test and canary-secret sweep (invariants 1, 2, 7)
    as a standing CI check that runs against every later change.

PRs 1 to 4 deliver "many people, one definition, private everything". Knowledge sharing, shared
credentials and autonomy are strictly additive after.

## Risks

- **Per-user duplication of cost**: N users means N computers and N sets of memory. Intended (it is
  the isolation), but fleet cost is real; mitigate with idle stop and Wave 3 fleet manager.
- **Version drift**: instances follow `currentVersionId`; a bad publish affects everyone. Needs
  rollback (included) and eventually canary (Wave 3).
- **Prompt-level leakage**: a model can paraphrase shared knowledge or user data into a proposal.
  Reviewer UI, secret scan and "no auto-promotion" reduce but do not eliminate it.
- **Claim limits**: Entra `groups` overflows above 200 and returns a link instead; app roles are
  safer. Stale claims between revalidations extend access up to `OIDC_REVALIDATE_MINUTES`.
- **Service principal blast radius**: shared credentials are the riskiest part; hence a separate
  flag, explicit authorization records, role-limited triggers, and last in the plan.
- **Upstream mergeability**: touching `Bot`, executor and `usage_records` conflicts with upstream;
  keep edits small and put logic in new modules.
- **RLS gap by design**: employee tables are written through `runAsSystem` after an application
  check, so a bug in that module could over-grant. Hence the Postgres policy tests and
  the import-boundary test.

## Decisions

Recorded from the maintainer; the sections above are read in their light.

1. **An instance is a full `Bot` row** (nullable `bots.employeeId`), not a lighter binding. Every
   existing feature (threads, memory, computers, routines, Today, budgets) works on instances
   unchanged.
2. **Shared-identity credentials are authorized by the employee Owner only**, plus an optional
   admin-configured approver list. Managers configure which credential an employee uses but cannot
   attach a shared one. The access evaluator expresses this as `authorize_shared_credential`
   (Owner, or a listed approver who still holds at least Collaborator) next to
   `configure_credentials` (Manager and up). This replaces "or Manager if policy allows" in the
   Credential model, and `allowedRoles` there still limits who may *use* a shared credential.
3. **Shared multi-user channels (Teams or Slack channels) talk only to the employee's service
   instance, using the shared identity.** Personal credentials and personal memory are never used
   in group channels; a direct message still links to the requester's own instance. This replaces
   "not supported" in the Messaging apps note and depends on the service instance (PR 10).

Open items not decided here: whether proposer identity is shown to reviewers (default hidden),
whether claims may confer Manager (the evaluator allows it only when an Owner created that grant;
a claim never confers Owner, enforced in the evaluator and by a database check), upstream posture,
and admin takeover of an ownerless employee (definition only, never instance content).

## Status

PR 1 (schema foundation) ships the tables above except knowledge, proposals, access requests and
shared connections, `bots.employeeId` with a one-instance-per-user partial unique index, row-level
security, the contracts in `packages/contracts/src/employees.ts` and the pure evaluator in
`packages/core/src/employee-access.ts`. Nothing reads them yet and no flag is needed. Not added
yet: `employeeVersionSeen`, `instanceKind` and `usage_records.employeeId`, which arrive with the
PRs that use them.

PR 2 (directory claims and reconcile) records the verified `OIDC_ACCESS_CLAIM` values in
`user_directory_claims` at SSO sign-in, at each revalidation (before the access check, so a user who
just lost access is recorded too) and on Easy Auth passes when the ID token is new or changed.
Entra overage (`_claim_names` or `hasgroups`) and oversized values are stored as `truncated`, so
claim grants confer nothing. `packages/db/src/employee-entitlements.ts` recomputes
`employee_entitlements` from grants and claims: per user (claims changed) and per employee (grants
changed, in chunks of users). Each recompute reads current rows after taking a per-user advisory
lock, applies a diff (`diffEntitlements` in `core`) and records
`employee.entitlements_reconciled` with ids and counts when anything changed, so concurrent
instances converge without a global loop. Expired grants drop out at the next sign-in or
revalidation and in an hourly sweep. Nothing calls the employee-level reconcile yet: grant writes
arrive with PR 3 and must call `reconcileEmployeeEntitlements` after committing.
