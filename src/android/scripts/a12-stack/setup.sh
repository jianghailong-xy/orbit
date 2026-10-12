#!/usr/bin/env bash
# Isolated Orbit server stack for task A12 (Android Wiki & Watch) — loopback only, no production data.
# Adapted from A11's src/android/scripts/a11-stack (commit 49c028579); same server and runner trees.
#   source : git archive of 3eb8e8594 (the project tip A12 merged on 2026-10-08: src/apiserver tree fbe271e6…,
#            src/shared tree bb96d8a6…, the same trees as A12's HEAD) into $S/src
#   deps   : node_modules hard-linked (cp -al) from a worktree whose package-lock.json is byte-identical;
#            @prisma/client is a private copy and the client is generated from THIS schema
#   db     : postgres:16-alpine "a12-stack-pg" on 127.0.0.1:5712, data on tmpfs (gone when the container stops)
#   api    : node dist/main.js on 127.0.0.1:3712, serves /api directly (app.setGlobalPrefix('api'))
#   runner : the 3eb8e8594 Go runner, ORBIT_HOME=$S/runner-home, HOME=$S/runner-userhome, no real engines on PATH
# Every process starts under `env -i` so nothing from the calling Orbit session (ORBIT_HOME, ORBIT_SESSION_ID,
# CLAUDE_CONFIG_DIR, …) or any provider credential leaks into the stack.
#
# Run it from the repository checkout (src/android/scripts/a12-stack/setup.sh): it installs itself, the node
# helpers and the fake engine into the stack directory. Overrides (the same for every command and helper):
#   A12_STACK_DIR (/var/tmp/a12-stack)  A12_STACK_API_PORT (3712)  A12_STACK_PG_PORT (5712)
#   A12_STACK_PG_CONTAINER (a12-stack-pg)  NM_SRC (a checkout with node_modules from the same lockfile; found if unset)
#
# usage: setup.sh build | db | start | stop | seed | status | reset | clean | readback [label]
#        (register <token>: used by seed)
#   reset = stop + wipe runner state + db (fresh tmpfs database, migrations) + start
#           + seed (seed.mjs: everything through the real API, ids into seed.json)
#   stop  = stop runner + apiserver (Postgres keeps running, data kept); clean = everything incl. container
#   readback = node readback.mjs: the seeded objects as the owner and as the other account read them, as JSON
# helper: node $S/api.mjs METHOD PATH [json] [--as owner|other]
set -euo pipefail

HERE=$(cd -P "$(dirname "${BASH_SOURCE[0]}")" && pwd)
REV=3eb8e8594aea152b96fa82dd0b444ca3cc4f301d
WANT_API_TREE=fbe271e6c219f180c80439ea0d6f5292409c9cc0
WANT_SHARED_TREE=bb96d8a6566d907cfa5b95e76d87211970881ad1
WANT_LOCK_SHA256=f0554c0375b5b06f71c47088d1b504a383639934b286f73f1b7f19272460c501

S=$(realpath -m "${A12_STACK_DIR:-/var/tmp/a12-stack}")
SRC=$S/src
LOG=$S/logs
PG=${A12_STACK_PG_CONTAINER:-a12-stack-pg}
PG_PORT=${A12_STACK_PG_PORT:-5712}
API_PORT=${A12_STACK_API_PORT:-3712}
API=http://127.0.0.1:$API_PORT/api
BASE_PATH=/usr/local/bin:/usr/bin:/bin
RUNNER_HOME=$S/runner-home          # ORBIT_HOME of the stack's runner
RUNNER_USERHOME=$S/runner-userhome  # HOME of the stack's runner (no ~/.claude, ~/.codex, …)
RUNNER_WORK=$S/runner-work          # the runner's workspace (a throwaway git repo)
RUNNER_BIN=$S/bin
# no /usr/local/bin (codex) and no /root/.local/bin (claude, agy): the only engine the runner can find is ours
RUNNER_PATH=$S/runner-path:/usr/bin:/bin
# what prepare() copies from the checkout into $S (the fake engine goes to $S/runner-path/claude)
INSTALLED=(setup.sh lib.mjs api.mjs seed.mjs readback.mjs live-args.mjs loopback-only.cjs)

die() { echo "setup.sh: $*" >&2; exit 1; }
pid_alive() { [ -f "$1" ] && kill -0 "$(cat "$1")" 2>/dev/null; }

case "$S/" in /root/*) die "A12_STACK_DIR=$S: the runner hides /root behind a tmpfs, so the stack cannot live there" ;; esac
# `clean` removes fixed paths under $S (bin, src, …): only ever in a directory this script made.
[ -e "$S/.a12-stack" ] || [ -z "$(ls -A "$S" 2>/dev/null)" ] || die "$S is not empty and was not made by this script"

# The stack directory, and (when run from the checkout) this script, the node helpers and the fake engine in it:
# the runner cannot see /root, where checkouts live, and seed.mjs calls $S/setup.sh. Each file is replaced by a
# rename, so a copy that is running (bash reads a script as it goes) keeps reading its own.
install_file() {  # install_file MODE SRC DEST
  cmp -s "$2" "$3" || { install -m "$1" "$2" "$3.new" && mv -f "$3.new" "$3"; }
}
prepare() {
  mkdir -p "$LOG"; touch "$S/.a12-stack"
  [ "$HERE" = "$S" ] && return
  mkdir -p "$S/runner-path"
  local f
  for f in "${INSTALLED[@]}"; do install_file "$([ "$f" = setup.sh ] && echo 755 || echo 644)" "$HERE/$f" "$S/$f"; done
  install_file 755 "$HERE/fake-claude" "$S/runner-path/claude"
  ln -sfn "$RUNNER_BIN/orbit" "$S/runner-path/orbit"
}

# The repository the scripts are checked out from: git archive reads the fixed revision from its object store.
repo() {
  local wt=${A12_STACK_REPO:-}
  [ -n "$wt" ] || wt=$(git -C "$HERE" rev-parse --show-toplevel 2>/dev/null) || die "build runs from the repository checkout (or set A12_STACK_REPO)"
  echo "$wt"
}

verify_trees() {
  local a s
  a=$(git -C "$WT" rev-parse "$REV:src/apiserver"); s=$(git -C "$WT" rev-parse "$REV:src/shared")
  [ "$a" = "$WANT_API_TREE" ] || die "src/apiserver tree at $REV is $a, want $WANT_API_TREE"
  [ "$s" = "$WANT_SHARED_TREE" ] || die "src/shared tree at $REV is $s, want $WANT_SHARED_TREE"
  echo "trees ok: $REV src/apiserver=$a src/shared=$s"
}

# A checkout whose node_modules are a plain install (npm ci) of this very lockfile; they are hard-linked, never
# written. Plain means no absolute symlinks (they would escape the copy) and no Prisma client under src/apiserver
# (only the root one is made private before `prisma generate`; overlay-style worktrees have both). The installed
# graph must satisfy the lockfile (the repo's own checker at $REV; reads only).
nm_src_ok() {
  [ -f "$1/package-lock.json" ] && [ -d "$1/node_modules" ] && [ ! -L "$1/node_modules" ] \
    && [ -d "$1/src/apiserver/node_modules" ] && [ ! -L "$1/src/apiserver/node_modules" ] \
    && [ ! -e "$1/src/apiserver/node_modules/.prisma" ] && [ ! -e "$1/src/apiserver/node_modules/@prisma" ] \
    && [ "$(sha256sum < "$1/package-lock.json" | cut -d' ' -f1)" = "$WANT_LOCK_SHA256" ] \
    && [ -z "$(find "$1/node_modules" "$1/src/apiserver/node_modules" -type l -lname '/*' -print -quit)" ] \
    && node "$SRC/scripts/worktree-dependencies.mjs" "$SRC" "$1" 2>/dev/null
}
find_nm_src() {
  local d
  while read -r d; do nm_src_ok "$d" && { echo "$d"; return 0; }; done \
    < <(git -C "$WT" worktree list --porcelain | sed -n 's/^worktree //p')
  return 1
}

cmd_build() {
  WT=$(repo)
  verify_trees
  [ "$(git -C "$WT" show "$REV:package-lock.json" | sha256sum | cut -d' ' -f1)" = "$WANT_LOCK_SHA256" ] || die "lockfile changed"
  rm -rf "$SRC"; mkdir -p "$SRC"
  git -C "$WT" archive "$REV" package.json package-lock.json tsconfig.base.json src/shared src/apiserver \
    scripts/worktree-dependencies.mjs | tar -x -C "$SRC"
  git -C "$WT" rev-parse "$REV^{commit}" > "$S/SOURCE_SHA"
  if [ -n "${NM_SRC:-}" ]; then
    nm_src_ok "$NM_SRC" || die "NM_SRC=$NM_SRC: no node_modules installed from lockfile $WANT_LOCK_SHA256"
  else
    NM_SRC=$(find_nm_src) || die "no worktree of $WT has node_modules installed from lockfile $WANT_LOCK_SHA256 (npm ci in one, or set NM_SRC)"
  fi
  echo "node_modules from $NM_SRC" | tee "$LOG/build-nm-src.log"
  cp -al "$NM_SRC/node_modules" "$SRC/node_modules"
  cp -al "$NM_SRC/src/apiserver/node_modules" "$SRC/src/apiserver/node_modules"
  # private Prisma client: never generate into inodes shared with another tree
  rm -rf "$SRC/node_modules/@prisma/client" "$SRC/node_modules/.prisma"
  cp -r "$NM_SRC/node_modules/@prisma/client" "$SRC/node_modules/@prisma/client"
  local abs; abs=$(find "$SRC/node_modules" "$SRC/src/apiserver/node_modules" -type l -lname '/*' | head -5)
  [ -z "$abs" ] || die "absolute symlinks would escape the tree: $abs"
  (cd "$SRC/src/apiserver" && env -i PATH="$BASE_PATH" HOME="$S" ../../node_modules/.bin/prisma generate) > "$LOG/build-prisma.log" 2>&1
  (cd "$SRC" && node_modules/.bin/tsc -p src/shared/tsconfig.json) > "$LOG/build-shared.log" 2>&1
  (cd "$SRC/src/apiserver" && rm -rf dist && ../../node_modules/.bin/tsc -p tsconfig.json) > "$LOG/build-apiserver.log" 2>&1
  (cd "$SRC/src/apiserver" && node -e "console.log(require.resolve('@orbit/shared'), require.resolve('.prisma/client/default'))") | tee "$LOG/build-resolve.log"
  grep -q "^$SRC/" "$LOG/build-resolve.log" || die "@orbit/shared resolves outside $SRC"
  build_runner
  echo built
}

build_runner() {
  local ver sha
  rm -rf "$S/runner-src"; mkdir -p "$S/runner-src" "$RUNNER_BIN"
  git -C "$WT" archive "$REV" src/runner-go | tar -x -C "$S/runner-src"
  ver=$(git -C "$WT" show "$REV:package.json" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).version))')
  sha=$(cat "$S/SOURCE_SHA")
  (cd "$S/runner-src/src/runner-go" && CGO_ENABLED=0 go build -trimpath -buildvcs=false \
     -ldflags "-s -w -X main.version=$ver -X main.sourceSHA=$sha" -o "$RUNNER_BIN/orbit" .) > "$LOG/build-runner.log" 2>&1
  "$RUNNER_BIN/orbit" --version | tee -a "$LOG/build-runner.log"
}

# Random per stack and never in the repository: the apiserver's JWT/provider keys and the database password.
load_secrets() {
  if [ ! -f "$S/secrets.env" ]; then
    (umask 077; printf 'JWT_SECRET=%s\nPROVIDER_SECRET_KEY=%s\nPG_PASSWORD=%s\n' \
      "$(openssl rand -hex 32)" "$(openssl rand -base64 32)" "$(openssl rand -hex 16)" > "$S/secrets.env")
  fi
  # shellcheck disable=SC1091
  set -a; . "$S/secrets.env"; set +a
  DB_URL=postgresql://orbit:$PG_PASSWORD@127.0.0.1:$PG_PORT/orbit
}

cmd_db() {
  load_secrets
  docker rm -f -v "$PG" >/dev/null 2>&1 || true
  docker run -d --name "$PG" --label a12-stack=1 -e POSTGRES_USER=orbit -e POSTGRES_PASSWORD="$PG_PASSWORD" -e POSTGRES_DB=orbit \
    -p 127.0.0.1:$PG_PORT:5432 --tmpfs /var/lib/postgresql/data postgres:16-alpine >/dev/null
  for _ in $(seq 1 60); do docker exec "$PG" pg_isready -h 127.0.0.1 -U orbit >/dev/null 2>&1 && break; sleep 1; done
  sleep 2
  (cd "$SRC/src/apiserver" && env -i PATH="$BASE_PATH" HOME="$S" DATABASE_URL="$DB_URL" ../../node_modules/.bin/prisma migrate deploy) > "$LOG/migrate.log" 2>&1
  tail -2 "$LOG/migrate.log"
}

start_api() {
  if pid_alive "$S/api.pid"; then echo "apiserver already running (pid $(cat "$S/api.pid"))"; return; fi
  [ -f "$SRC/src/apiserver/dist/main.js" ] || die "not built"
  load_secrets
  cd "$SRC"
  env -i PATH="$BASE_PATH" HOME="$S" LANG=C.UTF-8 \
    DATABASE_URL="$DB_URL" PORT="$API_PORT" JWT_SECRET="$JWT_SECRET" PROVIDER_SECRET_KEY="$PROVIDER_SECRET_KEY" \
    PUBLIC_ORIGIN="http://127.0.0.1:$API_PORT" CORS_ORIGINS="http://127.0.0.1:$API_PORT" \
    ${ACCESS_TOKEN_TTL:+ACCESS_TOKEN_TTL=$ACCESS_TOKEN_TTL} \
    setsid -f node --max-old-space-size=1024 --require "$S/loopback-only.cjs" src/apiserver/dist/main.js >> "$LOG/apiserver.log" 2>&1 < /dev/null
  cd - >/dev/null
  local pid=""
  for _ in $(seq 1 120); do
    pid=$(ss -ltnpH "sport = :$API_PORT" 2>/dev/null | grep -o 'pid=[0-9]*' | head -1 | cut -d= -f2 || true)
    [ -n "$pid" ] && break; sleep 1
  done
  [ -n "$pid" ] || { tail -20 "$LOG/apiserver.log"; die "apiserver did not listen on $API_PORT"; }
  echo "$pid" > "$S/api.pid"
  echo "apiserver pid $pid on 127.0.0.1:$API_PORT"
}

# Runs a command as the stack runner. The runner resolves engine CLIs from the passwd home's
# ~/.local/bin (/root/.local/bin: the host's real claude and agy) AHEAD of PATH (runner-go
# serviceLoginPath), so HOME alone cannot isolate it: it runs in a private mount namespace with an
# empty tmpfs over /root (invisible to the host), a scrubbed environment, its own HOME/ORBIT_HOME/TMPDIR,
# and a PATH whose only engine is the fake claude in $S/runner-path.
runner_exec() {
  mkdir -p "$RUNNER_HOME" "$RUNNER_USERHOME" "$S/runner-tmp"; chmod 700 "$RUNNER_HOME" "$RUNNER_USERHOME"
  unshare --mount --propagation private -- /bin/sh -c \
    'mount -t tmpfs -o size=4m,mode=0700 a12-stack-hide-root /root && cd "$0" && exec "$@"' "$RUNNER_WORK" \
    env -i PATH="$RUNNER_PATH" HOME="$RUNNER_USERHOME" LANG=C.UTF-8 USER=root LOGNAME=root \
      ORBIT_HOME="$RUNNER_HOME" ORBIT_NO_SELFUPDATE=1 ORBIT_NO_ENGINE_UPDATE=1 \
      XDG_CONFIG_HOME="$RUNNER_USERHOME/.config" XDG_CACHE_HOME="$RUNNER_USERHOME/.cache" \
      XDG_DATA_HOME="$RUNNER_USERHOME/.local/share" XDG_STATE_HOME="$RUNNER_USERHOME/.local/state" \
      TMPDIR="$S/runner-tmp" GIT_CONFIG_NOSYSTEM=1 A12_FAKE_CLAUDE_LOG="$LOG/fake-claude.jsonl" \
      "$@"
}

# The runner's workspace: a throwaway git repository with a local identity (nothing leaves this host).
ensure_runner_work() {
  local g="env -i PATH=/usr/bin:/bin HOME=$RUNNER_USERHOME GIT_CONFIG_NOSYSTEM=1 git"
  if [ ! -d "$RUNNER_WORK/.git" ]; then
    mkdir -p "$RUNNER_WORK"
    $g -C "$RUNNER_WORK" init -q -b main
    $g -C "$RUNNER_WORK" config user.name "A12 Stack Runner"; $g -C "$RUNNER_WORK" config user.email runner@a12.test
    printf '# a12 stack sandbox\n\nThrowaway repository for the isolated A12 Orbit stack runner.\n' > "$RUNNER_WORK/README.md"
    $g -C "$RUNNER_WORK" add README.md; $g -C "$RUNNER_WORK" commit -qm "init sandbox"
  fi
}

cmd_register() {  # setup.sh register <enrollment-token>
  local token=${1:?enrollment token}
  ensure_runner_work
  stop_pidfile "$S/runner.pid" runner
  runner_exec "$RUNNER_BIN/orbit" register --server "http://127.0.0.1:$API_PORT" --token "$token" \
    --name a12-stack-runner --workdir "$RUNNER_WORK" --no-service --no-auto-install-engines --force \
    > "$LOG/register.log" 2>&1 || { cat "$LOG/register.log"; die "register failed"; }
  grep -m1 registered "$LOG/register.log"
}

# The stack runner's processes: those whose executable is this stack's binary — never a name or command-line match
# (this host's real Orbit runner is also called orbit, and a command line can merely mention the path).
runner_pids() {
  local p
  for p in $(pgrep -x orbit 2>/dev/null || true); do
    [ "$(readlink "/proc/$p/exe" 2>/dev/null)" = "$RUNNER_BIN/orbit" ] && echo "$p"
  done
  return 0
}

start_runner() {
  [ -f "$RUNNER_HOME/config.json" ] || { echo "runner not registered (seed registers it); skipping"; return; }
  if pid_alive "$S/runner.pid"; then echo "runner already running (pid $(cat "$S/runner.pid"))"; return; fi
  runner_exec setsid -f "$RUNNER_BIN/orbit" run >> "$LOG/runner.log" 2>&1 < /dev/null
  local pid=""
  for _ in $(seq 1 40); do
    pid=$(runner_pids | head -1)
    [ -n "$pid" ] && break; sleep 0.5
  done
  [ -n "$pid" ] || die "runner did not start"
  echo "$pid" > "$S/runner.pid"
  echo "runner pid $pid (ORBIT_HOME=$RUNNER_HOME)"
}

cmd_start() {
  docker ps --format '{{.Names}}' | grep -qx "$PG" || die "$PG is not running (run: setup.sh db)"
  start_api
  start_runner
}

stop_pidfile() {
  local f=$1 name=$2
  if pid_alive "$f"; then
    local p; p=$(cat "$f"); kill "$p" 2>/dev/null || true
    for _ in $(seq 1 20); do kill -0 "$p" 2>/dev/null || break; sleep 0.5; done
    kill -0 "$p" 2>/dev/null && kill -9 "$p" 2>/dev/null || true
    echo "stopped $name ($p)"
  fi
  rm -f "$f"
}

cmd_stop() {
  stop_pidfile "$S/runner.pid" runner
  # Anything of the stack's binary still up (a child the runner started, a crash between setsid and the pidfile).
  local p
  for p in $(runner_pids); do kill "$p" 2>/dev/null || true; echo "stopped $p (the stack's orbit binary)"; done
  stop_pidfile "$S/api.pid" apiserver
}

cmd_status() {
  echo "stack: $S (api 127.0.0.1:$API_PORT, postgres $PG on 127.0.0.1:$PG_PORT)"
  echo "source: $(cat "$S/SOURCE_SHA" 2>/dev/null || echo '?')"
  docker ps -a --filter "name=^${PG}\$" --format 'postgres: {{.Names}} {{.Status}} {{.Ports}}'
  if pid_alive "$S/api.pid"; then echo "apiserver: pid $(cat "$S/api.pid")"; else echo "apiserver: down"; fi
  if pid_alive "$S/runner.pid"; then echo "runner: pid $(cat "$S/runner.pid")"; else echo "runner: down"; fi
  printf 'GET /api/health: '; curl -s -m 5 "$API/health" || printf 'unreachable'; echo
  ss -ltnH "( sport = :$API_PORT or sport = :$PG_PORT )" | awk '{print "listen: "$4}'
}

# The node helpers get a scrubbed environment that says only where this stack is (seed.mjs passes it on to
# $S/setup.sh register/start).
node_env() {
  env -i PATH="$BASE_PATH" HOME="$S" A12_STACK_DIR="$S" A12_STACK_API_PORT="$API_PORT" \
    A12_STACK_PG_PORT="$PG_PORT" A12_STACK_PG_CONTAINER="$PG" "$@"
}

cmd_clean() {
  cmd_stop || true
  docker rm -f -v "$PG" >/dev/null 2>&1 && echo "removed $PG" || true
  rm -rf "$SRC" "$S/runner-src" "$RUNNER_BIN" "$RUNNER_HOME" "$RUNNER_USERHOME" "$RUNNER_WORK" "$S/runner-tmp" \
    "$S/secrets.env" "$S/seed.json" "$S/accounts.json" "$S/SOURCE_SHA" "$LOG" "$S/.cache" "$S/.config" "$S/.npm" \
    "$S/runner-path" "${INSTALLED[@]/#/$S/}" "$S/.a12-stack"
  rmdir "$S" 2>/dev/null || true
  echo cleaned
}

case "${1:-}" in
  build|db|start|seed|reset|readback|register) prepare ;;
esac
case "${1:-}" in
  build) cmd_build ;;
  db) cmd_db ;;
  start) cmd_start ;;
  stop) cmd_stop ;;
  seed) node_env node "$S/seed.mjs" ;;
  status) cmd_status ;;
  register) shift; cmd_register "$@" ;;
  reset) cmd_stop; rm -rf "$RUNNER_HOME" "$RUNNER_USERHOME" "$RUNNER_WORK" "$S/runner-tmp" "$S/seed.json" "$S/accounts.json"
         rm -f "$LOG/fake-claude.jsonl"; cmd_db; cmd_start; node_env node "$S/seed.mjs" ;;
  clean) cmd_clean ;;
  readback) shift; node_env node "$S/readback.mjs" "$@" ;;
  *) echo "usage: $0 build|db|start|stop|seed|status|reset|clean|readback [label]|register <token>" >&2; exit 2 ;;
esac
