-- The coordinator wake vocabulary gains one event: this project holds a loosening edit to its
-- acceptance criteria that nobody has decided yet.
--
-- WHY THE COORDINATOR IS TOLD AT ALL, GIVEN IT CANNOT ANSWER
-- ----------------------------------------------------------
-- It cannot. Approving a looser ruler is the account owner's, through the owner-authenticated
-- channel, for the same reason CONFIRM_ACCEPTANCE_CRITERIA is: the party asking for the ruler to
-- move must not be the party that moves it. What the coordinator conversation is FOR here is that
-- it is the one place a person is already reading — a proposal filed into silence is a proposal
-- nobody knows to answer, and the work it holds up goes on being judged against the old ruler with
-- no one told why.
--
-- WHY IT IS ITS OWN EVENT
-- -----------------------
-- Every other event in this set is a fact about work: an attempt, a task set, a criterion's
-- landing, a revision of evidence. This one is a fact about the RULER, and it is raised by a write
-- that touched no task. Folding it into any of the others would key it on a projection that does
-- not move when a proposal is filed, which is exactly how PROJECT_ACCEPTANCE_LANDED came to need
-- 0246: a fact whose key is a digest of somebody else's rows can be permanently unsendable.
--
-- WHY THE CONSTRAINT IS RESTATED IN FULL RATHER THAN RELAXED
-- ---------------------------------------------------------
-- `project_coordinator_wake.event` is a closed set held by a CHECK and by `COORDINATOR_WAKE_EVENTS`
-- + `RETIRED_COORDINATOR_WAKE_EVENTS` together, with `coordinator-wake.spec.ts` asserting that the
-- three agree exactly. So the whole list is written out here, the way 0183, 0224, 0242 and 0246
-- wrote it out: a spelling that reached the database without appearing in one of those two lists
-- would be a wake nothing in this tree could explain, and that assertion only keeps meaning
-- something if adding an event costs an edit in every place the set is stated.
--
-- The retired half stays accepted for the reason 0224 stated: rows already written say what
-- happened when they were written, and this is an event log rather than a projection to be
-- rewritten.
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
