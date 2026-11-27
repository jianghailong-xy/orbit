#!/usr/bin/env bash
# The Scheduled page chat against this checkout's real apiserver (task 354CXjMVTfnhPkEoj0DhZ): a throwaway PostgreSQL
# on tmpfs (docker, 127.0.0.1:5757), this checkout's src/apiserver/dist/main.js on :3757, the built web through
# gateway.mjs on 127.0.0.1:2757. State (secrets, tokens, shots, payloads) lives in $STACK_DIR, never in the repo.
#
#   npm run build -w @orbit/shared && npm run build -w @orbit/apiserver && npm run build -w @orbit/web
#   stack.sh up            # PostgreSQL + migrations (prisma migrate deploy)
#   stack.sh api           # the apiserver, in the foreground (run it as a background service)
#   stack.sh gateway       # the web + /api gateway, in the foreground (a background service too)
#   stack.sh record        # empty the database, migrate, seed.mjs, capture.mjs, fixture-diff.mjs
#   stack.sh down          # remove the container (tmpfs: the data goes with it)
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
export STACK_DIR="${STACK_DIR:-/var/tmp/sched-chat-stack}"
PG=sched-chat-pg
DB='postgresql://postgres:pw@127.0.0.1:5757/orbit'
mkdir -p "$STACK_DIR"
migrate() { (cd "$REPO/src/apiserver" && DATABASE_URL="$DB" npx prisma migrate deploy | tail -1); }
case "${1:-}" in
  up)
    docker rm -f -v "$PG" >/dev/null 2>&1 || true
    docker run -d --name "$PG" --tmpfs /var/lib/postgresql/data:rw -e POSTGRES_PASSWORD=pw -e POSTGRES_DB=orbit \
      -p 127.0.0.1:5757:5432 postgres:16-alpine >/dev/null
    for _ in $(seq 1 60); do docker exec "$PG" psql -U postgres -d orbit -qtc 'select 1' >/dev/null 2>&1 && break; sleep 1; done
    sleep 2
    migrate ;;
  api)
    umask 077
    [ -f "$STACK_DIR/secrets.env" ] || printf 'JWT_SECRET=%s\nPROVIDER_SECRET_KEY=%s\n' "$(openssl rand -hex 32)" "$(openssl rand -hex 32)" > "$STACK_DIR/secrets.env"
    set -a; . "$STACK_DIR/secrets.env"; set +a
    # The session's own Orbit and Claude variables must not reach a server of its own.
    for v in $(env | grep -oE '^(ORBIT_[A-Z_]*|CLAUDE[A-Z_]*)' || true); do unset "$v"; done
    DATABASE_URL="$DB" PORT=3757 PUBLIC_ORIGIN=http://127.0.0.1:2757 CORS_ORIGINS=http://127.0.0.1:2757 NODE_ENV=production \
      exec node "$REPO/src/apiserver/dist/main.js" ;;
  gateway)
    exec node "$HERE/gateway.mjs" "$REPO/src/web/dist" ;;
  record)
    docker exec "$PG" psql -U postgres -d orbit -q -o /dev/null -c 'DROP SCHEMA public CASCADE; CREATE SCHEMA public;' 2>/dev/null
    migrate
    node "$HERE/seed.mjs"
    rm -rf "$STACK_DIR/out"
    node "$HERE/capture.mjs" "$REPO" "$STACK_DIR/out"
    node "$HERE/fixture-diff.mjs" "$STACK_DIR/out/payloads" "$REPO/src/web/src/test/scheduledChatFixtures.ts" ;;
  down)
    docker rm -f -v "$PG" >/dev/null ;;
  *) sed -n '2,13p' "$0"; exit 2 ;;
esac
