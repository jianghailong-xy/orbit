#!/usr/bin/env bash
# lab-server.sh: the server machine of the multi-host lab, once both channel machines' kits are installed.
#   1. two Cloudflare quick tunnels from the HPC host: the server's gateway and the fake model, each at a public
#      https://<random>.trycloudflare.com (the runners' firewall refuses every private address, and a remote profile
#      needs an https runner.serverUrl);
#   2. the server's images, built on the HPC host from the lab's commit, loaded here;
#   3. scripts/install-server.sh --no-managed-runners at that origin, then managed runners switched on in .env without
#      the managed-runners-docker profile, both channels' tokens copied over, and profile.json (kit/profile.sh) naming
#      channel A alone;
#   4. the stack up, the fake model running here.
set -euo pipefail
source /mnt/data/tmp/34w2jFb/kit/env.sh
t() { echo "==> $(date -u +%FT%TZ) $*"; }
o() { docker exec -i -w /work/orbit "$SERVER" "$@"; }

tunnel() {  # tunnel <name> <origin>: prints its public https origin
  local name=$1 origin=$2 url=""
  if [ "$(docker inspect -f '{{.State.Running}}' "$name" 2>/dev/null)" = true ]; then
    url="$(docker logs "$name" 2>&1 | grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' | head -1 || true)"
    if [ -n "$url" ]; then echo "$url"; return 0; fi
  fi
  docker rm -f "$name" >/dev/null 2>&1 || true
  docker run -d --name "$name" --label mrmh=1 --network "$NET" cloudflare/cloudflared:latest \
    tunnel --no-autoupdate --url "$origin" >/dev/null
  for _ in $(seq 1 60); do
    url="$(docker logs "$name" 2>&1 | grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' | head -1 || true)"
    [ -n "$url" ] && break
    sleep 2
  done
  [ -n "$url" ] || { docker logs "$name" >&2; return 1; }
  echo "$url"
}

t "tunnels"
SERVER_URL="$(tunnel mrmh-tunnel-server "http://$SERVER_IP:2086")"
FAKE_URL="$(tunnel mrmh-tunnel-fake "http://$SERVER_IP:$FAKE_PORT")"
printf 'SERVER_URL=%s\nFAKE_URL=%s\n' "$SERVER_URL" "$FAKE_URL" | tee "$K/tunnels.env"

t "the server's images"
docker exec -i "$SERVER" docker load -q < "$K/server-images.tar"
docker exec "$SERVER" docker tag mrmh-apiserver:local orbit-apiserver:local
docker exec "$SERVER" docker tag mrmh-web:latest orbit-web:latest

t "install-server.sh --no-managed-runners --public-origin $SERVER_URL --no-start"
o scripts/install-server.sh --no-managed-runners --public-origin "$SERVER_URL" --no-start

t "managed runners on, the channel machines remote"
o sh -c 'sed -i "s/^ORBIT_MANAGED_RUNNERS_ENABLED=false$/ORBIT_MANAGED_RUNNERS_ENABLED=true/" .env
  echo ORBIT_MANAGED_RUNNERS_DIR=./data/managed-runners >> .env
  grep -nE "^(ORBIT_MANAGED_RUNNERS_|COMPOSE_PROFILES)" .env'
o sh -c 'umask 077 && mkdir -p data/managed-runners && chmod 700 data/managed-runners'
for pair in "$CHAN_A:$INST_A" "$CHAN_B:$INST_B"; do
  chan=${pair%%:*} inst=${pair#*:}
  [ "$(docker exec "$chan" jq -r .instanceId /work/orbit/data/channel-host/channel.json)" = "$inst" ]
  docker exec "$chan" cat /work/orbit/data/channel-host/token | o sh -c "umask 077 && cat > data/managed-runners/$inst.token"
done
$K/kit/profile.sh --no-recreate a

t "the fake model (not a model), on the server machine's port $FAKE_PORT"
docker exec -d "$SERVER" sh -c "python3 /kit/fake-model.py $FAKE_PORT /work/fake-model.jsonl > /work/fake-model.out 2>&1"

t "the stack, from the loaded images"
o docker compose up -d --no-build --wait --wait-timeout 600
o docker compose ps --format '{{.Service}}: {{.Status}}'
o sh -c 'docker compose logs apiserver 2>&1 | grep -E "managed runners are" | tail -3'
t "server done"
