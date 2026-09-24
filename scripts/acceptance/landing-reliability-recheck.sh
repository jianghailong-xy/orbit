#!/usr/bin/env bash
# Criterion 5 of project 34TsjwkAMVVkeEUwi2IAJ, re-checked on ONE tree: the two landing incidents of
# 2026-09-23 are each covered by a rule, and the specs that pin them pass together.
#
#   bash scripts/acceptance/landing-reliability-recheck.sh
#
# THE TWO INCIDENTS, AS THIS DEPLOYMENT RECORDED THEM (UTC, 2026-09-23)
# =====================================================================
# 789a8fffc — a landing judged before the work it was about had stopped moving.
#   15:32:33      789a8fffc committed on orbit/autorun-false-91f94d by the work session 54387e56…
#   15:38:27.920  the DONE queues LAND_TASK 0a443775…, frozen onto the one-turn RETRY's branch
#                 orbit/autorun-false-830a9b, whose tip was the project tip 3fc8f2800
#   15:39:18.325  that job's finished_at: ALREADY_LANDED (source = target_before = 3fc8f2800)
#   15:42:00.488  the work session's finished_at — 2m42.163s after the judgment
#   Covered by task-landing-races-final-commit.pg.spec.ts, case (2).
#
# d6b55d2d8 — the same work, hand-picked onto the project line, left there when the project settled.
#   15:41:51      d6b55d2d8: 789a8fffc committed again on the same parent (same tree, same patch-id)
#   15:44:50.303  receipt MERGED 789a8fffc -> project/34ODoUKJGEsfbgcJDGS4q, after = d6b55d2d8,
#                 while the project was still open
#   15:54:08      c125e11c6: the same patch pushed onto main BY HAND (its receipt 15:54:26)
#   17:00:12.409  the project settles (PROJECT_ACCEPTANCE_LANDED); d6b55d2d8 is still its line's tip,
#                 and it has never been an ancestor of main
#   Covered by project-settled-unpromoted-work.pg.spec.ts, case (1) (the receipt arrives on a settled
#   project) and case (5) (the project settles with the commit already on its line — the incident's
#   own order). What kept the incident's real rows quiet is the hand replay: that is case (2).
#
# WHAT IT CHECKS
# ==============
#   1. the commits by CONTENT — a landing rebases, so the same work never has the same sha twice;
#      patch-ids are what is compared
#   2. the ordering above, off the deployment's database, in read-only transactions
#   3. both specs compiled once and run in one go on this tree, with zero skips, and every case named
#      above among the passes — a green exit is not taken as proof that those cases ran
#
# 789a8fffc exists only in this host's repository (on a local branch) and the rows only in this
# host's database, so this is a recheck for this host, not a CI job. It writes nothing to that
# database: the specs run against the throwaway PostgreSQL scripts/run-pg-spec.sh creates.
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO" || exit 2

RACED=789a8fffc0bf0223efe8d8286ed5fcae2cb6c414         # the commit the work session made
LINE_TIP=d6b55d2d853f8b2410977674e3ec54c39f52a34e      # the same work on the project line
REPLAYED=c125e11c674a6dc58b7d6740ec3fac30f8cf783d      # the same work, pushed onto main by hand
MAIN_BEFORE=04c0a00e85c4d3401160568284eb9cdcc53b66b5   # main when the hand replay was made
LINE=refs/remotes/origin/project/34ODoUKJGEsfbgcJDGS4q
UPSTREAM=refs/remotes/origin/main
PG_CONTAINER=orbit-postgres

RACE_SPEC=src/apiserver/src/tasks/task-landing-races-final-commit.pg.spec.ts
SETTLED_SPEC=src/apiserver/src/projects/project-settled-unpromoted-work.pg.spec.ts
CASES=(
  'a landing is not judged before the work it is about has stopped moving'
  '(2) 789a8fffc: the landing is held, then re-queued onto the branch the work ended on'
  '(1) a settled project whose line carries d6b55d2d8 tells its coordinator, naming that commit'
  '(2) a receipt that lands the same work on main wakes nobody'
  '(5) the completion that settles a project whose line already carries d6b55d2d8 tells its coordinator'
)

RED=()
check() { # <what> <command...>: one line per fact; every failing one is repeated at the end
  local what="$1"; shift
  if "$@"; then echo "  ok   $what"; else echo "  RED  $what"; RED+=("$what"); fi
}
not() { ! "$@"; }
same() { [ "$1" = "$2" ]; }
patch_id() { git show "$1" | git patch-id --stable | cut -d' ' -f1; }
cherry_mark() { git cherry "$1" "$2" | awk -v c="$2" '$2 == c { print $1 }'; }

echo "==> the tree: HEAD $(git rev-parse HEAD), tree $(git rev-parse 'HEAD^{tree}'),"\
     "$(git status --porcelain | wc -l | tr -d ' ') uncommitted path(s)"

# --- 1. the commits, by content -----------------------------------------------------------------
echo "==> 1. the commits, by content"
for c in "$RACED" "$LINE_TIP" "$REPLAYED" "$MAIN_BEFORE"; do
  git cat-file -e "$c^{commit}" 2>/dev/null ||
    { echo "no $c here: run this in the deployment host's clone, after a git fetch" >&2; exit 2; }
done
git rev-parse -q --verify "$LINE" >/dev/null || { echo "no $LINE: git fetch origin first" >&2; exit 2; }
PID="$(patch_id "$RACED")"
for c in "$RACED" "$LINE_TIP" "$REPLAYED"; do
  echo "     $c committed $(git log -1 --format=%cI "$c"), patch-id $(patch_id "$c")"
done
check "$LINE_TIP carries the patch of $RACED" same "$(patch_id "$LINE_TIP")" "$PID"
check "$REPLAYED carries the patch of $RACED" same "$(patch_id "$REPLAYED")" "$PID"
check "$LINE_TIP is $RACED on the same parent: same tree, only the commit differs" \
  same "$(git rev-parse "$RACED^{tree}" "$RACED^")" "$(git rev-parse "$LINE_TIP^{tree}" "$LINE_TIP^")"
check "$LINE_TIP is on ${LINE#refs/remotes/}" git merge-base --is-ancestor "$LINE_TIP" "$LINE"
check "$LINE_TIP is not an ancestor of main" not git merge-base --is-ancestor "$LINE_TIP" "$UPSTREAM"
check "git cherry $MAIN_BEFORE $LINE_TIP = + (main before the hand replay)" \
  same "$(cherry_mark "$MAIN_BEFORE" "$LINE_TIP")" +
check "git cherry origin/main $LINE_TIP = - today" same "$(cherry_mark "$UPSTREAM" "$LINE_TIP")" -
check "because $REPLAYED, the hand replay, is on main" git merge-base --is-ancestor "$REPLAYED" "$UPSTREAM"

# --- 2. the ordering, off the deployment's database ---------------------------------------------
echo "==> 2. the ordering, off $PG_CONTAINER (read-only)"
ROWS="$(docker exec -i -e PGOPTIONS='-c default_transaction_read_only=on -c TimeZone=UTC' "$PG_CONTAINER" \
  psql -U orbit -d orbit -X -v ON_ERROR_STOP=1 -tA -F ' ' <<SQL
WITH job AS (SELECT * FROM project_integration_job WHERE id = '0a443775-3288-4518-8f9d-ab7affa74d6a'),
     work AS (SELECT * FROM session WHERE id = '54387e56-681a-5824-ba14-cf89966932f8'),
     onto_line AS (SELECT min(created_at)::timestamptz AS at FROM session_merge_receipt
                    WHERE source_sha = '$RACED' AND result = 'MERGED' AND target_sha_after = '$LINE_TIP'
                      AND target_branch = '${LINE#refs/remotes/origin/}'),
     settled AS (SELECT min(w.created_at)::timestamptz AS at FROM project_coordinator_wake w, onto_line
                  WHERE w.project_id = '01a09bd1-405c-751d-b04e-69bedefeb70c'
                    AND w.event = 'PROJECT_ACCEPTANCE_LANDED' AND w.created_at > onto_line.at)
SELECT 'judged', job.state, job.source_ref, to_char(job.finished_at, 'HH24:MI:SS.MS"Z"') FROM job
UNION ALL SELECT 'work_finished', work.status::text, work.worktree_branch,
                 to_char(work.finished_at::timestamptz, 'HH24:MI:SS.MS"Z"') FROM work
UNION ALL SELECT 'onto_line', '-', '-', to_char(onto_line.at, 'HH24:MI:SS.MS"Z"') FROM onto_line
UNION ALL SELECT 'settled', '-', '-', to_char(settled.at, 'HH24:MI:SS.MS"Z"') FROM settled
UNION ALL SELECT 'work_finished_after_judgment', (work.finished_at::timestamptz - job.finished_at)::text,
                 '-', '-' FROM job, work WHERE work.finished_at::timestamptz > job.finished_at
UNION ALL SELECT 'line_before_settled', (settled.at - onto_line.at)::text, '-', '-'
            FROM onto_line, settled WHERE onto_line.at < settled.at;
SQL
)" || { echo "could not read $PG_CONTAINER: this recheck needs the deployment's database" >&2; exit 2; }
printf '%s\n' "$ROWS" | sed 's/^/     /'
row() { printf '%s\n' "$ROWS" | awk -v k="$1" '$1 == k'; }
check "the landing was judged ALREADY_LANDED about the retry's branch" \
  same "$(row judged | cut -d' ' -f2-3)" "ALREADY_LANDED refs/heads/orbit/autorun-false-830a9b"
check "the work session ended on the branch $RACED is on" \
  same "$(row work_finished | cut -d' ' -f3)" orbit/autorun-false-91f94d
check "and it finished after that judgment: the work had not stopped moving" \
  test -n "$(row work_finished_after_judgment)"
check "$LINE_TIP reached the line before the project settled" test -n "$(row line_before_settled)"

# --- 3. both specs, one build of this tree ------------------------------------------------------
echo "==> 3. both specs, compiled once and run in one go on this tree"
check "the race spec pins $RACED" grep -qF "'$RACED'" "$RACE_SPEC"
check "the settled spec pins $RACED" grep -qF "'$RACED'" "$SETTLED_SPEC"
check "the settled spec pins $LINE_TIP" grep -qF "'$LINE_TIP'" "$SETTLED_SPEC"
LOG="$(mktemp -t landing-reliability-recheck.XXXXXX)"
NODE_OPTIONS="${NODE_OPTIONS:---max-old-space-size=1536}" \
  bash scripts/run-pg-spec.sh "$RACE_SPEC" "$SETTLED_SPEC" >"$LOG" 2>&1
rc=$?
grep -E '^==== |^RED:' "$LOG" | sed 's/^/     /'
check "scripts/run-pg-spec.sh exited 0: no failure, no skip (log: $LOG)" same "$rc" 0
PASSED="$(sed -nE 's/^[[:space:]]*ok [0-9]+ - //p' "$LOG")"
for name in "${CASES[@]}"; do
  check "passed: $name" grep -qFx -- "$name" <<<"$PASSED"
done

for r in ${RED[@]+"${RED[@]}"}; do echo "RED: $r"; done
[ "${#RED[@]}" -gt 0 ] && exit 1
echo "==> OK: both incidents are covered, on tree $(git rev-parse 'HEAD^{tree}')"
