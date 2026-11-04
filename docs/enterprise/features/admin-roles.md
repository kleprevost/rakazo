# Operator roles

Splits the single deployment-admin gate (`requireAdmin`) into four roles, so a fleet operator
cannot revoke sessions or quarantine, a security admin cannot run fleet operations, and an
auditor can look but not change. Wave 4 item 1.

## Roles
| Role | Holds |
|---|---|
| `platform` | Everything. This is today's admin: nobody's access changes on upgrade. |
| `security` | Sessions and revocation, bot suspension and quarantine, audit log, capability grants and modes, users and bots views. |
| `fleet` | Computers, fleet operations, images (reads the policy for approved images). |
| `auditor` | Read-only: every view above, no mutation. |

Bot Manager is deferred. It is a per-bot scope (manage the bots you are assigned), not a
deployment-wide role, and needs an assignment model first. Until then bot owners keep owning
their bots, as today.

## Assignment: environment lists, not the policy file
Roles come from the environment, in the same two shapes admin already uses:

| Role | Email list | SSO claim values (`OIDC_ACCESS_CLAIM`) |
|---|---|---|
| `platform` | `RAKAZO_ADMIN_EMAILS` | `OIDC_ADMIN_VALUES` |
| `security` | `RAKAZO_SECURITY_EMAILS` | `OIDC_SECURITY_VALUES` |
| `fleet` | `RAKAZO_FLEET_EMAILS` | `OIDC_FLEET_VALUES` |
| `auditor` | `RAKAZO_AUDITOR_EMAILS` | `OIDC_AUDITOR_VALUES` |

Why not a `roles` section in the central policy file: policy is what the product may do, and is
meant to be reviewed and versioned apart from who operates it. Operator identity already lives
in the environment, works with Easy Auth and Entra app roles/groups through the existing claim
mapping, and needs no new policy schema or reload path. An account may hold several roles (list
it in several variables). Every role needs a verified email, and an SSO role follows the ID token
stored at the last sign-in, so it is revoked on the next sign-in or denial, like admin.

## Enforcement
`requireAdminRole(deps, userId, role | roles[])` in `apps/api/src/admins.ts` replaces
`requireAdmin`. `platform` always passes; any other caller needs one of the listed roles, or the
call is `FORBIDDEN` (never `NOT_FOUND`, so nothing is probed). `adminRoles()` computes the held
roles; `me.adminRoles` returns them and `me.isAdmin` stays the `platform` role.

## Procedure map
| Procedure | Roles (besides `platform`) |
|---|---|
| `admin.overview` | security, fleet, auditor |
| `admin.users.list` | security, auditor |
| `admin.users.endSessions` | security |
| `admin.bots.list` | security, auditor |
| `admin.bots.suspend`, `.resume` | security |
| `admin.quarantine.list` | security, auditor |
| `admin.quarantine.start`, `.lift` | security |
| `admin.computers.list`, `.get` | security, fleet, auditor |
| `admin.computers.quarantine`, `.release` | security |
| `admin.computers.operations.create` | fleet |
| `admin.computers.operations.list`, `.get` | security, fleet, auditor |
| `admin.policy` | security, fleet, auditor |
| `admin.audit` | security, auditor |
| `capabilityGrants.list` | security, auditor (and the bot's owner, as before) |
| `capabilityGrants.set`, `.revoke`, `.setMode` | security (owners keep their own grants) |
| `marketplace.submissions`, `.review`, MCP stdio servers, `accessGrants.*`, computer provider settings | platform only |

## Web
The Admin section opens for anyone holding a role. Its navigation lists only the sections the
roles allow, and write controls (end sessions, suspend, quarantine, fleet operations) are hidden
from roles that cannot use them. The server check is the real gate. No new copy.

## Tests
- `apps/api/src/admin-roles.test.ts`: every procedure against every role, unverified and
  non-admin accounts, and an install with only `RAKAZO_ADMIN_EMAILS`.
- `packages/testkit/src/authorization.test.ts`: the same matrix over HTTP against Postgres.
- Web: navigation and hidden actions per role. Auth: role values from a stored ID token.

## Not in this change
Runtime role editing, Bot Manager, per-role audit events, and splitting the plugin review
and stdio-MCP rights out of `platform`.
