#!/usr/bin/env bash
# Full API acceptance: every compiled Node test, including every destructive PostgreSQL case,
# against one explicitly isolated PostgreSQL 16 server. Absence of the database or any skip fails.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
API="$REPO/src/apiserver"
BUILD="$REPO/build"
CONTAINER="orbit-release-api-pg-$$"
ADMIN="pccrf_admin"
PASSWORD="pccrf_password"
DATABASE="pccrf_frontier_template"
IMAGE="${OUTCOME_RELEASE_API_PG_IMAGE:-postgres:16-alpine}"
JOBS="${OUTCOME_RELEASE_API_JOBS:-4}"
TAP="$BUILD/outcome-reconciler-full-api.tap"
MANIFEST="$BUILD/outcome-reconciler-full-api-manifest.json"
STARTED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
CASE_DIR=''

cleanup() {
  docker rm -fv "$CONTAINER" >/dev/null 2>&1 || true
  if [ -n "$CASE_DIR" ] && [[ "$CASE_DIR" == "$BUILD"/outcome-reconciler-full-api-cases.* ]]; then
    rm -rf -- "$CASE_DIR"
  fi
}
trap cleanup EXIT

command -v docker >/dev/null || { echo 'docker is required for full API acceptance' >&2; exit 1; }
docker info >/dev/null 2>&1 || { echo 'docker daemon is unavailable' >&2; exit 1; }
[[ "$JOBS" =~ ^[1-8]$ ]] || { echo 'OUTCOME_RELEASE_API_JOBS must be an integer from 1 through 8' >&2; exit 1; }
mkdir -p "$BUILD"
CASE_DIR="$(mktemp -d "$BUILD/outcome-reconciler-full-api-cases.XXXXXX")"

echo '==> full-api: compile every API test'
( cd "$REPO" && node scripts/outcome-reconciler-isolated-prisma-schema.mjs \
  "$API/prisma/schema.prisma" \
  "$API/build/outcome-reconciler-prisma.schema.prisma" \
  "$API/build/node_modules/@prisma/client" )
( cd "$API" && ./node_modules/.bin/prisma format \
  --schema "$API/build/outcome-reconciler-prisma.schema.prisma" >/dev/null )
( cd "$API" && ./node_modules/.bin/prisma generate \
  --schema "$API/build/outcome-reconciler-prisma.schema.prisma" >/dev/null )
( cd "$API" && cmp -s \
  build/outcome-reconciler-prisma.schema.prisma \
  build/node_modules/@prisma/client/schema.prisma ) || {
  echo 'isolated Prisma Client schema does not match the candidate schema' >&2
  exit 1
}
( cd "$REPO" && npm run build -w @orbit/shared >/dev/null )
( cd "$API" && ./node_modules/.bin/tsc --build --clean tsconfig.outcome-reconciler.json )
( cd "$API" && ./node_modules/.bin/tsc -p tsconfig.outcome-reconciler.json )
# The checked-out worktree intentionally reuses /root/orbit/node_modules. Its workspace link for
# @orbit/shared therefore points at the deployed checkout, not this immutable candidate. Node
# searches build/node_modules before that shared dependency tree, so pin the runtime import to the
# package compiled immediately above. Without this, a clean candidate can compile correctly and
# then execute tests against an older codec/protocol implementation.
mkdir -p "$API/build/node_modules/@orbit"
ln -sfn "$REPO/src/shared" "$API/build/node_modules/@orbit/shared"

echo '==> full-api: provision disposable PostgreSQL 16'
docker run -d --name "$CONTAINER" \
  -e "POSTGRES_USER=$ADMIN" -e "POSTGRES_PASSWORD=$PASSWORD" -e POSTGRES_DB=postgres \
  "$IMAGE" >/dev/null
READY=0
for _ in $(seq 1 60); do
  if docker exec -e "PGPASSWORD=$PASSWORD" "$CONTAINER" \
    psql -h 127.0.0.1 -U "$ADMIN" -d postgres -tAc 'SELECT 1' >/dev/null 2>&1; then
    READY=1
    break
  fi
  sleep 1
done
[ "$READY" = 1 ] || { echo 'disposable PostgreSQL did not become ready' >&2; exit 1; }
docker exec "$CONTAINER" psql -U "$ADMIN" -d postgres -v ON_ERROR_STOP=1 \
  -c "CREATE DATABASE $DATABASE" >/dev/null
PG_HOST="$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' "$CONTAINER")"
[ -n "$PG_HOST" ] || { echo 'disposable PostgreSQL has no bridge address' >&2; exit 1; }
URL="postgresql://$ADMIN:$PASSWORD@$PG_HOST:5432/$DATABASE"
SYSTEM_ID="$(docker exec "$CONTAINER" psql -U "$ADMIN" -d postgres -tAc \
  'SELECT system_identifier FROM pg_control_system()' | tr -d '[:space:]')"
PG_VERSION="$(docker exec "$CONTAINER" psql -U "$ADMIN" -d postgres -tAc \
  'SHOW server_version' | tr -d '[:space:]')"

echo '==> full-api: deploy every migration'
( cd "$API" && DATABASE_URL="$URL" node node_modules/prisma/build/index.js \
  migrate deploy --schema prisma/schema.prisma >/dev/null )
MIGRATIONS="$(docker exec "$CONTAINER" psql -U "$ADMIN" -d "$DATABASE" -tAc \
  'SELECT count(*) FROM _prisma_migrations WHERE finished_at IS NOT NULL' | tr -d '[:space:]')"
REPOSITORY_MIGRATIONS="$(find "$API/prisma/migrations" -mindepth 1 -maxdepth 1 -type d | wc -l | tr -d '[:space:]')"
[ "$MIGRATIONS" = "$REPOSITORY_MIGRATIONS" ] || {
  echo "migration frontier mismatch applied=$MIGRATIONS repository=$REPOSITORY_MIGRATIONS" >&2
  exit 1
}
echo "==> full-api: postgres=$PG_VERSION migrations=$MIGRATIONS system_identifier=$SYSTEM_ID"

echo "==> full-api: run every API spec in isolated clones (parallelism=$JOBS)"
: > "$TAP"
mapfile -t SPECS < <(find "$API/build" -mindepth 2 -maxdepth 2 -type f -name '*.spec.js' | sort)
[ "${#SPECS[@]}" -gt 0 ] || { echo 'no compiled API specs found' >&2; exit 1; }
if [ -n "${OUTCOME_RELEASE_API_SPEC_REGEX:-}" ]; then
  mapfile -t SPECS < <(printf '%s\n' "${SPECS[@]}" | grep -E "$OUTCOME_RELEASE_API_SPEC_REGEX")
  [ "${#SPECS[@]}" -gt 0 ] || { echo 'API spec regex selected no files' >&2; exit 1; }
fi

export OUTCOME_API_CASE_CONTAINER="$CONTAINER"
export OUTCOME_API_CASE_ADMIN="$ADMIN"
export OUTCOME_API_CASE_PASSWORD="$PASSWORD"
export OUTCOME_API_CASE_HOST="$PG_HOST"
export OUTCOME_API_CASE_SYSTEM_ID="$SYSTEM_ID"
export OUTCOME_API_CASE_REPO="$REPO"
export OUTCOME_API_CASE_API="$API"
export OUTCOME_API_CASE_DIR="$CASE_DIR"
export OUTCOME_API_CASE_TOTAL="${#SPECS[@]}"

PARALLEL_INPUT=()
SERIAL_INPUT=()
INDEX=0
for SPEC in "${SPECS[@]}"; do
  INDEX=$((INDEX + 1))
  if [[ "$SPEC" =~ (task-(dispatch-epoch-aba|run-winner-recovery|completion-evidence)|judgment-delivery)\.pg\.spec\.js$ ]]; then
    SERIAL_INPUT+=("$INDEX" "$SPEC")
  else
    PARALLEL_INPUT+=("$INDEX" "$SPEC")
  fi
done

TEST_RC=0
if [ "${#PARALLEL_INPUT[@]}" -gt 0 ]; then
  set +e
  printf '%s\0' "${PARALLEL_INPUT[@]}" | \
    xargs -0 -r -n 2 -P "$JOBS" "$REPO/scripts/outcome-reconciler-full-api-case.sh"
  PARALLEL_RC=${PIPESTATUS[1]}
  set -e
  [ "$PARALLEL_RC" = 0 ] || TEST_RC=1
fi

for ((OFFSET = 0; OFFSET < ${#SERIAL_INPUT[@]}; OFFSET += 2)); do
  if ! "$REPO/scripts/outcome-reconciler-full-api-case.sh" \
    "${SERIAL_INPUT[$OFFSET]}" "${SERIAL_INPUT[$((OFFSET + 1))]}"; then
    TEST_RC=1
  fi
done

for ((INDEX = 1; INDEX <= ${#SPECS[@]}; INDEX += 1)); do
  CASE_LOG="$CASE_DIR/$(printf '%04d' "$INDEX").tap"
  [ -f "$CASE_LOG" ] || { echo "full API case $INDEX produced no TAP log" >&2; TEST_RC=1; continue; }
  cat "$CASE_LOG" >> "$TAP"
done
[ "$TEST_RC" = 0 ] || { echo 'full API acceptance failed' >&2; exit "$TEST_RC"; }
if [ -n "${OUTCOME_RELEASE_API_SPEC_REGEX:-}" ]; then
  echo '==> full-api: selected diagnostic specs passed'
  exit 0
fi

echo '==> full-api: validate zero-skip result and publish manifest'
OUTCOME_FULL_API_STARTED_AT="$STARTED_AT" \
OUTCOME_FULL_API_PG_VERSION="$PG_VERSION" \
OUTCOME_FULL_API_MIGRATIONS="$MIGRATIONS" \
OUTCOME_FULL_API_SYSTEM_IDENTIFIER="$SYSTEM_ID" \
node "$REPO/scripts/outcome-reconciler-full-api-manifest.mjs" "$TAP" "$MANIFEST"
