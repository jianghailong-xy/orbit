#!/usr/bin/env bash
# A loopback-only stack for the running-mode web states (board docs/mocks/permission-mode-actual; task 350TVt7QvzeqPJKO7tFuS):
# this checkout's apiserver on a real PostgreSQL, which seed.mjs fills through the server's own write paths and capture.mjs
# shoots this checkout's built web against. See README.md.
#   db   : postgres:16-alpine on tmpfs, a port docker picks on 127.0.0.1, migrated with this checkout's `prisma migrate deploy`
#   api  : this checkout's src/apiserver/dist/main.js under `env -i`, on a free 127.0.0.1 port (the loopback-only preload)
# usage: stack.sh up | down | status | env
set -uo pipefail

HERE=$(cd -P "$(dirname "${BASH_SOURCE[0]}")" && pwd)
WT=$(git -C "$HERE" rev-parse --show-toplevel)
S=$(realpath -m "${PMA_STACK_DIR:-/var/tmp/permission-mode-actual-stack}")
PG=${PMA_STACK_PG:-pma-stack-pg-$(basename "$S")}
BASE_PATH=/usr/local/bin:/usr/bin:/bin
mkdir -p "$S/logs" "$S/run"
die() { echo "stack.sh: $*" >&2; exit 1; }

secrets() {
  if [ ! -f "$S/secrets.env" ]; then
    (umask 077; printf 'JWT_SECRET=%s\nPROVIDER_SECRET_KEY=%s\nPG_PASSWORD=%s\n' \
      "$(openssl rand -hex 32)" "$(openssl rand -base64 32)" "$(openssl rand -hex 16)" > "$S/secrets.env")
  fi
  set -a; . "$S/secrets.env"; set +a
}

free_port() { python3 -I -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1]); s.close()'; }

cmd_up() {
  secrets
  [ -d "$WT/src/apiserver/dist" ] || die "build the apiserver first: (cd src/apiserver && npm run build)"
  docker rm -f -v "$PG" >/dev/null 2>&1 || true
  docker run -d --name "$PG" --label pma-stack=1 -e POSTGRES_USER=orbit -e POSTGRES_PASSWORD="$PG_PASSWORD" -e POSTGRES_DB=orbit \
    -p 127.0.0.1::5432 --tmpfs /var/lib/postgresql/data postgres:16-alpine >/dev/null || die "docker run $PG failed"
  local pg_port; pg_port=$(docker port "$PG" 5432/tcp | head -1 | sed 's/.*://') || true
  [ -n "$pg_port" ] || die "no port for $PG"
  for _ in $(seq 1 60); do docker exec "$PG" pg_isready -h 127.0.0.1 -U orbit >/dev/null 2>&1 && break; sleep 1; done
  sleep 2
  local db_url="postgresql://orbit:$PG_PASSWORD@127.0.0.1:$pg_port/orbit"
  # The database answering on that port is this container's, and empty, before anything is migrated into it.
  local who; who=$(docker exec "$PG" psql -U orbit -d orbit -Atc "select current_database() || ' ' || (select count(*) from pg_tables where schemaname='public')") \
    || die "cannot read $PG"
  [ "$who" = "orbit 0" ] || die "$PG is not an empty orbit database ($who)"
  (cd "$WT/src/apiserver" && env -i PATH="$BASE_PATH" HOME="$S" DATABASE_URL="$db_url" ../../node_modules/.bin/prisma migrate deploy) \
    > "$S/logs/migrate.log" 2>&1 || { tail -20 "$S/logs/migrate.log"; die "migrate deploy failed"; }
  tail -1 "$S/logs/migrate.log"
  local api_port; api_port=$(free_port)
  (cd "$WT/src/apiserver" && env -i PATH="$BASE_PATH" HOME="$S" LANG=C.UTF-8 TZ=UTC \
    DATABASE_URL="$db_url" PORT="$api_port" JWT_SECRET="$JWT_SECRET" PROVIDER_SECRET_KEY="$PROVIDER_SECRET_KEY" \
    PUBLIC_ORIGIN="http://127.0.0.1:$api_port" \
    setsid -f node --max-old-space-size=1536 --require "$WT/src/android/scripts/a11-stack/loopback-only.cjs" dist/main.js \
      >> "$S/logs/apiserver.log" 2>&1 < /dev/null)
  local ok=""
  for _ in $(seq 1 240); do curl -sf -m 2 "http://127.0.0.1:$api_port/api/health" >/dev/null 2>&1 && { ok=1; break; }; sleep 1; done
  [ -n "$ok" ] || { tail -30 "$S/logs/apiserver.log"; die "apiserver did not answer /api/health on $api_port"; }
  local pid; pid=$(ss -ltnpH "sport = :$api_port" | grep -o 'pid=[0-9]*' | head -1 | cut -d= -f2)
  echo "$pid" > "$S/run/api.pid"
  printf 'PMA_API=http://127.0.0.1:%s/api\nPMA_DATABASE_URL=%s\nPMA_PG=%s\nPMA_WT=%s\nPMA_SHA=%s\n' \
    "$api_port" "$db_url" "$PG" "$WT" "$(git -C "$WT" rev-parse HEAD)" > "$S/stack.env"
  chmod 600 "$S/stack.env"
  echo "apiserver pid $pid on 127.0.0.1:$api_port (checkout $(git -C "$WT" rev-parse --short HEAD), dirty files: $(git -C "$WT" status --porcelain | wc -l)); postgres $PG on 127.0.0.1:$pg_port"
}

cmd_down() {
  if [ -f "$S/run/api.pid" ] && kill -0 "$(cat "$S/run/api.pid")" 2>/dev/null; then
    kill "$(cat "$S/run/api.pid")"; echo "stopped apiserver $(cat "$S/run/api.pid")"
  fi
  rm -f "$S/run/api.pid"
  docker rm -f -v "$PG" >/dev/null 2>&1 && echo "removed $PG" || true
}

cmd_status() {
  docker ps -a --filter "name=^${PG}\$" --format 'postgres: {{.Names}} {{.Status}} {{.Ports}}'
  [ -f "$S/stack.env" ] && . "$S/stack.env" && printf 'GET /api/health: %s\n' "$(curl -s -m 5 "$PMA_API/health" || echo unreachable)"
}

case "${1:-}" in
  up) cmd_up ;;
  down) cmd_down ;;
  status) cmd_status ;;
  env) cat "$S/stack.env" ;;
  *) echo "usage: $0 up|down|status|env" >&2; exit 2 ;;
esac
