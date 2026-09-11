#!/usr/bin/env bash
# The Codex rate-limit reset operation — admission, both idempotency layers and its persisted state
# (docs/codex-rate-limit-reset-contract.md §5–§7, §9.3) — witnessed against disposable PostgreSQL.
#
#   bash scripts/test-codex-reset-operation.sh
#
# RED on any failure and on any skip. Three phases, each run even when an earlier one went red, so one
# run reports everything that is wrong:
#
#   1. BEHAVIOUR. `scripts/run-pg-spec.sh` on src/apiserver/src/runners/codex-rate-limit-reset.pg.spec.ts:
#      its own PostgreSQL, the whole test tree compiled, and a non-zero exit on a single skip. The spec
#      drives the real routes over HTTP against the real schema: concurrent POSTs of one request id and
#      of many, a client that gives up before the response and retries, owner / runner / account scope,
#      every admission refusal in the contract's order ending in the same request succeeding, the
#      provider key absent from every body, both checkpoints persisted apart, and illegal or backward
#      moves refused by the repository and by the database, including under concurrent transactions.
#   2. THE MIGRATION, FORWARD AND BACK, on a second disposable PostgreSQL. A schema is compared as the
#      text of `pg_dump --schema-only`. Rolled back with down.sql, a database migrated to 0255 must be
#      identical to one migrated only to 0254 — and must differ from it before the rollback, which is
#      the control that the comparison can see 0255 at all. Rolled forward again by
#      `prisma migrate deploy`, after deleting the ledger row as down.sql says to, it must be identical
#      to the 0255 database again. Both scripts also run a second time on top of themselves, and the
#      rollback runs over rows.
#   3. THE OLD RUNNER PATHS. The heartbeat specs whose runners send none of the new fields, unchanged.
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
API="$REPO/src/apiserver"
UNIT=0255_codex_rate_limit_reset_operation
SPEC=src/apiserver/src/runners/codex-rate-limit-reset.pg.spec.ts
# The reporter a `node --test` child is pinned to, and the parser that decides whether its summary can
# be believed; shared with run-pg-spec.sh.
# shellcheck source=scripts/pg-matrix-summary.lib.sh
. "$REPO/scripts/pg-matrix-summary.lib.sh" || exit 2

RED=()
red() { RED+=("$*"); echo "RED: $*"; }

WORK="$(mktemp -d -t codex-reset-operation.XXXXXX)"
CONTAINER="pccreset-pg-$$-$RANDOM"   # never a fixed name: sibling sessions run their own
ADMIN=pccreset_
PASSWORD=pccreset_pw
PORT=
cleanup() {
  docker rm -f -v "$CONTAINER" >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT INT TERM

# --- 1. behaviour -------------------------------------------------------------------------------
echo "########## 1. behaviour: $SPEC ##########"
bash "$REPO/scripts/run-pg-spec.sh" "$SPEC" 2>&1 | tee "$WORK/spec.log"
rc=${PIPESTATUS[0]}
[ "$rc" = 0 ] || red "run-pg-spec.sh exited $rc"
# run-pg-spec.sh already refuses a skip. The counts are read back anyway so that the last lines of this
# run say how many cases were witnessed, not only that nothing complained.
line="$(grep -E '^==== codex-rate-limit-reset\.pg\.spec\.ts ' "$WORK/spec.log" | tail -1)"
tests="$(sed -n 's/.* tests=\([0-9]*\) .*/\1/p' <<<"$line")"
failed="$(sed -n 's/.* fail=\([0-9]*\) .*/\1/p' <<<"$line")"
skipped="$(sed -n 's/.* skipped=\([0-9]*\).*/\1/p' <<<"$line")"
if [ -z "$tests" ] || [ "$tests" = 0 ] || [ "$failed" != 0 ] || [ "$skipped" != 0 ]; then
  red "the spec's summary is not a clean witness: '${line:-no summary line}'"
fi

# --- 2. the migration, forward and back ---------------------------------------------------------
# psql inside the container, over TCP: the image's init server listens on the unix socket only, so a
# socket probe answers before the real server exists. -i, or statements on stdin are silently dropped.
sql() {
  docker exec -i -e "PGPASSWORD=$PASSWORD" "$CONTAINER" \
    psql -h 127.0.0.1 -U "$ADMIN" -d "$1" -v ON_ERROR_STOP=1 -qtA "${@:2}"
}
url() { echo "postgresql://$ADMIN:$PASSWORD@127.0.0.1:$PORT/$1"; }
# The schema of one database as text two databases can be compared by. pg_dump writes a random
# `\restrict` key into every dump, so those lines go, with the comments and blank lines around objects.
dump() {
  docker exec -e "PGPASSWORD=$PASSWORD" "$CONTAINER" \
    pg_dump -h 127.0.0.1 -U "$ADMIN" -d "$1" --schema-only --no-owner --no-privileges \
    | grep -Ev '^(--|\\restrict |\\unrestrict |$)'
}
same_schema() {  # same_schema <expected dump> <database> <what it is>
  dump "$2" >"$WORK/actual.sql" || { red "pg_dump of $2 failed"; return 1; }
  if ! diff -u "$1" "$WORK/actual.sql" >"$WORK/schema.diff"; then
    head -80 "$WORK/schema.diff"
    red "$3"
    return 1
  fi
}

migration_round_trip() {
  local PRISMA="$API/node_modules/.bin/prisma"
  [ -x "$PRISMA" ] || PRISMA="$REPO/node_modules/.bin/prisma"
  [ -x "$PRISMA" ] || { red "no prisma CLI under $API or $REPO — phase 1 lays the overlay that provides it"; return; }

  docker run -d --name "$CONTAINER" \
    -e "POSTGRES_USER=$ADMIN" -e "POSTGRES_PASSWORD=$PASSWORD" -e POSTGRES_DB=postgres \
    -e PGDATA=/pgdata --tmpfs /pgdata:size=2g \
    -p 127.0.0.1::5432 "${RUN_PG_SPEC_IMAGE:-postgres:16-alpine}" >/dev/null || { red "docker run failed"; return; }
  PORT="$(docker port "$CONTAINER" 5432/tcp | head -1 | sed 's/.*://')"
  [ -n "$PORT" ] || { red "docker did not publish a host port"; return; }
  for _ in $(seq 1 120); do sql postgres -c 'SELECT 1' </dev/null >/dev/null 2>&1 && break; sleep 1; done
  sql postgres -c 'SELECT 1' </dev/null >/dev/null || { red "$CONTAINER never accepted a TCP connection"; return; }
  sql postgres -c 'CREATE DATABASE pccreset_before' </dev/null >/dev/null &&
    sql postgres -c 'CREATE DATABASE pccreset_after' </dev/null >/dev/null || { red "could not create the databases"; return; }

  # Every migration below 0255, byte for byte, replayed from a directory of its own by the frontier config.
  mkdir -p "$WORK/frontier"
  cp "$API/prisma/migrations/migration_lock.toml" "$WORK/frontier/"
  local dir name
  for dir in "$API"/prisma/migrations/[0-9][0-9][0-9][0-9]_*/; do
    name="$(basename "$dir")"
    (( 10#${name%%_*} < 10#${UNIT%%_*} )) && cp -R "$dir" "$WORK/frontier/$name"
  done
  echo "==> prisma migrate deploy: pccreset_before to 0254, pccreset_after to $UNIT"
  ( cd "$API" && DATABASE_URL="$(url pccreset_before)" \
      ORBIT_FRONTIER_PRISMA_SCHEMA="$API/prisma/schema.prisma" ORBIT_FRONTIER_PRISMA_MIGRATIONS="$WORK/frontier" \
      "$PRISMA" migrate deploy --config prisma.frontier.config.ts >"$WORK/deploy-before.log" 2>&1 ) ||
    { cat "$WORK/deploy-before.log"; red "prisma migrate deploy up to 0254 failed"; return; }
  ( cd "$API" && DATABASE_URL="$(url pccreset_after)" "$PRISMA" migrate deploy >"$WORK/deploy-after.log" 2>&1 ) ||
    { cat "$WORK/deploy-after.log"; red "prisma migrate deploy up to $UNIT failed"; return; }
  dump pccreset_before >"$WORK/before.sql" && dump pccreset_after >"$WORK/after.sql" || { red "pg_dump failed"; return; }

  # The control: before any rollback the two schemas differ, exactly by what 0255 creates.
  if cmp -s "$WORK/before.sql" "$WORK/after.sql"; then
    red "the 0254 and $UNIT schemas dump identically — this comparison cannot see 0255"
    return
  fi
  local object
  for object in 'CREATE TABLE public.codex_rate_limit_reset_operation (' \
                'CREATE UNIQUE INDEX codex_rate_limit_reset_operation_in_flight_key' \
                'CREATE UNIQUE INDEX codex_rate_limit_reset_operation_owner_id_client_request_id_key' \
                'CREATE TRIGGER codex_rate_limit_reset_operation_guard BEFORE UPDATE' \
                'heartbeat_lease_owner uuid' 'heartbeat_draining boolean'; do
    grep -qF "$object" "$WORK/after.sql" || red "the $UNIT schema has no '$object'"
    grep -qF "$object" "$WORK/before.sql" && red "the 0254 schema already has '$object'"
  done

  # Rows to roll back over: an operation, and a runner whose new columns hold values.
  sql pccreset_after >/dev/null <<'SQL' || { red "could not seed the rows the rollback runs over"; return; }
INSERT INTO "user" ("id", "email", "name", "password_hash")
  VALUES ('00000000-0000-7000-8000-0000000c0de1', 'codex-reset-rollback@example.test', 'rollback', 'x');
INSERT INTO "runner" ("id", "name", "owner_id", "token_hash", "heartbeat_lease_owner", "heartbeat_draining")
  VALUES ('00000000-0000-7000-8000-0000000c0de2', 'codex-reset-rollback', '00000000-0000-7000-8000-0000000c0de1',
          'x', '00000000-0000-7000-8000-0000000c0de3', false);
INSERT INTO "codex_rate_limit_reset_operation" ("id", "owner_id", "runner_id", "account_fingerprint",
    "client_request_id", "provider_idempotency_key", "consume_state", "refresh_state", "created_at", "updated_at")
  VALUES ('00000000-0000-7000-8000-0000000c0de4', '00000000-0000-7000-8000-0000000c0de1',
          '00000000-0000-7000-8000-0000000c0de2', 'cxa1_0123456789abcdef0123456789abcdef',
          '00000000-0000-7000-8000-0000000c0de5', '00000000-0000-7000-8000-0000000c0de6',
          'PENDING', 'NONE', now(), now());
SQL

  local round
  for round in 1 2; do
    sql pccreset_after <"$API/prisma/migrations/$UNIT/down.sql" >/dev/null || { red "down.sql failed on run $round"; return; }
    same_schema "$WORK/before.sql" pccreset_after "rolled back (down.sql run $round), the schema is not the 0254 one" || return
  done
  [ "$(sql pccreset_after -c 'SELECT count(*) FROM "runner"' </dev/null)" = 1 ] ||
    red "the rollback lost the runner row it ran over"

  sql pccreset_after -c "DELETE FROM \"_prisma_migrations\" WHERE \"migration_name\" = '$UNIT'" </dev/null >/dev/null ||
    { red "could not delete $UNIT's ledger row"; return; }
  ( cd "$API" && DATABASE_URL="$(url pccreset_after)" "$PRISMA" migrate deploy >"$WORK/deploy-again.log" 2>&1 ) ||
    { cat "$WORK/deploy-again.log"; red "prisma migrate deploy did not roll $UNIT forward again"; return; }
  same_schema "$WORK/after.sql" pccreset_after "rolled forward again, the schema is not the $UNIT one" || return
  [ "$(sql pccreset_after -c "SELECT count(*) FROM \"_prisma_migrations\" WHERE \"migration_name\" = '$UNIT' AND \"finished_at\" IS NOT NULL" </dev/null)" = 1 ] ||
    red "the ledger does not record $UNIT as applied exactly once"

  sql pccreset_after <"$API/prisma/migrations/$UNIT/migration.sql" >/dev/null || { red "migration.sql does not run a second time"; return; }
  same_schema "$WORK/after.sql" pccreset_after "migration.sql run a second time leaves a different schema" || return
  echo "==> $UNIT: forward, back twice over rows, forward again and re-run all match"
}

echo "########## 2. $UNIT forward and back ##########"
migration_round_trip

# --- 3. the old runner paths --------------------------------------------------------------------
echo "########## 3. old runner heartbeats ##########"
OLD_RUNNER_SPECS=(
  build/runner-api/heartbeat-lease-owner.spec.js
  build/runner-api/runtime-default-heartbeat.spec.js
  build/runner-api/repos-root-heartbeat.spec.js
  build/runner-api/repo-health-heartbeat.spec.js
  build/runner-api/model-catalog-refresh-heartbeat.spec.js
  build/runner-api/engine-sign-out-alert.spec.js
)
compiled=1
for js in "${OLD_RUNNER_SPECS[@]}"; do
  [ -f "$API/$js" ] || { red "$js was not compiled"; compiled=0; }
done
if [ "$compiled" = 1 ]; then
  out="$(cd "$API" && NODE_OPTIONS="$(pg_matrix_child_node_options)" \
    node "${PG_MATRIX_NODE_TEST_ARGS[@]}" "${OLD_RUNNER_SPECS[@]}" 2>&1)"
  rc=$?
  IFS=$'\t' read -r t p f s why < <(printf '%s\n' "$out" | pg_matrix_summary)
  [ "$rc" = 0 ] || { printf '%s\n' "$out"; red "the old runner heartbeat specs exited $rc"; }
  [ -n "$why" ] && red "old runner heartbeat specs: $why"
  [ "$f" -gt 0 ] && red "old runner heartbeat specs: $f failing"
  [ "$s" -gt 0 ] && red "old runner heartbeat specs: $s SKIPPED"
  echo "==== old runner heartbeats tests=$t pass=$p fail=$f skipped=$s"
fi

echo
echo "==== behaviour: ${line:-no summary}"
for r in ${RED[@]+"${RED[@]}"}; do echo "RED: $r"; done
[ "${#RED[@]}" -gt 0 ] && exit 1
echo "==> OK: behaviour, $UNIT forward and back, and the old runner heartbeats witnessed, no skips"
exit 0
