#!/bin/bash
# Start the isolated Docker host of task D10 (34ilx9dqVOKBeYZObuIjI), as D5's, D8's and D9's kits did, on the HPC host:
#   dind-up.sh
# A docker:29.8.2-dind container: privileged for its own dockerd, its own network namespace and iptables, capped (8 GiB
# without swap, 10 CPUs, first to go under a global OOM), outside the Orbit runner's cgroup (a container of the host's
# Docker), labelled. Its Docker data root and its deployment's checkout are under /mnt/data/tmp/34ilx9dqVOKBeYZObuIjI on
# the HPC host's spinning disk (/dev/sdb, ext4), one filesystem as a default host's /var/lib/docker and checkout are: the
# managed runners' volumes, the deployment's Postgres (./data/postgres) and its logs share it, and a syncfs on a volume
# writes all of it back. dockerd runs under supervise-dockerd.sh (D9's), has no TCP listener, and its deployment's
# gateway is published on host 127.0.0.1:15086 only. The source is /repo.git, a bare repository of the commits under
# test, read-only.
set -euo pipefail
T=/mnt/data/tmp/34ilx9dqVOKBeYZObuIjI
C=d10-dind
mkdir -p "$T/dind/docker" "$T/work" "$T/evidence" "$T/kit"
# The kit as the test host runs it: a copy, so that nothing done to the worktree it comes from reaches a running host.
cp -a "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/." "$T/kit/"
KIT="$T/kit"
[ -d "$T/repo.git" ] || { echo "no $T/repo.git: run kit/repo-sync.sh first" >&2; exit 1; }
if ! docker inspect "$C" >/dev/null 2>&1; then
  docker run -d --privileged --name "$C" --hostname d10-host \
    --label orbit.test=d10-34ilx9dqVOKBeYZObuIjI \
    --memory 8g --memory-swap 8g --cpus 10 --oom-score-adj 1000 --tmpfs /run:rw,exec,size=256m \
    -e DOCKER_TLS_CERTDIR= \
    -v "$T/dind/docker:/var/lib/docker" -v "$T/work:/work" -v "$T/repo.git:/repo.git:ro" -v "$KIT:/kit:ro" \
    -v "$T/evidence:/evidence" \
    -p 127.0.0.1:15086:2086 \
    --entrypoint /kit/supervise-dockerd.sh docker:29.8.2-dind >/dev/null
fi
for _ in $(seq 1 90); do docker exec "$C" docker info >/dev/null 2>&1 && break; sleep 1; done
docker exec "$C" sh -c 'command -v bash >/dev/null && command -v git >/dev/null && command -v openssl >/dev/null && command -v python3 >/dev/null && command -v socat >/dev/null && command -v ip >/dev/null || apk add --no-cache bash git openssl curl jq python3 socat iproute2 >/dev/null'
docker exec "$C" sh -c 'echo "Docker $(docker version --format "{{.Server.Version}} (API {{.Server.APIVersion}})"); $(docker compose version)"; echo "data root: $(docker info --format "{{.DockerRootDir}} {{.Driver}}")"; echo "kernel: $(uname -r)"; df -T /var/lib/docker /work | tail -n 2'
