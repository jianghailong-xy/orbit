#!/usr/bin/env bash
# Unique executable acceptance for automatic dependency dispatch. PostgreSQL is mandatory and
# disposable; no branch may degrade to a skip or touch a production Project/Task.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$REPO/scripts/lib/outcome-reconciler-release-dag.sh"
API="$REPO/src/apiserver"
BUILD="$REPO/build"
CONTAINER="${AUTO_DISPATCH_PG_CONTAINER:-orbit-auto-dispatch-pg-$$}"
ADMIN="${AUTO_DISPATCH_PG_USER:-auto_dispatch_admin}"
PASSWORD="${AUTO_DISPATCH_PG_PASSWORD:-auto_dispatch_fixture_pw}"
DATABASE="${AUTO_DISPATCH_PG_DATABASE:-orbit_auto_dispatch_$$_fixture}"
IMAGE="${AUTO_DISPATCH_PG_IMAGE:-postgres:16-alpine}"
TIMEOUT_SECONDS="${AUTO_DISPATCH_TEST_TIMEOUT_SECONDS:-180}"
TAP="$BUILD/outcome-reconciler-auto-dispatch.tap"
EVIDENCE="$BUILD/outcome-reconciler-auto-dispatch-evidence.json"
MANIFEST="$BUILD/outcome-reconciler-auto-dispatch-manifest.json"
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
[[ "$TARGET_SHA" =~ ^[0-9a-f]{40}$ ]] || {
  echo '!! target SHA must be a full git SHA' >&2
  exit 1
}

if [ ! -e "$REPO/node_modules" ] && [ ! -L "$REPO/node_modules" ]; then
  [ -d /root/orbit/node_modules ] || {
    echo '!! root Node dependencies are unavailable' >&2
    exit 1
  }
  ln -s /root/orbit/node_modules "$REPO/node_modules"
  ROOT_MODULE_LINK=1
fi
if [ ! -e "$API/node_modules" ] && [ ! -L "$API/node_modules" ]; then
  [ -d /root/orbit/src/apiserver/node_modules ] || {
    echo '!! API Node dependencies are unavailable' >&2
    exit 1
  }
  ln -s /root/orbit/src/apiserver/node_modules "$API/node_modules"
  API_MODULE_LINK=1
fi
[ -x "$API/node_modules/.bin/prisma" ] || {
  echo '!! Prisma CLI is unavailable' >&2
  exit 1
}
node -e "require('pg')" >/dev/null 2>&1 || {
  echo '!! pg client dependency is unavailable' >&2
  exit 1
}
mkdir -p "$BUILD"

if [ "${OUTCOME_RELEASE_DAG_PREPARED_BUILD:-0}" = 1 ]; then
  outcome_release_dag_assert_build
  echo '==> auto-dispatch: use exact bound Prisma/Shared/API build'
else
  echo '==> auto-dispatch: generate and build the exact runtime sources'
  ( cd "$REPO" && npm run prisma:generate -w @orbit/apiserver >/dev/null )
  ( cd "$REPO" && npm run build -w @orbit/shared >/dev/null )
  RESOLVED_SHARED_PACKAGE="$(cd "$REPO" && node -p "require.resolve('@orbit/shared/package.json')")"
  if [ "$RESOLVED_SHARED_PACKAGE" != "$REPO/src/shared/package.json" ]; then
    ( cd "$(dirname "$RESOLVED_SHARED_PACKAGE")" && "$REPO/node_modules/.bin/tsc" -p tsconfig.json )
  fi
  ( cd "$REPO" && npm run build -w @orbit/apiserver >/dev/null )
fi

if outcome_release_dag_db_enabled; then
  echo '==> auto-dispatch: clone the bound migrated PostgreSQL template'
  outcome_release_dag_bind_database
else
  echo '==> auto-dispatch: provision isolated PostgreSQL 16'
  docker run -d --name "$CONTAINER" --tmpfs /var/lib/postgresql/data:rw,size=1g \
    -e "POSTGRES_USER=$ADMIN" -e "POSTGRES_PASSWORD=$PASSWORD" -e POSTGRES_DB=postgres \
    -p 127.0.0.1::5432 "$IMAGE" >/dev/null
  READY=0
  for _ in $(seq 1 45); do
    if docker exec -e "PGPASSWORD=$PASSWORD" "$CONTAINER" \
      psql -h 127.0.0.1 -U "$ADMIN" -d postgres -tAc 'SELECT 1' >/dev/null 2>&1; then
      READY=1
      break
    fi
    sleep 1
  done
  [ "$READY" = "1" ] || { echo '!! disposable PostgreSQL did not become ready' >&2; exit 1; }
  docker exec "$CONTAINER" psql -U "$ADMIN" -d postgres -v ON_ERROR_STOP=1 \
    -c "CREATE DATABASE $DATABASE" >/dev/null
  PORT_LINE="$(docker port "$CONTAINER" 5432/tcp)"
  PORT="${PORT_LINE##*:}"
  URL="postgresql://$ADMIN:$PASSWORD@127.0.0.1:$PORT/$DATABASE"
  SYSTEM_IDENTIFIER="$(docker exec "$CONTAINER" psql -U "$ADMIN" -d postgres -tAc \
    'SELECT system_identifier FROM pg_control_system()' | tr -d '[:space:]')"
  echo '==> auto-dispatch: deploy every migration to the disposable database'
  ( cd "$API" && DATABASE_URL="$URL" node node_modules/prisma/build/index.js \
    migrate deploy --schema prisma/schema.prisma >/dev/null )
  MIGRATION_COUNT="$(docker exec "$CONTAINER" psql -U "$ADMIN" -d "$DATABASE" -tAc \
    'SELECT count(*) FROM _prisma_migrations WHERE finished_at IS NOT NULL' | tr -d '[:space:]')"
  LAST_MIGRATION="$(docker exec "$CONTAINER" psql -U "$ADMIN" -d "$DATABASE" -tAc \
    'SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL ORDER BY finished_at DESC LIMIT 1' \
    | tr -d '[:space:]')"
fi
REQUIRED_MIGRATION_APPLIED="$(docker exec "$CONTAINER" psql -U "$ADMIN" -d "$DATABASE" -tAc \
  "SELECT count(*) FROM _prisma_migrations WHERE migration_name='0205_task_auto_dispatch_obligation' AND finished_at IS NOT NULL" \
  | tr -d '[:space:]')"
[ "$MIGRATION_COUNT" -gt 0 ] || {
  echo '!! zero applied migrations is forbidden' >&2
  exit 1
}
[ "$REQUIRED_MIGRATION_APPLIED" = '1' ] || {
  echo "!! required migration 0205_task_auto_dispatch_obligation is not applied exactly once" >&2
  exit 1
}
echo "==> auto-dispatch: migrations=$MIGRATION_COUNT frontier=$LAST_MIGRATION system_identifier=$SYSTEM_IDENTIFIER"

echo '==> auto-dispatch: run immediate/sweep/rolling/concurrency/refusal matrix'
set +e
AUTO_DISPATCH_PG_URL="$URL" \
AUTO_DISPATCH_PG_EXPECTED_DATABASE="$DATABASE" \
AUTO_DISPATCH_PG_EXPECTED_USER="$ADMIN" \
AUTO_DISPATCH_PG_EXPECTED_SYSTEM_IDENTIFIER="$SYSTEM_IDENTIFIER" \
AUTO_DISPATCH_FIXTURE_DISPOSABLE=true \
AUTO_DISPATCH_EVIDENCE_PATH="$EVIDENCE" \
AUTO_DISPATCH_TARGET_SHA="$TARGET_SHA" \
AUTO_DISPATCH_STARTED_AT="$STARTED_AT" \
AUTO_DISPATCH_MIGRATION_COUNT="$MIGRATION_COUNT" \
AUTO_DISPATCH_LAST_MIGRATION="$LAST_MIGRATION" \
AUTO_DISPATCH_REQUIRED_MIGRATION_APPLIED="$REQUIRED_MIGRATION_APPLIED" \
timeout -k 10 "$TIMEOUT_SECONDS" node --test --test-concurrency=1 --test-reporter=tap \
  "$REPO/test/outcome-reconciler-auto-dispatch.test.mjs" 2>&1 | tee "$TAP"
TEST_RC=${PIPESTATUS[0]}
set -e
if [ "$TEST_RC" -ne 0 ]; then
  echo "!! automatic-dispatch tests failed rc=$TEST_RC" >&2
  exit "$TEST_RC"
fi

echo '==> auto-dispatch: remove PostgreSQL before publishing evidence'
if outcome_release_dag_db_enabled; then
  outcome_release_dag_drop_database
else
  docker rm -fv "$CONTAINER" >/dev/null
  if docker inspect "$CONTAINER" >/dev/null 2>&1; then
    echo '!! disposable PostgreSQL fixture survived cleanup' >&2
    exit 1
  fi
fi

echo '==> auto-dispatch: validate zero-skip evidence and write SHA/source-bound manifest'
AUTO_DISPATCH_TARGET_SHA="$TARGET_SHA" \
AUTO_DISPATCH_FIXTURE_CLEANED=true \
node "$REPO/scripts/outcome-reconciler-auto-dispatch-manifest.mjs" \
  "$TAP" "$EVIDENCE" "$MANIFEST"
