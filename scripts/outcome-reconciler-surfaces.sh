#!/usr/bin/env bash
# Executable acceptance for the shared actor surfaces. PostgreSQL and every transport adapter are
# mandatory; unavailable infrastructure and skipped tests fail instead of reducing coverage.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
API="$REPO/src/apiserver"
CONTAINER="${OUTCOME_SURFACES_PG_CONTAINER:-outcome-surfaces-pg16-$$}"
ADMIN="${OUTCOME_SURFACES_PG_USER:-surface_admin}"
PASSWORD="${OUTCOME_SURFACES_PG_PASSWORD:-surface_pw}"
DATABASE="${OUTCOME_SURFACES_PG_DATABASE:-outcome_surfaces}"
IMAGE="${OUTCOME_SURFACES_PG_IMAGE:-postgres:16-alpine}"
BUILD="$REPO/build"
COMPILED="$BUILD/outcome-surfaces-ts"
TAP="$BUILD/outcome-reconciler-v2-surfaces.tap"
EVIDENCE="$BUILD/outcome-reconciler-v2-surfaces-evidence.json"
MANIFEST="$BUILD/outcome-reconciler-v2-surfaces-manifest.json"
ROOT_MODULE_LINK=0
API_MODULE_LINK=0
WEB_MODULE_LINK=0
SHARED_MODULE_LINK=0

cleanup() {
  docker rm -fv "$CONTAINER" >/dev/null 2>&1 || true
  if [ "$SHARED_MODULE_LINK" = 1 ] && [ -L "$REPO/src/shared/node_modules" ]; then unlink "$REPO/src/shared/node_modules"; fi
  if [ "$WEB_MODULE_LINK" = 1 ] && [ -L "$REPO/src/web/node_modules" ]; then unlink "$REPO/src/web/node_modules"; fi
  if [ "$API_MODULE_LINK" = 1 ] && [ -L "$API/node_modules" ]; then unlink "$API/node_modules"; fi
  if [ "$ROOT_MODULE_LINK" = 1 ] && [ -L "$REPO/node_modules" ]; then unlink "$REPO/node_modules"; fi
}
trap cleanup EXIT

command -v docker >/dev/null || { echo '!! docker is required; skip is forbidden' >&2; exit 1; }
docker info >/dev/null 2>&1 || { echo '!! docker daemon is unavailable; skip is forbidden' >&2; exit 1; }
command -v go >/dev/null || { echo '!! Go is required; skip is forbidden' >&2; exit 1; }

if [ ! -e "$REPO/node_modules" ]; then ln -s /root/orbit/node_modules "$REPO/node_modules"; ROOT_MODULE_LINK=1; fi
if [ ! -e "$API/node_modules" ]; then ln -s /root/orbit/src/apiserver/node_modules "$API/node_modules"; API_MODULE_LINK=1; fi
if [ ! -e "$REPO/src/web/node_modules" ]; then ln -s /root/orbit/src/web/node_modules "$REPO/src/web/node_modules"; WEB_MODULE_LINK=1; fi
if [ ! -e "$REPO/src/shared/node_modules" ]; then ln -s /root/orbit/src/shared/node_modules "$REPO/src/shared/node_modules"; SHARED_MODULE_LINK=1; fi

TSC="$REPO/node_modules/.bin/tsc"
PRISMA="$API/node_modules/.bin/prisma"
[ -x "$TSC" ] || { echo '!! TypeScript compiler unavailable' >&2; exit 1; }
[ -x "$PRISMA" ] || { echo '!! Prisma CLI unavailable' >&2; exit 1; }
NODE_MODULES="$API/node_modules:$REPO/node_modules:/root/orbit/src/apiserver/node_modules:/root/orbit/node_modules"
mkdir -p "$BUILD" "$COMPILED"

echo '==> outcome-surfaces: compiling canonical production model'
"$TSC" "$API/src/outcome-reconciler/outcome-surfaces.ts" \
  --target ES2022 --module nodenext --moduleResolution nodenext --strict --skipLibCheck \
  --typeRoots "$REPO/node_modules/@types" --outDir "$COMPILED"

echo '==> outcome-surfaces: building Web actor adapter'
npm run build -w @orbit/web >/dev/null
echo '==> outcome-surfaces: checking Web fixture semantic parity'
npm run test -w @orbit/web -- src/lib/outcomeSurfaces.contract.test.ts

echo '==> outcome-surfaces: provisioning disposable PostgreSQL 16'
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
docker exec "$CONTAINER" psql -U "$ADMIN" -d postgres -v ON_ERROR_STOP=1 \
  -c "CREATE DATABASE $DATABASE" >/dev/null
PORT_LINE="$(docker port "$CONTAINER" 5432/tcp)"
PORT="${PORT_LINE##*:}"
URL="postgresql://$ADMIN:$PASSWORD@127.0.0.1:$PORT/$DATABASE"

echo '==> outcome-surfaces: applying every Prisma migration'
( cd "$API" && NODE_PATH="$NODE_MODULES" DATABASE_URL="$URL" \
  "$PRISMA" migrate deploy --schema prisma/schema.prisma >/dev/null )

echo '==> outcome-surfaces: running semantic, tenant, stale, expiry, secret and ratification matrix'
set +e
NODE_PATH="$NODE_MODULES" \
OUTCOME_SURFACES_MODULE="$COMPILED/outcome-surfaces.js" \
OUTCOME_SURFACES_FIXTURE="$REPO/contracts/outcome-reconciler-v2.surfaces.fixture.json" \
OUTCOME_SURFACES_PG_URL="$URL" \
OUTCOME_SURFACES_EVIDENCE_PATH="$EVIDENCE" \
node --test --test-concurrency=1 "$REPO/test/outcome-reconciler-v2.surfaces.test.mjs" 2>&1 | tee "$TAP"
TEST_RC=${PIPESTATUS[0]}
set -e
[ "$TEST_RC" = 0 ] || exit "$TEST_RC"

echo '==> outcome-surfaces: checking CLI and MCP raw transport parity'
( cd "$REPO/src/runner-go" && go test -count=1 \
  -run '^(TestProjectObligations|TestMCPExposesExactlyTheProjectTools|TestProjectCLICapabilitiesAreAccurate|TestProjectCLIHelpAndUnknownCommand)' )

node "$REPO/scripts/outcome-reconciler-surfaces-manifest.mjs" "$TAP" "$EVIDENCE" "$MANIFEST"
