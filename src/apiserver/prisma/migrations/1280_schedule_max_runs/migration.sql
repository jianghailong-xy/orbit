-- 1280 — a schedule's planned end by count, and its one "stopped as planned" push (docs/scheduled-tasks-design.md §8.5).
--
-- WHAT IT ADDS
-- ============
--   * `schedule.max_runs`: the schedule stops after this many runs have started, counted as §4's budget counts them
--     (`started_at` set; a retried undelivered start is the same row). NULL: no planned end by count. At least 1.
--   * `schedule.planned_end_told_at`: when the owner was pushed "Stopped as planned after N runs" for an ENDED
--     (END_REACHED) schedule, or when the worker decided none is sent (a ONCE rule). It is what keeps that push to one;
--     it is bookkeeping, not a setting, and no door writes it.
--
-- BACKWARD COMPATIBLE
-- ===================
-- Two nullable columns with no default. Every schedule already ENDED is marked told, so a deploy pushes nothing about
-- an end that happened before it.
--
-- 1280: the highest number in use on origin/main and the 300 newest remote branches was 1270 on 2026-11-20.

-- AlterTable
ALTER TABLE "schedule" ADD COLUMN "max_runs" INTEGER;
ALTER TABLE "schedule" ADD CONSTRAINT "schedule_max_runs_positive" CHECK ("max_runs" IS NULL OR "max_runs" >= 1);
ALTER TABLE "schedule" ADD COLUMN "planned_end_told_at" TIMESTAMPTZ(3);

UPDATE "schedule" SET "planned_end_told_at" = COALESCE("ended_at", now()) WHERE "state" = 'ENDED';
