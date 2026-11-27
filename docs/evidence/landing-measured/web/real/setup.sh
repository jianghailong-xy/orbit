#!/bin/bash
# usage: setup.sh up|down  — a throwaway Postgres (tmpfs) with this worktree's migrations applied.
set -e
. "$(dirname "$0")/env.sh"
case "$1" in
  up)
    docker rm -f lm-real-pg >/dev/null 2>&1 || true
    docker run -d --name lm-real-pg --tmpfs /var/lib/postgresql/data -e POSTGRES_PASSWORD=pg -e POSTGRES_DB=orbit \
      -p 127.0.0.1:${PGPORT_LM}:5432 postgres:16-alpine >/dev/null
    for i in $(seq 1 60); do docker exec lm-real-pg pg_isready -U postgres -d orbit >/dev/null 2>&1 && break; sleep 1; done
    (cd "$WT/src/apiserver" && npx prisma migrate deploy 2>&1 | tail -2)
    ;;
  down) docker rm -f lm-real-pg >/dev/null 2>&1 || true ;;
esac
