#!/usr/bin/env bash
# The isolated real stack of the long-running-loop drill (docs/long-running-loop-contract.md; task E of project
# 34pUaJboWdDFzjftkEso8). Everything is this checkout's code and runs on 127.0.0.1, outside the Orbit runner's cgroup:
#
#   - PostgreSQL 16 in a container (orbit-lrl-pg), its data under LRL_DIR;
#   - the apiserver (unit orbit-lrl-api), started with NODE_OPTIONS=--require of two preloads: the a11 stack's
#     loopback-only.cjs, and push-recorder.cjs, which wraps PushService.prototype.notifyLoopMissed in that same process
#     and appends every call to LRL_DIR/logs/push-calls.jsonl before calling the original. No product code changes;
#     the PushService the worker calls is the one Nest's dependency injection handed it;
#   - fake-model.py (unit orbit-lrl-fake-model), the lab's Anthropic-dialect stand-in: no model, no key;
#   - the drill's runners (units orbit-lrl-runner-NAME): this checkout's runner-go, driving a copy of the host's
#     Claude Code against fake-model.py, each with its own HOME and ORBIT_HOME, under KillMode=mixed like the host's
#     orbit-runner-root.service, so `runner-kill` (SIGKILL to the main pid) takes the engines and jobs with it as a
#     real runner death does. No Restart=: a killed runner stays down until `runner-start`.
#
# It never talks to a production server: the runners' config.json names the isolated apiserver, and the provider
# key the drill makes names fake-model.py.
#
# Usage: stack.sh build | start | stop | status | runner-start NAME | runner-kill NAME | runner-stop NAME | down
#   build          worktree overlay, shared + apiserver build, runner-go build, a copy of the host's claude
#   start          secrets, PostgreSQL, migrations, apiserver, fake model; waits for /api/health
#   runner-kill    SIGKILL to the runner unit's main pid; prints what the unit's cgroup held just before
#   down           stop everything and remove the PostgreSQL container (the data dir is kept)
# Environment: LRL_DIR (default /mnt/data/tmp/lrle: short, a session's bg.sock path must stay under 100 bytes),
#   LRL_PG_PORT (15733), LRL_API_PORT (13910), LRL_FAKE_PORT (13912).
set -euo pipefail

REPO=$(cd "$(dirname "$0")/../.." && pwd)
LRL_DIR=${LRL_DIR:-/mnt/data/tmp/lrle}
PG_PORT=${LRL_PG_PORT:-15733}
API_PORT=${LRL_API_PORT:-13910}
FAKE_PORT=${LRL_FAKE_PORT:-13912}
PG=orbit-lrl-pg
API=orbit-lrl-api
FAKE=orbit-lrl-fake-model

say() { printf '%s %s\n' "$(date -u +%FT%T.%3NZ)" "$*" >&2; }
die() { say "error: $*"; exit 1; }
[ "$(id -u)" -eq 0 ] || die "run as root: systemd-run needs it"

runner_unit() { echo "orbit-lrl-runner-$1"; }
runner_dir() { echo "$LRL_DIR/r/$1"; }
check_name() { [[ "$1" =~ ^[a-z][a-z0-9]{0,7}$ ]] || die "runner NAME: a short lowercase word"; }

build() {
  mkdir -p "$LRL_DIR/bin" "$LRL_DIR/logs"
  chmod 700 "$LRL_DIR"
  say "worktree overlay"
  (cd "$REPO" && bash scripts/worktree-overlay.sh) > "$LRL_DIR/logs/build-overlay.log" 2>&1 \
    || die "worktree-overlay.sh failed; see $LRL_DIR/logs/build-overlay.log"
  say "shared + apiserver build"
  (cd "$REPO" && systemd-run --scope --quiet -p MemoryMax=3G -- bash -c \
    'npm run build -w @orbit/shared && npm run build -w @orbit/apiserver') > "$LRL_DIR/logs/build-node.log" 2>&1 \
    || die "the apiserver build failed; see $LRL_DIR/logs/build-node.log"
  say "runner-go build"
  local head
  head=$(git -C "$REPO" rev-parse HEAD)
  (cd "$REPO/src/runner-go" && systemd-run --scope --quiet -p MemoryMax=3G -- env GOFLAGS=-buildvcs=false CGO_ENABLED=0 \
    go build -trimpath -ldflags "-X main.version=lrl-drill-${head:0:12}" -o "$LRL_DIR/bin/orbit.new" .) \
    > "$LRL_DIR/logs/build-go.log" 2>&1 || die "go build failed; see $LRL_DIR/logs/build-go.log"
  mv "$LRL_DIR/bin/orbit.new" "$LRL_DIR/bin/orbit"
  local claude
  claude=$(readlink -f /root/.local/bin/claude)
  cp "$claude" "$LRL_DIR/bin/claude.new" && mv "$LRL_DIR/bin/claude.new" "$LRL_DIR/bin/claude"
  python3 - "$LRL_DIR/build.json" "$head" "$claude" "$("$LRL_DIR/bin/claude" --version 2>/dev/null | head -1)" \
    "$(sha256sum "$LRL_DIR/bin/orbit" | cut -c1-64)" <<'EOF'
import json, sys, time
path, head, claude, version, digest = sys.argv[1:]
json.dump({'builtAt': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()), 'source': head, 'runnerSha256': digest,
           'claudeFrom': claude, 'claudeVersion': version}, open(path, 'w'), indent=2)
EOF
  cat "$LRL_DIR/build.json"
}

secrets() {  # generated once; never printed
  umask 077
  mkdir -p "$LRL_DIR/secrets" "$LRL_DIR/pgdata" "$LRL_DIR/logs" "$LRL_DIR/home"
  for name in pg-password jwt-secret provider-secret-key; do
    [ -s "$LRL_DIR/secrets/$name" ] || head -c 32 /dev/urandom | base64 | tr -d '/+=' > "$LRL_DIR/secrets/$name"
  done
  cat > "$LRL_DIR/secrets/api.env" <<EOF
DATABASE_URL=postgresql://orbit:$(cat "$LRL_DIR/secrets/pg-password")@127.0.0.1:$PG_PORT/orbit
JWT_SECRET=$(cat "$LRL_DIR/secrets/jwt-secret")
PROVIDER_SECRET_KEY=$(cat "$LRL_DIR/secrets/provider-secret-key")
PORT=$API_PORT
PUBLIC_ORIGIN=http://127.0.0.1:$API_PORT
CORS_ORIGINS=http://127.0.0.1:$API_PORT
MODEL_CATALOG_URL=http://127.0.0.1:9/models.json
ORBIT_RECAP_ENABLED=0
HOME=$LRL_DIR/home
PATH=/usr/local/bin:/usr/bin:/bin
LANG=C.UTF-8
NODE_ENV=production
NO_COLOR=1
NODE_OPTIONS=--require $REPO/src/android/scripts/a11-stack/loopback-only.cjs --require $REPO/scripts/long-running-loops/push-recorder.cjs
ORBIT_PUSH_RECORD_FILE=$LRL_DIR/logs/push-calls.jsonl
EOF
}

wait_http() {  # wait_http <url> <seconds>
  local deadline=$(( SECONDS + $2 ))
  until [ "$(curl -s -o /dev/null -w '%{http_code}' "$1")" = 200 ]; do
    [ "$SECONDS" -lt "$deadline" ] || die "no answer from $1 within $2 s; see $LRL_DIR/logs"
    sleep 3
  done
}

start() {
  [ -f "$REPO/src/apiserver/dist/main.js" ] || die "build first: stack.sh build"
  secrets
  if ! docker inspect -f '{{.State.Running}}' "$PG" 2>/dev/null | grep -q true; then
    docker rm "$PG" >/dev/null 2>&1 || true
    docker run -d --name "$PG" --label orbit.lrl=drill --memory 768m --memory-swap 1g \
      -p "127.0.0.1:$PG_PORT:5432" -e POSTGRES_USER=orbit -e POSTGRES_DB=orbit \
      -e POSTGRES_PASSWORD="$(cat "$LRL_DIR/secrets/pg-password")" -v "$LRL_DIR/pgdata:/var/lib/postgresql/data" \
      postgres:16-alpine >/dev/null
  fi
  local deadline=$(( SECONDS + 120 ))
  until docker exec "$PG" pg_isready -q -U orbit -h 127.0.0.1; do
    [ "$SECONDS" -lt "$deadline" ] || die "PostgreSQL did not start; docker logs $PG"
    sleep 2
  done
  say "applying migrations"
  ( cd "$REPO/src/apiserver" && systemd-run --scope --quiet -p MemoryMax=2G \
      env -i PATH=/usr/local/bin:/usr/bin:/bin HOME="$LRL_DIR/home" \
      DATABASE_URL="$(sed -n 's/^DATABASE_URL=//p' "$LRL_DIR/secrets/api.env")" \
      node "$(node -p 'require.resolve("prisma/build/index.js")')" migrate deploy ) >> "$LRL_DIR/logs/migrate.log" 2>&1 \
    || die "migrate deploy failed; see $LRL_DIR/logs/migrate.log"
  if ! systemctl is-active --quiet "$API"; then
    systemd-run --unit="$API" --collect --quiet -p MemoryMax=1536M -p OOMScoreAdjust=900 \
      -p EnvironmentFile="$LRL_DIR/secrets/api.env" -p WorkingDirectory="$LRL_DIR/home" \
      -p StandardOutput=append:"$LRL_DIR/logs/apiserver.log" -p StandardError=append:"$LRL_DIR/logs/apiserver.log" \
      /usr/local/bin/node "$REPO/src/apiserver/dist/main.js"
  fi
  if ! systemctl is-active --quiet "$FAKE"; then
    systemd-run --unit="$FAKE" --collect --quiet -p MemoryMax=192M \
      -p StandardOutput=append:"$LRL_DIR/logs/fake-model.out" -p StandardError=append:"$LRL_DIR/logs/fake-model.out" \
      /usr/bin/python3 -I "$REPO/scripts/managed-runner/lab/fake-model.py" "$FAKE_PORT" "$LRL_DIR/logs/fake-model.jsonl"
  fi
  wait_http "http://127.0.0.1:$API_PORT/api/health" 300
  status
}

runner_start() {
  check_name "$1"
  local unit dir
  unit=$(runner_unit "$1")
  dir=$(runner_dir "$1")
  [ -s "$dir/oh/config.json" ] || die "runner $1 is not registered yet ($dir/oh/config.json); drill.py setup writes it"
  systemctl is-active --quiet "$unit" && { say "$unit is already running"; return; }
  # The engine's environment is the runner's: no self-update, no engine updates, no telemetry. HOME holds the
  # engine's own settings (drill.py writes them), ORBIT_HOME the runner's config, run scratch and job records.
  systemd-run --unit="$unit" --collect --quiet -p MemoryMax=2G -p OOMScoreAdjust=900 \
    -p KillMode=mixed -p TimeoutStopSec=180 -p WorkingDirectory="$dir" \
    -p Environment=HOME="$dir/home" -p Environment=ORBIT_HOME="$dir/oh" -p Environment=PATH="$LRL_DIR/bin:/usr/bin:/bin" \
    -p Environment=LANG=C.UTF-8 -p Environment=ORBIT_NO_SELFUPDATE=1 -p Environment=ORBIT_NO_ENGINE_UPDATE=1 \
    -p Environment=DISABLE_AUTOUPDATER=1 -p Environment=CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 \
    -p StandardOutput=append:"$dir/runner.log" -p StandardError=append:"$dir/runner.log" \
    "$LRL_DIR/bin/orbit" run
  say "started $unit (main pid $(systemctl show -P MainPID "$unit"))"
}

runner_kill() {
  check_name "$1"
  local unit pid cg
  unit=$(runner_unit "$1")
  pid=$(systemctl show -P MainPID "$unit")
  [ -n "$pid" ] && [ "$pid" != 0 ] || die "$unit has no main pid (not running)"
  cg=/sys/fs/cgroup$(systemctl show -P ControlGroup "$unit")
  echo "before: $(date -u +%FT%T.%3NZ) unit $unit main pid $pid; its cgroup holds:"
  for p in $(cat "$cg/cgroup.procs"); do ps -o pid=,ppid=,etimes=,args= -p "$p" 2>/dev/null | cut -c1-200; done
  kill -9 "$pid"
  echo "killed: $(date -u +%FT%T.%3NZ) SIGKILL to pid $pid"
  # systemd ends what the main pid left in the unit's cgroup (KillMode=mixed), then collects the unit.
  local deadline=$(( SECONDS + 60 )) state
  while state=$(systemctl show -P ActiveState "$unit" 2>/dev/null) && [ "$state" = active ] || [ "$state" = deactivating ]; do
    [ "$SECONDS" -lt "$deadline" ] || die "$unit is still $state 60 s after the kill"
    sleep 0.5
  done
  echo "after: $(date -u +%FT%T.%3NZ) unit $unit is ${state:-gone}; left in its cgroup: $(cat "$cg/cgroup.procs" 2>/dev/null | xargs || true)"
}

runner_stop() {
  check_name "$1"
  systemctl stop "$(runner_unit "$1")" 2>/dev/null || true
}

stop() {
  for unit in $(systemctl list-units --plain --no-legend 'orbit-lrl-runner-*' | awk '{print $1}'); do
    systemctl stop "$unit" || true
  done
  systemctl stop "$FAKE" "$API" 2>/dev/null || true
  docker stop "$PG" >/dev/null 2>&1 || true
  say "stopped; data kept in $LRL_DIR"
}

status() {
  echo "apiserver ($API): $(systemctl is-active "$API" 2>/dev/null || true), source $(git -C "$REPO" rev-parse HEAD)"
  echo "fake model ($FAKE): $(systemctl is-active "$FAKE" 2>/dev/null || true)"
  echo "PostgreSQL ($PG): $(docker inspect -f '{{.State.Status}}' "$PG" 2>/dev/null || echo absent)"
  for unit in $(systemctl list-units --plain --no-legend --all 'orbit-lrl-runner-*' | awk '{print $1}'); do
    echo "runner $unit: $(systemctl is-active "$unit" 2>/dev/null || true), main pid $(systemctl show -P MainPID "$unit")"
  done
  echo "listening: $(ss -Hltn | awk -v a=":$API_PORT" -v b=":$PG_PORT" -v c=":$FAKE_PORT" \
    '$4 ~ a"$" || $4 ~ b"$" || $4 ~ c"$" {print $4}' | sort | xargs)"
  echo "state: $LRL_DIR; API http://127.0.0.1:$API_PORT/api"
}

case "${1:-}" in
  build) build ;;
  start) start ;;
  stop) stop ;;
  status) status ;;
  runner-start) runner_start "${2:?NAME}" ;;
  runner-kill) runner_kill "${2:?NAME}" ;;
  runner-stop) runner_stop "${2:?NAME}" ;;
  down) stop; docker rm "$PG" >/dev/null 2>&1 || true ;;
  *) die "usage: stack.sh build|start|stop|status|runner-start NAME|runner-kill NAME|runner-stop NAME|down" ;;
esac
