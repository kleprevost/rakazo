// Rakazo on Azure: AKS, Key Vault, PostgreSQL Flexible Server, Log Analytics.
// Scope: a resource group. See docs/enterprise/azure-aks.md.
targetScope = 'resourceGroup'

@description('Short lowercase prefix for resource names (3-12 letters or digits).')
@minLength(3)
@maxLength(12)
param prefix string

param location string = resourceGroup().location

@description('Object ids of Entra groups that administer the cluster.')
param aksAdminGroupObjectIds array

@description('Kubernetes namespace of the API, worker and web pods; must match infra/azure/k8s.')
param kubernetesNamespace string = 'rakazo'

@description('Service accounts that receive the managed identity; must match infra/azure/k8s.')
param serviceAccounts array = ['rakazo-api', 'rakazo-worker']

param systemNodeVmSize string = 'Standard_D4s_v5'
param systemNodeCount int = 2

@description('Must support nested virtualization for Kata, such as the Dsv5 family.')
param computerNodeVmSize string = 'Standard_D8s_v5'
param computerNodeMinCount int = 1
param computerNodeMaxCount int = 5

param postgresAdminLogin string = 'rakazoadmin'
@secure()
param postgresAdminPassword string
param postgresSkuName string = 'Standard_D2ds_v5'
param postgresStorageSizeGB int = 128

param vnetAddressPrefix string = '10.20.0.0/16'
param aksSubnetPrefix string = '10.20.0.0/22'
param postgresSubnetPrefix string = '10.20.8.0/24'

var unique = uniqueString(resourceGroup().id)

module monitoring 'modules/monitoring.bicep' = {
  name: 'monitoring'
  params: {
    name: '${prefix}-logs'
    location: location
  }
}

module network 'modules/network.bicep' = {
  name: 'network'
  params: {
    name: '${prefix}-vnet'
    location: location
    vnetAddressPrefix: vnetAddressPrefix
    aksSubnetPrefix: aksSubnetPrefix
    postgresSubnetPrefix: postgresSubnetPrefix
  }
}

module aks 'modules/aks.bicep' = {
  name: 'aks'
  params: {
    name: '${prefix}-aks'
    location: location
    subnetId: network.outputs.aksSubnetId
    workspaceId: monitoring.outputs.workspaceId
    adminGroupObjectIds: aksAdminGroupObjectIds
    systemNodeVmSize: systemNodeVmSize
    systemNodeCount: systemNodeCount
    computerNodeVmSize: computerNodeVmSize
    computerNodeMinCount: computerNodeMinCount
    computerNodeMaxCount: computerNodeMaxCount
  }
}

module identity 'modules/identity.bicep' = {
  name: 'identity'
  params: {
    name: '${prefix}-app'
    location: location
    oidcIssuerUrl: aks.outputs.oidcIssuerUrl
    kubernetesNamespace: kubernetesNamespace
    serviceAccounts: serviceAccounts
  }
}

module keyVault 'modules/keyvault.bicep' = {
  name: 'keyvault'
  params: {
    name: '${prefix}-kv-${take(unique, 6)}'
    location: location
    tenantId: tenant().tenantId
    appPrincipalId: identity.outputs.principalId
  }
}

module postgres 'modules/postgres.bicep' = {
  name: 'postgres'
  params: {
    name: '${prefix}-pg-${take(unique, 6)}'
    location: location
    subnetId: network.outputs.postgresSubnetId
    privateDnsZoneId: network.outputs.postgresZoneId
    administratorLogin: postgresAdminLogin
    administratorPassword: postgresAdminPassword
    skuName: postgresSkuName
    storageSizeGB: postgresStorageSizeGB
    databaseName: 'rakazo'
  }
}

// Values for infra/azure/k8s/kustomization.yaml and the cluster secret.
output aksName string = aks.outputs.clusterName
output appIdentityClientId string = identity.outputs.clientId
output tenantId string = tenant().tenantId
output keyVaultUrl string = keyVault.outputs.vaultUrl
output keyVaultKeyId string = keyVault.outputs.keyId
output postgresHost string = postgres.outputs.host
