# Deploy: Container Apps + one Docker VM (PoC)

Bicep for the layout designed in [aca-vm.md](./aca-vm.md), in `infra/azure/aca/`. Nothing here
has been deployed; see [Not verified](#not-verified). The AKS entry point (`infra/azure/main.bicep`)
is unchanged; the two share only `modules/postgres.bicep` and `modules/monitoring.bicep`.

```
 Browser --https/wss--> web (ACA, external) --https--> api (ACA, internal) --> Postgres (private)
                           |  screen/terminal                |  /computers/*        ^
                           +----------> VM :7091 supervisor <+                      |
                                          bot computers (Docker) ; worker --------- +
 /data: Azure Files Premium NFS (private endpoint) mounted on api and on the VM
```

## What gets created

| Resource | Notes |
|---|---|
| VNet | subnets `aca` (delegated `Microsoft.App/environments`, `/23`), `vm`, `private-endpoints`, `postgres` (delegated); one NAT gateway for `aca` and `vm` (static outbound IP, no public IP on the VM) |
| Container Apps environment | workload profiles (Consumption), VNet-integrated, logs to Log Analytics, NFS storage `data` |
| `web` app | external ingress, port 5173, min 1. The only public entry; proxies `/api`, `/rpc`, device websocket and `/novnc` |
| `api` app | internal ingress, port 3100, min 2, `/data` mounted. Probes: `/health` (startup, liveness), `/ready` (readiness) |
| `migrate` job | manual trigger, `pnpm db:deploy`; the only place `DATABASE_MIGRATION_URL` exists |
| Storage account | Premium FileStorage, NFS 4.1 share `data` (100 GiB), no public access, private endpoint + `privatelink.file` zone |
| Postgres Flexible Server | private access only (shared module) |
| Linux VM | Ubuntu 24.04 LTS, `Standard_D8s_v5`, no public IP, runs Docker, the supervisor, the bot computers and the worker |
| Log Analytics | ACA logs. The VM keeps Docker logs locally (`local` driver, 3 x 10 MB per container) |

The worker is on the VM, not ACA, because it needs a 50 minute shutdown drain (ACA caps the grace
period far lower). `web` does not mount `/data`; it keeps its asset archive on `EmptyDir`.

## Network rules

| From | To | Port | How enforced |
|---|---|---|---|
| Internet | web | 443 | ACA ingress (the only external ingress) |
| web | api | 443 | ACA internal ingress |
| ACA subnet | VM | **7091/tcp only** | NSG `allow-supervisor-from-aca` (priority 100) |
| any other VNet peer or the Internet | VM | none | NSG `deny-vnet-inbound`, `deny-internet-inbound` (priority 4000/4010) |
| api, VM | Azure Files | 2049 | private endpoint, no public access |
| api, VM | Postgres | 5432 | delegated private subnet |
| bot computers | public Internet only | any | `restrict-computer-egress.sh` (RFC1918, link-local, host dropped) plus drops of `168.63.129.16` and `169.254.169.254` (`rakazo-azure-egress.service`) |

There is no NSG on the ACA subnet (ACA needs specific platform rules there if you add one). No
inbound SSH is opened.

Admin access uses `az vm run-command invoke` (free, no extra subnet, needs the VM agent, output is
truncated at about 4 KB). Azure Bastion would need an `AzureBastionSubnet` and costs a fixed monthly
amount; add it only if you need an interactive shell.

## Prerequisites

1. **Entra app registration** per [entra-id.md](./entra-id.md): single tenant, app roles
   `Rakazo.User` / `Rakazo.Admin`, assignment required, a client secret. You need the tenant id, the
   client id and the secret. Redirect URIs are added after the first deployment.
2. **Foundry deployment** per [inference.md](./inference.md): the resource name, an API key and the
   model id (`piDefaultModel`). If the deployment name differs from the model id, set
   `azureOpenAiDeploymentNameMap`.
3. **Images** `ghcr.io/kleprevost/rakazo/app` and `ghcr.io/kleprevost/rakazo/computer`, published by
   CI at the tag you deploy (default `edge`). If the packages are private, set `ghcrUsername` and
   `ghcrToken` (read:packages); both ACA and the VM then log in to GHCR. The fork publishes both
   images (linux/amd64) from `.github/workflows/fork-images.yml` on every push to `main`, tagged
   `sha-<commit>` and `edge`. It is the fork's only CI: the maintainer disables the upstream
   workflows in the GitHub Actions UI instead of editing them.
4. Azure CLI with Bicep, an SSH key pair (`ssh-keygen -t ed25519`; only the public key is used, to
   satisfy the VM's login requirement), and a resource group in a region with `Standard_D8s_v5`
   and Premium Files.

## Deploy

Review `infra/azure/aca/main.bicepparam` (tenant, client, model, resource name), then:

```bash
export RAKAZO_POSTGRES_ADMIN_PASSWORD="$(openssl rand -hex 24)"
export RAKAZO_POSTGRES_APP_PASSWORD="$(openssl rand -hex 24)"
export RAKAZO_BETTER_AUTH_SECRET="$(openssl rand -hex 32)"
export RAKAZO_ENCRYPTION_KEY="$(openssl rand -hex 32)"
export RAKAZO_SCREEN_PROXY_SECRET="$(openssl rand -hex 32)"
export RAKAZO_SUPERVISOR_TOKEN="$(openssl rand -hex 32)"
export RAKAZO_OIDC_CLIENT_SECRET='<Entra client secret value>'
export RAKAZO_AZURE_OPENAI_API_KEY='<Foundry key>'
export RAKAZO_VM_SSH_PUBLIC_KEY="$(cat ~/.ssh/id_ed25519.pub)"

az group create -n rakazo-rg -l <region>
```

Keep the generated secrets: the encryption key cannot be recovered, and the secret values must not
contain `$` or quotes (the VM reads them from a Compose env file).

**Phase 1: infrastructure, VM and migrate job.** The API cannot start before migrations have
created the `rakazo_app` login, so web and api are created in phase 2.

```bash
az deployment group create -g rakazo-rg --parameters infra/azure/aca/main.bicepparam
```

Outputs include `webUrl`, `oidcRedirectUri`, `easyAuthRedirectUri`, `vmName` and `natPublicIp`.

Wait for the VM's cloud-init (Docker install, NFS mount, egress rules, images; a few minutes):

```bash
az vm run-command invoke -g rakazo-rg -n rakazo-docker --command-id RunShellScript \
  --scripts "cloud-init status --wait; docker ps --format '{{.Names}} {{.Status}}'; curl -s localhost:7091/health"
```

Run the migrations and check the result:

```bash
az containerapp job start -g rakazo-rg -n rakazo-migrate
az containerapp job execution list -g rakazo-rg -n rakazo-migrate -o table
```

Register the redirect URIs in the Entra app (Web platform): `oidcRedirectUri`
(`https://<web fqdn>/api/auth/callback/oidc`) and, if you use Easy Auth, `easyAuthRedirectUri`
(`https://<web fqdn>/.auth/login/aad/callback`).

**Phase 2: web and api.**

```bash
RAKAZO_DEPLOY_APPS=true az deployment group create -g rakazo-rg --parameters infra/azure/aca/main.bicepparam
```

Later deployments keep `RAKAZO_DEPLOY_APPS=true`. A VM cannot change its custom data in place, so
once the VM exists a redeploy that changes any VM-related value (a secret, the image tag, the
model) fails on the VM resource. Pass `deployVm=false` for those runs (in the param file) and update
the VM as below.

### Upgrading and changing values

- Image tag: change `imageTag` and redeploy for ACA (add `deployVm=false`), then on the VM
  `sudo bash /opt/rakazo/bootstrap.sh set-tag <tag>` through `az vm run-command`. Run the migrate job
  before the new api revision.
- Secrets or settings on the VM: edit `/etc/rakazo/vm.env` through `az vm run-command`, then
  `docker compose --env-file /etc/rakazo/vm.env -f /opt/rakazo/docker-compose.yml up -d`.
  Mind that api and worker must keep the same `ENCRYPTION_KEY` and `SANDBOX_SUPERVISOR_TOKEN`.

## Central policy file

`RAKAZO_POLICY_FILE=/data/policy.yaml` is set on api and worker. A missing or invalid file stops the
process, so the VM writes a starter policy (Azure models only, no user connections) to the share if
the file does not exist. Replace it with your own ([central-policy.md](./central-policy.md)):

```bash
az vm run-command invoke -g rakazo-rg -n rakazo-docker --command-id RunShellScript --scripts \
  "cat > /data/policy.yaml <<'EOF'
version: 1
models:
  allowProviders: [azure]
  allowModels: ['azure/gpt-*']
  allowUserConnections: false
EOF
chown 1000:1000 /data/policy.yaml
cd /opt/rakazo && docker compose --env-file /etc/rakazo/vm.env restart worker"
az containerapp revision restart -g rakazo-rg -n rakazo-api \
  --revision "$(az containerapp revision list -g rakazo-rg -n rakazo-api --query '[0].name' -o tsv)"
```

The policy is read once at startup, so both processes restart. Set `policyFile` to an empty string
to run without one.

The supervisor on the VM reads the same file (`/data` is mounted into it) for
`computers.images`: restart it too (`docker compose ... restart supervisor`) after changing the
approved images, or it keeps checking against the list it started with.

### Exposing more Foundry deployments

The starter policy (`allowProviders: [azure]`, `allowUserConnections: false`) keeps members off
their own credentials but still lists every Azure model the deployment serves. Azure serves only the
deployments you create, so the picker shows `piDefaultModel` plus each model id named in
`azureOpenAiDeploymentNameMap` (`<catalog model id>=<deployment name>,...`). Add the models, redeploy
the apps with `deployVm=false` and restart api and worker; see
[inference.md](./inference.md#organization-models). Use `allowModels` to offer only some of them.

## Easy Auth (optional)

`enableEasyAuth=true` configures the web app's Entra provider (token store on, unauthenticated
requests allowed, same app registration and client secret as OIDC) and sets `AUTH_EASY_AUTH=true` on
web and api (see [easy-auth.md](./easy-auth.md); it cannot be combined with `OIDC_REVALIDATE_MINUTES`). The
Easy Auth redirect URI must be registered as above.

## Smoke test

1. Open `webUrl`: the sign-in page shows the Microsoft button; sign in as a user with `Rakazo.User`.
   A user without a role is refused. The `Rakazo.Admin` user sees admin settings.
2. Create a bot and send a message: the model answers (Foundry via `PI_DEFAULT_PROVIDER=azure`).
3. Start a computer for the bot. Its screen appears in the UI and stays up for 10 minutes; the terminal
   opens. On the VM `docker ps` shows a `rakazo-c...` computer container.
4. From the computer's terminal, `curl -m 5 http://169.254.169.254/` and `curl -m 5 http://168.63.129.16/`
   fail, a private address such as the Postgres host fails, and a public site works.
5. A model outside the policy (for example an OpenAI-compatible user connection) is refused with
   "Blocked by your organization".
6. Set a budget on a user or bot and confirm a run past the limit is refused (budget enforcement is
   a separate workstream; skip until it is merged).
7. Files written in the bot home survive a computer restart (the home lives on the share) and a file
   uploaded through the UI is readable on the VM under `/data`.
8. Open the page for 10 minutes with an active chat: SSE and the device websocket reconnect cleanly
   (ACA ingress timeout).

## Risks and hardening

- **Secrets in custom data.** The VM's secrets (`DATABASE_URL`, `ENCRYPTION_KEY`, supervisor token,
  Foundry key, GHCR token) are rendered by Bicep into the VM's custom data, so they appear in the
  deployment record of the resource group, in the VM model for anyone who can read it, and in
  `/var/lib/cloud` on the VM (root only). Computers cannot reach the metadata service (egress rules),
  and the env file is `0600`. Acceptable for a PoC. Hardening: Key Vault plus a user-assigned managed
  identity on the VM, fetching the values at boot (the shape described in `aca-vm.md`), and
  Key Vault references on ACA ([azure-key-vault.md](./azure-key-vault.md)).
- **ACA secrets** hold the same values for web, api and the job. Rotate by redeploying.
- **Supervisor** is plain HTTP with a bearer token and owns the Docker socket: reachable only from
  the ACA subnet. Anything running in that subnet can try it.
- **Single VM.** One failure domain and a fixed capacity; set `SANDBOX_MAX_COMPUTERS_PER_USER` on api
  and worker for the VM size.
- Password sign-in stays on unless you add `AUTH_PASSWORD_ENABLED=false` to the api (not set here).

## Not verified

Nothing was deployed. `bicep lint` and `bicep build` pass, the cloud-init YAML and the Compose file
parse; that is all.

- ACA NFS mount support with a workload-profile environment, the `NfsAzureFile` volume type on API
  `2025-01-01`, uid 1000 ownership and `NoRootSquash` through the mount, and the `api` image user
  (`node`, uid 1000) writing to `/data`.
- Premium NFS with `supportsHttpsTrafficOnly: false` plus a private endpoint, and the VM mount
  options (`nconnect`, `x-systemd.automount`).
- Commands via `sh -c 'cd ... && exec ...'` on ACA (no working directory setting); signals reach the
  process because of `exec`.
- ACA outbound through the shared NAT gateway, and that the Envoy/web source addresses fall inside
  the ACA subnet for `TRUSTED_PROXIES`.
- Ingress timeouts for SSE, websocket and an open screen (about 4 minutes documented by ACA).
- Docker >= 28 from Docker's apt repository on Ubuntu 24.04 with the nftables-backed `iptables`
  shim and `restrict-computer-egress.sh` (it expects the iptables backend and the `DOCKER-USER`
  chain); the supervisor's own start-up probe will refuse computers if it is wrong.
- The supervisor in a container with no Compose `web` peer (isolated screens), and the
  `daemon.json` setting `userland-proxy: false` with the published port 7091.
- `TrustedLaunch` with the Ubuntu 24.04 image, `Standard_D8s_v5` quota, and the worker's 50 minute
  drain during a VM reboot or Azure maintenance.
- Easy Auth `authConfigs` shape and that `AllowAnonymous` leaves the app's own OIDC sign-in alone.
- The migrate job against the private Postgres from the job's replica, and `sslmode=require` URLs.
