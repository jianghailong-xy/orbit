-- 0511: Capture serving lifecycle epochs at the owner DONE press, without comparing clocks.
-- This migration reached main with a colliding number; renumbering resolves that collision.
-- Guards allow environments that applied the earlier number to replay it safely.
-- Nullable for legacy OWNER records and rollback compatibility; no rows are rewritten.
ALTER TABLE "project" ADD COLUMN IF NOT EXISTS "done_task_epochs" jsonb;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'project_done_task_epochs_chk') THEN
    ALTER TABLE "project" ADD CONSTRAINT "project_done_task_epochs_chk"
      CHECK ("done_task_epochs" IS NULL OR jsonb_typeof("done_task_epochs") = 'object');
  END IF;
END $$;
