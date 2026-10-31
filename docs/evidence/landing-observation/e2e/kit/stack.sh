#!/usr/bin/env bash
# R29-13: isolated Orbit stacks for the landing-observation end-to-end runs (contract §10). Loopback only.
# Adapted from src/android/scripts/a11-stack/setup.sh (same isolation: env -i, a private mount namespace that
# hides /root from the runner, a fake `claude` as the only engine, random secrets per stack).
#
#   stack a : scenarios 1-3, this branch's apiserver + this branch's runner from the start
#   stack b : scenarios 4-5, the 0.1.239 apiserver (18dfe8f1c) + the 0.1.239 release runner first, then the
#             deploy: this branch's apiserver on the same database, the old runner still connected, and last
#             this branch's runner in the old one's place (same ORBIT_HOME, same workspaces).
#
# Layout under R2913_DIR (/var/tmp/r29-13-e2e):
#   servers/<name>/src     git archive of the server trees at a revision, built (dist/), node_modules hard-linked
#   bin/orbit-<name>       runner binaries: orbit-new (built from a revision), orbit-0.1.239 (the release binary)
#   <stack>/               logs/, secrets.env, runner-home, runner-userhome, runner-tmp, runner-path, work/, origin/
#
# usage: R2913_STACK=a|b stack.sh <command> [args]
#   build-server <name> <rev>    archive + build an apiserver (name: new | old)
#   build-runner <name> <rev>    go build src/runner-go at <rev> into bin/orbit-<name>
#   old-runner                   copy /usr/local/bin/orbit (the host's 0.1.239 release binary) to bin/orbit-0.1.239
#   db <server>                  fresh postgres (tmpfs) + that server's migrations
#   migrate <server>             prisma migrate deploy with that server's migrations (the deploy step)
#   start-api <server> | stop-api
#   start-proxy | stop-proxy     the logging proxy the runner talks to (logs/runner-wire.jsonl)
#   repo <name>                  a bare origin origin/<name>.git and the runner's clone work/<name>
#   register <token> <bin>       orbit register through the proxy, with that runner binary
#   start-runner <bin> | stop-runner
#   install-engine               copy the kit's fake-claude over the runner's (the next session spawn uses it)
#   psql <sql>                   one READ ONLY query (default_transaction_read_only=on)
#   status | clean
set -euo pipefail

HERE=$(cd -P "$(dirname "${BASH_SOURCE[0]}")" && pwd)
S=$(realpath -m "${R2913_DIR:-/var/tmp/r29-13-e2e}")
STACK=${R2913_STACK:-}
die() { echo "stack.sh: $*" >&2; exit 1; }
case "$S/" in /root/*) die "R2913_DIR=$S: the runner hides /root behind a tmpfs" ;; esac
[ -e "$S/.r2913" ] || [ -z "$(ls -A "$S" 2>/dev/null)" ] || die "$S is not empty and was not made by this script"
mkdir -p "$S" && touch "$S/.r2913"

case "$STACK" in
  a) N=0 ;; b) N=1 ;; "") N=-1 ;; *) die "R2913_STACK must be a or b" ;;
esac
if [ "$N" -ge 0 ]; then
  API_PORT=$((3913 + N * 10)); PROXY_PORT=$((API_PORT + 1)); PG_PORT=$((5913 + N * 10))
  PG=r2913-pg-$STACK
  SD=$S/$STACK
  LOG=$SD/logs
  RUNNER_HOME=$SD/runner-home; RUNNER_USERHOME=$SD/runner-userhome
  RUNNER_PATH_DIR=$SD/runner-path
  mkdir -p "$LOG"
fi
need_stack() { [ "$N" -ge 0 ] || die "set R2913_STACK=a|b"; }
BASE_PATH=/usr/local/bin:/usr/bin:/bin
pid_alive() { [ -f "$1" ] && kill -0 "$(cat "$1")" 2>/dev/null; }

# ── builds ───────────────────────────────────────────────────────────────────────────────────────────
# node_modules come hard-linked from a checkout installed from the same lockfile for the server trees
# (NM_SRC; the apiserver/shared manifests are identical between 18dfe8f1c and this branch, only src/web's differ).
cmd_build_server() {
  local name=${1:?name} rev=${2:?rev} wt dst nm
  wt=$(git -C "$HERE" rev-parse --show-toplevel)
  nm=${NM_SRC:?NM_SRC: a checkout with a plain npm ci install}
  dst=$S/servers/$name
  rm -rf "$dst"; mkdir -p "$dst/src" "$dst/logs"
  git -C "$wt" archive "$rev" package.json package-lock.json tsconfig.base.json src/shared src/apiserver | tar -x -C "$dst/src"
  git -C "$wt" rev-parse "$rev^{commit}" > "$dst/SOURCE_SHA"
  for t in src/apiserver src/shared; do echo "$t $(git -C "$wt" rev-parse "$rev:$t")"; done > "$dst/TREES"
  diff <(git -C "$wt" show "$rev:src/apiserver/package.json") "$nm/src/apiserver/package.json" >/dev/null || die "apiserver package.json at $rev differs from $nm"
  cp -al "$nm/node_modules" "$dst/src/node_modules"
  cp -al "$nm/src/apiserver/node_modules" "$dst/src/src/apiserver/node_modules"
  rm -rf "$dst/src/node_modules/@prisma/client" "$dst/src/node_modules/.prisma" "$dst/src/node_modules/@orbit"
  cp -r "$nm/node_modules/@prisma/client" "$dst/src/node_modules/@prisma/client"
  mkdir -p "$dst/src/node_modules/@orbit"; ln -s ../../src/shared "$dst/src/node_modules/@orbit/shared"
  (cd "$dst/src/src/apiserver" && env -i PATH="$BASE_PATH" HOME="$dst" ../../node_modules/.bin/prisma generate) > "$dst/logs/prisma.log" 2>&1
  (cd "$dst/src" && node_modules/.bin/tsc -p src/shared/tsconfig.json) > "$dst/logs/shared.log" 2>&1
  (cd "$dst/src/src/apiserver" && rm -rf dist && ../../node_modules/.bin/tsc -p tsconfig.json) > "$dst/logs/apiserver.log" 2>&1
  (cd "$dst/src/src/apiserver" && node -e "console.log(require.resolve('@orbit/shared'), require.resolve('.prisma/client/default'))") | tee "$dst/logs/resolve.log"
  grep -q "^$dst/src/" "$dst/logs/resolve.log" || die "@orbit/shared resolves outside $dst"
  echo "built server $name at $(cat "$dst/SOURCE_SHA")"
}

cmd_build_runner() {
  local name=${1:?name} rev=${2:?rev} wt ver sha tmp
  wt=$(git -C "$HERE" rev-parse --show-toplevel)
  mkdir -p "$S/bin" "$S/runner-src"
  tmp=$S/runner-src/$name; rm -rf "$tmp"; mkdir -p "$tmp"
  git -C "$wt" archive "$rev" src/runner-go | tar -x -C "$tmp"
  ver=$(git -C "$wt" show "$rev:package.json" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).version))')
  sha=$(git -C "$wt" rev-parse "$rev^{commit}")
  (cd "$tmp/src/runner-go" && CGO_ENABLED=0 go build -trimpath -buildvcs=false \
     -ldflags "-s -w -X main.version=$ver -X main.sourceSHA=$sha" -o "$S/bin/orbit-$name" .)
  echo "$sha" > "$S/bin/orbit-$name.SOURCE_SHA"
  "$S/bin/orbit-$name" --version
}

cmd_old_runner() {
  mkdir -p "$S/bin"
  install -m 755 /usr/local/bin/orbit "$S/bin/orbit-0.1.239"
  "$S/bin/orbit-0.1.239" --version | grep -qx '0.1.239' || die "the host binary is not 0.1.239"
  sha256sum "$S/bin/orbit-0.1.239" | tee "$S/bin/orbit-0.1.239.sha256"
}

# ── database ─────────────────────────────────────────────────────────────────────────────────────────
load_secrets() {
  need_stack
  if [ ! -f "$SD/secrets.env" ]; then
    (umask 077; printf 'JWT_SECRET=%s\nPROVIDER_SECRET_KEY=%s\nPG_PASSWORD=%s\n' \
      "$(openssl rand -hex 32)" "$(openssl rand -base64 32)" "$(openssl rand -hex 16)" > "$SD/secrets.env")
  fi
  set -a; . "$SD/secrets.env"; set +a
  DB_URL=postgresql://orbit:$PG_PASSWORD@127.0.0.1:$PG_PORT/orbit
}

cmd_migrate() {
  local server=${1:?server}
  load_secrets
  (cd "$S/servers/$server/src/src/apiserver" && env -i PATH="$BASE_PATH" HOME="$SD" DATABASE_URL="$DB_URL" \
     ../../node_modules/.bin/prisma migrate deploy) >> "$LOG/migrate-$server.log" 2>&1
  tail -3 "$LOG/migrate-$server.log"
}

cmd_db() {
  local server=${1:?server}
  load_secrets
  docker rm -f -v "$PG" >/dev/null 2>&1 || true
  docker run -d --name "$PG" --label r2913=1 -e POSTGRES_USER=orbit -e POSTGRES_PASSWORD="$PG_PASSWORD" -e POSTGRES_DB=orbit \
    -p 127.0.0.1:$PG_PORT:5432 --tmpfs /var/lib/postgresql/data postgres:16-alpine >/dev/null
  for _ in $(seq 1 60); do docker exec "$PG" pg_isready -h 127.0.0.1 -U orbit >/dev/null 2>&1 && break; sleep 1; done
  sleep 2
  cmd_migrate "$server"
}

cmd_psql() {  # psql <sql> [x]: x = expanded display (one field per line)
  need_stack
  docker exec -e PGOPTIONS='-c default_transaction_read_only=on' "$PG" \
    psql -U orbit -d orbit -X -v ON_ERROR_STOP=1 -P pager=off ${2:+-x} -c "$1"
}

# ── apiserver ────────────────────────────────────────────────────────────────────────────────────────
cmd_start_api() {
  local server=${1:?server}
  load_secrets
  if pid_alive "$SD/api.pid"; then echo "apiserver already running (pid $(cat "$SD/api.pid"))"; return; fi
  local src=$S/servers/$server/src
  [ -f "$src/src/apiserver/dist/main.js" ] || die "server $server is not built"
  echo "== $(date -u +%FT%TZ) start apiserver '$server' at $(cat "$S/servers/$server/SOURCE_SHA")" >> "$LOG/apiserver.log"
  (cd "$src" && env -i PATH="$BASE_PATH" HOME="$SD" LANG=C.UTF-8 \
    DATABASE_URL="$DB_URL" PORT="$API_PORT" JWT_SECRET="$JWT_SECRET" PROVIDER_SECRET_KEY="$PROVIDER_SECRET_KEY" \
    PUBLIC_ORIGIN="http://127.0.0.1:$API_PORT" CORS_ORIGINS="http://127.0.0.1:$API_PORT" \
    setsid -f node --max-old-space-size=1536 --require "$HERE/loopback-only.cjs" src/apiserver/dist/main.js >> "$LOG/apiserver.log" 2>&1 < /dev/null)
  local pid=""
  for _ in $(seq 1 120); do
    pid=$(ss -ltnpH "sport = :$API_PORT" 2>/dev/null | grep -o 'pid=[0-9]*' | head -1 | cut -d= -f2 || true)
    [ -n "$pid" ] && break; sleep 1
  done
  [ -n "$pid" ] || { tail -30 "$LOG/apiserver.log"; die "apiserver did not listen on $API_PORT"; }
  echo "$pid" > "$SD/api.pid"; echo "$server" > "$SD/api.server"
  echo "apiserver '$server' pid $pid on 127.0.0.1:$API_PORT"
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
cmd_stop_api() { need_stack; stop_pidfile "$SD/api.pid" apiserver; echo "== $(date -u +%FT%TZ) apiserver stopped" >> "$LOG/apiserver.log"; }

cmd_start_proxy() {
  need_stack
  if pid_alive "$SD/proxy.pid"; then echo "proxy already running"; return; fi
  env -i PATH="$BASE_PATH" HOME="$SD" PROXY_PORT="$PROXY_PORT" API_PORT="$API_PORT" WIRE_LOG="$LOG/runner-wire.jsonl" \
    setsid -f node "$HERE/proxy.mjs" >> "$LOG/proxy.log" 2>&1 < /dev/null
  local pid=""
  for _ in $(seq 1 20); do
    pid=$(ss -ltnpH "sport = :$PROXY_PORT" 2>/dev/null | grep -o 'pid=[0-9]*' | head -1 | cut -d= -f2 || true)
    [ -n "$pid" ] && break; sleep 0.5
  done
  [ -n "$pid" ] || die "proxy did not listen on $PROXY_PORT"
  echo "$pid" > "$SD/proxy.pid"; echo "proxy pid $pid: 127.0.0.1:$PROXY_PORT -> $API_PORT"
}
cmd_stop_proxy() { need_stack; stop_pidfile "$SD/proxy.pid" proxy; }

# ── runner ───────────────────────────────────────────────────────────────────────────────────────────
# The runner resolves engine CLIs from the passwd home's ~/.local/bin (/root/.local/bin) ahead of PATH, so it
# runs in a private mount namespace with an empty tmpfs over /root, a scrubbed environment and a PATH whose only
# engine is the fake claude.
runner_exec() {
  need_stack
  mkdir -p "$RUNNER_HOME" "$RUNNER_USERHOME" "$SD/runner-tmp" "$RUNNER_PATH_DIR" "$SD/work"
  chmod 700 "$RUNNER_HOME" "$RUNNER_USERHOME"
  install -m 755 "$HERE/fake-claude" "$RUNNER_PATH_DIR/claude"
  unshare --mount --propagation private -- /bin/sh -c \
    'mount -t tmpfs -o size=4m,mode=0700 r2913-hide-root /root && cd "$0" && exec "$@"' "$SD/work" \
    env -i PATH="$RUNNER_PATH_DIR:/usr/bin:/bin" HOME="$RUNNER_USERHOME" LANG=C.UTF-8 USER=root LOGNAME=root \
      ORBIT_HOME="$RUNNER_HOME" ORBIT_NO_SELFUPDATE=1 ORBIT_NO_ENGINE_UPDATE=1 \
      XDG_CONFIG_HOME="$RUNNER_USERHOME/.config" XDG_CACHE_HOME="$RUNNER_USERHOME/.cache" \
      XDG_DATA_HOME="$RUNNER_USERHOME/.local/share" XDG_STATE_HOME="$RUNNER_USERHOME/.local/state" \
      TMPDIR="$SD/runner-tmp" GIT_CONFIG_NOSYSTEM=1 R2913_FAKE_LOG="$LOG/fake-claude.jsonl" R2913_STACK="$STACK" \
      "$@"
}

git_u() { env -i PATH=/usr/bin:/bin HOME="$RUNNER_USERHOME" GIT_CONFIG_NOSYSTEM=1 git "$@"; }

# A bare origin and the runner's clone of it, one per project: README on main, plus the upstream branch if asked.
cmd_repo() {
  need_stack
  local name=${1:?name} branch=${2:-main}
  local origin=$SD/origin/$name.git work=$SD/work/$name
  mkdir -p "$SD/origin" "$SD/work" "$RUNNER_USERHOME"
  [ -d "$origin" ] || git_u init -q --bare -b main "$origin"
  if [ ! -d "$work/.git" ]; then
    mkdir -p "$work"
    git_u -C "$work" init -q -b main
    git_u -C "$work" config user.name "R29-13 E2E"; git_u -C "$work" config user.email e2e@r2913.test
    printf '# %s\n\nThrowaway repository for the R29-13 landing-observation e2e (stack %s).\n' "$name" "$STACK" > "$work/README.md"
    git_u -C "$work" add README.md; git_u -C "$work" commit -qm "init $name"
    git_u -C "$work" remote add origin "$origin"
    git_u -C "$work" push -q -u origin main
    if [ "$branch" != main ]; then
      git_u -C "$work" push -q origin "main:refs/heads/$branch"
    fi
    git_u -C "$origin" symbolic-ref HEAD refs/heads/main
  fi
  echo "$work $origin"
}

cmd_register() {
  local token=${1:?token} bin=${2:?runner binary name}
  need_stack
  stop_pidfile "$SD/runner.pid" runner
  runner_exec "$S/bin/orbit-$bin" register --server "http://127.0.0.1:$PROXY_PORT" --token "$token" \
    --name "r2913-$STACK-runner" --workdir "$SD/work/_root" --no-service --no-auto-install-engines --force \
    > "$LOG/register.log" 2>&1 || { cat "$LOG/register.log"; die "register failed"; }
  grep -m1 -i registered "$LOG/register.log" || true
}

cmd_start_runner() {
  local bin=${1:?runner binary name}
  need_stack
  [ -f "$RUNNER_HOME/config.json" ] || die "runner not registered"
  if pid_alive "$SD/runner.pid"; then echo "runner already running (pid $(cat "$SD/runner.pid"))"; return; fi
  # A copy per stack, so this stack's runner has a command line no other stack's runner shares (pgrep below).
  mkdir -p "$SD/bin"; install -m 755 "$S/bin/orbit-$bin" "$SD/bin/orbit-$bin"
  ln -sfn "$SD/bin/orbit-$bin" "$RUNNER_PATH_DIR/orbit"
  echo "== $(date -u +%FT%TZ) start runner orbit-$bin ($("$SD/bin/orbit-$bin" --version))" >> "$LOG/runner.log"
  runner_exec setsid -f "$SD/bin/orbit-$bin" run >> "$LOG/runner.log" 2>&1 < /dev/null
  local pid=""
  for _ in $(seq 1 40); do
    pid=$(pgrep -f "^$SD/bin/orbit-$bin run" | head -1 || true)
    [ -n "$pid" ] && break; sleep 0.5
  done
  [ -n "$pid" ] || die "runner did not start"
  echo "$pid" > "$SD/runner.pid"; echo "$bin" > "$SD/runner.bin"
  echo "runner orbit-$bin pid $pid"
}
cmd_stop_runner() { need_stack; stop_pidfile "$SD/runner.pid" runner; echo "== $(date -u +%FT%TZ) runner stopped" >> "$LOG/runner.log"; }

cmd_status() {
  need_stack
  echo "stack $STACK: $SD (api :$API_PORT, proxy :$PROXY_PORT, postgres $PG :$PG_PORT)"
  docker ps -a --filter "name=^${PG}\$" --format 'postgres: {{.Names}} {{.Status}}'
  for p in api proxy runner; do
    if pid_alive "$SD/$p.pid"; then echo "$p: pid $(cat "$SD/$p.pid") $(cat "$SD/$p.server" "$SD/$p.bin" 2>/dev/null || true)"; else echo "$p: down"; fi
  done
}

cmd_clean() {
  need_stack
  cmd_stop_runner || true; cmd_stop_proxy || true; cmd_stop_api || true
  docker rm -f -v "$PG" >/dev/null 2>&1 && echo "removed $PG" || true
}

cmd=${1:-}; shift || true
case "$cmd" in
  build-server) cmd_build_server "$@" ;;
  build-runner) cmd_build_runner "$@" ;;
  old-runner) cmd_old_runner ;;
  db) cmd_db "$@" ;;
  migrate) cmd_migrate "$@" ;;
  psql) cmd_psql "$@" ;;
  start-api) cmd_start_api "$@" ;;
  stop-api) cmd_stop_api ;;
  start-proxy) cmd_start_proxy ;;
  stop-proxy) cmd_stop_proxy ;;
  repo) cmd_repo "$@" ;;
  register) cmd_register "$@" ;;
  start-runner) cmd_start_runner "$@" ;;
  install-engine) need_stack; mkdir -p "$RUNNER_PATH_DIR"; install -m 755 "$HERE/fake-claude" "$RUNNER_PATH_DIR/claude"; echo "installed fake-claude" ;;
  stop-runner) cmd_stop_runner ;;
  status) cmd_status ;;
  clean) cmd_clean ;;
  *) echo "usage: R2913_STACK=a|b $0 build-server|build-runner|old-runner|db|migrate|psql|start-api|stop-api|start-proxy|stop-proxy|repo|register|start-runner|stop-runner|status|clean" >&2; exit 2 ;;
esac
