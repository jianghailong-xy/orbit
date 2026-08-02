-- Task execution sessions historically stopped with a successful task_done result but stayed
-- in Open. File those sessions in Completed so existing rows follow the same lifecycle rule as
-- new task executions. Prefer the recorded terminal/turn timestamps so old rows retain their
-- historical position in Completed instead of jumping to the top at deploy time.
UPDATE "session"
SET "completed_at" = COALESCE(
      "finished_at", "cancel_requested_at", "last_turn_at", "updated_at", "created_at", NOW()
    ),
    "archived_at" = COALESCE(
      "finished_at", "cancel_requested_at", "last_turn_at", "updated_at", "created_at", NOW()
    )
WHERE "end_reason" = 'task_done'
  AND "status" = 'SUCCEEDED'
  AND "completed_at" IS NULL
  AND "archived_at" IS NULL
  AND "deleted_at" IS NULL;
