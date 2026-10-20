#!/bin/bash
# Start the isolated Docker host of task D9 (34iSiGtPrJ0LWSqn17esR), as D5's and D8's kits did, run on the HPC host:
#   dind-up.sh
# A docker:29.8.2-dind container: privileged for its own dockerd, its own network namespace and iptables, capped (6 GiB,
# 8 CPUs, first to go under a global OOM), outside the Orbit runner's cgroup (a container of the host's Docker),
# labelled, its /run a tmpfs as a host's is. Its Docker data root and its deployments' checkouts are under
# /mnt/data/tmp/34iSiGtPrJ0LWSqn17esR, so they outlive a restart of it, as a host's disk does. dockerd runs under
# supervise-dockerd.sh, so it can be restarted on its own. No TCP listener for dockerd (DOCKER_TLS_CERTDIR empty and
# an explicit --host). Its deployment's gateway is published on host 127.0.0.1:14986 only. The source is /repo.git, a
# bare clone of the branches under test, read-only: the test host never sees the shared repository.
set -euo pipefail
T=/mnt/data/tmp/34iSiGtPrJ0LWSqn17esR
C=d9-dind
mkdir -p "$T/dind/docker" "$T/work" "$T/evidence" "$T/kit"
# The kit as the test host runs it: a copy, so that nothing done to the worktree it comes from reaches a running host.
cp -a "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/." "$T/kit/"
KIT="$T/kit"
[ -d "$T/repo.git" ] || { echo "no $T/repo.git: run kit/repo-sync.sh first" >&2; exit 1; }
if ! docker inspect "$C" >/dev/null 2>&1; then
  docker run -d --privileged --name "$C" --hostname d9-host \
    --label orbit.test=d9-34iSiGtPrJ0LWSqn17esR \
    --memory 6g --memory-swap 12g --cpus 8 --oom-score-adj 1000 --tmpfs /run:rw,exec,size=256m \
    -e DOCKER_TLS_CERTDIR= \
    -v "$T/dind/docker:/var/lib/docker" -v "$T/work:/work" -v "$T/repo.git:/repo.git:ro" -v "$KIT:/kit:ro" \
    -v "$T/evidence:/evidence" \
    -p 127.0.0.1:14986:2086 \
    --entrypoint /kit/supervise-dockerd.sh docker:29.8.2-dind >/dev/null
fi
for _ in $(seq 1 90); do docker exec "$C" docker info >/dev/null 2>&1 && break; sleep 1; done
docker exec "$C" sh -c 'command -v bash >/dev/null && command -v git >/dev/null && command -v openssl >/dev/null && command -v python3 >/dev/null && command -v socat >/dev/null && command -v ip >/dev/null || apk add --no-cache bash git openssl curl jq python3 socat iproute2 >/dev/null'
docker exec "$C" sh -c 'echo "Docker $(docker version --format "{{.Server.Version}} (API {{.Server.APIVersion}})"); $(docker compose version)"; echo "iptables: $(iptables --version)"; echo "firewall backend: $(docker info --format "{{json .FirewallBackend}}")"; echo "kernel: $(uname -r)"; echo "dockerd flags: $(cat /etc/d9/dockerd-flags 2>/dev/null || echo none)"'
