#!/usr/bin/env bash
# End-to-end acceptance for canonical Failure Continuation surfaces and automatic repair.
# PostgreSQL and the broken prepare-postgres fixture are disposable; no deployed database is used.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
API="$REPO/src/apiserver"
WEB="$REPO/src/web"
BUILD="$REPO/build/failure-coordination-e2e"
CONTAINER="${FAILURE_COORDINATION_PG_CONTAINER:-orbit-failure-coordination-pg-$$}"
ADMIN="${FAILURE_COORDINATION_PG_USER:-failure_coordination_admin}"
PASSWORD="${FAILURE_COORDINATION_PG_PASSWORD:-failure_coordination_fixture_pw}"
DATABASE="${FAILURE_COORDINATION_PG_DATABASE:-failure_coordination_$$_fixture}"
IMAGE="${FAILURE_COORDINATION_PG_IMAGE:-postgres:16-alpine}"
TIMEOUT_SECONDS="${FAILURE_COORDINATION_TEST_TIMEOUT_SECONDS:-1200}"
WEB_JSON="$BUILD/web.json"
API_TAP="$BUILD/api.tap"
E2E_TAP="$BUILD/e2e.tap"
EVIDENCE="$BUILD/evidence.json"
MANIFEST="$REPO/build/outcome-reconciler-failure-coordination-e2e-manifest.json"
LOCAL_PRISMA_SCHEMA_DIR="$API/build/failure-coordination-prisma-schema"
LOCAL_PRISMA_SCHEMA="$LOCAL_PRISMA_SCHEMA_DIR/schema.prisma"
LOCAL_PRISMA_CLIENT="$BUILD/prisma-client"
STARTED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
TARGET_SHA="$(git -C "$REPO" rev-parse HEAD)"
ROOT_MODULE_LINK=0
API_MODULE_LINK=0
WEB_MODULE_LINK=0
SHARED_MODULE_LINK=0
SOURCE_SHARED_LINK=0
SOURCE_PRISMA_LINK=0
DIST_SHARED_LINK=0
DIST_PRISMA_LINK=0

cleanup() {
  docker rm -fv "$CONTAINER" >/dev/null 2>&1 || true
  if [ "$DIST_PRISMA_LINK" = "1" ]; then unlink "$API/dist/node_modules/@prisma/client"; fi
  if [ "$DIST_SHARED_LINK" = "1" ]; then unlink "$API/dist/node_modules/@orbit/shared"; fi
  rmdir "$API/dist/node_modules/@prisma" "$API/dist/node_modules/@orbit" \
    "$API/dist/node_modules" >/dev/null 2>&1 || true
  if [ "$SOURCE_PRISMA_LINK" = "1" ]; then unlink "$API/src/node_modules/@prisma/client"; fi
  if [ "$SOURCE_SHARED_LINK" = "1" ]; then unlink "$API/src/node_modules/@orbit/shared"; fi
  rmdir "$API/src/node_modules/@prisma" "$API/src/node_modules/@orbit" \
    "$API/src/node_modules" >/dev/null 2>&1 || true
  if [ "$WEB_MODULE_LINK" = "1" ] && [ -L "$WEB/node_modules" ]; then unlink "$WEB/node_modules"; fi
  if [ "$SHARED_MODULE_LINK" = "1" ] && [ -L "$REPO/src/shared/node_modules" ]; then
    unlink "$REPO/src/shared/node_modules"
  fi
  if [ "$API_MODULE_LINK" = "1" ] && [ -L "$API/node_modules" ]; then unlink "$API/node_modules"; fi
  if [ "$ROOT_MODULE_LINK" = "1" ] && [ -L "$REPO/node_modules" ]; then unlink "$REPO/node_modules"; fi
}
trap cleanup EXIT

command -v docker >/dev/null || { echo '!! docker is required' >&2; exit 1; }
docker info >/dev/null 2>&1 || { echo '!! docker daemon is not reachable' >&2; exit 1; }
[[ "$TARGET_SHA" =~ ^[0-9a-f]{40}$ ]] || { echo '!! target SHA must be full' >&2; exit 1; }
mkdir -p "$BUILD"

if [ ! -e "$REPO/node_modules" ] && [ ! -L "$REPO/node_modules" ]; then
  [ -d /root/orbit/node_modules ] || { echo '!! root dependencies unavailable' >&2; exit 1; }
  ln -s /root/orbit/node_modules "$REPO/node_modules"
  ROOT_MODULE_LINK=1
fi
if [ ! -e "$API/node_modules" ] && [ ! -L "$API/node_modules" ]; then
  [ -d /root/orbit/src/apiserver/node_modules ] || { echo '!! API dependencies unavailable' >&2; exit 1; }
  ln -s /root/orbit/src/apiserver/node_modules "$API/node_modules"
  API_MODULE_LINK=1
fi
if [ ! -e "$WEB/node_modules" ] && [ ! -L "$WEB/node_modules" ]; then
  [ -d /root/orbit/src/web/node_modules ] || { echo '!! Web dependencies unavailable' >&2; exit 1; }
  ln -s /root/orbit/src/web/node_modules "$WEB/node_modules"
  WEB_MODULE_LINK=1
fi
if [ ! -e "$REPO/src/shared/node_modules" ] && [ ! -L "$REPO/src/shared/node_modules" ]; then
  [ -d /root/orbit/src/shared/node_modules ] || { echo '!! shared dependencies unavailable' >&2; exit 1; }
  ln -s /root/orbit/src/shared/node_modules "$REPO/src/shared/node_modules"
  SHARED_MODULE_LINK=1
fi

PRISMA="$API/node_modules/.bin/prisma"
TSC="$API/node_modules/.bin/tsc"
VITEST="$WEB/node_modules/.bin/vitest"
[ -x "$VITEST" ] || VITEST="$REPO/node_modules/.bin/vitest"
[ -x "$PRISMA" ] || { echo '!! Prisma CLI unavailable' >&2; exit 1; }
[ -x "$TSC" ] || { echo '!! TypeScript compiler unavailable' >&2; exit 1; }
[ -x "$VITEST" ] || { echo '!! Vitest unavailable' >&2; exit 1; }

echo '==> failure-coordination: build shared and isolated schema-bound API client'
npm run build -w @orbit/shared >/dev/null
mkdir -p "$LOCAL_PRISMA_SCHEMA_DIR"
cp "$API/prisma/schema.prisma" "$LOCAL_PRISMA_SCHEMA"
sed -i "/provider = \"prisma-client-js\"/a\\  output = \"$LOCAL_PRISMA_CLIENT\"" \
  "$LOCAL_PRISMA_SCHEMA"
( cd "$API" && node node_modules/prisma/build/index.js generate \
  --schema "$LOCAL_PRISMA_SCHEMA" --no-hints >/dev/null )
for link in "$API/src/node_modules/@orbit/shared" "$API/src/node_modules/@prisma/client"; do
  if [ -e "$link" ] || [ -L "$link" ]; then
    echo "!! isolated module overlay already exists: $link" >&2
    exit 1
  fi
done
mkdir -p "$API/src/node_modules/@orbit" "$API/src/node_modules/@prisma"
ln -s "$REPO/src/shared" "$API/src/node_modules/@orbit/shared"
SOURCE_SHARED_LINK=1
ln -s "$LOCAL_PRISMA_CLIENT" "$API/src/node_modules/@prisma/client"
SOURCE_PRISMA_LINK=1
npm run build -w @orbit/apiserver >/dev/null
"$TSC" -p "$API/tsconfig.test.json"
mkdir -p "$API/dist/node_modules/@orbit" "$API/dist/node_modules/@prisma"
ln -s "$REPO/src/shared" "$API/dist/node_modules/@orbit/shared"
DIST_SHARED_LINK=1
ln -s "$LOCAL_PRISMA_CLIENT" "$API/dist/node_modules/@prisma/client"
DIST_PRISMA_LINK=1

echo '==> failure-coordination: build Web and run focused Web/API tests'
npm run build -w @orbit/web >/dev/null
( cd "$WEB" && "$VITEST" run src/components/FailureCoordinationUi.test.tsx \
  --maxWorkers=1 --reporter=json --outputFile="$WEB_JSON" )
node --test --test-reporter=tap \
  "$API/build/common/failure-coordination-read.spec.js" 2>&1 | tee "$API_TAP"
WEB_TESTS="$(node -e "const v=require(process.argv[1]); process.stdout.write(String(v.numTotalTests))" "$WEB_JSON")"
API_TESTS="$(sed -n 's/^# tests //p' "$API_TAP" | tail -n 1)"
[ "$WEB_TESTS" -gt 0 ] && [ "$API_TESTS" -gt 0 ] || {
  echo '!! Web and API tests must both be > 0' >&2
  exit 1
}

echo '==> failure-coordination: provision disposable PostgreSQL 16'
docker run -d --name "$CONTAINER" --tmpfs /var/lib/postgresql/data:rw,size=1g \
  -e "POSTGRES_USER=$ADMIN" -e "POSTGRES_PASSWORD=$PASSWORD" -e POSTGRES_DB=postgres \
  -p 127.0.0.1::5432 "$IMAGE" >/dev/null
READY=0
for _ in $(seq 1 60); do
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
( cd "$API" && DATABASE_URL="$URL" "$PRISMA" migrate deploy --schema prisma/schema.prisma >/dev/null )
MIGRATION_COUNT="$(docker exec "$CONTAINER" psql -U "$ADMIN" -d "$DATABASE" -tAc \
  'SELECT count(*) FROM _prisma_migrations WHERE finished_at IS NOT NULL' | tr -d '[:space:]')"
LAST_MIGRATION="$(docker exec "$CONTAINER" psql -U "$ADMIN" -d "$DATABASE" -tAc \
  'SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL ORDER BY finished_at DESC LIMIT 1' \
  | tr -d '[:space:]')"
[ "$MIGRATION_COUNT" -gt 0 ] || { echo '!! no migrations applied' >&2; exit 1; }
[ "$LAST_MIGRATION" = '0212_failure_successor_handoff' ] || {
  echo "!! unexpected migration frontier $LAST_MIGRATION" >&2
  exit 1
}

echo '==> failure-coordination: run prepare-postgres automatic continuation E2E'
set +e
FAILURE_COORDINATION_PG_URL="$URL" \
FAILURE_COORDINATION_PG_EXPECTED_DATABASE="$DATABASE" \
FAILURE_COORDINATION_PG_EXPECTED_USER="$ADMIN" \
FAILURE_COORDINATION_PG_EXPECTED_SYSTEM_IDENTIFIER="$SYSTEM_IDENTIFIER" \
FAILURE_COORDINATION_EVIDENCE_PATH="$EVIDENCE" \
FAILURE_COORDINATION_TARGET_SHA="$TARGET_SHA" \
FAILURE_COORDINATION_STARTED_AT="$STARTED_AT" \
FAILURE_COORDINATION_MIGRATION_COUNT="$MIGRATION_COUNT" \
FAILURE_COORDINATION_LAST_MIGRATION="$LAST_MIGRATION" \
FAILURE_COORDINATION_WEB_TESTS="$WEB_TESTS" \
FAILURE_COORDINATION_API_TESTS="$API_TESTS" \
timeout -k 20 "$TIMEOUT_SECONDS" node --test --test-concurrency=1 --test-reporter=tap \
  "$REPO/test/outcome-reconciler-failure-coordination-e2e.test.mjs" 2>&1 | tee "$E2E_TAP"
E2E_RC=${PIPESTATUS[0]}
set -e
[ "$E2E_RC" -eq 0 ] || { echo "!! E2E failed rc=$E2E_RC" >&2; exit "$E2E_RC"; }

echo '==> failure-coordination: remove disposable database before publishing manifest'
docker rm -fv "$CONTAINER" >/dev/null
if docker inspect "$CONTAINER" >/dev/null 2>&1; then
  echo '!! disposable PostgreSQL survived cleanup' >&2
  exit 1
fi
FAILURE_COORDINATION_FIXTURE_CLEANED=true \
node "$REPO/scripts/outcome-reconciler-failure-coordination-e2e-manifest.mjs" \
  "$WEB_JSON" "$API_TAP" "$E2E_TAP" "$EVIDENCE" "$MANIFEST"
echo '==> failure-coordination: PASS'
