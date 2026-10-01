-- A human-owned project blocker is its own coordinator notification.
--
-- The landing fact is consumed after it is observed. Reusing that key for the blocker would either
-- duplicate its delivery or leave Automatic with no durable explanation of why it stopped. The new
-- event is keyed by the blocker episode, so one episode gets one message and a later episode gets
-- another. Existing rows are untouched; this only widens the closed event vocabulary.

ALTER TABLE "project_coordinator_wake"
  DROP CONSTRAINT "project_coordinator_wake_event_chk",
  ADD CONSTRAINT "project_coordinator_wake_event_chk" CHECK ("event" IN (
    'ATTEMPT_ENDED_UNSETTLED',
    'ATTEMPT_BUDGET_SPENT',
    'PROJECT_TASKS_SETTLED',
    'PROJECT_ACCEPTANCE_LANDED',
    'CRITERION_READY',
    'CRITERION_UNLANDED',
    'PROJECT_BLOCKER_RAISED',
    'COMPLETION_EVIDENCE_REVISED',
    'COMPLETION_ACK_STALE',
    'CRITERIA_DECISION_PENDING',
    'TASK_DISPATCH_REFUSED',
    'DEPENDENT_READY',
    'PROJECT_SETTLED_UNMERGED',
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
