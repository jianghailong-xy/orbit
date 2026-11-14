-- 0810 — starting and retrying a scheduled task's run (docs/scheduled-tasks-design.md §6, §7.2).
--
-- WHAT IT ADDS
-- ============
--   * `schedule_run.not_before_at`: a QUEUED run is not started before this instant. NULL starts it as soon as the
--     run ahead of it ends; a retry of a run that never reached its engine waits 1, 5 and then 15 minutes.
--   * `schedule_run.held_reason`: why a HELD run's start checks failed (§6.1). `failure_reason` stays the closed set
--     of §7.2 for FAILED and CANCELLED runs.
--   * `schedule_run_queued_idx`: what the starter reads, the QUEUED runs, oldest slot first.
--
-- BACKWARD COMPATIBLE
-- ===================
-- Two nullable columns with no default and one partial index on a table no release before 0790 has: no stored row
-- is rewritten or backfilled.
--
-- 0810: the highest number in use on main, every origin/project/* and origin/orbit/* branch and the local branches
-- was 0800 (2026-11-15).

ALTER TABLE "schedule_run" ADD COLUMN "not_before_at" TIMESTAMPTZ(3);
ALTER TABLE "schedule_run" ADD COLUMN "held_reason" TEXT;
CREATE INDEX "schedule_run_queued_idx" ON "schedule_run" ("planned_at") WHERE "state" = 'QUEUED';
