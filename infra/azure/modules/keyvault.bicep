// Key Vault (Azure RBAC, purge protection), the RSA key for MASTER_KEY_PROVIDER=azure-key-vault,
// and the roles docs/enterprise/azure-key-vault.md requires for the app identity.
param name string
param location string
param tenantId string
param appPrincipalId string

// Built-in role definition ids.
var secretsOfficerRoleId = 'b86a8fe4-44ce-4948-aee5-eccb2c155cd7'
var cryptoUserRoleId = '12338af0-0e69-4776-bea7-57ae8d297424'

resource vault 'Microsoft.KeyVault/vaults@2024-11-01' = {
  name: name
  location: location
  properties: {
    tenantId: tenantId
    sku: {
      family: 'A'
      name: 'standard'
    }
    enableRbacAuthorization: true
    enableSoftDelete: true
    softDeleteRetentionInDays: 90
    enablePurgeProtection: true
  }
}

resource masterKey 'Microsoft.KeyVault/vaults/keys@2024-11-01' = {
  parent: vault
  name: 'rakazo-master'
  properties: {
    kty: 'RSA'
    keySize: 3072
    keyOps: ['wrapKey', 'unwrapKey']
  }
}

// Secrets: set, get, delete and purge. Secrets User is not enough because Rakazo writes secrets.
resource secretsOfficer 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: vault
  name: guid(vault.id, appPrincipalId, secretsOfficerRoleId)
  properties: {
    principalId: appPrincipalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', secretsOfficerRoleId)
  }
}

// Keys: wrap and unwrap on the one key; the private key cannot be read or exported.
resource cryptoUser 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: masterKey
  name: guid(masterKey.id, appPrincipalId, cryptoUserRoleId)
  properties: {
    principalId: appPrincipalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', cryptoUserRoleId)
  }
}

output vaultUrl string = vault.properties.vaultUri
// Includes the version, as AZURE_KEY_VAULT_KEY_ID requires.
output keyId string = masterKey.properties.keyUriWithVersion
