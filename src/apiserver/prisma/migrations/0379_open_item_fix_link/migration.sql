-- T7: a task may be filed as the concrete fix for an open exception item.  The
-- link is nullable and an exception's history must outlive the work, so deleting
-- the item only clears the task's pointer.
ALTER TABLE "task"
  ADD COLUMN "fixes_open_item_id" UUID;

ALTER TABLE "task"
  ADD CONSTRAINT "task_fixes_open_item_fkey"
  FOREIGN KEY ("fixes_open_item_id")
  REFERENCES "project_open_item"("id")
  ON DELETE SET NULL
  ON UPDATE CASCADE;

CREATE INDEX "task_fixes_open_item_idx"
  ON "task"("fixes_open_item_id");
