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
- Vitest runs from the repo root (`pnpm exec vitest run <path>`), not from a package directory; Postgres tests need `VERIFY_DATABASE=1`, `DATABASE_URL` (runtime login) and `DATABASE_MIGRATION_URL` after `pnpm db:migrate` against your own database. Do not run content-encryption and row-security Postgres files together on one database.
- A new run-start gate (suspension, quarantine, entitlement, routine wake) must add its default answer to the shared executor test fake, `packages/adapters/src/testing/run-gates.ts`, in the same PR. The gates fail closed, so a fake that lacks a method silently refuses every run and the symptom is hundreds of "expected vi.fn() to be called" failures far from the cause (#55 broke 267 tests this way).
- Run the executor suites (`executor.test.ts`, `executor-readonly-approval.test.ts`, `ticket-changes.test.ts`) in a clean env (`env -u DATABASE_URL -u DATABASE_MIGRATION_URL -u VERIFY_DATABASE`) before calling a failure "pre-existing"; bisect against `main` rather than assuming.
- Postgres test env, in full: `VERIFY_DATABASE=1`, `DATABASE_MIGRATION_URL` as the owner, and `DATABASE_URL` as `rakazo_app` **with a password** (e.g. `rakazo-test-runtime`). Without the password the cross-tenant bypass key is not provisioned, so `row-security.postgres.test.ts` fails two cases ("bypass key", "ignores a bypass a tenant session turns on"); if `VERIFY_DATABASE` is unset or the two URLs are equal, the whole file silently skips (17 skipped). Check the count: it should report 17 passed, 0 skipped. Use `postgresql://user@localhost:55432/db` (TCP); Prisma cannot reach a unix-socket host.
- `bot-update.test.ts` and `database-access.test.ts` are plain unit tests with `vi.mock`. Under `VERIFY_DATABASE=1` the shared setup file imports `@rakazo/db` before the test's mocks apply, so they fail (`findUniqueOrThrow is not a function`, `getaddrinfo ENOTFOUND postgres`). They pass in a clean env; run them with `env -u DATABASE_URL -u DATABASE_MIGRATION_URL -u VERIFY_DATABASE`. Not a product bug.
- Postgres files that share one database must scope assertions to their own Space or bot: `listQuarantines` and the `all` quarantine scope are global, so `bot-quarantine` and `computer-quarantine` can see each other's rows when run together. Run files alone on a fresh copy of the migrated database to tell interference from a real failure.
- Several Postgres files run in parallel on one database hit `TransactionWriteConflict` (seen in `account-import` and `account-deletion`) because each app reconciles shared durable work. This is not a product bug: set `COPY_TEST_DATABASE=1` (plus `REALTIME_DATABASE_URL` equal to `DATABASE_URL`), as `packages/testkit/src/cli/harness.ts` does, so every file gets its own copy of the migrated database; 7 `account*`/`a*` files then pass together.
