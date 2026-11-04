# Lessons learned

- Upstream already has generic OIDC SSO, a Kubernetes sandbox with `runtimeClass`, OpenCode as a
  Pi provider, OpenAI-compatible connections with custom headers, audit export, and pluggable
  secret stores/key providers. Check for an existing seam before scoping new code.
- `node_modules` is not installed in fresh cloud sessions: run `pnpm install` then `pnpm db:generate`.
- `infra/updater/src/compose-env.test.ts` requires every env var read in source to be passed in all
  compose files and nothing extra. SDK-read vars (e.g. `AZURE_CLIENT_ID`) go in its `NOT_PASSED` list or stay out.
- Run `pnpm exec biome check --write <files>` before committing; import order is enforced.
- Review sub-agent diffs for house rules they miss: WS1 used inline `import("…")` types (must be top-level `import type`).
- The full adapters vitest suite exceeds the tool timeout; run the relevant files.
- Upstream's Pi runtime already knew `azure` and `opencode`; the only gap was the deployment-model key lookup. Investigate-first briefs keep PRs small.
- Worktree agents: the guard rejects compound shell commands (cd + heredoc + git); brief agents to use single commands and Edit/Write.
- Better Auth: throwing from a provider's `getUserInfo` yields raw 403 JSON; return `{ error }` from `validateUserInfo` to redirect with a code.
- Sonnet cost so far: ~100-125k tokens per workstream, including the PR.
- Parallel agents on one feature: give each its own new files (evaluator + assert per area) so merges only conflict on index exports and the status doc.
- Sub-agents report pre-existing failures without checking `main`; check them yourself (the SSO admin change silently broke 22 router tests).
- Row-level security tests must run with `DATABASE_URL` as the non-owner runtime login (`rakazo_app`) and `DATABASE_MIGRATION_URL` as the owner; a superuser URL bypasses RLS and makes isolation tests fail (or worse, pass vacuously). Agents should set both before calling an RLS failure "environmental".
- Every new protected RPC must be added to `exhaustiveProtectedCalls` in packages/testkit/src/authorization.test.ts, or the testkit typecheck collapses to `never`.
- Known sandbox-only failures (also fail on main): authorization `models/connect` cases, host-computer process tests, compose installer smoke.
