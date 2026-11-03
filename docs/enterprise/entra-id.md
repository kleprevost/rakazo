# Microsoft Entra ID sign-in

Rakazo's generic OpenID Connect SSO works with Microsoft Entra ID. This guide registers a
single-tenant app and restricts sign-in to users assigned an app role. General settings are in
[self-host-accounts.md](../self-host-accounts.md#openid-connect-sso).

## Register the app

1. In the Entra admin center, open **App registrations** and choose **New registration**.
2. Supported account types: **Accounts in this organizational directory only** (single tenant).
3. Redirect URI, platform **Web**: `https://<host>/api/auth/callback/oidc`, where `<host>` is
   your public `BETTER_AUTH_URL` host.
4. Under **Certificates & secrets**, create a client secret and copy its value.
5. Under **Overview**, copy the Application (client) ID and Directory (tenant) ID.

Single-tenant restriction needs no extra check. The issuer is
`https://login.microsoftonline.com/<tenant-id>/v2.0`, which contains the tenant ID, and Rakazo
requires every ID token's `iss` to equal the configured issuer exactly. A token from another
tenant carries that tenant's issuer and is rejected.

## App roles

Use app roles rather than groups. Entra leaves the `groups` claim out of a token when the user
belongs to too many groups (over 200 in a JWT), which would deny that user. The `roles` claim
has no such limit.

1. In the app registration, open **App roles** and create roles for **Users/Groups** with the
   values `Rakazo.User` and `Rakazo.Admin` (values cannot contain spaces).
2. In **Enterprise applications**, open the same app, then **Properties**, and set
   **Assignment required** to Yes.
3. Under **Users and groups**, assign people or groups to a role.

Entra includes the `roles` claim in tokens for users assigned an app role, so no further token
configuration should be needed.

## Configure Rakazo

```env
OIDC_ISSUER=https://login.microsoftonline.com/<tenant-id>/v2.0
OIDC_CLIENT_ID=<application-client-id>
OIDC_CLIENT_SECRET=<client-secret-value>
OIDC_NAME=Microsoft
OIDC_ACCESS_CLAIM=roles
OIDC_ALLOWED_VALUES=Rakazo.User,Rakazo.Admin
OIDC_ADMIN_VALUES=Rakazo.Admin
OIDC_REVALIDATE_MINUTES=60
```

`OIDC_REVALIDATE_MINUTES` is optional but recommended for enterprises (see Revocation below).

Verified-email handling is unchanged. Entra's ID token normally has no `email_verified` claim,
so an SSO account may stay unverified, and admin (from `RAKAZO_ADMIN_EMAILS` or
`OIDC_ADMIN_VALUES`) still requires a verified email. Verify the address through email delivery
before expecting an SSO admin to take effect. The `email` claim is optional in Entra and needs
the `email` scope and a mailbox on the user.

## Behavior

- Sign-in and linking are denied unless the configured claim is an array containing an allowed
  value. A missing, empty, non-array or non-string claim is denied.
- The check runs on every SSO sign-in. A removed role blocks the user's next sign-in. Without
  `OIDC_REVALIDATE_MINUTES`, existing sessions last until they expire or are revoked.
- Admin is derived from the ID token stored at the user's last sign-in, so it needs no database
  column. It is revoked on the next sign-in once the admin value is gone, and immediately after a
  denied sign-in. Admins named in `RAKAZO_ADMIN_EMAILS` are unaffected.

## Revocation

With `OIDC_REVALIDATE_MINUTES` set, the API refreshes each signed-in user's token against Entra
on that interval. A user who is disabled or deleted, whose refresh token is revoked, or who no
longer holds an allowed app role loses all Rakazo sessions on every device; losing only
`Rakazo.Admin` removes SSO admin immediately. 60 is a reasonable interval: revocation then lands
within about an hour. Mechanics and failure handling are in
[self-host-accounts.md](../self-host-accounts.md#revalidating-signed-in-users).

- Rakazo requests `offline_access` automatically, so Entra issues a refresh token. Without one
  the user is signed out after one interval. Users who signed in before enabling this are signed
  out once and sign in again.
- Entra is documented to revoke a user's refresh tokens when the account is disabled, and to
  refuse a refresh for a disabled or deleted user with `invalid_grant`. Not verified against a real
  tenant. An access-token lifetime does not matter here, because Rakazo ends sessions itself.
- Removing an app role from a user is only seen when the refreshed ID token omits it; Entra
  issues new tokens with current assignments.
- SCIM provisioning, where Entra pushes deprovisioning, could replace the polling later. It is
  not implemented.

## Not verified

Written from Entra's documented behavior and tested offline with simulated ID tokens only. Not
verified against a real tenant: the portal steps and wording, the `roles` claim in live tokens,
guest users, and the `email` claim. Also unverified: that a refresh request for a disabled user
returns `invalid_grant`, that a removed app role disappears from the refreshed ID token, and that
the refresh response includes an ID token.
