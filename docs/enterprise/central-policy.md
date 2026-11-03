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
evaluator (`packages/core/src/policy.ts`). **`models`, `computers`, `bots`, `messaging` and `data` are enforced**; the rest are
parsed and validated but have no effect yet.

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
