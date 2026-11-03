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
- Budgets: per user/bot/org spend limits enforced pre-run (extend existing budget code).
- Audit to Azure Monitor / Sentinel: stream existing audit events to Log Analytics.
- Admin roles (security admin, bot owner, viewer) mapped from Entra app roles via the OIDC claim mapping.

## Milestone 3 — Collaboration & integrations
- Microsoft 365 via existing remote MCP: verify end to end, document.
- Teams as a messaging surface (new adapter on the existing messaging-surface abstraction).
- Shared team bots and delegation: upstream features — verify under Entra + Kata, don't rebuild.

## Alternative hosting: Container Apps + one Docker VM
Discovery for a PoC with API/web on ACA and the Docker supervisor, bot computers and worker on a private VM: [aca-vm.md](./aca-vm.md) (needs a screen-proxy code change before it works). Bicep and deploy guide, not yet run on Azure: [aca-vm-deploy.md](./aca-vm-deploy.md), `infra/azure/aca/`.

## Real Azure validation (as soon as a subscription exists)
Deploy the Bicep, run a smoke test, confirm the items listed as unverified in each `docs/enterprise/*.md`
(Kata handler name, Cilium enforcement of bot egress, Key Vault purge/RBAC, Entra claims, Foundry deployment names).
