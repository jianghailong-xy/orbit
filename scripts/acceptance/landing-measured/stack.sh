#!/usr/bin/env bash
# The isolated stack for the revision 42 part two end-to-end runs (docs/project-integration-line-contract.md §12.15),
# loopback only, never production.
#
# The server side is scripts/runner-link/staging-up.sh under a Compose project of its own: postgres, the apiserver, web,
# the web gateway, the link gateway and NATS, every image built from this checkout. A real runner needs the link
# gateway (a plain apiserver answers its heartbeat 426), which is why this is not the older single-process kits. The
# runner is `go build` of this checkout's src/runner-go, registered with `orbit register --no-service` and run as a host
# process in a private mount namespace (/root hidden), under `env -i`, whose PATH holds no engine but ./fake-claude.
#
#   stack.sh up [--no-build]     start or converge the server stack (staging-up.sh)
#   stack.sh build-runner        go build src/runner-go into $LM_DIR/bin/orbit
#   stack.sh repo <name>         a bare origin $LM_DIR/origin/<name>.git and the runner's clone $LM_DIR/work/<name>
#   stack.sh register <token>    orbit register against the stack (fresh ORBIT_HOME)
#   stack.sh start-runner | stop-runner | kill-runner (SIGKILL, no drain)
#   stack.sh psql <sql> [x]      one READ ONLY query (default_transaction_read_only=on); x = expanded display
#   stack.sh status | down       down stops the runner and removes the stack (staging-down.sh --purge)
#
# LM_RUNNER names a second (third, ...) runner of the same stack: its own home, PATH, pid, log, name lm42-runner-<name>
# and, with LM_RUNNER_BIN, its own binary (default $LM_DIR/bin/orbit). Unset, the one runner as before.
set -euo pipefail

HERE=$(cd -P "$(dirname "${BASH_SOURCE[0]}")" && pwd)
REPO=$(cd "$HERE/../../.." && pwd)
export ORBIT_LINK_STAGING_PROJECT=${LM_PROJECT:-orbit-link-lm42}
LM_DIR=$(realpath -m "${LM_DIR:-/var/tmp/$ORBIT_LINK_STAGING_PROJECT}")
export ORBIT_LINK_STAGING_DIR=$LM_DIR/stack
export ORBIT_LINK_STAGING_HTTP_PORT=${LM_HTTP_PORT:-46086}
export ORBIT_LINK_STAGING_LINK_PORT=${LM_LINK_PORT:-46443}
export ORBIT_LINK_STAGING_METRICS_PORT=${LM_METRICS_PORT:-46464}
export ORBIT_LINK_STAGING_NATS_PORT=${LM_NATS_PORT:-46422}
export ORBIT_LINK_STAGING_NATS_MONITOR_PORT=${LM_NATS_MONITOR_PORT:-46822}
export ORBIT_LINK_STAGING_PEBBLE_PORT=${LM_PEBBLE_PORT:-46500}
PG=$ORBIT_LINK_STAGING_PROJECT-postgres
SUFFIX=${LM_RUNNER:+-$LM_RUNNER}
RUNNER_HOME=$LM_DIR/runner-home$SUFFIX
RUNNER_USERHOME=$LM_DIR/runner-userhome$SUFFIX
RUNNER_PATH_DIR=$LM_DIR/runner-path$SUFFIX
RUNNER_BIN=${LM_RUNNER_BIN:-$LM_DIR/bin/orbit}
RUNNER_NAME=lm42-runner$SUFFIX
PIDFILE=$LM_DIR/runner$SUFFIX.pid
LOG=$LM_DIR/logs
die() { echo "stack.sh: $*" >&2; exit 1; }
case "$LM_DIR/" in /root/*) die "LM_DIR=$LM_DIR: the runner hides /root behind a tmpfs" ;; esac
mkdir -p "$LM_DIR" "$LOG"
pid_alive() { [ -f "$1" ] && kill -0 "$(cat "$1")" 2>/dev/null; }

cmd_up() {
  # staging-up.sh runs Compose with an env file of its own; nothing of this session's ORBIT_* reaches the stack.
  local p
  for p in "$ORBIT_LINK_STAGING_HTTP_PORT" "$ORBIT_LINK_STAGING_LINK_PORT" "$ORBIT_LINK_STAGING_METRICS_PORT"; do
    if ss -ltnH "sport = :$p" | grep -q . && ! docker ps --format '{{.Names}}' | grep -q "^$ORBIT_LINK_STAGING_PROJECT-"; then
      die "port $p is taken by something that is not $ORBIT_LINK_STAGING_PROJECT"
    fi
  done
  bash "$REPO/scripts/runner-link/staging-up.sh" "$@"
}

cmd_build_runner() {
  local ver sha
  mkdir -p "$LM_DIR/bin"
  ver=$(node -e 'console.log(require(process.argv[1]).version)' "$REPO/package.json")
  sha=$(git -C "$REPO" rev-parse HEAD)
  (cd "$REPO/src/runner-go" && CGO_ENABLED=0 go build -trimpath -buildvcs=false \
     -ldflags "-s -w -X main.version=$ver -X main.sourceSHA=$sha" -o "$LM_DIR/bin/orbit.new" .)
  mv -f "$LM_DIR/bin/orbit.new" "$LM_DIR/bin/orbit"  # a rename, so a running runner keeps its own inode
  echo "$sha" > "$LM_DIR/bin/orbit.SOURCE_SHA"
  echo "runner $("$LM_DIR/bin/orbit" --version) built from $sha"
}

# The runner resolves engine CLIs from the passwd home's ~/.local/bin (/root/.local/bin) ahead of PATH, so it runs in a
# private mount namespace with an empty tmpfs over /root, a scrubbed environment and a PATH whose only engine is the
# fake claude.
runner_exec() {
  mkdir -p "$RUNNER_HOME" "$RUNNER_USERHOME" "$LM_DIR/runner-tmp" "$RUNNER_PATH_DIR" "$LM_DIR/work"
  chmod 700 "$RUNNER_HOME" "$RUNNER_USERHOME"
  # LM_CLAUDE_BIN: a real Claude Code binary (outside /root) in place of the fake, for a run whose model is scripted
  # behind an Orbit provider (scripts/acceptance/landing-fix-own-session/).
  rm -f "$RUNNER_PATH_DIR/claude"
  if [ -n "${LM_CLAUDE_BIN:-}" ]; then ln -s "$LM_CLAUDE_BIN" "$RUNNER_PATH_DIR/claude"; else install -m 755 "$HERE/fake-claude" "$RUNNER_PATH_DIR/claude"; fi
  ln -sfn "$RUNNER_BIN" "$RUNNER_PATH_DIR/orbit"
  unshare --mount --propagation private -- /bin/sh -c \
    'mount -t tmpfs -o size=4m,mode=0700 lm42-hide-root /root && cd "$0" && exec "$@"' "$LM_DIR/work" \
    env -i PATH="$RUNNER_PATH_DIR:/usr/local/go/bin:/usr/bin:/bin" HOME="$RUNNER_USERHOME" LANG=C.UTF-8 USER=root LOGNAME=root \
      ORBIT_HOME="$RUNNER_HOME" ORBIT_NO_SELFUPDATE=1 ORBIT_NO_ENGINE_UPDATE=1 \
      DISABLE_AUTOUPDATER=1 CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 \
      SSL_CERT_FILE="$ORBIT_LINK_STAGING_DIR/tls/ca-bundle.pem" \
      XDG_CONFIG_HOME="$RUNNER_USERHOME/.config" XDG_CACHE_HOME="$RUNNER_USERHOME/.cache" \
      XDG_DATA_HOME="$RUNNER_USERHOME/.local/share" XDG_STATE_HOME="$RUNNER_USERHOME/.local/state" \
      TMPDIR="$LM_DIR/runner-tmp" GIT_CONFIG_NOSYSTEM=1 LM_FAKE_LOG="$LOG/fake-claude.jsonl" LM_SCRATCH="$LM_DIR/ops-out" \
      "$@"
}

git_u() { env -i PATH=/usr/bin:/bin HOME="$RUNNER_USERHOME" GIT_CONFIG_NOSYSTEM=1 git "$@"; }

cmd_repo() {
  local name=${1:?name}
  local origin=$LM_DIR/origin/$name.git work=$LM_DIR/work/$name
  mkdir -p "$LM_DIR/origin" "$LM_DIR/work" "$RUNNER_USERHOME"
  [ -d "$origin" ] || git_u init -q --bare -b main "$origin"
  if [ ! -d "$work/.git" ]; then
    mkdir -p "$work"
    git_u -C "$work" init -q -b main
    git_u -C "$work" config user.name "LM42 E2E"; git_u -C "$work" config user.email e2e@lm42.test
    printf '# %s\n\nThrowaway repository for the revision 42 part two e2e.\n' "$name" > "$work/README.md"
    git_u -C "$work" add README.md; git_u -C "$work" commit -qm "init $name"
    git_u -C "$work" remote add origin "$origin"
    git_u -C "$work" push -q -u origin main
    git_u -C "$origin" symbolic-ref HEAD refs/heads/main
  fi
  echo "$work $origin"
}

cmd_register() {
  local token=${1:?token}
  cmd_stop_runner
  rm -rf "$RUNNER_HOME"
  mkdir -p "$LM_DIR/work/_root$SUFFIX"
  runner_exec "$RUNNER_BIN" register --server "http://127.0.0.1:$ORBIT_LINK_STAGING_HTTP_PORT" --token "$token" \
    --name "$RUNNER_NAME" --workdir "$LM_DIR/work/_root$SUFFIX" --no-service --no-auto-install-engines --force \
    > "$LOG/register$SUFFIX.log" 2>&1 || { cat "$LOG/register$SUFFIX.log"; die "register failed"; }
  grep -m1 -i registered "$LOG/register$SUFFIX.log" || true
}

cmd_start_runner() {
  [ -f "$RUNNER_HOME/config.json" ] || die "runner not registered"
  if pid_alive "$PIDFILE"; then echo "runner already running (pid $(cat "$PIDFILE"))"; return; fi
  echo "== $(date -u +%FT%TZ) start runner $RUNNER_NAME ($("$RUNNER_BIN" --version))" >> "$LOG/runner$SUFFIX.log"
  runner_exec setsid -f "$RUNNER_BIN" run >> "$LOG/runner$SUFFIX.log" 2>&1 < /dev/null
  local pid=""
  for _ in $(seq 1 40); do
    pid=$(pgrep -f "^$RUNNER_BIN run" | head -1 || true)
    [ -n "$pid" ] && break; sleep 0.5
  done
  [ -n "$pid" ] || die "runner did not start"
  echo "$pid" > "$PIDFILE"
  echo "runner $RUNNER_NAME pid $pid"
}

cmd_stop_runner() {
  if pid_alive "$PIDFILE"; then
    local p; p=$(cat "$PIDFILE"); kill "$p" 2>/dev/null || true
    for _ in $(seq 1 40); do kill -0 "$p" 2>/dev/null || break; sleep 0.5; done
    kill -0 "$p" 2>/dev/null && kill -9 "$p" 2>/dev/null || true
    echo "stopped runner $RUNNER_NAME ($p)"
  fi
  rm -f "$PIDFILE"
}

# kill-runner: SIGKILL, no drain: a runner that dies without a word, with what it was doing cut off.
cmd_kill_runner() {
  if pid_alive "$PIDFILE"; then
    local p; p=$(cat "$PIDFILE")
    pkill -9 -P "$p" 2>/dev/null || true
    kill -9 "$p" 2>/dev/null || true
    echo "killed runner $RUNNER_NAME ($p)"
  fi
  rm -f "$PIDFILE"
}

cmd_psql() {
  docker exec -e PGOPTIONS='-c default_transaction_read_only=on' "$PG" \
    psql -U orbit -d orbit -X -v ON_ERROR_STOP=1 -P pager=off ${2:+-x} -c "$1"
}

cmd_status() {
  docker ps -a --filter "name=^$ORBIT_LINK_STAGING_PROJECT-" --format '{{.Names}} {{.Status}}'
  if pid_alive "$PIDFILE"; then echo "runner $RUNNER_NAME: pid $(cat "$PIDFILE")"; else echo "runner $RUNNER_NAME: down"; fi
}

cmd_down() {
  cmd_stop_runner
  bash "$REPO/scripts/runner-link/staging-down.sh" --purge
}

cmd=${1:-}; shift || true
case "$cmd" in
  up) cmd_up "$@" ;;
  build-runner) cmd_build_runner ;;
  repo) cmd_repo "$@" ;;
  register) cmd_register "$@" ;;
  start-runner) cmd_start_runner ;;
  stop-runner) cmd_stop_runner ;;
  kill-runner) cmd_kill_runner ;;
  psql) cmd_psql "$@" ;;
  status) cmd_status ;;
  down) cmd_down ;;
  *) sed -n '2,20p' "$0" >&2; exit 2 ;;
esac
