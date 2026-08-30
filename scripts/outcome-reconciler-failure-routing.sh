#!/usr/bin/env bash
# Dedicated executable acceptance for deterministic Failure Continuation routing and convergence.
# Every database write is made in a disposable PostgreSQL container.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
API="$REPO/src/apiserver"
BUILD="$REPO/build"
CONTAINER="${FAILURE_ROUTING_PG_CONTAINER:-orbit-failure-routing-pg-$$}"
ADMIN="${FAILURE_ROUTING_PG_USER:-failure_routing_admin}"
PASSWORD="${FAILURE_ROUTING_PG_PASSWORD:-failure_routing_fixture_pw}"
DATABASE="${FAILURE_ROUTING_PG_DATABASE:-failure_routing_$$_fixture}"
IMAGE="${FAILURE_ROUTING_PG_IMAGE:-postgres:16-alpine}"
TIMEOUT_SECONDS="${FAILURE_ROUTING_TEST_TIMEOUT_SECONDS:-480}"
TAP="$BUILD/outcome-reconciler-failure-routing.tap"
EVIDENCE="$BUILD/outcome-reconciler-failure-routing-evidence.json"
MANIFEST="$BUILD/outcome-reconciler-failure-routing-manifest.json"
STARTED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
TARGET_SHA="$(git -C "$REPO" rev-parse HEAD)"
ROOT_MODULE_LINK=0
API_MODULE_LINK=0
SHARED_MODULE_LINK=0

cleanup() {
  docker rm -fv "$CONTAINER" >/dev/null 2>&1 || true
  if [ "$SHARED_MODULE_LINK" = "1" ] && [ -L "$REPO/src/shared/node_modules" ]; then
    unlink "$REPO/src/shared/node_modules"
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
if [ ! -e "$REPO/src/shared/node_modules" ] && [ ! -L "$REPO/src/shared/node_modules" ]; then
  [ -d /root/orbit/src/shared/node_modules ] || {
    echo '!! shared Node dependencies are unavailable' >&2
    exit 1
  }
  ln -s /root/orbit/src/shared/node_modules "$REPO/src/shared/node_modules"
  SHARED_MODULE_LINK=1
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

echo '==> failure-routing: generate and build production sources'
( cd "$REPO" && npm run prisma:generate -w @orbit/apiserver >/dev/null )
( cd "$REPO" && npm run build -w @orbit/shared >/dev/null )
RESOLVED_SHARED_PACKAGE="$(cd "$REPO" && node -p "require.resolve('@orbit/shared/package.json')")"
if [ "$RESOLVED_SHARED_PACKAGE" != "$REPO/src/shared/package.json" ]; then
  ( cd "$(dirname "$RESOLVED_SHARED_PACKAGE")" && "$REPO/node_modules/.bin/tsc" -p tsconfig.json )
fi
( cd "$REPO" && npm run build -w @orbit/apiserver >/dev/null )

echo '==> failure-routing: provision disposable PostgreSQL 16'
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

echo '==> failure-routing: deploy every migration to disposable PostgreSQL'
( cd "$API" && DATABASE_URL="$URL" node node_modules/prisma/build/index.js \
  migrate deploy --schema prisma/schema.prisma >/dev/null )
MIGRATION_COUNT="$(docker exec "$CONTAINER" psql -U "$ADMIN" -d "$DATABASE" -tAc \
  'SELECT count(*) FROM _prisma_migrations WHERE finished_at IS NOT NULL' | tr -d '[:space:]')"
LAST_MIGRATION="$(docker exec "$CONTAINER" psql -U "$ADMIN" -d "$DATABASE" -tAc \
  'SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL ORDER BY finished_at DESC LIMIT 1' \
  | tr -d '[:space:]')"
REQUIRED_MIGRATION_APPLIED="$(docker exec "$CONTAINER" psql -U "$ADMIN" -d "$DATABASE" -tAc \
  "SELECT count(*) FROM _prisma_migrations WHERE migration_name='0211_failure_continuation_routing' AND finished_at IS NOT NULL" \
  | tr -d '[:space:]')"
[ "$MIGRATION_COUNT" -gt 0 ] || {
  echo '!! zero applied migrations is forbidden' >&2
  exit 1
}
[ "$LAST_MIGRATION" = '0211_failure_continuation_routing' ] || {
  echo "!! migration frontier is $LAST_MIGRATION" >&2
  exit 1
}
[ "$REQUIRED_MIGRATION_APPLIED" = '1' ] || {
  echo '!! required migration 0211_failure_continuation_routing is not applied exactly once' >&2
  exit 1
}

echo '==> failure-routing: run deterministic domain/owner/convergence/replay matrix'
set +e
FAILURE_ROUTING_PG_URL="$URL" \
FAILURE_ROUTING_PG_EXPECTED_DATABASE="$DATABASE" \
FAILURE_ROUTING_PG_EXPECTED_USER="$ADMIN" \
FAILURE_ROUTING_PG_EXPECTED_SYSTEM_IDENTIFIER="$SYSTEM_IDENTIFIER" \
FAILURE_ROUTING_EVIDENCE_PATH="$EVIDENCE" \
FAILURE_ROUTING_TARGET_SHA="$TARGET_SHA" \
FAILURE_ROUTING_STARTED_AT="$STARTED_AT" \
FAILURE_ROUTING_MIGRATION_COUNT="$MIGRATION_COUNT" \
FAILURE_ROUTING_LAST_MIGRATION="$LAST_MIGRATION" \
FAILURE_ROUTING_REQUIRED_MIGRATION_APPLIED="$REQUIRED_MIGRATION_APPLIED" \
timeout -k 10 "$TIMEOUT_SECONDS" node --test --test-concurrency=1 --test-reporter=tap \
  "$REPO/test/outcome-reconciler-failure-routing.test.mjs" 2>&1 | tee "$TAP"
TEST_RC=${PIPESTATUS[0]}
set -e
if [ "$TEST_RC" -ne 0 ]; then
  echo "!! failure-routing tests failed rc=$TEST_RC" >&2
  exit "$TEST_RC"
fi

echo '==> failure-routing: remove PostgreSQL before publishing evidence'
docker rm -fv "$CONTAINER" >/dev/null
if docker inspect "$CONTAINER" >/dev/null 2>&1; then
  echo '!! disposable PostgreSQL fixture survived cleanup' >&2
  exit 1
fi

echo '==> failure-routing: validate zero-skip evidence and publish manifest'
FAILURE_ROUTING_FIXTURE_CLEANED=true \
node "$REPO/scripts/outcome-reconciler-failure-routing-manifest.mjs" \
  "$TAP" "$EVIDENCE" "$MANIFEST"
