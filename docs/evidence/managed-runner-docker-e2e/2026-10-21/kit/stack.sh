#!/usr/bin/env bash
# D4's isolated test stack on this host's own Docker (task 34hJ7RzpqTB13BmLR8uQv): the project line's apiserver with
# managed runners on its Docker backend, its own PostgreSQL, the restricted Docker channel and the managed runner
# image, all built from one commit (build-images.sh). Nothing listens on a LAN address: the apiserver and PostgreSQL
# on 127.0.0.1, the runners' door (forward.mjs) on the gateway address of the runners' own network. Each piece has
# a memory cap and runs outside the Orbit runner's cgroup: the containers in Docker's, the two node processes in
# transient systemd units of their own. No firewall service (D9's rules are not installed on this host).
#
#   stack.sh up            network, PostgreSQL (migrated), configuration, channel, apiserver, forwarder
#   stack.sh api-start | api-stop | api-kill | fwd-start | fwd-stop | channel-start | channel-stop | ps
#   stack.sh down          stop everything, remove this instance's runner containers and volumes, the stack's
#                          containers, volumes, network and images
set -euo pipefail
W=${D4_DIR:-/mnt/data/tmp/34hJ7RzpqTB13BmLR8uQv}
REPO=${D4_REPO:-/root/.orbit/worktrees/7423e624-0ae4-5ebc-9759-b34b6c0212c6}
K=$W/kit
MR=$W/mr
SECRETS=$W/secrets
NETWORK=d4-managed-runners
API_PORT=3714
PG_PORT=5714
DOOR_PORT=2714
TAG=d4-$(cut -c1-9 "$W/image/source-sha")
RUNNER_IMAGE=orbit-managed-runner:$TAG
CHANNEL_IMAGE=orbit-docker-channel:$TAG
NODE=/usr/local/bin/node
say() { printf '%s %s\n' "$(date -u +%H:%M:%S)" "$*"; }

gateway() { docker network inspect -f '{{range .IPAM.Config}}{{.Gateway}} {{end}}' "$NETWORK" | tr ' ' '\n' | grep -E '^[0-9.]+$' | head -1; }
instance() { python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["instanceId"])' "$MR/channel.json"; }

net_up() {
  if ! docker network inspect "$NETWORK" >/dev/null 2>&1; then
    # As scripts/install-server.sh makes orbit-managed-runners: a bridge with a route out, no inter-container traffic.
    docker network create --driver bridge --ipv6=false --opt com.docker.network.bridge.enable_icc=false \
      --label orbit.test=d4 "$NETWORK" >/dev/null
  fi
  say "network $NETWORK gateway $(gateway)"
}

pg_up() {
  ( umask 077 && mkdir -p "$SECRETS" )
  [ -s "$SECRETS/pg-password" ] || ( umask 077 && openssl rand -hex 16 >"$SECRETS/pg-password" )
  chmod 0644 "$SECRETS/pg-password"   # read inside the container by its postgres user; the directory stays 0700
  if ! docker inspect d4-pg >/dev/null 2>&1; then
    docker run -d --name d4-pg --label orbit.test=d4 --restart no --memory 512m --memory-swap 512m --cpus 1 \
      -p 127.0.0.1:$PG_PORT:5432 -e POSTGRES_USER=orbit -e POSTGRES_DB=orbit \
      -e POSTGRES_PASSWORD_FILE=/run/d4/pg-password -v "$SECRETS/pg-password:/run/d4/pg-password:ro" \
      --mount type=volume,source=d4-pgdata,target=/var/lib/postgresql/data,volume-label=orbit.test=d4 \
      postgres:16-alpine >/dev/null
  fi
  for _ in $(seq 60); do docker exec d4-pg pg_isready -U orbit -d orbit -q && break; sleep 1; done
  say "postgres ready on 127.0.0.1:$PG_PORT"
}

config() {
  [ -f "$MR/channel.json" ] && { say "configuration exists ($(instance))"; return; }
  local image_id gw inst
  image_id=$(docker image inspect -f '{{.Id}}' "$RUNNER_IMAGE")
  gw=$(gateway)
  inst="orbit-d4-$(openssl rand -hex 4)"
  ( umask 077 && mkdir -p "$MR" "$SECRETS" && openssl rand -hex 32 >"$MR/token" )
  chmod 700 "$MR"
  # The channel's limits and the profile follow scripts/install-server.sh; what differs is smaller per-runner
  # resources, a stated compute budget for four runners, and 2 GiB volumes, so the test fits this shared host.
  ( umask 077 && cat >"$MR/channel.json" <<EOF
{
  "schemaVersion": 1,
  "instanceId": "$inst",
  "listen": { "unixSocket": "/var/lib/orbit-managed-runners/channel.sock" },
  "tokenFile": "/var/lib/orbit-managed-runners/token",
  "dockerSocket": "/var/run/docker.sock",
  "stateDir": "/var/lib/orbit-managed-runners/state",
  "image": "$image_id",
  "network": "$NETWORK",
  "limits": {
    "maxCpuMillis": 1000,
    "maxMemoryBytes": 1073741824,
    "maxPids": 1024,
    "maxTmpBytes": 536870912,
    "maxVolumeBytes": 4294967296,
    "maxConcurrent": 2,
    "maxContainers": 4
  },
  "stopGraceSeconds": 240,
  "diskCheckSeconds": 120
}
EOF
  )
  ( umask 077 && cat >"$MR/profile.json" <<EOF
{
  "schemaVersion": 1,
  "valueKind": "actual",
  "backend": "docker",
  "environmentId": "$inst",
  "clusterKey": "$inst",
  "resourceProfileId": "docker-d4",
  "docker": {
    "instanceId": "$inst",
    "channel": { "socketPath": "$MR/channel.sock" },
    "tokenFile": "$MR/token"
  },
  "storage": { "capacity": "2Gi" },
  "runner": {
    "image": "$image_id",
    "serverUrl": "http://$gw:$DOOR_PORT",
    "maxConcurrent": 2,
    "tmpSizeLimit": "512Mi",
    "resources": { "cpu": "1", "memory": "1Gi", "pids": 1024 }
  },
  "capacity": { "compute": { "cpu": "4", "memory": "4Gi" } },
  "lifecycle": {
    "maxAttempts": 5,
    "backoffBaseSeconds": 10,
    "backoffMaxSeconds": 300,
    "startupDeadlineSeconds": 1800,
    "requestTimeoutSeconds": 60,
    "leaseSeconds": 60,
    "pollIntervalSeconds": 5,
    "heartbeatFreshSeconds": 120,
    "idleSeconds": 3600,
    "capacityRetrySeconds": 60,
    "drainSeconds": 600
  }
}
EOF
  )
  ( umask 077 && {
    echo "NODE_ENV=production"
    echo "PORT=$API_PORT"
    echo "DATABASE_URL=postgresql://orbit:$(cat "$SECRETS/pg-password")@127.0.0.1:$PG_PORT/orbit?schema=public"
    echo "JWT_SECRET=$(openssl rand -base64 32)"
    echo "PROVIDER_SECRET_KEY=$(openssl rand -base64 32)"
    echo "PUBLIC_ORIGIN=http://$gw:$DOOR_PORT"
    echo "CORS_ORIGINS=http://127.0.0.1:$API_PORT"
    echo "ORBIT_MANAGED_RUNNERS_ENABLED=true"
    echo "ORBIT_MANAGED_RUNNERS_PROFILE=$MR/profile.json"
  } >"$SECRETS/api.env" )
  say "configuration written: instance $inst, runner image $image_id, serverUrl http://$gw:$DOOR_PORT"
}

migrate() {
  ( set -a; . "$SECRETS/api.env"; set +a; cd "$REPO/src/apiserver" && "$REPO/node_modules/.bin/prisma" migrate deploy ) \
    >"$W/logs/migrate.txt" 2>&1
  say "migrated: $(grep -cE '^Applying migration|migrations? (have been )?applied' "$W/logs/migrate.txt" || true) lines; $(tail -1 "$W/logs/migrate.txt")"
}

channel_start() {
  docker rm -f d4-docker-channel >/dev/null 2>&1 || true
  # As root Compose's docker-channel: no network, the Docker socket, the managed runners' directory, and the disk
  # probe volume beside Docker's volumes; plus caps of its own.
  docker run -d --name d4-docker-channel --label orbit.test=d4 --restart no --network none \
    --memory 256m --memory-swap 256m --cpus 0.5 --pids-limit 256 \
    -v /var/run/docker.sock:/var/run/docker.sock -v "$MR:/var/lib/orbit-managed-runners" \
    --mount type=volume,source=d4-channel-probe,target=/var/lib/orbit-docker-volumes,readonly,volume-label=orbit.test=d4 \
    "$CHANNEL_IMAGE" serve --config /var/lib/orbit-managed-runners/channel.json \
    --disk-probe-path /var/lib/orbit-docker-volumes >/dev/null
  for _ in $(seq 30); do [ -S "$MR/channel.sock" ] && break; sleep 1; done
  say "channel up: $(docker inspect -f '{{.State.Status}} {{.Id}}' d4-docker-channel | cut -c1-24)"
}
channel_stop() { docker stop -t 10 d4-docker-channel >/dev/null 2>&1 || true; say "channel stopped"; }

api_start() {
  systemctl reset-failed d4-apiserver.service >/dev/null 2>&1 || true
  systemd-run --quiet --unit=d4-apiserver --collect -p MemoryMax=1536M -p MemorySwapMax=0 -p CPUQuota=200% \
    -p EnvironmentFile="$SECRETS/api.env" -p KillSignal=SIGTERM -p TimeoutStopSec=60 \
    -p StandardOutput=append:"$W/logs/apiserver.log" -p StandardError=append:"$W/logs/apiserver.log" \
    --working-directory="$REPO" "$NODE" -r "$K/loopback.cjs" src/apiserver/dist/main.js
  for _ in $(seq 90); do curl -s -o /dev/null "http://127.0.0.1:$API_PORT/api" && break; sleep 1; done
  say "apiserver: $(systemctl show -p ActiveState -p MainPID -p ControlGroup --value d4-apiserver | tr '\n' ' ')"
}
api_stop() { systemctl stop d4-apiserver.service 2>/dev/null || true; say "apiserver stopped (SIGTERM)"; }
api_kill() { systemctl kill -s SIGKILL d4-apiserver.service; sleep 1; systemctl stop d4-apiserver.service 2>/dev/null || true; say "apiserver killed (SIGKILL)"; }

fwd_start() {
  systemctl reset-failed d4-door.service >/dev/null 2>&1 || true
  systemd-run --quiet --unit=d4-door --collect -p MemoryMax=128M -p MemorySwapMax=0 -p CPUQuota=50% \
    -p StandardOutput=append:"$W/logs/door.log" -p StandardError=append:"$W/logs/door.log" \
    "$NODE" "$K/forward.mjs" "$(gateway)" "$DOOR_PORT" 127.0.0.1 "$API_PORT"
  sleep 1
  say "door: $(systemctl show -p ActiveState -p ControlGroup --value d4-door | tr '\n' ' ')"
}
fwd_stop() { systemctl stop d4-door.service 2>/dev/null || true; say "door stopped"; }

ps_stack() {
  docker ps -a --filter label=orbit.test=d4 --format '{{.Names}}\t{{.Status}}'
  [ -f "$MR/channel.json" ] && docker ps -a --filter "label=orbit.managed-runner.instance=$(instance)" --format '{{.Names}}\t{{.Status}}\t{{.Label "orbit.managed-runner.generation"}}'
  systemctl show -p Id -p ActiveState -p ControlGroup -p MemoryMax d4-apiserver d4-door 2>/dev/null | paste -sd' '
  ss -ltnH "( sport = :$API_PORT or sport = :$PG_PORT or sport = :$DOOR_PORT )" | awk '{print "listening", $4}'
}

down() {
  local inst=""
  [ -f "$MR/channel.json" ] && inst=$(instance)
  fwd_stop; api_stop; channel_stop
  if [ -n "$inst" ]; then
    docker ps -aq --filter "label=orbit.managed-runner.instance=$inst" | xargs -r docker rm -f >/dev/null
    docker volume ls -q --filter "label=orbit.managed-runner.instance=$inst" | xargs -r docker volume rm >/dev/null
  fi
  docker ps -aq --filter label=orbit.test=d4 | xargs -r docker rm -f >/dev/null
  docker volume ls -q --filter label=orbit.test=d4 | xargs -r docker volume rm >/dev/null
  docker network rm "$NETWORK" >/dev/null 2>&1 || true
  docker image rm "$RUNNER_IMAGE" "$CHANNEL_IMAGE" >/dev/null 2>&1 || true
  say "down: containers $(docker ps -aq --filter label=orbit.test=d4 | wc -l), runner containers $( [ -n "$inst" ] && docker ps -aq --filter "label=orbit.managed-runner.instance=$inst" | wc -l || echo 0), volumes $(docker volume ls -q --filter label=orbit.test=d4 | wc -l)+$( [ -n "$inst" ] && docker volume ls -q --filter "label=orbit.managed-runner.instance=$inst" | wc -l || echo 0)"
}

case "${1:-}" in
  up) net_up; pg_up; config; migrate; channel_start; api_start; fwd_start ;;
  net) net_up ;;
  pg) pg_up ;;
  config) config ;;
  migrate) migrate ;;
  channel-start) channel_start ;;
  channel-stop) channel_stop ;;
  api-start) api_start ;;
  api-stop) api_stop ;;
  api-kill) api_kill ;;
  fwd-start) fwd_start ;;
  fwd-stop) fwd_stop ;;
  ps) ps_stack ;;
  down) down ;;
  *) sed -n '2,14p' "$0"; exit 2 ;;
esac
