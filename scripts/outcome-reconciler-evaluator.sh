#!/usr/bin/env bash
# Acceptance harness for the pure Outcome Evaluator and its PostgreSQL linearization boundary.
# PostgreSQL is mandatory and disposable; absence is a failure, never a skipped concurrency suite.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
API="$REPO/src/apiserver"
CONTAINER="${OUTCOME_EVALUATOR_PG_CONTAINER:-pceval-pg16-$$}"
ADMIN="${OUTCOME_EVALUATOR_PG_USER:-pceval_admin}"
PASSWORD="${OUTCOME_EVALUATOR_PG_PASSWORD:-pceval_pw}"
DATABASE="${OUTCOME_EVALUATOR_PG_DATABASE:-pceval_outcome}"
IMAGE="${OUTCOME_EVALUATOR_PG_IMAGE:-postgres:16-alpine}"
TIMEOUT_SECONDS="${OUTCOME_EVALUATOR_TIMEOUT:-900}"
BUILD="$REPO/build"
COMPILED="$BUILD/outcome-evaluator-ts"
TAP="$BUILD/outcome-reconciler-v2-evaluator.tap"
EVIDENCE="$BUILD/outcome-reconciler-v2-evaluator-evidence.json"
MANIFEST="$BUILD/outcome-reconciler-v2-evaluator-manifest.json"
STARTED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

cleanup() {
  docker rm -fv "$CONTAINER" >/dev/null 2>&1 || true
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
echo "==> outcome-evaluator: compiling the pure production reducer"
"$TSC" "$API/src/outcome-reconciler/outcome-evaluator.ts" \
  --target ES2022 --module nodenext --moduleResolution nodenext --strict --skipLibCheck \
  --typeRoots "$TYPE_ROOT" --outDir "$COMPILED"

echo "==> outcome-evaluator: provisioning disposable PostgreSQL 16"
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

echo "==> outcome-evaluator: applying every Prisma migration"
( cd "$API" && NODE_PATH="$NODE_MODULES" DATABASE_URL="$URL" \
  "$PRISMA" migrate deploy --schema prisma/schema.prisma >/dev/null )
MIGRATIONS="$(docker exec "$CONTAINER" psql -U "$ADMIN" -d "$DATABASE" -tAc \
  'SELECT count(*) FROM _prisma_migrations WHERE finished_at IS NOT NULL' | tr -d '[:space:]')"
echo "==> outcome-evaluator: migrations=$MIGRATIONS system_identifier=$SYSTEM_ID port=$PORT"

echo "==> outcome-evaluator: running pure tables and PostgreSQL concurrency matrix"
set +e
NODE_PATH="$NODE_MODULES" \
OUTCOME_EVALUATOR_MODULE="$COMPILED/outcome-evaluator.js" \
OUTCOME_EVALUATOR_PG_URL="$URL" \
OUTCOME_EVALUATOR_PG_EXPECTED_DATABASE="$DATABASE" \
OUTCOME_EVALUATOR_PG_EXPECTED_USER="$ADMIN" \
OUTCOME_EVALUATOR_PG_EXPECTED_SYSTEM_IDENTIFIER="$SYSTEM_ID" \
OUTCOME_EVALUATOR_EVIDENCE_PATH="$EVIDENCE" \
timeout -k 20 "$TIMEOUT_SECONDS" node --test --test-concurrency=1 \
  "$REPO/test/outcome-reconciler-v2.evaluator.test.mjs" 2>&1 | tee "$TAP"
TEST_RC=${PIPESTATUS[0]}
set -e
if [ "$TEST_RC" -ne 0 ]; then
  echo "!! outcome-evaluator tests failed rc=$TEST_RC" >&2
  exit "$TEST_RC"
fi

echo "==> outcome-evaluator: validating zero-skip evidence and writing manifest"
OUTCOME_EVALUATOR_STARTED_AT="$STARTED_AT" \
  node "$REPO/scripts/outcome-reconciler-evaluator-manifest.mjs" "$TAP" "$EVIDENCE" "$MANIFEST"
