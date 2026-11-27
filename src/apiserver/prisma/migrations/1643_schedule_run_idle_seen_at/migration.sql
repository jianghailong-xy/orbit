-- 1643: when the watch pass first found a delivered scheduled run's session idle with nothing to wake it.
--
-- A job's end is reported before the wake it files, so a session can read idle for a moment while work is still
-- coming back to it. The run is failed NO_REPORT only once it has read idle for a settle time counted from here
-- (docs/scheduled-tasks-design.md §7.1); any other reading clears it. One nullable column; no row is written.
ALTER TABLE "schedule_run" ADD COLUMN "idle_seen_at" TIMESTAMPTZ(3);
