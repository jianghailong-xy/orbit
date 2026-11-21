-- 1350: one task exempt from its project's landing check (contract revision 42, section 12.14, P-C2).
--
--   task.landing_check_exempt               true: when this task lands on its project's branch, the project's
--                                           landing check is not run; the task's own acceptance still is, and the
--                                           merge check before upstream is untouched.
--   task.landing_check_exempt_reason        why, at most 280 characters; set exactly when the task is exempt.
--   task.landing_check_exempt_by_session_id the coordinator conversation that wrote it; NULL when the owner did.
--
-- Three columns and two CHECKs on task, which every existing row satisfies with the defaults; no row is written,
-- no index, trigger, function or DONE fence changes. Every statement can run twice.
ALTER TABLE "task" ADD COLUMN IF NOT EXISTS "landing_check_exempt" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "task" ADD COLUMN IF NOT EXISTS "landing_check_exempt_reason" TEXT;
ALTER TABLE "task" ADD COLUMN IF NOT EXISTS "landing_check_exempt_by_session_id" UUID;
ALTER TABLE "task" DROP CONSTRAINT IF EXISTS "task_landing_check_exempt_reason_chk";
ALTER TABLE "task" ADD CONSTRAINT "task_landing_check_exempt_reason_chk" CHECK (
  ("landing_check_exempt" AND "landing_check_exempt_reason" IS NOT NULL
    AND char_length("landing_check_exempt_reason") BETWEEN 1 AND 280)
  OR (NOT "landing_check_exempt" AND "landing_check_exempt_reason" IS NULL)
);
ALTER TABLE "task" DROP CONSTRAINT IF EXISTS "task_landing_check_exempt_by_chk";
ALTER TABLE "task" ADD CONSTRAINT "task_landing_check_exempt_by_chk" CHECK (
  "landing_check_exempt" OR "landing_check_exempt_by_session_id" IS NULL
);
