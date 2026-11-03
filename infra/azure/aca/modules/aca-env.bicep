// Container Apps environment (workload profiles) integrated into the delegated subnet, logging to
// the shared Log Analytics workspace, with the NFS share registered as storage "data".
param name string
param location string
param subnetId string
param workspaceName string
param workloadProfileName string
param nfsServer string
param nfsSharePath string

resource workspace 'Microsoft.OperationalInsights/workspaces@2023-09-01' existing = {
  name: workspaceName
}

resource environment 'Microsoft.App/managedEnvironments@2025-01-01' = {
  name: name
  location: location
  properties: {
    vnetConfiguration: {
      infrastructureSubnetId: subnetId
      internal: false
    }
    workloadProfiles: [
      {
        name: workloadProfileName
        workloadProfileType: 'Consumption'
      }
    ]
    appLogsConfiguration: {
      destination: 'log-analytics'
      logAnalyticsConfiguration: {
        customerId: workspace.properties.customerId
        sharedKey: workspace.listKeys().primarySharedKey
      }
    }
  }
}

resource dataStorage 'Microsoft.App/managedEnvironments/storages@2025-01-01' = {
  parent: environment
  name: 'data'
  properties: {
    nfsAzureFile: {
      server: nfsServer
      shareName: nfsSharePath
      accessMode: 'ReadWrite'
    }
  }
}

output environmentId string = environment.id
output defaultDomain string = environment.properties.defaultDomain
output storageName string = dataStorage.name
