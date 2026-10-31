#!/usr/bin/env bash
# An isolated Orbit stack for the startNow / "Create and start" end-to-end run. Loopback only.
# Adapted from docs/evidence/landing-observation/e2e/kit/stack.sh (R29-13): the same isolation — env -i, a private
# mount namespace that hides /root from the runner, a fake `claude` (copied unchanged) as the only engine, random
# secrets per stack — with one stack instead of two, and the web console served beside the API so the cards can be
# seen and pressed in a browser.
#
# Layout under CAS_DIR (/var/tmp/cas-e2e):
#   server/src        git archive of the server and web trees at one commit, built (dist/), node_modules hard-linked
#   bin/orbit         the runner built from the same commit
#   logs/, secrets.env, runner-home, runner-userhome, runner-tmp, runner-path, work/, origin/
#
# usage: stack.sh <command> [args]
#   build <rev>              archive <rev>, build @orbit/shared, the apiserver, the web console and the runner
#   db                       fresh postgres (tmpfs) + every migration
#   start-api | stop-api
#   start-proxy | stop-proxy the logging proxy the runner talks to (logs/runner-wire.jsonl)
#   start-web | stop-web     the web console (server/src/src/web/dist) with /api passed to the apiserver
#   repo <name>              a bare origin origin/<name>.git and the runner's clone work/<name>
#   register <token>         orbit register through the proxy
#   start-runner | stop-runner
#   psql <sql> [x]           one READ ONLY query (default_transaction_read_only=on)
#   status | clean
set -euo pipefail

HERE=$(cd -P "$(dirname "${BASH_SOURCE[0]}")" && pwd)
S=$(realpath -m "${CAS_DIR:-/var/tmp/cas-e2e}")
die() { echo "stack.sh: $*" >&2; exit 1; }
case "$S/" in /root/*) die "CAS_DIR=$S: the runner hides /root behind a tmpfs" ;; esac
[ -e "$S/.cas" ] || [ -z "$(ls -A "$S" 2>/dev/null)" ] || die "$S is not empty and was not made by this script"
mkdir -p "$S" && touch "$S/.cas"

API_PORT=${CAS_API_PORT:-3967}; PROXY_PORT=$((API_PORT + 1)); WEB_PORT=${CAS_WEB_PORT:-2967}; PG_PORT=${CAS_PG_PORT:-5967}
PG=cas-e2e-pg
LOG=$S/logs
RUNNER_HOME=$S/runner-home; RUNNER_USERHOME=$S/runner-userhome
RUNNER_PATH_DIR=$S/runner-path
mkdir -p "$LOG"
BASE_PATH=/usr/local/bin:/usr/bin:/bin
pid_alive() { [ -f "$1" ] && kill -0 "$(cat "$1")" 2>/dev/null; }

# ── build ────────────────────────────────────────────────────────────────────────────────────────────
# node_modules come hard-linked from a checkout installed from the same lockfile (NM_SRC), with this tree's own
# Prisma client generated into the copy, so nothing is written back into NM_SRC.
cmd_build() {
  local rev=${1:?rev} wt dst nm ver sha
  wt=$(git -C "$HERE" rev-parse --show-toplevel)
  nm=${NM_SRC:?NM_SRC: a checkout with an npm ci install of this lockfile}
  dst=$S/server
  rm -rf "$dst"; mkdir -p "$dst/src" "$dst/logs"
  git -C "$wt" archive "$rev" package.json package-lock.json tsconfig.base.json src/shared src/apiserver src/web | tar -x -C "$dst/src"
  sha=$(git -C "$wt" rev-parse "$rev^{commit}"); echo "$sha" > "$dst/SOURCE_SHA"
  for t in src/apiserver src/shared src/web src/runner-go; do echo "$t $(git -C "$wt" rev-parse "$rev:$t")"; done > "$dst/TREES"
  cmp -s <(git -C "$wt" show "$rev:package-lock.json") "$nm/package-lock.json" || die "package-lock.json at $rev differs from $nm"
  cp -al "$nm/node_modules" "$dst/src/node_modules"
  [ -d "$nm/src/apiserver/node_modules" ] && cp -al "$nm/src/apiserver/node_modules" "$dst/src/src/apiserver/node_modules"
  [ -d "$nm/src/web/node_modules" ] && cp -al "$nm/src/web/node_modules" "$dst/src/src/web/node_modules"
  rm -rf "$dst/src/node_modules/@prisma/client" "$dst/src/node_modules/.prisma" "$dst/src/node_modules/@orbit"
  cp -r "$nm/node_modules/@prisma/client" "$dst/src/node_modules/@prisma/client"
  mkdir -p "$dst/src/node_modules/@orbit"
  ln -s ../../src/shared "$dst/src/node_modules/@orbit/shared"; ln -s ../../src/web "$dst/src/node_modules/@orbit/web"
  ln -s ../../src/apiserver "$dst/src/node_modules/@orbit/apiserver"
  (cd "$dst/src/src/apiserver" && env -i PATH="$BASE_PATH" HOME="$dst" ../../node_modules/.bin/prisma generate) > "$dst/logs/prisma.log" 2>&1
  (cd "$dst/src" && node_modules/.bin/tsc -p src/shared/tsconfig.json) > "$dst/logs/shared.log" 2>&1
  (cd "$dst/src/src/apiserver" && rm -rf dist && ../../node_modules/.bin/tsc -p tsconfig.json) > "$dst/logs/apiserver.log" 2>&1
  (cd "$dst/src/src/apiserver" && node -e "console.log(require.resolve('@orbit/shared'), require.resolve('.prisma/client/default'))") | tee "$dst/logs/resolve.log"
  grep -q "^$dst/src/" "$dst/logs/resolve.log" || die "@orbit/shared resolves outside $dst"
  (cd "$dst/src/src/web" && env -i PATH="$BASE_PATH" HOME="$dst" PUBLIC_ORIGIN="http://127.0.0.1:$WEB_PORT" \
     ../../node_modules/.bin/vite build) > "$dst/logs/web.log" 2>&1 || { tail -20 "$dst/logs/web.log"; die "web build failed"; }
  mkdir -p "$S/bin" "$S/runner-src"; rm -rf "$S/runner-src/src"
  git -C "$wt" archive "$rev" src/runner-go | tar -x -C "$S/runner-src"
  ver=$(git -C "$wt" show "$rev:package.json" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).version))')
  (cd "$S/runner-src/src/runner-go" && CGO_ENABLED=0 go build -trimpath -buildvcs=false \
     -ldflags "-s -w -X main.version=$ver -X main.sourceSHA=$sha" -o "$S/bin/orbit" .)
  echo "$sha" > "$S/bin/orbit.SOURCE_SHA"
  echo "built $sha: apiserver, web, runner $("$S/bin/orbit" --version)"
}

# ── database ─────────────────────────────────────────────────────────────────────────────────────────
load_secrets() {
  if [ ! -f "$S/secrets.env" ]; then
    (umask 077; printf 'JWT_SECRET=%s\nPROVIDER_SECRET_KEY=%s\nPG_PASSWORD=%s\n' \
      "$(openssl rand -hex 32)" "$(openssl rand -base64 32)" "$(openssl rand -hex 16)" > "$S/secrets.env")
  fi
  set -a; . "$S/secrets.env"; set +a
  DB_URL=postgresql://orbit:$PG_PASSWORD@127.0.0.1:$PG_PORT/orbit
}

cmd_db() {
  load_secrets
  docker rm -f -v "$PG" >/dev/null 2>&1 || true
  docker run -d --name "$PG" --label cas-e2e=1 -e POSTGRES_USER=orbit -e POSTGRES_PASSWORD="$PG_PASSWORD" -e POSTGRES_DB=orbit \
    -p 127.0.0.1:$PG_PORT:5432 --tmpfs /var/lib/postgresql/data postgres:16-alpine >/dev/null
  for _ in $(seq 1 60); do docker exec "$PG" pg_isready -h 127.0.0.1 -U orbit >/dev/null 2>&1 && break; sleep 1; done
  sleep 2
  (cd "$S/server/src/src/apiserver" && env -i PATH="$BASE_PATH" HOME="$S" DATABASE_URL="$DB_URL" \
     ../../node_modules/.bin/prisma migrate deploy) >> "$LOG/migrate.log" 2>&1
  tail -3 "$LOG/migrate.log"
}

cmd_psql() {  # psql <sql> [x]: x = expanded display (one field per line)
  docker exec -e PGOPTIONS='-c default_transaction_read_only=on' "$PG" \
    psql -U orbit -d orbit -X -v ON_ERROR_STOP=1 -P pager=off ${2:+-x} -c "$1"
}

# ── apiserver, proxy, web ────────────────────────────────────────────────────────────────────────────
wait_port() {  # wait_port <port> <name> -> pid
  local pid=""
  for _ in $(seq 1 120); do
    pid=$(ss -ltnpH "sport = :$1" 2>/dev/null | grep -o 'pid=[0-9]*' | head -1 | cut -d= -f2 || true)
    [ -n "$pid" ] && break; sleep 0.5
  done
  [ -n "$pid" ] || die "$2 did not listen on $1"
  echo "$pid"
}

cmd_start_api() {
  load_secrets
  if pid_alive "$S/api.pid"; then echo "apiserver already running (pid $(cat "$S/api.pid"))"; return; fi
  local src=$S/server/src
  [ -f "$src/src/apiserver/dist/main.js" ] || die "not built"
  echo "== $(date -u +%FT%TZ) start apiserver at $(cat "$S/server/SOURCE_SHA")" >> "$LOG/apiserver.log"
  (cd "$src" && env -i PATH="$BASE_PATH" HOME="$S" LANG=C.UTF-8 \
    DATABASE_URL="$DB_URL" PORT="$API_PORT" JWT_SECRET="$JWT_SECRET" PROVIDER_SECRET_KEY="$PROVIDER_SECRET_KEY" \
    PUBLIC_ORIGIN="http://127.0.0.1:$WEB_PORT" CORS_ORIGINS="http://127.0.0.1:$WEB_PORT,http://127.0.0.1:$API_PORT" \
    setsid -f node --max-old-space-size=1536 --require "$HERE/loopback-only.cjs" src/apiserver/dist/main.js >> "$LOG/apiserver.log" 2>&1 < /dev/null)
  local pid; pid=$(wait_port "$API_PORT" apiserver)
  echo "$pid" > "$S/api.pid"; echo "apiserver pid $pid on 127.0.0.1:$API_PORT"
}

stop_pidfile() {
  local f=$1 name=$2
  if pid_alive "$f"; then
    local p; p=$(cat "$f"); kill "$p" 2>/dev/null || true
    for _ in $(seq 1 40); do kill -0 "$p" 2>/dev/null || break; sleep 0.5; done
    kill -0 "$p" 2>/dev/null && kill -9 "$p" 2>/dev/null || true
    echo "stopped $name ($p)"
  fi
  rm -f "$f"
}
cmd_stop_api() { stop_pidfile "$S/api.pid" apiserver; }

cmd_start_proxy() {
  if pid_alive "$S/proxy.pid"; then echo "proxy already running"; return; fi
  env -i PATH="$BASE_PATH" HOME="$S" PROXY_PORT="$PROXY_PORT" API_PORT="$API_PORT" WIRE_LOG="$LOG/runner-wire.jsonl" \
    setsid -f node "$HERE/proxy.mjs" >> "$LOG/proxy.log" 2>&1 < /dev/null
  local pid; pid=$(wait_port "$PROXY_PORT" proxy)
  echo "$pid" > "$S/proxy.pid"; echo "proxy pid $pid: 127.0.0.1:$PROXY_PORT -> $API_PORT"
}
cmd_stop_proxy() { stop_pidfile "$S/proxy.pid" proxy; }

cmd_start_web() {
  if pid_alive "$S/web.pid"; then echo "web already running"; return; fi
  env -i PATH="$BASE_PATH" HOME="$S" WEB_PORT="$WEB_PORT" API_PORT="$API_PORT" DIST="$S/server/src/src/web/dist" \
    setsid -f node "$HERE/gateway.mjs" >> "$LOG/gateway.log" 2>&1 < /dev/null
  local pid; pid=$(wait_port "$WEB_PORT" gateway)
  echo "$pid" > "$S/web.pid"; echo "web pid $pid on http://127.0.0.1:$WEB_PORT"
}
cmd_stop_web() { stop_pidfile "$S/web.pid" web; }

# ── runner ───────────────────────────────────────────────────────────────────────────────────────────
# The runner resolves engine CLIs from the passwd home's ~/.local/bin (/root/.local/bin) ahead of PATH, so it
# runs in a private mount namespace with an empty tmpfs over /root, a scrubbed environment and a PATH whose only
# engine is the fake claude.
runner_exec() {
  mkdir -p "$RUNNER_HOME" "$RUNNER_USERHOME" "$S/runner-tmp" "$RUNNER_PATH_DIR" "$S/work"
  chmod 700 "$RUNNER_HOME" "$RUNNER_USERHOME"
  install -m 755 "$HERE/fake-claude" "$RUNNER_PATH_DIR/claude"
  unshare --mount --propagation private -- /bin/sh -c \
    'mount -t tmpfs -o size=4m,mode=0700 cas-hide-root /root && cd "$0" && exec "$@"' "$S/work" \
    env -i PATH="$RUNNER_PATH_DIR:/usr/bin:/bin" HOME="$RUNNER_USERHOME" LANG=C.UTF-8 USER=root LOGNAME=root \
      ORBIT_HOME="$RUNNER_HOME" ORBIT_NO_SELFUPDATE=1 ORBIT_NO_ENGINE_UPDATE=1 \
      XDG_CONFIG_HOME="$RUNNER_USERHOME/.config" XDG_CACHE_HOME="$RUNNER_USERHOME/.cache" \
      XDG_DATA_HOME="$RUNNER_USERHOME/.local/share" XDG_STATE_HOME="$RUNNER_USERHOME/.local/state" \
      TMPDIR="$S/runner-tmp" GIT_CONFIG_NOSYSTEM=1 R2913_FAKE_LOG="$LOG/fake-claude.jsonl" R2913_STACK=cas \
      "$@"
}

git_u() { env -i PATH=/usr/bin:/bin HOME="$RUNNER_USERHOME" GIT_CONFIG_NOSYSTEM=1 git "$@"; }

# A bare origin and the runner's clone of it: README on main.
cmd_repo() {
  local name=${1:?name}
  local origin=$S/origin/$name.git work=$S/work/$name
  mkdir -p "$S/origin" "$S/work" "$RUNNER_USERHOME"
  [ -d "$origin" ] || git_u init -q --bare -b main "$origin"
  if [ ! -d "$work/.git" ]; then
    mkdir -p "$work"
    git_u -C "$work" init -q -b main
    git_u -C "$work" config user.name "Create-and-start E2E"; git_u -C "$work" config user.email e2e@cas.test
    printf '# %s\n\nThrowaway repository for the startNow / Create and start e2e.\n' "$name" > "$work/README.md"
    git_u -C "$work" add README.md; git_u -C "$work" commit -qm "init $name"
    git_u -C "$work" remote add origin "$origin"
    git_u -C "$work" push -q -u origin main
    git_u -C "$origin" symbolic-ref HEAD refs/heads/main
  fi
  echo "$work $origin"
}

cmd_register() {
  local token=${1:?token}
  stop_pidfile "$S/runner.pid" runner
  runner_exec "$S/bin/orbit" register --server "http://127.0.0.1:$PROXY_PORT" --token "$token" \
    --name "cas-e2e-runner" --workdir "$S/work/_root" --no-service --no-auto-install-engines --force \
    > "$LOG/register.log" 2>&1 || { cat "$LOG/register.log"; die "register failed"; }
  grep -m1 -i registered "$LOG/register.log" || true
}

cmd_start_runner() {
  [ -f "$RUNNER_HOME/config.json" ] || die "runner not registered"
  if pid_alive "$S/runner.pid"; then echo "runner already running (pid $(cat "$S/runner.pid"))"; return; fi
  # A copy with a path no other stack's runner has, so the pgrep below finds this one.
  mkdir -p "$S/runbin"; install -m 755 "$S/bin/orbit" "$S/runbin/orbit-cas"
  ln -sfn "$S/runbin/orbit-cas" "$RUNNER_PATH_DIR/orbit"
  echo "== $(date -u +%FT%TZ) start runner ($("$S/runbin/orbit-cas" --version))" >> "$LOG/runner.log"
  runner_exec setsid -f "$S/runbin/orbit-cas" run >> "$LOG/runner.log" 2>&1 < /dev/null
  local pid=""
  for _ in $(seq 1 40); do
    pid=$(pgrep -f "^$S/runbin/orbit-cas run" | head -1 || true)
    [ -n "$pid" ] && break; sleep 0.5
  done
  [ -n "$pid" ] || die "runner did not start"
  echo "$pid" > "$S/runner.pid"; echo "runner pid $pid"
}
cmd_stop_runner() { stop_pidfile "$S/runner.pid" runner; }

cmd_status() {
  echo "stack: $S (api :$API_PORT, proxy :$PROXY_PORT, web :$WEB_PORT, postgres $PG :$PG_PORT)"
  docker ps -a --filter "name=^${PG}\$" --format 'postgres: {{.Names}} {{.Status}}'
  for p in api proxy web runner; do
    if pid_alive "$S/$p.pid"; then echo "$p: pid $(cat "$S/$p.pid")"; else echo "$p: down"; fi
  done
}

cmd_clean() {
  cmd_stop_runner || true; cmd_stop_web || true; cmd_stop_proxy || true; cmd_stop_api || true
  docker rm -f -v "$PG" >/dev/null 2>&1 && echo "removed $PG" || true
}

cmd=${1:-}; shift || true
case "$cmd" in
  build) cmd_build "$@" ;;
  db) cmd_db ;;
  psql) cmd_psql "$@" ;;
  start-api) cmd_start_api ;;
  stop-api) cmd_stop_api ;;
  start-proxy) cmd_start_proxy ;;
  stop-proxy) cmd_stop_proxy ;;
  start-web) cmd_start_web ;;
  stop-web) cmd_stop_web ;;
  repo) cmd_repo "$@" ;;
  register) cmd_register "$@" ;;
  start-runner) cmd_start_runner ;;
  stop-runner) cmd_stop_runner ;;
  status) cmd_status ;;
  clean) cmd_clean ;;
  *) echo "usage: $0 build|db|psql|start-api|stop-api|start-proxy|stop-proxy|start-web|stop-web|repo|register|start-runner|stop-runner|status|clean" >&2; exit 2 ;;
esac
