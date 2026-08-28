#!/usr/bin/env bash
# Acceptance harness for the constrained Action Executor. PostgreSQL is mandatory and disposable;
# races are never skipped because a shared server or a provider fixture is unavailable.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
API="$REPO/src/apiserver"
CONTAINER="${OUTCOME_ACTION_PG_CONTAINER:-pcaction-pg16-$$}"
ADMIN="${OUTCOME_ACTION_PG_USER:-pcaction_admin}"
PASSWORD="${OUTCOME_ACTION_PG_PASSWORD:-pcaction_pw}"
DATABASE="${OUTCOME_ACTION_PG_DATABASE:-pcaction_outcome}"
IMAGE="${OUTCOME_ACTION_PG_IMAGE:-postgres:16-alpine}"
TIMEOUT_SECONDS="${OUTCOME_ACTION_TIMEOUT:-900}"
BUILD="$REPO/build"
COMPILED="$BUILD/outcome-action-ts"
TAP="$BUILD/outcome-reconciler-v2-actions.tap"
EVIDENCE="$BUILD/outcome-reconciler-v2-actions-evidence.json"
MANIFEST="$BUILD/outcome-reconciler-v2-actions-manifest.json"
STARTED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
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

# TypeScript resolves packages from the source file's ancestors, while this disposable worktree
# intentionally has no install of its own. Link the already-provisioned repository cache only for
# the production-service compile and remove both links in cleanup.
if [ ! -e "$REPO/node_modules" ] && [ ! -L "$REPO/node_modules" ]; then
  ln -s /root/orbit/node_modules "$REPO/node_modules"
  ROOT_MODULE_LINK=1
fi
if [ ! -e "$API/node_modules" ] && [ ! -L "$API/node_modules" ]; then
  ln -s /root/orbit/src/apiserver/node_modules "$API/node_modules"
  API_MODULE_LINK=1
fi

mkdir -p "$BUILD" "$COMPILED"
echo "==> action-executor: compiling production executor, admission, transition and fairness logic"
"$TSC" "$API/src/outcome-reconciler/action-executor.ts" \
  "$API/src/outcome-reconciler/action-executor.service.ts" \
  --target ES2022 --module nodenext --moduleResolution nodenext --strict --skipLibCheck \
  --experimentalDecorators --emitDecoratorMetadata --typeRoots "$TYPE_ROOT" --outDir "$COMPILED"

echo "==> action-executor: provisioning disposable PostgreSQL 16"
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

echo "==> action-executor: applying every Prisma migration"
( cd "$API" && NODE_PATH="$NODE_MODULES" DATABASE_URL="$URL" \
  "$PRISMA" migrate deploy --schema prisma/schema.prisma >/dev/null )
MIGRATIONS="$(docker exec "$CONTAINER" psql -U "$ADMIN" -d "$DATABASE" -tAc \
  'SELECT count(*) FROM _prisma_migrations WHERE finished_at IS NOT NULL' | tr -d '[:space:]')"
echo "==> action-executor: migrations=$MIGRATIONS system_identifier=$SYSTEM_ID port=$PORT"

echo "==> action-executor: running pure and PostgreSQL fault/concurrency matrix"
set +e
NODE_PATH="$NODE_MODULES" \
OUTCOME_ACTION_MODULE="$COMPILED/outcome-reconciler/action-executor.js" \
OUTCOME_ACTION_SERVICE_MODULE="$COMPILED/outcome-reconciler/action-executor.service.js" \
OUTCOME_ACTION_PG_URL="$URL" \
OUTCOME_ACTION_PG_EXPECTED_DATABASE="$DATABASE" \
OUTCOME_ACTION_PG_EXPECTED_USER="$ADMIN" \
OUTCOME_ACTION_PG_EXPECTED_SYSTEM_IDENTIFIER="$SYSTEM_ID" \
OUTCOME_ACTION_EVIDENCE_PATH="$EVIDENCE" \
timeout -k 20 "$TIMEOUT_SECONDS" node --test --test-concurrency=1 \
  "$REPO/test/outcome-reconciler-v2.actions.test.mjs" 2>&1 | tee "$TAP"
TEST_RC=${PIPESTATUS[0]}
set -e
if [ "$TEST_RC" -ne 0 ]; then
  echo "!! action-executor tests failed rc=$TEST_RC" >&2
  exit "$TEST_RC"
fi

echo "==> action-executor: validating zero-skip evidence and writing manifest"
OUTCOME_ACTION_STARTED_AT="$STARTED_AT" node \
  "$REPO/scripts/outcome-reconciler-actions-manifest.mjs" "$TAP" "$EVIDENCE" "$MANIFEST"
