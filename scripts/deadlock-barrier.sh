#!/usr/bin/env bash
# A disposable PostgreSQL 16 with Orbit's migrations on it, for the lock-order barrier fixture.
#
#   scripts/deadlock-barrier.sh                # the two-party 40P01 baseline (default)
#   scripts/deadlock-barrier.sh three-party    # the three-party 40P01 baseline
#   scripts/deadlock-barrier.sh spec           # the harness's own pg spec
#   scripts/deadlock-barrier.sh session-scope  # the 0130 Session event-source scope regression
#   scripts/deadlock-barrier.sh lock-order     # the canonical lock order, from both arrival orders
#   scripts/deadlock-barrier.sh all            # every gate above, on one server
#   scripts/deadlock-barrier.sh baseline --keep
#
# Why its own server rather than `db:up` or the deployment's postgres: the fixture deliberately
# parks two or three backends in a lock cycle and lets PostgreSQL abort one of them. That is safe
# on a server nobody else is using and nowhere else, so the database and role are named `pcc40p01_*`
# and the specs re-check the server's system_identifier before their first write
# (src/apiserver/src/projects/coordinator-pg-test-safety.ts). Handing this script an Orbit
# business URL fails in the guard, before any statement runs.
#
# `docker rm -fv` on the way out: the anonymous volume PGDATA lives on is several hundred MB and
# a run that leaves it behind is a slow disk leak, not a clean teardown.
#
# The run is wrapped in `timeout`. A run that is killed is RED — never a pass.
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
API="$REPO/src/apiserver"
CONTAINER="${P40_PG_CONTAINER:-pcc-40p01-barrier-pg16}"
PORT="${P40_PG_PORT:-55491}"
ADMIN="${P40_PG_USER:-pcc40p01_admin}"
PASSWORD="${P40_PG_PASSWORD:-pcc40p01_pw}"
DB="${P40_PG_DATABASE:-pcc40p01_barrier}"
IMAGE="${P40_PG_IMAGE:-postgres:16-alpine}"
RUN_TIMEOUT="${P40_TIMEOUT:-900}"
NODE="${NODE:-node}"
# TypeScript 7 and Prisma 7 are installed per workspace; npm no longer hoists either.
TSC="$API/node_modules/.bin/tsc"; [ -x "$TSC" ] || TSC="$REPO/node_modules/.bin/tsc"
PRISMA="$API/node_modules/.bin/prisma"; [ -x "$PRISMA" ] || PRISMA="$REPO/node_modules/.bin/prisma"

TARGET="baseline"; KEEP=0
for arg in "$@"; do
  case "$arg" in
    --keep) KEEP=1 ;;
    baseline|three-party|spec|session-scope|lock-order|all) TARGET="$arg" ;;
    *) echo "usage: $(basename "$0") [baseline|three-party|spec|session-scope|lock-order|all] [--keep]" >&2; exit 2 ;;
  esac
done

cleanup() {
  if [ "$KEEP" = "1" ]; then
    echo "==> keeping $CONTAINER on 127.0.0.1:$PORT (db $DB)"
  else
    docker rm -fv "$CONTAINER" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

echo "==> provisioning $CONTAINER ($IMAGE) on 127.0.0.1:$PORT"
docker rm -fv "$CONTAINER" >/dev/null 2>&1 || true
docker run -d --name "$CONTAINER" \
  -e "POSTGRES_USER=$ADMIN" -e "POSTGRES_PASSWORD=$PASSWORD" -e "POSTGRES_DB=postgres" \
  -p "127.0.0.1:$PORT:5432" "$IMAGE" >/dev/null || exit 1
# Over TCP, not the unix socket: initdb runs a temporary server that listens on the socket
# only, and probing it there reports "ready" seconds before the real server exists.
ready() { docker exec -e PGPASSWORD="$PASSWORD" "$CONTAINER" \
  psql -h 127.0.0.1 -U "$ADMIN" -d postgres -tAc 'SELECT 1' >/dev/null 2>&1; }
for _ in $(seq 1 90); do ready && break; sleep 1; done
ready || { echo "!! $CONTAINER never accepted connections"; exit 1; }

SYSTEM_ID="$(docker exec "$CONTAINER" psql -U "$ADMIN" -d postgres -tAc \
  'SELECT system_identifier FROM pg_control_system()' | tr -d '[:space:]')"
echo "==> server identity: role=$ADMIN system_identifier=$SYSTEM_ID"

docker exec "$CONTAINER" psql -U "$ADMIN" -d postgres -tAc "DROP DATABASE IF EXISTS $DB" >/dev/null
docker exec "$CONTAINER" psql -U "$ADMIN" -d postgres -tAc "CREATE DATABASE $DB" >/dev/null
echo "==> prisma migrate deploy ($DB)"
( cd "$API" && DATABASE_URL="postgresql://$ADMIN:$PASSWORD@127.0.0.1:$PORT/$DB" \
    "$PRISMA" migrate deploy --schema prisma/schema.prisma >/dev/null ) || exit 1
echo "==> $(docker exec "$CONTAINER" psql -U "$ADMIN" -d "$DB" -tAc \
  'SELECT count(*) FROM _prisma_migrations WHERE finished_at IS NOT NULL') migrations applied"

echo "==> building the test tree"
( cd "$API" && "$TSC" -p tsconfig.test.json ) || exit 1

URL="postgresql://$ADMIN:$PASSWORD@127.0.0.1:$PORT/$DB"
# The whole point of `all`: one provisioned server, every gate, and a non-zero exit if any of
# them fails. Rounds are serialized, so a later target never observes an earlier one's backends.
case "$TARGET" in
  # session-scope runs LAST because it rebuilds the pre-0130 trigger mid-test: an interrupted
  # run must never be able to leave a baseline executing against a schema it did not intend.
  all) TARGETS=(spec baseline three-party lock-order session-scope) ;;
  *)   TARGETS=("$TARGET") ;;
esac

run_target() {
  case "$1" in
    baseline)    CMD=("$NODE" build/deadlock/two-party-40p01.baseline.js) ;;
    three-party) CMD=("$NODE" build/deadlock/three-party-40p01.baseline.js) ;;
    spec)        CMD=("$NODE" --test --test-concurrency=1 build/deadlock/pg-barrier.pg.spec.js) ;;
    # The regression the narrowing owns. It rebuilds the pre-0130 trigger to prove its own
    # barrier discriminates, then re-applies 0130 — so it must not run beside the baselines.
    session-scope) CMD=("$NODE" --test --test-concurrency=1 build/projects/project-session-event-scope.pg.spec.js) ;;
    # The post-fix regression: the same two barrier timings, both arrival orders, every party
    # committing. It runs AFTER the baselines so a run that stops early has still proven the
    # cycles it is the answer to, and BEFORE session-scope, which rebuilds a trigger mid-test.
    lock-order)  CMD=("$NODE" --test --test-concurrency=1 build/deadlock/lock-order.pg.spec.js) ;;
  esac
  echo "==> $1"
  ( cd "$API" && COORDINATOR_PG_URL="$URL" \
      COORDINATOR_PG_EXPECTED_DATABASE="$DB" \
      COORDINATOR_PG_EXPECTED_USER="$ADMIN" \
      COORDINATOR_PG_EXPECTED_SYSTEM_IDENTIFIER="$SYSTEM_ID" \
      timeout -k 20 "$RUN_TIMEOUT" "${CMD[@]}" )
  local rc=$?
  if [ "$rc" = "124" ] || [ "$rc" = "137" ]; then
    echo "!! $1 TIMED OUT after ${RUN_TIMEOUT}s (rc=$rc) — a hang, not a pass"
  elif [ "$rc" != "0" ]; then
    echo "!! $1 FAILED rc=$rc"
  else
    echo "==> $1 OK"
  fi
  return "$rc"
}

rc=0
for t in "${TARGETS[@]}"; do
  run_target "$t" || { rc=$?; break; }
done
exit "$rc"
