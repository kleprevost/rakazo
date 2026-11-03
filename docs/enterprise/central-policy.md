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
evaluator (`packages/core/src/policy.ts`). **Only `models` is enforced**; every other section is
parsed and validated but has no effect yet.

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
