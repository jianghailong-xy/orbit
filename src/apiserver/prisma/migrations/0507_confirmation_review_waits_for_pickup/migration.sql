BEGIN;

-- A failed run without an end fact is still an open reviewer conversation.
DROP TRIGGER "task_owner_confirmation_review_reviewer_ended" ON "session";
CREATE TRIGGER "task_owner_confirmation_review_reviewer_ended"
  AFTER UPDATE OF "status", "end_reason", "completed_at", "archived_at", "deleted_at"
  ON "session"
  FOR EACH ROW
  WHEN (
    NEW."deleted_at" IS NOT NULL
    OR NEW."completed_at" IS NOT NULL
    OR NEW."archived_at" IS NOT NULL
    OR NEW."status" IN ('SUCCEEDED', 'CANCELLED')
    OR (NEW."status" IN ('FAILED', 'INTERRUPTED') AND COALESCE(NEW."end_reason", '') <> '')
  )
  EXECUTE FUNCTION "task_owner_confirmation_review_reviewer_ended"();

COMMIT;
