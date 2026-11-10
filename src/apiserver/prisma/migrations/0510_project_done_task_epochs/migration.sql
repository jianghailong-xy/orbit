-- Capture serving lifecycle epochs at the owner DONE press, without comparing clocks.
-- Nullable for legacy OWNER records and rollback compatibility; no rows are rewritten.
ALTER TABLE "project" ADD COLUMN "done_task_epochs" jsonb;
ALTER TABLE "project" ADD CONSTRAINT "project_done_task_epochs_chk"
  CHECK ("done_task_epochs" IS NULL OR jsonb_typeof("done_task_epochs") = 'object');
