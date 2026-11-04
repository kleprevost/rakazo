# Sign-in behind Azure built-in authentication (Easy Auth)

Azure App Service and Container Apps can authenticate browsers before a request reaches the app
("Easy Auth"). With `AUTH_EASY_AUTH=true`, Rakazo accepts that sign-in instead of redirecting the
browser through its own OpenID Connect flow. Rakazo still owns sessions, the claim allow-list,
SSO admin, trusted email, central policy and budgets; Easy Auth only proves who the browser is.
This builds on [entra-id.md](entra-id.md), which describes the Entra app registration and app
roles.

## Configure Azure

1. Use the Entra app registration from [entra-id.md](entra-id.md). Add the platform's callback as a
   second **Web** redirect URI: `https://<host>/.auth/login/aad/callback`. Keep
   `https://<host>/api/auth/callback/oidc`, which mobile and desktop still use.
2. On the web app or container app, open **Authentication** and add the **Microsoft** provider with
   that app registration. Set the issuer URL to the v2.0 endpoint,
   `https://login.microsoftonline.com/<tenant-id>/v2.0`, so the forwarded token's `iss` equals
   `OIDC_ISSUER` exactly. With the default v1 issuer (`https://sts.windows.net/...`) every token is
   rejected.
3. Set **Restrict access** to **Allow unauthenticated access**. Rakazo requires its own session
   everywhere, and native apps, bot webhooks and billing webhooks must reach the API without a
   browser login. Do not use "Require authentication": native clients would be redirected to a
   login page.
4. Turn the **token store** on (`authsettingsV2` `login.tokenStore.enabled`). Rakazo verifies the
   ID token the platform forwards in `X-MS-TOKEN-AAD-ID-TOKEN`; without the store there is no token
   and nobody can sign in this way.
5. Serve the web app and the API from the same origin behind the same authentication, so the
   browser's API calls carry the headers. Do not exclude `/api/*` or `/rpc/*` from authentication.
   `/.auth/*` is handled by the platform and never reaches Rakazo.
6. Set `TRUSTED_PROXIES` as in [azure-aks.md](azure-aks.md) or
   [self-host-production.md](../self-host-production.md#client-addresses) so session records and
   rate limits see the client address.

## Configure Rakazo

```env
AUTH_EASY_AUTH=true
OIDC_ISSUER=https://login.microsoftonline.com/<tenant-id>/v2.0
OIDC_CLIENT_ID=<application-client-id>
OIDC_CLIENT_SECRET=<client-secret-value>
OIDC_NAME=Microsoft
OIDC_ACCESS_CLAIM=roles
OIDC_ALLOWED_VALUES=Rakazo.User,Rakazo.Admin
OIDC_ADMIN_VALUES=Rakazo.Admin
OIDC_TRUST_EMAIL=true
```

The narrower operator roles work the same way: add `OIDC_SECURITY_VALUES`, `OIDC_FLEET_VALUES`
or `OIDC_AUDITOR_VALUES` (see [admin roles](features/admin-roles.md)).

`OIDC_ISSUER` and `OIDC_CLIENT_ID` must name the same app registration Easy Auth uses; the token's
audience is checked against the client ID. The client secret stays required because mobile and
desktop still sign in with the built-in OIDC flow and need it. `AUTH_EASY_AUTH` cannot be combined
with `OIDC_REVALIDATE_MINUTES` (see Limitations). The web sign-in screen then sends the SSO button
to `/.auth/login/aad`, and signing out also visits `/.auth/logout`. The button label is
`OIDC_NAME`, as before.

## What happens on a request

The API checks every request that carries the platform's token or a cookie, before any session is
read (RPC, streams, HTTP routes and the auth handler all see the result).

- **Verified identity, no session.** Rakazo creates a session for the person and sets the session
  cookie. The account is the same `oidc` account the redirect flow uses (subject `sub`, scoped to
  the issuer), so a person who signed in either way is the same user. New users follow the OIDC
  sign-up rules: signup policy, email allow-list, `OIDC_ALLOW_SIGNUP_BYPASS`, and verified email
  (`OIDC_TRUST_EMAIL`). An existing account is never linked by email address. An ID token without
  an `email` claim cannot sign in.
- **Claim allow-list.** `OIDC_ALLOWED_VALUES` is applied to the verified token on every request.
  A denied identity gets no session, its bound session is ended, and its stored ID token is
  cleared so it stops granting admin.
- **Admin.** The verified ID token is stored (sealed) on the account whenever it changes, so
  `OIDC_ADMIN_VALUES` (and the security, fleet and auditor values) follow the token the platform
  currently forwards.
- **Different person.** If the verified subject differs from the one the session was created for,
  the old session is ended and a new one is created.
- **Identity gone.** A session created from Easy Auth is bound to it. A browser request that no
  longer carries a valid identity (signed out of the platform, token expired, token invalid) ends
  that session.
- **Native sessions are untouched.** Requests with `Authorization: Bearer` are ignored by this
  pass. A session created by the built-in OIDC flow, a password or a code carries no binding and
  is never ended because headers are missing.

## Security model

Easy Auth headers are only trustworthy when the platform is the only thing that can set them. With
"Allow unauthenticated access" a client can send any `X-MS-CLIENT-PRINCIPAL*` header itself, and
a deployment can also be reached around the platform (another route, a sidecar, a misconfigured
ingress). So Rakazo never acts on those headers alone:

- `X-MS-TOKEN-AAD-ID-TOKEN` must be a JWT whose signature verifies against the issuer's published
  keys, with `iss` equal to `OIDC_ISSUER`, `aud` equal to `OIDC_CLIENT_ID`, and a present, unexpired
  `exp` (one minute of clock skew). Discovery and keys are cached like OIDC revalidation does.
- If `X-MS-CLIENT-PRINCIPAL` is also present it must agree with the token's `sub` (and `oid`,
  when the token has one), or the request is treated as unauthenticated. The header is otherwise
  unused.
- The token proves who the browser is, not that it came through Azure. A stolen valid ID token is
  as good as one sent through the platform until it expires, as with any bearer token.
- If the issuer's keys cannot be reached, nothing is known about the request: Rakazo does not
  create or end any session and hides the Easy Auth session from that request. It recovers on the
  next request.
- Sessions are bound with a marker stored next to the session (no migration). Bearer and native
  sessions never receive one.

## Limitations

- **Mobile and desktop.** They keep the built-in OIDC flow and cannot use Easy Auth, so the app
  registration needs both redirect URIs and the client secret.
- **Lifetime and revocation.** The stored ID token usually expires after about an hour. The web
  app calls `/.auth/refresh` every 30 minutes (and when a tab regains focus after that long), so
  sessions stay up while the user can still get tokens. This needs `offline_access` in the Entra
  provider's login scopes (`loginParameters: ["scope=openid profile email offline_access"]`; the
  Container Apps Bicep sets it). If a refresh fails, for example because the user was disabled in
  Entra, the token expires, Rakazo ends the session and the person lands on the sign-in screen.
  Revocation for browsers is therefore bounded by roughly the ID token lifetime.
- **No refresh-token revalidation.** `OIDC_REVALIDATE_MINUTES` is rejected in this mode: Easy Auth
  sessions hold no refresh token, so the revalidator would end them. Disabling a user in Entra
  stops new tokens, not tokens already issued, and does not end native sessions.
- **Concurrent first requests** in one API process share one session. Across several API
  instances a burst can create a spare session that expires unused.
- Sign-in with a different `sub` for the same person (a different app registration) is a different
  account, as with the redirect flow.

## Not verified

Written from Microsoft's documented Easy Auth behavior and tested offline with simulated Entra
tokens and a fake key set (real RS256 signatures). Not verified against real Azure: that
`X-MS-TOKEN-AAD-ID-TOKEN` carries the `sub`, `email` and `roles` claims as assumed, the exact
claim types in `X-MS-CLIENT-PRINCIPAL`, the v2.0 issuer setting, the `/.auth/login` and
`/.auth/logout` redirect parameters, the ID token lifetime in the store, and behavior with guest
users. The web client changes are covered by unit tests only.
