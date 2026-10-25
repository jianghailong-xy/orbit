#!/bin/bash
# Start one isolated Docker-in-Docker test host for task D6 (34hTEJMR1drqjLq8TqKM3), as D3's kit did.
#   dind-up.sh <name: on|off> <host loopback port for its gateway>
# Its Docker data root and its work directory live under /mnt/data/tmp/34hTEJMR1drqjLq8TqKM3/<name>;
# the container is privileged (its own dockerd), capped (6 GiB memory, 8 CPUs, first to go under a global
# OOM), outside the Orbit runner's cgroup, labelled, and publishes its gateway on host loopback only.
# Inside it, `docker` is a shim that logs every call (kit/docker-shim.sh) before the real binary runs it.
set -euo pipefail
NAME="$1"; PORT="$2"
T=/mnt/data/tmp/34hTEJMR1drqjLq8TqKM3
KIT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
C="d6-$NAME-dind"
mkdir -p "$T/$NAME/docker" "$T/$NAME/work"
if ! docker inspect "$C" >/dev/null 2>&1; then
  docker run -d --privileged --name "$C" --hostname "d6-$NAME" \
    --label orbit.test=d6-34hTEJMR1drqjLq8TqKM3 \
    --memory 6g --memory-swap 12g --cpus 8 --oom-score-adj 1000 \
    -v "$T/$NAME/docker:/var/lib/docker" -v "$T/$NAME/work:/work" -v "$KIT:/kit:ro" \
    -p "127.0.0.1:$PORT:2086" \
    docker:29.8.2-dind >/dev/null
fi
for _ in $(seq 1 90); do docker exec "$C" docker info >/dev/null 2>&1 && break; sleep 1; done
docker exec "$C" sh -c 'command -v bash >/dev/null && command -v git >/dev/null && command -v openssl >/dev/null && command -v curl >/dev/null && command -v jq >/dev/null && command -v python3 >/dev/null || apk add --no-cache bash git openssl curl jq python3 >/dev/null'
docker exec "$C" sh -c 'mkdir -p /usr/local/d6-shim && cp /kit/docker-shim.sh /usr/local/d6-shim/docker && chmod 0755 /usr/local/d6-shim/docker'
docker exec "$C" sh -c 'docker version --format "{{.Server.Version}}"; docker compose version; docker buildx version; docker info --format "storage driver {{.Driver}}, {{json .DriverStatus}}"; bash --version | head -1; git --version; openssl version; python3 --version'
