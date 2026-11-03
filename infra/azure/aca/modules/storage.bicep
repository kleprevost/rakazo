// Premium Azure Files account with one NFS 4.1 share for DATA_DIR, reachable only through a
// private endpoint. NFS keeps uid/gid 1000 ownership (SMB cannot). NoRootSquash lets the
// root-run supervisor and cloud-init chown; access is already limited to the VNet.
param name string
param location string
param shareName string
param shareQuotaGiB int
param subnetId string
param privateDnsZoneId string

resource account 'Microsoft.Storage/storageAccounts@2023-05-01' = {
  name: name
  location: location
  kind: 'FileStorage'
  sku: { name: 'Premium_LRS' }
  properties: {
    // NFS shares do not support encryption in transit at the protocol level; the traffic stays
    // on the private endpoint.
    supportsHttpsTrafficOnly: false
    minimumTlsVersion: 'TLS1_2'
    allowBlobPublicAccess: false
    publicNetworkAccess: 'Disabled'
    networkAcls: {
      defaultAction: 'Deny'
      bypass: 'None'
    }
  }
}

resource fileService 'Microsoft.Storage/storageAccounts/fileServices@2023-05-01' = {
  parent: account
  name: 'default'
}

resource share 'Microsoft.Storage/storageAccounts/fileServices/shares@2023-05-01' = {
  parent: fileService
  name: shareName
  properties: {
    enabledProtocols: 'NFS'
    rootSquash: 'NoRootSquash'
    shareQuota: shareQuotaGiB
  }
}

resource endpoint 'Microsoft.Network/privateEndpoints@2024-05-01' = {
  name: '${name}-pe'
  location: location
  properties: {
    subnet: { id: subnetId }
    privateLinkServiceConnections: [
      {
        name: 'file'
        properties: {
          privateLinkServiceId: account.id
          groupIds: ['file']
        }
      }
    ]
  }
}

resource zoneGroup 'Microsoft.Network/privateEndpoints/privateDnsZoneGroups@2024-05-01' = {
  parent: endpoint
  name: 'default'
  properties: {
    privateDnsZoneConfigs: [
      {
        name: 'file'
        properties: { privateDnsZoneId: privateDnsZoneId }
      }
    ]
  }
}

output accountName string = account.name
output server string = '${account.name}.file.${environment().suffixes.storage}'
// Path as NFS clients and the ACA storage definition expect it: /<account>/<share>.
output sharePath string = '/${account.name}/${share.name}'
