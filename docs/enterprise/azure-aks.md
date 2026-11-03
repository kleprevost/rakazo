# Azure reference deployment (AKS)

Bicep and plain Kubernetes manifests that run Rakazo on Azure Kubernetes Service with Key Vault,
Entra ID, Foundry and one Kata microVM per bot computer. One enterprise per install.

- `infra/azure/main.bicep` and `modules/`: AKS, Key Vault, PostgreSQL, managed identity, network, logs.
- `infra/azure/k8s/`: kustomize manifests (no Helm) using the published images.

It reuses existing settings only: the Kubernetes computer provider
([self-host-sandbox-providers.md](../self-host-sandbox-providers.md#kubernetes)), the Key Vault
options in [azure-key-vault.md](./azure-key-vault.md), OIDC in [entra-id.md](./entra-id.md) and
the Foundry variables in [inference.md](./inference.md).

## What Bicep creates

| Resource | Notes |
|---|---|
| AKS | OIDC issuer and workload identity on, Entra sign-in with Azure RBAC, local accounts disabled, Azure CNI overlay with Cilium network policy, managed NGINX ingress, Log Analytics container logs |
| `system` node pool | Azure Linux. Runs the API, worker, web and migration Job |
| `computers` node pool | Azure Linux, `workloadRuntime: KataVmIsolation`, autoscaled. Runs only bot computers |
| Key Vault | RBAC mode, soft delete and purge protection, RSA 3072 key `rakazo-master` |
| Managed identity | Secrets Officer on the vault, Crypto User on the key, federated to service accounts `rakazo-api` and `rakazo-worker` in namespace `rakazo` |
| PostgreSQL Flexible Server 16 | Private access in a delegated subnet, no public endpoint, password auth |
| Log Analytics | 90 day retention |

## Deploy

You need Owner (or Contributor plus User Access Administrator) on the resource group, `az`,
`kubectl`, and `kubelogin`.

```bash
az group create -n rakazo-rg -l <region>
export RAKAZO_POSTGRES_ADMIN_PASSWORD='<generated password>'
# Edit infra/azure/main.bicepparam first: prefix and the Entra admin group object id.
az deployment group create -g rakazo-rg -f infra/azure/main.bicep -p infra/azure/main.bicepparam
```

Note the outputs (`appIdentityClientId`, `keyVaultUrl`, `keyVaultKeyId`, `postgresHost`, `aksName`).
Then connect:

```bash
az aks get-credentials -g rakazo-rg -n <aksName>
kubelogin convert-kubeconfig -l azurecli
kubectl get runtimeclass
```

After applying the manifests, `kubectl get runtimeclass -o custom-columns=NAME:.metadata.name,HANDLER:.handler`
must show the Kata class AKS installed for the `computers` pool. `rakazo-kata` (from
`k8s/runtimeclass.yaml`) uses handler `kata`; if AKS's class shows a different handler, change it
in that file.

## Post-deploy

1. **Entra app.** Register it as in [entra-id.md](./entra-id.md) with redirect URI
   `https://<host>/api/auth/callback/oidc`.
2. **Configure.** Edit `infra/azure/k8s/kustomization.yaml`: the managed identity client id, host,
   Key Vault URL and key id, Entra tenant and client id, Foundry model and resource, and a pinned
   image tag. Edit the host and TLS secret name in `ingress.yaml`. The file lists every value to
   change; it contains placeholders only.
3. **Secrets.** Copy `k8s/secrets.example.yaml` outside the repository, fill in generated values and
   apply it after the namespaces exist: `kubectl apply -f k8s/namespaces.yaml`, then
   `kubectl apply -f <your copy>`. Create the `rakazo-tls` TLS secret in `rakazo`.
4. **Apply.** `kubectl apply -k infra/azure/k8s`. The `rakazo-migrate` Job creates the database
   schema and the `rakazo_app` login. A finished Job is removed after an hour; delete it before
   applying again (`kubectl -n rakazo delete job rakazo-migrate --ignore-not-found`) because a
   Job's pod template cannot change.
5. **DNS.** Point the host at the ingress address (`kubectl -n app-routing-system get svc`).
6. **Verify.** Sign in, create a bot and start its computer. `kubectl -n rakazo-sandboxes get pods
   -o wide` shows one pod per computer on a node of the `computers` pool.

## How bot computers are isolated

The Kubernetes provider creates one pod per computer in `rakazo-sandboxes` with
`runtimeClassName` from `KUBERNETES_SANDBOX_RUNTIME_CLASS_NAME`. The Kata runtime class makes the
node start each pod inside its own lightweight VM with a separate guest kernel, so a bot that
escapes its container still lands inside that VM, not on the node or beside another bot. The
provider cannot set node selectors or tolerations, so `rakazo-kata` carries them: the
`computers` pool is labelled `rakazo.io/pool=computers` and tainted
`rakazo.io/computers=true:NoSchedule`, and the class selects that label and tolerates that
taint. A bot pod can therefore only run on a Kata node, and no other pod can. Rakazo's own pods
are pinned to the system pool (`kubernetes.azure.com/mode: system`).

Around the VM, the namespace is locked down:

- The provider already creates pods with no service account token, no capabilities, privilege
  escalation off and the default seccomp profile.
- RBAC lets the API and worker create, get and delete pods and use `pods/exec` in
  `rakazo-sandboxes` only.
- `networkpolicy.yaml` denies all traffic to and from computer pods, then allows ingress from the
  API, worker and web pods on ports 6080 and 6100-6199, and egress to cluster DNS and to the public
  internet excluding private, shared and link-local ranges. That blocks the instance metadata
  endpoint `169.254.169.254`, nodes, other pods and the Kubernetes API server.
- `rakazo-sandboxes` enforces the Pod Security `baseline` level.

## Choices to know about

- **Shared data volume.** `DATA_DIR` is an Azure Files share (ReadWriteMany) so API and worker can
  both use it. To shrink it, keep bot homes in object storage
  ([self-host-storage.md](../self-host-storage.md#bot-homes-in-object-storage)).
- **Mounted bot homes** (`KUBERNETES_SANDBOX_HOME_CLAIM`) are not used: they need a ReadWriteOnce
  volume and pod affinity, which conflicts with the shared Azure Files claim.
- **Ingress.** AKS managed NGINX (`webapprouting.kubernetes.azure.com`). Another controller only
  needs a different `ingressClassName`. Only the web service is exposed; it proxies to the API.
- **Client addresses.** `TRUSTED_PROXIES` is the pod CIDR, so the API believes `X-Forwarded-For`
  from the ingress and web pods. Computer pods cannot reach the API. Narrow it if you change the pod CIDR.
- **PostgreSQL** has no public endpoint; only the cluster VNet reaches it. Key Vault keeps its public
  endpoint (RBAC and Entra only). Add a private endpoint if policy requires one.
- **Not included:** high availability for PostgreSQL, Key Vault private link, a bastion or jump
  host, backups beyond the Flexible Server's 14 day default, and cluster autoscaling of the system pool.

## What was validated

Offline only; nothing was deployed and no Azure subscription was used.

- `bicep lint` and `bicep build` on `main.bicep` and `bicep build-params` on `main.bicepparam`
  (Bicep CLI 0.48.1): no errors or warnings. This confirms property names against the Bicep types,
  including `workloadRuntime` on the node pool. The type accepts any string for its value, so
  `KataVmIsolation` was not checked against a type.
- `kustomize build infra/azure/k8s` and `kubeconform -strict` against Kubernetes 1.33 schemas:
  all 21 resources valid.
- Environment variable names were checked against the Kubernetes computer provider docs and the
  Compose file.

## Not verified

- Deployment, quotas, and VM size availability. The `computers` pool VM size must support nested
  virtualization in your region.
- The `KataVmIsolation` value, the Kata handler name `kata` in `rakazo-kata` (from memory of AKS's
  own class), that the taint and label apply to the pool as written, and Kata with Azure CNI
  overlay and Cilium. Older docs and API versions used `KataMshvVmIsolation` and
  AKS's class `kata-mshv-vm-isolation`.
- That Cilium enforces the `ipBlock` exceptions as intended for pod and node addresses. Test from a
  computer pod: `curl 169.254.169.254` and a pod IP must fail, a public site must work.
- Entra-specific settings, Azure Files uid mapping for the `node` user, TLS to PostgreSQL with
  `sslmode=require`, and the migrate Job creating `rakazo_app` as the Flexible Server admin.
- The image tag `edge` and that `/health` and the worker health check work with these probes.
- Workload identity token exchange and every item in the "Not verified" lists of
  [azure-key-vault.md](./azure-key-vault.md), [entra-id.md](./entra-id.md) and
  [inference.md](./inference.md).
