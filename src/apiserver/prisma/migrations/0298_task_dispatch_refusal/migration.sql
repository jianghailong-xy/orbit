-- ══════════════════════════════════════════════════════════════════════════════════════════════
-- A start that was refused before its run could begin becomes a fact on the TASK, and the
-- coordinator wake vocabulary gains the event that tells the project's coordinator about it.
--
-- WHY THIS HAD TO EXIST
-- ---------------------
-- A run whose checkout the runner refuses — its pinned baseline does not contain a prerequisite's
-- landed commit (DEPENDENCY_BASE_NOT_LANDED), the commit is not in the repository, or no worktree
-- can be made on it — gets no engine and ends FAILED with one line in `session.error`. Until now
-- that line was all there was. On 2026-09-23 (project 34Tcl0kralZrY8opuLJU4) a start refused this
-- way left the task OPEN with its `updated_at` where it was, no exception item, and not one
-- `project_coordinator_wake` row: nothing in the system recorded that the project had stopped.
--
-- WHY A COLUMN ON `task`, AND NOT ON THE SESSION
-- ----------------------------------------------
-- The session cannot say it structurally: the refusal is decided at the checkout, AFTER the pin
-- froze, and 0231's freeze guard lets `source_state` leave SELECTED only — PINNED does not become
-- REFUSED. And the reader who has to see it is a reader of the task, the detail and the list, who
-- should not have to find the right session to learn the task could not start.
--
--   dispatch_refusal   jsonb. The `TaskDispatchRefusal` of @orbit/shared: the §10.1 code and its
--                      fixAction, when, which run, the commit it stood on, and the prerequisite
--                      commits that commit did not contain. NULL is "the task's most recent start
--                      was not refused" — which is also every existing row, so nothing is
--                      backfilled. One column rather than several because it is one fact with a
--                      shape the code owns; no statement reads a field of it except the one that
--                      clears it once another run is put on the task.
--
-- WHY THE WAKE CHECK IS RESTATED IN FULL RATHER THAN RELAXED
-- ---------------------------------------------------------
-- For the reason 0250 gives: `project_coordinator_wake.event` is a closed set held by this CHECK
-- and by `COORDINATOR_WAKE_EVENTS` + `RETIRED_COORDINATOR_WAKE_EVENTS` together, and
-- `coordinator-wake.spec.ts` asserts the three agree exactly. The one new spelling is
-- TASK_DISPATCH_REFUSED; the retired half stays accepted because rows already carry it.
--
-- Nothing else moves. ADD COLUMN with no default and no NOT NULL is catalog-only, no function,
-- trigger, type or index is created, altered or dropped, and no row is read or written.

ALTER TABLE "task" ADD COLUMN "dispatch_refusal" JSONB;

ALTER TABLE "project_coordinator_wake"
  DROP CONSTRAINT "project_coordinator_wake_event_chk",
  ADD CONSTRAINT "project_coordinator_wake_event_chk" CHECK ("event" IN (
    'ATTEMPT_ENDED_UNSETTLED',
    'ATTEMPT_BUDGET_SPENT',
    'PROJECT_TASKS_SETTLED',
    'PROJECT_ACCEPTANCE_LANDED',
    'CRITERION_READY',
    'CRITERION_UNLANDED',
    'COMPLETION_EVIDENCE_REVISED',
    'COMPLETION_ACK_STALE',
    'CRITERIA_DECISION_PENDING',
    'TASK_DISPATCH_REFUSED',
    'EXECUTABLE_RESULT_RECORDED',
    'VERIFICATION_VERDICT_RECORDED',
    'EVIDENCE_JUDGMENT_REQUESTED',
    'EVIDENCE_JUDGMENT_DECIDED',
    'EVIDENCE_JUDGMENT_REQUEST_SUPERSEDED',
    'HUMAN_SIGNOFF_REQUESTED',
    'HUMAN_SIGNOFF_DECIDED',
    'HUMAN_SIGNOFF_REQUEST_SUPERSEDED',
    'FAILURE_CONTINUATION_ACTIONABLE'
  ));
