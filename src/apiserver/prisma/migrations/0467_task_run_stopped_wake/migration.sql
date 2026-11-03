-- A task's run that stopped working, with its task unsettled and no evidence waiting for a decision,
-- is its own coordinator notification.
--
-- Nothing in the wake vocabulary said so: `ATTEMPT_ENDED_UNSETTLED` needs a run that is over, and a
-- run that stops parks at AWAITING_INPUT. The new event is keyed by what ended, so one stop gets one
-- message and a later stop gets another. Existing rows are untouched; this only widens the closed
-- event vocabulary.

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
    'TASK_RUN_STOPPED',
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
