#!/usr/bin/env bash
# First-boot setup for the Docker VM, run by cloud-init (and safe to re-run):
#   sudo bash /opt/rakazo/bootstrap.sh            # converge: mount, Docker, egress rules, compose up
#   sudo bash /opt/rakazo/bootstrap.sh set-tag X  # switch the image tag on this VM, then converge
# Settings come from /etc/rakazo/vm.env, rendered by cloud-init from the Bicep parameters.
set -Eeuo pipefail
exec > >(tee -a /var/log/rakazo-bootstrap.log) 2>&1

ENV_FILE=/etc/rakazo/vm.env
COMPOSE=(docker compose --env-file "$ENV_FILE" -f /opt/rakazo/docker-compose.yml)

# Read one key without sourcing the file (values may contain shell metacharacters).
get() { grep -m1 "^$1=" "$ENV_FILE" | cut -d= -f2- || true; }

if [[ "${1:-}" == "set-tag" ]]; then
  tag="${2:?usage: bootstrap.sh set-tag <tag>}"
  sed -i "s|^RAKAZO_IMAGE_TAG=.*|RAKAZO_IMAGE_TAG=$tag|; s|^RAKAZO_COMPUTER_IMAGE_TAG=.*|RAKAZO_COMPUTER_IMAGE_TAG=$tag|" "$ENV_FILE"
fi

echo "== $(date -u +%FT%TZ) bootstrap start"

# 1. Shared /data (Azure Files Premium NFS 4.1 over the private endpoint).
nfs_server="$(get NFS_SERVER)"
nfs_path="$(get NFS_PATH)"
mkdir -p /data
if ! grep -q " /data nfs" /etc/fstab; then
  echo "$nfs_server:$nfs_path /data nfs vers=4,minorversion=1,sec=sys,nconnect=4,nofail,_netdev,x-systemd.automount 0 0" >>/etc/fstab
  systemctl daemon-reload
fi
mountpoint -q /data || mount /data
# The share allows root (NoRootSquash); computers and the app run as uid/gid 1000.
chown 1000:1000 /data

# Starter policy so the API and worker can start with RAKAZO_POLICY_FILE set. Never overwritten.
policy_file="$(get RAKAZO_POLICY_FILE)"
if [[ -n "$policy_file" && "$policy_file" == /data/* && ! -e "$policy_file" ]]; then
  install -o 1000 -g 1000 -m 0644 /opt/rakazo/policy.seed.yaml "$policy_file"
fi

# 2. Docker Engine from Docker's apt repository (Compose plugin included).
if ! command -v docker >/dev/null 2>&1; then
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
    >/etc/apt/sources.list.d/docker.list
  apt-get update
  DEBIAN_FRONTEND=noninteractive apt-get install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin
fi
systemctl enable --now docker
docker_major="$(docker version --format '{{.Server.Version}}' | cut -d. -f1)"
if ((docker_major < 28)); then
  echo "WARNING: Docker $docker_major < 28 forwards computer DNS from the computer network; set SANDBOX_COMPUTER_DNS." >&2
fi

# 3. Restricted computer egress: the repo script, then the Azure-specific drops.
bash /opt/rakazo/restrict-computer-egress.sh
systemctl daemon-reload
systemctl enable --now rakazo-azure-egress.service

# 4. Images and containers.
ghcr_token="$(get GHCR_TOKEN)"
if [[ -n "$ghcr_token" ]]; then
  printf '%s' "$ghcr_token" | docker login ghcr.io -u "$(get GHCR_USERNAME)" --password-stdin
fi
"${COMPOSE[@]}" pull
"${COMPOSE[@]}" up -d

echo "== $(date -u +%FT%TZ) bootstrap done"
