#!/usr/bin/env bash
# Acceptance harness for the disposable Outcome Reconciler projection and shadow reconciler.
# PostgreSQL is mandatory and disposable; an unavailable server or a skipped test is a hard fail.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$REPO/scripts/lib/outcome-reconciler-release-dag.sh"
API="$REPO/src/apiserver"
CONTAINER="${OUTCOME_PROJECTION_PG_CONTAINER:-pcprojection-pg16-$$}"
ADMIN="${OUTCOME_PROJECTION_PG_USER:-pcprojection_admin}"
PASSWORD="${OUTCOME_PROJECTION_PG_PASSWORD:-pcprojection_pw}"
DATABASE="${OUTCOME_PROJECTION_PG_DATABASE:-pcprojection_outcome}"
IMAGE="${OUTCOME_PROJECTION_PG_IMAGE:-postgres:16-alpine}"
TIMEOUT_SECONDS="${OUTCOME_PROJECTION_TIMEOUT:-900}"
BUILD="$REPO/build"
COMPILED="$BUILD/outcome-projection-ts"
TAP="$BUILD/outcome-reconciler-v2-projection.tap"
EVIDENCE="$BUILD/outcome-reconciler-v2-projection-evidence.json"
MANIFEST="$BUILD/outcome-reconciler-v2-projection-manifest.json"
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
TSC="$REPO/node_modules/.bin/tsc"
[ -x "$TSC" ] || TSC=/root/orbit/node_modules/.bin/tsc
[ -x "$TSC" ] || { echo '!! TypeScript compiler is unavailable' >&2; exit 1; }
TYPE_ROOT="$REPO/node_modules/@types"
[ -d "$TYPE_ROOT" ] || TYPE_ROOT=/root/orbit/node_modules/@types
[ -d "$TYPE_ROOT" ] || { echo '!! Node TypeScript definitions are unavailable' >&2; exit 1; }

mkdir -p "$BUILD" "$COMPILED"
if [ "${OUTCOME_RELEASE_DAG_PREPARED_BUILD:-0}" = 1 ]; then
  outcome_release_dag_assert_build
  EVALUATOR_MODULE="$API/dist/outcome-reconciler/outcome-evaluator.js"
  echo '==> outcome-projection: use exact bound production build'
else
  echo "==> outcome-projection: compiling the production evaluator replay source"
  "$TSC" "$API/src/outcome-reconciler/outcome-evaluator.ts" \
    --target ES2022 --module nodenext --moduleResolution nodenext --strict --skipLibCheck \
    --typeRoots "$TYPE_ROOT" --outDir "$COMPILED"
  EVALUATOR_MODULE="$COMPILED/outcome-evaluator.js"
fi

if outcome_release_dag_db_enabled; then
  echo '==> release-dag: clone the bound migrated PostgreSQL template'
  outcome_release_dag_bind_database
else
  echo "==> outcome-projection: provisioning disposable PostgreSQL 16"
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
  echo "==> outcome-projection: applying every Prisma migration"
  ( cd "$API" && NODE_PATH="$NODE_MODULES" DATABASE_URL="$URL" \
    "$PRISMA" migrate deploy --schema prisma/schema.prisma >/dev/null )
  MIGRATIONS="$(docker exec "$CONTAINER" psql -U "$ADMIN" -d "$DATABASE" -tAc \
    'SELECT count(*) FROM _prisma_migrations WHERE finished_at IS NOT NULL' | tr -d '[:space:]')"
fi
echo "==> outcome-projection: migrations=$MIGRATIONS system_identifier=$SYSTEM_ID port=$PORT"

echo "==> outcome-projection: running rebuild, outbox, checksum, index and stale matrix"
set +e
NODE_PATH="$NODE_MODULES" \
OUTCOME_PROJECTION_EVALUATOR_MODULE="$EVALUATOR_MODULE" \
OUTCOME_PROJECTION_PG_URL="$URL" \
OUTCOME_PROJECTION_PG_EXPECTED_DATABASE="$DATABASE" \
OUTCOME_PROJECTION_PG_EXPECTED_USER="$ADMIN" \
OUTCOME_PROJECTION_PG_EXPECTED_SYSTEM_IDENTIFIER="$SYSTEM_ID" \
OUTCOME_PROJECTION_EVIDENCE_PATH="$EVIDENCE" \
timeout -k 20 "$TIMEOUT_SECONDS" node --test --test-concurrency=1 \
  "$REPO/test/outcome-reconciler-v2.projection.test.mjs" 2>&1 | tee "$TAP"
TEST_RC=${PIPESTATUS[0]}
set -e
if [ "$TEST_RC" -ne 0 ]; then
  echo "!! outcome-projection tests failed rc=$TEST_RC" >&2
  exit "$TEST_RC"
fi

echo "==> outcome-projection: validating zero-skip evidence and writing manifest"
OUTCOME_PROJECTION_STARTED_AT="$STARTED_AT" \
  node "$REPO/scripts/outcome-reconciler-projection-manifest.mjs" "$TAP" "$EVIDENCE" "$MANIFEST"
