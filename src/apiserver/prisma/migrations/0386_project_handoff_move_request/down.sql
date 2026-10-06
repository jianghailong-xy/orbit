-- Reverses 0386, in the opposite order. Not read by Prisma; re-runnable like the forward script.
-- Dropping the column discards the criterion every MOVE_TASK request named, so run it only where
-- those rows are no longer wanted.

DROP TRIGGER IF EXISTS "project_handoff_approval_guard_criterion" ON "project_handoff_approval";
DROP FUNCTION IF EXISTS "project_handoff_approval_criterion_guard"();
DROP INDEX IF EXISTS "project_handoff_approval_pending_move_idx";
ALTER TABLE "project_handoff_approval"
  DROP CONSTRAINT IF EXISTS "project_handoff_approval_requested_criterion_chk";
ALTER TABLE "project_handoff_approval" DROP COLUMN IF EXISTS "requested_criterion_definition_id";
