using 'main.bicep'

// Example values. Replace the placeholders; never commit real ids.
param prefix = 'rakazo'
param aksAdminGroupObjectIds = [
  '00000000-0000-0000-0000-000000000000' // Entra group that administers the cluster
]

// Read from the environment so the password is never written to a file:
//   export RAKAZO_POSTGRES_ADMIN_PASSWORD='<generated password>'
param postgresAdminPassword = readEnvironmentVariable('RAKAZO_POSTGRES_ADMIN_PASSWORD')

// Optional overrides (defaults are in main.bicep):
// param computerNodeVmSize = 'Standard_D8s_v5'
// param computerNodeMaxCount = 5
