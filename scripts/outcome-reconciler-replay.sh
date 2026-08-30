#!/usr/bin/env bash
# Historical trace replay acceptance harness. PostgreSQL is mandatory and disposable: absence,
# migration failure, timeout, cancellation, todo, or a single skipped case makes this command fail.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$REPO/scripts/lib/outcome-reconciler-release-dag.sh"
API="$REPO/src/apiserver"
CONTAINER="${OUTCOME_REPLAY_PG_CONTAINER:-outcome-replay-pg16-$$}"
ADMIN="${OUTCOME_REPLAY_PG_USER:-outcome_replay_admin}"
PASSWORD="${OUTCOME_REPLAY_PG_PASSWORD:-outcome_replay_pw}"
DATABASE="${OUTCOME_REPLAY_PG_DATABASE:-outcome_replay}"
IMAGE="${OUTCOME_REPLAY_PG_IMAGE:-postgres:16-alpine}"
TIMEOUT_SECONDS="${OUTCOME_REPLAY_TIMEOUT:-900}"
BUILD="$REPO/build"
COMPILED="$BUILD/outcome-replay-ts"
TAP="$BUILD/outcome-reconciler-v2-replay.tap"
EVIDENCE="$BUILD/outcome-reconciler-v2-replay-evidence.json"
MANIFEST="$BUILD/outcome-reconciler-v2-replay-manifest.json"
STARTED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
TARGET_SHA="$(git -C "$REPO" rev-parse HEAD)"
ROOT_MODULE_LINK=0
API_MODULE_LINK=0

cleanup() {
  if outcome_release_dag_db_enabled; then
    outcome_release_dag_drop_database
  else
    docker rm -fv "$CONTAINER" >/dev/null 2>&1 || true
  fi
  if [ "$API_MODULE_LINK" = "1" ] && [ -L "$API/node_modules" ]; then
    unlink "$API/node_modules"
  fi
  if [ "$ROOT_MODULE_LINK" = "1" ] && [ -L "$REPO/node_modules" ]; then
    unlink "$REPO/node_modules"
  fi
}
trap cleanup EXIT

command -v docker >/dev/null || {
  echo '!! PostgreSQL unavailable: docker is required' >&2
  exit 1
}
docker info >/dev/null 2>&1 || {
  echo '!! PostgreSQL unavailable: docker daemon is not reachable' >&2
  exit 1
}

NODE_MODULES=""
FOUND_PG=0
for candidate in "$API/node_modules" "$REPO/node_modules" \
  /root/orbit/src/apiserver/node_modules /root/orbit/node_modules; do
  if [ -d "$candidate" ]; then
    NODE_MODULES="${NODE_MODULES:+$NODE_MODULES:}$candidate"
  fi
  [ -d "$candidate/pg" ] && FOUND_PG=1
done
[ "$FOUND_PG" = "1" ] || {
  echo '!! pg client dependency is unavailable' >&2
  exit 1
}

PRISMA="$API/node_modules/.bin/prisma"
[ -x "$PRISMA" ] || PRISMA=/root/orbit/src/apiserver/node_modules/.bin/prisma
[ -x "$PRISMA" ] || {
  echo '!! Prisma CLI is unavailable' >&2
  exit 1
}
TSC="$REPO/node_modules/.bin/tsc"
[ -x "$TSC" ] || TSC=/root/orbit/node_modules/.bin/tsc
[ -x "$TSC" ] || {
  echo '!! TypeScript compiler is unavailable' >&2
  exit 1
}
TYPE_ROOT="$REPO/node_modules/@types"
[ -d "$TYPE_ROOT" ] || TYPE_ROOT=/root/orbit/node_modules/@types
[ -d "$TYPE_ROOT" ] || {
  echo '!! Node TypeScript definitions are unavailable' >&2
  exit 1
}

if [ ! -e "$REPO/node_modules" ] && [ ! -L "$REPO/node_modules" ]; then
  ln -s /root/orbit/node_modules "$REPO/node_modules"
  ROOT_MODULE_LINK=1
fi
if [ ! -e "$API/node_modules" ] && [ ! -L "$API/node_modules" ]; then
  ln -s /root/orbit/src/apiserver/node_modules "$API/node_modules"
  API_MODULE_LINK=1
fi

mkdir -p "$BUILD" "$COMPILED"
if [ "${OUTCOME_RELEASE_DAG_PREPARED_BUILD:-0}" = 1 ]; then
  outcome_release_dag_assert_build
  RUNTIME_MODULE="$API/dist/tasks/executable-acceptance-runtime.js"
  echo '==> trace-replay: use exact bound production build'
else
  echo '==> trace-replay: compiling the production executable-acceptance runtime'
  "$TSC" "$API/src/tasks/executable-acceptance-runtime.ts" \
    --target ES2022 --module nodenext --moduleResolution nodenext --strict --skipLibCheck \
    --typeRoots "$TYPE_ROOT" --rootDir "$API/src" --outDir "$COMPILED"
  RUNTIME_MODULE="$COMPILED/tasks/executable-acceptance-runtime.js"
fi
[ -f "$RUNTIME_MODULE" ] || {
  echo "!! compiled runtime is missing: $RUNTIME_MODULE" >&2
  exit 1
}

if outcome_release_dag_db_enabled; then
  echo '==> trace-replay: clone the bound migrated PostgreSQL template'
  outcome_release_dag_bind_database
else
  echo '==> trace-replay: provisioning disposable PostgreSQL 16'
  docker run -d --name "$CONTAINER" --tmpfs /var/lib/postgresql/data:rw,size=1g \
    -e "POSTGRES_USER=$ADMIN" -e "POSTGRES_PASSWORD=$PASSWORD" -e POSTGRES_DB=postgres \
    -p 127.0.0.1::5432 "$IMAGE" >/dev/null
  for _ in $(seq 1 90); do
    if docker exec -e "PGPASSWORD=$PASSWORD" "$CONTAINER" \
      psql -h 127.0.0.1 -U "$ADMIN" -d postgres -tAc 'SELECT 1' >/dev/null 2>&1; then
      break
    fi
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
  echo '==> trace-replay: applying every Prisma migration'
  ( cd "$API" && NODE_PATH="$NODE_MODULES" DATABASE_URL="$URL" \
    "$PRISMA" migrate deploy --schema prisma/schema.prisma >/dev/null )
  MIGRATIONS="$(docker exec "$CONTAINER" psql -U "$ADMIN" -d "$DATABASE" -tAc \
    'SELECT count(*) FROM _prisma_migrations WHERE finished_at IS NOT NULL' | tr -d '[:space:]')"
fi
echo "==> trace-replay: migrations=$MIGRATIONS system_identifier=$SYSTEM_ID port=$PORT"

echo '==> trace-replay: replaying 7+7+3 history, fault boundaries, races, and timeout recovery'
set +e
NODE_PATH="$NODE_MODULES" \
OUTCOME_REPLAY_RUNTIME_MODULE="$RUNTIME_MODULE" \
OUTCOME_REPLAY_PG_URL="$URL" \
OUTCOME_REPLAY_PG_EXPECTED_DATABASE="$DATABASE" \
OUTCOME_REPLAY_PG_EXPECTED_USER="$ADMIN" \
OUTCOME_REPLAY_PG_EXPECTED_SYSTEM_IDENTIFIER="$SYSTEM_ID" \
OUTCOME_REPLAY_EVIDENCE_PATH="$EVIDENCE" \
OUTCOME_REPLAY_TARGET_SHA="$TARGET_SHA" \
timeout -k 20 "$TIMEOUT_SECONDS" node --test --test-concurrency=1 \
  "$REPO/test/outcome-reconciler-v2.replay.test.mjs" 2>&1 | tee "$TAP"
TEST_RC=${PIPESTATUS[0]}
set -e
if [ "$TEST_RC" -ne 0 ]; then
  echo "!! trace-replay tests failed rc=$TEST_RC" >&2
  exit "$TEST_RC"
fi

# A manifest claiming disposable PostgreSQL must not be signed while its fixture is still alive.
if outcome_release_dag_db_enabled; then
  outcome_release_dag_drop_database
else
  docker rm -fv "$CONTAINER" >/dev/null
  if docker inspect "$CONTAINER" >/dev/null 2>&1; then
    echo '!! disposable PostgreSQL fixture still exists after cleanup' >&2
    exit 1
  fi
fi

echo '==> trace-replay: validating zero-skip evidence and writing the trace manifest'
OUTCOME_REPLAY_STARTED_AT="$STARTED_AT" \
OUTCOME_REPLAY_MIGRATION_COUNT="$MIGRATIONS" \
OUTCOME_REPLAY_FIXTURE_CLEANED=true \
node "$REPO/scripts/outcome-reconciler-replay-manifest.mjs" "$TAP" "$EVIDENCE" "$MANIFEST"
