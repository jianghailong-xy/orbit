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
# no agent, no message, and nobody pressing anything — and that the ways that can go are each what
# the contract says:
#
#   clean          → the branch lands, a receipt records it, and the task waiting downstream is
#                    released (§2.5 J8, J10)
#   conflict       → nothing lands, the target ref is byte-for-byte where it was, and an
#                    INTEGRATION_CONFLICT item names somebody (§2.6, §4.2)
#   checks red     → nothing lands, and an INTEGRATION_CHECK_FAILED item carries the failing
#                    command's exit code and output (§2.4 J-S5)
#   two at once    → they land one after the other, each on a target the other had already moved,
#                    and each one's landed tree is the tree its own checks ran on (§2.1 J1, J2)
#   needs JS deps  → the tree the checks run in came out of git and carries no node_modules, so the
#                    platform lays the tree's own recipe down before them: without that, whether a
#                    task passes is a question about the SHAPE of its acceptance command (§2.4 J-S5)
#
# "Two at once" is the reason this is an end-to-end script and not a unit test: "the tree that landed
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
# product itself writes (§2.3 J-T1a). The one case whose check needs JS dependencies borrows this
# checkout's installed `node_modules` for its fixture repository — what an installed checkout has,
# and what the real recipe links from (`new_js_repo` in lib/integration-line-fixture.sh).

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
    "$(sql "SELECT count(*) FROM project_open_item
             WHERE project_id = '$project' AND kind <> 'PROMOTION_APPROVAL'" | tr -d '[:space:]')"
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
  # `kind = 'LAND_TASK'`: since §3 the same project also queues promotion jobs, which finish after
  # these two and carry no task at all — "the newest job of this project" stopped meaning "the
  # second landing" the moment a promotion could be the newest thing in the table.
  local first second
  first="$(sql "SELECT task_id FROM project_integration_job
                 WHERE project_id = '$project' AND kind = 'LAND_TASK'
                 ORDER BY finished_at LIMIT 1" | tr -d '[:space:]')"
  second="$(sql "SELECT task_id FROM project_integration_job
                  WHERE project_id = '$project' AND kind = 'LAND_TASK'
                  ORDER BY finished_at DESC LIMIT 1" | tr -d '[:space:]')"
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
    "$(sql "SELECT count(*) FROM project_open_item
             WHERE project_id = '$project' AND kind <> 'PROMOTION_APPROVAL'" | tr -d '[:space:]')"
}

# ── criterion 7: main sync, and merging the project branch into main ────────────────────────────
#
# Everything below is about the one thing §3 adds to §2: work that has landed on a project branch is
# NOT on main, and what puts it there is the account owner pressing a button. The four ways that can
# go — the branch absorbing main before it integrates, the merge waiting unconfirmed, the merge
# rechecking because main moved under the confirmation, and the merge landing as a merge commit —
# are one case each, plus the projection that reads the result.

# ── case 5: the project branch absorbs main before it integrates (§3.1 M1) ──────────────────────

case_main_sync_merges_upstream_keeps_old_tip() {
  local work origin ws project
  work="$(new_repo mainsync)"
  origin="$(repo_origin_of mainsync)"
  ws="$(new_workspace 'mainsync' "$work" "$origin")"
  project="$(new_project mainsync "$ws" "$origin")"
  local base; base="$(git -C "$work" rev-parse main)"

  # A project branch with a commit of its own, so "the old tip is still an ancestor" is a claim
  # about work somebody did rather than about the commit main was already at.
  git -C "$work" checkout --quiet -b project/mainsync main
  printf 'on the line\n' > "$work/line.txt"
  git -C "$work" add line.txt
  git -C "$work" commit --quiet -m 'project branch: line'
  git -C "$work" push --quiet origin project/mainsync
  git -C "$work" checkout --quiet main
  local old_tip; old_tip="$(origin_tip "$origin" refs/heads/project/mainsync)"
  [ -n "$old_tip" ] || fail 'the project branch was not seeded'

  # main moves AFTER the branch forked from it: the project branch is now behind.
  local new_main; new_main="$(advance_upstream "$work" upstream.txt 'main moved')"
  assert_eq 'main is not yet in the project branch' 'no' "$(is_ancestor_in "$work" "$new_main" "$old_tip")"

  new_task_branch "$work" task/mainsync a.txt 'from a' >/dev/null
  local task; task="$(new_code_task "$project" 'mainsync task' "$ws" task/mainsync "$base")"

  confirm_task_done "$task"
  wait_for_job_state "$task" LANDED 240

  fetch_all "$work"
  local tip; tip="$(origin_tip "$origin" refs/heads/project/mainsync)"
  local sync; sync="$(job_column_of "$task" main_sync_sha)"
  [ -n "$sync" ] || fail 'the job absorbed no upstream commit'

  # M1, in three claims. The absorb commit is a MERGE of the branch as it was and main as it is —
  # so nothing was rewritten and nothing was dropped — and the branch now contains both.
  assert_eq 'the absorb commit has the old tip as its first parent' "$old_tip" \
    "$(git -C "$work" rev-parse "$sync^1")"
  assert_eq 'the absorb commit has main as its second parent' "$new_main" \
    "$(git -C "$work" rev-parse "$sync^2")"
  assert_eq 'the old project tip is still an ancestor' 'yes' "$(is_ancestor_in "$work" "$old_tip" "$tip")"
  assert_eq "main's new commit is now an ancestor too" 'yes' "$(is_ancestor_in "$work" "$new_main" "$tip")"
  assert_eq 'the task landed on top of the absorb commit' 'yes' "$(is_ancestor_in "$work" "$sync" "$tip")"
  assert_eq 'the line holds the task work' 'from a' "$(git -C "$work" show "$tip:a.txt" | tr -d '\n')"
  assert_eq 'no exception item was opened' 0 \
    "$(sql "SELECT count(*) FROM project_open_item
             WHERE project_id = '$project' AND kind <> 'PROMOTION_APPROVAL'" | tr -d '[:space:]')"
}

# ── case 6: nothing reaches main until the owner says so (§3.3 M7, M-F3) ────────────────────────

case_unconfirmed_does_not_merge() {
  local work origin ws project
  work="$(new_repo unconfirmed)"
  origin="$(repo_origin_of unconfirmed)"
  ws="$(new_workspace 'unconfirmed' "$work" "$origin")"
  project="$(new_project unconfirmed "$ws" "$origin" 'test -f README.md')"
  local base; base="$(git -C "$work" rev-parse main)"
  local main_before; main_before="$(origin_tip "$origin" refs/heads/main)"

  new_task_branch "$work" task/unconfirmed a.txt 'from a' >/dev/null
  local task; task="$(new_code_task "$project" 'unconfirmed task' "$ws" task/unconfirmed "$base")"
  confirm_task_done "$task"
  wait_for_job_state "$task" LANDED 240

  # The landing is what makes the candidate: the platform notices the queue is empty and asks.
  wait_for_promotion_state "$project" READY 240
  local promotion; promotion="$(promotion_of "$project")"
  [ -n "$promotion" ] || fail 'no promotion was made for the landed branch'
  assert_eq 'the candidate is the project branch' 'PROJECT_BRANCH' \
    "$(promotion_column_of "$project" source_kind)"
  assert_eq 'the candidate is the tip that landed' "$(job_column_of "$task" landed_sha)" \
    "$(promotion_column_of "$project" source_sha)"
  assert_eq 'the candidate carries the task' 1 \
    "$(sql "SELECT count(*) FROM project_promotion
             WHERE id = '$promotion' AND '$task' = ANY(included_task_ids)" | tr -d '[:space:]')"
  assert_eq 'the check recorded the upstream it passed against' "$main_before" \
    "$(promotion_column_of "$project" upstream_sha_checked)"

  # The whole of the case: main did not move, and nothing says the task is on it.
  assert_eq 'main did not move' "$main_before" "$(origin_tip "$origin" refs/heads/main)"
  assert_eq 'no receipt claims the work is on main' 0 \
    "$(sql "SELECT count(*) FROM session_merge_receipt
             WHERE project_id = '$project' AND target_branch = 'main'" | tr -d '[:space:]')"

  # M-T2: the owner is ASKED. One card, theirs, and no escalation clock on it — there is nobody
  # above the owner for it to escalate to. Producing this row is the push event §3.3 names.
  assert_eq 'one PROMOTION_APPROVAL item is open for the owner' 1 \
    "$(sql "SELECT count(*) FROM project_open_item
             WHERE project_id = '$project' AND kind = 'PROMOTION_APPROVAL'
               AND state = 'OPEN' AND assignee = 'OWNER' AND escalate_at IS NULL" | tr -d '[:space:]')"
  assert_eq 'the card names the promotion' 1 \
    "$(sql "SELECT count(*) FROM project_open_item
             WHERE project_id = '$project' AND kind = 'PROMOTION_APPROVAL'
               AND promotion_id = '$promotion'" | tr -d '[:space:]')"

  # M-F3: an agent holding the owner's credential is still an agent.
  local agent_session refused
  agent_session="$(sql1 "SELECT id FROM session WHERE task_id = '$task' LIMIT 1")"
  refused="$(api_as_session POST "/projects/$project/promotions/$promotion/confirm" "$agent_session" '{}')"
  assert_eq 'an agent session cannot confirm the merge' '403' "$(api_status)"
  assert_eq 'and it is refused by name' 'PROMOTION_OWNER_ONLY' \
    "$(printf '%s' "$refused" | python3 -c 'import json,sys;print(json.load(sys.stdin)["code"])')"
  assert_eq 'the refusal changed nothing' 'READY' "$(promotion_column_of "$project" state)"
  assert_eq 'main still did not move' "$main_before" "$(origin_tip "$origin" refs/heads/main)"
}

# ── case 7: confirmed, then main moved — recheck before landing (§3.3 M5, M-T7) ─────────────────

case_confirm_after_main_moved_rechecks_then_lands() {
  local work origin ws project
  work="$(new_repo recheck)"
  origin="$(repo_origin_of recheck)"
  ws="$(new_workspace 'recheck' "$work" "$origin")"
  # A real merge check, so "it was checked again" is a command that really ran a second time.
  project="$(new_project recheck "$ws" "$origin" 'test -f README.md')"
  local base; base="$(git -C "$work" rev-parse main)"

  new_task_branch "$work" task/recheck a.txt 'from a' >/dev/null
  local task; task="$(new_code_task "$project" 'recheck task' "$ws" task/recheck "$base")"
  confirm_task_done "$task"
  wait_for_job_state "$task" LANDED 240
  wait_for_promotion_state "$project" READY 240

  local promotion checked
  promotion="$(promotion_of "$project")"
  checked="$(promotion_column_of "$project" upstream_sha_checked)"
  [ -n "$checked" ] || fail 'the check recorded no upstream'

  # §3.6: what the card is drawn from names the tasks this merge would carry, by title — a count of
  # them is not what the owner is deciding about.
  local card; card="$(api GET "/projects/$project/promotions/current")"
  assert_eq 'the card names the task this merge would carry' 'recheck task' \
    "$(printf '%s' "$card" | python3 -c 'import json,sys; print(json.load(sys.stdin)["tasks"][0]["title"])')"

  # Main moves between the check and the press — the case §3 exists for.
  local moved_main; moved_main="$(advance_upstream "$work" upstream.txt 'main moved after the check')"
  [ "$moved_main" != "$checked" ] || fail 'main did not actually move'

  confirm_promotion "$project" "$promotion"
  wait_for_promotion_state "$project" MERGED 300

  # M-T7: the upstream moving is a fact about this promotion, not a silent redo.
  local rechecked; rechecked="$(promotion_column_of "$project" rechecked_at)"
  [ -n "$rechecked" ] || fail 'the promotion was never marked as rechecked'
  # §3.6's `recheck.upstreamMovedBy`, and the reason it is the runner's number rather than the
  # control plane's: the commits are in the runner's repository and nowhere else, so the count
  # arrives on the progress report that also moves the promotion to RECHECKING. One commit above.
  assert_eq 'the promotion records how far main moved, counted on the runner' '1' \
    "$(promotion_column_of "$project" upstream_moved_by)"
  assert_eq 'the landing merged onto the upstream that had moved' "$moved_main" \
    "$(promotion_job_column_of "$project" LAND_PROMOTION upstream_sha)"
  assert_eq 'the merge check ran again on the new combination' 1 \
    "$(sql "SELECT count(*) FROM project_integration_job j, jsonb_array_elements(j.checks) c
             WHERE j.project_id = '$project' AND j.kind = 'LAND_PROMOTION'
               AND c->>'name' = 'MERGE_CHECK' AND (c->>'exitCode')::int = 0" | tr -d '[:space:]')"
  assert_eq 'and the promotion now records the upstream it really landed on' "$moved_main" \
    "$(promotion_column_of "$project" upstream_sha_checked)"

  fetch_all "$work"
  local main_after; main_after="$(origin_tip "$origin" refs/heads/main)"
  assert_eq 'the commit main had while this was confirmed is still an ancestor' 'yes' \
    "$(is_ancestor_in "$work" "$moved_main" "$main_after")"
  assert_eq 'the approval card was resolved as approved' 'APPROVED' \
    "$(sql "SELECT resolution FROM project_open_item
             WHERE project_id = '$project' AND kind = 'PROMOTION_APPROVAL'" | tr -d '[:space:]')"
}

# ── case 8: it lands as a merge commit, and the task commits stay ancestors (§3.3 M6, M9) ───────

case_lands_no_ff_task_commits_are_ancestors() {
  local work origin ws project
  work="$(new_repo noff)"
  origin="$(repo_origin_of noff)"
  ws="$(new_workspace 'noff' "$work" "$origin")"
  project="$(new_project noff "$ws" "$origin" 'test -f README.md')"
  local base; base="$(git -C "$work" rev-parse main)"
  local main_before; main_before="$(origin_tip "$origin" refs/heads/main)"

  new_task_branch "$work" task/noff a.txt 'from a' >/dev/null
  local task; task="$(new_code_task "$project" 'noff task' "$ws" task/noff "$base")"
  confirm_task_done "$task"
  wait_for_job_state "$task" LANDED 240
  wait_for_promotion_state "$project" READY 240

  local promotion source_sha task_sha
  promotion="$(promotion_of "$project")"
  source_sha="$(promotion_column_of "$project" source_sha)"
  task_sha="$(job_column_of "$task" landed_sha)"

  confirm_promotion "$project" "$promotion"
  wait_for_promotion_state "$project" MERGED 300

  fetch_all "$work"
  local main_after; main_after="$(origin_tip "$origin" refs/heads/main)"
  assert_eq 'main is where the promotion says it landed' "$main_after" \
    "$(promotion_column_of "$project" merged_sha)"

  # M6: a merge commit, not a fast-forward and not a replay. Two parents, in that order: main as it
  # was, and the project branch as it was confirmed.
  assert_eq "main's tip has two parents" 2 \
    "$(git -C "$work" rev-list --parents -n 1 "$main_after" | wc -w | awk '{print $1 - 1}')"
  assert_eq 'its first parent is where main was' "$main_before" "$(git -C "$work" rev-parse "$main_after^1")"
  assert_eq 'its second parent is the branch that was confirmed' "$source_sha" \
    "$(git -C "$work" rev-parse "$main_after^2")"
  # The claim the whole of M6 is for: the commit the task produced is still in main's history, as
  # itself — a rebase onto main would have replaced it with a copy under another SHA.
  assert_eq "the task's own commit is an ancestor of main" 'yes' \
    "$(is_ancestor_in "$work" "$task_sha" "$main_after")"
  assert_eq 'and main carries its work' 'from a' \
    "$(git -C "$work" show "$main_after:a.txt" | tr -d '\n')"

  # M9: one receipt per task carried, against main, so the landing lane can read it.
  assert_eq 'one MERGED receipt for the task, on main' 1 \
    "$(sql "SELECT count(*) FROM session_merge_receipt
             WHERE task_id = '$task' AND result = 'MERGED' AND target_branch = 'main'" | tr -d '[:space:]')"
  assert_eq 'the receipt names the commit the task landed as' "$task_sha" \
    "$(sql "SELECT source_sha FROM session_merge_receipt
             WHERE task_id = '$task' AND target_branch = 'main'" | tr -d '[:space:]')"
  assert_eq 'and where main ended up' "$main_after" \
    "$(sql "SELECT target_sha_after FROM session_merge_receipt
             WHERE task_id = '$task' AND target_branch = 'main'" | tr -d '[:space:]')"
}

# ── case 9: the project's own status flips on the merge, and not before (§3.5 M10) ──────────────

case_project_done_flips_on_merge() {
  local work origin ws project
  work="$(new_repo doneflip)"
  origin="$(repo_origin_of doneflip)"
  ws="$(new_workspace 'doneflip' "$work" "$origin")"
  project="$(new_project_with_criterion doneflip "$ws" "$origin" 'test -f README.md')"
  local base; base="$(git -C "$work" rev-parse main)"

  new_task_branch "$work" task/doneflip a.txt 'from a' >/dev/null
  local task; task="$(new_code_task "$project" 'doneflip task' "$ws" task/doneflip "$base")"
  declare_task_serves_criterion "$task" "$project"
  confirm_standard_set "$project"

  confirm_task_done "$task"
  wait_for_job_state "$task" LANDED 240
  wait_for_promotion_state "$project" READY 240

  # Everything the projection asks for holds EXCEPT the landing: the task settled by its owner's own
  # confirmation, the standard set is confirmed, and the work is on the project branch.
  assert_eq 'the work is on the integration line' 1 \
    "$(sql "SELECT count(*) FROM session_merge_receipt
             WHERE task_id = '$task' AND target_branch = 'project/doneflip'
               AND result IN ('MERGED','ALREADY_MERGED')" | tr -d '[:space:]')"
  assert_eq 'the task is DONE' 'DONE' \
    "$(sql "SELECT status FROM task WHERE id = '$task'" | tr -d '[:space:]')"
  assert_eq 'and the project is still OPEN, because none of it is on main' 'OPEN' \
    "$(sql "SELECT status FROM project WHERE id = '$project'" | tr -d '[:space:]')"

  local promotion; promotion="$(promotion_of "$project")"
  confirm_promotion "$project" "$promotion"
  wait_for_promotion_state "$project" MERGED 300

  # M10: the receipts the merge wrote are the same edge any other receipt takes, so the projection
  # is recomputed by the landing itself — nothing else has to happen for the status to move.
  wait_for_sql 'the project to be derived DONE' 120 \
    "SELECT status FROM project WHERE id = '$project'" DONE
  assert_eq 'because its criterion now reads as landed on main' 1 \
    "$(sql "SELECT count(*) FROM session_merge_receipt
             WHERE task_id = '$task' AND target_branch = 'main'
               AND result IN ('MERGED','ALREADY_MERGED')" | tr -d '[:space:]')"
}

# ── case 10: a MAIN-line project promotes the task branch itself (§3.4 M-F2, M6, M9) ───────────
#
# A project whose integration line IS main has nowhere to accumulate: the thing that goes onto the
# upstream is the task's own branch, and the platform cannot land it — every merge into main is the
# owner's to confirm. So the DONE makes a CANDIDATE rather than a landing, the candidate is checked
# (the task's acceptance command and the project's merge check, both on the combined tree), and the
# owner is asked. What lands when they say yes is not a merge commit of that branch: the branch is
# rebased onto the upstream tip and the upstream fast-forwards to it, which is the one place M6
# treats the two kinds of source differently.

case_main_line_task_branch_promotion() {
  local work origin ws project
  work="$(new_repo mainline)"
  origin="$(repo_origin_of mainline)"
  ws="$(new_workspace 'mainline' "$work" "$origin")"
  # The merge check sleeps, so the candidate can be read in CHECKING rather than raced for: the
  # queue picks a job up on a heartbeat, and a check that finished in milliseconds would turn the
  # assertion below into a coin toss. The task's own acceptance command is the other half of M-S3,
  # and it passes on the tree this promotion produces.
  project="$(new_main_line_project mainline "$ws" "$origin" 'sleep 8; test -f README.md')"
  local base; base="$(git -C "$work" rev-parse main)"

  local task_sha; task_sha="$(new_task_branch "$work" task/mainline a.txt 'from a')"
  # main moves AFTER the branch forked, so the promotion's rebase has something to replay instead of
  # being the no-op git makes of a branch already sitting on the upstream tip.
  local moved_main; moved_main="$(advance_upstream "$work" upstream.txt 'main moved')"
  assert_eq 'the task branch is behind main' 'no' "$(is_ancestor_in "$work" "$moved_main" "$task_sha")"

  local task
  task="$(new_code_task "$project" 'mainline task' "$ws" task/mainline "$base" 'test -f a.txt')"

  confirm_task_done "$task"

  # M-F2, read while the check is still standing. The DONE queued no landing — there is nowhere on
  # this line to land one — and what it made instead is a candidate for the task's branch, already
  # being checked.
  assert_eq 'the DONE made a candidate' 'TASK_BRANCH' "$(promotion_column_of "$project" source_kind)"
  assert_eq 'and it is being checked' 'CHECKING' "$(promotion_column_of "$project" state)"
  assert_eq 'it offers the task branch' 'refs/heads/task/mainline' \
    "$(promotion_column_of "$project" source_ref)"
  assert_eq 'it would merge into main' 'refs/heads/main' "$(promotion_column_of "$project" upstream_ref)"
  assert_eq 'it names the task it came from' "$task" "$(promotion_column_of "$project" task_id)"
  assert_eq 'a CHECK_PROMOTION job is queued beside it' 1 \
    "$(sql "SELECT count(*) FROM project_integration_job j, project_promotion p
             WHERE j.project_id = '$project' AND j.kind = 'CHECK_PROMOTION'
               AND p.check_job_id = j.id AND j.promotion_id = p.id" | tr -d '[:space:]')"
  # `::text` on a boolean, not psql's `t`: this is the cast's spelling, and the case is asserting a
  # value that came through one.
  assert_eq 'the job names no task of its own' 'true' \
    "$(sql "SELECT (j.task_id IS NULL)::text FROM project_integration_job j, project_promotion p
             WHERE j.project_id = '$project' AND p.check_job_id = j.id" | tr -d '[:space:]')"
  # Nobody has read the repository yet, so nobody has claimed to: the source SHA is resolved by the
  # check that fetches the ref, and a candidate is not allowed to guess it (0293).
  assert_eq 'the candidate names no source commit before it has looked' '' \
    "$(promotion_column_of "$project" source_sha)"
  assert_eq 'and no landing job was queued' 0 \
    "$(sql "SELECT count(*) FROM project_integration_job
             WHERE project_id = '$project' AND kind IN ('LAND_TASK', 'LAND_PROMOTION')" | tr -d '[:space:]')"
  assert_eq 'nothing has reached main' "$moved_main" "$(origin_tip "$origin" refs/heads/main)"

  wait_for_promotion_state "$project" READY 240

  # M-S3: the checks the promotion ran. BOTH of them — a task branch is one task's work arriving on
  # the upstream, so the task's own acceptance command is as much a part of the question as the
  # project's merge check.
  assert_eq 'both checks ran, on the tree it would land' 'MERGE_CHECK:0,TASK_ACCEPTANCE:0' \
    "$(sql "SELECT string_agg(c->>'name' || ':' || COALESCE(c->>'exitCode', 'null'), ','
                              ORDER BY c->>'name')
             FROM project_integration_job j, jsonb_array_elements(j.checks) c
            WHERE j.project_id = '$project' AND j.kind = 'CHECK_PROMOTION'" | tr -d '[:space:]')"
  assert_eq 'the check recorded the upstream it passed against' "$moved_main" \
    "$(promotion_column_of "$project" upstream_sha_checked)"
  # 0293: the check resolved the branch tip and the candidate now names it.
  assert_eq 'the candidate now names the task branch tip' "$task_sha" \
    "$(promotion_column_of "$project" source_sha)"

  # M-T2: the owner is asked, and only the owner. Nothing has moved while they decide (M7).
  assert_eq 'one PROMOTION_APPROVAL item is open for the owner' 1 \
    "$(sql "SELECT count(*) FROM project_open_item
             WHERE project_id = '$project' AND kind = 'PROMOTION_APPROVAL'
               AND state = 'OPEN' AND assignee = 'OWNER'" | tr -d '[:space:]')"
  assert_eq 'main did not move while it waited' "$moved_main" "$(origin_tip "$origin" refs/heads/main)"
  assert_eq 'no receipt claims the work is on main' 0 \
    "$(sql "SELECT count(*) FROM session_merge_receipt
             WHERE project_id = '$project' AND target_branch = 'main'" | tr -d '[:space:]')"

  local promotion; promotion="$(promotion_of "$project")"
  confirm_promotion "$project" "$promotion"
  wait_for_promotion_state "$project" MERGED 300

  fetch_all "$work"
  local tip; tip="$(origin_tip "$origin" refs/heads/main)"
  local landed; landed="$(promotion_job_column_of "$project" LAND_PROMOTION tested_sha)"
  assert_eq 'main is where the promotion says it landed' "$tip" "$(promotion_column_of "$project" merged_sha)"
  # M6 for a task branch: the commit main holds is the one the landing checked — no merge commit
  # carries it, so there is nothing for the tip to be but exactly that commit.
  assert_eq 'main is exactly the commit the landing tested' "$tip" "$landed"
  assert_eq 'the tip is not a merge commit' 1 \
    "$(git -C "$work" rev-list --parents -n 1 "$tip" | wc -w | awk '{print $1 - 1}')"
  assert_eq 'it sits directly on the upstream tip the task was rebased onto' "$moved_main" \
    "$(git -C "$work" rev-parse "$tip^")"
  # The rebase is the point: main gained the task's WORK, not the task's commit. A merge --no-ff
  # would have kept the original as an ancestor, and this measures the difference.
  assert_eq "the task's own commit is not in main — the branch was replayed, not merged" 'no' \
    "$(is_ancestor_in "$work" "$task_sha" "$tip")"
  assert_eq 'and main carries its work' 'from a' "$(git -C "$work" show "$tip:a.txt" | tr -d '\n')"

  # M9: one receipt for the task, against main. Its source is the commit the landing tested, which
  # is what a reader looking for "where did this task's work arrive" has to be able to find.
  assert_eq 'one MERGED receipt for the task, on main' 1 \
    "$(sql "SELECT count(*) FROM session_merge_receipt
             WHERE task_id = '$task' AND result = 'MERGED' AND target_branch = 'main'" | tr -d '[:space:]')"
  assert_eq 'the receipt names the commit that arrived' "$landed" \
    "$(sql "SELECT source_sha FROM session_merge_receipt
             WHERE task_id = '$task' AND target_branch = 'main'" | tr -d '[:space:]')"
  assert_eq 'and where main ended up' "$tip" \
    "$(sql "SELECT target_sha_after FROM session_merge_receipt
             WHERE task_id = '$task' AND target_branch = 'main'" | tr -d '[:space:]')"
  assert_eq 'the approval card was resolved as approved' 'APPROVED' \
    "$(sql "SELECT resolution FROM project_open_item
             WHERE project_id = '$project' AND kind = 'PROMOTION_APPROVAL'" | tr -d '[:space:]')"
}

# ── case 11: an unresolved absorb of upstream holds the queue (M2's second half) ────────────────
#
# A conflict on the absorb is not one task's problem: it is the branch's relationship with main, and
# every later landing would meet exactly the same paths. So the item the first one opened is the
# queue's stop, and it is also the retry mechanism — closing it is what lets the line move again
# (J5: the platform never retries by itself). Without that, a project with ten queued tasks gets ten
# identical cards about one problem, and the coordinator answers the same conflict ten times.

case_main_sync_conflict_holds_the_queue() {
  local work origin ws project
  work="$(new_repo holdqueue)"
  origin="$(repo_origin_of holdqueue)"
  ws="$(new_workspace 'holdqueue' "$work" "$origin")"
  project="$(new_project holdqueue "$ws" "$origin")"
  local base; base="$(git -C "$work" rev-parse main)"

  # A project branch with its own version of a file, and main with another: the absorb conflicts, and
  # it conflicts for EVERY task, because it is the branch that cannot take main's copy.
  git -C "$work" checkout --quiet -b project/holdqueue main
  printf 'line\n' > "$work/contested.txt"
  git -C "$work" add contested.txt
  git -C "$work" commit --quiet -m 'project branch: contested'
  git -C "$work" push --quiet origin project/holdqueue
  git -C "$work" checkout --quiet main

  new_task_branch "$work" task/hold-a a.txt 'from a' >/dev/null
  new_task_branch "$work" task/hold-b b.txt 'from b' >/dev/null
  local task_a task_b
  task_a="$(new_code_task "$project" 'hold A' "$ws" task/hold-a "$base")"
  task_b="$(new_code_task "$project" 'hold B' "$ws" task/hold-b "$base")"
  # main moves after the project branch forked, which is what makes the next landing absorb it.
  printf 'upstream\n' > "$work/contested.txt"
  git -C "$work" add contested.txt
  git -C "$work" commit --quiet -m 'main: contested'
  git -C "$work" push --quiet origin main

  confirm_task_done "$task_a"
  wait_for_job_state "$task_a" CONFLICT 240
  assert_eq 'the absorb is what conflicted' 'MAIN_SYNC' "$(job_column_of "$task_a" phase)"
  assert_eq 'an INTEGRATION_CONFLICT item is open' 1 \
    "$(sql "SELECT count(*) FROM project_open_item
             WHERE project_id = '$project' AND kind = 'INTEGRATION_CONFLICT' AND state = 'OPEN'
               AND COALESCE(payload->>'phase', '') = 'MAIN_SYNC'" | tr -d '[:space:]')"

  confirm_task_done "$task_b"
  wait_for_job_row "$task_b"
  # It is queued and it stays queued: a heartbeat is thirty seconds, so a queue that would take it
  # takes it well inside this window. Nothing here is timing-sensitive in the other direction — a
  # claim that did not happen cannot be hurried.
  sleep 70
  assert_eq 'the later landing is not claimed while the absorb is unresolved' 'QUEUED' \
    "$(job_state_of "$task_b")"
  assert_eq 'nothing has been pushed onto the project branch' \
    "$(git -C "$work" rev-parse project/holdqueue)" "$(origin_tip "$origin" refs/heads/project/holdqueue)"

  # Closing the item is the retry (J5), and the line moves on its own from there.
  sql "UPDATE project_open_item
          SET state = 'RESOLVED', resolution = 'HANDLED', resolved_by = 'COORDINATOR',
              resolved_at = now(), updated_at = now()
        WHERE project_id = '$project' AND kind = 'INTEGRATION_CONFLICT' AND state = 'OPEN'" >/dev/null
  wait_for_job_state "$task_b" CONFLICT 180
  assert_eq 'and it meets the same conflict, as it always would have' 'MAIN_SYNC' \
    "$(job_column_of "$task_b" phase)"
  assert_eq 'the project branch is still exactly where it was' \
    "$(git -C "$work" rev-parse project/holdqueue)" "$(origin_tip "$origin" refs/heads/project/holdqueue)"
}

# ── case 12: a check that needs node_modules, in a tree that came out of git ────────────────────
#
# The false red of 2026-09-21, observed the first time this line ran in production: the combination
# tree is staged from git objects and git carries no `node_modules`, so a task whose acceptance
# command was `cd src/web && npx vitest run …` was judged CHECK_FAILED with
# `Cannot find package '@vitejs/plugin-react'` — a correct implementation refused by the line for the
# SHAPE of its command. A command that runs in the session's own worktree (overlaid) is not one the
# line may refuse, so the platform lays the tree's environment down before the checks: the
# repository's own `scripts/worktree-overlay.sh`, run in the tree (contract §2.4 J-S5).
#
# What the case holds to that, in both directions:
#   * the failing half must fail on vitest's OWN output — an assertion — and not on a package that
#     was not there. That is what separates "the tree was prepared" from "the command happened to
#     fail anyway", and it is why the control command is a real failing spec rather than `false`.
#   * the landing half must LAND, with the check's output showing vitest ran, and land exactly the
#     tree it tested: the recipe writes only gitignored paths, so J-S6a's tree is untouched.
case_js_check_runs_on_the_prepared_tree() {
  local work origin ws project
  work="$(new_js_repo jsdeps)"
  origin="$(repo_origin_of jsdeps)"
  ws="$(new_workspace 'jsdeps' "$work" "$origin")"
  project="$(new_project jsdeps "$ws" "$origin")"
  local base; base="$(git -C "$work" rev-parse main)"

  # ── the landing half ─────────────────────────────────────────────────────────────────────────
  new_task_branch "$work" task/js-ok extra.txt 'from the js task' >/dev/null
  local ok_task
  ok_task="$(new_code_task "$project" 'js ok' "$ws" task/js-ok "$base" \
    'cd src/web && npx vitest run src/lib/sums.test.ts')"

  confirm_task_done "$ok_task"
  wait_for_job_state "$ok_task" LANDED 420

  assert_eq 'the js task landed' 'LANDED' "$(job_state_of "$ok_task")"
  assert_eq 'its acceptance check passed' 'TASK_ACCEPTANCE:0' \
    "$(sql "SELECT string_agg(c->>'name' || ':' || COALESCE(c->>'exitCode', 'null'), ',')
              FROM project_integration_job j, jsonb_array_elements(j.checks) c
             WHERE j.task_id = '$ok_task'" | tr -d '[:space:]')"
  # The check's own output, not merely its exit code: this is vitest's summary, so the command ran
  # against installed dependencies instead of failing on the way in.
  assert_eq 'and vitest really ran in that tree' 'true' \
    "$(sql "SELECT (c->>'outputTail' LIKE '%Test Files%passed%')::text
              FROM project_integration_job j, jsonb_array_elements(j.checks) c
             WHERE j.task_id = '$ok_task' AND c->>'name' = 'TASK_ACCEPTANCE'" | tr -d '[:space:]')"
  assert_eq 'the landed tree is the tested tree' \
    "$(job_column_of "$ok_task" tested_tree_sha)" "$(job_column_of "$ok_task" landed_tree_sha)"
  assert_eq 'one MERGED receipt for the landing' 1 \
    "$(sql "SELECT count(*) FROM session_merge_receipt
             WHERE task_id = '$ok_task' AND result = 'MERGED' AND target_branch = 'project/jsdeps'" | tr -d '[:space:]')"
  assert_eq 'the line holds the task work' 'from the js task' \
    "$(git -C "$work" show "$(origin_tip "$origin" refs/heads/project/jsdeps)":extra.txt | tr -d '\n')"

  # ── the negative control: the same shape, on a spec that really fails ────────────────────────
  local target_before; target_before="$(origin_tip "$origin" refs/heads/project/jsdeps)"
  new_task_branch "$work" task/js-bad other.txt 'x' >/dev/null
  local bad_task
  bad_task="$(new_code_task "$project" 'js bad' "$ws" task/js-bad "$base" \
    'cd src/web && npx vitest run src/lib/broken.test.ts')"

  confirm_task_done "$bad_task"
  wait_for_job_state "$bad_task" CHECK_FAILED 420

  assert_eq 'the target branch did not move' "$target_before" \
    "$(origin_tip "$origin" refs/heads/project/jsdeps)"
  assert_eq 'nothing was recorded as landed' '' "$(job_column_of "$bad_task" landed_sha)"
  assert_eq 'an INTEGRATION_CHECK_FAILED item is open' 1 \
    "$(sql "SELECT count(*) FROM project_open_item
             WHERE project_id = '$project' AND kind = 'INTEGRATION_CHECK_FAILED' AND state = 'OPEN'" | tr -d '[:space:]')"
  assert_eq 'the item names the task acceptance check' 'TASK_ACCEPTANCE' \
    "$(sql "SELECT payload->'check'->>'name' FROM project_open_item
             WHERE project_id = '$project' AND kind = 'INTEGRATION_CHECK_FAILED'" | tr -d '[:space:]')"
  assert_eq 'the item carries the exit code vitest returned' '1' \
    "$(sql "SELECT payload->'check'->>'exitCode' FROM project_open_item
             WHERE project_id = '$project' AND kind = 'INTEGRATION_CHECK_FAILED'" | tr -d '[:space:]')"
  # The heart of the control: the failure it carries is the assertion failing, NOT a dependency that
  # was missing. A tree that was never prepared fails this assertion by saying `Cannot find package`.
  assert_eq 'and it is the spec failing, not a missing package' 'true' \
    "$(sql "SELECT ((payload->'check'->>'outputTail' LIKE '%Test Files%failed%')
                    AND (payload->'check'->>'outputTail' NOT LIKE '%Cannot find package%'))::text
              FROM project_open_item
             WHERE project_id = '$project' AND kind = 'INTEGRATION_CHECK_FAILED'" | tr -d '[:space:]')"
  assert_eq 'the item says the branch is unchanged' 'true' \
    "$(sql "SELECT payload->>'branchUnchanged' FROM project_open_item
             WHERE project_id = '$project' AND kind = 'INTEGRATION_CHECK_FAILED'" | tr -d '[:space:]')"
  assert_eq 'no receipt was written' 0 \
    "$(sql "SELECT count(*) FROM session_merge_receipt WHERE task_id = '$bad_task'" | tr -d '[:space:]')"
}

# ── the register ───────────────────────────────────────────────────────────────────────────────
# One function per case, listed here. Later tasks append their own (§9.2) and do not edit these.
CASES=(
  case_clean_lands_and_dispatches
  case_conflict_opens_item_target_untouched
  case_check_failed_opens_item_nothing_lands
  case_two_done_serialize_tree_equals_tested
  case_main_sync_merges_upstream_keeps_old_tip
  case_unconfirmed_does_not_merge
  case_confirm_after_main_moved_rechecks_then_lands
  case_lands_no_ff_task_commits_are_ancestors
  case_project_done_flips_on_merge
  case_main_line_task_branch_promotion
  case_main_sync_conflict_holds_the_queue
  case_js_check_runs_on_the_prepared_tree
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
