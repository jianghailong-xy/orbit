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
# Lending it one, giving this branch its own Prisma client and building this tree's `@orbit/shared`
# is `scripts/worktree-overlay.sh`, which this script runs below and whose header explains each
# piece and why it cannot be the main checkout's. It is one script rather than a section here
# because `scripts/run-pg-spec.sh` runs the same one, and an overlay that drifts between two copies
# of it comes back as harness reds that read like product reds.
#
# `@orbit/shared` is a workspace link to `src/shared`, and what a consumer reads is its `dist/` —
# the package's `main`/`types` — not its sources. The overlay builds that `dist/` and links the
# package under `src/` for the compiler; below, this script adds its own link under `build/` for the
# child process, as `scripts/run-pg-spec.sh` does it.
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
# never a pass.
#
# A RED IS CONFIRMED BEFORE IT IS COUNTED
# =======================================
# On 2026-09-16/17 the same bare worktree, on the same spec sources, reported two different red
# lists. At load 39-93 (8 cores, 13 concurrent agent sessions) the baseline run came back with 12
# specs red; at load 7-9 that run and the changed one both came back `spec-level-red=0`, all 161
# lines identical, and the sixteen specs that had been red in one of those runs came back 169/169
# green under both scripts. Every one of those specs was red on its first run and clean on the next,
# in both directions, with nothing changed but the host — the load, not the branch.
#
# They arrived in exactly the shape a product red arrives in: the same `RED: <spec>: rc=1` line, the
# same non-zero ending, the same footer, under a header that said every one of them was real. A
# session nearly filed one as a main red on 2026-09-16, and what stopped it was re-running the spec
# by hand — which is the work this section now does, and writes down.
#
# So a spec whose outcome is not clean is run a SECOND time, on its own fresh clone of the template,
# before anything is reported about it:
#
#   * CLEAN THE SECOND TIME — the failure did not reproduce. The line says so, and under it go the
#     host load at the time, the claim `NOT REPRODUCED`, and the tail of the first run's own TAP
#     output (`pg_matrix_failure_tail`, whose header says what each shape prints), so that a timeout
#     or a refused connection is VISIBLE as that rather than as a failed assertion the reader has to
#     take on faith. That tail is then read, and the sentence the line carries is derived from it and
#     not chosen: whether the child failed a case at all (`pg_matrix_failure_failed_a_case`), and if
#     it did, whether the text names a timeout or a connection (`pg_matrix_failure_is_load_shaped`).
#     These specs are counted as `not-reproduced`, they are listed as `NOT REPRODUCED:` at the end,
#     and they are NOT in `spec-level-red`: the first run did fail, and what it said is printed.
#   * RED AGAIN — counted in `spec-level-red`, and the spec's line and its `RED:` entry both carry
#     `REPRODUCED`, so a reader can tell it from the ones that were red only once.
#
# The confirmation run is not an allowlist, not a subset, and not a second chance. Nothing here is
# excused and no spec is skipped by it; a skip is still red, and a spec that skipped is not re-run at
# all — the `skip: !URL` conditions in this tree read an environment variable and not a clock, so a
# skip that did not reproduce is not a thing this script has seen. What the second run costs is one
# more run of a spec that was already not clean, which is nothing at all on a run that has none.
#
# The exit code carries the distinction, for a caller that reads no further than that:
#
#   0  everything clean.
#   1  at least one spec was red twice, or skipped, or printed no summary this script can vouch for.
#      This is a verdict on the branch, and it is the only code that is one.
#   3  no spec was red twice, but at least one did not come back clean on the first run and did on
#      the second. The run is NOT a verdict on the branch and not a green either: the host made it,
#      and the specs named at the end have to be re-run alone on a quiet one.
#
# `fail=` in the footer counts the FIRST runs and is not a verdict of its own: node exits non-zero
# when a case fails, so every spec it counts is in one of the two lists the footer prints.
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
# node_modules borrowed from the main checkout, this branch's own Prisma client, this tree's
# `@orbit/shared` built and linked — all of it, and the reasoning behind each piece, is in the
# script this line runs. That script also prints which tsc it picked up, which is the regression
# signal this script used to lose in silence: a worktree that borrowed the repository root's 5.9.3
# compiled a whole test tree with the wrong compiler and said nothing about it.
bash "$REPO/scripts/worktree-overlay.sh" || die "scripts/worktree-overlay.sh failed"

# Which tsc and prisma that left available, resolved the way the overlay resolves them and for the
# same reason it resolves them late: in a worktree neither binary exists until its links are made.
TSC="$API/node_modules/.bin/tsc"
[ -x "$TSC" ] || TSC="$REPO/node_modules/.bin/tsc"
PRISMA="$API/node_modules/.bin/prisma"
[ -x "$PRISMA" ] || PRISMA="$REPO/node_modules/.bin/prisma"
[ -x "$TSC" ] || die "no tsc after the overlay — run npm install in the main checkout first"
[ -x "$PRISMA" ] || die "no prisma after the overlay — run npm install in the main checkout first"

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

echo "==> building the test tree"
( cd "$API" && "$TSC" -p tsconfig.test.json ) || die "tsconfig.test.json failed to compile"
# The overlay's `src/node_modules/@orbit/shared` already answers for everything under `build/`;
# this one is here because it is nearer still, and because `build/` is this script's own to lay out.
mkdir -p "$API/build/node_modules/@orbit"
ln -sfn "$REPO/src/shared" "$API/build/node_modules/@orbit/shared"       # run time

cd "$API"
# Taken once, and empty is fatal: a loop that never runs reports the same zeroes as a clean run.
SPECS="$(ls build/**/*.pg.spec.js 2>/dev/null | sort)"
[ -n "$SPECS" ] || die "no build/**/*.pg.spec.js to run — the test tree compiled nothing"
# --- one spec, one database, and whether it has to be asked twice ---------------------------------
# Each call clones the template into the database it is given and drops it again, so the second run
# of a spec starts from what the first one started from and neither leaves anything behind.
SPEC_OUT=''; SPEC_RC=0
run_spec_once() {  # $1 = compiled spec, $2 = database name
  psql_admin "DROP DATABASE IF EXISTS $2" >/dev/null
  psql_admin "CREATE DATABASE $2 TEMPLATE $TMPL" >/dev/null
  local url="postgresql://$ADMIN:$PASSWORD@127.0.0.1:$PORT/$2"
  local child=(COORDINATOR_PG_EXPECTED_DATABASE="$2"
               COORDINATOR_PG_EXPECTED_USER="$ADMIN"
               COORDINATOR_PG_EXPECTED_SYSTEM_IDENTIFIER="$SYSTEM_ID"
               COORDINATOR_PG_CONTAINER="$CONTAINER"
               COORDINATOR_PG_RESTART_COMMAND="docker restart $CONTAINER"
               ORBIT_DB_CONFLICT_ORIGIN=fault_injection
               NODE_OPTIONS="$(pg_matrix_child_node_options)")
  [ "$CONTROL" = "omit-url" ] ||
    child+=(COORDINATOR_PG_URL="$url" ORBIT_TEST_PG_URL="$url" WORK_OVERVIEW_PG_URL="$url")
  SPEC_OUT=$(env "${child[@]}" \
             timeout -k 20 "$SPEC_TIMEOUT" "$NODE" "${PG_MATRIX_NODE_TEST_ARGS[@]}" "$1" 2>&1)
  SPEC_RC=$?
  psql_admin "DROP DATABASE IF EXISTS $2" >/dev/null
}

# Why a spec is not clean, in one line, or nothing at all when it is. The wording is the one this
# script has always printed; the caller appends what the second run made of it.
spec_verdict() {  # $1 rc, $2 skipped, $3 unreadable-summary reason
  local why=""
  if [ "$1" = "124" ] || [ "$1" = "137" ]; then why="TIMEOUT/KILLED rc=$1 (hang or leaked handle)"
  elif [ "$1" != "0" ]; then why="rc=$1"; fi
  [ -n "$3" ] && why="${why:+$why; }$3"
  # The silence this script used to print and pass on: see "A SKIP IS RED" in the header.
  [ "$2" -gt 0 ] && why="${why:+$why; }$2 SKIPPED — those assertions were not witnessed"
  printf '%s' "$why"
}

# Is this outcome the shape a saturated host produces — so, worth asking a second time? A child that
# exited 0 did what it was asked and said what it found, so a skip in it is a statement about the
# environment and not a race: it is red, and it is not re-run.
wants_confirmation() { [ "$1" != "0" ] || [ -n "$2" ]; }

n=0; TOTAL=0; PASS=0; FAIL=0; SKIP=0; MISSING=0; RED=(); NOT_REPRODUCED=()
for f in $SPECS; do
  n=$((n+1)); base="$(basename "$f")"
  run_spec_once "$f" "pcc_matrix_s$n"
  rc="$SPEC_RC"; out="$SPEC_OUT"
  IFS=$'\t' read -r t p fl sk unreadable < <(printf '%s\n' "$out" | pg_matrix_summary)
  TOTAL=$((TOTAL+t)); PASS=$((PASS+p)); FAIL=$((FAIL+fl)); SKIP=$((SKIP+sk))
  [ -n "$unreadable" ] && MISSING=$((MISSING+1))
  why="$(spec_verdict "$rc" "$sk" "$unreadable")"
  tail_text=''; note=''
  if [ -n "$why" ]; then
    tail_first="$(printf '%s\n' "$out" | pg_matrix_failure_tail)"
    if wants_confirmation "$rc" "$unreadable"; then
      run_spec_once "$f" "pcc_matrix_s${n}r"
      IFS=$'\t' read -r _ _ _ sk2 unreadable2 < <(printf '%s\n' "$SPEC_OUT" | pg_matrix_summary)
      why2="$(spec_verdict "$SPEC_RC" "$sk2" "$unreadable2")"
      if [ -n "$why2" ]; then
        why="$why; REPRODUCED on a second run ($why2)"
        RED+=("$base: $why")
        tail_text="$(printf '%s\n' "$SPEC_OUT" | pg_matrix_failure_tail)"
        note="  REPRODUCED on a second run, on its own clone of the template:"
      else
        # What the first run said, read into one sentence by the library that also reads its counts.
        # This picks a sentence; it does not excuse anything — the spec is named at the end of the
        # run either way, and its first run's own words are printed right here.
        shape="$(printf '%s\n' "$tail_first" | pg_matrix_failure_shape)"
        why="$why; NOT REPRODUCED on a second run"
        NOT_REPRODUCED+=("$base: $why — $shape (host load $(cut -d' ' -f1 /proc/loadavg) when it ran)")
        tail_text="$tail_first"
        note="  NOT REPRODUCED: a second run on its own clone of the template was clean, so this is not
  counted in spec-level-red. The first run was not clean, and what it said was ($shape):"
      fi
      [ -n "${PCC_PG_LOG_DIR:-}" ] && printf '%s\n' "$SPEC_OUT" > "$PCC_PG_LOG_DIR/$base.rerun.txt"
    else
      RED+=("$base: $why")
      tail_text="$tail_first"
      note="  what it said:"
    fi
  fi
  printf '%-58s tests=%-4s pass=%-4s fail=%-3s skip=%-3s %s\n' "$base" "$t" "$p" "$fl" "$sk" "$why"
  [ -n "$note" ] && printf '%s\n' "$note"
  [ -n "$tail_text" ] && printf '%s\n' "$tail_text" | sed 's/^/    /'
  [ -n "${PCC_PG_LOG_DIR:-}" ] && printf '%s\n' "$out" > "$PCC_PG_LOG_DIR/$base.txt"
done

echo "==== tests=$TOTAL pass=$PASS fail=$FAIL skipped=$SKIP missing-summary=$MISSING spec-level-red=${#RED[@]} not-reproduced=${#NOT_REPRODUCED[@]} load=$(cut -d' ' -f1-3 /proc/loadavg) on $(nproc) cpus ===="
for r in "${RED[@]:-}"; do [ -n "$r" ] && echo "RED: $r"; done
for r in "${NOT_REPRODUCED[@]:-}"; do [ -n "$r" ] && echo "NOT REPRODUCED: $r"; done
if [ "${#RED[@]}" -gt 0 ]; then exit 1; fi
if [ "${#NOT_REPRODUCED[@]}" -gt 0 ]; then
  echo "==> not a verdict on the branch: ${#NOT_REPRODUCED[@]} spec(s) above were not clean once and were clean the second time. Re-run them alone on a quiet host before believing anything about them."
  exit 3
fi
echo "==> OK"
