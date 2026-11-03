# PoC: Container Apps + one Docker VM (discovery)

Design only; nothing here is deployed or tested. Target: API, web and worker on Azure Container
Apps (ACA), Postgres Flexible Server, and one private Linux VM running the Docker computer supervisor
and the bot computers (`SANDBOX_PROVIDER=docker`). Entra and Foundry as in [entra-id.md](./entra-id.md)
and [inference.md](./inference.md); Key Vault optional ([azure-key-vault.md](./azure-key-vault.md)).

**Verdict: needs code changes.** Config alone cannot work, because the browser-facing screen and
terminal streams are proxied by the web process, which only reaches a computer on its Docker bridge
or loopback (section 2). Shared storage for bot homes also needs an NFS share (section 3).

```
 Browser --https/wss--> ACA ingress --> web (vite preview, /novnc proxy)
                                           | /api /rpc /device ws        | screen + terminal (http/ws)
                                           v                             v
                                       api (ACA, internal) --+-------> VM :7091 supervisor ---docker.sock---> computer containers
                                       worker (ACA, no ingress)-+            |  (per-bot bridge, :6080 noVNC, :7070 control)
                                           |                                  |
              Azure Files NFS /data  <-----+----------------------------------+  (same share mounted at /data on VM)
                                           v
                 Postgres Flexible (private)      Foundry / Entra / Key Vault (public endpoints or private link)
```

## 1. Supervisor and app

- API and worker are plain HTTP clients of the supervisor: `DockerSandboxProvider(supervisorUrl, token)`
  (`packages/adapters/src/docker-sandbox.ts:102-110`), URL from `SANDBOX_SUPERVISOR_URL`
  (`apps/api/src/env.ts:277`, `apps/worker/src/index.ts:167`; default `http://127.0.0.1:7091`).
- Endpoints, all under `/computers`: `POST /computers` (148), `GET|DELETE /:id` (361, 580),
  `POST /:id/exec` (194; answers NDJSON for long commands, read at 215-223), `/:id/browser` (244),
  `/:id/screen-mode` (272, 329), `/:id/terminal` (309), `/:id/input` (384), `/:id/observe` (397),
  `/:id/actions` (425), `GET|POST /:id/files` (469-504), `DELETE /:id/screen` (542), `POST /:id/stop` (566).
- Auth: `Authorization: Bearer SANDBOX_SUPERVISOR_TOKEN` plus `x-rakazo-space-id`/`bot-id` headers
  (`docker-sandbox.ts:132-142`); checked at `infra/sandboxes/supervisor/src/index.ts:205-216`. `/health`
  is open (203). No TLS and no WebSocket on the supervisor; it listens on `SUPERVISOR_HOST:SUPERVISOR_PORT`
  (1253-1255, compose sets `0.0.0.0:7091`, `docker-compose.images.yml:336-337`). Bodies are capped at
  1 MB, file writes at ~16 MB+ (147-167).
- Same-host assumptions: (a) home paths and the data dir (section 3); (b) it finds itself with
  `docker.getContainer($HOSTNAME)` (2055-2063), so it must run in a container with the default hostname
  or it behaves as a host-run supervisor; (c) in the compose layout it connects the `web` container of
  its Compose project to every computer bridge (1755-1795), which cannot cross hosts; (d) the supervisor
  owns the Docker socket, so it must run on the VM, never on ACA.

## 2. App to computer containers

- Callbacks: none. The computer env carries no API URL, only a control token
  (`computer-spec.ts:578-586`). Control (`:7070`) is called by the supervisor on the container IP
  (`index.ts:1584-1598`); that stays on the VM.
- Screen and terminal are the problem. The supervisor returns `screenUrl`/`terminalUrl` pointing at the
  computer's noVNC/websockify on container port 6080 (`screenPorts`, `packages/core/src/node/desktop-runtime.ts:56-67`;
  terminal uses the same port, `index.ts:1019`). The API seals that URL into an AES-GCM capability on the
  web origin (`apps/api/src/routes/computer.ts:698-808`, `packages/core/src/node/screen-capability.ts:81-117`).
  The web process (not the browser, not the API) opens the upstream HTTP/WebSocket
  (`apps/web/vite.config.ts:297`, `apps/web/src/screen-proxy.ts:110-121`), asks the API to authorize
  each request (`screen-proxy.ts:49-92`) and rechecks every second (`screen-capability.ts:10-16`).
- What URL is returned depends on `SANDBOX_SCREEN_NETWORK` (`computer-spec.ts:688-703`):
  `isolated` (compose default, `docker-compose.images.yml:345`) gives the container's bridge IP, reachable
  only because the supervisor attached `web` to that bridge; `published` (unset) gives
  `SANDBOX_SCREEN_HOST:<ephemeral port>`, but the publish is hardcoded to `HostIp 127.0.0.1`
  (`computer-spec.ts:487`), so `SANDBOX_SCREEN_HOST=<vm ip>` yields a URL nothing listens on.
  The proxy also only accepts plain-HTTP targets that are loopback/private IPs on ports >= 1024
  (`screen-capability.ts:234-238, 280-286`), so a VM private IP is acceptable once something listens there.
- Options (all need ACA to reach the VM on private IPs only; no public exposure either way):
  | Option | Change | Code? | Ports/NSG |
  |---|---|---|---|
  | A. Supervisor screen proxy (recommended) | Add an authenticated HTTP+WebSocket reverse proxy to `/computers/:id/novnc/*` in the supervisor (it can already reach every bridge); the Docker adapter returns that URL plus `headers: {authorization: Bearer ...}`. `ScreenSession.headers` exists for this and is sealed server-side (`adapter-kit/src/types.ts:147-153`, `screen-capability.ts:62-79`; unwrapped by `screen-proxy.ts:157-168`). | Supervisor + docker adapter | one port, 7091, same as control |
  | B. Publish on the VM private IP | Make `HostIp` configurable (`computer-spec.ts:487`) and use `SANDBOX_SCREEN_HOST=<vm ip>`; pin a host port range (Docker default 32768-60999) | Small supervisor change | NSG: ACA subnet -> VM range; every VM-local peer in the VNet can also try the ports, so the websockify token is the only gate |
  | C. Second `web` on the VM | Run the VM as a Compose project (supervisor + screen-only `web`), route `/novnc/*` to it with Front Door/App Gateway; it needs `SCREEN_PROXY_SECRET` and API reachability | None in Rakazo, extra edge service | edge -> VM 5173 |
  | D. Generic reverse proxy on the VM | Cannot work: upstream is per-container and dynamic | n/a | n/a |
  Use A; B is the fallback if A takes too long; C avoids code but adds Front Door and a second web.

## 3. Shared storage

- Required. The API creates the bot home on its own disk (`packages/adapters/src/computer-lifecycle.ts:395`)
  and the supervisor insists on `<its DATA_DIR>/homes/<botId>` (`index.ts:244-245, 1577-1582`) and
  bind-mounts it as `/home/rakazo` (`computer-spec.ts:497-517`). Docker computers "read and write the
  server's home directory" (`computer-workspace.ts:37-42`). A root supervisor never creates it (`index.ts:248-251`).
  `OBJECT_STORAGE_*` does not remove this: Docker computers still mount the cached home
  (`docs/self-host-storage.md:88-90, 118-122`).
- API and worker also share `DATA_DIR` for artifacts, staging and MCP packages unless object storage is set
  (`self-host-storage.md:8-10`; `app.yaml:5-16` is the AKS equivalent, 100Gi RWX).
- ACA needs an Azure Files share. SMB cannot preserve uid 1000 ownership or the `chown`/mode checks
  (`assertComputerHomeWritable`, `index.ts:348`), so use **Premium Files NFS 4.1** with a private endpoint,
  an ACA storage mount at `/data` on api and worker, and the same share mounted at `/data` on the VM with
  the supervisor started with `-v /data:/data` and `DATA_DIR=/data`. Replica-safe: AKS runs 2 replicas of
  each with one RWX volume (`app.yaml:24, 90`). Unverified: ACA NFS mount semantics and root squash.
  Also set `OBJECT_STORAGE_BUCKET` later to take artifacts off the share (not needed for the PoC).

## 4. ACA fit

| Process | ACA shape | Notes |
|---|---|---|
| web | external ingress, target 5173, min 1 | `vite preview` (`docker-compose.images.yml:544`). It is the only public entry: it proxies `/api`, `/rpc`, the device WebSocket and `/novnc` (`apps/web/src/api-proxy.ts:43-52`, `vite.config.ts:614`). Needs `API_PROXY_TARGET`, `RAKAZO_HOST`, `SCREEN_PROXY_SECRET` (`app.yaml:164-173`). Static hosting is not enough. Keep the archive dir on `EmptyDir` (`app.yaml:185-190`). |
| api | internal ingress, target 3100, min 2 | Several replicas are the supported layout (`app.yaml:24`). Probes: HTTP `/health` (`apps/api/src/health.ts:37`), `/ready` checks the DB (28). SSE sends a heartbeat every 20 s (`routes/shared.ts:158`). |
| worker | no ingress, min 1, never scale to zero | Graphile claims jobs in Postgres, so replicas are safe (`app.yaml:90`). ACA probes are HTTP/TCP only; the worker's check is an exec on a temp file (`worker/src/health.ts:5`, `app.yaml:117-123`), so no liveness probe. |
| migrate | ACA Job, manual trigger, run before each revision | `pnpm db:deploy` in `/app/apps/api`; only it gets `DATABASE_MIGRATION_URL` (`app.yaml:202-243`). |
| updater | drop | `infra/updater` drives Compose; ACA revisions replace it. |

- Ingress limits (unverified offline): ACA documents a ~4 minute HTTP request timeout, and the AKS
  Ingress sets 3600 s for the same streams (`ingress.yaml:12-14`). Heartbeats and client reconnect may
  suffice; test SSE, the device WebSocket and a screen held open for 10 minutes.
- Worker shutdown: compose waits 50 min for running jobs (`docker-compose.images.yml:505`,
  `JOB_DRAIN_TIMEOUT_MS` 45 min, `packages/adapters/src/wakeup.ts:205`), AKS 3000 s (`app.yaml:103`).
  ACA caps the grace period at 600 s (unverified), so a revision swap can interrupt long runs; they are
  locked for hours afterwards (compose comment, line 503). Mitigate with single-revision mode and
  deploys when idle, or run the worker on the VM.
- `TRUSTED_PROXIES`: the API sees the web replica, which appends the peer to `X-Forwarded-For`
  (`api-proxy.ts:38`); ACA's Envoy is in front of that. Set it to the ACA infrastructure subnet CIDR
  (as `kustomization.yaml:52` does for AKS); default `local-networks` is unverified on ACA
  (`docs/self-host-production.md:110-122`).
- Public origin: `BETTER_AUTH_URL`, `WEB_ORIGIN`, `API_URL`, `RAKAZO_HOST` = the web app's FQDN
  (default `<app>.<env>.<region>.azurecontainerapps.io` or a custom domain); the Entra redirect is
  `https://<host>/api/auth/callback/oidc` ([entra-id.md](./entra-id.md)).
- Restricted egress on the VM: `SANDBOX_COMPUTER_EGRESS=restricted` plus
  `restrict-computer-egress.sh` (`docs/self-host-docker-computers.md:35-83`) blocks all RFC1918, link-local
  and the host, so computers cannot reach Postgres, the supervisor port or 169.254.169.254
  (`restrict-computer-egress.sh:62-71`). Gap: Azure's `168.63.129.16` (DNS/WireServer) is a public
  address and is not blocked. Add `DOCKER-USER -i rakazo-c+ -d 168.63.129.16 -j DROP` in cloud-init.
  Docker >= 28 resolves via the host, otherwise set `SANDBOX_COMPUTER_DNS=1.1.1.1,1.0.0.1`
  (`self-host-docker-computers.md:85-96`).

## 5. Secrets and config

Derived from `docker-compose.images.yml:16-280, 401-576`, `kustomization.yaml:33-80`, `secrets.example.yaml`.
Set only what is used; the compose test requires every env var read in source to be passed in all Compose
files (`lessons.md:7`), but ACA is outside that test.

| Setting | api | worker | web | migrate | VM supervisor | Secret? |
|---|---|---|---|---|---|---|
| `DATABASE_URL` (rakazo_app, `sslmode=require`) | x | x | | x | | secret |
| `DATABASE_MIGRATION_URL` | | | | x | | secret |
| `BETTER_AUTH_SECRET` | x | | | | | secret |
| `ENCRYPTION_KEY` (+ `ENCRYPTION_MASTER_KEYS`) | x | x | | | | secret |
| `SCREEN_PROXY_SECRET` | x | | x | | | secret |
| `SANDBOX_SUPERVISOR_TOKEN` | x | x | | | x | secret |
| `OIDC_CLIENT_SECRET` | x | | | | | secret |
| `AZURE_OPENAI_API_KEY` (Foundry) | x | x | | | | secret |
| `SANDBOX_PROVIDER=docker`, `SANDBOX_SUPERVISOR_URL=http://<vm-ip>:7091` | x | x | | | | no |
| `BETTER_AUTH_URL`, `WEB_ORIGIN`, `API_URL`, `RAKAZO_HOST`, `TRUSTED_PROXIES`, `API_HOST=0.0.0.0` | x | | | | | no |
| `RAKAZO_HOST`, `API_PROXY_TARGET`, `NODE_ENV`, `RAYON_NUM_THREADS=4` | | | x | | | no |
| `OIDC_ISSUER/CLIENT_ID/NAME/ACCESS_CLAIM/ALLOWED_VALUES/ADMIN_VALUES` | x | | | | | no |
| `PI_DEFAULT_PROVIDER=azure`, `PI_DEFAULT_MODEL`, `AZURE_OPENAI_RESOURCE_NAME` | x | x | | | | no |
| `DATA_DIR=/data`, `WAKEUP_DRIVER=graphile`, `AGENT_RUNTIME=pi`, `CONTENT_ENCRYPTION=on`, `NODE_ENV` | x | x | | | `DATA_DIR`,`NODE_ENV` | no |
| Key Vault: `SECRET_STORE`, `AZURE_KEY_VAULT_URL`, `MASTER_KEY_PROVIDER`, `AZURE_KEY_VAULT_KEY_ID`, `AZURE_CLIENT_ID` | x | x | | | | no |
| Supervisor: `SUPERVISOR_HOST=0.0.0.0`, `DOCKER_SOCKET`, `RAKAZO_COMPUTER_IMAGE`, `SANDBOX_COMPUTER_EGRESS`, resource caps (`docker-compose.images.yml:332-348`) | | | | | x | no |

- Store the secrets as ACA secrets (`secretRef`) or Key Vault references on the app identity. Key Vault
  here means the app-level `SECRET_STORE`/key provider, which use `DefaultAzureCredential`
  (`azure-key-vault.md:4`); ACA's managed identity works if `AZURE_CLIENT_ID` is set for a user-assigned one.
- `SANDBOX_SUPERVISOR_TOKEN` lives on the VM too: cloud-init fetches it from Key Vault with the VM's
  identity rather than embedding it in custom data.

## Network and ports

| Source | Destination | Port / protocol | Purpose |
|---|---|---|---|
| Internet | web (ACA ingress) | 443 https/wss | UI, `/api`, `/rpc`, device ws, `/novnc` |
| web | api (internal ingress) | 443 https | proxy and screen authorization |
| api, worker | VM supervisor | 7091 http (bearer) | all `/computers/*` calls, exec streams |
| web | VM supervisor | 7091 http/ws (option A) | screen and terminal streams |
| web | VM published range | 32768-60999 tcp (option B only) | noVNC |
| api, worker, migrate | Postgres | 5432 tcp tls | database |
| api, worker | Azure Files | 2049 nfs (private endpoint) | `/data` |
| VM | Azure Files | 2049 nfs | `/data` |
| api, worker | Foundry, Entra, Key Vault | 443 https | inference, OIDC, secrets |
| VM | GHCR (or ACR) | 443 https | app image (supervisor), computer image |
| computer containers | public internet only | any | browsing; private ranges dropped by the egress rules |
| computers | anything on the VNet | none | blocked by `restrict-computer-egress.sh` |

NSG on the VM subnet: allow 7091 from the ACA infrastructure subnet only; deny inbound from the internet;
SSH via Bastion or none.

## 6. Gaps and risks, ranked

1. **Screen/terminal reachability (code).** Section 2 option A (or B). Blocks the core "watch the computer" flow.
2. **Shared `/data` over NFS (infra + unverified).** Needs a Premium Files NFS share on ACA and the VM; ownership
   (uid 1000, `chown`) and the bind mount through a NFS path are untested.
3. **Worker drain and probes on ACA (config).** 600 s grace versus 45 min of job drain; no exec probe.
   Consider the worker on the VM for the PoC.
4. **Egress on Azure (config).** Add the 168.63.129.16 drop; confirm DNS on the Docker version in use.
5. **Ingress timeouts for SSE/ws (unverified).** Needs a live test.
6. **Supervisor is plain HTTP with a static bearer token, and Docker socket access is host control.** Restrict by
   NSG and subnet; consider mTLS or a private-link proxy later. The bearer token is also sealed into screen
   capabilities under option A; that capability is AES-GCM encrypted, still treat as sensitive.
7. **Single VM, single point of failure and capacity.** Caps: `SANDBOX_MAX_COMPUTERS_PER_USER`, `_PER_SPACE`.
8. **Not verifiable offline:** ACA NFS mounts, ACA `terminationGracePeriodSeconds`, Envoy source IPs for
   `TRUSTED_PROXIES`, managed identity with `DefaultAzureCredential` in ACA, Docker/iptables on the chosen VM image.

## Proposed Bicep (follow-up; reuse `infra/azure/modules/*`)

Reuse as is: `monitoring.bicep` (workspace), `postgres.bicep` (needs a delegated subnet for ACA too),
`keyvault.bicep` (pass the new identity's principal id). Adapt: `network.bicep` (drop the AKS subnet, add
`aca` delegated to `Microsoft.App/environments` /27+, `vm`, private-endpoint subnet, NSGs, `privatelink.file`
zone); `identity.bicep` (without the AKS federation, or a variant). New:
- `storage.bicep`: Premium FileStorage account, NFS share, private endpoint.
- `aca-env.bicep`: workload-profiles environment on the `aca` subnet, Log Analytics, storage definition.
- `aca-apps.bicep`: `web`, `api`, `worker`, `migrate` job with secrets and env from section 5.
- `vm.bicep`: NIC, Ubuntu LTS VM (no public IP), user-assigned identity (Key Vault get, Files access), cloud-init.
- `main-aca.bicep` + param file that wires them and outputs the FQDN for the Entra redirect URI.

## VM bootstrap (cloud-init outline)

1. Install Docker Engine >= 28 (iptables backend), enable the service; mount the NFS share at `/data`.
2. Fetch `SANDBOX_SUPERVISOR_TOKEN` from Key Vault with the VM identity into a root-only env file.
3. Pull the app image and the computer image (`RAKAZO_COMPUTER_IMAGE:TAG`; the supervisor only pulls
   registry-qualified images, `computer-image.ts:37-45`).
4. Run `restrict-computer-egress.sh` (as a systemd oneshot) plus the 168.63.129.16 drop; set
   `SANDBOX_COMPUTER_EGRESS=restricted`.
5. Start the supervisor: `docker run -d --restart unless-stopped --user root -p 7091:7091
   -v /var/run/docker.sock:/var/run/docker.sock -v /data:/data -e SUPERVISOR_HOST=0.0.0.0 -e DATA_DIR=/data
   -e SANDBOX_SCREEN_NETWORK=... --env-file ... <app image> pnpm --filter @rakazo/sandbox-supervisor start`
   (as in `docker-compose.images.yml:322-376`; the screen network mode follows the option chosen in section 2).
6. Health check `GET :7091/health`; NSG as above.

## Decisions needed

1. Screen path: A (supervisor proxy), B (publish on private IP), or C (Front Door + second web)?
2. Worker location: ACA (accept the 600 s drain limit) or on the VM next to the supervisor?
3. `/data`: Premium NFS share (recommended), or move homes and artifacts to object storage and accept
   the cache requirement (still needs a share between VM and ACA for homes)?
4. Secrets: ACA secrets for the PoC, or Key Vault references from day one?
5. Custom domain and certificate now, or the default `azurecontainerapps.io` FQDN for the PoC?
6. VM size and the per-space/user computer caps; ACR mirror versus GHCR from the VM.
