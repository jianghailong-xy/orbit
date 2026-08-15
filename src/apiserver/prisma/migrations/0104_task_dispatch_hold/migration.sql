-- The projection of task_list.paused onto the tasks it governs. See Task.dispatchHold.
ALTER TABLE "task" ADD COLUMN "dispatch_hold" BOOLEAN NOT NULL DEFAULT false;

-- Backfill from the flag this column replaces, so a list paused before this migration stays
-- paused after it. Tasks whose list was already deleted are deliberately left released: their
-- holder is gone, and a hold nothing can lift is a wedge, not a stop.
UPDATE "task" t
SET "dispatch_hold" = true
FROM "task_list" tl
WHERE tl.id = t.list_id AND tl.paused = true;
