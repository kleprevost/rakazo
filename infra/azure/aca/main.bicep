// Rakazo on Azure Container Apps + one Docker VM (PoC). See docs/enterprise/aca-vm-deploy.md.
//
//   browser -> web (ACA, external) -> api (ACA, internal) -> Postgres Flexible Server (private)
//                         \-> VM :7091 supervisor -> bot computers      worker (VM) -> Postgres
//   /data: Azure Files Premium NFS, mounted on the api and on the VM, private endpoint only.
//
// Two phases (docs/enterprise/aca-vm-deploy.md): deploy with deployApps=false, run the migrate job,
// then deploy again with deployApps=true. Scope: a resource group. The AKS entry point is
// infra/azure/main.bicep; this one shares only its postgres and monitoring modules.
targetScope = 'resourceGroup'

@description('Short lowercase prefix for resource names (3-12 letters or digits).')
@minLength(3)
@maxLength(12)
param prefix string

param location string = resourceGroup().location

@description('Create the web and api apps. Leave false for the first deployment: the API cannot start before the migrate job has run.')
param deployApps bool = true

@description('Create the VM. Set to false on later deployments: a VM cannot change its custom data in place.')
param deployVm bool = true

// Images (published by CI to GHCR).
param appImage string = 'ghcr.io/kleprevost/rakazo/app'
param computerImage string = 'ghcr.io/kleprevost/rakazo/computer'
param imageTag string = 'edge'
@description('Only for private GHCR packages: a user and a token with read:packages.')
param ghcrUsername string = ''
@secure()
param ghcrToken string = ''

// Network.
param vnetAddressPrefix string = '10.20.0.0/16'
@description('Delegated to Microsoft.App/environments. Also the TRUSTED_PROXIES value.')
param acaSubnetPrefix string = '10.20.0.0/23'
param vmSubnetPrefix string = '10.20.4.0/27'
param privateEndpointSubnetPrefix string = '10.20.4.32/27'
param postgresSubnetPrefix string = '10.20.8.0/24'
param supervisorPort int = 7091

// Postgres.
param postgresAdminLogin string = 'rakazoadmin'
@secure()
param postgresAdminPassword string
@description('Password of the rakazo_app login that the migrate job creates.')
@secure()
param postgresAppPassword string
param postgresSkuName string = 'Standard_D2ds_v5'
param postgresStorageSizeGB int = 128

// VM.
param vmSize string = 'Standard_D8s_v5'
param vmOsDiskSizeGB int = 128
param vmAdminUsername string = 'rakazoadmin'
@description('SSH public key for the admin user. There is no inbound SSH; use az vm run-command.')
param vmAdminSshPublicKey string

// Shared /data.
param dataShareQuotaGiB int = 100

// Application secrets (generate with `openssl rand -hex 32`; no "$" or quotes).
@secure()
param betterAuthSecret string
@secure()
param encryptionKey string
@secure()
param screenProxySecret string
@secure()
param supervisorToken string

// Entra ID (docs/enterprise/entra-id.md).
param oidcTenantId string
param oidcClientId string
@secure()
param oidcClientSecret string
param oidcName string = 'Microsoft'
param oidcAccessClaim string = 'roles'
param oidcAllowedValues string = 'Rakazo.User,Rakazo.Admin'
param oidcAdminValues string = 'Rakazo.Admin'
param oidcRevalidateMinutes string = '60'
param oidcTrustEmail bool = true
@description('Add Easy Auth (Entra) in front of the web app, anonymous requests allowed. Needs the code that reads AUTH_EASY_AUTH (placeholder name).')
param enableEasyAuth bool = false
@description('Let people add their own instance of an AI employee shared with them (SHARED_EMPLOYEES_ENABLED on the API).')
param enableSharedEmployees bool = false

// Foundry (docs/enterprise/inference.md).
param piDefaultModel string
param azureOpenAiResourceName string
@secure()
param azureOpenAiApiKey string
@description('Optional: <model id>=<deployment name>,... when deployment names differ from model ids.')
param azureOpenAiDeploymentNameMap string = ''

// Central policy (docs/enterprise/central-policy.md): a file on the shared /data share.
@description('Path inside the containers. Empty disables the policy. A missing file stops the API and worker.')
param policyFile string = '/data/policy.yaml'
@description('Written to policyFile on the share by the VM when the file does not exist yet.')
param policySeed string = 'version: 1\nmodels:\n  allowProviders: [azure]\n  allowUserConnections: false\n'

param apiMinReplicas int = 2
param webMinReplicas int = 1

var unique = uniqueString(resourceGroup().id)
var workloadProfileName = 'Consumption'
// Azure reserves the first four addresses of a subnet; this is the fifth.
var vmPrivateIp = cidrHost(vmSubnetPrefix, 4)
var postgresDatabase = 'rakazo'

module monitoring '../modules/monitoring.bicep' = {
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
    acaSubnetPrefix: acaSubnetPrefix
    vmSubnetPrefix: vmSubnetPrefix
    privateEndpointSubnetPrefix: privateEndpointSubnetPrefix
    postgresSubnetPrefix: postgresSubnetPrefix
    supervisorPort: supervisorPort
  }
}

module postgres '../modules/postgres.bicep' = {
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
    databaseName: postgresDatabase
  }
}

module storage 'modules/storage.bicep' = {
  name: 'storage'
  params: {
    name: '${take(prefix, 10)}fs${take(unique, 8)}'
    location: location
    shareName: 'data'
    shareQuotaGiB: dataShareQuotaGiB
    subnetId: network.outputs.privateEndpointSubnetId
    privateDnsZoneId: network.outputs.fileZoneId
  }
}

module acaEnv 'modules/aca-env.bicep' = {
  name: 'aca-env'
  params: {
    name: '${prefix}-env'
    location: location
    subnetId: network.outputs.acaSubnetId
    workspaceName: '${prefix}-logs'
    workloadProfileName: workloadProfileName
    nfsServer: storage.outputs.server
    nfsSharePath: storage.outputs.sharePath
  }
  dependsOn: [monitoring]
}

// Same URLs everywhere; the owner login is only for the migrate job.
var appDatabaseUrl = 'postgres://rakazo_app:${uriComponent(postgresAppPassword)}@${postgres.outputs.host}:5432/${postgresDatabase}?sslmode=require'
var migrationDatabaseUrl = 'postgres://${postgresAdminLogin}:${uriComponent(postgresAdminPassword)}@${postgres.outputs.host}:5432/${postgresDatabase}?sslmode=require'

module apps 'modules/aca-apps.bicep' = {
  name: 'aca-apps'
  params: {
    location: location
    prefix: prefix
    environmentId: acaEnv.outputs.environmentId
    environmentDomain: acaEnv.outputs.defaultDomain
    workloadProfileName: workloadProfileName
    storageName: acaEnv.outputs.storageName
    deployApps: deployApps
    appImage: appImage
    imageTag: imageTag
    ghcrUsername: ghcrUsername
    ghcrToken: ghcrToken
    trustedProxies: acaSubnetPrefix
    supervisorUrl: 'http://${vmPrivateIp}:${supervisorPort}'
    policyFile: policyFile
    apiMinReplicas: apiMinReplicas
    webMinReplicas: webMinReplicas
    databaseUrl: appDatabaseUrl
    databaseMigrationUrl: migrationDatabaseUrl
    betterAuthSecret: betterAuthSecret
    encryptionKey: encryptionKey
    screenProxySecret: screenProxySecret
    supervisorToken: supervisorToken
    oidcClientSecret: oidcClientSecret
    azureOpenAiApiKey: azureOpenAiApiKey
    oidcTenantId: oidcTenantId
    oidcClientId: oidcClientId
    oidcName: oidcName
    oidcAccessClaim: oidcAccessClaim
    oidcAllowedValues: oidcAllowedValues
    oidcAdminValues: oidcAdminValues
    // Easy Auth sessions have no refresh token, so the API refuses both settings together.
    oidcRevalidateMinutes: enableEasyAuth ? '' : oidcRevalidateMinutes
    oidcTrustEmail: oidcTrustEmail
    piDefaultModel: piDefaultModel
    azureOpenAiResourceName: azureOpenAiResourceName
    azureOpenAiDeploymentNameMap: azureOpenAiDeploymentNameMap
    enableEasyAuth: enableEasyAuth
    enableSharedEmployees: enableSharedEmployees
  }
}

module vm 'modules/vm.bicep' = if (deployVm) {
  name: 'vm'
  params: {
    name: '${prefix}-docker'
    location: location
    subnetId: network.outputs.vmSubnetId
    privateIp: vmPrivateIp
    vmSize: vmSize
    osDiskSizeGB: vmOsDiskSizeGB
    adminUsername: vmAdminUsername
    adminSshPublicKey: vmAdminSshPublicKey
    nfsServer: storage.outputs.server
    nfsSharePath: storage.outputs.sharePath
    appImage: appImage
    computerImage: computerImage
    imageTag: imageTag
    ghcrUsername: ghcrUsername
    ghcrToken: ghcrToken
    databaseUrl: appDatabaseUrl
    encryptionKey: encryptionKey
    supervisorToken: supervisorToken
    azureOpenAiApiKey: azureOpenAiApiKey
    publicOrigin: apps.outputs.webUrl
    policyFile: policyFile
    policySeed: policySeed
    piDefaultModel: piDefaultModel
    azureOpenAiResourceName: azureOpenAiResourceName
    azureOpenAiDeploymentNameMap: azureOpenAiDeploymentNameMap
  }
}

// Register these in the Entra app registration (Web platform).
output webUrl string = apps.outputs.webUrl
output oidcRedirectUri string = '${apps.outputs.webUrl}/api/auth/callback/oidc'
output easyAuthRedirectUri string = '${apps.outputs.webUrl}/.auth/login/aad/callback'
output migrateJobName string = apps.outputs.migrateJobName
output vmName string = '${prefix}-docker'
output supervisorUrl string = 'http://${vmPrivateIp}:${supervisorPort}'
output dataShare string = '${storage.outputs.server}:${storage.outputs.sharePath}'
output postgresHost string = postgres.outputs.host
// Static outbound address of the ACA environment and the VM, for allow-lists.
output natPublicIp string = network.outputs.natPublicIp
