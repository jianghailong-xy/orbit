#!/usr/bin/env bash
# Isolated acceptance for active-vs-audit-only Owner Ratification routing.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$REPO/scripts/lib/outcome-reconciler-release-dag.sh"
API="$REPO/src/apiserver"
WEB="$REPO/src/web"
BUILD="$REPO/build/owner-ratification-inbox-routing"
CONTAINER="${OWNER_RATIFICATION_ROUTING_PG_CONTAINER:-owner-ratification-routing-pg16-$$}"
ADMIN="${OWNER_RATIFICATION_ROUTING_PG_USER:-ratification_routing_admin}"
PASSWORD="${OWNER_RATIFICATION_ROUTING_PG_PASSWORD:-ratification_routing_pw}"
DATABASE="${OWNER_RATIFICATION_ROUTING_PG_DATABASE:-owner_ratification_routing_fixture}"
IMAGE="${OWNER_RATIFICATION_ROUTING_PG_IMAGE:-postgres:16-alpine}"
TIMEOUT_SECONDS="${OWNER_RATIFICATION_ROUTING_TIMEOUT:-600}"
API_TAP="$BUILD/api-integration.tap"
WEB_JSON="$BUILD/web-integration.json"
EVIDENCE="$BUILD/api-evidence.json"
FIXTURE="$BUILD/seeded-fixtures.json"
MANIFEST="$REPO/build/outcome-reconciler-owner-ratification-inbox-routing-manifest.json"
MIGRATION_STAGE=''
API_SHARED_LINK="$API/src/node_modules/@orbit/shared"
API_SHARED_LINK_CREATED=0

cleanup() {
  if outcome_release_dag_db_enabled; then
    outcome_release_dag_drop_database
  else
    docker rm -fv "$CONTAINER" >/dev/null 2>&1 || true
  fi
  if [ -n "$MIGRATION_STAGE" ] && [ -d "$MIGRATION_STAGE" ]; then
    rm -rf -- "$MIGRATION_STAGE"
  fi
  if [ "$API_SHARED_LINK_CREATED" -eq 1 ]; then
    rm -f -- "$API_SHARED_LINK"
    rmdir "$API/src/node_modules/@orbit" "$API/src/node_modules" 2>/dev/null || true
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

link_modules "$REPO/node_modules" /root/orbit/node_modules
link_modules "$API/node_modules" /root/orbit/src/apiserver/node_modules
link_modules "$WEB/node_modules" /root/orbit/src/web/node_modules

# A retained worktree can borrow dependency binaries from /root/orbit while its workspace package
# symlink still resolves to that checkout's stale dist. Put the current shared package closer to
# API sources so TypeScript always compiles against this worktree, without rewriting the fallback.
EXPECTED_SHARED="$(readlink -f "$REPO/src/shared")"
if [ -e "$API_SHARED_LINK" ] || [ -L "$API_SHARED_LINK" ]; then
  [ "$(readlink -f "$API_SHARED_LINK")" = "$EXPECTED_SHARED" ] || {
    echo "!! $API_SHARED_LINK does not resolve to the current workspace shared package" >&2
    exit 1
  }
else
  mkdir -p "$(dirname "$API_SHARED_LINK")"
  ln -s "$EXPECTED_SHARED" "$API_SHARED_LINK"
  API_SHARED_LINK_CREATED=1
fi

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
VITEST="$WEB/node_modules/.bin/vitest"
[ -x "$VITEST" ] || VITEST="$REPO/node_modules/.bin/vitest"
[ -x "$PRISMA" ] || { echo '!! Prisma CLI is unavailable' >&2; exit 1; }
[ -x "$VITEST" ] || { echo '!! Vitest is unavailable' >&2; exit 1; }
command -v docker >/dev/null || { echo '!! docker is required for isolated PostgreSQL' >&2; exit 1; }
docker info >/dev/null 2>&1 || { echo '!! docker daemon is not reachable' >&2; exit 1; }

mkdir -p "$BUILD" "$(dirname "$MANIFEST")"

if [ "${OUTCOME_RELEASE_DAG_PREPARED_BUILD:-0}" = 1 ]; then
  outcome_release_dag_assert_build
  echo '==> owner-ratification-inbox-routing: use exact bound Shared/API/Web build'
else
  echo '==> owner-ratification-inbox-routing: compiling shared, API and Web'
  npm run build -w @orbit/shared
  npm run build -w @orbit/apiserver
  npm run build -w @orbit/web
fi

if outcome_release_dag_db_enabled; then
  echo '==> owner-ratification-inbox-routing: clone the bound pre-0210 template'
  outcome_release_dag_bind_database
else
  echo '==> owner-ratification-inbox-routing: provisioning disposable PostgreSQL 16'
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
  echo '==> owner-ratification-inbox-routing: applying migrations through 0209'
  MIGRATION_STAGE="$(mktemp -d "$BUILD/prisma-before-owner-routing.XXXXXX")"
  cp -R "$API/prisma" "$MIGRATION_STAGE/prisma"
  cp "$API/prisma.config.ts" "$MIGRATION_STAGE/prisma.config.ts"
  rm -rf -- "$MIGRATION_STAGE/prisma/migrations/0210_owner_ratification_inbox_eligibility"
  ( cd "$MIGRATION_STAGE" && DATABASE_URL="$URL" "$PRISMA" migrate deploy \
      --config prisma.config.ts >/dev/null )
fi

echo '==> owner-ratification-inbox-routing: seeding the same legacy batch before 0210'
DATABASE_URL="$URL" \
OWNER_RATIFICATION_ROUTING_PG_URL="$URL" \
OWNER_RATIFICATION_ROUTING_PG_EXPECTED_DATABASE="$DATABASE" \
OWNER_RATIFICATION_ROUTING_PG_EXPECTED_SYSTEM_IDENTIFIER="$SYSTEM_ID" \
OWNER_RATIFICATION_ROUTING_FIXTURE_PATH="$FIXTURE" \
node "$REPO/test/owner-ratification-inbox-routing.seed.mjs"

echo '==> owner-ratification-inbox-routing: applying the real 0210 routing migration'
( cd "$API" && DATABASE_URL="$URL" "$PRISMA" migrate deploy --schema prisma/schema.prisma >/dev/null )
MIGRATIONS="$(docker exec "$CONTAINER" psql -U "$ADMIN" -d "$DATABASE" -tAc \
  'SELECT count(*) FROM _prisma_migrations WHERE finished_at IS NOT NULL' | tr -d '[:space:]')"
echo "==> owner-ratification-inbox-routing: migrations=$MIGRATIONS system_identifier=$SYSTEM_ID"

echo '==> owner-ratification-inbox-routing: running batch migration, HTTP and projection proofs'
set +e
DATABASE_URL="$URL" \
OWNER_RATIFICATION_ROUTING_PG_URL="$URL" \
OWNER_RATIFICATION_ROUTING_PG_EXPECTED_DATABASE="$DATABASE" \
OWNER_RATIFICATION_ROUTING_PG_EXPECTED_USER="$ADMIN" \
OWNER_RATIFICATION_ROUTING_PG_EXPECTED_SYSTEM_IDENTIFIER="$SYSTEM_ID" \
OWNER_RATIFICATION_ROUTING_EVIDENCE_PATH="$EVIDENCE" \
OWNER_RATIFICATION_ROUTING_FIXTURE_PATH="$FIXTURE" \
timeout -k 20 "$TIMEOUT_SECONDS" node --test --test-concurrency=1 \
  "$REPO/test/owner-ratification-inbox-routing.api.test.mjs" 2>&1 | tee "$API_TAP"
API_RC=${PIPESTATUS[0]}
set -e
[ "$API_RC" -eq 0 ] || { echo "!! API routing integration failed rc=$API_RC" >&2; exit "$API_RC"; }

echo '==> owner-ratification-inbox-routing: running active CTA and mixed-version Web proofs'
set +e
( cd "$WEB" && timeout -k 20 "$TIMEOUT_SECONDS" "$VITEST" run \
    src/pages/OwnerRatificationUi.test.tsx --maxWorkers=1 \
    --reporter=json --outputFile="$WEB_JSON" )
WEB_RC=$?
set -e
if [ "$WEB_RC" -ne 0 ]; then
  sed -n '1,240p' "$WEB_JSON" || true
  echo "!! Web routing integration failed rc=$WEB_RC" >&2
  exit "$WEB_RC"
fi

echo '==> owner-ratification-inbox-routing: validating skip=0 evidence and manifest'
node "$REPO/scripts/outcome-reconciler-owner-ratification-inbox-routing-manifest.mjs" \
  "$API_TAP" "$WEB_JSON" "$EVIDENCE" "$MANIFEST"

echo '==> owner-ratification-inbox-routing: PASS (skip=0)'
