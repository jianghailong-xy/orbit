#!/usr/bin/env bash
# The lab's isolated test Orbit control plane, on the host: PostgreSQL in a container and the
# apiserver of this checkout as a transient unit, both on 127.0.0.1 only, plus a TLS front that
# the lab's Pods reach at https://10.0.2.2:LAB_TEST_TLS_PORT through the QEMU user network, with
# a lab-only CA, and fake-model.py (a stand-in model endpoint for model-free checks, reached at
# http://10.0.2.2:LAB_TEST_FAKE_MODEL_PORT). Everything runs outside the Orbit runner's cgroup with a
# memory cap, and keeps its data, secrets and logs in LAB_DIR/test-server. It never talks to a
# production server.
# Usage: test-server.sh start [--managed|--managed-false|--managed-false-no-profile]|stop|status|secrets
#   start   needs a built apiserver in this checkout (scripts/worktree-overlay.sh, then
#           npm run build -w @orbit/shared && npm run build -w @orbit/apiserver)
#   --managed   turn managed runners on (ORBIT_MANAGED_RUNNERS_ENABLED=true) with the manager
#           profile $S/managed-runner-profile.json, which single-writer.py writes; without it the
#           switch stays unset. Takes effect when the apiserver unit starts: stop first to change it.
#   --managed-false   the switch explicitly off (ORBIT_MANAGED_RUNNERS_ENABLED=false), the same
#           profile still named, so everything an enabled server would read is there (task T04)
#   --managed-false-no-profile   the switch explicitly off and no profile named: the server has no
#           Kubernetes or Ceph configuration at all (task T08)
#   secrets only creates the secrets and the lab CA (for an image that has to trust it)
# LAB_TEST_SERVER_DIR keeps a task's database, secrets and logs apart (default LAB_DIR/test-server).
set -euo pipefail
. "$(dirname "$0")/lib.sh"

REPO=$(cd "$LAB_SCRIPTS/../../.." && pwd)
S=${LAB_TEST_SERVER_DIR:-$LAB_DIR/test-server}
MANAGED=0
PG=orbit-mr-lab-pg
API=orbit-mr-lab-api
TLS=orbit-mr-lab-tls
FAKE=orbit-mr-lab-fake-model

secrets() {  # generated once; never printed
  umask 077
  mkdir -p "$S/secrets" "$S/pgdata" "$S/logs" "$S/home" "$S/tls"
  for name in pg-password jwt-secret provider-secret-key; do
    [ -s "$S/secrets/$name" ] || head -c 32 /dev/urandom | base64 | tr -d '/+=' > "$S/secrets/$name"
  done
  cat > "$S/secrets/api.env" <<EOF
DATABASE_URL=postgresql://orbit:$(cat "$S/secrets/pg-password")@127.0.0.1:$LAB_TEST_PG_PORT/orbit
JWT_SECRET=$(cat "$S/secrets/jwt-secret")
PROVIDER_SECRET_KEY=$(cat "$S/secrets/provider-secret-key")
PORT=$LAB_TEST_API_PORT
PUBLIC_ORIGIN=http://127.0.0.1:$LAB_TEST_API_PORT
CORS_ORIGINS=http://127.0.0.1:$LAB_TEST_API_PORT
MODEL_CATALOG_URL=http://127.0.0.1:9/models.json
ORBIT_RECAP_ENABLED=0
HOME=$S/home
PATH=/usr/local/bin:/usr/bin:/bin
LANG=C.UTF-8
NODE_ENV=production
EOF
  if [ "$MANAGED" = false-no-profile ]; then
    printf 'ORBIT_MANAGED_RUNNERS_ENABLED=false\n' >> "$S/secrets/api.env"
  elif [ "$MANAGED" = 1 ] || [ "$MANAGED" = false ]; then
    [ -s "$S/managed-runner-profile.json" ] || die "--managed needs $S/managed-runner-profile.json (single-writer.py profile)"
    printf 'ORBIT_MANAGED_RUNNERS_ENABLED=%s\nORBIT_MANAGED_RUNNERS_PROFILE=%s\n' "$([ "$MANAGED" = 1 ] && echo true || echo false)" \
      "$S/managed-runner-profile.json" >> "$S/secrets/api.env"
  fi
  # A lab-only CA and a server certificate for the address the Pods use (and loopback).
  if [ ! -s "$S/tls/server.pem" ]; then
    openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -days 90 \
      -subj "/CN=Orbit managed-runner lab test CA" -keyout "$S/tls/ca.key" -out "$S/tls/ca.crt" \
      -addext "basicConstraints=critical,CA:TRUE" -addext "keyUsage=critical,keyCertSign,cRLSign" 2>/dev/null
    openssl req -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -subj "/CN=orbit-mr-lab-test-server" \
      -keyout "$S/tls/server.key" -out "$S/tls/server.csr" 2>/dev/null
    printf 'subjectAltName=IP:10.0.2.2,IP:127.0.0.1\nextendedKeyUsage=serverAuth\nbasicConstraints=critical,CA:FALSE\n' \
      > "$S/tls/server.ext"
    openssl x509 -req -in "$S/tls/server.csr" -CA "$S/tls/ca.crt" -CAkey "$S/tls/ca.key" -CAcreateserial \
      -days 90 -extfile "$S/tls/server.ext" -out "$S/tls/server.crt" 2>/dev/null
    cat "$S/tls/server.crt" "$S/tls/server.key" > "$S/tls/server.pem"
    chmod 644 "$S/tls/ca.crt"
  fi
}

wait_http() {  # wait_http <url> <seconds>
  local deadline=$(( SECONDS + $2 ))
  until [ "$(curl -s -o /dev/null -w '%{http_code}' --cacert "$S/tls/ca.crt" "$1")" = 200 ]; do
    [ "$SECONDS" -lt "$deadline" ] || die "no answer from $1 within $2 s; see $S/logs"
    sleep 3
  done
}

start() {
  [ -f "$REPO/src/apiserver/dist/main.js" ] || die "build the apiserver in $REPO first (see the usage)"
  secrets
  if ! docker inspect -f '{{.State.Running}}' "$PG" 2>/dev/null | grep -q true; then
    docker rm "$PG" >/dev/null 2>&1 || true
    docker run -d --name "$PG" --label orbit.lab=test-server --memory 768m --memory-swap 1g \
      -p "127.0.0.1:$LAB_TEST_PG_PORT:5432" -e POSTGRES_USER=orbit -e POSTGRES_DB=orbit \
      -e POSTGRES_PASSWORD="$(cat "$S/secrets/pg-password")" -v "$S/pgdata:/var/lib/postgresql/data" \
      postgres:16-alpine >/dev/null
  fi
  local deadline=$(( SECONDS + 120 ))
  until docker exec "$PG" pg_isready -q -U orbit -h 127.0.0.1; do
    [ "$SECONDS" -lt "$deadline" ] || die "PostgreSQL did not start; docker logs $PG"
    sleep 2
  done
  say "applying migrations"
  ( cd "$REPO/src/apiserver" && systemd-run --scope --quiet -p MemoryMax=2G \
      env -i PATH=/usr/local/bin:/usr/bin:/bin HOME="$S/home" \
      DATABASE_URL="$(sed -n 's/^DATABASE_URL=//p' "$S/secrets/api.env")" \
      node "$(node -p 'require.resolve("prisma/build/index.js")')" migrate deploy ) >> "$S/logs/migrate.log" 2>&1 \
    || die "migrate deploy failed; see $S/logs/migrate.log"
  if ! systemctl is-active --quiet "$API"; then
    systemd-run --unit="$API" --collect --quiet -p MemoryMax=1536M -p OOMScoreAdjust=900 \
      -p EnvironmentFile="$S/secrets/api.env" -p WorkingDirectory="$S/home" \
      -p StandardOutput=append:"$S/logs/apiserver.log" -p StandardError=append:"$S/logs/apiserver.log" \
      /usr/local/bin/node --require "$REPO/src/android/scripts/a11-stack/loopback-only.cjs" \
      "$REPO/src/apiserver/dist/main.js"
  fi
  if ! systemctl is-active --quiet "$TLS"; then
    systemd-run --unit="$TLS" --collect --quiet -p MemoryMax=256M \
      -p StandardOutput=append:"$S/logs/tls.log" -p StandardError=append:"$S/logs/tls.log" \
      /usr/bin/socat "OPENSSL-LISTEN:$LAB_TEST_TLS_PORT,bind=127.0.0.1,reuseaddr,fork,cert=$S/tls/server.pem,verify=0" \
      "TCP:127.0.0.1:$LAB_TEST_API_PORT"
  fi
  if ! systemctl is-active --quiet "$FAKE"; then
    systemd-run --unit="$FAKE" --collect --quiet -p MemoryMax=128M \
      -p StandardOutput=append:"$S/logs/fake-model.out" -p StandardError=append:"$S/logs/fake-model.out" \
      /usr/bin/python3 -I "$LAB_SCRIPTS/fake-model.py" "$LAB_TEST_FAKE_MODEL_PORT" "$S/logs/fake-model.jsonl"
  fi
  wait_http "http://127.0.0.1:$LAB_TEST_API_PORT/api/health" 300
  wait_http "https://127.0.0.1:$LAB_TEST_TLS_PORT/api/health" 30
  status
}

stop() {
  systemctl stop "$FAKE" "$TLS" "$API" 2>/dev/null || true
  docker stop "$PG" >/dev/null 2>&1 || true
  say "stopped; data kept in $S"
}

status() {
  echo "apiserver ($API): $(systemctl is-active "$API" 2>/dev/null || true), source $(git -C "$REPO" rev-parse HEAD)"
  echo "TLS front ($TLS): $(systemctl is-active "$TLS" 2>/dev/null || true)"
  echo "fake model ($FAKE): $(systemctl is-active "$FAKE" 2>/dev/null || true)"
  echo "PostgreSQL ($PG): $(docker inspect -f '{{.State.Status}}' "$PG" 2>/dev/null || echo absent)"
  echo "listening: $(ss -Hltn | awk -v a=":$LAB_TEST_API_PORT" -v b=":$LAB_TEST_TLS_PORT" -v c=":$LAB_TEST_PG_PORT" \
    -v d=":$LAB_TEST_FAKE_MODEL_PORT" '$4 ~ a"$" || $4 ~ b"$" || $4 ~ c"$" || $4 ~ d"$" {print $4}' | sort | xargs)"
  echo "Pods use: https://10.0.2.2:$LAB_TEST_TLS_PORT (CA $S/tls/ca.crt); host API http://127.0.0.1:$LAB_TEST_API_PORT/api"
  echo "state: $S; managed runners: $(sed -n 's/^ORBIT_MANAGED_RUNNERS_ENABLED=//p' "$S/secrets/api.env" 2>/dev/null | grep . || echo unset)"
}

require_root
case "${1:-}" in
  start)
    case "${2:-}" in
      --managed) MANAGED=1 ;;
      --managed-false) MANAGED=false ;;
      --managed-false-no-profile) MANAGED=false-no-profile ;;
      "") ;;
      *) die "usage: test-server.sh start [--managed|--managed-false|--managed-false-no-profile]" ;;
    esac
    start ;;
  stop) stop ;;
  status) status ;;
  secrets) secrets ;;
  *) die "usage: test-server.sh start [--managed|--managed-false|--managed-false-no-profile]|stop|status|secrets" ;;
esac
