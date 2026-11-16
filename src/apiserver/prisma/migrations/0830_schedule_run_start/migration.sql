-- 0830 — starting and retrying a scheduled task's run (docs/scheduled-tasks-design.md §6, §7.2).
--
-- WHAT IT ADDS
-- ============
--   * `schedule_run.not_before_at`: a QUEUED run is not started before this instant. NULL starts it as soon as the
--     run ahead of it ends; a retry of a run that never reached its engine waits 1, 5 and 15 minutes, then an hour.
--   * `schedule_run.held_reason`: why a HELD run's start checks failed (§6.1). `failure_reason` stays the closed set
--     of §7.2 for FAILED, MISSED and CANCELLED runs.
--   * `schedule_run_queued_idx`: what the starter reads, the QUEUED runs, oldest slot first.
--   * `session.opened_by` gains 'SCHEDULE' (0670's check): a run's session is opened by the schedule starter, not
--     by a person, so it must not become the workspace default a person's next session is preselected on.
--
-- BACKWARD COMPATIBLE
-- ===================
-- Two nullable columns with no default and one partial index on a table no release before 0790 has: no stored row
-- is rewritten or backfilled. The opened_by check is widened, never narrowed: re-added NOT VALID inside the
-- transaction (catalog-only, as 0670 did) and validated after the COMMIT, which scans without blocking writes.
--
-- 0830: renumbered from 0810 when 0810 (0810_coordinator_handoff) and 0820 (0820_github_app_connection) were taken
-- on other branches; the highest number in use on the local branches, origin/main, every origin/project/* and
-- origin/orbit/* branch was 0820 (2026-11-15).
BEGIN;

ALTER TABLE "schedule_run" ADD COLUMN "not_before_at" TIMESTAMPTZ(3);
ALTER TABLE "schedule_run" ADD COLUMN "held_reason" TEXT;
CREATE INDEX "schedule_run_queued_idx" ON "schedule_run" ("planned_at") WHERE "state" = 'QUEUED';

ALTER TABLE "session" DROP CONSTRAINT "session_opened_by_check";
ALTER TABLE "session" ADD CONSTRAINT "session_opened_by_check"
  CHECK ("opened_by" IN (
    'PERSON',
    'COORDINATOR',
    'COORDINATOR_JUDGMENT',
    'TASK_LIST_CONSOLE',
    'WIKI_CHAT',
    'FEISHU',
    'SERVICE_TOKEN',
    'MENTION_REPLY',
    'ORBIT',
    'SCHEDULE'
  )) NOT VALID;

COMMIT;

ALTER TABLE "session" VALIDATE CONSTRAINT "session_opened_by_check";
