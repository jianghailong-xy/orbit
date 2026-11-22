-- 1040 — a schedule's WHEN rule (docs/condition-triggers-design.md §3, §5.2, §6.1; C3 of §11).
--
-- WHAT IT ADDS
-- ============
--   * `schedule_run_trigger` value CONDITION: a run a WHEN schedule's condition started, its `planned_at` the firing
--     sample's time. Not in `schedule_run_slot_key` (SCHEDULED, CATCH_UP): one firing writes one run under the
--     condition's row lock, which is what keeps it to one.
--   * `schedule.envelope_command_hash`: the sha256 of the probe command the owner approved on the create card or an
--     Allow (schedule-envelope.ts). A different command grows the envelope. NULL for a timed schedule.
--   * `condition.resumed_at`: when the schedule it belongs to was last resumed. A paused or ended schedule ends its
--     condition; resuming brings it back, and its silence (three intervals with no sample) is counted from the newer of
--     this and its newest sample, so a resume does not read as a runner gone quiet.
--
-- BACKWARD COMPATIBLE
-- ===================
-- An enum widened, two nullable columns with no default. No stored row is rewritten.
--
-- 1040: the highest number in use on origin/main, every origin/project/* and origin/orbit/* was 1030 on 2026-11-17.

-- AlterEnum
ALTER TYPE "schedule_run_trigger" ADD VALUE 'CONDITION';

-- AlterTable
ALTER TABLE "schedule" ADD COLUMN "envelope_command_hash" TEXT;

-- AlterTable
ALTER TABLE "condition" ADD COLUMN "resumed_at" TIMESTAMPTZ(3);
