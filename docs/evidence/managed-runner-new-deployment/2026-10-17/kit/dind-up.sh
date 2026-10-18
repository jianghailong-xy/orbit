#!/bin/bash
# Start one isolated Docker-in-Docker test host for task D3 (34hJ7RbezzIdkzud1OBz2).
#   dind-up.sh <name: fresh|upgrade> <host loopback port for its gateway>
# Its Docker data root and its work directory live under /mnt/data/tmp/34hJ7RbezzIdkzud1OBz2/<name>;
# the container is privileged (its own dockerd), capped (6 GiB memory, 8 CPUs) and labelled.
set -euo pipefail
NAME="$1"; PORT="$2"
T=/mnt/data/tmp/34hJ7RbezzIdkzud1OBz2
C="d3-$NAME-dind"
mkdir -p "$T/$NAME/docker" "$T/$NAME/work"
if ! docker inspect "$C" >/dev/null 2>&1; then
  docker run -d --privileged --name "$C" --hostname "d3-$NAME" \
    --label orbit.test=d3-34hJ7RbezzIdkzud1OBz2 \
    --memory 6g --memory-swap 12g --cpus 8 --oom-score-adj 1000 \
    -v "$T/$NAME/docker:/var/lib/docker" -v "$T/$NAME/work:/work" \
    -p "127.0.0.1:$PORT:2086" \
    docker:29.8.2-dind >/dev/null
fi
for _ in $(seq 1 90); do docker exec "$C" docker info >/dev/null 2>&1 && break; sleep 1; done
docker exec "$C" sh -c 'command -v bash >/dev/null && command -v git >/dev/null && command -v openssl >/dev/null && command -v curl >/dev/null && command -v jq >/dev/null || apk add --no-cache bash git openssl curl jq >/dev/null'
docker exec "$C" sh -c 'docker version --format "{{.Server.Version}}"; docker compose version; docker buildx version; bash --version | head -1; git --version; openssl version'
