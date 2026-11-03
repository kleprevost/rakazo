# Lessons learned

- Upstream already has generic OIDC SSO, a Kubernetes sandbox with `runtimeClass`, OpenCode as a
  Pi provider, OpenAI-compatible connections with custom headers, audit export, and pluggable
  secret stores/key providers. Check for an existing seam before scoping new code.
- `node_modules` is not installed in fresh cloud sessions: run `pnpm install` then `pnpm db:generate`.
