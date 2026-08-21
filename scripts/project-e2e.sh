#!/usr/bin/env bash
# The Project Coordinator control loop, end to end, on a database this script creates and destroys.
#
#   scripts/project-e2e.sh              # provision, migrate, run everything, tear down
#   scripts/project-e2e.sh --keep       # leave the container up for poking at afterwards
#
# What it runs, in order:
#   1. `prisma migrate deploy` on an EMPTY database — AC11's migration, from nothing, every time.
#   2. project-e2e-acceptance.pg.spec  — criteria 1, 4, 5, 6, 7, 8, 10, 11.
#   3. project-e2e-recovery.pg.spec    — criteria 2, 3, 9, with real SIGKILLs and a real restart.
#   4. scripts/project-liveness-audit.sql — §10.3 against whatever the suites left behind.
#
# It is deliberately self-contained: no shared database, no seeded state, nothing inherited from a
# previous run. That is what makes "the suite runs independently" a fact rather than a claim.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
API="$REPO/src/apiserver"
CONTAINER="${PCC_E2E_CONTAINER:-pcc22-e2e-pg16}"
PORT="${PCC_E2E_PORT:-55470}"
DB="${PCC_E2E_DB:-pcc22_e2e}"
USER_NAME="${PCC_E2E_USER:-pcc22_admin}"
PASSWORD="${PCC_E2E_PASSWORD:-pcc22_e2e_pw}"
IMAGE="${PCC_E2E_IMAGE:-postgres:16-alpine}"
KEEP=0
[ "${1:-}" = "--keep" ] && KEEP=1

URL="postgresql://$USER_NAME:$PASSWORD@127.0.0.1:$PORT/$DB"
NODE="${NODE:-node}"
# Prisma 7 is installed per workspace too — npm no longer hoists it to the repo root.
PRISMA="$API/node_modules/.bin/prisma"
[ -x "$PRISMA" ] || PRISMA="$REPO/node_modules/.bin/prisma"
# TypeScript 7 is installed per workspace: the repo root still hoists the 5.9.3 that
# @nestjs/cli pins, so take the apiserver copy when it is there.
TSC="$API/node_modules/.bin/tsc"
[ -x "$TSC" ] || TSC="$REPO/node_modules/.bin/tsc"

cleanup() {
  if [ "$KEEP" = "1" ]; then
    echo "==> keeping $CONTAINER on 127.0.0.1:$PORT ($URL)"
  else
    echo "==> removing $CONTAINER"
    docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

echo "==> provisioning $CONTAINER ($IMAGE) on 127.0.0.1:$PORT"
docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
docker run -d --name "$CONTAINER" \
  -e "POSTGRES_USER=$USER_NAME" -e "POSTGRES_PASSWORD=$PASSWORD" -e "POSTGRES_DB=$DB" \
  -p "127.0.0.1:$PORT:5432" "$IMAGE" >/dev/null

# `pg_isready` answers YES to the temporary server the postgres image runs during initdb, so it
# is not the readiness signal here: the first real query is.
for _ in $(seq 1 90); do
  docker exec "$CONTAINER" psql -U "$USER_NAME" -d "$DB" -tAc 'SELECT 1' >/dev/null 2>&1 && break
  sleep 1
done
docker exec "$CONTAINER" psql -U "$USER_NAME" -d "$DB" -tAc 'SELECT 1' >/dev/null

SYSTEM_ID="$(docker exec "$CONTAINER" psql -U "$USER_NAME" -d "$DB" -tAc \
  'SELECT system_identifier FROM pg_control_system()')"
echo "==> server identity: database=$DB role=$USER_NAME system_identifier=$SYSTEM_ID"

echo "==> prisma migrate deploy (empty database)"
( cd "$API" && DATABASE_URL="$URL" "$PRISMA" migrate deploy --schema prisma/schema.prisma )
APPLIED="$(docker exec "$CONTAINER" psql -U "$USER_NAME" -d "$DB" -tAc \
  'SELECT count(*) FROM _prisma_migrations WHERE finished_at IS NOT NULL')"
echo "==> $APPLIED migrations applied"

echo "==> building the test tree"
( cd "$API" && "$TSC" -p tsconfig.test.json )

export COORDINATOR_PG_URL="$URL"
export COORDINATOR_PG_EXPECTED_DATABASE="$DB"
export COORDINATOR_PG_EXPECTED_USER="$USER_NAME"
export COORDINATOR_PG_EXPECTED_SYSTEM_IDENTIFIER="$SYSTEM_ID"
export COORDINATOR_PG_CONTAINER="$CONTAINER"

# One at a time, and on purpose: these suites take the same projects' leases and restart the
# server under each other's feet. Concurrency here would be testing the harness, not the loop.
echo "==> acceptance suite (AC1, 4, 5, 6, 7, 8, 10, 11)"
( cd "$API" && "$NODE" --test --test-concurrency=1 build/projects/project-e2e-acceptance.pg.spec.js )

echo "==> recovery and fault-injection suite (AC2, 3, 9)"
( cd "$API" && "$NODE" --test --test-concurrency=1 build/projects/project-e2e-recovery.pg.spec.js )

echo "==> §10.3 liveness audit over the world the suites left behind"
VIOLATIONS="$(docker exec -i "$CONTAINER" psql -U "$USER_NAME" -d "$DB" -tA \
  < "$REPO/scripts/project-liveness-audit.sql" | sed '/^$/d' | wc -l)"
if [ "$VIOLATIONS" != "0" ]; then
  echo "!! $VIOLATIONS project(s) violate §10.3 liveness:"
  docker exec -i "$CONTAINER" psql -U "$USER_NAME" -d "$DB" \
    < "$REPO/scripts/project-liveness-audit.sql"
  exit 1
fi
echo "==> liveness audit clean"
echo "==> OK"
