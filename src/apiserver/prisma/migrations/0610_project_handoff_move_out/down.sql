-- Reverses 0610, in the opposite order. Not read by Prisma; re-runnable like the forward script.
-- Restoring NOT NULL fails while any request to take a task out of its project exists, so delete
-- those rows first, and only where they are no longer wanted.

CREATE OR REPLACE FUNCTION "task_claimed_project_move_guard"() RETURNS trigger AS $$
DECLARE
  confirmation text;
BEGIN
  IF NEW."project_id" IS DISTINCT FROM OLD."project_id" AND EXISTS (
    SELECT 1 FROM "session" s WHERE s."task_id" = NEW."id" AND s."deleted_at" IS NULL
      AND s."status" IN ('PENDING', 'RUNNING', 'AWAITING_INPUT', 'INTERRUPTED')
  ) THEN
    confirmation := current_setting('orbit.move_task_handoff_id', true);
    IF confirmation IS NULL
       OR confirmation !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       OR NOT EXISTS (
         SELECT 1 FROM "project_handoff_approval" a
          WHERE a."id" = confirmation::uuid
            AND a."owner_id" = NEW."owner_id"
            AND a."kind" = 'MOVE_TASK'
            AND a."subject_task_id" = NEW."id"
            AND a."from_project_id" = OLD."project_id"
            AND a."to_project_id" = NEW."project_id"
            AND a."state" = 'APPROVED'
            AND a."applied_task_id" IS NULL
            AND a."decided_by" = 'USER'
            AND a."decided_by_user_id" IS NOT NULL
       ) THEN
      RAISE EXCEPTION 'TASK_CLAIMED_PROJECT_MOVE: task % has a live execution claim', NEW."id";
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP INDEX IF EXISTS "project_handoff_approval_pending_move_idx";
CREATE UNIQUE INDEX "project_handoff_approval_pending_move_idx"
  ON "project_handoff_approval"("owner_id", "subject_task_id", "from_project_id", "to_project_id")
  WHERE "kind" = 'MOVE_TASK' AND "state" = 'PENDING';

ALTER TABLE "project_handoff_approval"
  DROP CONSTRAINT IF EXISTS "project_handoff_approval_no_target_chk";
ALTER TABLE "project_handoff_approval" ALTER COLUMN "to_project_id" SET NOT NULL;
