-- Reverses 0389: 0130's body, word for word. Not read by Prisma; re-runnable like the forward script.
-- After it, a confirmed move of a task whose run is live is refused again (TASK_CLAIMED_PROJECT_MOVE)
-- and rolls back whole, leaving its request PENDING.

CREATE OR REPLACE FUNCTION "task_claimed_project_move_guard"() RETURNS trigger AS $$
BEGIN
  IF NEW."project_id" IS DISTINCT FROM OLD."project_id" AND EXISTS (
    SELECT 1 FROM "session" s WHERE s."task_id" = NEW."id" AND s."deleted_at" IS NULL
      AND s."status" IN ('PENDING', 'RUNNING', 'AWAITING_INPUT', 'INTERRUPTED')
  ) THEN
    RAISE EXCEPTION 'TASK_CLAIMED_PROJECT_MOVE: task % has a live execution claim', NEW."id";
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
