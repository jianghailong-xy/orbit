-- ══════════════════════════════════════════════════════════════════════════════════════════════
-- The coordinator wake vocabulary gains one event: this project is settled and its integration
-- line still carries work of its own that no receipt puts on the upstream.
--
-- WHY THE COORDINATOR IS TOLD
-- ---------------------------
-- Every promotion candidate is made off a landing — `considerCandidate` runs when the queue gets
-- shorter — so a commit that reaches the integration line with no landing behind it is offered to
-- nobody: the job that would have carried it answered ALREADY_LANDED and went terminal while the
-- session's last commit was still being written. Once the project settles, nothing re-reads the
-- line either, because settling is the end of the writes that would have. On 2026-09-23 project
-- 34ODoUKJGEsfbgcJDGS4q was DONE with commit d6b55d2d853f8b2410977674e3ec54c39f52a34e sitting on
-- project/34ODoUKJGEsfbgcJDGS4q and not on main, and not one row anywhere said so. It sat there
-- until a person looked, and a person looking is not a mechanism.
--
-- WORK THAT ANSWERS INSTEAD OF BEING SILENT. The skip itself is left exactly as it is — nothing
-- here loosens a promotion guard — and what is added is the record of what the skip left behind.
--
-- WHY THE WAKE CHECK IS RESTATED IN FULL RATHER THAN RELAXED
-- ---------------------------------------------------------
-- The reason 0183, 0224, 0242, 0246, 0250, 0298 and 0299 gave: `project_coordinator_wake.event`
-- is a closed set held by this CHECK and by `COORDINATOR_WAKE_EVENTS` +
-- `RETIRED_COORDINATOR_WAKE_EVENTS` together, and `coordinator-wake.spec.ts` asserts that the
-- three agree exactly. Writing the whole list out is what keeps that assertion meaning something.
--
-- The one new spelling is PROJECT_SETTLED_UNMERGED. The retired half stays accepted for the reason
-- 0224 stated: rows already written say what happened when they were written, and this is an event
-- log rather than a projection.
--
-- AND WHY IT NAMES AN EVENT THIS BRANCH DOES NOT PRODUCE
-- -----------------------------------------------------
-- DEPENDENT_READY is listed here and in `COORDINATOR_WAKE_EVENTS` although the producer behind it
-- (migration 0299, main) was not on this branch when it was cut. A restatement is a REVOCATION for
-- every spelling it leaves out, and it takes effect on whatever database runs it last: a database
-- that has both 0299 and this file applies them in name order — 0299 first, this one second — so a
-- list without DEPENDENT_READY in it would take that spelling away from a producer that is already
-- writing it, and the next dependent that became ready would fail on this CHECK. Naming it is the
-- same rule every other line of this list follows, read one branch further out.
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
