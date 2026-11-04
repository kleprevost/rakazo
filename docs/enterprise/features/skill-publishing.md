# Publishing a taught skill to a pilot group

Wave 4 item 5. A person teaches a skill by demonstration ([skills](../../skills.md): record, edit the
draft, save, test, add to a routine). This feature lets them offer that skill to colleagues: a
reviewer approves a frozen version, it goes to a small pilot first and then wider, and it can be
rolled back. **Publishing grants no tool access.**

## Current state (on `origin/main`)

- A taught skill is `taught_skills` (`botId`, `userId`, `name`, `goal`, `playbook`, `recording`,
  `status` `draft|saved`). It is private to its owner's space by row-level security. The playbook is
  text (when to use, inputs, steps, how to check, what to return, approval boundaries, failure
  handling). The recording is the raw demonstration and stays private.
- The executor lists the owner's saved skills in the prompt and, when the message names one,
  prefixes the full playbook (`formatSkillRunPrompt`). Group chats get none.
- Shared employees already have versions and audiences: `employee_versions` (immutable once
  published, `currentVersionId` is the pin, rollback repoints it), `employee_grants` and
  `user_directory_claims` (a grant names a user or a directory claim value). Their `skills` field
  holds names only; nothing resolves a shared skill at run time ([shared-employees.md](./shared-employees.md)).
- Tool access is decided by the capability broker per bot and acting user ([capability-broker.md](./capability-broker.md)).
  Nothing about a prompt or a skill's text is an input to that decision.

## Decisions

1. **A version is a copy of the text.** `published_skill_versions` holds `name`, `description` and
   the playbook, plus the author and the source skill id. It never holds the recording, the
   thread or memory; the submit path selects only the text columns. A database trigger rejects
   changes to the content columns, so an approved version cannot move. Editing the source skill
   changes nothing published; the next submission is version N+1.
2. **Reviewer: a deployment admin with the `platform` role.** One rule, the same as marketplace
   review, no new role and no per-skill role table. The Owner/Manager rule only makes sense once a
   skill belongs to a shared employee, and nothing resolves employee skills yet; it is added with
   that attachment (PR 4). Nobody reviews their own submission, so an admin who authors a skill
   needs a second admin.
3. **Pilot access is an audience pin.** `published_skill_audiences` is `(skillId, subjectKind,
   subjectValue) -> versionId` with kinds `user`, `claim` (read from `user_directory_claims`, as
   employee grants do) and `all`. Each audience pins its own approved version, so a pilot can run
   v2 while everyone else stays on v1. A person's own pin beats a group pin, which beats `all`.
4. **Pinning and rollback.** The executor resolves the pin at run start, so a publish or rollback
   applies to the next run and a running turn keeps its text. Rollback moves every audience above
   a version back to it. Pinning an older version for one audience is the same operation.
5. **No capability change.** The published skill reaches a run as instructions in the same slot as
   the runner's own saved skills. No table here is read by the broker, and nothing writes
   `capability_grants`. The runner's connections, grants, approvals and central policy decide
   every call; a skill that needs a tool the runner lacks is refused at the gate, like any other
   request. A skill the runner saved under the same name wins.
6. **Hygiene.** A credential-shaped string refuses submission and approval. Security events carry
   ids only. Account deletion keeps the copy and clears the author reference.

## Data model

All additive, row-level security in the same migration, system-only writes after the role check.

| Table | Purpose | Tenant can read |
| --- | --- | --- |
| `published_skills` | one per author and source skill | own, or any with a pin naming them |
| `published_skill_versions` | immutable copy, `submitted/approved/rejected/withdrawn`, one open submission per skill | own, or the version pinned for them |
| `published_skill_audiences` | audience to pinned version | rows naming them |

## Surfaces

Web and desktop: a saved draft skill card shows **Publish**, which submits for review (teaching is
not available on mobile, so there is no mobile entry point and nothing to degrade). Review and
audience management are API-first in PR 1 (`skillPublishing.*`), with an admin screen in PR 2.

## PR sequence

1. **Foundation (this PR).** Tables and policies, submit/withdraw, review with diff, approve or
   reject, audience pins, rollback, executor resolution, the Publish button, and a Postgres
   acceptance test: Ann publishes, an admin approves v1 for Ben, Ben runs it on his own connection
   and grants, Ann's recording and memory are invisible to Ben, rollback v2 to v1 changes the next
   run, and publishing adds no capability grants.
2. **Admin review screen.** Queue, side-by-side diff, approve or reject with a reason, audiences
   and pins with a rollback action, and the author's status line on the skill card.
3. **Fresh-input test.** Before approval the reviewer runs the version once on a supplied input
   in a throwaway context under the reviewer's own grants; the result is recorded on the version.
4. **Employee attachment.** Pin a published skill to a shared employee version, with Owner and
   Manager as reviewers for that employee and entitlements as the audience.
5. **Notify and retire.** Tell the author the outcome, warn pilot users when a skill is rolled
   back, and let an admin retire a skill everywhere.

## Risks

- A recorded playbook can carry text the author typed. The credential scan is a backstop; the
  diff review is the control, and the first review shows every line.
- Group runs and non-owner chat runs receive no published skills, matching saved skills.
- A new release's rows are ignored by the previous one; nothing is dropped or renamed.
