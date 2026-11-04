# Identity lifecycle: deprovisioning and group reconciliation

When someone leaves, the directory knows first. Rakazo must stop that person's access and their AI
employees within minutes, without waiting for a session to expire, and without deleting anything.
Not linked from the public docs site.

## What exists
- OIDC revalidation (`OIDC_REVALIDATE_MINUTES`, [entra-id.md](../entra-id.md)) refreshes tokens on an
  interval and ends sessions when the provider refuses. Easy Auth rejects it
  ([easy-auth.md](../easy-auth.md)), so there a disabled user lives until the ID token expires.
- `admin.users.endSessions` signs one account out. The next sign-in still works.
- Bot suspension ([suspend.md](./suspend.md)) stops one bot's runs and refuses new ones.
- Capability grants and delegations ([capability-broker.md](./capability-broker.md)) have
  `revokedAt`; employee entitlements are derived from grants and `user_directory_claims`
  ([shared-employees.md](./shared-employees.md)).
- Operator roles ([admin-roles.md](./admin-roles.md)); `security` may suspend and end sessions.

## PR sequence
1. **Deprovision** (this PR): one provider-neutral operation, the admin action, a minimal SCIM 2.0
   Users endpoint, and the per-request check that makes Easy Auth sessions stop.
2. **Group reconciliation**: refresh `user_directory_claims` from the directory on a schedule
   instead of only at sign-in, so a removed group takes effect without a sign-in. Design below.
3. **Hardening**: optional SCIM `Groups` read for diagnostics, a deprovision-on-disable report in
   Admin Audit, and a bulk "deactivate everyone not in the directory" dry run. Only if asked.

## PR 1 behavior
`deprovisionUser` (`apps/api/src/identity-lifecycle.ts`), called by `admin.users.deprovision`
(role `security`; not on yourself) and by the provisioning endpoint:
- Sets `user.deprovisionedAt` and `deprovisionedVia` (`admin` or `provisioning`) first, so nothing
  can create or use a session from then on. Then it ends all sessions (which revokes paired
  devices), suspends every bot the person owns (the existing suspension), cancels their active
  runs, including their runs on other people's bots, revokes their capability grants (their bots'
  allow/ask rows, delegations of their credentials, rows they created as owner; `deny` rows stay,
  they only narrow), and empties their employee entitlements.
- Keeps all data. Idempotent: a repeat finishes a partly applied run and keeps the first time.
  Records `user.deprovisioned` (via, admin id, counts, reason).
- `reactivateUser` clears the flag and recomputes entitlements from the grants (which were not
  deleted). It does not resume bots (an admin does, in Admin AI employees) and does not restore
  revoked capability grants. A provisioning request may only undo a provisioning deactivation; an
  admin's decision answers 409. Records `user.reactivated`.

### Enforcement
- **Every request.** `packages/auth` returns no session when the user row is deprovisioned, in the
  same session-lookup override that already refuses messaging accounts. It reads the flag with the
  user row, so there is no extra query, and it covers cookie, bearer, RPC, streams and Easy Auth.
  The Easy Auth pass cannot recreate a session either: session creation refuses the account.
- **Sign-in.** Any method is refused with `ACCOUNT_DEACTIVATED` (SSO callback redirects with the
  same code). The IdP may keep issuing tokens; they are not enough.
- **Entitlements.** The reconcile functions treat a deprovisioned user as holding nothing, so a
  later grant or claim change cannot give access back.

### Provisioning endpoint
`SCIM_BEARER_TOKEN` (at least 32 characters) turns on `/api/v1/scim/v2`; unset, the routes do not
exist. Put the value in the platform's secret store (Container Apps secret, Key Vault reference,
compose secret). Constant-time comparison; 600 requests per minute per address (429).
- `GET /Users?filter=userName eq "<email>"` finds an account by email, case-insensitively. Other
  filters answer 400 `invalidFilter`. This is the validation call a directory makes.
- `GET /Users/{id}`, `GET /ServiceProviderConfig`.
- `PATCH /Users/{id}` with `active` false (or `"False"`) deprovisions; true reactivates. Other
  attributes are accepted and ignored. `DELETE /Users/{id}` deprovisions; nothing is deleted.
- `POST /Users` answers 501: accounts are created at first sign-in under the sign-up rules. Turn
  off "Create" in the directory's provisioning actions.
- Match key is the sign-in email, as in the rest of SSO (see `OIDC_TRUST_EMAIL`). The `id` is the
  Rakazo user id. The web proxy must pass `/api/v1/scim/*` and the `Authorization` header.

### UI
Admin, Users (`/admin/users`), `security` role: buttons **Deactivate** (confirming click, then
**Confirm**) and **Reactivate**, badge **Deactivated**. Errors: **Could not update account**.
Sign-in error: **This account is deactivated**. Everything else is existing copy.

### Data
Migration `20261211120000_user_deprovision`: `user.deprovisionedAt`, `deprovisionedVia`, nullable.
The previous release ignores them. Tests: `identity-lifecycle.postgres.test.ts`, `provisioning.test.ts`,
the acceptance case in `packages/testkit/src/authorization.test.ts`, and the Easy Auth case.

## PR 2 design: group reconciliation
Today claims change only when a token is read: sign-in, revalidation, Easy Auth token change.
A person who never signs in again keeps their last groups. Add a worker job per user (Postgres
claim with a lease, no global loop) that reads the person's group ids from the directory with
application permissions, then calls `recordDirectoryClaims` (`via: "directory_sync"`). A failed
read calls `markDirectoryClaimsStale` (fail closed). Provider-neutral interface
`DirectoryClaimsSource` (`packages/adapter-kit`); the Entra adapter uses Graph `transitiveMemberOf`
and loads on first use. Config: `DIRECTORY_SYNC_*` through the shared connection settings, off by
default. Users whose `refreshedAt` is oldest are visited first; a 404 from the directory means
deprovision (`via: "provisioning"`).

## Not covered
- Entra behavior is from documentation and offline tests; not tried against a real tenant.
- SCIM `Groups`, `POST`, `PUT`, bulk and sorting are not implemented.
- Computers are not stopped (as in suspend). Per-user budgets and messaging channel bindings stay.
