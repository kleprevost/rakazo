// Managed identity for the API and worker, trusted by the cluster's OIDC issuer for exactly the
// two service accounts that use it.
param name string
param location string
param oidcIssuerUrl string
param kubernetesNamespace string
param serviceAccounts array

resource identity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: name
  location: location
}

// Federated credentials on one identity are written one at a time.
@batchSize(1)
resource federated 'Microsoft.ManagedIdentity/userAssignedIdentities/federatedIdentityCredentials@2023-01-31' = [
  for serviceAccount in serviceAccounts: {
    parent: identity
    name: serviceAccount
    properties: {
      issuer: oidcIssuerUrl
      subject: 'system:serviceaccount:${kubernetesNamespace}:${serviceAccount}'
      audiences: ['api://AzureADTokenExchange']
    }
  }
]

output principalId string = identity.properties.principalId
output clientId string = identity.properties.clientId
