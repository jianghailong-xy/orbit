-- The coordinator wake vocabulary gains one event: a project whose every task is terminal AND
-- whose every stated criterion is satisfied with its work on the default branch.
--
-- WHY THIS IS A NEW EVENT RATHER THAN A SECOND READING OF `PROJECT_TASKS_SETTLED`
-- ------------------------------------------------------------------------------
-- `PROJECT_TASKS_SETTLED` is keyed on a digest of the project's `(task_id, status)` pairs and on
-- nothing else, which is the correct identity for what it says. Merge receipts are written by
-- paths the task write path does not touch, so the order they arrive in is: the last task settles
-- while the work is still on a branch, that fact is derived and spent, and the receipt lands
-- afterwards with no task write near it. The roster has flipped and the digest has not moved, so
-- re-deriving reaches the key already spent and the confirmation card can never be sent.
--
-- Folding the receipts into the settlement digest was rejected and stays rejected — it would make
-- PARTIAL landing a second fact about one unfinished situation. This event admits no partial
-- state: every criterion satisfied and landed, or the fact does not exist. So it spends no key
-- early, and the moment the last receipt arrives it derives one nothing has claimed.
--
-- WHY THE CONSTRAINT IS RESTATED IN FULL RATHER THAN RELAXED
-- ---------------------------------------------------------
-- `project_coordinator_wake.event` is a closed set held by a CHECK and by `COORDINATOR_WAKE_EVENTS`
-- + `RETIRED_COORDINATOR_WAKE_EVENTS` together, with `coordinator-wake.spec.ts` asserting that the
-- three agree exactly. So the whole list is written out here, the way 0183, 0224 and 0242 wrote it
-- out: a spelling that reached the database without appearing in one of those two lists would be a
-- wake nothing in this tree could explain, and the only way that assertion can keep meaning
-- something is if adding an event costs an edit in every place the set is stated.
--
-- The retired half stays accepted for the reason 0224 stated: rows already written say what
-- happened when they were written, and this is an event log rather than a projection to be
-- rewritten.
--
-- Nothing else moves. No table, column, index, enum, type, trigger or function is created, altered
-- or dropped, and no row is read or written: an event this migration did not previously accept has
-- never been written, so widening the set needs no backfill and can refuse nothing that is already
-- stored.

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
