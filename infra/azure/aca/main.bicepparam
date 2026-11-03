using 'main.bicep'

// Example values. Replace the placeholders; never commit real ids or secrets.
param prefix = 'rakazo'

// Phase 1: unset or false (infra, VM, migrate job). Phase 2: export RAKAZO_DEPLOY_APPS=true (web and api).
// See docs/enterprise/aca-vm-deploy.md.
param deployApps = readEnvironmentVariable('RAKAZO_DEPLOY_APPS', 'false') == 'true'

// Read from the environment so no secret is written to a file:
//   export RAKAZO_POSTGRES_ADMIN_PASSWORD="$(openssl rand -hex 24)"
//   export RAKAZO_POSTGRES_APP_PASSWORD="$(openssl rand -hex 24)"
//   export RAKAZO_BETTER_AUTH_SECRET="$(openssl rand -hex 32)"
//   export RAKAZO_ENCRYPTION_KEY="$(openssl rand -hex 32)"
//   export RAKAZO_SCREEN_PROXY_SECRET="$(openssl rand -hex 32)"
//   export RAKAZO_SUPERVISOR_TOKEN="$(openssl rand -hex 32)"
//   export RAKAZO_OIDC_CLIENT_SECRET='<Entra client secret value>'
//   export RAKAZO_AZURE_OPENAI_API_KEY='<Foundry key>'
param postgresAdminPassword = readEnvironmentVariable('RAKAZO_POSTGRES_ADMIN_PASSWORD')
param postgresAppPassword = readEnvironmentVariable('RAKAZO_POSTGRES_APP_PASSWORD')
param betterAuthSecret = readEnvironmentVariable('RAKAZO_BETTER_AUTH_SECRET')
param encryptionKey = readEnvironmentVariable('RAKAZO_ENCRYPTION_KEY')
param screenProxySecret = readEnvironmentVariable('RAKAZO_SCREEN_PROXY_SECRET')
param supervisorToken = readEnvironmentVariable('RAKAZO_SUPERVISOR_TOKEN')
param oidcClientSecret = readEnvironmentVariable('RAKAZO_OIDC_CLIENT_SECRET')
param azureOpenAiApiKey = readEnvironmentVariable('RAKAZO_AZURE_OPENAI_API_KEY')

// Admin SSH public key (no inbound SSH is opened; this only satisfies the VM's login requirement).
param vmAdminSshPublicKey = readEnvironmentVariable('RAKAZO_VM_SSH_PUBLIC_KEY')

// Entra app registration.
param oidcTenantId = '00000000-0000-0000-0000-000000000000'
param oidcClientId = '00000000-0000-0000-0000-000000000000'

// Foundry deployment.
param piDefaultModel = 'replace-with-model-id'
param azureOpenAiResourceName = 'replace-with-resource'

// Optional overrides (defaults are in main.bicep):
// param imageTag = 'edge'
// param vmSize = 'Standard_D8s_v5'
// param deployVm = false   // after the VM exists; update it through az vm run-command instead
// param enableEasyAuth = true
// param azureOpenAiDeploymentNameMap = 'gpt-5.1=my-gpt-deployment'
// param ghcrUsername = '<github user>'
// param ghcrToken = readEnvironmentVariable('RAKAZO_GHCR_TOKEN')
