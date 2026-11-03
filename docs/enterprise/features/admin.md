# Admin section (MVP)

One place for deployment operators to see and manage the install. Web and desktop only: the
Electron app hosts the web UI, so it gets the section for free. Mobile intentionally has no admin
UI: it is an operator surface, needs a large screen, and nothing in it is needed on the go.
Admins reach it from the account menu ("Admin"); everyone else never sees the entry.

## What existed
- `isAdmin` / `requireAdmin` (`apps/api/src/admins.ts`): a verified email on
  `RAKAZO_ADMIN_EMAILS`, or a verified SSO identity carrying an `OIDC_ADMIN_VALUES` value.
  `me.isAdmin` tells the web app.
- Pages `/admin/access` (free access grants) and `/admin/plugins` (plugin submissions), each a
  standalone page with no navigation to it.
- `GET /api/audit-events/export` and `audit.events`: the organization audit log, readable by
  organization owners and admins (a different gate from deployment admin).
- `security_events` table (`listSecurityEvents`), written by `recordSecurityEvent`, with no reader
  for the web: the old `security.events` procedure is closed for app accounts.
- Policy runtime (`activePolicy()`), budgets (`budgetPeriodStart`), `UsageRecord.costUsd`.
- No bot disabled/paused flag existed (`archivedAt` is the user's archive, not an admin action); `suspendedAt` now is one.

## Pages (`/admin`)
| Page | Path | Shows |
|---|---|---|
| Overview | `/admin` | Sign-in methods (password, SSO, Easy Auth), default model, computer provider, policy loaded with version and short hash, user and AI employee counts |
| Users | `/admin/users` | Name, email, role (admin via email list or SSO claim, else member), SSO linked, last sign-in; action: end all sessions |
| AI employees | `/admin/bots` | Name, owner, space, model (blank = deployment default), last active, this month's spend, archived |
| Policy | `/admin/policy` | Active policy rules as `section.rule` rows, month spend against org/user/bot limits, recent `policy.denied` events |
| Audit log | `/admin/audit` | Security events, newest first, filters: type, user email, from and to date; Load more |
| Free access | `/admin/access` | Unchanged page, now inside the section; the tab shows only when the deployment sells model credits |
| Plugin submissions | `/admin/plugins` | Unchanged page, now inside the section |

Old routes keep working (`/admin/access`, `/admin/plugins`, and sign-in redirects to any
`/admin/...` path). A shared `AdminShell` gives every page the same header and sub-navigation, and
sends non-admins to `/app`.

## Procedures
New, in `packages/contracts/src/admin.ts` (the `admin.*` namespace), implemented in
`apps/api/src/admin-console.ts`, wired by `apps/api/src/routes/admin.ts`:
- `admin.overview`, `admin.users.list`, `admin.users.endSessions`, `admin.bots.list`,
  `admin.policy`, `admin.audit`.

Reused: `me` (for `isAdmin`), `accessGrants.*`, `marketplace.*` (existing pages), the sign-in
session adapter that SSO revalidation uses to end sessions, `listSecurityEvents` (gained optional
`from`/`to`), `activePolicy`, `budgetPeriodStart`. Not reused: `audit.events`, because it is gated
by organization role rather than deployment admin, and its events are per organization; the
security event log is the deployment-wide record the policy and sign-in events land in.

## Authorization
- Every handler calls `requireAdmin` first, on the server, before reading anything. The web
  gate is a convenience only. Tests assert `FORBIDDEN` for each procedure for a non-admin and for
  a listed admin whose email is unverified.
- Reads run as system (the data spans spaces and organizations) only after the admin check.
- `endSessions` cannot target yourself (use sign out), requires an existing user, deletes the
  user's sessions through the same adapter SSO revalidation uses, and records
  `auth.session.revoked` with `via: admin`.
- Single-tenant: one enterprise per install, so "all users" and "all bots" are the install's.

## Data exposure rules
Allowed: names, emails, ids, roles, counts, model ids, timestamps, spend totals, policy rules,
security event type/ip/metadata (already content-free by construction in `securityEventMetadata`).
Never returned: passwords, tokens, session tokens, API keys, secret ciphertext, OAuth tokens,
message or thread content, bot instructions, user agents, attachments. Contract output schemas
list fields explicitly; a test pins the user fields. The policy file holds rules only (no
credentials; the schema is strict).

## Deferred
- Suspend and resume a bot: done, see [suspend.md](./suspend.md).
- Editing: config editing in the UI, policy editing, role changes. Policy stays policy-as-code.
- Per-user disable (revoke plus block sign-in), user search and role filters.
- Admin roles (security admin, viewer) from the OIDC claim; today admin is all or nothing.
- Spend warnings (`warnAtPercent`), spend history charts, per-space budgets.
- Audit: filter by IP, export button on the page (the JSON Lines export route exists), organization
  audit log view alongside security events.
- Mobile admin UI, if ever needed.
