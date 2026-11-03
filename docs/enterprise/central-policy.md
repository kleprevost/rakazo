# Central policy (design)

Org-wide rules an enterprise admin sets once and no user, bot or space setting can loosen.
Today Rakazo has per-user approval modes, per-account/space allow and block lists, and per-bot
disabled tools. All are owned by the user. Central policy is a ceiling above them.

## Principles
- **Backend-enforced at the moment of use** (model resolution, tool call, computer start, connection
  save). Settings-time checks are a convenience; runtime checks are the gate, because settings can
  predate the policy.
- **Deny wins, fail closed.** An invalid policy stops the API from starting rather than running unrestricted.
- **Policy as code first.** A versioned file (`RAKAZO_POLICY_FILE`, YAML or JSON) checked into the
  enterprise's own config repo and mounted into API and worker. No editing UI in v1; an admin
  read-only view later. Absent file = today's behavior.
- **One evaluator, one contract.** Schema in `packages/contracts`, pure evaluator in `packages/core`,
  loaded once per process. Enforcement points call the evaluator; they never re-implement rules.
- **Visible but quiet.** A denied action returns a structured reason (`policy`, rule id); UI shows one
  short "Blocked by your organization" style message where the action failed, nothing persistent.
- **Audited.** Policy load (hash/version) and each denial are written as `SecurityEvent`s.
- Additive for upstream merges: new files plus small hooks at enforcement points.

## Policy v1 schema (sketch)
```yaml
version: 1
models:
  allowProviders: [azure, opencode]        # omit = any
  allowModels: ["azure/gpt-*"]             # glob on provider/model; omit = any in allowed providers
  allowUserConnections: false              # users may not add their own model credentials/endpoints
approvals:
  minimumMode: ask | auto                  # forbids looser modes (e.g. "never ask")
  alwaysAsk: ["email.send", "files.delete"] # tool ids/globs that always show a card
tools:
  deny: ["computer.host_*"]                # tool ids/globs refused everywhere
integrations:
  allowConnectors: [...]                   # app integrations; omit = any
  mcp:
    allowHosts: ["mcp.example.com"]        # remote MCP / OpenAPI hosts; omit = any
computers:
  allowProviders: [kubernetes]             # sandbox providers
  allowHostComputer: false                 # desktop "use my computer"
  egress: { allowDomains: [], denyDomains: [] }   # later; needs provider support
bots:
  allowFleetManagement: true
  allowSubagents: true
  allowWebhooks: true
  allowRoutines: true
messaging:
  allowSurfaces: [web, desktop, mobile, teams]   # external messaging channels
data:
  allowAccountExport: true
```

## Status
Step 1 is implemented: the full v1 schema (`PolicySchema`, strict, in `packages/contracts/src/policy.ts`),
the loader and process-wide accessor (`packages/adapters/src/policy-runtime.ts`), and the pure
evaluator (`packages/core/src/policy.ts`). **Every section is enforced** except `computers.egress`.

- `RAKAZO_POLICY_FILE` points at a YAML or JSON file (JSON is read by the YAML parser). It is read
  once at API and worker startup. An unreadable or invalid file stops the process with the failing
  field named; no variable means no policy. Mount the file into both containers and pass the
  variable to both.
- Audit: `policy.loaded` (version, SHA-256 of the file) at startup; `policy.denied` (rule,
  `provider/model` subject, surface) per refusal. Never message content or secrets.
- Model enforcement: the run gate is `resolveModelKey` (every run, backup and role path); the
  catalog every picker reads (`chatCatalog`) is filtered; saving a connection, choosing a role
  or backup model, setting the main model and changing a bot's model are refused with `FORBIDDEN`
  and `{ reason: "policy", rule }`. Users see "Blocked by your organization". A saved choice that
  a later policy forbids is kept and fails at run time with that message.
- `computers`, `bots`, `messaging` and `data` are enforced too (evaluators in
  `packages/core/src/policy-capabilities.ts`, asserts in `packages/adapters/src/policy-capabilities.ts`).
  Denials use the same `FORBIDDEN` / `policy.denied` surfaces and message.
  - `computers.allowProviders`: refused when saving deployment or account computer settings
    (the picker lists only allowed providers; going back to "default" is always open) and when a
    computer starts (`provisionComputer`). A computer already running keeps running until it stops.
  - `computers.allowHostComputer: false`: refuses choosing "this computer" as the host, pairing a
    desktop, its websocket connection, and runs reaching the user's computer. The host computer is
    sandbox kind `desktop`, so it must also be listed in `allowProviders` when that list is set.
    `computers.egress` is not enforced yet.
  - `bots`: fleet, helper (`run_subagent`, `spawn_bot`) and routine-creation tools are removed
    from the run's tool set and refused at tool time; enabling "Manage other bots", creating or
    enabling a routine, enabling a routine webhook and rotating a bot webhook secret are refused.
    Existing routines and webhooks are kept: their runs fail before the model with the policy
    message, and inbound webhook requests get 403; each records a denial.
  - `messaging.allowSurfaces`: surface ids are the chat-app provider ids already in use
    (`slack`, `telegram`, ...). The Rakazo apps (`web`, `desktop`, `mobile`) are always allowed and
    need not be listed. A disallowed app is hidden from the status list, cannot be connected, its
    webhooks get 403, inbound messages are dropped and outbound sends are refused (existing links
    are kept).
  - `data.allowAccountExport: false`: refuses issuing an export token and downloading with one.
- Integrations: `integrations.allowConnectors` matches the app slug shown in the connector catalog and
  on the saved connection (for example `gmail`; case-insensitive, `*` globs), not the managed
  provider that serves it. Connecting is refused (`connections.begin`), the catalog is filtered, and
  a connected app the policy no longer allows is dropped from the run's connections so its tools
  are neither listed nor callable. `integrations.mcp.allowHosts` matches the hostname of every
  remote MCP, OpenAPI and GraphQL tool source (exact, or `*.example.com` for subdomains only; ports
  ignored; userinfo tricks resolve to the real host). It is checked on save and on every request
  those sources make, including OAuth discovery, token and registration endpoints, so list an
  OAuth server's authorization host too. Local-command (stdio) MCP servers are blocked whenever
  `allowHosts` is set. Denials record the host only. Not covered: built-in services (web search,
  voice) and the browser-side OAuth redirect.
- Tools and approvals: ids are the tool names the approval Allow/Block lists use (a built-in
  tool's name, or an installed connector tool's name; every name a call goes by, including each
  batch action, is checked), globs case-insensitive. `tools.deny` is checked in the run gate
  (`gateToolCall`): the model gets a short "blocked by your organization" tool error, the run
  continues, and `policy.denied` is recorded; denied tools are also left out of the tool list the
  model is offered. `approvals.alwaysAsk` makes the gate ask in every mode, over Always allow and
  allow rules (a Block rule still refuses). `approvals.minimumMode` clamps the effective mode where
  a run reads it, and `autoReview.set` refuses a looser mode with `FORBIDDEN`/`policy`; the mode
  the settings read returns is the clamped one, so pickers show the effective mode. A tool called
  from inside a routine's watch passes the same `tools.deny` and `integrations.allowConnectors`
  checks (and the suspension check) in `BrokeredConnector`, which wraps every connector call. Not
  covered: allow/ask rules themselves.
- Budgets: see [Budgets](#budgets).
- Not yet: a capabilities flag for clients; routines, agent import and other paths that pin a model
  without going through the bot-model check are caught at run time only.

Example:
```yaml
version: 1
models:
  allowProviders: [azure]
  allowModels: ["azure/gpt-*"]
  allowUserConnections: false
```

## Budgets
```yaml
budgets:
  period: month          # calendar month, UTC; the only option
  organizationUsd: 5000  # all usage in the install
  perUserUsd: 200        # the human the run is billed to
  perBotUsd: 100
  warnAtPercent: 80      # accepted, not enforced yet
```
All keys are optional; an absent limit is no limit, and with none set no query is made.

- **Cost source.** Every model call already writes a `UsageRecord` (user, bot, space, time,
  `costUsd`). Budgets sum `costUsd` since the first instant of the UTC month; nothing new is
  recorded. A call without a reported cost counts as zero, so a provider that reports no cost is
  not limited. One aggregate (organization, user and bot in a single `FILTER` query, run as
  system because they span Spaces) is served by the covering index
  `usage_records_period_spend_idx` (additive migration).
- **Who is billed.** The run's `userId`: the bot's owner, who is also the member whose Space the
  run belongs to. Usage on a user's own model connection counts too (a budget is a spend cap on
  everything the install runs, not only on managed credits).
- **Gate.** In the run executor right after the routine/webhook trigger check, before any model is
  resolved or called. At or over any limit (organization, then user, then bot) the run fails
  terminally (no retry; a routine backs off like other account errors) with "Monthly budget
  reached", and `policy.denied` is recorded with rule `budgets.organization`, `budgets.user` or
  `budgets.bot` and subject `monthly-budget`.
- **Overshoot.** The check happens once at run start. Runs already in flight, and runs that start
  concurrently, finish and are counted afterwards, so spend can pass a limit by the cost of those
  runs. No lock serializes runs.
- **Not covered.** Warnings (`warnAtPercent`), an admin spend view, mid-run cut-off, per-space
  budgets, and gates outside the executor (voice, memory and other model calls made outside runs
  still count toward spend but are not themselves refused).

## Delivery
1. **Foundation + models** (first PR): contract, file loader, evaluator, audit events, a capabilities
   flag so clients can hide disallowed choices, and enforcement for `models`.
2. In parallel after (1) merges: **tools + approvals floor**, **integrations + MCP hosts**,
   **computers + bot capabilities + messaging**.
3. Later: admin read-only view, admin roles (security admin vs. bot owner) from OIDC claims,
   policy-change diff in audit, egress domain control.

## Open questions
- Should violating existing state (e.g. a user's saved connection now disallowed) be hidden, or shown
  disabled? v1: shown disabled with the short reason, never deleted.
- Per-group policy (e.g. engineering may use computers, sales may not) needs group claims on the
  user; out of scope for v1, keep the evaluator's input shaped so a `principal` can be added.
