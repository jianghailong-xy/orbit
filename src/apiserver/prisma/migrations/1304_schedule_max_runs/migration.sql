-- 1304 — a schedule's planned end by count, and its one "stopped as planned" push (docs/scheduled-tasks-design.md §8.5).
--
-- WHAT IT ADDS
-- ============
--   * `schedule.max_runs`: the schedule stops after this many runs have started, counted as §4's budget counts them
--     (`started_at` set; a retried undelivered start is the same row). NULL: no planned end by count. At least 1.
--   * `schedule.planned_end_told_at`: when the owner was pushed "Stopped as planned after N runs" for an ENDED
--     (END_REACHED) schedule, or when the worker decided none is sent (a ONCE rule). It is what keeps that push to one;
--     it is bookkeeping, not a setting, and no door writes it.
--   * Two partial indexes: `schedule_planned_end_untold_idx`, the ENDED (END_REACHED) schedules not yet told, which
--     the worker reads every pass the way `schedule_due_idx` serves its firing; and `schedule_run_started_idx`, a
--     schedule's started runs, which the list counts for every row it shows and a start counts against max_runs.
--
-- BACKWARD COMPATIBLE
-- ===================
-- Two nullable columns with no default. Every schedule already ENDED is marked told, so a deploy pushes nothing about
-- an end that happened before it.
--
-- 1304: the highest number in use on origin/main, the 400 newest branches and every session worktree on this host was
-- 1290 on 2026-11-20 (1280 was held three times), and it is not round, so a sibling picking the next free number does
-- not land on it.

-- AlterTable
ALTER TABLE "schedule" ADD COLUMN "max_runs" INTEGER;
ALTER TABLE "schedule" ADD CONSTRAINT "schedule_max_runs_positive" CHECK ("max_runs" IS NULL OR "max_runs" >= 1);
ALTER TABLE "schedule" ADD COLUMN "planned_end_told_at" TIMESTAMPTZ(3);

UPDATE "schedule" SET "planned_end_told_at" = COALESCE("ended_at", now()) WHERE "state" = 'ENDED';

-- CreateIndex
CREATE INDEX "schedule_planned_end_untold_idx" ON "schedule" ("ended_at")
  WHERE "state" = 'ENDED' AND "ended_reason" = 'END_REACHED' AND "planned_end_told_at" IS NULL;
CREATE INDEX "schedule_run_started_idx" ON "schedule_run" ("schedule_id") WHERE "started_at" IS NOT NULL;
