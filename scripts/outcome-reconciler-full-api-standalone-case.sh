#!/usr/bin/env bash
# One Full API spec, in a database and role that exist only for it.
#
# This is the standalone acceptance's case runner. Its sibling
# outcome-reconciler-full-api-case.sh belongs to the Release DAG and stamps each case with that
# run's binding and attempt; a standalone run has neither, and inventing them would put a release
# binding's name on a receipt no release produced. So this one keeps every property the acceptance
# actually asserts -- a unique pcc* identity per case, that identity verified before the spec may
# mutate anything, a TAP log that reported at least one test and skipped none, a cleanup that is
# checked rather than assumed, and how the case ended when it did not pass -- and records them
# under its own kind.
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
: "${OUTCOME_API_CASE_TAIL_LINES:=40}"

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
TAIL_LINES="$OUTCOME_API_CASE_TAIL_LINES"
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
SPEC_RC=0
SPEC_ELAPSED=0

psql_admin() {
  docker exec "$CONTAINER" psql -U "$ADMIN" -d postgres -v ON_ERROR_STOP=1 "$@"
}

# How the case ended, named rather than left as a bare number. "Non-zero" arrives for four
# different facts and they are not the same news: the wall clock ran out (`timeout` reports its
# own 124), the process was killed by a signal (`timeout` reports 128+N, which is what an
# out-of-memory kill looks like from here), the case died before it could report a single TAP
# line, or the spec ran and reported a failing test. The first three all leave a log with no
# `not ok` in it, so only the exit code can tell them apart.
case_kind() {
  local rc="$1"
  if [ "$rc" = 0 ]; then echo COMPLETED; return; fi
  if [ "$rc" = 124 ]; then echo TIMED_OUT; return; fi
  if [ "$rc" -gt 128 ]; then echo SIGNALED; return; fi
  if grep -q '^not ok' "$LOG" 2>/dev/null; then echo SPEC_FAILED; return; fi
  echo CRASHED_BEFORE_TAP
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

  # An empty log is itself a fact worth recording, so the receipt is written whenever the spec was
  # actually launched -- which is exactly when the identity read-back below has run. A case killed
  # before it printed one byte used to leave no receipt at all.
  if [ -s "$LOG" ] || [ -n "$IDENTITY_DATABASE" ]; then
    node "$REPO/scripts/outcome-reconciler-full-api-standalone-receipt.mjs" \
      "$RECEIPT" "$INDEX" "$SPEC" "$CASE_DB" "$EMPTY_DB" "$CASE_ROLE" \
      "$IDENTITY_DATABASE" "$IDENTITY_ROLE" "$IDENTITY_SYSTEM" \
      "$LOG" "$original_rc" "$cleanup_rc" \
      "$(case_kind "$original_rc")" "$SPEC_ELAPSED" "$OUTCOME_API_CASE_TIMEOUT" || receipt_rc=1
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

CASE_STARTED_AT="$(date +%s)"
set +e
(
  cd "$API"
  # node:test tells a child runner, through the environment, to report to a parent that is
  # listening. Whoever launched this script may itself be a test -- the case-runner diagnostics
  # are, and so is anything that drives acceptance from a spec -- and the inherited context makes
  # the runner below report into a channel nobody is reading: empty stdout, exit 0, a case that
  # tested nothing and said it passed. The variables are dropped here rather than at each call
  # site so no caller has to remember.
  for NAME in "${!NODE_TEST_@}"; do unset "$NAME"; done
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
SPEC_ELAPSED=$(( $(date +%s) - CASE_STARTED_AT ))
SPEC_KIND="$(case_kind "$SPEC_RC")"

if [ "$SPEC_RC" != 0 ]; then
  echo "==> full-api FAILED [$INDEX/$OUTCOME_API_CASE_TOTAL]: $RELATIVE_SPEC $SPEC_KIND exit=$SPEC_RC elapsed=${SPEC_ELAPSED}s timeout=$OUTCOME_API_CASE_TIMEOUT" >&2
  if [ -n "${OUTCOME_API_CASE_FAILURE_LOG:-}" ]; then
    # Written the moment this case ends rather than when the run does. The run keeps going -- the
    # point of a full run is the whole list of failures, not the first one -- but waiting until the
    # end to say anything is what made a case that died in three seconds arrive twenty minutes
    # later. One short line, appended: under PIPE_BUF that is atomic, so the parallel workers
    # cannot interleave halves of two failures.
    printf '%s [%s/%s] %s %s exit=%s elapsed=%ss\n' \
      "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$INDEX" "$OUTCOME_API_CASE_TOTAL" "$SPEC_KIND" \
      "$RELATIVE_SPEC" "$SPEC_RC" "$SPEC_ELAPSED" >> "$OUTCOME_API_CASE_FAILURE_LOG"
  fi
  if grep -q '^not ok' "$LOG"; then
    sed -n '/^not ok/,$p' "$LOG" >&2
  else
    # The case died before it produced a single `not ok`, so the sed above printed nothing at all.
    # That is how one acceptance run reported nineteen reds without one word of why. Whatever the
    # case did manage to write is the only evidence left, so print the end of it, and state the
    # three numbers that separate "it ran out of time" from "it broke".
    echo "==> full-api NO TAP [$INDEX/$OUTCOME_API_CASE_TOTAL]: $RELATIVE_SPEC: last ${TAIL_LINES} lines of $LOG" >&2
    tail -n "$TAIL_LINES" "$LOG" >&2
    echo "exit=$SPEC_RC elapsed=${SPEC_ELAPSED}s timeout=$OUTCOME_API_CASE_TIMEOUT kind=$SPEC_KIND" >&2
  fi
  exit "$SPEC_RC"
fi
echo "==> full-api PASS [$INDEX/$OUTCOME_API_CASE_TOTAL]: $RELATIVE_SPEC"
