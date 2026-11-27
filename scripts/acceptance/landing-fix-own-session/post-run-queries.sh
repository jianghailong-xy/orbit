#!/usr/bin/env bash
# Read-only queries of one finished run of cases.mjs (default_transaction_read_only=on through stack.sh psql): the
# project's LAND_TASK jobs, its open items, and the conversation_turn rows of the three tasks' work sessions and of the
# coordinator, each of the three outcomes in its own block.
#
#   bash scripts/acceptance/landing-fix-own-session/post-run-queries.sh <run>     # <run> = the LM_RUN of the run
set -euo pipefail
HERE=$(cd -P "$(dirname "${BASH_SOURCE[0]}")" && pwd)
export LM_PROJECT=${LM_PROJECT:-orbit-link-lfx42} LM_DIR=${LM_DIR:-/mnt/tmp/tmp/lfx42}
RUN=${1:?usage: post-run-queries.sh <run>}
case "$RUN" in *[!A-Za-z0-9_-]*) echo "a run tag is letters, digits, - and _" >&2; exit 2 ;; esac
source "$HERE/../../lib/session-word.sh"
q() { echo; echo "### $1"; bash "$HERE/../landing-measured/stack.sh" psql "$2" x; }
P="(select id from project where title like '%($RUN)')"
T() { echo "(select id from task where project_id = $P and title like '$1 %')"; }
J1() { echo "(select id from project_integration_job where task_id = $(T "$1") and kind = 'LAND_TASK' and state in ('CONFLICT', 'CHECK_FAILED') order by generation limit 1)"; }
S() { echo "(select session_id from project_integration_job where id = $(J1 "$1"))"; }
X=$(bash "$HERE/../landing-measured/stack.sh" psql "select split_part(t.title, ' ', 1) from project_integration_job j join task t on t.id = j.task_id where j.project_id = $P and j.kind = 'LAND_TASK' and j.state = 'CONFLICT' and t.title like 'F%'" | sed -n 3p | tr -d ' ')
Y=$(bash "$HERE/../landing-measured/stack.sh" psql "select split_part(t.title, ' ', 1) from project_integration_job j join task t on t.id = j.task_id where j.project_id = $P and j.kind = 'LAND_TASK' and j.state = 'CONFLICT' and t.title like 'H%'" | sed -n 3p | tr -d ' ')
echo "run $RUN: project $(bash "$HERE/../landing-measured/stack.sh" psql "select id, title from project where id = $P" | sed -n 3p)"
echo "case 1 conflicted task: $X; case 2 conflicted task: $Y; case 3 task: R"
COORD="(select coordinator_session_id from project where id = $P)"

q "every LAND_TASK of the project (project_integration_job)" "select t.title as task, j.id, j.generation, j.state, j.phase, j.conflicts, j.baseline_red,
  j.session_id, j.source_sha, j.landed_sha, j.retry_of_job_id, j.retry_failure_class, j.retry_reason, j.retry_requested_by_session_id,
  j.finished_at from project_integration_job j join task t on t.id = j.task_id where j.project_id = $P and j.kind = 'LAND_TASK' order by j.created_at"
q "every open item of the project (project_open_item)" "select i.kind, i.state, i.assignee, t.title as task, i.integration_job_id, i.payload->>'failureClass' as failure_class,
  i.work_session_id, i.work_session_offered_at, i.work_session_returned_at, i.work_session_return_reason,
  i.payload->'workSession' as work_session_payload, i.resolution, i.resolved_by_session_id, i.handling_job_id, i.escalate_at, i.resolved_at
from project_open_item i left join task t on t.id = i.task_id where i.project_id = $P and i.kind <> 'START_REQUEST' order by i.created_at"

echo; echo "======== case 1: $X's conflict, fixed by its own session, landed with no coordinator turn"
q "conversation_turn of $X's work session" "select seq, client_turn_id, kind, status, created_at, answered_at, left(content, 120) as content_head
from conversation_turn where session_id = $(S "$X") order by seq"
q "coordinator turns between $X's conflict and the landing that fixed it" "select count(*) as coordinator_turns,
  (select finished_at from project_integration_job where id = $(J1 "$X")) as conflict_finished_at,
  (select finished_at from project_integration_job where retry_of_job_id = $(J1 "$X")) as fixed_landing_finished_at
from conversation_turn where session_id = $COORD
  and created_at > (select finished_at from project_integration_job where id = $(J1 "$X"))
  and created_at <= (select finished_at from project_integration_job where retry_of_job_id = $(J1 "$X"))"

echo; echo "======== case 2: $Y's fix turn ended without a commit; handed back with what it said"
q "conversation_turn of $Y's work session" "select seq, client_turn_id, kind, status, created_at, answered_at, left(content, 120) as content_head
from conversation_turn where session_id = $(S "$Y") order by seq"
q "the coordinator's turns after the hand-back that quote $Y's session" "select t.seq, t.client_turn_id, t.created_at, left(t.content, 400) as content_head,
  position(i.payload->'workSession'->>'lastMessage' in t.content) > 0 as quotes_the_session
from conversation_turn t, project_open_item i
where t.session_id = $COORD and i.integration_job_id = $(J1 "$Y") and t.created_at >= i.work_session_returned_at order by t.seq"

echo; echo "======== case 3: R's baseline-red landing never reached R's session"
q "conversation_turn of R's work session" "select seq, client_turn_id, kind, status, created_at, answered_at, left(content, 120) as content_head
from conversation_turn where session_id = $(S R) order by seq"
q "R's session against its landing" "select $(session_word_sql s) as status, s.end_reason, s.finished_at, j.finished_at as landing_finished_at,
  (select count(*) from conversation_turn c where c.session_id = s.id and c.client_turn_id like 'landing-fix:v1:%') as landing_fix_turns,
  (select count(*) from conversation_turn c where c.session_id = s.id and c.created_at > j.finished_at) as turns_after_landing
from session s, project_integration_job j where s.id = $(S R) and j.id = $(J1 R)"
q "the coordinator's turns about R's landing" "select seq, client_turn_id, created_at, left(content, 300) as content_head from conversation_turn
where session_id = $COORD and created_at > (select finished_at from project_integration_job where id = $(J1 R))
  and (position('LINE_RED.md' in content) > 0 or position('R lands after main went red' in content) > 0) order by seq"

echo; echo "======== the engine"
q "the sessions of the project and the engine they ran on" "select coalesce(t.title, 'coordinator') as task, s.id, s.provider, s.engine, s.model, $(session_word_sql s) as status, s.end_reason
from session s left join task t on t.id = s.task_id where s.task_id in (select id from task where project_id = $P) or s.id = $COORD order by s.created_at"
q "the provider and the runner's engines" "select p.slug, p.preset_slug, p.base_url, r.name as runner, r.version, r.engines->0 as claude
from model_provider p, runner r where p.slug = 'deepseek' and r.name = 'lm42-runner'"
