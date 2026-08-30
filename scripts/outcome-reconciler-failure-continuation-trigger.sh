#!/usr/bin/env bash
# Dedicated executable acceptance for transactional failure-continuation triggering and leased
# coordinator delivery.  Every write goes to a disposable PostgreSQL container.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
API="$REPO/src/apiserver"
BUILD="$REPO/build"
CONTAINER="${FAILURE_CONTINUATION_PG_CONTAINER:-orbit-failure-continuation-pg-$$}"
ADMIN="${FAILURE_CONTINUATION_PG_USER:-failure_continuation_admin}"
PASSWORD="${FAILURE_CONTINUATION_PG_PASSWORD:-failure_continuation_fixture_pw}"
DATABASE="${FAILURE_CONTINUATION_PG_DATABASE:-failure_continuation_$$_fixture}"
IMAGE="${FAILURE_CONTINUATION_PG_IMAGE:-postgres:16-alpine}"
TIMEOUT_SECONDS="${FAILURE_CONTINUATION_TEST_TIMEOUT_SECONDS:-360}"
TAP="$BUILD/outcome-reconciler-failure-continuation-trigger.tap"
EVIDENCE="$BUILD/outcome-reconciler-failure-continuation-trigger-evidence.json"
MANIFEST="$BUILD/outcome-reconciler-failure-continuation-trigger-manifest.json"
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

echo '==> failure-continuation: generate and build production protocol sources'
( cd "$REPO" && npm run prisma:generate -w @orbit/apiserver >/dev/null )
( cd "$REPO" && npm run build -w @orbit/shared >/dev/null )
# A worktree can borrow node_modules from /root/orbit; in that case @orbit/shared resolves there.
# Refresh exactly the package the API compiler reads, while source digests still bind this tree.
RESOLVED_SHARED_PACKAGE="$(cd "$REPO" && node -p "require.resolve('@orbit/shared/package.json')")"
if [ "$RESOLVED_SHARED_PACKAGE" != "$REPO/src/shared/package.json" ]; then
  ( cd "$(dirname "$RESOLVED_SHARED_PACKAGE")" && "$REPO/node_modules/.bin/tsc" -p tsconfig.json )
fi
( cd "$REPO" && npm run build -w @orbit/apiserver >/dev/null )

echo '==> failure-continuation: provision disposable PostgreSQL 16'
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

echo '==> failure-continuation: deploy every migration to disposable PostgreSQL'
( cd "$API" && DATABASE_URL="$URL" node node_modules/prisma/build/index.js \
  migrate deploy --schema prisma/schema.prisma >/dev/null )
MIGRATION_COUNT="$(docker exec "$CONTAINER" psql -U "$ADMIN" -d "$DATABASE" -tAc \
  'SELECT count(*) FROM _prisma_migrations WHERE finished_at IS NOT NULL' | tr -d '[:space:]')"
LAST_MIGRATION="$(docker exec "$CONTAINER" psql -U "$ADMIN" -d "$DATABASE" -tAc \
  'SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL ORDER BY finished_at DESC LIMIT 1' \
  | tr -d '[:space:]')"
REQUIRED_MIGRATION_APPLIED="$(docker exec "$CONTAINER" psql -U "$ADMIN" -d "$DATABASE" -tAc \
  "SELECT count(*) FROM _prisma_migrations WHERE migration_name='0210_failure_continuation_trigger' AND finished_at IS NOT NULL" \
  | tr -d '[:space:]')"
[ "$MIGRATION_COUNT" -gt 0 ] || {
  echo '!! zero applied migrations is forbidden' >&2
  exit 1
}
[ "$LAST_MIGRATION" = '0210_failure_continuation_trigger' ] || {
  echo "!! migration frontier is $LAST_MIGRATION" >&2
  exit 1
}
[ "$REQUIRED_MIGRATION_APPLIED" = '1' ] || {
  echo '!! required migration 0210_failure_continuation_trigger is not applied exactly once' >&2
  exit 1
}

echo '==> failure-continuation: run atomicity/replay/lease/crash/sweep matrix'
set +e
FAILURE_CONTINUATION_PG_URL="$URL" \
FAILURE_CONTINUATION_PG_EXPECTED_DATABASE="$DATABASE" \
FAILURE_CONTINUATION_PG_EXPECTED_USER="$ADMIN" \
FAILURE_CONTINUATION_PG_EXPECTED_SYSTEM_IDENTIFIER="$SYSTEM_IDENTIFIER" \
FAILURE_CONTINUATION_EVIDENCE_PATH="$EVIDENCE" \
FAILURE_CONTINUATION_TARGET_SHA="$TARGET_SHA" \
FAILURE_CONTINUATION_STARTED_AT="$STARTED_AT" \
FAILURE_CONTINUATION_MIGRATION_COUNT="$MIGRATION_COUNT" \
FAILURE_CONTINUATION_LAST_MIGRATION="$LAST_MIGRATION" \
FAILURE_CONTINUATION_REQUIRED_MIGRATION_APPLIED="$REQUIRED_MIGRATION_APPLIED" \
timeout -k 10 "$TIMEOUT_SECONDS" node --test --test-concurrency=1 --test-reporter=tap \
  "$REPO/test/outcome-reconciler-failure-continuation-trigger.test.mjs" 2>&1 | tee "$TAP"
TEST_RC=${PIPESTATUS[0]}
set -e
if [ "$TEST_RC" -ne 0 ]; then
  echo "!! failure-continuation tests failed rc=$TEST_RC" >&2
  exit "$TEST_RC"
fi

echo '==> failure-continuation: remove PostgreSQL before publishing evidence'
docker rm -fv "$CONTAINER" >/dev/null
if docker inspect "$CONTAINER" >/dev/null 2>&1; then
  echo '!! disposable PostgreSQL fixture survived cleanup' >&2
  exit 1
fi

echo '==> failure-continuation: validate zero-skip evidence and publish manifest'
FAILURE_CONTINUATION_FIXTURE_CLEANED=true \
node "$REPO/scripts/outcome-reconciler-failure-continuation-trigger-manifest.mjs" \
  "$TAP" "$EVIDENCE" "$MANIFEST"
