#!/usr/bin/env bash
# Local stack for the Kimi Code multi-account integration (task 34cM1TaZiO8CtZCSGxdDp) — loopback only. See README.md.
# After src/android/scripts/a11-stack/setup.sh, built from this checkout instead of a pinned revision:
#   db      : postgres:16-alpine "$PG" on 127.0.0.1:$PG_PORT, data on tmpfs; `prisma migrate deploy` of the checkout
#   api     : the checkout's src/apiserver/dist/main.js on 127.0.0.1:$API_PORT (env -i, loopback-only preload)
#   kimi    : the fake Kimi server (fake-kimi-server.mjs) on 127.0.0.1:$FK_PORT — device sign-in, token refresh,
#             per-account GET /coding/v1/usages, admin API — and the fake `kimi` CLI (fake-kimi.mjs) on the
#             runners' PATH
#   runners : the checkout's src/runner-go, built twice: `orbit` (as is) and `orbit-nocap` (the same source with
#             kimi-account-login/v1, kimi-account-remove/v1 and kimi-account-move/v1 taken out of its capability
#             list). Each runs in a private mount namespace: an empty tmpfs over /root (no real engine, no real
#             ~/.kimi-code) and an /etc/hosts that maps auth./api.kimi.com and auth./api.kimi.ai to 127.0.0.1, so the
#             logins the fake CLI writes (http://api.kimi.com:$FK_PORT/coding/v1, …) reach the fake server and
#             nothing else. Own HOME (Default's ~/.kimi-code is in it), ORBIT_HOME, TMPDIR, PATH.
#   web     : vite dev of the checkout's src/web on 127.0.0.1:$WEB_PORT, and of the old client — main's src/web at
#             $MAIN_REV (git archive) — on 127.0.0.1:$MAIN_WEB_PORT, both proxying /api to the apiserver.
#
# usage: stack.sh build | db | api | fake-kimi | web | main-web | register <name> <bin> <token> | start <name> |
#                 stop <name> | default-login <name> <region> <user> | status | down | clean
set -euo pipefail

SCRIPTS=$(cd -P "$(dirname "${BASH_SOURCE[0]}")" && pwd)
WT=${KIMI_STACK_REPO:-$(git -C "$SCRIPTS" rev-parse --show-toplevel)}
S=$(realpath -m "${KIMI_STACK_DIR:-/var/tmp/kimi-accounts-stack}")
case "$S/" in /root/*) echo "stack.sh: KIMI_STACK_DIR=$S: the runners hide /root behind a tmpfs, so the stack cannot live there" >&2; exit 1 ;; esac
LOG=$S/logs
PG=${KIMI_STACK_PG:-kimi-accounts-stack-pg}
PG_PORT=${KIMI_STACK_PG_PORT:-5741}
API_PORT=${KIMI_STACK_API_PORT:-3741}
WEB_PORT=${KIMI_STACK_WEB_PORT:-4741}
MAIN_WEB_PORT=${KIMI_STACK_MAIN_WEB_PORT:-4742}
FK_PORT=${KIMI_STACK_FAKE_KIMI_PORT:-18741}
# The old client: main's web just before this project's web landed on main (b8bc76d1f merged it).
MAIN_REV=${KIMI_STACK_MAIN_REV:-721e48275dcfac150c6944e0d5fae399cf6d83e8}
BASE_PATH=/usr/local/bin:/usr/bin:/bin
RUNNER_PATH=$S/runner-path:/usr/bin:/bin

die() { echo "stack.sh: $*" >&2; exit 1; }
pid_alive() { [ -f "$1" ] && kill -0 "$(cat "$1")" 2>/dev/null; }
mkdir -p "$LOG" "$S/bin" "$S/runner-path" "$S/runners" "$S/run"

load_secrets() {
  if [ ! -f "$S/secrets.env" ]; then
    (umask 077; printf 'JWT_SECRET=%s\nPROVIDER_SECRET_KEY=%s\nPG_PASSWORD=%s\n' \
      "$(openssl rand -hex 32)" "$(openssl rand -base64 32)" "$(openssl rand -hex 16)" > "$S/secrets.env")
  fi
  set -a; . "$S/secrets.env"; set +a
  DB_URL=postgresql://orbit:$PG_PASSWORD@127.0.0.1:$PG_PORT/orbit
}

wait_port() {  # wait_port PORT SECONDS → pid listening
  local pid=""
  for _ in $(seq 1 "$2"); do
    pid=$(ss -ltnpH "sport = :$1" 2>/dev/null | grep -o 'pid=[0-9]*' | head -1 | cut -d= -f2 || true)
    [ -n "$pid" ] && { echo "$pid"; return 0; }
    sleep 1
  done
  return 1
}

cmd_build() {
  local ver sha
  ver=$(node -p "require('$WT/package.json').version")
  sha=$(git -C "$WT" rev-parse HEAD)
  echo "checkout $WT at $sha (version $ver); dirty files: $(git -C "$WT" status --porcelain | wc -l)"
  (cd "$WT/src/apiserver" && npm run build) > "$LOG/build-apiserver.log" 2>&1 || { tail -20 "$LOG/build-apiserver.log"; die "apiserver build failed"; }
  echo "apiserver dist built"
  (cd "$WT/src/runner-go" && CGO_ENABLED=0 go build -trimpath -buildvcs=false \
     -ldflags "-s -w -X main.version=$ver -X main.sourceSHA=$sha" -o "$S/bin/orbit" .) > "$LOG/build-runner.log" 2>&1 \
     || { tail -20 "$LOG/build-runner.log"; die "runner build failed"; }
  # The capability-less runner: the same source with the three kimi-account-* capabilities taken out.
  rm -rf "$S/runner-nocap-src"; mkdir -p "$S/runner-nocap-src"
  cp -a "$WT/src/runner-go/." "$S/runner-nocap-src/"
  sed -i -e '/^\t\tkimiAccountLoginCapabilityV1,$/d' -e '/^\t\tkimiAccountRemoveCapabilityV1,$/d' \
    -e '/^\t\tkimiAccountMoveCapabilityV1,$/d' "$S/runner-nocap-src/transport.go"
  diff -u "$WT/src/runner-go/transport.go" "$S/runner-nocap-src/transport.go" > "$LOG/runner-nocap.diff" || true
  [ "$(grep -c '^-' "$LOG/runner-nocap.diff")" -eq 4 ] || { cat "$LOG/runner-nocap.diff"; die "the nocap patch did not remove exactly three lines"; }
  (cd "$S/runner-nocap-src" && CGO_ENABLED=0 go build -trimpath -buildvcs=false \
     -ldflags "-s -w -X main.version=$ver -X main.sourceSHA=$sha" -o "$S/bin/orbit-nocap" .) >> "$LOG/build-runner.log" 2>&1 \
     || { tail -20 "$LOG/build-runner.log"; die "nocap runner build failed"; }
  "$S/bin/orbit" --version; "$S/bin/orbit-nocap" --version
  install -m 755 "$SCRIPTS/fake-kimi.mjs" "$S/runner-path/kimi"
  printf '127.0.0.1\tlocalhost\n::1\tlocalhost\n127.0.0.1\tauth.kimi.com api.kimi.com www.kimi.com auth.kimi.ai api.kimi.ai www.kimi.ai\n' > "$S/hosts"
  # origin/main's web for the old-client check: the same lockfile as the checkout, so its node_modules serve.
  [ "$(git -C "$WT" show "$MAIN_REV:package-lock.json" | sha256sum)" = "$(sha256sum < "$WT/package-lock.json")" ] || die "$MAIN_REV has another lockfile"
  rm -rf "$S/main-src"; mkdir -p "$S/main-src"
  git -C "$WT" archive "$MAIN_REV" package.json tsconfig.base.json src/web src/shared | tar -x -C "$S/main-src"
  git -C "$WT" rev-parse "$MAIN_REV" > "$S/main-src/SOURCE_SHA"
  ln -sfn "$WT/node_modules" "$S/main-src/node_modules"
  echo "main web: $(cat "$S/main-src/SOURCE_SHA")"
}

cmd_db() {
  load_secrets
  docker rm -f -v "$PG" >/dev/null 2>&1 || true
  docker run -d --name "$PG" --label kimi-accounts-stack=1 -e POSTGRES_USER=orbit -e POSTGRES_PASSWORD="$PG_PASSWORD" -e POSTGRES_DB=orbit \
    -p 127.0.0.1:$PG_PORT:5432 --tmpfs /var/lib/postgresql/data postgres:16-alpine >/dev/null
  for _ in $(seq 1 60); do docker exec "$PG" pg_isready -h 127.0.0.1 -U orbit >/dev/null 2>&1 && break; sleep 1; done
  sleep 2
  (cd "$WT/src/apiserver" && env -i PATH="$BASE_PATH" HOME="$S" DATABASE_URL="$DB_URL" ../../node_modules/.bin/prisma migrate deploy) > "$LOG/migrate.log" 2>&1
  tail -2 "$LOG/migrate.log"
}

cmd_api() {
  if pid_alive "$S/run/api.pid"; then echo "apiserver already running (pid $(cat "$S/run/api.pid"))"; return; fi
  load_secrets
  (cd "$WT/src/apiserver" && env -i PATH="$BASE_PATH" HOME="$S" LANG=C.UTF-8 \
    DATABASE_URL="$DB_URL" PORT="$API_PORT" JWT_SECRET="$JWT_SECRET" PROVIDER_SECRET_KEY="$PROVIDER_SECRET_KEY" \
    PUBLIC_ORIGIN="http://127.0.0.1:$WEB_PORT" CORS_ORIGINS="http://127.0.0.1:$WEB_PORT,http://127.0.0.1:$MAIN_WEB_PORT" \
    setsid -f node --max-old-space-size=1536 --require "$WT/src/android/scripts/a11-stack/loopback-only.cjs" dist/main.js >> "$LOG/apiserver.log" 2>&1 < /dev/null)
  local pid; pid=$(wait_port "$API_PORT" 240) || { tail -20 "$LOG/apiserver.log"; die "apiserver did not listen on $API_PORT"; }
  echo "$pid" > "$S/run/api.pid"; echo "apiserver pid $pid on 127.0.0.1:$API_PORT"
}

cmd_fake_kimi() {
  if pid_alive "$S/run/fake-kimi.pid"; then echo "fake kimi server already running"; return; fi
  setsid -f env -i PATH="$BASE_PATH" FAKE_KIMI_ACCESS_TTL="${FAKE_KIMI_ACCESS_TTL:-900}" node "$SCRIPTS/fake-kimi-server.mjs" "$FK_PORT" "$S/fake-kimi-state.json" "$LOG/fake-kimi-requests.jsonl" \
    >> "$LOG/fake-kimi-server.log" 2>&1 < /dev/null
  local pid; pid=$(wait_port "$FK_PORT" 20) || die "fake kimi server did not listen"
  echo "$pid" > "$S/run/fake-kimi.pid"; echo "fake kimi server pid $pid on 127.0.0.1:$FK_PORT"
}

serve_web() {  # serve_web NAME ROOT PORT
  local name=$1 root=$2 port=$3
  if pid_alive "$S/run/$name.pid"; then echo "$name already running"; return; fi
  setsid -f env -i PATH="$BASE_PATH" HOME="$S" node "$SCRIPTS/serve-web.mjs" "$WT" "$root" "$port" "$API_PORT" "$S/vite-cache-$name" \
    >> "$LOG/$name.log" 2>&1 < /dev/null
  local pid; pid=$(wait_port "$port" 120) || { tail -20 "$LOG/$name.log"; die "$name did not listen on $port"; }
  echo "$pid" > "$S/run/$name.pid"; echo "$name pid $pid on http://127.0.0.1:$port"
}

# Runs a command as runner NAME: private mount namespace (tmpfs over /root, the stack's /etc/hosts), scrubbed env.
runner_exec() {
  local name=$1; shift
  local R=$S/runners/$name
  mkdir -p "$R/home" "$R/userhome" "$R/tmp"; chmod 700 "$R/home" "$R/userhome"
  unshare --mount --propagation private -- /bin/sh -c \
    'mount -t tmpfs -o size=4m,mode=0700 kimi-stack-hide-root /root && mount --bind "$1" /etc/hosts && cd "$2" && shift 2 && exec "$@"' \
    sh "$S/hosts" "$R" \
    env -i PATH="$RUNNER_PATH" HOME="$R/userhome" LANG=C.UTF-8 USER=root LOGNAME=root \
      ORBIT_HOME="$R/home" ORBIT_NO_SELFUPDATE=1 ORBIT_NO_ENGINE_UPDATE=1 \
      XDG_CONFIG_HOME="$R/userhome/.config" XDG_CACHE_HOME="$R/userhome/.cache" \
      XDG_DATA_HOME="$R/userhome/.local/share" XDG_STATE_HOME="$R/userhome/.local/state" \
      TMPDIR="$R/tmp" GIT_CONFIG_NOSYSTEM=1 \
      FAKE_KIMI_SERVER="http://127.0.0.1:$FK_PORT" FAKE_KIMI_LOG="$LOG/fake-kimi-$name.jsonl" \
      "$@"
}

ensure_work() {  # a throwaway git repo per runner, with a local bare origin
  local R=$S/runners/$1
  local g="env -i PATH=/usr/bin:/bin HOME=$R/userhome GIT_CONFIG_NOSYSTEM=1 git"
  if [ ! -d "$R/work/.git" ]; then
    mkdir -p "$R/work"
    $g -C "$R/work" init -q -b main
    $g -C "$R/work" config user.name "Kimi Stack Runner"; $g -C "$R/work" config user.email runner@kimi-int.test
    printf '# kimi integration sandbox (%s)\n' "$1" > "$R/work/README.md"
    $g -C "$R/work" add README.md; $g -C "$R/work" commit -qm "init sandbox"
  fi
  [ -d "$R/origin.git" ] || $g init -q --bare -b main "$R/origin.git"
  $g -C "$R/work" remote get-url origin >/dev/null 2>&1 || $g -C "$R/work" remote add origin "$R/origin.git"
  $g -C "$R/work" push -q -u origin main
}

cmd_register() {  # register NAME BIN TOKEN
  local name=$1 bin=$2 token=$3
  ensure_work "$name"
  echo "$bin" > "$S/runners/$name/BIN"
  runner_exec "$name" "$S/bin/$bin" register --server "http://127.0.0.1:$API_PORT" --token "$token" \
    --name "$name" --workdir "$S/runners/$name/work" --no-service --no-auto-install-engines --force \
    > "$LOG/register-$name.log" 2>&1 || { cat "$LOG/register-$name.log"; die "register failed"; }
  grep -m1 -i registered "$LOG/register-$name.log" || true
}

cmd_start() {
  local name=$1 R=$S/runners/$1
  [ -f "$R/home/config.json" ] || die "runner $name is not registered"
  if pid_alive "$S/run/runner-$name.pid"; then echo "runner $name already running"; return; fi
  local bin; bin=$(cat "$R/BIN")
  runner_exec "$name" setsid -f "$S/bin/$bin" run >> "$LOG/runner-$name.log" 2>&1 < /dev/null
  local pid=""
  for _ in $(seq 1 20); do pid=$(pgrep -f "^$S/bin/$bin run" | while read -r p; do
      [ "$(tr '\0' '\n' < /proc/$p/environ 2>/dev/null | grep -c "^ORBIT_HOME=$R/home$")" = 1 ] && echo "$p"; done | head -1); [ -n "$pid" ] && break; sleep 0.5; done
  [ -n "$pid" ] || die "runner $name did not start"
  echo "$pid" > "$S/run/runner-$name.pid"; echo "runner $name pid $pid ($bin, ORBIT_HOME=$R/home)"
}

stop_pidfile() {
  local f=$1 name=$2
  if pid_alive "$f"; then
    local p; p=$(cat "$f"); kill "$p" 2>/dev/null || true
    for _ in $(seq 1 30); do kill -0 "$p" 2>/dev/null || break; sleep 0.5; done
    kill -0 "$p" 2>/dev/null && kill -9 "$p" 2>/dev/null || true
    echo "stopped $name ($p)"
  fi
  rm -f "$f"
}

# Signs a runner's Default account in with the fake CLI, as somebody would at that machine's terminal (`kimi
# login`): the device code is approved on the fake server as USER.
cmd_default_login() {  # default-login NAME REGION USER [TOKEN_TTL_SECONDS]
  local name=$1 region=$2 user=$3 ttl=${4:-} out=$LOG/default-login-$1.err
  runner_exec "$name" kimi login --region "$region" > "$LOG/default-login-$name.out" 2> "$out" &
  local lp=$! code=""
  for _ in $(seq 1 40); do code=$(sed -n 's/.*enter code: //p' "$out"); [ -n "$code" ] && break; sleep 0.25; done
  [ -n "$code" ] || { cat "$out"; die "no device code"; }
  curl -sf -XPOST -H 'content-type: application/json' -d "{\"userCode\":\"$code\",\"user\":\"$user\"${ttl:+,\"ttl\":$ttl}}" "http://127.0.0.1:$FK_PORT/__admin/approve"; echo
  wait "$lp"; cat "$LOG/default-login-$name.out"
}

cmd_status() {
  echo "stack: $S  checkout: $WT ($(git -C "$WT" rev-parse --short HEAD))"
  docker ps -a --filter "name=^${PG}\$" --format 'postgres: {{.Names}} {{.Status}} {{.Ports}}'
  for f in "$S"/run/*.pid; do [ -e "$f" ] || continue; n=$(basename "$f" .pid); if pid_alive "$f"; then echo "$n: pid $(cat "$f")"; else echo "$n: down"; fi; done
  printf 'GET /api/health: '; curl -s -m 5 "http://127.0.0.1:$API_PORT/api/health" || printf 'unreachable'; echo
}

cmd_down() {
  for f in "$S"/run/runner-*.pid; do [ -e "$f" ] && stop_pidfile "$f" "$(basename "$f" .pid)"; done
  for n in web main-web api fake-kimi; do stop_pidfile "$S/run/$n.pid" "$n"; done
}

case "${1:-}" in
  build) cmd_build ;;
  db) cmd_db ;;
  api) cmd_api ;;
  fake-kimi) cmd_fake_kimi ;;
  web) serve_web web "$WT/src/web" "$WEB_PORT" ;;
  main-web) serve_web main-web "$S/main-src/src/web" "$MAIN_WEB_PORT" ;;
  register) shift; cmd_register "$@" ;;
  start) cmd_start "$2" ;;
  stop) stop_pidfile "$S/run/runner-$2.pid" "runner $2" ;;
  exec) shift; name=$1; shift; runner_exec "$name" "$@" ;;
  default-login) shift; cmd_default_login "$@" ;;
  status) cmd_status ;;
  down) cmd_down ;;
  clean) cmd_down; docker rm -f -v "$PG" >/dev/null 2>&1 && echo "removed $PG" || true ;;
  *) echo "usage: $0 build|db|api|fake-kimi|web|main-web|register <name> <bin> <token>|start <name>|stop <name>|exec <name> cmd…|default-login <name> <region> <user>|status|down|clean" >&2; exit 2 ;;
esac
