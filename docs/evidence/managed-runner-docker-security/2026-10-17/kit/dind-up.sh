#!/bin/bash
# Start the isolated Docker-in-Docker test host of task D5 (34hJ7S9C3isVnzIDDfSHD).
#   dind-up.sh
# Its Docker data root and its work directory live under /mnt/data/tmp/34hJ7S9C3isVnzIDDfSHD/dind; the
# container is privileged (its own dockerd), capped (6 GiB memory, 8 CPUs), outside the Orbit runner's cgroup
# (a container of the host's Docker), labelled, and its deployment's gateway is published on host loopback only.
# Restarting this container restarts its dockerd and everything inside it, and nothing else on the host. Its /run is
# a tmpfs, as a host's is: a docker kill left containerd's pid file in the container's own /run, and the next start's
# dockerd took a new process with that pid for a running containerd and gave up (power-cut run 2, 2026-10-17 13:51Z).
set -euo pipefail
T=/mnt/data/tmp/34hJ7S9C3isVnzIDDfSHD/dind
C=d5-dind
mkdir -p "$T/docker" "$T/work"
if ! docker inspect "$C" >/dev/null 2>&1; then
  docker run -d --privileged --name "$C" --hostname d5-host \
    --label orbit.test=d5-34hJ7S9C3isVnzIDDfSHD \
    --memory 6g --memory-swap 12g --cpus 8 --oom-score-adj 1000 --tmpfs /run:rw,exec,size=256m \
    -v "$T/docker:/var/lib/docker" -v "$T/work:/work" \
    -p 127.0.0.1:14086:2086 \
    docker:29.8.2-dind >/dev/null
fi
for _ in $(seq 1 90); do docker exec "$C" docker info >/dev/null 2>&1 && break; sleep 1; done
docker exec "$C" sh -c 'command -v bash >/dev/null && command -v git >/dev/null && command -v openssl >/dev/null && command -v curl >/dev/null && command -v jq >/dev/null && command -v python3 >/dev/null || apk add --no-cache bash git openssl curl jq python3 >/dev/null'
docker exec "$C" sh -c 'docker version --format "{{.Server.Version}}"; docker compose version; docker info --format "{{json .SecurityOptions}} cgroup={{.CgroupVersion}}"; bash --version | head -1; git --version; openssl version; python3 --version'
