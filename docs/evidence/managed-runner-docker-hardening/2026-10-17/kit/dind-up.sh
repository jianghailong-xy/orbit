#!/bin/bash
# Start the isolated Docker-in-Docker test host of task D8 (34hXCWEWAgHqtrxZsMBOh), as D5's and D6's kits did.
#   dind-up.sh
# Its Docker data root is /mnt/data/tmp/34hXCWEWAgHqtrxZsMBOh/dind/docker, on the HPC host's /mnt/data (ext4 on
# its own disk). The deployment's checkout is /work, a tmpfs of the test host's own: a different filesystem from
# Docker's data root, which is the case D5's finding 5 is about (the channel measured the disk under
# data/managed-runners, not the one Docker's volumes live on). The source is /repo.git, a bare clone of the branch
# under test on /mnt/data, read-only here, so the test host never sees the shared repository.
# The container is privileged (its own dockerd), capped (6 GiB memory, 8 CPUs, first to go under a global OOM),
# outside the Orbit runner's cgroup (a container of the host's Docker), labelled, its /run a tmpfs as a host's is,
# and it publishes its deployment's gateway on host loopback only.
set -euo pipefail
T=/mnt/data/tmp/34hXCWEWAgHqtrxZsMBOh
KIT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
C=d8-dind
PORT=14886
mkdir -p "$T/dind/docker" "$T/evidence"
[ -d "$T/repo.git" ] || { echo "no $T/repo.git: clone the branch under test there first (kit/repo-sync.sh)" >&2; exit 1; }
if ! docker inspect "$C" >/dev/null 2>&1; then
  docker run -d --privileged --name "$C" --hostname d8-host \
    --label orbit.test=d8-34hXCWEWAgHqtrxZsMBOh \
    --memory 6g --memory-swap 12g --cpus 8 --oom-score-adj 1000 \
    --tmpfs /run:rw,exec,size=256m --tmpfs /work:rw,exec,size=3g \
    -v "$T/dind/docker:/var/lib/docker" -v "$T/repo.git:/repo.git:ro" -v "$KIT:/kit:ro" -v "$T/evidence:/evidence" \
    -p "127.0.0.1:$PORT:2086" \
    docker:29.8.2-dind >/dev/null
fi
for _ in $(seq 1 90); do docker exec "$C" docker info >/dev/null 2>&1 && break; sleep 1; done
docker exec "$C" sh -c 'command -v bash >/dev/null && command -v git >/dev/null && command -v openssl >/dev/null && command -v curl >/dev/null && command -v jq >/dev/null && command -v python3 >/dev/null || apk add --no-cache bash git openssl curl jq python3 >/dev/null'
docker exec "$C" sh -c 'docker version --format "{{.Server.Version}} (API {{.Server.APIVersion}})"; docker compose version; docker info --format "data root {{.DockerRootDir}}, storage driver {{.Driver}}, {{json .DriverStatus}}"; bash --version | head -1; git --version; python3 --version'
docker exec "$C" sh -c 'echo "filesystems: Docker data root and the checkout"; df -hT /var/lib/docker /work'
