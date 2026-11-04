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
2. **Group reconciliation** (done): refresh `user_directory_claims` from the directory on a
   schedule instead of only at sign-in, so a removed group takes effect without a sign-in.
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

## PR 2: group reconciliation
Claims used to change only when a token was read (sign-in, revalidation, Easy Auth). A person who
never signs in again kept their last groups. With `DIRECTORY_SYNC_MINUTES` (at least 15; unset is
off) the API reads each person's current groups from the directory and records them with
`recordDirectoryClaims` (`via: "directory_sync"`), which recomputes their entitlements.
- **Interface.** `DirectoryClaimsSource.claimsFor({ userId, email })` in `packages/adapter-kit`
  returns `found` (values, optional `truncated`) or `missing`, and throws when the answer is
  unknown. The Entra adapter (`graph-directory-claims.ts`, Microsoft Graph REST, no SDK) is loaded
  by `createDirectoryClaimsSource` with a dynamic `import()` only when sync is configured.
- **Connection.** It reuses `OIDC_ISSUER`, `OIDC_CLIENT_ID` and `OIDC_CLIENT_SECRET`: no vendor
  variables. Grant that app registration the application permissions `GroupMember.Read.All` and
  `User.ReadBasic.All` with admin consent. Needs `OIDC_ACCESS_CLAIM=groups`, because Graph returns
  group ids; with app roles the claim values are role names and sync is refused at startup.
- **Match and values.** The person is found by sign-in email (`mail` or `userPrincipalName`);
  two matches is an error. Transitive security groups only, as in the token's `groups` claim. More
  than 10,000 groups reports `truncated`, so claim grants fail closed.
- **Claim and lease.** `claimDueDirectoryClaims` picks people whose `refreshedAt` is older than
  the interval (stale ones after 10 minutes), skipping deprovisioned accounts, and takes each with
  a compare-and-set on `user_directory_claims.syncLeaseUntil` (5 minute lease). Every API instance
  runs the timer; no global loop or queue. Reads run five at a time.
- **Failure never widens.** Any error (unreachable, throttled, ambiguous, unreadable) calls
  `markDirectoryClaimsStale`: values become none and `truncated` is set, so claim grants confer
  nothing until a good read or a sign-in. `missing` records no groups (not truncated).
- **Where it runs.** In the API process, like SSO revalidation, not in a worker job: it needs the
  client secret, which the worker never receives (the compose env test enforces this).
- Migration `20261214120000_directory_sync_lease` adds `user_directory_claims.syncLeaseUntil`
  (nullable). Tests are offline: a fake source for `directory-sync.postgres.test.ts`, a fake
  `fetch` for the Graph adapter. Not verified against a real tenant.
- Not done: a directory 404 does not deprovision (an email change would look the same); SCIM does.

## Not covered
- Entra behavior is from documentation and offline tests; not tried against a real tenant.
- SCIM `Groups`, `POST`, `PUT`, bulk and sorting are not implemented.
- Computers are not stopped (as in suspend). Per-user budgets and messaging channel bindings stay.
