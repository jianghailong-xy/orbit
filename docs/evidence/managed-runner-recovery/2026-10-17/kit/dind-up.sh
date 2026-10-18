#!/bin/bash
# Start the isolated Docker-in-Docker test host of task D7 (34hXCW6iauoWaquGQj7DO), as D5's kit did.
#   dind-up.sh
# Its Docker data root and its work directory live under /mnt/data/tmp/34hXCW6iauoWaquGQj7DO/dind. The container is
# privileged (its own dockerd), capped (6 GiB memory, 8 CPUs, OOM score 1000), outside the Orbit runner's cgroup (a
# container of the host's Docker), labelled, and its deployment's gateway is published on host loopback only. Restarting
# this container restarts its dockerd and everything inside it, and nothing else on the host. Its /run is a tmpfs, as a
# host's is (D5: a `docker kill` otherwise leaves containerd's pid file behind and the next start gives up).
set -euo pipefail
T=/mnt/data/tmp/34hXCW6iauoWaquGQj7DO/dind
C=d7-dind
mkdir -p "$T/docker" "$T/work"
if ! docker inspect "$C" >/dev/null 2>&1; then
  docker run -d --privileged --name "$C" --hostname d7-host \
    --label orbit.test=d7-34hXCW6iauoWaquGQj7DO \
    --memory 6g --memory-swap 12g --cpus 8 --oom-score-adj 1000 --tmpfs /run:rw,exec,size=256m \
    -v "$T/docker:/var/lib/docker" -v "$T/work:/work" \
    -p 127.0.0.1:17086:2086 \
    docker:29.8.2-dind >/dev/null
fi
for _ in $(seq 1 90); do docker exec "$C" docker info >/dev/null 2>&1 && break; sleep 1; done
docker exec "$C" sh -c 'command -v bash >/dev/null && command -v git >/dev/null && command -v openssl >/dev/null && command -v curl >/dev/null && command -v jq >/dev/null && command -v python3 >/dev/null || apk add --no-cache bash git openssl curl jq python3 >/dev/null'
docker exec "$C" sh -c 'docker version --format "{{.Server.Version}}"; docker compose version; docker info --format "{{json .SecurityOptions}} cgroup={{.CgroupVersion}}"; bash --version | head -1; git --version; python3 --version'
