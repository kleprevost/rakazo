// Log Analytics workspace that receives AKS container and control-plane logs.
param name string
param location string

resource workspace 'Microsoft.OperationalInsights/workspaces@2023-09-01' = {
  name: name
  location: location
  properties: {
    sku: { name: 'PerGB2018' }
    retentionInDays: 90
  }
}

output workspaceId string = workspace.id
