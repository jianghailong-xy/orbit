-- 1050 — a WHEN condition can fire again while it still holds (docs/condition-triggers-design.md §3, §5.1; C9).
--
-- WHAT IT ADDS
-- ============
--   * `condition.repeat_seconds`: fire again every this many seconds while the comparison has held since the last
--     firing and the condition has not re-armed. WHEN rules only: `condition_repeat_chk` refuses it on a startWhen
--     condition (no schedule_id), under 900 seconds, or under the condition's own interval.
--   * `condition.repeat_from`: what the next repeat is counted from, the last FIRED or the sample the comparison held
--     again on after a break; NULL while none is due.
--   * `condition_event.repeat`: a FIRED that is a repeat, so the history can say "Fired again".
--
-- BACKWARD COMPATIBLE
-- ===================
-- Two nullable columns with no default, a boolean with a constant default, and a CHECK every stored row passes (no
-- condition has a repeat_seconds yet). No stored row is rewritten.
--
-- 1050: the highest number in use on origin/main, every origin/project/* and origin/orbit/* was 1040 on 2026-11-17,
-- and 1060 is taken by C4's branch (task_start_when).

-- AlterTable
ALTER TABLE "condition" ADD COLUMN "repeat_seconds" INTEGER;
ALTER TABLE "condition" ADD COLUMN "repeat_from" TIMESTAMPTZ(3);
ALTER TABLE "condition" ADD CONSTRAINT "condition_repeat_chk" CHECK (
  "repeat_seconds" IS NULL
  OR ("schedule_id" IS NOT NULL AND "repeat_seconds" >= 900 AND "repeat_seconds" >= "interval_seconds")
);

-- AlterTable
ALTER TABLE "condition_event" ADD COLUMN "repeat" BOOLEAN NOT NULL DEFAULT false;
