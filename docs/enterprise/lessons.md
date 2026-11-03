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
