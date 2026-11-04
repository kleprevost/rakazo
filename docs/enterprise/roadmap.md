# Enterprise roadmap (fork)

Fork goal: make Rakazo an enterprise AI employee platform without breaking upstream merges.
Not linked from the public docs site (`apps/www/src/docs.ts` lists slugs explicitly).

## Ground rules
- One enterprise per install (single-tenant). No multi-org tenancy work.
- Stay mergeable with upstream: prefer new adapters, config, docs; avoid rewriting shared files.
- Vendor names may appear outside adapters in this fork, but keep provider-neutral interfaces.
- No Azure subscription yet: everything must be offline-testable (fakes, conformance tests);
  infra is delivered as IaC/manifests for later validation.
- One PR per workstream against `kleprevost/rakazo`, branch `claude/ent-<ws>` off `main`; Sonnet agents in worktrees.

## Milestone 1 — Azure-native foundation (done offline; needs a real Azure run)
| WS | Scope | Result |
|---|---|---|
| 1 Secrets | Key Vault `SecretStore` + `KeyProvider`, workload identity | Merged (#1) |
| 2 Identity | Entra via OIDC: claim allow-list, SSO admin; trusted email option | Merged (#3, #6) |
| 3 Inference | Foundry + OpenCode Zen as deployment model and connections | Merged (#2) |
| 4 Compute + hosting | Bicep AKS, Kata pool + `rakazo-kata` RuntimeClass, network policy, kustomize manifests | Merged (#7) |

## Next: M1 gaps (one small batch)
- Revoke access promptly when a user is terminated or loses their role: done (#9).
- Deferred by decision: Foundry keyless auth (API keys are fine), secret migration CLI (no running deployment yet).

## Milestone 2 — Governance (next, run policy and budgets in parallel)
Acceptance: enforced server-side before a run starts, offline tests, admin UI only where needed.
- Central policy: done (#8, #12, #13, #14); see [central-policy.md](./central-policy.md). Gaps: bot computer egress, routine-watch tools, already-running computers on a newly disallowed provider, admin read-only view.
- Budgets: per user/bot/org monthly USD limits enforced pre-run from persisted usage cost; see [central-policy.md](./central-policy.md#budgets). Gaps: `warnAtPercent` warning, admin spend view, mid-run cut-off.
- Audit to Azure Monitor / Sentinel: stream existing audit events to Log Analytics.
- Admin roles (security admin, bot owner, viewer) mapped from Entra app roles via the OIDC claim mapping.

## Milestone 3 — Collaboration & integrations
- Microsoft 365 via existing remote MCP: verify end to end, document.
- Teams as a messaging surface (new adapter on the existing messaging-surface abstraction).
- Shared team bots and delegation: upstream features — verify under Entra + Kata, don't rebuild.

## Alternative hosting: Container Apps + one Docker VM
PoC on Azure Container Apps (web, API) with the Docker supervisor, bot computers and worker on a private VM: design [aca-vm.md](./aca-vm.md) (supervisor screen proxy implemented), Bicep and deploy guide [aca-vm-deploy.md](./aca-vm-deploy.md), `infra/azure/aca/`. Not yet run on Azure.

## Real Azure validation (as soon as a subscription exists)
Deploy the Bicep, run a smoke test, confirm the items listed as unverified in each `docs/enterprise/*.md`
(Kata handler name, Cilium enforcement of bot egress, Key Vault purge/RBAC, Entra claims, Foundry deployment names).

## Wave 4 (priority order)
Release gate for cross-user delegation and shared skills: two Entra users add the same Executive
Assistant; each reads only their approved calendar; writes, sends and the other user's connection
are denied; a revoked grant blocks the next call; a fleet operator cannot revoke user sessions.

1. **Trust: enforce the broker + split operator permissions.** Grant decisions in live tool
   execution and credential resolution (broker PR 5+); operator roles so fleet operations and
   quarantine stop sharing the broad admin gate. Quarantine should also contain the computer
   (network/stop), not only the application.
2. **Independent assignments per employee.** Each assignment gets its own conversation, status,
   run history, approvals and files, built on the work-item read model. Create, search, resume,
   steer, cancel, archive. Two jobs on one employee stay independently addressable; Today and
   Board open the same assignment. Branch/rewind later. Fix in the same track: Today shows waiting
   runs under Working; Board realtime leaves the open ticket's linked work stale.
3. **Automation receipts and exceptions.** Visible routine outcomes: no change, action needed,
   failed, missed. Unchanged checks stay quiet; a source outage differs from a clean check.
4. **Reviewable shared knowledge.** Source-linked memory proposals with accept (undo) / reject
   (stays dismissed), published to a shared employee; source conversation stays private.
5. **Publish a taught skill to a pilot group** ([design](./features/skill-publishing.md)). Reviewable diff, pinned version, fresh-input test,
   pilot access, rollback. Publishing grants no tool access.
6. **Primary assistant with visible handoffs.** A nominated bot delegates linked child
   assignments (owner, scoped brief, return destination); each child runs under its own
   authorization; the user gets one consolidated deliverable.
7. **Release verification.** Images publish `edge` without a test gate; add a fast gate
   (typecheck + adapters unit) before `edge` moves.

First demo: "Watch the inbox for replies on these three commitments, prepare tomorrow's briefing,
and ask before sending anything" — monitoring and briefing as separate assignments, quiet on
unchanged checks, a real exception surfaced in Today, back to the exact draft for approval.

## Wave 3 backlog
Epics only; each needs its own design before building. Shared employees is designed in
[features/shared-employees.md](./features/shared-employees.md).
- Shared AI employees: one definition, per-user instances with private chat, memory and credentials, approved shared knowledge, roles from Entra claims and grants.
- Capability broker + quarantine: central grant/withdraw of tool capabilities per employee; extends merged suspend (#38).
- Computer fleet manager: pools, sizing, idle policy and cost view for per-user and service computers.
- Teach by demonstration + skill lifecycle: Observed -> Drafted -> Tested -> Approved -> Published; publishing never grants permissions.
- Team skill/template library: approved skills and employee templates browsable and reusable across the deployment.
- Memory review & knowledge governance: review queues, retention, provenance and retirement for shared knowledge.
- Agent evaluation & release management: draft -> evaluate -> approve -> canary -> publish -> rollback.
- Inference firewall (pre-model) + pre-action gate: inspect and block data before model calls and before side effects.
- Network egress policy: enforce `computers.egress` per provider (today not enforced).
- Group-scoped policy: central policy overrides keyed by directory group.
- Fine-grained admin roles: Platform, Security, Fleet, Bot Manager, Auditor.
- Credential governance: inventory, rotation, expiry and revocation of user and shared credentials.
- Action recording & audit replay: durable record of tool actions for review.
- Identity lifecycle: Entra group reconciliation, SCIM deprovisioning.
- Admin API: scripted access to metadata and governance operations.
- Proactive standing responsibilities: employees with owned recurring duties.
- Quiet autonomous reporting: summaries only when something needs a person.
- Execution replay: re-run a past run deterministically for debugging and evaluation.

### Licensing guidance
Adapt MIT/Apache-2.0 code with attribution (keep notices, record the source in the PR). Treat
noncommercial or restricted-license projects (for example OpenBot under PolyForm Noncommercial,
n8n under the Sustainable Use License, Dify under its modified Apache license) as design
references only: read for ideas, do not copy code or structure.
