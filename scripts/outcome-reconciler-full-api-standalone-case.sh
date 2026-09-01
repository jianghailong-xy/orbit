#!/usr/bin/env bash
# One Full API spec, in a database and role that exist only for it.
#
# This is the standalone acceptance's case runner. Its sibling
# outcome-reconciler-full-api-case.sh belongs to the Release DAG and stamps each case with that
# run's binding and attempt; a standalone run has neither, and inventing them would put a release
# binding's name on a receipt no release produced. So this one keeps every property the acceptance
# actually asserts -- a unique pcc* identity per case, that identity verified before the spec may
# mutate anything, a TAP log that reported at least one test and skipped none, and a cleanup that
# is checked rather than assumed -- and records them under its own kind.
set -euo pipefail

[ "$#" = 2 ] || { echo 'usage: full-api-standalone-case INDEX SPEC' >&2; exit 2; }
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
: "${OUTCOME_API_CASE_TEMPLATE:?}"
: "${OUTCOME_API_CASE_PREFIX:=pccrf}"
: "${OUTCOME_API_CASE_TIMEOUT:=360}"

[[ "$OUTCOME_API_CASE_PREFIX" =~ ^pcc[0-9a-z]*$ ]] || {
  echo 'OUTCOME_API_CASE_PREFIX must be a pcc* identifier prefix' >&2
  exit 2
}
[[ "$OUTCOME_API_CASE_TEMPLATE" =~ ^pcc[0-9a-z]*_[a-z0-9_]+$ ]] || {
  echo 'OUTCOME_API_CASE_TEMPLATE must be a dedicated pcc_* template database' >&2
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
STEM="${OUTCOME_API_CASE_PREFIX}_c$(printf '%04d' "$INDEX")"
CASE_DB="${STEM}_d"
EMPTY_DB="${STEM}_e"
CASE_ROLE="${STEM}_u"
for IDENTITY in "$CASE_DB" "$EMPTY_DB" "$CASE_ROLE"; do
  [[ "$IDENTITY" =~ ^pcc[0-9a-z]*_[a-z0-9_]+$ ]] || {
    echo 'destructive specs require a dedicated pcc_* database and role' >&2
    exit 2
  }
done

RELATIVE_SPEC="${SPEC#"$API"/}"
LOG="$OUTCOME_API_CASE_DIR/$(printf '%04d' "$INDEX").tap"
RECEIPT="$OUTCOME_API_CASE_DIR/$(printf '%04d' "$INDEX").json"
ROLE_CREATED=0
CASE_CREATED=0
EMPTY_CREATED=0
IDENTITY_DATABASE=''
IDENTITY_ROLE=''
IDENTITY_SYSTEM=''

psql_admin() {
  docker exec "$CONTAINER" psql -U "$ADMIN" -d postgres -v ON_ERROR_STOP=1 "$@"
}

cleanup_case() {
  local original_rc="$1"
  local cleanup_rc=0 receipt_rc=0 leftovers='unknown'
  trap - EXIT
  set +e
  if [ "$CASE_CREATED" = 1 ] || [ "$EMPTY_CREATED" = 1 ]; then
    psql_admin -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname IN ('$CASE_DB', '$EMPTY_DB') AND pid <> pg_backend_pid()" >/dev/null 2>&1
    psql_admin -c "DROP DATABASE IF EXISTS \"$CASE_DB\"" >/dev/null 2>&1 || cleanup_rc=1
    psql_admin -c "DROP DATABASE IF EXISTS \"$EMPTY_DB\"" >/dev/null 2>&1 || cleanup_rc=1
  fi
  if [ "$ROLE_CREATED" = 1 ]; then
    psql_admin -c "DROP ROLE IF EXISTS \"$CASE_ROLE\"" >/dev/null 2>&1 || cleanup_rc=1
  fi
  # Asked of the server rather than inferred from the DROPs succeeding: a database still held open
  # by a backend the terminate missed survives its own DROP without reporting one.
  leftovers="$(docker exec "$CONTAINER" psql -U "$ADMIN" -d postgres -At -v ON_ERROR_STOP=1 \
    -c "SELECT (SELECT count(*) FROM pg_database WHERE datname IN ('$CASE_DB','$EMPTY_DB')) + (SELECT count(*) FROM pg_roles WHERE rolname='$CASE_ROLE')" \
    2>/dev/null)" || cleanup_rc=1
  [ "$leftovers" = 0 ] || cleanup_rc=1

  if [ -s "$LOG" ]; then
    node "$REPO/scripts/outcome-reconciler-full-api-standalone-receipt.mjs" \
      "$RECEIPT" "$INDEX" "$SPEC" "$CASE_DB" "$EMPTY_DB" "$CASE_ROLE" \
      "$IDENTITY_DATABASE" "$IDENTITY_ROLE" "$IDENTITY_SYSTEM" \
      "$LOG" "$original_rc" "$cleanup_rc" || receipt_rc=1
  elif [ "$original_rc" = 0 ]; then
    receipt_rc=1
  fi
  set -e
  if [ "$original_rc" != 0 ]; then exit "$original_rc"; fi
  if [ "$cleanup_rc" != 0 ] || [ "$receipt_rc" != 0 ]; then exit 70; fi
  exit 0
}
trap 'cleanup_case $?' EXIT

echo "==> full-api [$INDEX/$OUTCOME_API_CASE_TOTAL]: $RELATIVE_SPEC database=$CASE_DB role=$CASE_ROLE"
psql_admin -c "DROP DATABASE IF EXISTS \"$CASE_DB\"" >/dev/null
psql_admin -c "DROP DATABASE IF EXISTS \"$EMPTY_DB\"" >/dev/null
psql_admin -c "DROP ROLE IF EXISTS \"$CASE_ROLE\"" >/dev/null
psql_admin -c "CREATE ROLE \"$CASE_ROLE\" LOGIN SUPERUSER PASSWORD '$PASSWORD'" >/dev/null
ROLE_CREATED=1
psql_admin -c "CREATE DATABASE \"$CASE_DB\" WITH TEMPLATE \"$OUTCOME_API_CASE_TEMPLATE\" OWNER \"$CASE_ROLE\"" >/dev/null
CASE_CREATED=1
psql_admin -c "CREATE DATABASE \"$EMPTY_DB\" WITH TEMPLATE template0 OWNER \"$CASE_ROLE\"" >/dev/null
EMPTY_CREATED=1

# Read back through the case role itself, before the spec runs. A spec that truncates has to be
# proved to be truncating its own database, and only the server can settle that.
IFS=$'\t' read -r IDENTITY_DATABASE IDENTITY_ROLE IDENTITY_SYSTEM < <(
  docker exec -e "PGPASSWORD=$PASSWORD" "$CONTAINER" \
    psql -h 127.0.0.1 -U "$CASE_ROLE" -d "$CASE_DB" -X -At -F $'\t' -v ON_ERROR_STOP=1 \
    -c "SELECT current_database(), current_user, system_identifier::text FROM pg_control_system()"
)
[ "$IDENTITY_DATABASE" = "$CASE_DB" ]
[ "$IDENTITY_ROLE" = "$CASE_ROLE" ]
[ "$IDENTITY_SYSTEM" = "$SYSTEM_ID" ]

CASE_URL="postgresql://$CASE_ROLE:$PASSWORD@$PG_HOST:$PG_PORT/$CASE_DB"
EMPTY_URL="postgresql://$CASE_ROLE:$PASSWORD@$PG_HOST:$PG_PORT/$EMPTY_DB"
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
  COORDINATOR_PG_EXPECTED_USER="$CASE_ROLE" \
  COORDINATOR_PG_EXPECTED_SYSTEM_IDENTIFIER="$SYSTEM_ID" \
  COORDINATOR_PG_RESTART_COMMAND="$REPO/scripts/outcome-reconciler-restart-postgres.sh $CONTAINER $CASE_ROLE $PASSWORD $CASE_DB" \
  ORBIT_DB_CONFLICT_ORIGIN="$CONFLICT_ORIGIN" \
  PROVIDER_SECRET_KEY=release-frontier-test-key \
  JWT_SECRET=release-frontier-test-jwt \
  timeout -k 20 "$OUTCOME_API_CASE_TIMEOUT" node --test --test-concurrency=1 --test-reporter=tap "$SPEC"
) >"$LOG" 2>&1
SPEC_RC=$?
set -e

if [ "$SPEC_RC" != 0 ]; then
  echo "==> full-api FAILED [$INDEX/$OUTCOME_API_CASE_TOTAL]: $RELATIVE_SPEC" >&2
  sed -n '/^not ok/,$p' "$LOG" >&2
  exit "$SPEC_RC"
fi
echo "==> full-api PASS [$INDEX/$OUTCOME_API_CASE_TOTAL]: $RELATIVE_SPEC"
