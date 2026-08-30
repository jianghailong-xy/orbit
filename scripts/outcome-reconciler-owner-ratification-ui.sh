#!/usr/bin/env bash
# Fixture-only acceptance for the canonical Owner Ratification UI and its exact decision protocol.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$REPO/scripts/lib/outcome-reconciler-release-dag.sh"
API="$REPO/src/apiserver"
WEB="$REPO/src/web"
BUILD="$REPO/build/owner-ratification-ui"
CONTAINER="${OWNER_RATIFICATION_UI_PG_CONTAINER:-owner-ratification-ui-pg16-$$}"
ADMIN="${OWNER_RATIFICATION_UI_PG_USER:-ratification_ui_admin}"
PASSWORD="${OWNER_RATIFICATION_UI_PG_PASSWORD:-ratification_ui_pw}"
DATABASE="${OWNER_RATIFICATION_UI_PG_DATABASE:-owner_ratification_ui_fixture}"
IMAGE="${OWNER_RATIFICATION_UI_PG_IMAGE:-postgres:16-alpine}"
TIMEOUT_SECONDS="${OWNER_RATIFICATION_UI_TIMEOUT:-600}"
API_TAP="$BUILD/api-integration.tap"
UNIT_TAP="$BUILD/api-unit.tap"
WEB_JSON="$BUILD/web-integration.json"
EVIDENCE="$BUILD/api-evidence.json"
MANIFEST="$REPO/build/outcome-reconciler-owner-ratification-ui-manifest.json"

cleanup() {
  if outcome_release_dag_db_enabled; then
    outcome_release_dag_drop_database
  else
    docker rm -fv "$CONTAINER" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

link_modules() {
  local destination="$1"
  local fallback="$2"
  if [ ! -e "$destination" ] && [ -d "$fallback" ]; then
    ln -s "$fallback" "$destination"
  fi
}

# Worktrees intentionally do not duplicate the dependency tree. Reuse the deployment checkout's
# immutable install when present; a standalone checkout with its own install needs no fallback.
link_modules "$REPO/node_modules" /root/orbit/node_modules
link_modules "$API/node_modules" /root/orbit/src/apiserver/node_modules
link_modules "$WEB/node_modules" /root/orbit/src/web/node_modules

NODE_PATH_PARTS=()
for candidate in "$API/node_modules" "$WEB/node_modules" "$REPO/node_modules" \
  /root/orbit/src/apiserver/node_modules /root/orbit/src/web/node_modules /root/orbit/node_modules; do
  [ -d "$candidate" ] && NODE_PATH_PARTS+=("$candidate")
done
[ "${#NODE_PATH_PARTS[@]}" -gt 0 ] || { echo '!! node dependencies are unavailable' >&2; exit 1; }
NODE_PATH_JOINED="$(IFS=:; echo "${NODE_PATH_PARTS[*]}")"
export NODE_PATH="$NODE_PATH_JOINED"
export PATH="$API/node_modules/.bin:$WEB/node_modules/.bin:$REPO/node_modules/.bin:$PATH"

PRISMA="$API/node_modules/.bin/prisma"
TSC="$API/node_modules/.bin/tsc"
VITEST="$WEB/node_modules/.bin/vitest"
[ -x "$VITEST" ] || VITEST="$REPO/node_modules/.bin/vitest"
[ -x "$PRISMA" ] || { echo '!! Prisma CLI is unavailable' >&2; exit 1; }
[ -x "$TSC" ] || { echo '!! TypeScript compiler is unavailable' >&2; exit 1; }
[ -x "$VITEST" ] || { echo '!! Vitest is unavailable' >&2; exit 1; }
command -v docker >/dev/null || { echo '!! docker is required for isolated PostgreSQL' >&2; exit 1; }
docker info >/dev/null 2>&1 || { echo '!! docker daemon is not reachable' >&2; exit 1; }

mkdir -p "$BUILD" "$(dirname "$MANIFEST")"

if [ "${OUTCOME_RELEASE_DAG_PREPARED_BUILD:-0}" = 1 ]; then
  outcome_release_dag_assert_build
  echo '==> owner-ratification-ui: use exact bound Shared/API/test/Web build'
else
  echo '==> owner-ratification-ui: compiling shared, API, tests and production Web bundle'
  npm run build -w @orbit/shared
  npm run build -w @orbit/apiserver
  "$TSC" -p "$API/tsconfig.test.json"
  npm run build -w @orbit/web
fi

if outcome_release_dag_db_enabled; then
  echo '==> owner-ratification-ui: clone the bound migrated PostgreSQL template'
  outcome_release_dag_bind_database
else
  echo '==> owner-ratification-ui: provisioning disposable PostgreSQL 16'
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
  echo '==> owner-ratification-ui: applying every migration to the disposable database'
  ( cd "$API" && DATABASE_URL="$URL" "$PRISMA" migrate deploy --schema prisma/schema.prisma >/dev/null )
  MIGRATIONS="$(docker exec "$CONTAINER" psql -U "$ADMIN" -d "$DATABASE" -tAc \
    'SELECT count(*) FROM _prisma_migrations WHERE finished_at IS NOT NULL' | tr -d '[:space:]')"
fi
echo "==> owner-ratification-ui: migrations=$MIGRATIONS system_identifier=$SYSTEM_ID"

echo '==> owner-ratification-ui: running real HTTP + PostgreSQL security/integration proofs'
set +e
DATABASE_URL="$URL" \
OWNER_RATIFICATION_UI_PG_URL="$URL" \
OWNER_RATIFICATION_UI_PG_EXPECTED_DATABASE="$DATABASE" \
OWNER_RATIFICATION_UI_PG_EXPECTED_USER="$ADMIN" \
OWNER_RATIFICATION_UI_PG_EXPECTED_SYSTEM_IDENTIFIER="$SYSTEM_ID" \
OWNER_RATIFICATION_UI_API_EVIDENCE_PATH="$EVIDENCE" \
timeout -k 20 "$TIMEOUT_SECONDS" node --test --test-concurrency=1 \
  "$REPO/test/owner-ratification-ui.api.test.mjs" 2>&1 | tee "$API_TAP"
API_RC=${PIPESTATUS[0]}
set -e
[ "$API_RC" -eq 0 ] || { echo "!! API integration failed rc=$API_RC" >&2; exit "$API_RC"; }

echo '==> owner-ratification-ui: running focused API route/projection unit proofs'
set +e
timeout -k 20 "$TIMEOUT_SECONDS" node --test \
  "$API/build/projects/project-owner-ratification-ui-api.spec.js" 2>&1 | tee "$UNIT_TAP"
UNIT_RC=${PIPESTATUS[0]}
set -e
[ "$UNIT_RC" -eq 0 ] || { echo "!! API unit tests failed rc=$UNIT_RC" >&2; exit "$UNIT_RC"; }

echo '==> owner-ratification-ui: running Web integration, keyboard and mobile proofs'
set +e
( cd "$WEB" && timeout -k 20 "$TIMEOUT_SECONDS" "$VITEST" run \
    src/pages/OwnerRatificationUi.test.tsx src/pages/JudgmentEntryPoints.test.tsx \
    --maxWorkers=1 --reporter=json --outputFile="$WEB_JSON" )
WEB_RC=$?
set -e
if [ "$WEB_RC" -ne 0 ]; then
  sed -n '1,240p' "$WEB_JSON" || true
  echo "!! Web integration failed rc=$WEB_RC" >&2
  exit "$WEB_RC"
fi

echo '==> owner-ratification-ui: validating skip=0 evidence and generating manifest'
node "$REPO/scripts/outcome-reconciler-owner-ratification-ui-manifest.mjs" \
  "$API_TAP" "$UNIT_TAP" "$WEB_JSON" "$EVIDENCE" "$MANIFEST"

echo '==> owner-ratification-ui: PASS'
