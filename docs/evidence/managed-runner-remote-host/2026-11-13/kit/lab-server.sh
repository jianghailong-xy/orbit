#!/usr/bin/env bash
# lab-server.sh: the server machine of the two-host lab, once the channel machine's kit is installed.
#   1. two Cloudflare quick tunnels from the HPC host: the server's gateway and the fake model, each at a public
#      https://<random>.trycloudflare.com (the runners' firewall refuses every private address, and a remote profile
#      needs an https runner.serverUrl);
#   2. the server's images, built on the HPC host from the lab's commit, loaded here;
#   3. scripts/install-server.sh --no-managed-runners at that origin, then managed runners switched on in .env without
#      the managed-runners-docker profile, and data/managed-runners/profile.json naming the channel machine alone
#      (docker.hosts, "image": "channel"), with its token copied over;
#   4. the stack up, the fake model running here.
set -euo pipefail
source /mnt/data/tmp/34w2jF/kit/env.sh
t() { echo "==> $(date -u +%FT%TZ) $*"; }
o() { docker exec -i -w /work/orbit "$SERVER" "$@"; }

tunnel() {  # tunnel <name> <origin>: prints its public https origin
  local name=$1 origin=$2 url=""
  if [ "$(docker inspect -f '{{.State.Running}}' "$name" 2>/dev/null)" = true ]; then
    url="$(docker logs "$name" 2>&1 | grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' | head -1 || true)"
    if [ -n "$url" ]; then echo "$url"; return 0; fi
  fi
  docker rm -f "$name" >/dev/null 2>&1 || true
  docker run -d --name "$name" --label mrrh=1 --network "$NET" cloudflare/cloudflared:latest \
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
SERVER_URL="$(tunnel mrrh-tunnel-server "http://$SERVER_IP:2086")"
FAKE_URL="$(tunnel mrrh-tunnel-fake "http://$SERVER_IP:$FAKE_PORT")"
printf 'SERVER_URL=%s\nFAKE_URL=%s\n' "$SERVER_URL" "$FAKE_URL" | tee "$K/tunnels.env"

t "the server's images"
docker exec -i "$SERVER" docker load -q < "$K/server-images.tar"
docker exec "$SERVER" docker tag mrrh-apiserver:local orbit-apiserver:local
docker exec "$SERVER" docker tag mrrh-web:latest orbit-web:latest

t "install-server.sh --no-managed-runners --public-origin $SERVER_URL --no-start"
o scripts/install-server.sh --no-managed-runners --public-origin "$SERVER_URL" --no-start

t "managed runners on, on the channel machine alone"
INSTANCE="$(docker exec "$CHAN" jq -r .instanceId /work/orbit/data/channel-host/channel.json)"
o sh -c 'sed -i "s/^ORBIT_MANAGED_RUNNERS_ENABLED=false$/ORBIT_MANAGED_RUNNERS_ENABLED=true/" .env
  echo ORBIT_MANAGED_RUNNERS_DIR=./data/managed-runners >> .env
  grep -nE "^(ORBIT_MANAGED_RUNNERS_|COMPOSE_PROFILES)" .env'
o sh -c 'umask 077 && mkdir -p data/managed-runners && chmod 700 data/managed-runners'
docker exec "$CHAN" cat /work/orbit/data/channel-host/token | o sh -c "umask 077 && cat > data/managed-runners/$INSTANCE.token"
o sh -c "umask 077 && cat > data/managed-runners/profile.json" <<EOF
{
  "schemaVersion": 1,
  "valueKind": "actual",
  "backend": "docker",
  "environmentId": "mrrh-lab",
  "clusterKey": "mrrh-lab",
  "resourceProfileId": "docker-default",
  "docker": {
    "hosts": [
      { "instanceId": "$INSTANCE", "channel": { "url": "http://$CHAN_IP:$CHAN_PORT" }, "tokenFile": "/var/lib/orbit-managed-runners/$INSTANCE.token" }
    ]
  },
  "storage": { "capacity": "5Gi" },
  "runner": {
    "image": "channel",
    "serverUrl": "$SERVER_URL",
    "maxConcurrent": 2,
    "tmpSizeLimit": "512Mi",
    "resources": { "cpu": "1", "memory": "2Gi", "pids": 4096 }
  },
  "lifecycle": {
    "maxAttempts": 5, "backoffBaseSeconds": 10, "backoffMaxSeconds": 300, "startupDeadlineSeconds": 1800,
    "requestTimeoutSeconds": 60, "leaseSeconds": 60, "pollIntervalSeconds": 5, "heartbeatFreshSeconds": 120,
    "idleSeconds": 3600, "capacityRetrySeconds": 60, "drainSeconds": 600
  }
}
EOF
o ls -la data/managed-runners

t "the fake model (not a model), on the server machine's port $FAKE_PORT"
docker exec "$SERVER" sh -c "pgrep -f fake-model.py >/dev/null || nohup python3 /kit/fake-model.py $FAKE_PORT /work/fake-model.jsonl > /work/fake-model.out 2>&1 &"

t "the stack, from the loaded images"
o docker compose up -d --no-build --wait --wait-timeout 600
o docker compose ps --format '{{.Service}}: {{.Status}}'
o sh -c 'docker compose logs apiserver 2>&1 | grep -E "managed runners are" | tail -3'
t "server done"
