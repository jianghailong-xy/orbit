-- 1430: when a scheduled run's undelivered session was last seen held by a full runner, run or batch.
--
-- A run whose session waits for a slot keeps that session until its catch-up deadline instead of being
-- retired after 10 minutes (docs/scheduled-tasks-design.md §7.2). Once the slot frees, the 10-minute
-- undelivered limit counts from the last time the watch pass saw the session held, not from the start.
-- One nullable column; no row is written.
ALTER TABLE "schedule_run" ADD COLUMN "capacity_held_at" TIMESTAMPTZ(3);
