#!/usr/bin/env bash
# Acceptance harness for digest-bound Owner Ratification. A disposable PostgreSQL is mandatory:
# the suite includes real row-lock races and must never skip because a shared database is absent.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$REPO/scripts/lib/outcome-reconciler-release-dag.sh"
API="$REPO/src/apiserver"
CONTAINER="${OWNER_RATIFICATION_PG_CONTAINER:-owner-ratification-pg16-$$}"
ADMIN="${OWNER_RATIFICATION_PG_USER:-ratification_admin}"
PASSWORD="${OWNER_RATIFICATION_PG_PASSWORD:-ratification_pw}"
DATABASE="${OWNER_RATIFICATION_PG_DATABASE:-owner_ratification}"
IMAGE="${OWNER_RATIFICATION_PG_IMAGE:-postgres:16-alpine}"
TIMEOUT_SECONDS="${OWNER_RATIFICATION_TIMEOUT:-600}"
BUILD="$REPO/build"
TAP="$BUILD/outcome-reconciler-v2-ratification.tap"
EVIDENCE="$BUILD/outcome-reconciler-v2-ratification-evidence.json"
MANIFEST="$BUILD/outcome-reconciler-v2-ratification-manifest.json"
STARTED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

cleanup() {
  if outcome_release_dag_db_enabled; then
    outcome_release_dag_drop_database
  else
    docker rm -fv "$CONTAINER" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

command -v docker >/dev/null || { echo '!! PostgreSQL unavailable: docker is required' >&2; exit 1; }
docker info >/dev/null 2>&1 || { echo '!! PostgreSQL unavailable: docker daemon is not reachable' >&2; exit 1; }

NODE_MODULES=""
FOUND_PG=0
for candidate in "$REPO/src/apiserver/node_modules" "$REPO/node_modules" \
  /root/orbit/src/apiserver/node_modules /root/orbit/node_modules; do
  if [ -d "$candidate" ]; then
    NODE_MODULES="${NODE_MODULES:+$NODE_MODULES:}$candidate"
  fi
  [ -d "$candidate/pg" ] && FOUND_PG=1
done
[ "$FOUND_PG" = "1" ] || { echo '!! pg client dependency is unavailable' >&2; exit 1; }

PRISMA="$API/node_modules/.bin/prisma"
[ -x "$PRISMA" ] || PRISMA=/root/orbit/src/apiserver/node_modules/.bin/prisma
[ -x "$PRISMA" ] || { echo '!! Prisma CLI is unavailable' >&2; exit 1; }

mkdir -p "$BUILD"
if outcome_release_dag_db_enabled; then
  echo '==> release-dag: clone the bound migrated PostgreSQL template'
  outcome_release_dag_bind_database
else
  echo "==> owner-ratification: provisioning disposable PostgreSQL 16"
  docker run -d --name "$CONTAINER" --tmpfs /var/lib/postgresql/data:rw,size=1g \
    -e "POSTGRES_USER=$ADMIN" -e "POSTGRES_PASSWORD=$PASSWORD" -e POSTGRES_DB=postgres \
    -p 127.0.0.1::5432 "$IMAGE" >/dev/null
  for _ in $(seq 1 90); do
    docker exec -e "PGPASSWORD=$PASSWORD" "$CONTAINER" \
      psql -h 127.0.0.1 -U "$ADMIN" -d postgres -tAc 'SELECT 1' >/dev/null 2>&1 && break
    sleep 1
  done
  docker exec -e "PGPASSWORD=$PASSWORD" "$CONTAINER" \
    psql -h 127.0.0.1 -U "$ADMIN" -d postgres -tAc 'SELECT 1' >/dev/null
  PORT_LINE="$(docker port "$CONTAINER" 5432/tcp)"
  PORT="${PORT_LINE##*:}"
  SYSTEM_ID="$(docker exec "$CONTAINER" psql -U "$ADMIN" -d postgres -tAc \
    'SELECT system_identifier FROM pg_control_system()' | tr -d '[:space:]')"
  docker exec "$CONTAINER" psql -U "$ADMIN" -d postgres -v ON_ERROR_STOP=1 \
    -c "CREATE DATABASE $DATABASE" >/dev/null
  URL="postgresql://$ADMIN:$PASSWORD@127.0.0.1:$PORT/$DATABASE"
  echo "==> owner-ratification: applying every Prisma migration"
  ( cd "$API" && NODE_PATH="$NODE_MODULES" DATABASE_URL="$URL" \
    "$PRISMA" migrate deploy --schema prisma/schema.prisma >/dev/null )
  MIGRATIONS="$(docker exec "$CONTAINER" psql -U "$ADMIN" -d "$DATABASE" -tAc \
    'SELECT count(*) FROM _prisma_migrations WHERE finished_at IS NOT NULL' | tr -d '[:space:]')"
fi
echo "==> owner-ratification: migrations=$MIGRATIONS system_identifier=$SYSTEM_ID port=$PORT"

echo "==> owner-ratification: running digest, authority, CTA, dispatch, and race proofs"
# The reporter below is pinned rather than left to default: Node 23+ emits `spec` (`ℹ tests 17`)
# even with no TTY, and `outcome-reconciler-ratification-manifest.mjs` reduces this file by matching
# `^# tests`.
set +e
NODE_PATH="$NODE_MODULES" \
OWNER_RATIFICATION_PG_URL="$URL" \
OWNER_RATIFICATION_PG_EXPECTED_DATABASE="$DATABASE" \
OWNER_RATIFICATION_PG_EXPECTED_USER="$ADMIN" \
OWNER_RATIFICATION_PG_EXPECTED_SYSTEM_IDENTIFIER="$SYSTEM_ID" \
OWNER_RATIFICATION_EVIDENCE_PATH="$EVIDENCE" \
timeout -k 20 "$TIMEOUT_SECONDS" node --test --test-concurrency=1 \
  --test-reporter=tap --test-reporter-destination=stdout \
  "$REPO/test/outcome-reconciler-v2.ratification.test.mjs" 2>&1 | tee "$TAP"
TEST_RC=${PIPESTATUS[0]}
set -e
if [ "$TEST_RC" -ne 0 ]; then
  echo "!! owner-ratification tests failed rc=$TEST_RC" >&2
  exit "$TEST_RC"
fi

echo "==> owner-ratification: validating zero-skip evidence and writing manifest"
OWNER_RATIFICATION_STARTED_AT="$STARTED_AT" node \
  "$REPO/scripts/outcome-reconciler-ratification-manifest.mjs" "$TAP" "$EVIDENCE" "$MANIFEST"
