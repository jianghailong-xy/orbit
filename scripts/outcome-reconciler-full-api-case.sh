#!/usr/bin/env bash
set -euo pipefail

[ "$#" = 2 ] || { echo 'usage: full-api-case INDEX SPEC' >&2; exit 2; }
: "${OUTCOME_API_CASE_CONTAINER:?}"
: "${OUTCOME_API_CASE_ADMIN:?}"
: "${OUTCOME_API_CASE_PASSWORD:?}"
: "${OUTCOME_API_CASE_HOST:?}"
: "${OUTCOME_API_CASE_PORT:?}"
: "${OUTCOME_API_CASE_SYSTEM_ID:?}"
: "${OUTCOME_API_CASE_REPO:?}"
: "${OUTCOME_API_CASE_API:?}"
: "${OUTCOME_API_CASE_DIR:?}"
: "${OUTCOME_API_CASE_TOTAL:?}"
: "${OUTCOME_API_CASE_TEMPLATE:=pccrf_frontier_template}"
: "${OUTCOME_API_CASE_PREFIX:=pccrf}"

[[ "$OUTCOME_API_CASE_TEMPLATE" =~ ^[a-zA-Z_][a-zA-Z0-9_]*$ ]] || {
  echo 'OUTCOME_API_CASE_TEMPLATE must be a PostgreSQL identifier' >&2
  exit 2
}
[[ "$OUTCOME_API_CASE_PREFIX" =~ ^[a-zA-Z_][a-zA-Z0-9_]*$ ]] || {
  echo 'OUTCOME_API_CASE_PREFIX must be a PostgreSQL identifier prefix' >&2
  exit 2
}

INDEX="$1"
SPEC="$2"
CONTAINER="$OUTCOME_API_CASE_CONTAINER"
ADMIN="$OUTCOME_API_CASE_ADMIN"
PASSWORD="$OUTCOME_API_CASE_PASSWORD"
PG_HOST="$OUTCOME_API_CASE_HOST"
PG_PORT="$OUTCOME_API_CASE_PORT"
SYSTEM_ID="$OUTCOME_API_CASE_SYSTEM_ID"
REPO="$OUTCOME_API_CASE_REPO"
API="$OUTCOME_API_CASE_API"
CASE_DB="${OUTCOME_API_CASE_PREFIX}_case_$(printf '%04d' "$INDEX")"
EMPTY_DB="${OUTCOME_API_CASE_PREFIX}_empty_$(printf '%04d' "$INDEX")"
RELATIVE_SPEC="${SPEC#"$API"/}"
LOG="$OUTCOME_API_CASE_DIR/$(printf '%04d' "$INDEX").tap"
DATABASES_CREATED=0

cleanup_case() {
  if [ "$DATABASES_CREATED" = 1 ]; then
    docker exec "$CONTAINER" psql -U "$ADMIN" -d postgres -v ON_ERROR_STOP=1 \
      -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname IN ('$CASE_DB', '$EMPTY_DB') AND pid <> pg_backend_pid()" >/dev/null 2>&1 || true
    docker exec "$CONTAINER" psql -U "$ADMIN" -d postgres -v ON_ERROR_STOP=1 \
      -c "DROP DATABASE IF EXISTS \"$CASE_DB\"" >/dev/null 2>&1 || true
    docker exec "$CONTAINER" psql -U "$ADMIN" -d postgres -v ON_ERROR_STOP=1 \
      -c "DROP DATABASE IF EXISTS \"$EMPTY_DB\"" >/dev/null 2>&1 || true
  fi
}
trap cleanup_case EXIT

echo "==> full-api [$INDEX/$OUTCOME_API_CASE_TOTAL]: $RELATIVE_SPEC"
docker exec "$CONTAINER" psql -U "$ADMIN" -d postgres -v ON_ERROR_STOP=1 \
  -c "CREATE DATABASE \"$CASE_DB\" TEMPLATE \"$OUTCOME_API_CASE_TEMPLATE\"" >/dev/null
docker exec "$CONTAINER" psql -U "$ADMIN" -d postgres -v ON_ERROR_STOP=1 \
  -c "CREATE DATABASE \"$EMPTY_DB\" TEMPLATE template0" >/dev/null
DATABASES_CREATED=1

CASE_URL="postgresql://$ADMIN:$PASSWORD@$PG_HOST:$PG_PORT/$CASE_DB"
EMPTY_URL="postgresql://$ADMIN:$PASSWORD@$PG_HOST:$PG_PORT/$EMPTY_DB"
CONFLICT_ORIGIN=service
[[ "$RELATIVE_SPEC" == *.pg.spec.js ]] && CONFLICT_ORIGIN=fault_injection

set +e
(
  cd "$API"
  DATABASE_URL="$CASE_URL" \
  COORDINATOR_PG_URL="$CASE_URL" \
  WORK_OVERVIEW_PG_URL="$CASE_URL" \
  ORBIT_TEST_PG_URL="$EMPTY_URL" \
  COORDINATOR_PG_EXPECTED_DATABASE="$CASE_DB" \
  COORDINATOR_PG_EXPECTED_USER="$ADMIN" \
  COORDINATOR_PG_EXPECTED_SYSTEM_IDENTIFIER="$SYSTEM_ID" \
  COORDINATOR_PG_RESTART_COMMAND="$REPO/scripts/outcome-reconciler-restart-postgres.sh $CONTAINER $ADMIN $PASSWORD $CASE_DB" \
  ORBIT_DB_CONFLICT_ORIGIN="$CONFLICT_ORIGIN" \
  PROVIDER_SECRET_KEY=release-frontier-test-key \
  JWT_SECRET=release-frontier-test-jwt \
  timeout -k 20 360 node --test --test-concurrency=1 --test-reporter=tap "$SPEC"
) >"$LOG" 2>&1
SPEC_RC=$?
set -e

if [ "$SPEC_RC" != 0 ]; then
  echo "==> full-api FAILED [$INDEX/$OUTCOME_API_CASE_TOTAL]: $RELATIVE_SPEC" >&2
  sed -n '/^not ok/,$p' "$LOG" >&2
  exit "$SPEC_RC"
fi
echo "==> full-api PASS [$INDEX/$OUTCOME_API_CASE_TOTAL]: $RELATIVE_SPEC"
