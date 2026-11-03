// AKS cluster: OIDC issuer + workload identity, Azure CNI overlay with Cilium network policy,
// a system pool for Rakazo's own pods and a separate pool whose pods each run in a Kata microVM.
param name string
param location string
param subnetId string
param workspaceId string
param adminGroupObjectIds array
param systemNodeVmSize string
param systemNodeCount int
param computerNodeVmSize string
param computerNodeMinCount int
param computerNodeMaxCount int

resource aks 'Microsoft.ContainerService/managedClusters@2025-05-01' = {
  name: name
  location: location
  identity: { type: 'SystemAssigned' }
  sku: {
    name: 'Base'
    tier: 'Standard'
  }
  properties: {
    dnsPrefix: name
    enableRBAC: true
    // Entra sign-in and Azure RBAC for the Kubernetes API; no static admin credentials.
    disableLocalAccounts: true
    aadProfile: {
      managed: true
      enableAzureRBAC: true
      adminGroupObjectIDs: adminGroupObjectIds
    }
    oidcIssuerProfile: { enabled: true }
    securityProfile: {
      workloadIdentity: { enabled: true }
    }
    networkProfile: {
      networkPlugin: 'azure'
      networkPluginMode: 'overlay'
      networkPolicy: 'cilium'
      networkDataplane: 'cilium'
      podCidr: '192.168.0.0/16'
      serviceCidr: '172.16.0.0/16'
      dnsServiceIP: '172.16.0.10'
      loadBalancerSku: 'standard'
    }
    // Managed NGINX ingress controller (ingress class webapprouting.kubernetes.azure.com).
    ingressProfile: {
      webAppRouting: { enabled: true }
    }
    addonProfiles: {
      omsagent: {
        enabled: true
        config: { logAnalyticsWorkspaceResourceID: workspaceId }
      }
    }
    agentPoolProfiles: [
      {
        name: 'system'
        mode: 'System'
        osType: 'Linux'
        osSKU: 'AzureLinux'
        vmSize: systemNodeVmSize
        count: systemNodeCount
        vnetSubnetID: subnetId
        type: 'VirtualMachineScaleSets'
      }
    ]
  }
}

// Bot computers. workloadRuntime KataVmIsolation (AKS Pod Sandboxing) needs Azure Linux and a VM
// size with nested virtualization. infra/azure/k8s/runtimeclass.yaml binds the Kata handler to
// this pool's label and taint. Rakazo's own pods stay on the system pool.
resource computerPool 'Microsoft.ContainerService/managedClusters/agentPools@2025-05-01' = {
  parent: aks
  name: 'computers'
  properties: {
    mode: 'User'
    osType: 'Linux'
    osSKU: 'AzureLinux'
    vmSize: computerNodeVmSize
    workloadRuntime: 'KataVmIsolation'
    // Only pods that tolerate the taint (the rakazo-kata RuntimeClass adds it) run here, and that
    // class selects this label, so bots never land on the system pool and app pods never land here.
    nodeLabels: { 'rakazo.io/pool': 'computers' }
    nodeTaints: ['rakazo.io/computers=true:NoSchedule']
    enableAutoScaling: true
    minCount: computerNodeMinCount
    maxCount: computerNodeMaxCount
    vnetSubnetID: subnetId
    type: 'VirtualMachineScaleSets'
  }
}

output clusterName string = aks.name
output oidcIssuerUrl string = aks.properties.oidcIssuerProfile.issuerURL
