# Enterprise roadmap (fork)

Fork goal: make Rakazo an enterprise AI employee platform without breaking upstream merges.
Not linked from the public docs site (`apps/www/src/docs.ts` lists slugs explicitly).

## Ground rules
- One enterprise per install (single-tenant). No multi-org tenancy work.
- Stay mergeable with upstream: prefer new adapters, config, docs; avoid rewriting shared files.
- Vendor names may appear outside adapters in this fork, but keep provider-neutral interfaces.
- No Azure subscription yet: everything must be offline-testable (fakes, conformance tests);
  infra is delivered as IaC/manifests for later validation.
- One PR per workstream against `kleprevost/rakazo`.

## Milestone 1 — Azure-native foundation
| WS | Scope | Existing base | Status |
|---|---|---|---|
| 1 Secrets | Azure Key Vault `SecretStore` + `KeyProvider` adapters, workload identity (DefaultAzureCredential) | `infisical-secret-store.ts`, `aws-kms-key-provider.ts`, conformance tests | in progress |
| 2 Identity | Entra via existing OIDC: restrict to tenant (`tid`), optional group allow-list, admin role from group; docs | `packages/auth/src/oidc.ts` | todo |
| 3 Inference | Foundry + OpenCode Zen as deployment model / connections; verify via existing OpenAI-compatible + Pi providers before writing code | `pi-models.ts`, OpenAI-compatible connections | todo |
| 4 Compute + hosting | AKS reference deployment (Helm or manifests), Kata `runtimeClass` for bot pods, network policy, workload identity wiring | `kubernetes-sandbox.ts` (supports runtimeClass) | todo |

Acceptance for each WS: unit/conformance tests pass offline, `pnpm lint` clean, doc page under
`docs/enterprise/`, PR describes config and what was not verified against real Azure.

## Milestone 2 — Governance (later)
Central policy, approvals, budgets, audit export to Azure Monitor/Sentinel. Build on existing
`approvals`, `audit-export`, budget code. Scope after M1.

## Milestone 3 — Collaboration & integrations (later)
M365 via existing remote MCP support; team bots, delegation, memory are upstream features — verify, don't rebuild.
