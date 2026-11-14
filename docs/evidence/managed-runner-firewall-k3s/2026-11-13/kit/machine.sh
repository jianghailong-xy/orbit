#!/usr/bin/env bash
# machine.sh up | down | checkout <sha> | k3s-start | k3s-stop | k3s-wait: the lab's machine, a privileged docker:dind
# container with its own Docker, network namespace and iptables, which also runs k3s (the binary of the release,
# checked against its sha256sum-amd64.txt). k3s-stop kills the k3s process only, as systemd's KillMode=process does on
# `systemctl restart k3s`: pods keep running, k3s and its controllers start again over them.
set -euo pipefail
source /mnt/data/tmp/34wdoS/kit2/env.sh
cmd=$1; shift || true
on() { docker exec "$M" "$@"; }
case "$cmd" in
  up)
    mkdir -p "$K/m/docker" "$K/m/rancher" "$K/m/work"
    docker network inspect "$NET" >/dev/null 2>&1 || docker network create --subnet "$SUBNET" --label mrk3s=1 "$NET" >/dev/null
    docker rm -f "$M" >/dev/null 2>&1 || true
    docker run -d --name "$M" --hostname "$M" --privileged --label mrk3s=1 \
      --memory 6g --memory-swap 6g --cpus 6 --oom-score-adj 1000 \
      --network "$NET" --ip "$M_IP" --tmpfs /run:rw,exec,size=256m -e DOCKER_TLS_CERTDIR= \
      -v "$K/m/docker:/var/lib/docker" -v "$K/m/rancher:/var/lib/rancher" -v "$K/m/work:/work" \
      -v /root/orbit/.git:/repo.git:ro -v "$K/kit2:/kit:ro" -v "$K/bin/k3s:/usr/local/bin/k3s:ro" \
      "$DIND_IMAGE" >/dev/null
    for _ in $(seq 1 60); do on docker info >/dev/null 2>&1 && break; sleep 2; done
    on docker info --format "$M: Docker {{.ServerVersion}}, {{.Driver}}, {{.NCPU}} CPUs, {{.MemTotal}} bytes"
    on apk add -q --no-progress bash git openssl curl jq python3 iproute2 conntrack-tools >/dev/null
    on sh -c 'ip -4 -o addr show eth0; iptables --version'
    ;;
  down)
    docker rm -f $(docker ps -aq --filter label=mrk3s=1) >/dev/null 2>&1 || true
    docker network rm "$NET" >/dev/null 2>&1 || true
    docker run --rm -v "$K:/k" alpine:3 rm -rf /k/m >/dev/null 2>&1 || true
    ;;
  checkout)
    sha=$1
    docker exec -i "$M" bash -s "$sha" <<'SH'
set -euo pipefail
sha=$1
export GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=advice.detachedHead GIT_CONFIG_VALUE_0=false
if [ ! -d /work/orbit/.git ]; then
  mkdir -p /work/orbit
  git -C /work/orbit init -q
  echo /repo.git/objects > /work/orbit/.git/objects/info/alternates
  git -C /work/orbit config user.email lab@example.invalid
  git -C /work/orbit config user.name lab
fi
git -C /work/orbit checkout -q --detach "$sha"
git -C /work/orbit log --oneline -1
SH
    ;;
  k3s-start)
    on sh -c 'mkdir -p /var/log; echo "==== $(date -u +%FT%TZ) k3s server starting" >> /var/log/k3s.log'
    docker exec -d "$M" sh -c 'echo $$ > /run/k3s.pid; exec k3s server --node-ip '"$M_IP"' --disable traefik,servicelb,metrics-server --write-kubeconfig-mode 644 >> /var/log/k3s.log 2>&1'
    echo "$(date -u +%FT%TZ) k3s server started"
    ;;
  k3s-stop)
    on sh -c 'kill -TERM "$(cat /run/k3s.pid)"; for i in $(seq 1 60); do kill -0 "$(cat /run/k3s.pid)" 2>/dev/null || break; sleep 1; done'
    echo "$(date -u +%FT%TZ) k3s server stopped"
    ;;
  k3s-wait)
    for _ in $(seq 1 120); do
      on k3s kubectl get --raw /readyz >/dev/null 2>&1 && on sh -c 'k3s kubectl -n kube-system get pods -l k8s-app=kube-dns -o jsonpath="{.items[0].status.phase}" 2>/dev/null' | grep -q Running && break
      sleep 5
    done
    on k3s kubectl get nodes -o wide; on k3s kubectl get pods -A -o wide; on k3s kubectl get svc -A
    ;;
  *) echo "unknown $cmd" >&2; exit 2 ;;
esac
