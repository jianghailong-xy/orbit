-- The integration job's state set gains one value: `NOTHING_TO_LAND`.
--
-- WHY A STATE OF ITS OWN
-- ----------------------
-- §2.4 J-S3 reaches its answer by asking whether the source tip is an ancestor of the base it is
-- working from. An empty branch passes that trivially — every branch's fork point is in the target
-- it forked from — so a branch that carries nothing of the task's own and a branch whose commits are
-- genuinely already on the target were answered identically: `ALREADY_LANDED`, the positive one. On
-- 2026-09-23 that cost a delivery (project 34Tq39ByZ0rV4c6pJkfw7, task 34TqaiSUMbQfgTGgyTuNK): the
-- landing was queued for a retry session that had died on a 429 with no commit, the line answered
-- `ALREADY_LANDED` about a branch whose tip WAS the upstream, a receipt for a landing that moved
-- nothing was written, and the promotion card counted the task as work the merge did not contain —
-- while the branch that held the work was never offered to the line at all.
--
-- `NOTHING_TO_LAND` is that answer said on its own: the branch the line was handed carried nothing
-- of the task's. It is not a failure (nothing went wrong with the landing — there was no landing to
-- do) and not a landing (nothing was pushed), which is why it is a state and not an error code, and
-- why nothing is opened for it: `openItemKindForJobState` deliberately answers null.
--
-- WHY THE CONSTRAINT IS RESTATED IN FULL RATHER THAN RELAXED
-- ---------------------------------------------------------
-- The reason 0183, 0224, 0242, 0246, 0250, 0298 and 0299 gave: `project_integration_job.state` is a
-- closed set held by this CHECK and by `INTEGRATION_JOB_STATES` together, and the two have to move as
-- one — a state the database refuses is a result the runner reports and the API server cannot record.
-- Writing the whole list out is what keeps the two compilable-and-checkable against each other.
--
-- Nothing else moves. No table, column, index, type, trigger or function is created, altered or
-- dropped, and no row is read or written: a state this migration did not previously accept has never
-- been written, so widening the set needs no backfill and can refuse nothing already stored. Rows
-- already carrying `ALREADY_LANDED` go on saying what the line said when it said it.

ALTER TABLE "project_integration_job"
  DROP CONSTRAINT "project_integration_job_state_chk",
  ADD CONSTRAINT "project_integration_job_state_chk" CHECK ("state" IN (
    'QUEUED', 'RUNNING', 'LANDED', 'ALREADY_LANDED', 'NOTHING_TO_LAND', 'READY',
    'CONFLICT', 'CHECK_FAILED', 'ERROR', 'CANCELLED', 'SUPERSEDED'));
