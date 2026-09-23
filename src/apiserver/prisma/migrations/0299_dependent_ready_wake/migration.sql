-- The coordinator wake vocabulary gains one event: a task that waits on prerequisites can now be
-- started, and it will not start by itself.
--
-- WHY THE COORDINATOR IS TOLD
-- ---------------------------
-- A prerequisite's landing receipt is what releases the work downstream of it (contract §2.5
-- J10), and for a dependent with `auto_run_when_ready = true` the platform then starts it. A
-- dependent with `auto_run_when_ready = false` is one somebody has said must be started by a
-- decision, and until this event nothing told the one conversation that makes those decisions
-- that there was one to make: the dispatch skips it on purpose, and none of the events before
-- this one is about it. On 2026-09-23 a project stood still for hours with its last task
-- startable and its coordinator awake. `DEPENDENT_READY` carries that fact to the coordinator; it
-- starts nothing, because starting is exactly the decision the flag reserves.
--
-- WHY THE CONSTRAINT IS RESTATED IN FULL RATHER THAN RELAXED
-- ---------------------------------------------------------
-- The reason 0183, 0224, 0242, 0246, 0250 and 0298 gave: `project_coordinator_wake.event` is a
-- closed set held by this CHECK and by `COORDINATOR_WAKE_EVENTS` + `RETIRED_COORDINATOR_WAKE_EVENTS`
-- together, and `coordinator-wake.spec.ts` asserts that the three agree exactly. Writing the whole
-- list out is what keeps that assertion meaning something.
--
-- The retired half stays accepted for the reason 0224 stated: rows already written say what
-- happened when they were written, and this is an event log rather than a projection.
--
-- Nothing else moves. No table, column, index, enum, type, trigger or function is created, altered
-- or dropped, and no row is read or written: an event this migration did not previously accept has
-- never been written, so widening the set needs no backfill and can refuse nothing already stored.

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
    'DEPENDENT_READY',
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
