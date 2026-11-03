# Azure Key Vault

Rakazo can keep credentials in Azure Key Vault secrets and wrap content keys with a Key Vault key.
Both authenticate with `DefaultAzureCredential`, so AKS workload identity and managed identity work
without any secret in Rakazo's configuration. The Azure SDK packages load only when one of the
options below is selected.

## Configuration

| Variable | Purpose |
|---|---|
| `SECRET_STORE=azure-key-vault` | Store credentials as Key Vault secrets. |
| `AZURE_KEY_VAULT_URL` | Vault URL, for example `https://name.vault.azure.net`. |
| `MASTER_KEY_PROVIDER=azure-key-vault` | Wrap content keys with a Key Vault key. |
| `AZURE_KEY_VAULT_KEY_ID` | Full key identifier including version: `https://name.vault.azure.net/keys/<key>/<version>`. A version is required so a new key version cannot be swapped in unnoticed. |
| `AZURE_CLIENT_ID`, `AZURE_TENANT_ID` | Read by the Azure SDK, not by Rakazo, and not passed through the Compose files. Workload identity injects them on AKS. |

API and worker must share the same values. The two features are independent, and the key may live in a
different vault than the secrets because the key id carries its own vault.

Secrets are named `rakazo-<24 hex of the record digest>-<uuid>` (Key Vault allows only letters,
digits and hyphens), and refs are `azure-key-vault:v1:<name>`. Every write uses a fresh name, so a
soft-deleted secret never blocks a later write. Deleting a secret deletes it and then tries to purge it.

Keys: use an RSA key (2048 bits or more). Space keys are wrapped with RSA-OAEP-256. RSA-OAEP has no
associated data, so the space id and key version are wrapped together with the data key and checked on
unwrap. To rotate, create a new key version, point `AZURE_KEY_VAULT_KEY_ID` at it, and run
`content-encryption rotate`; keys wrapped by earlier versions in the same vault keep unwrapping.

## RBAC (Azure RBAC permission model)

Grant the Rakazo identity, scoped to the vault (or the individual key):

- Secrets: `Key Vault Secrets Officer`. It covers set, get, delete and purge. `Key Vault Secrets User`
  is not enough because Rakazo writes secrets.
- Keys: `Key Vault Crypto User` on the key (wrap and unwrap). It cannot read or export the private key.

If the vault has purge protection enabled or the identity lacks purge, purging is refused; Rakazo
logs a warning and continues, and deleted secrets stay recoverable until retention ends. Vaults using access policies instead of RBAC need get, set, delete and purge on
secrets and wrapKey and unwrapKey on keys.

## Workload identity on AKS

1. Enable the OIDC issuer and workload identity on the cluster
   (`az aks update --enable-oidc-issuer --enable-workload-identity`).
2. Create a user-assigned managed identity and assign the roles above.
3. Create a federated credential on the identity for the cluster issuer and the subject
   `system:serviceaccount:<namespace>:<service-account>`.
4. Annotate the service account used by the API and worker with
   `azure.workload.identity/client-id: <identity client id>` and label their pods with
   `azure.workload.identity/use: "true"`.
5. Set the variables above in the pods' environment. The webhook adds `AZURE_CLIENT_ID`,
   `AZURE_TENANT_ID`, `AZURE_FEDERATED_TOKEN_FILE` and `AZURE_AUTHORITY_HOST`.

On a VM or App Service with a system-assigned managed identity no extra variables are needed.

## Limits

- The legacy-secret upgrade leaves Azure refs untouched, but the migration to and from a remote store
  only knows Infisical. Moving existing secrets into or out of Key Vault is not supported yet.
- Reads are cached for 30 seconds per process. Key Vault throttles per vault, so keep that in mind
  for very large installs.

## Not verified against real Azure

Everything here was tested offline against fakes that follow the documented Key Vault behaviour
(name rules, soft-delete conflicts, RSA-OAEP-256). Not yet checked against a real vault:

- `DefaultAzureCredential` token acquisition under AKS workload identity and managed identity.
- The exact status codes for purge on a purge-protected vault and for reading a soft-deleted secret.
- The RBAC role sets above, in particular that Secrets Officer includes purge in your tenant.
- Behaviour under Key Vault throttling (HTTP 429), which relies on the SDK's built-in retry.
- Managed HSM and non-RSA keys.
