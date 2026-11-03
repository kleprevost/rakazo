// VNet for the Container Apps + VM layout: a delegated subnet for the ACA environment, a subnet for
// the Docker VM (NSG: only the supervisor port from ACA), a private-endpoint subnet for Azure Files,
// and the delegated PostgreSQL subnet. One NAT gateway gives the ACA subnet and the VM subnet
// outbound internet without any public IP on the VM.
param name string
param location string
param vnetAddressPrefix string
param acaSubnetPrefix string
param vmSubnetPrefix string
param privateEndpointSubnetPrefix string
param postgresSubnetPrefix string
param supervisorPort int

resource vmNsg 'Microsoft.Network/networkSecurityGroups@2024-05-01' = {
  name: '${name}-vm-nsg'
  location: location
  properties: {
    securityRules: [
      {
        // The supervisor is the only port the ACA environment may reach on the VM.
        name: 'allow-supervisor-from-aca'
        properties: {
          priority: 100
          direction: 'Inbound'
          access: 'Allow'
          protocol: 'Tcp'
          sourceAddressPrefix: acaSubnetPrefix
          sourcePortRange: '*'
          destinationAddressPrefix: vmSubnetPrefix
          destinationPortRange: string(supervisorPort)
        }
      }
      {
        // Overrides the default AllowVnetInbound rule: no other VNet peer reaches the VM.
        name: 'deny-vnet-inbound'
        properties: {
          priority: 4000
          direction: 'Inbound'
          access: 'Deny'
          protocol: '*'
          sourceAddressPrefix: 'VirtualNetwork'
          sourcePortRange: '*'
          destinationAddressPrefix: '*'
          destinationPortRange: '*'
        }
      }
      {
        name: 'deny-internet-inbound'
        properties: {
          priority: 4010
          direction: 'Inbound'
          access: 'Deny'
          protocol: '*'
          sourceAddressPrefix: 'Internet'
          sourcePortRange: '*'
          destinationAddressPrefix: '*'
          destinationPortRange: '*'
        }
      }
    ]
  }
}

resource natIp 'Microsoft.Network/publicIPAddresses@2024-05-01' = {
  name: '${name}-nat-ip'
  location: location
  sku: { name: 'Standard' }
  properties: {
    publicIPAllocationMethod: 'Static'
  }
}

resource nat 'Microsoft.Network/natGateways@2024-05-01' = {
  name: '${name}-nat'
  location: location
  sku: { name: 'Standard' }
  properties: {
    idleTimeoutInMinutes: 10
    publicIpAddresses: [{ id: natIp.id }]
  }
}

resource vnet 'Microsoft.Network/virtualNetworks@2024-05-01' = {
  name: name
  location: location
  properties: {
    addressSpace: { addressPrefixes: [vnetAddressPrefix] }
    subnets: [
      {
        name: 'aca'
        properties: {
          addressPrefix: acaSubnetPrefix
          natGateway: { id: nat.id }
          delegations: [
            {
              name: 'aca-environment'
              properties: { serviceName: 'Microsoft.App/environments' }
            }
          ]
        }
      }
      {
        name: 'vm'
        properties: {
          addressPrefix: vmSubnetPrefix
          natGateway: { id: nat.id }
          networkSecurityGroup: { id: vmNsg.id }
        }
      }
      {
        name: 'private-endpoints'
        properties: { addressPrefix: privateEndpointSubnetPrefix }
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

// Private DNS zone for the Azure Files private endpoint.
resource fileZone 'Microsoft.Network/privateDnsZones@2024-06-01' = {
  name: 'privatelink.file.${environment().suffixes.storage}'
  location: 'global'
}

resource fileZoneLink 'Microsoft.Network/privateDnsZones/virtualNetworkLinks@2024-06-01' = {
  parent: fileZone
  name: '${name}-link'
  location: 'global'
  properties: {
    registrationEnabled: false
    virtualNetwork: { id: vnet.id }
  }
}

output acaSubnetId string = '${vnet.id}/subnets/aca'
output vmSubnetId string = '${vnet.id}/subnets/vm'
output privateEndpointSubnetId string = '${vnet.id}/subnets/private-endpoints'
output postgresSubnetId string = '${vnet.id}/subnets/postgres'
output postgresZoneId string = postgresZone.id
output fileZoneId string = fileZone.id
output natPublicIp string = natIp.properties.ipAddress
