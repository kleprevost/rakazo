// One VNet: a subnet for AKS nodes and a delegated subnet for PostgreSQL private access.
param name string
param location string
param vnetAddressPrefix string
param aksSubnetPrefix string
param postgresSubnetPrefix string

resource vnet 'Microsoft.Network/virtualNetworks@2024-05-01' = {
  name: name
  location: location
  properties: {
    addressSpace: { addressPrefixes: [vnetAddressPrefix] }
    subnets: [
      {
        name: 'aks'
        properties: { addressPrefix: aksSubnetPrefix }
      }
      {
        name: 'postgres'
        properties: {
          addressPrefix: postgresSubnetPrefix
          delegations: [
            {
              name: 'postgres-flexible'
              properties: { serviceName: 'Microsoft.DBforPostgreSQL/flexibleServers' }
            }
          ]
        }
      }
    ]
  }
}

// Private DNS zone for the Flexible Server. The name must end in .postgres.database.azure.com.
resource postgresZone 'Microsoft.Network/privateDnsZones@2024-06-01' = {
  name: '${name}.private.postgres.database.azure.com'
  location: 'global'
}

resource postgresZoneLink 'Microsoft.Network/privateDnsZones/virtualNetworkLinks@2024-06-01' = {
  parent: postgresZone
  name: '${name}-link'
  location: 'global'
  properties: {
    registrationEnabled: false
    virtualNetwork: { id: vnet.id }
  }
}

output aksSubnetId string = '${vnet.id}/subnets/aks'
output postgresSubnetId string = '${vnet.id}/subnets/postgres'
output postgresZoneId string = postgresZone.id
