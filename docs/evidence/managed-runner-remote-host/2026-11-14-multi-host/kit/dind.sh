#!/usr/bin/env bash
# dind.sh up <server|a|b> | down | checkout <machine> <sha>: the lab's machines, each its own Docker (data root and /work
# under $K/<machine>), on $NET at a fixed private address. `down` removes all of them, their data and the tunnels.
set -euo pipefail
source /mnt/data/tmp/34w2jFb/kit/env.sh
cmd=$1; shift
case "$cmd" in
  up)
    which=$1
    case "$which" in
      server) name=$SERVER ip=$SERVER_IP mem=5g cpus=6 ;;
      a) name=$CHAN_A ip=$CHAN_A_IP mem=5g cpus=6 ;;
      b) name=$CHAN_B ip=$CHAN_B_IP mem=5g cpus=6 ;;
      *) echo "server, a or b" >&2; exit 2 ;;
    esac
    mkdir -p "$K/$which/docker" "$K/$which/work"
    docker network inspect "$NET" >/dev/null 2>&1 || docker network create --subnet "$SUBNET" --label mrmh=1 "$NET" >/dev/null
    docker rm -f "$name" >/dev/null 2>&1 || true
    docker run -d --name "$name" --hostname "$name" --privileged --label mrmh=1 \
      --memory "$mem" --memory-swap "$mem" --cpus "$cpus" --oom-score-adj 1000 \
      --network "$NET" --ip "$ip" --tmpfs /run:rw,exec,size=256m -e DOCKER_TLS_CERTDIR= \
      -v "$K/$which/docker:/var/lib/docker" -v "$K/$which/work:/work" -v /root/orbit/.git:/repo.git:ro -v "$K/kit:/kit:ro" \
      "$DIND_IMAGE" >/dev/null
    for _ in $(seq 1 60); do docker exec "$name" docker info >/dev/null 2>&1 && break; sleep 2; done
    docker exec "$name" docker info --format "$name: Docker {{.ServerVersion}}, {{.Driver}}, {{.NCPU}} CPUs, {{.MemTotal}} bytes"
    docker exec "$name" apk add -q --no-progress bash git openssl curl jq python3 iproute2 >/dev/null
    docker exec "$name" sh -c 'ip -4 -o addr show eth0'
    ;;
  down)
    docker rm -f $(docker ps -aq --filter label=mrmh=1) >/dev/null 2>&1 || true
    docker network rm "$NET" >/dev/null 2>&1 || true
    docker run --rm -v "$K:/k" alpine:3 rm -rf /k/server /k/a /k/b >/dev/null 2>&1 || true
    ;;
  checkout)
    name=$1 sha=$2
    docker exec -i "$name" bash -s "$sha" <<'SH'
set -euo pipefail
sha=$1
export GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=advice.detachedHead GIT_CONFIG_VALUE_0=false
if [ ! -d /work/orbit/.git ]; then
  mkdir -p /work/orbit
  git -C /work/orbit init -q
  echo /repo.git/objects > /work/orbit/.git/objects/info/alternates
  git -C /work/orbit config user.email lab@example.invalid
  git -C /work/orbit config user.name lab
  git -C /work/orbit remote add origin /repo.git
fi
git -C /work/orbit checkout -q --detach "$sha"
git -C /work/orbit log --oneline -1
SH
    ;;
  *) echo "unknown $cmd" >&2; exit 2 ;;
esac
