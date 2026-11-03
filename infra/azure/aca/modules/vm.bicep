// One Ubuntu LTS VM, no public IP, that runs the Docker computer supervisor, the bot computers
// and the worker. Everything is set up by cloud-init (infra/azure/aca/vm). The VM's private IP is
// fixed so the Container Apps can point at it before the VM exists.
//
// Secrets reach the VM as custom data (the rendered /etc/rakazo/vm.env). That is acceptable for a
// PoC: custom data is readable by anything on the VM that can call the metadata service, which the
// computers cannot (egress rules), and by people with VM read access in Azure. Hardening: Key Vault
// plus a managed identity, fetched at boot (docs/enterprise/aca-vm-deploy.md).
param name string
param location string
param subnetId string
param privateIp string
param vmSize string
param osDiskSizeGB int
param adminUsername string
param adminSshPublicKey string

param nfsServer string
param nfsSharePath string

param appImage string
param computerImage string
param imageTag string
param ghcrUsername string
@secure()
param ghcrToken string

@secure()
param databaseUrl string
@secure()
param encryptionKey string
@secure()
param supervisorToken string
@secure()
param azureOpenAiApiKey string

param publicOrigin string
param policyFile string
param policySeed string
param piDefaultModel string
param azureOpenAiResourceName string
param azureOpenAiDeploymentNameMap string

var envLines = [
  'RAKAZO_IMAGE=${appImage}'
  'RAKAZO_IMAGE_TAG=${imageTag}'
  'RAKAZO_COMPUTER_IMAGE=${computerImage}'
  'RAKAZO_COMPUTER_IMAGE_TAG=${imageTag}'
  'NFS_SERVER=${nfsServer}'
  'NFS_PATH=${nfsSharePath}'
  'GHCR_USERNAME=${ghcrUsername}'
  'GHCR_TOKEN=${ghcrToken}'
  'DATABASE_URL=${databaseUrl}'
  'ENCRYPTION_KEY=${encryptionKey}'
  'SANDBOX_SUPERVISOR_TOKEN=${supervisorToken}'
  'API_URL=${publicOrigin}'
  'RAKAZO_POLICY_FILE=${policyFile}'
  'PI_DEFAULT_PROVIDER=azure'
  'PI_DEFAULT_MODEL=${piDefaultModel}'
  'AZURE_OPENAI_RESOURCE_NAME=${azureOpenAiResourceName}'
  'AZURE_OPENAI_API_KEY=${azureOpenAiApiKey}'
  'AZURE_OPENAI_DEPLOYMENT_NAME_MAP=${azureOpenAiDeploymentNameMap}'
  // PLACEHOLDER: supervisor screen proxy switch from the sibling PR. Verify the name.
  'SANDBOX_SCREEN_VIA_SUPERVISOR=true'
  ''
]

var cloudInit = replace(
  replace(
    replace(
      replace(
        replace(
          replace(
            loadTextContent('../vm/cloud-init.yaml'),
            '@@VM_ENV_B64@@',
            base64(join(envLines, '\n'))
          ),
          '@@COMPOSE_B64@@',
          base64(loadTextContent('../vm/docker-compose.yml'))
        ),
        '@@BOOTSTRAP_B64@@',
        base64(loadTextContent('../vm/bootstrap.sh'))
      ),
      '@@EGRESS_SCRIPT_B64@@',
      base64(loadTextContent('../../../compose/restrict-computer-egress.sh'))
    ),
    '@@POLICY_SEED_B64@@',
    base64(policySeed)
  ),
  '@@DAEMON_JSON_B64@@',
  base64(loadTextContent('../../../compose/docker-daemon.json'))
)

resource nic 'Microsoft.Network/networkInterfaces@2024-05-01' = {
  name: '${name}-nic'
  location: location
  properties: {
    ipConfigurations: [
      {
        name: 'ipconfig1'
        properties: {
          subnet: { id: subnetId }
          privateIPAllocationMethod: 'Static'
          privateIPAddress: privateIp
        }
      }
    ]
  }
}

resource vm 'Microsoft.Compute/virtualMachines@2024-07-01' = {
  name: name
  location: location
  properties: {
    hardwareProfile: { vmSize: vmSize }
    storageProfile: {
      imageReference: {
        publisher: 'Canonical'
        offer: 'ubuntu-24_04-lts'
        sku: 'server'
        version: 'latest'
      }
      osDisk: {
        createOption: 'FromImage'
        diskSizeGB: osDiskSizeGB
        managedDisk: { storageAccountType: 'Premium_LRS' }
      }
    }
    osProfile: {
      computerName: take(name, 15)
      adminUsername: adminUsername
      customData: base64(cloudInit)
      linuxConfiguration: {
        disablePasswordAuthentication: true
        ssh: {
          publicKeys: [
            {
              path: '/home/${adminUsername}/.ssh/authorized_keys'
              keyData: adminSshPublicKey
            }
          ]
        }
      }
    }
    securityProfile: {
      securityType: 'TrustedLaunch'
      uefiSettings: {
        secureBootEnabled: true
        vTpmEnabled: true
      }
    }
    networkProfile: {
      networkInterfaces: [{ id: nic.id }]
    }
  }
}

output privateIp string = privateIp
output vmName string = vm.name
