#!/usr/bin/env bash
# Acceptance harness for the independent Outcome Watchdog. PostgreSQL is mandatory and disposable;
# fault, security and 111k capacity cases may not degrade to skips.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$REPO/scripts/lib/outcome-reconciler-release-dag.sh"
API="$REPO/src/apiserver"
CONTAINER="${OUTCOME_WATCHDOG_PG_CONTAINER:-pcwatchdog-pg16-$$}"
ADMIN="${OUTCOME_WATCHDOG_PG_USER:-pcwatchdog_admin}"
PASSWORD="${OUTCOME_WATCHDOG_PG_PASSWORD:-pcwatchdog_pw}"
DATABASE="${OUTCOME_WATCHDOG_PG_DATABASE:-pcwatchdog_outcome}"
IMAGE="${OUTCOME_WATCHDOG_PG_IMAGE:-postgres:16-alpine}"
TIMEOUT_SECONDS="${OUTCOME_WATCHDOG_TIMEOUT:-1200}"
BUILD="$REPO/build"
COMPILED="$BUILD/outcome-watchdog-ts"
TAP="$BUILD/outcome-reconciler-v2-watchdog.tap"
EVIDENCE="$BUILD/outcome-reconciler-v2-watchdog-evidence.json"
MANIFEST="$BUILD/outcome-reconciler-v2-watchdog-manifest.json"
CAPACITY_MANIFEST="$BUILD/outcome-reconciler-v2-watchdog-capacity-manifest.json"
RUNTIME_EVIDENCE="$BUILD/executable-acceptance-runtime-evidence.json"
RUNTIME_MANIFEST="$BUILD/executable-acceptance-runtime-manifest.json"
CONTRACT="$REPO/contracts/outcome-reconciler-v2-watchdog-slo.json"
STARTED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
COLLECTOR_SHA="${OUTCOME_WATCHDOG_COLLECTOR_SHA:-$(git -C "$REPO" rev-parse HEAD)}"
TARGET_SHA="${OUTCOME_WATCHDOG_TARGET_SHA:-$(git -C "$REPO" rev-parse HEAD)}"
ROOT_MODULE_LINK=0
API_MODULE_LINK=0

cleanup() {
  if outcome_release_dag_db_enabled; then
    outcome_release_dag_drop_database
  else
    docker rm -fv "$CONTAINER" >/dev/null 2>&1 || true
  fi
  if [ "$API_MODULE_LINK" = "1" ] && [ -L "$API/node_modules" ]; then unlink "$API/node_modules"; fi
  if [ "$ROOT_MODULE_LINK" = "1" ] && [ -L "$REPO/node_modules" ]; then unlink "$REPO/node_modules"; fi
}
trap cleanup EXIT

command -v docker >/dev/null || { echo '!! PostgreSQL unavailable: docker is required' >&2; exit 1; }
docker info >/dev/null 2>&1 || { echo '!! PostgreSQL unavailable: docker daemon is not reachable' >&2; exit 1; }
[[ "$COLLECTOR_SHA" =~ ^[0-9a-f]{40}$ ]] || { echo '!! collector SHA must be full git SHA' >&2; exit 1; }
[[ "$TARGET_SHA" =~ ^[0-9a-f]{40}$ ]] || { echo '!! target SHA must be full git SHA' >&2; exit 1; }

NODE_MODULES=""
FOUND_PG=0
for candidate in "$REPO/src/apiserver/node_modules" "$REPO/node_modules" \
  /root/orbit/src/apiserver/node_modules /root/orbit/node_modules; do
  if [ -d "$candidate" ]; then NODE_MODULES="${NODE_MODULES:+$NODE_MODULES:}$candidate"; fi
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

if [ ! -e "$REPO/node_modules" ] && [ ! -L "$REPO/node_modules" ]; then
  ln -s /root/orbit/node_modules "$REPO/node_modules"
  ROOT_MODULE_LINK=1
fi
if [ ! -e "$API/node_modules" ] && [ ! -L "$API/node_modules" ]; then
  ln -s /root/orbit/src/apiserver/node_modules "$API/node_modules"
  API_MODULE_LINK=1
fi

mkdir -p "$BUILD" "$COMPILED"
if [ "${OUTCOME_WATCHDOG_RUNTIME_CLOSURE:-required}" = "required" ]; then
  echo "==> outcome-watchdog: proving typed-attempt, supersession and external dead-man closure"
  bash "$REPO/scripts/executable-acceptance-runtime.sh"
else
  [ -s "$RUNTIME_EVIDENCE" ] && [ -s "$RUNTIME_MANIFEST" ] || {
    echo '!! reusable runtime closure evidence is unavailable' >&2
    exit 1
  }
fi

if [ "${OUTCOME_RELEASE_DAG_PREPARED_BUILD:-0}" = 1 ]; then
  outcome_release_dag_assert_build
  WATCHDOG_MODULE="$API/dist/outcome-watchdog/outcome-watchdog.js"
  WATCHDOG_EVALUATOR_MODULE="$API/dist/outcome-reconciler/outcome-evaluator.js"
  echo '==> outcome-watchdog: use exact bound production build'
else
  echo "==> outcome-watchdog: compiling independent worker, security policy and production evaluator"
  "$TSC" \
    "$API/src/outcome-watchdog/outcome-watchdog.ts" \
    "$API/src/outcome-watchdog/outcome-watchdog.service.ts" \
    "$API/src/outcome-watchdog/outcome-watchdog.module.ts" \
    "$API/src/outcome-watchdog/outcome-watchdog.runner.ts" \
    "$API/src/outcome-watchdog/outcome-watchdog.worker.module.ts" \
    "$API/src/outcome-watchdog/main.ts" \
    "$API/src/outcome-reconciler/outcome-evaluator.ts" \
    --target ES2022 --module nodenext --moduleResolution nodenext --strict --skipLibCheck \
    --experimentalDecorators --emitDecoratorMetadata --typeRoots "$TYPE_ROOT" --outDir "$COMPILED"
  WATCHDOG_MODULE="$COMPILED/outcome-watchdog/outcome-watchdog.js"
  WATCHDOG_EVALUATOR_MODULE="$COMPILED/outcome-reconciler/outcome-evaluator.js"
fi

if outcome_release_dag_db_enabled; then
  echo '==> outcome-watchdog: clone the bound migrated PostgreSQL template'
  outcome_release_dag_bind_database
else
  echo "==> outcome-watchdog: provisioning disposable PostgreSQL 16"
  docker run -d --name "$CONTAINER" --tmpfs /var/lib/postgresql/data:rw,size=2g \
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
  echo "==> outcome-watchdog: applying every Prisma migration"
  ( cd "$API" && NODE_PATH="$NODE_MODULES" DATABASE_URL="$URL" \
    "$PRISMA" migrate deploy --schema prisma/schema.prisma >/dev/null )
  MIGRATIONS="$(docker exec "$CONTAINER" psql -U "$ADMIN" -d "$DATABASE" -tAc \
    'SELECT count(*) FROM _prisma_migrations WHERE finished_at IS NOT NULL' | tr -d '[:space:]')"
  LAST_MIGRATION="$(docker exec "$CONTAINER" psql -U "$ADMIN" -d "$DATABASE" -tAc \
    'SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL ORDER BY finished_at DESC LIMIT 1' \
    | tr -d '[:space:]')"
fi
echo "==> outcome-watchdog: migrations=$MIGRATIONS last_migration=$LAST_MIGRATION system_identifier=$SYSTEM_ID port=$PORT"

echo "==> outcome-watchdog: running independent fault, SLO, capacity and security matrix"
set +e
NODE_PATH="$NODE_MODULES" \
OUTCOME_WATCHDOG_MODULE="$WATCHDOG_MODULE" \
OUTCOME_WATCHDOG_EVALUATOR_MODULE="$WATCHDOG_EVALUATOR_MODULE" \
OUTCOME_WATCHDOG_PG_URL="$URL" \
OUTCOME_WATCHDOG_PG_EXPECTED_DATABASE="$DATABASE" \
OUTCOME_WATCHDOG_PG_EXPECTED_USER="$ADMIN" \
OUTCOME_WATCHDOG_PG_EXPECTED_SYSTEM_IDENTIFIER="$SYSTEM_ID" \
OUTCOME_WATCHDOG_EVIDENCE_PATH="$EVIDENCE" \
OUTCOME_WATCHDOG_CONTRACT_PATH="$CONTRACT" \
OUTCOME_WATCHDOG_COLLECTOR_SHA="$COLLECTOR_SHA" \
OUTCOME_WATCHDOG_TARGET_SHA="$TARGET_SHA" \
timeout -k 20 "$TIMEOUT_SECONDS" node --test --test-concurrency=1 \
  "$REPO/test/outcome-reconciler-v2.watchdog.test.mjs" 2>&1 | tee "$TAP"
TEST_RC=${PIPESTATUS[0]}
set -e
if [ "$TEST_RC" -ne 0 ]; then
  echo "!! outcome-watchdog tests failed rc=$TEST_RC" >&2
  exit "$TEST_RC"
fi

echo "==> outcome-watchdog: removing disposable PostgreSQL database before publishing evidence"
if outcome_release_dag_db_enabled; then
  outcome_release_dag_drop_database
else
  docker rm -fv "$CONTAINER" >/dev/null
  if docker inspect "$CONTAINER" >/dev/null 2>&1; then
    echo '!! disposable PostgreSQL fixture survived cleanup' >&2
    exit 1
  fi
fi

echo "==> outcome-watchdog: validating zero-skip evidence and writing manifests"
OUTCOME_WATCHDOG_STARTED_AT="$STARTED_AT" \
OUTCOME_WATCHDOG_DEADLINE_SECONDS="$TIMEOUT_SECONDS" \
OUTCOME_WATCHDOG_FIXTURE_CLEANED=true \
OUTCOME_WATCHDOG_MIGRATIONS="$MIGRATIONS" \
OUTCOME_WATCHDOG_LAST_MIGRATION="$LAST_MIGRATION" \
node \
  "$REPO/scripts/outcome-reconciler-watchdog-manifest.mjs" \
  "$TAP" "$EVIDENCE" "$CONTRACT" "$MANIFEST" "$CAPACITY_MANIFEST" \
  "$RUNTIME_EVIDENCE" "$RUNTIME_MANIFEST"
