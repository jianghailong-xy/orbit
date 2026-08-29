#!/usr/bin/env bash
# Isolated PostgreSQL regression for the singleton Watchdog binding lifecycle. Production rows and
# outcome_projection are never written; absence of Docker/PostgreSQL is a hard failure.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
API="$REPO/src/apiserver"
BUILD="$REPO/build"
CONTAINER="${WATCHDOG_CURRENT_BINDING_PG_CONTAINER:-orbit-watchdog-binding-pg-$$}"
ADMIN="${WATCHDOG_CURRENT_BINDING_PG_USER:-watchdog_binding_admin}"
PASSWORD="${WATCHDOG_CURRENT_BINDING_PG_PASSWORD:-watchdog_binding_fixture_pw}"
DATABASE="${WATCHDOG_CURRENT_BINDING_PG_DATABASE:-watchdog_binding_$$_fixture}"
IMAGE="${WATCHDOG_CURRENT_BINDING_PG_IMAGE:-postgres:16-alpine}"
TIMEOUT_SECONDS="${WATCHDOG_CURRENT_BINDING_TEST_TIMEOUT_SECONDS:-240}"
TAP="$BUILD/outcome-reconciler-watchdog-current-binding.tap"
EVIDENCE="$BUILD/outcome-reconciler-watchdog-current-binding-evidence.json"
MANIFEST="$BUILD/outcome-reconciler-watchdog-current-binding-manifest.json"
STARTED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
TARGET_SHA="$(git -C "$REPO" rev-parse HEAD)"
ROOT_MODULE_LINK=0
API_MODULE_LINK=0

cleanup() {
  docker rm -fv "$CONTAINER" >/dev/null 2>&1 || true
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

echo '==> watchdog-current-binding: provision isolated PostgreSQL 16'
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
[ "$READY" = "1" ] || {
  echo '!! disposable PostgreSQL did not become ready' >&2
  exit 1
}
docker exec "$CONTAINER" psql -U "$ADMIN" -d postgres -v ON_ERROR_STOP=1 \
  -c "CREATE DATABASE $DATABASE" >/dev/null
PORT_LINE="$(docker port "$CONTAINER" 5432/tcp)"
PORT="${PORT_LINE##*:}"
URL="postgresql://$ADMIN:$PASSWORD@127.0.0.1:$PORT/$DATABASE"
SYSTEM_IDENTIFIER="$(docker exec "$CONTAINER" psql -U "$ADMIN" -d postgres -tAc \
  'SELECT system_identifier FROM pg_control_system()' | tr -d '[:space:]')"

echo '==> watchdog-current-binding: deploy every migration to disposable PostgreSQL'
( cd "$API" && DATABASE_URL="$URL" node node_modules/prisma/build/index.js \
  migrate deploy --schema prisma/schema.prisma >/dev/null )
MIGRATION_COUNT="$(docker exec "$CONTAINER" psql -U "$ADMIN" -d "$DATABASE" -tAc \
  'SELECT count(*) FROM _prisma_migrations WHERE finished_at IS NOT NULL' | tr -d '[:space:]')"
LAST_MIGRATION="$(docker exec "$CONTAINER" psql -U "$ADMIN" -d "$DATABASE" -tAc \
  'SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL ORDER BY finished_at DESC LIMIT 1' \
  | tr -d '[:space:]')"
[ "$MIGRATION_COUNT" -gt 0 ] || {
  echo '!! zero applied migrations is forbidden' >&2
  exit 1
}
[ "$LAST_MIGRATION" = '0206_watchdog_current_binding' ] || {
  echo "!! migration frontier is $LAST_MIGRATION, expected 0206_watchdog_current_binding" >&2
  exit 1
}

echo '==> watchdog-current-binding: run startup/heartbeat/rolling/race/dead-man matrix'
set +e
WATCHDOG_CURRENT_BINDING_PG_URL="$URL" \
WATCHDOG_CURRENT_BINDING_PG_EXPECTED_DATABASE="$DATABASE" \
WATCHDOG_CURRENT_BINDING_PG_EXPECTED_USER="$ADMIN" \
WATCHDOG_CURRENT_BINDING_PG_EXPECTED_SYSTEM_IDENTIFIER="$SYSTEM_IDENTIFIER" \
WATCHDOG_CURRENT_BINDING_EVIDENCE_PATH="$EVIDENCE" \
WATCHDOG_CURRENT_BINDING_TARGET_SHA="$TARGET_SHA" \
WATCHDOG_CURRENT_BINDING_STARTED_AT="$STARTED_AT" \
WATCHDOG_CURRENT_BINDING_MIGRATION_COUNT="$MIGRATION_COUNT" \
WATCHDOG_CURRENT_BINDING_LAST_MIGRATION="$LAST_MIGRATION" \
timeout -k 10 "$TIMEOUT_SECONDS" node --test --test-concurrency=1 --test-reporter=tap \
  "$REPO/test/outcome-reconciler-watchdog-current-binding.test.mjs" 2>&1 | tee "$TAP"
TEST_RC=${PIPESTATUS[0]}
set -e
if [ "$TEST_RC" -ne 0 ]; then
  echo "!! watchdog current-binding tests failed rc=$TEST_RC" >&2
  exit "$TEST_RC"
fi

echo '==> watchdog-current-binding: remove PostgreSQL before publishing evidence'
docker rm -fv "$CONTAINER" >/dev/null
if docker inspect "$CONTAINER" >/dev/null 2>&1; then
  echo '!! disposable PostgreSQL fixture survived cleanup' >&2
  exit 1
fi

echo '==> watchdog-current-binding: validate zero-skip evidence and write manifest'
WATCHDOG_CURRENT_BINDING_FIXTURE_CLEANED=true \
node "$REPO/scripts/outcome-reconciler-watchdog-current-binding-manifest.mjs" \
  "$TAP" "$EVIDENCE" "$MANIFEST"
