#!/usr/bin/env bash
# Every `*.pg.spec` in the apiserver, each on a database this script creates and destroys.
#
#   scripts/project-pg-matrix.sh          # provision, migrate a template, run all of them, tear down
#   scripts/project-pg-matrix.sh --keep   # leave the container up for poking at afterwards
#
# `scripts/project-e2e.sh` gives its two suites a fresh database. This gives every pg spec one, for
# the reason the first run without it found: sharing a database means `coordinator-identity-migration`
# runs its DDL and everything scheduled after it is measured against a schema that spec left behind.
# Six figures of that is not a signal; it is the harness reporting on itself.
#
# Two specs need something other than the migrated clone, and both say so in their own headers:
#
#   * project-reconcile-fault-injection spawns a child that requires
#     ./build-project-reconcile-faults/… — an artifact of its OWN tsconfig. From `build/` the child
#     dies with MODULE_NOT_FOUND before the injected SIGKILL happens and the spec reports 5/7 for a
#     reason that has nothing to do with the product. The build step is done here.
#   * steer-dequeue is schema-owning: it creates the two columns-only tables its WHERE clause reads
#     ("any empty Postgres … not the application schema"). Handed a migrated clone, its
#     `DROP TABLE "session"` hits the dependent objects of every migration. It gets an EMPTY one.
#
# `COORDINATOR_PG_RESTART_COMMAND` is supplied too: the disposable container IS restartable, and
# without it project-dispatch-boundary-verification's "a real server restart does not duplicate or
# lose an applied dispatch" reports `# SKIP` — a silent hole in exactly the property that most needs
# a real server.
#
# `ORBIT_DB_CONFLICT_ORIGIN=fault_injection` is supplied for the reason `scripts/deadlock-barrier.sh`
# supplies it: every spec here makes conflicts on purpose. The label is a property of the PROCESS —
# src/apiserver/src/common/db-conflict-metrics.ts reads it from the environment exactly so that no
# production code path can reach it — so a harness that does not export it leaves its own deliberate
# 40001s counted as `origin="service"`, the value that means a real incident. transaction-retry.pg is
# the spec that asserts the label, and without this it reports 4/6 for a property of this script.
#
# A spec FAILS if node exits non-zero for any reason — a failing assertion, a crash, a timeout, or a
# process that will not exit because something left a handle open. The timeout is a backstop and
# never a pass; the script exits non-zero if anything was red.
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
API="$REPO/src/apiserver"
CONTAINER="${PCC_PG_CONTAINER:-pcc-matrix-pg16}"
PORT="${PCC_PG_PORT:-55490}"
ADMIN="${PCC_PG_USER:-pcc_matrix_admin}"
PASSWORD="${PCC_PG_PASSWORD:-pcc_matrix_pw}"
IMAGE="${PCC_PG_IMAGE:-postgres:16-alpine}"
TMPL="${PCC_PG_TEMPLATE:-pcc_matrix_tmpl}"
SPEC_TIMEOUT="${PCC_PG_SPEC_TIMEOUT:-600}"
NODE="${NODE:-node}"
# TypeScript 7 is installed per workspace: the repo root still hoists the 5.9.3 that
# @nestjs/cli pins, so take the apiserver copy when it is there.
TSC="$API/node_modules/.bin/tsc"
[ -x "$TSC" ] || TSC="$REPO/node_modules/.bin/tsc"
# Prisma 7 is installed per workspace too — npm no longer hoists it to the repo root.
PRISMA="$API/node_modules/.bin/prisma"
[ -x "$PRISMA" ] || PRISMA="$REPO/node_modules/.bin/prisma"
KEEP=0
[ "${1:-}" = "--keep" ] && KEEP=1

cleanup() {
  if [ "$KEEP" = "1" ]; then
    echo "==> keeping $CONTAINER on 127.0.0.1:$PORT"
  else
    echo "==> removing $CONTAINER"
    docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

psql_admin() { docker exec "$CONTAINER" psql -U "$ADMIN" -d postgres -tAc "$1"; }

echo "==> provisioning $CONTAINER ($IMAGE) on 127.0.0.1:$PORT"
docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
docker run -d --name "$CONTAINER" \
  -e "POSTGRES_USER=$ADMIN" -e "POSTGRES_PASSWORD=$PASSWORD" -e "POSTGRES_DB=postgres" \
  -p "127.0.0.1:$PORT:5432" "$IMAGE" >/dev/null
for _ in $(seq 1 90); do
  docker exec "$CONTAINER" psql -U "$ADMIN" -d postgres -tAc 'SELECT 1' >/dev/null 2>&1 && break
  sleep 1
done
docker exec "$CONTAINER" psql -U "$ADMIN" -d postgres -tAc 'SELECT 1' >/dev/null

SYSTEM_ID="$(psql_admin 'SELECT system_identifier FROM pg_control_system()' | tr -d '[:space:]')"
echo "==> server identity: role=$ADMIN system_identifier=$SYSTEM_ID"

psql_admin "DROP DATABASE IF EXISTS $TMPL" >/dev/null
psql_admin "CREATE DATABASE $TMPL" >/dev/null
echo "==> prisma migrate deploy (template $TMPL)"
( cd "$API" && DATABASE_URL="postgresql://$ADMIN:$PASSWORD@127.0.0.1:$PORT/$TMPL" \
    "$PRISMA" migrate deploy --schema prisma/schema.prisma >/dev/null )
echo "==> $(docker exec "$CONTAINER" psql -U "$ADMIN" -d "$TMPL" -tAc \
  'SELECT count(*) FROM _prisma_migrations WHERE finished_at IS NOT NULL') migrations applied"

echo "==> building the test tree"
( cd "$API" && "$TSC" -p tsconfig.test.json )
echo "==> building the fault-injection tree"
( cd "$API" && "$TSC" -p tsconfig.project-reconcile-faults.json )

cd "$API"
n=0; TOTAL=0; PASS=0; FAIL=0; SKIP=0; RED=()
for f in $(ls build/**/*.pg.spec.js | sort); do
  n=$((n+1)); DB="pcc_matrix_s$n"; base="$(basename "$f")"
  [ "$base" = "project-reconcile-fault-injection.pg.spec.js" ] &&
    f="build-project-reconcile-faults/projects/$base"
  psql_admin "DROP DATABASE IF EXISTS $DB" >/dev/null
  case "$base" in
    steer-dequeue.pg.spec.js) psql_admin "CREATE DATABASE $DB" >/dev/null ;;
    *)                        psql_admin "CREATE DATABASE $DB TEMPLATE $TMPL" >/dev/null ;;
  esac
  URL="postgresql://$ADMIN:$PASSWORD@127.0.0.1:$PORT/$DB"
  out=$(COORDINATOR_PG_URL="$URL" \
        COORDINATOR_PG_EXPECTED_DATABASE="$DB" \
        COORDINATOR_PG_EXPECTED_USER="$ADMIN" \
        COORDINATOR_PG_EXPECTED_SYSTEM_IDENTIFIER="$SYSTEM_ID" \
        COORDINATOR_PG_CONTAINER="$CONTAINER" \
        ORBIT_TEST_PG_URL="$URL" \
        COORDINATOR_PG_RESTART_COMMAND="docker restart $CONTAINER" \
        ORBIT_DB_CONFLICT_ORIGIN=fault_injection \
        timeout -k 20 "$SPEC_TIMEOUT" "$NODE" --test --test-concurrency=1 "$f" 2>&1)
  rc=$?
  t=$(echo "$out" | sed -n 's/^# tests \([0-9]*\)/\1/p' | tail -1); t=${t:-0}
  p=$(echo "$out" | sed -n 's/^# pass \([0-9]*\)/\1/p' | tail -1); p=${p:-0}
  fl=$(echo "$out" | sed -n 's/^# fail \([0-9]*\)/\1/p' | tail -1); fl=${fl:-0}
  sk=$(echo "$out" | sed -n 's/^# skipped \([0-9]*\)/\1/p' | tail -1); sk=${sk:-0}
  TOTAL=$((TOTAL+t)); PASS=$((PASS+p)); FAIL=$((FAIL+fl)); SKIP=$((SKIP+sk))
  why=""
  if [ "$rc" = "124" ] || [ "$rc" = "137" ]; then why="TIMEOUT/KILLED rc=$rc (hang or leaked handle)"
  elif [ "$rc" != "0" ]; then why="rc=$rc"; fi
  [ -n "$why" ] && RED+=("$base: $why")
  printf '%-58s tests=%-4s pass=%-4s fail=%-3s skip=%-3s %s\n' "$base" "$t" "$p" "$fl" "$sk" "$why"
  [ -n "${PCC_PG_LOG_DIR:-}" ] && echo "$out" > "$PCC_PG_LOG_DIR/$base.txt"
  psql_admin "DROP DATABASE IF EXISTS $DB" >/dev/null
done

# The fault-injection tree is a build artifact of this script, not of the repo. Removing it here
# keeps `git status` after an acceptance run showing source changes and nothing else.
rm -rf "$API/build-project-reconcile-faults"

echo "==== tests=$TOTAL pass=$PASS fail=$FAIL skipped=$SKIP spec-level-red=${#RED[@]} ===="
for r in "${RED[@]:-}"; do [ -n "$r" ] && echo "RED: $r"; done
if [ "$FAIL" -gt 0 ] || [ "${#RED[@]}" -gt 0 ]; then exit 1; fi
echo "==> OK"
