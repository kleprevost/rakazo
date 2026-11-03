# Hire an AI employee (role templates)

Creating a specialized assistant should feel like onboarding an employee, not configuring a
chatbot: pick a role, see what the new hire comes with, confirm, and it gets its first task.
Not linked from the public docs site.

## Scope

MVP (this PR): a versioned template contract, four shipped templates, two procedures
(`roleTemplates.list`, `roleTemplates.hire`), a web hire flow behind the existing "New bot" dialog.

Not in the MVP: a template editor, describing the job in plain language, a mobile flow, applying
the model hint, localized template text. See [Later](#later).

## Template schema

`RoleTemplateSchema` in `packages/contracts/src/role-template.ts` (strict, `schemaVersion: 1`):

| Field | Meaning |
| --- | --- |
| `id`, `version` | Slug and an integer bumped on content change. A hired bot keeps what it was created with. |
| `name`, `role`, `description` | Default bot name, short job title, one-paragraph description (becomes the bot description). |
| `instructions` | The bot's instructions. |
| `modelHint` | `standard` or `deep`. A hint only; the bot keeps the account's default model. |
| `skills[]` | `{ name, description, body }`, written as `SKILL.md` in the owner's skill library. |
| `routines[]` | `{ name, prompt, cron }`, created paused, in the hiring user's time zone. |
| `tools[]` | Built-in tool ids the role relies on (the ids policy rules use). |
| `connections[]` | `{ kind, access: read\|write, optional }` with `kind` one of email, calendar, documents, chat, tickets, crm. Provider-neutral: the user decides which app serves a kind. |
| `approvals.askBefore[]` | Plain-language actions the bot must get a yes for. Rendered into the instructions as a standing rule. |
| `starterTask` | First message the new bot receives. |

## Catalog

`packages/core/src/role-templates/templates/*.json`, imported and parsed by
`packages/core/src/role-templates/index.ts` (`ROLE_TEMPLATES`, `findRoleTemplate`). A template that
fails the schema stops the process at load, and a test checks each one (cron parses, routines only
name skills the template ships). Shipped: Executive Assistant (daily briefing routine, inbox
triage, meeting prep, read-only by default), Chief of Staff, Research Analyst, Operations Assistant.

Admin-supplied templates later: merge a second source (a directory named by an env var, or a
database table) into `ROLE_TEMPLATES` behind the same schema. Callers only use the two functions
above, so no other code changes. No editor is built.

## Creation path (reused)

`hireRole` in `apps/api/src/role-templates.ts` calls the existing `repos.createBot` with its `seed`
callback, the same hook agent import uses. In one transaction it creates the bot (and its thread),
the skills (a skill that already exists by name is kept, so hiring twice does not clash) and the
routines (validated with the same `assertRoutineSchedule` / `routineNextRunAt` / `routineRowData`
as `routines.create`). After commit, routines are announced exactly as imported ones are.
Nothing new is added to the database.

## Policy preview

`evaluateRoleTemplate(policy, template)` (core, pure) returns the parts central policy refuses,
using the existing evaluators:

- routines: `bots.allowRoutines` (`evaluateBotCapability`)
- tools: `tools.deny` (`evaluateToolUse`)
- connections: only an empty `integrations.allowConnectors` is a refusal, because connection
  kinds are provider-neutral and policy matches app slugs. The real connection is still checked
  when the user makes it.

`roleTemplates.list` returns every template with its `blocked` list; the dialog shows
"Blocked by your organization" beside the affected section. `roleTemplates.hire` recomputes the
list server-side, leaves blocked parts out (never requests what policy forbids) and returns them.
Approvals are only ever stricter than policy (asking more is always allowed), so they are never
blocked. Runtime enforcement is unchanged and remains the gate.

## Starter task

`hire` takes a client-generated `idempotencyKey`. It is stored as the bot's `spawnKey`
(`hire:<user>:<key>`), so a retried hire returns the same bot and creates nothing twice. The
server then sends `starterTask` as the bot's first message with the same send path `threads.send`
uses (model, policy and budget checks, normal run start), under the nonce `hire-starter:<key>`, so
a retry never adds a second message. The response carries `starter`: `queued`, or `failed` with a
reason (for example no model set up). The web dialog stays open on `failed` and offers Retry,
which repeats the call with the same key and only re-attempts the task. A run that starts and then
fails shows in Today like any failed run. The hidden "created" intro run is not used: it is limited
to asking a question and editing the bot's profile.

## Web

"Hire for a role" in the New bot dialog opens `HireRoleDialog`: role cards, then a preview
(description, collapsed instructions, routines, skills, what it works with, what it asks before)
and Hire. Sections with nothing in them are not shown.

## Mobile

Deferred. Creation on mobile is a native sheet with its own look picker, and a role picker should be
a native list with a pushed preview. The contract and procedures are shared, so the follow-up is
UI only. Hired bots appear on mobile like any other bot.

## Later

- Describe the job in plain language and draft a template with the user's model (no cheap existing
  path to reuse today).
- Admin-managed templates and an admin view of policy-blocked parts per role.
- Apply `modelHint` through a provider-neutral model role.
- Template localization; a per-hire choice of which routines to switch on.
- Map connection kinds to the user's connected apps and offer to connect the missing ones.
- Mobile hire flow.
