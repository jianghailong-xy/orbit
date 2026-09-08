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
# Every spec gets that same migrated clone. steer-dequeue was the one exception until 2026-09-08,
# and why it stopped being one is written down here so that it does not come back:
#
#   * steer-dequeue is schema-owning: it creates the two columns-only tables its WHERE clause reads
#     ("any empty Postgres … not the application schema"), so it needs nothing FROM the clone. It
#     used to have to be kept AWAY from one as well — its fixture's tables were unqualified, and the
#     `DROP TABLE` in front of them hit what the migrations had made depend on the application's
#     own — so this loop handed it an empty database. 9c9a79c8 (2026-08-30) moved the fixture into a
#     `steer_dequeue_test` schema it creates and drops: the DROPs name `steer_dequeue_test."session"`
#     now, and the rest resolve through `search_path`. Measured on one throwaway server: empty
#     database 25/25, migrated clone 25/25, and the same spec with that qualification stripped back
#     off red on its first case, `2BP01 cannot drop table conversation_turn because other objects
#     depend on it`. That third run is what makes the second one worth anything.
#
# `COORDINATOR_PG_RESTART_COMMAND` is supplied too: the disposable container IS restartable, and
# without it the only two specs that read it report `# SKIP` — a silent hole in exactly the property
# that most needs a real server:
#
#   * task-dispatch-epoch-aba's
#     "a real server restart does not change what a moment named or what it answered"
#   * task-run-winner-recovery's
#     "a real server restart does not change which Session a press answers with"
#
# `ORBIT_DB_CONFLICT_ORIGIN=fault_injection` is supplied for the reason `scripts/deadlock-barrier.sh`
# supplies it: every spec here makes conflicts on purpose. The label is a property of the PROCESS —
# src/apiserver/src/common/db-conflict-metrics.ts reads it from the environment exactly so that no
# production code path can reach it — so a harness that does not export it leaves its own deliberate
# 40001s counted as `origin="service"`, the value that means a real incident. transaction-retry.pg is
# the spec that asserts the label, and without this it reports 4/6 for a property of this script.
#
# `WORK_OVERVIEW_PG_URL` is the same per-spec clone under a third name. project-work-overview-readiness
# is the one spec in the tree that reads it — `COORDINATOR_PG_URL` covers 111 of the others and
# `ORBIT_TEST_PG_URL` the last one — and until 2026-09-08 nothing here handed it over, so that spec
# reported `ok 1 … # SKIP` on every run this script has ever made while the line it printed read like
# a spec that had run. It gets the clone rather than a database of its own because the spec's own
# isolation guard and identity check read the `COORDINATOR_PG_EXPECTED_*` this loop already set for
# that clone.
#
# The reporter every child prints its summary with, and the parser that reads it, are pinned in
# `scripts/pg-matrix-summary.lib.sh` — Node 23 made `spec` the default and the TAP counters this
# script reads went to zero without anything going red. Nothing about that is the caller's to
# choose, so the child's `--test*` NODE_OPTIONS are dropped and argv says `--test-reporter=tap`.
#
# In a git worktree there is no node_modules at all — only the tracked files are there — so `$TSC`
# and `$PRISMA` named paths that did not exist and this script died before it provisioned anything.
# The main checkout's are borrowed below, one link per package for the apiserver so that the two
# entries which cannot be shared are real: `@prisma/client` is copied (node, tsc and prisma all
# resolve a linked package by its realpath and would read the main checkout's client straight back)
# and `.prisma/client` is generated from THIS branch's schema, which is what `tsc -p
# tsconfig.test.json` below is compiled against — borrowing the main checkout's leaves a branch that
# adds a model failing with `Property 'x' does not exist on type 'PrismaService'`, a red that is the
# harness rather than the product. In the main checkout the whole block is skipped: generating there
# rewrites the client every concurrent session is compiling against. Same overlay, and for the same
# reasons, as the one in `scripts/run-pg-spec.sh`.
#
# `@orbit/shared` is a workspace link to `src/shared`, and what a consumer reads is its `dist/` —
# the package's `main`/`types` — not its sources. Nothing here used to build it, so both the compiler
# and every child process read whatever `dist/` the main checkout happened to have lying around. On
# 2026-09-08 that was four days older than `src/shared/src` and this script printed seven TS2339 and
# TS2353 errors naming `refreshModelCatalog`, `minFreeDiskMb` and `enginePhase` in files no branch
# had touched. The compile noise is the visible half. The quiet half is the one
# `scripts/outcome-reconciler-full-api.sh` names — "a clean candidate can compile correctly and then
# execute tests against an older codec/protocol implementation" — because `tsc` emits anyway and the
# specs then ran against that same stale `dist/`. So it is built below and linked TWICE: once under
# `src/` for the compiler and once under `build/` for the child, as `scripts/run-pg-spec.sh` does it.
#
# Both `tsc` invocations end in `|| die`. Without that they were advisory: the errors above scrolled
# past and the run continued against whatever tree tsc had emitted regardless. An emit that produced
# no `build/**/*.pg.spec.js` at all was worse than red — the loop body ran zero times and the script
# printed `tests=0 pass=0 fail=0 … spec-level-red=0`, then `==> OK`, and exited 0. A green that has
# run nothing is the one outcome this script must not be able to report, so the list is taken once
# now and an empty one is fatal.
#
# `prisma migrate deploy` ends in `|| die` for the same reason, and the count it produces is now
# READ rather than printed. It was the last unguarded step: `set -e` is not available here (see
# below), so a deploy that failed — a migration that will not apply, a template `CREATE DATABASE`
# that did not happen, a server that never came up — printed its error, and the very next line
# printed `==> 0 migrations applied` and the run went on to clone that empty template 100-odd times.
# What comes back is not red: on 2026-09-08 the first seventeen specs run that way reported
# `pass=6 fail=0` for one of them and `fail=N` for the rest, which is a matrix reporting on its own
# template rather than on the branch. So the applied count is compared against the number of
# migration directories this branch actually has, and anything short of the frontier stops the run
# where the fault is, before a single database is cloned from it.
#
# `set -e` is deliberately NOT set. It cannot be: the spec loop's `out=$(… node --test …)` followed
# by `rc=$?` is the whole mechanism by which a failing spec is RECORDED instead of fatal, and under
# `-e` the first red spec aborts the script before `rc` is read — no per-spec line, no `RED[]`, no
# footer. Every step that must not be advisory therefore says `|| die` itself.
#
# A SKIP IS RED, AND THERE IS NO ALLOWLIST
# ========================================
# `node --test` exits 0 on a file whose every case skipped, and until 2026-09-08 this script folded
# those cases into a `skipped=N` in the footer that nothing then read: `FAIL` and `RED[]` were both
# 0 and the run went green. That is how the hole above stayed open for as long as it did — the count
# was in front of every reader the whole time and cost nothing.
#
# The choice, over an allowlist of specs that are permitted to skip: EVERY skip is red and nothing
# in the tree is exempt. What makes that affordable is what the paragraphs above are. Each of them
# is a variable this script supplies so that some spec does not skip — the restart command, the
# conflict origin, and now the third URL name — so the alternative to a name on a list has always
# been a variable the harness can hand over, and handing it over is strictly better: it buys the
# assertions instead of excusing them. With the third name supplied the whole matrix reports
# `skipped=0`, so a list would have been empty on the day it was written, and thereafter a place for
# the next hole to sit quietly with a name beside it.
#
# `PCC_PG_CONTROL=omit-url` is the control that holds this script to it, as
# `RUN_PG_SPEC_CONTROL=omit-url` does for `scripts/run-pg-spec.sh`: everything below happens exactly
# as it normally does, except that no URL reaches a child under any of its three names. Every case
# reports `# SKIP`, every `node --test` exits 0, and this script must still exit non-zero. The day
# it goes green under that knob, every green it has ever printed is worth nothing.
#
# A spec FAILS if node exits non-zero for any reason — a failing assertion, a crash, a timeout, or a
# process that will not exit because something left a handle open. The timeout is a backstop and
# never a pass; the script exits non-zero if anything was red.
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
API="$REPO/src/apiserver"
# shellcheck source=scripts/pg-matrix-summary.lib.sh
. "$REPO/scripts/pg-matrix-summary.lib.sh" || exit 1
CONTAINER="${PCC_PG_CONTAINER:-pcc-matrix-pg16}"
PORT="${PCC_PG_PORT:-55490}"
ADMIN="${PCC_PG_USER:-pcc_matrix_admin}"
PASSWORD="${PCC_PG_PASSWORD:-pcc_matrix_pw}"
IMAGE="${PCC_PG_IMAGE:-postgres:16-alpine}"
TMPL="${PCC_PG_TEMPLATE:-pcc_matrix_tmpl}"
SPEC_TIMEOUT="${PCC_PG_SPEC_TIMEOUT:-600}"
NODE="${NODE:-node}"
KEEP=0
[ "${1:-}" = "--keep" ] && KEEP=1
CONTROL="${PCC_PG_CONTROL:-}"
die() { echo "project-pg-matrix: $*" >&2; exit 2; }

# --- the worktree overlays ----------------------------------------------------------------------
# Refresh a symlink, create a missing one, never touch a real directory: in the main checkout every
# one of these already exists and this whole block is a no-op.
link() { if [ -L "$2" ] || [ ! -e "$2" ]; then ln -sfn "$1" "$2"; fi; }
MAIN="$(dirname "$(git -C "$REPO" rev-parse --path-format=absolute --git-common-dir 2>/dev/null)")"
[ -d "$MAIN/node_modules" ] || MAIN="$REPO"
echo "==> overlaying node_modules from $MAIN"
link "$MAIN/node_modules"                "$REPO/node_modules"
link "$MAIN/src/apiserver/node_modules"  "$API/node_modules"
link "$MAIN/src/shared/node_modules"     "$REPO/src/shared/node_modules"

# TypeScript 7 is installed per workspace: the repo root still hoists the 5.9.3 that
# @nestjs/cli pins, so take the apiserver copy when it is there. Prisma 7 is installed per workspace
# too — npm no longer hoists it to the repo root. Resolved HERE rather than at the top of the file
# because in a worktree neither binary exists until the links above are made.
TSC="$API/node_modules/.bin/tsc"
[ -x "$TSC" ] || TSC="$REPO/node_modules/.bin/tsc"
PRISMA="$API/node_modules/.bin/prisma"
[ -x "$PRISMA" ] || PRISMA="$REPO/node_modules/.bin/prisma"
[ -x "$TSC" ] || die "no tsc under $MAIN — run npm install in the main checkout first"
[ -x "$PRISMA" ] || die "no prisma under $MAIN — run npm install in the main checkout first"

# The branch's own Prisma client — see the header for why it cannot be the main checkout's. The
# whole-directory link above is undone for the apiserver and rebuilt as one symlink per package, so
# that the two entries which have to be ours can be real directories.
if [ "$MAIN" != "$REPO" ]; then
  NM="$API/node_modules"; MAIN_NM="$MAIN/src/apiserver/node_modules"
  [ -L "$NM" ] && rm -f "$NM"
  mkdir -p "$NM/@prisma" "$NM/.prisma"
  for d in "$MAIN_NM"/* "$MAIN_NM"/.[!.]*; do
    [ -e "$d" ] || continue
    case "$(basename "$d")" in @prisma|.prisma) continue ;; esac
    link "$d" "$NM/$(basename "$d")"
  done
  for d in "$MAIN_NM/@prisma"/*; do
    [ "$(basename "$d")" = "client" ] || link "$d" "$NM/@prisma/$(basename "$d")"
  done
  # A copy, ~75MB, once per worktree: `prisma generate` finds the package by walking up from the
  # schema's directory, and through a link it would find — and write beside — the main checkout's.
  # It also has to be in place BEFORE generating, which otherwise fails with `Could not resolve
  # @prisma/client`.
  if [ ! -d "$NM/@prisma/client" ] || [ -L "$NM/@prisma/client" ]; then
    echo "==> copying @prisma/client out of $MAIN (this worktree needs its own)"
    rm -rf "$NM/@prisma/client"
    cp -r "$MAIN_NM/@prisma/client" "$NM/@prisma/client" || die "could not copy @prisma/client"
  fi
  # ~6s, so only when this branch's schema is newer than what was generated from it last time.
  GENERATED="$NM/.prisma/client/index.d.ts"
  if [ ! -f "$GENERATED" ] || [ "$API/prisma/schema.prisma" -nt "$GENERATED" ]; then
    echo "==> generating this branch's Prisma client"
    ( cd "$API" && "$PRISMA" generate >/dev/null ) || die "prisma generate failed"
    [ -f "$GENERATED" ] || die "prisma generate wrote no $GENERATED"
  fi
fi

cleanup() {
  if [ "$KEEP" = "1" ]; then
    echo "==> keeping $CONTAINER on 127.0.0.1:$PORT"
  else
    echo "==> removing $CONTAINER"
    docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

# Over TCP, from inside the container, and never over the unix socket — the same answer
# `scripts/run-pg-spec.sh` gives, for the same reason. The entrypoint runs an init server that
# listens on the socket only, so a socket `psql` answers while the real server is still down. On
# 2026-09-08 the first CI run broke out of the readiness loop against that init server; the next
# statement, the one that reads `system_identifier`, hit the gap while the real server was starting
# and came back EMPTY. Every spec was then handed `COORDINATOR_PG_EXPECTED_SYSTEM_IDENTIFIER=''`,
# 109 of the 113 failed their own isolation check, and the whole matrix was a report on this
# handshake. A fresh runner pulls the image first, which is why the race lands there and not here.
psql_db() {
  docker exec -e "PGPASSWORD=$PASSWORD" "$CONTAINER" \
    psql -h 127.0.0.1 -p 5432 -U "$ADMIN" -d "$1" -tAc "$2"
}
psql_admin() { psql_db postgres "$1"; }

[ "$CONTROL" = "omit-url" ] &&
  echo "==> CONTROL omit-url: no URL is handed to any child; every case should SKIP and this run must be RED"
echo "==> provisioning $CONTAINER ($IMAGE) on 127.0.0.1:$PORT"
docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
docker run -d --name "$CONTAINER" \
  -e "POSTGRES_USER=$ADMIN" -e "POSTGRES_PASSWORD=$PASSWORD" -e "POSTGRES_DB=postgres" \
  -p "127.0.0.1:$PORT:5432" "$IMAGE" >/dev/null
for _ in $(seq 1 90); do psql_admin 'SELECT 1' >/dev/null 2>&1 && break; sleep 1; done
psql_admin 'SELECT 1' >/dev/null || die "$CONTAINER never accepted a TCP connection"

# Fatal rather than empty: this string is what every spec's isolation guard compares the server it
# reached against, so a blank one turns 113 product specs into 113 reports about this line.
SYSTEM_ID="$(psql_admin 'SELECT system_identifier FROM pg_control_system()' | tr -d '[:space:]')"
[ -n "$SYSTEM_ID" ] || die "$CONTAINER answered no system_identifier"
echo "==> server identity: role=$ADMIN system_identifier=$SYSTEM_ID"

psql_admin "DROP DATABASE IF EXISTS $TMPL" >/dev/null
psql_admin "CREATE DATABASE $TMPL" >/dev/null
echo "==> prisma migrate deploy (template $TMPL)"
( cd "$API" && DATABASE_URL="postgresql://$ADMIN:$PASSWORD@127.0.0.1:$PORT/$TMPL" \
    "$PRISMA" migrate deploy --schema prisma/schema.prisma >/dev/null ) ||
  die "prisma migrate deploy failed against template $TMPL — see the error above"
APPLIED="$(psql_db "$TMPL" \
  'SELECT count(*) FROM _prisma_migrations WHERE finished_at IS NOT NULL')"
FRONTIER="$(ls -d "$API"/prisma/migrations/*/ | wc -l)"
echo "==> ${APPLIED:-0} migrations applied"
[ "$APPLIED" = "$FRONTIER" ] ||
  die "template $TMPL is at ${APPLIED:-no} of $FRONTIER migrations — a clone is not this schema"

echo "==> building @orbit/shared"
"$TSC" -p "$REPO/src/shared/tsconfig.json" || die "src/shared failed to compile"
mkdir -p "$REPO/src/node_modules/@orbit"
link "$REPO/src/shared" "$REPO/src/node_modules/@orbit/shared"          # compile time

echo "==> building the test tree"
( cd "$API" && "$TSC" -p tsconfig.test.json ) || die "tsconfig.test.json failed to compile"
mkdir -p "$API/build/node_modules/@orbit"
link "$REPO/src/shared" "$API/build/node_modules/@orbit/shared"          # run time

cd "$API"
# Taken once, and empty is fatal: a loop that never runs reports the same zeroes as a clean run.
SPECS="$(ls build/**/*.pg.spec.js 2>/dev/null | sort)"
[ -n "$SPECS" ] || die "no build/**/*.pg.spec.js to run — the test tree compiled nothing"
n=0; TOTAL=0; PASS=0; FAIL=0; SKIP=0; MISSING=0; RED=()
for f in $SPECS; do
  n=$((n+1)); DB="pcc_matrix_s$n"; base="$(basename "$f")"
  psql_admin "DROP DATABASE IF EXISTS $DB" >/dev/null
  psql_admin "CREATE DATABASE $DB TEMPLATE $TMPL" >/dev/null
  URL="postgresql://$ADMIN:$PASSWORD@127.0.0.1:$PORT/$DB"
  child=(COORDINATOR_PG_EXPECTED_DATABASE="$DB"
         COORDINATOR_PG_EXPECTED_USER="$ADMIN"
         COORDINATOR_PG_EXPECTED_SYSTEM_IDENTIFIER="$SYSTEM_ID"
         COORDINATOR_PG_CONTAINER="$CONTAINER"
         COORDINATOR_PG_RESTART_COMMAND="docker restart $CONTAINER"
         ORBIT_DB_CONFLICT_ORIGIN=fault_injection
         NODE_OPTIONS="$(pg_matrix_child_node_options)")
  [ "$CONTROL" = "omit-url" ] ||
    child+=(COORDINATOR_PG_URL="$URL" ORBIT_TEST_PG_URL="$URL" WORK_OVERVIEW_PG_URL="$URL")
  out=$(env "${child[@]}" \
        timeout -k 20 "$SPEC_TIMEOUT" "$NODE" "${PG_MATRIX_NODE_TEST_ARGS[@]}" "$f" 2>&1)
  rc=$?
  IFS=$'\t' read -r t p fl sk unreadable < <(printf '%s\n' "$out" | pg_matrix_summary)
  TOTAL=$((TOTAL+t)); PASS=$((PASS+p)); FAIL=$((FAIL+fl)); SKIP=$((SKIP+sk))
  why=""
  if [ "$rc" = "124" ] || [ "$rc" = "137" ]; then why="TIMEOUT/KILLED rc=$rc (hang or leaked handle)"
  elif [ "$rc" != "0" ]; then why="rc=$rc"; fi
  if [ -n "$unreadable" ]; then MISSING=$((MISSING+1)); why="${why:+$why; }$unreadable"; fi
  # The silence this script used to print and pass on: see "A SKIP IS RED" in the header.
  [ "$sk" -gt 0 ] && why="${why:+$why; }$sk SKIPPED — those assertions were not witnessed"
  [ -n "$why" ] && RED+=("$base: $why")
  printf '%-58s tests=%-4s pass=%-4s fail=%-3s skip=%-3s %s\n' "$base" "$t" "$p" "$fl" "$sk" "$why"
  [ -n "${PCC_PG_LOG_DIR:-}" ] && echo "$out" > "$PCC_PG_LOG_DIR/$base.txt"
  psql_admin "DROP DATABASE IF EXISTS $DB" >/dev/null
done

echo "==== tests=$TOTAL pass=$PASS fail=$FAIL skipped=$SKIP missing-summary=$MISSING spec-level-red=${#RED[@]} ===="
for r in "${RED[@]:-}"; do [ -n "$r" ] && echo "RED: $r"; done
if [ "$FAIL" -gt 0 ] || [ "${#RED[@]}" -gt 0 ]; then exit 1; fi
echo "==> OK"
