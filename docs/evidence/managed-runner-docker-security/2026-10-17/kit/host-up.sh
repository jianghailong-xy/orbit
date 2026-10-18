#!/bin/bash
# D5 (task 34hJ7S9C3isVnzIDDfSHD): a restricted Docker channel on the HPC host's own Docker, for what a
# Docker-in-Docker host cannot show (AppArmor, the host's network reach) and for measured limits.
#   host-up.sh <checkout>      (run as root on the host; idempotent)
# Everything is labelled orbit.test=d5-34hJ7S9C3isVnzIDDfSHD: the channel container (no network, the Docker socket,
# 256 MiB), its network (bridge, inter-container traffic off, not internal: the default deployment's shape), and every
# volume and container the channel makes (its extraLabels). Its directory is under /mnt/data. host-down.sh removes it all.
set -euo pipefail
CHECKOUT="$1"
T=/mnt/data/tmp/34hJ7S9C3isVnzIDDfSHD/host
LABEL=orbit.test=d5-34hJ7S9C3isVnzIDDfSHD
NET=orbit-mr-d5
IMAGE_TAG=orbit-managed-runner:d5-34hJ7S9C3isVnzIDDfSHD
CHANNEL_TAG=orbit-docker-channel:d5-34hJ7S9C3isVnzIDDfSHD

# The managed runner image the default install built in d5-dind, by its ID, tagged here so no prune takes it.
IMAGE=$(docker exec d5-dind docker image inspect -f '{{.Id}}' orbit-managed-runner:local)
if ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
  docker exec d5-dind docker save "$IMAGE" | docker load >/dev/null
fi
docker tag "$IMAGE" "$IMAGE_TAG"
# The channel from this checkout, as root Compose builds it.
docker build -q -f "$CHECKOUT/deploy/managed-runner/docker-channel/Dockerfile" -t "$CHANNEL_TAG" "$CHECKOUT" >/dev/null

docker network inspect "$NET" >/dev/null 2>&1 || \
  docker network create --driver bridge --opt com.docker.network.bridge.enable_icc=false --label "$LABEL" "$NET" >/dev/null

mkdir -p "$T"
( umask 077 && mkdir -p "$T/mr" )
chmod 700 "$T/mr"
[ -s "$T/mr/token" ] || ( umask 077 && openssl rand -hex 32 > "$T/mr/token" )
( umask 077 && cat > "$T/mr/channel.json" <<EOF
{
  "schemaVersion": 1,
  "instanceId": "d5-host",
  "listen": { "unixSocket": "/var/lib/orbit-managed-runners/channel.sock" },
  "tokenFile": "/var/lib/orbit-managed-runners/token",
  "dockerSocket": "/var/run/docker.sock",
  "stateDir": "/var/lib/orbit-managed-runners/state",
  "image": "$IMAGE",
  "network": "$NET",
  "limits": {
    "maxCpuMillis": 2000,
    "maxMemoryBytes": 1073741824,
    "maxPids": 512,
    "maxTmpBytes": 268435456,
    "maxVolumeBytes": 1073741824,
    "maxConcurrent": 2
  },
  "stopGraceSeconds": 10,
  "diskCheckSeconds": 10,
  "extraLabels": { "orbit.test": "d5-34hJ7S9C3isVnzIDDfSHD" }
}
EOF
)
if ! docker inspect d5-host-channel >/dev/null 2>&1; then
  docker run -d --name d5-host-channel --label "$LABEL" --network none --memory 256m --pids-limit 128 \
    -v /var/run/docker.sock:/var/run/docker.sock -v "$T/mr:/var/lib/orbit-managed-runners" "$CHANNEL_TAG" >/dev/null
fi
for _ in $(seq 1 30); do [ -S "$T/mr/channel.sock" ] && break; sleep 1; done
docker logs d5-host-channel 2>&1 | tail -n 3
docker network inspect "$NET" --format 'network {{.Name}}: internal={{.Internal}} enable_icc={{index .Options "com.docker.network.bridge.enable_icc"}} {{range .IPAM.Config}}{{.Subnet}} gateway {{.Gateway}}{{end}}'
echo "image $IMAGE"
