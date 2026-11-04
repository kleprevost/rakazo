// web (external ingress), api (internal ingress) and the migrate job. The worker runs on the VM.
// Env names come from infra/compose/docker-compose.images.yml and infra/azure/k8s; commands start
// with `cd` because Container Apps has no working directory setting.
param location string
param prefix string
param environmentId string
param environmentDomain string
param workloadProfileName string
param storageName string

param deployApps bool
param appImage string
param imageTag string
param ghcrUsername string
@secure()
param ghcrToken string

@description('Subnet CIDR of the ACA environment; the API trusts X-Forwarded-For only from it.')
param trustedProxies string
param supervisorUrl string
param policyFile string
param apiMinReplicas int
param webMinReplicas int

@secure()
param databaseUrl string
@secure()
param databaseMigrationUrl string
@secure()
param betterAuthSecret string
@secure()
param encryptionKey string
@secure()
param screenProxySecret string
@secure()
param supervisorToken string
@secure()
param oidcClientSecret string
@secure()
param azureOpenAiApiKey string

param oidcTenantId string
param oidcClientId string
param oidcName string
param oidcAccessClaim string
param oidcAllowedValues string
param oidcAdminValues string
param oidcSecurityValues string
param oidcFleetValues string
param oidcAuditorValues string
param securityEmails string
param fleetEmails string
param auditorEmails string
param oidcRevalidateMinutes string
param oidcTrustEmail bool

param piDefaultModel string
param azureOpenAiResourceName string
param azureOpenAiDeploymentNameMap string

param enableEasyAuth bool
param enableSharedEmployees bool

var webName = '${prefix}-web'
var apiName = '${prefix}-api'
var webFqdn = '${webName}.${environmentDomain}'
var apiFqdn = '${apiName}.internal.${environmentDomain}'
var publicOrigin = 'https://${webFqdn}'
var appImageRef = '${appImage}:${imageTag}'

var registries = empty(ghcrToken) ? [] : [
  {
    server: 'ghcr.io'
    username: ghcrUsername
    passwordSecretRef: 'ghcr-token'
  }
]
var registrySecrets = empty(ghcrToken) ? [] : [
  { name: 'ghcr-token', value: ghcrToken }
]

// Easy Auth sign-in mode (docs/enterprise/easy-auth.md).
var easyAuthEnv = enableEasyAuth ? [{ name: 'AUTH_EASY_AUTH', value: 'true' }] : []
// Shared AI employees: people add their own instance (docs/enterprise/features/shared-employees.md). API only.
var sharedEmployeesEnv = enableSharedEmployees ? [{ name: 'SHARED_EMPLOYEES_ENABLED', value: 'true' }] : []
// Operator roles beyond admin (docs/enterprise/features/admin-roles.md), set only when given. API only.
var operatorRolesEnv = concat(
  empty(oidcSecurityValues) ? [] : [{ name: 'OIDC_SECURITY_VALUES', value: oidcSecurityValues }],
  empty(oidcFleetValues) ? [] : [{ name: 'OIDC_FLEET_VALUES', value: oidcFleetValues }],
  empty(oidcAuditorValues) ? [] : [{ name: 'OIDC_AUDITOR_VALUES', value: oidcAuditorValues }],
  empty(securityEmails) ? [] : [{ name: 'RAKAZO_SECURITY_EMAILS', value: securityEmails }],
  empty(fleetEmails) ? [] : [{ name: 'RAKAZO_FLEET_EMAILS', value: fleetEmails }],
  empty(auditorEmails) ? [] : [{ name: 'RAKAZO_AUDITOR_EMAILS', value: auditorEmails }]
)
// Screens and terminals go through the supervisor's proxy on port 7091 (docs/enterprise/aca-vm.md).
var screenViaSupervisorEnv = [{ name: 'SANDBOX_SCREEN_VIA_SUPERVISOR', value: 'true' }]

// Work items: tickets that bots pick up and track (docs/enterprise/features/work-items.md).
var workItemsEnv = [{ name: 'TICKET_BOARD_ENABLED', value: 'true' }]

var apiEnv = concat(
  [
    { name: 'NODE_ENV', value: 'production' }
    { name: 'DATA_DIR', value: '/data' }
    { name: 'API_HOST', value: '0.0.0.0' }
    { name: 'API_PORT', value: '3100' }
    { name: 'WAKEUP_DRIVER', value: 'graphile' }
    { name: 'AGENT_RUNTIME', value: 'pi' }
    { name: 'CONTENT_ENCRYPTION', value: 'on' }
    { name: 'DATABASE_URL', secretRef: 'database-url' }
    { name: 'ENCRYPTION_KEY', secretRef: 'encryption-key' }
    { name: 'BETTER_AUTH_SECRET', secretRef: 'better-auth-secret' }
    { name: 'BETTER_AUTH_URL', value: publicOrigin }
    { name: 'WEB_ORIGIN', value: publicOrigin }
    { name: 'API_URL', value: publicOrigin }
    { name: 'TRUSTED_PROXIES', value: trustedProxies }
    { name: 'SCREEN_PROXY_SECRET', secretRef: 'screen-proxy-secret' }
    { name: 'SANDBOX_PROVIDER', value: 'docker' }
    { name: 'SANDBOX_SUPERVISOR_URL', value: supervisorUrl }
    { name: 'SANDBOX_SUPERVISOR_TOKEN', secretRef: 'supervisor-token' }
    { name: 'OIDC_ISSUER', value: '${environment().authentication.loginEndpoint}${oidcTenantId}/v2.0' }
    { name: 'OIDC_CLIENT_ID', value: oidcClientId }
    { name: 'OIDC_CLIENT_SECRET', secretRef: 'oidc-client-secret' }
    { name: 'OIDC_NAME', value: oidcName }
    { name: 'OIDC_ACCESS_CLAIM', value: oidcAccessClaim }
    { name: 'OIDC_ALLOWED_VALUES', value: oidcAllowedValues }
    { name: 'OIDC_ADMIN_VALUES', value: oidcAdminValues }
    { name: 'OIDC_REVALIDATE_MINUTES', value: oidcRevalidateMinutes }
    { name: 'OIDC_TRUST_EMAIL', value: string(oidcTrustEmail) }
    { name: 'PI_DEFAULT_PROVIDER', value: 'azure' }
    { name: 'PI_DEFAULT_MODEL', value: piDefaultModel }
    { name: 'AZURE_OPENAI_RESOURCE_NAME', value: azureOpenAiResourceName }
    { name: 'AZURE_OPENAI_API_KEY', secretRef: 'azure-openai-api-key' }
  ],
  empty(azureOpenAiDeploymentNameMap) ? [] : [
    { name: 'AZURE_OPENAI_DEPLOYMENT_NAME_MAP', value: azureOpenAiDeploymentNameMap }
  ],
  empty(policyFile) ? [] : [{ name: 'RAKAZO_POLICY_FILE', value: policyFile }],
  screenViaSupervisorEnv,
  workItemsEnv,
  easyAuthEnv,
  sharedEmployeesEnv,
  operatorRolesEnv
)

var apiSecrets = concat(
  [
    { name: 'database-url', value: databaseUrl }
    { name: 'encryption-key', value: encryptionKey }
    { name: 'better-auth-secret', value: betterAuthSecret }
    { name: 'screen-proxy-secret', value: screenProxySecret }
    { name: 'supervisor-token', value: supervisorToken }
    { name: 'oidc-client-secret', value: oidcClientSecret }
    { name: 'azure-openai-api-key', value: azureOpenAiApiKey }
  ],
  registrySecrets
)

var webEnv = concat(
  [
    { name: 'NODE_ENV', value: 'production' }
    { name: 'RAYON_NUM_THREADS', value: '4' }
    { name: 'API_PROXY_TARGET', value: 'https://${apiFqdn}' }
    { name: 'RAKAZO_HOST', value: webFqdn }
    { name: 'RAKAZO_IMAGE_TAG', value: imageTag }
    { name: 'SCREEN_PROXY_SECRET', secretRef: 'screen-proxy-secret' }
  ],
  easyAuthEnv
)

var webSecrets = concat(
  [
    { name: 'screen-proxy-secret', value: screenProxySecret }
  ],
  enableEasyAuth ? [{ name: 'oidc-client-secret', value: oidcClientSecret }] : [],
  registrySecrets
)

resource api 'Microsoft.App/containerApps@2025-01-01' = if (deployApps) {
  name: apiName
  location: location
  properties: {
    environmentId: environmentId
    workloadProfileName: workloadProfileName
    configuration: {
      activeRevisionsMode: 'Single'
      ingress: {
        external: false
        targetPort: 3100
        transport: 'auto'
        allowInsecure: false
      }
      registries: registries
      secrets: apiSecrets
    }
    template: {
      containers: [
        {
          name: 'api'
          image: appImageRef
          command: ['sh', '-c', 'cd /app/apps/api && exec node --enable-source-maps dist/index.js']
          env: apiEnv
          resources: { cpu: json('1.0'), memory: '2Gi' }
          volumeMounts: [{ volumeName: 'data', mountPath: '/data' }]
          probes: [
            {
              type: 'Startup'
              httpGet: { path: '/health', port: 3100 }
              periodSeconds: 10
              failureThreshold: 10
            }
            {
              type: 'Liveness'
              httpGet: { path: '/health', port: 3100 }
              periodSeconds: 20
              failureThreshold: 3
            }
            {
              // /ready also checks the database.
              type: 'Readiness'
              httpGet: { path: '/ready', port: 3100 }
              periodSeconds: 10
              failureThreshold: 3
            }
          ]
        }
      ]
      volumes: [
        {
          name: 'data'
          storageType: 'NfsAzureFile'
          storageName: storageName
        }
      ]
      scale: {
        minReplicas: apiMinReplicas
        maxReplicas: 4
        rules: [
          {
            name: 'http'
            http: { metadata: { concurrentRequests: '100' } }
          }
        ]
      }
    }
  }
}

resource web 'Microsoft.App/containerApps@2025-01-01' = if (deployApps) {
  name: webName
  location: location
  properties: {
    environmentId: environmentId
    workloadProfileName: workloadProfileName
    configuration: {
      activeRevisionsMode: 'Single'
      // The only public entry: the browser talks to web, which proxies /api, /rpc, the device
      // websocket and /novnc.
      ingress: {
        external: true
        targetPort: 5173
        transport: 'auto'
        allowInsecure: false
      }
      registries: registries
      secrets: webSecrets
    }
    template: {
      containers: [
        {
          name: 'web'
          image: appImageRef
          command: [
            'sh'
            '-c'
            'cd /app/apps/web && exec node_modules/.bin/vite preview --host 0.0.0.0 --port 5173'
          ]
          env: webEnv
          resources: { cpu: json('0.5'), memory: '1Gi' }
          // Recent hashed assets so open tabs keep loading chunks after a deploy; per replica.
          volumeMounts: [{ volumeName: 'web-assets', mountPath: '/app/apps/web/asset-archive' }]
          probes: [
            {
              type: 'Startup'
              httpGet: { path: '/', port: 5173 }
              periodSeconds: 10
              failureThreshold: 10
            }
            {
              type: 'Liveness'
              httpGet: { path: '/', port: 5173 }
              periodSeconds: 20
              failureThreshold: 3
            }
            {
              type: 'Readiness'
              httpGet: { path: '/', port: 5173 }
              periodSeconds: 10
              failureThreshold: 3
            }
          ]
        }
      ]
      volumes: [
        {
          name: 'web-assets'
          storageType: 'EmptyDir'
        }
      ]
      scale: {
        minReplicas: webMinReplicas
        maxReplicas: 3
        rules: [
          {
            name: 'http'
            http: { metadata: { concurrentRequests: '100' } }
          }
        ]
      }
    }
  }
}

// Easy Auth on the web app only. Anonymous requests pass through, so the app's own OIDC sign-in
// keeps working; Easy Auth adds the token store and the /.auth endpoints.
resource webAuth 'Microsoft.App/containerApps/authConfigs@2025-01-01' = if (deployApps && enableEasyAuth) {
  parent: web
  name: 'current'
  properties: {
    platform: { enabled: true }
    globalValidation: {
      unauthenticatedClientAction: 'AllowAnonymous'
    }
    identityProviders: {
      azureActiveDirectory: {
        enabled: true
        registration: {
          openIdIssuer: '${environment().authentication.loginEndpoint}${oidcTenantId}/v2.0'
          clientId: oidcClientId
          clientSecretSettingName: 'oidc-client-secret'
        }
        validation: {
          allowedAudiences: [oidcClientId]
        }
        // offline_access lets the web app call /.auth/refresh before the stored ID token expires.
        login: {
          loginParameters: ['scope=openid profile email offline_access']
        }
      }
    }
    login: {
      tokenStore: { enabled: true }
    }
  }
}

// Manual job: `az containerapp job start`. Applies migrations as the database owner and creates
// the rakazo_app login named in DATABASE_URL; only this job gets DATABASE_MIGRATION_URL.
resource migrate 'Microsoft.App/jobs@2025-01-01' = {
  name: '${prefix}-migrate'
  location: location
  properties: {
    environmentId: environmentId
    workloadProfileName: workloadProfileName
    configuration: {
      triggerType: 'Manual'
      replicaTimeout: 1800
      replicaRetryLimit: 1
      manualTriggerConfig: {
        parallelism: 1
        replicaCompletionCount: 1
      }
      registries: registries
      secrets: concat(
        [
          { name: 'database-url', value: databaseUrl }
          { name: 'database-migration-url', value: databaseMigrationUrl }
        ],
        registrySecrets
      )
    }
    template: {
      containers: [
        {
          name: 'migrate'
          image: appImageRef
          command: ['sh', '-c', 'cd /app/apps/api && exec pnpm db:deploy']
          env: [
            { name: 'DATABASE_URL', secretRef: 'database-url' }
            { name: 'DATABASE_MIGRATION_URL', secretRef: 'database-migration-url' }
          ]
          resources: { cpu: json('1.0'), memory: '2Gi' }
        }
      ]
    }
  }
}

output webFqdn string = webFqdn
output webUrl string = publicOrigin
output apiFqdn string = apiFqdn
output migrateJobName string = migrate.name
