#!/usr/bin/env bash
# The project integration line, end to end (docs/project-integration-line-contract.md §2, criterion 6).
#
#   bash scripts/acceptance/project-integration-line.sh            # every case
#   bash scripts/acceptance/project-integration-line.sh case_clean_lands_and_dispatches
#   KEEP_SCRATCH=1 bash scripts/acceptance/project-integration-line.sh   # leave the scratch tree
#
# WHAT IT PROVES
# ==============
# That a code task reaching DONE is landed on its project's integration line by the PLATFORM — with
# no agent, no message, and nobody pressing anything — and that the four ways that can go are each
# what the contract says:
#
#   clean          → the branch lands, a receipt records it, and the task waiting downstream is
#                    released (§2.5 J8, J10)
#   conflict       → nothing lands, the target ref is byte-for-byte where it was, and an
#                    INTEGRATION_CONFLICT item names somebody (§2.6, §4.2)
#   checks red     → nothing lands, and an INTEGRATION_CHECK_FAILED item carries the failing
#                    command's exit code and output (§2.4 J-S5)
#   two at once    → they land one after the other, each on a target the other had already moved,
#                    and each one's landed tree is the tree its own checks ran on (§2.1 J1, J2)
#
# The last one is the reason this is an end-to-end script and not a unit test. "The tree that landed
# is the tree that was tested" is only interesting when something else is moving the target
# underneath, and only a real queue, a real runner and a real repository can move it.
#
# WHAT IS REAL AND WHAT IS SEEDED
# ===============================
# Real: the apiserver (production `dist/main.js`), the runner (`go build` of src/runner-go), the
# repositories, the branches, the pushes, and the check commands. Seeded: the rows that say a
# session took a worktree on a branch — producing those through a real engine would mean an LLM, and
# nothing under test is downstream of one. The DONE itself is never seeded: every case drives it
# through `POST /api/tasks/:id/owner-confirmation`, so the enqueue happens in the transaction the
# product itself writes (§2.3 J-T1a).

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/integration-line-fixture.sh
source "$HERE/lib/integration-line-fixture.sh"

# ── case 1: clean ──────────────────────────────────────────────────────────────────────────────

case_clean_lands_and_dispatches() {
  local work origin ws project
  work="$(new_repo clean)"
  origin="$(repo_origin_of clean)"
  ws="$(new_workspace 'clean' "$work" "$origin")"
  project="$(new_project clean "$ws" "$origin")"
  local base; base="$(git -C "$work" rev-parse main)"

  local sha_a; sha_a="$(new_task_branch "$work" task/clean-a a.txt 'from a')"
  local task_a; task_a="$(new_code_task "$project" 'clean A' "$ws" task/clean-a "$base")"
  # A downstream task with an edge onto A: what J10 releases when the receipt commits.
  local task_b; task_b="$(new_code_task "$project" 'clean B' "$ws" task/clean-b "$base")"
  sql "INSERT INTO task_dependency (id, task_id, depends_on_task_id, created_at)
       VALUES (gen_random_uuid(), '$task_b', '$task_a', now())" >/dev/null

  local before; before="$(origin_tip "$origin" refs/heads/project/clean)"
  assert_eq 'the project branch does not exist yet' '' "$before"

  confirm_task_done "$task_a"
  wait_for_job_state "$task_a" LANDED 240

  # The branch really moved, and it holds the task's work.
  local landed; landed="$(origin_tip "$origin" refs/heads/project/clean)"
  [ -n "$landed" ] || fail 'the project branch was not created by the landing'
  assert_eq 'the landed sha is what the job recorded' "$landed" "$(job_column_of "$task_a" landed_sha)"
  git -C "$work" fetch --quiet origin 'refs/heads/project/clean:refs/remotes/origin/project/clean' 2>/dev/null || true
  assert_eq 'the landed commit carries the task file' 'from a' \
    "$(git -C "$work" show "$landed:a.txt" | tr -d '\n')"

  # J2, read off the row rather than asserted about it.
  assert_eq 'the landed tree is the tested tree' \
    "$(job_column_of "$task_a" tested_tree_sha)" "$(job_column_of "$task_a" landed_tree_sha)"

  # J8: the receipt.
  assert_eq 'one MERGED receipt for the landing' 1 \
    "$(sql "SELECT count(*) FROM session_merge_receipt
             WHERE task_id = '$task_a' AND result = 'MERGED' AND target_branch = 'project/clean'" | tr -d '[:space:]')"
  assert_eq 'the receipt names the integration job' 1 \
    "$(sql "SELECT count(*) FROM session_merge_receipt r, project_integration_job j
             WHERE r.task_id = '$task_a' AND j.task_id = '$task_a'
               AND r.detail->>'integrationJobId' = j.id::text" | tr -d '[:space:]')"

  # J10: the landing — not the DONE — is what the downstream task was waiting for. Before the
  # receipt its prerequisite was DONE and unlanded; the platform's own predicate is what answers.
  assert_eq 'the downstream task is now dispatchable' 1 \
    "$(sql "SELECT count(*) FROM task t
             WHERE t.id = '$task_b'
               AND EXISTS (SELECT 1 FROM session_merge_receipt r
                            WHERE r.task_id = '$task_a' AND r.result IN ('MERGED','ALREADY_MERGED')
                              AND r.target_branch = 'project/clean')" | tr -d '[:space:]')"
  assert_eq 'no exception item was opened' 0 \
    "$(sql "SELECT count(*) FROM project_open_item WHERE project_id = '$project'" | tr -d '[:space:]')"
}

# ── case 2: conflict ───────────────────────────────────────────────────────────────────────────

case_conflict_opens_item_target_untouched() {
  local work origin ws project
  work="$(new_repo conflict)"
  origin="$(repo_origin_of conflict)"
  ws="$(new_workspace 'conflict' "$work" "$origin")"
  project="$(new_project conflict "$ws" "$origin")"
  local base; base="$(git -C "$work" rev-parse main)"

  # The project branch already holds a version of the file this task rewrites, from a commit the
  # task branch never saw: a real rebase conflict, not one arranged by touching the same bytes.
  git -C "$work" checkout --quiet -b project/conflict main
  printf 'theirs\n' > "$work/contested.txt"
  git -C "$work" add contested.txt
  git -C "$work" commit --quiet -m 'project branch: contested'
  git -C "$work" push --quiet origin project/conflict
  git -C "$work" checkout --quiet main
  local target_before; target_before="$(origin_tip "$origin" refs/heads/project/conflict)"
  # Read before the case can compare it to itself: "the target did not move" is no assertion at all
  # when the target was never there, and a seeding step that quietly failed would spell that.
  [ -n "$target_before" ] || fail 'the project branch was not seeded'

  new_task_branch "$work" task/conflict contested.txt 'ours' >/dev/null
  local task; task="$(new_code_task "$project" 'conflicting task' "$ws" task/conflict "$base")"

  confirm_task_done "$task"
  wait_for_job_state "$task" CONFLICT 240

  assert_eq 'the target branch did not move' "$target_before" \
    "$(origin_tip "$origin" refs/heads/project/conflict)"
  assert_eq 'the job names the conflicting path' 'contested.txt' \
    "$(sql "SELECT array_to_string(conflicts, ',') FROM project_integration_job WHERE task_id = '$task'" | tr -d '[:space:]')"
  assert_eq 'an INTEGRATION_CONFLICT item is open' 1 \
    "$(sql "SELECT count(*) FROM project_open_item
             WHERE project_id = '$project' AND kind = 'INTEGRATION_CONFLICT' AND state = 'OPEN'" | tr -d '[:space:]')"
  assert_eq 'the item says nothing landed' 'true' \
    "$(sql "SELECT payload->>'nothingLanded' FROM project_open_item
             WHERE project_id = '$project' AND kind = 'INTEGRATION_CONFLICT'" | tr -d '[:space:]')"
  assert_eq 'the item names the job' 1 \
    "$(sql "SELECT count(*) FROM project_open_item i, project_integration_job j
             WHERE i.project_id = '$project' AND j.task_id = '$task' AND i.integration_job_id = j.id" | tr -d '[:space:]')"
  assert_eq 'no receipt was written' 0 \
    "$(sql "SELECT count(*) FROM session_merge_receipt WHERE task_id = '$task'" | tr -d '[:space:]')"
  # J5: the platform does not try again by itself.
  sleep 3
  assert_eq 'no second generation was queued' 1 \
    "$(sql "SELECT count(*) FROM project_integration_job WHERE task_id = '$task'" | tr -d '[:space:]')"
}

# ── case 3: the checks fail on the combined tree ────────────────────────────────────────────────

case_check_failed_opens_item_nothing_lands() {
  local work origin ws project
  work="$(new_repo checks)"
  origin="$(repo_origin_of checks)"
  ws="$(new_workspace 'checks' "$work" "$origin")"
  # The merge check is a controllable script: it fails exactly when the combined tree holds BOTH
  # files, which is a state neither branch is in on its own. That is the thing J-S5 exists to catch
  # — a task that passes its own acceptance in its own worktree and breaks the line when combined.
  project="$(new_project checks "$ws" "$origin" 'test ! -f fuse.txt')"
  local base; base="$(git -C "$work" rev-parse main)"

  git -C "$work" checkout --quiet -b project/checks main
  printf 'quiet\n' > "$work/keep.txt"
  git -C "$work" add keep.txt
  git -C "$work" commit --quiet -m 'project branch: keep'
  git -C "$work" push --quiet origin project/checks
  git -C "$work" checkout --quiet main
  local target_before; target_before="$(origin_tip "$origin" refs/heads/project/checks)"
  [ -n "$target_before" ] || fail 'the project branch was not seeded'

  new_task_branch "$work" task/checks fuse.txt 'blows the merge check' >/dev/null
  local task; task="$(new_code_task "$project" 'task the line rejects' "$ws" task/checks "$base")"

  confirm_task_done "$task"
  wait_for_job_state "$task" CHECK_FAILED 240

  assert_eq 'the target branch did not move' "$target_before" \
    "$(origin_tip "$origin" refs/heads/project/checks)"
  assert_eq 'nothing was recorded as landed' '' "$(job_column_of "$task" landed_sha)"
  assert_eq 'the checks ran on a real combined commit' 1 \
    "$(sql "SELECT CASE WHEN tested_sha IS NOT NULL THEN 1 ELSE 0 END
              FROM project_integration_job WHERE task_id = '$task'" | tr -d '[:space:]')"
  assert_eq 'an INTEGRATION_CHECK_FAILED item is open' 1 \
    "$(sql "SELECT count(*) FROM project_open_item
             WHERE project_id = '$project' AND kind = 'INTEGRATION_CHECK_FAILED' AND state = 'OPEN'" | tr -d '[:space:]')"
  assert_eq 'the item names the failing check' 'MERGE_CHECK' \
    "$(sql "SELECT payload->'check'->>'name' FROM project_open_item
             WHERE project_id = '$project' AND kind = 'INTEGRATION_CHECK_FAILED'" | tr -d '[:space:]')"
  assert_eq 'the item carries its exit code' 1 \
    "$(sql "SELECT payload->'check'->>'exitCode' FROM project_open_item
             WHERE project_id = '$project' AND kind = 'INTEGRATION_CHECK_FAILED'" | tr -d '[:space:]')"
  assert_eq 'no receipt was written' 0 \
    "$(sql "SELECT count(*) FROM session_merge_receipt WHERE task_id = '$task'" | tr -d '[:space:]')"
}

# ── case 4: two tasks finish at once ───────────────────────────────────────────────────────────

case_two_done_serialize_tree_equals_tested() {
  local work origin ws project
  work="$(new_repo serial)"
  origin="$(repo_origin_of serial)"
  ws="$(new_workspace 'serial' "$work" "$origin")"
  # A check that reads the tree it is standing in: it passes only when every file present has this
  # line, so a job that ran its checks on one combination and pushed another would be caught.
  project="$(new_project serial "$ws" "$origin" 'for f in one.txt two.txt; do [ ! -f "$f" ] || grep -q ok "$f"; done')"
  local base; base="$(git -C "$work" rev-parse main)"

  new_task_branch "$work" task/serial-one one.txt 'ok one' >/dev/null
  new_task_branch "$work" task/serial-two two.txt 'ok two' >/dev/null
  local task_one task_two
  task_one="$(new_code_task "$project" 'serial one' "$ws" task/serial-one "$base")"
  task_two="$(new_code_task "$project" 'serial two' "$ws" task/serial-two "$base")"

  # Both DONE before either job is claimed: the queue, not the caller, decides the order.
  confirm_task_done "$task_one"
  confirm_task_done "$task_two"
  wait_for_job_state "$task_one" LANDED 300
  wait_for_job_state "$task_two" LANDED 300

  # J2 on both rows. The second one is the one that matters: its target had already moved.
  for task in "$task_one" "$task_two"; do
    local tested landed
    tested="$(job_column_of "$task" tested_tree_sha)"
    landed="$(job_column_of "$task" landed_tree_sha)"
    [ -n "$tested" ] || fail "job of $task recorded no tested tree"
    assert_eq "landed tree = tested tree ($task)" "$tested" "$landed"
  done

  # J1: they did not overlap. The second job's target-before is the first job's landed sha, which
  # is only true if the second one started after the first one finished.
  local first second
  first="$(sql "SELECT task_id FROM project_integration_job
                 WHERE project_id = '$project' ORDER BY finished_at LIMIT 1" | tr -d '[:space:]')"
  second="$(sql "SELECT task_id FROM project_integration_job
                  WHERE project_id = '$project' ORDER BY finished_at DESC LIMIT 1" | tr -d '[:space:]')"
  [ "$first" != "$second" ] || fail 'both jobs report the same task'
  assert_eq 'the second job started from where the first one landed' \
    "$(job_column_of "$first" landed_sha)" "$(job_column_of "$second" target_sha_before)"

  # And the branch holds both pieces of work, in one line of history.
  local tip; tip="$(origin_tip "$origin" refs/heads/project/serial)"
  git -C "$work" fetch --quiet origin 'refs/heads/project/serial:refs/remotes/origin/project/serial' 2>/dev/null || true
  assert_eq 'the line holds the first task' 'ok one' "$(git -C "$work" show "$tip:one.txt" | tr -d '\n')"
  assert_eq 'the line holds the second task' 'ok two' "$(git -C "$work" show "$tip:two.txt" | tr -d '\n')"
  assert_eq 'two MERGED receipts' 2 \
    "$(sql "SELECT count(*) FROM session_merge_receipt
             WHERE project_id = '$project' AND result = 'MERGED'" | tr -d '[:space:]')"
  assert_eq 'no exception item was opened' 0 \
    "$(sql "SELECT count(*) FROM project_open_item WHERE project_id = '$project'" | tr -d '[:space:]')"
}

# ── the register ───────────────────────────────────────────────────────────────────────────────
# One function per case, listed here. Later tasks append their own (§9.2) and do not edit these.
CASES=(
  case_clean_lands_and_dispatches
  case_conflict_opens_item_target_untouched
  case_check_failed_opens_item_nothing_lands
  case_two_done_serialize_tree_equals_tested
)

main() {
  local selected=("${CASES[@]}")
  [ "$#" -gt 0 ] && selected=("$@")
  trap fixture_teardown EXIT
  fixture_boot
  local failures=0
  for name in "${selected[@]}"; do
    say "case $name"
    if run_case "$name"; then
      printf '    PASS %s\n' "$name"
    else
      printf '    FAIL %s\n' "$name"
      failures=$(( failures + 1 ))
    fi
  done
  if [ "$failures" -ne 0 ]; then
    printf '\n!! %d of %d case(s) failed\n' "$failures" "${#selected[@]}"
    [ -n "$FIX_LOG" ] && printf '   logs: %s\n' "$FIX_LOG"
    return 1
  fi
  printf '\n==> OK: %d case(s)\n' "${#selected[@]}"
}

main "$@"
