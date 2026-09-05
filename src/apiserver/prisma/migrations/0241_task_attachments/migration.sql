-- Give an attachment a third, optional scope: the TASK it is an input to.
--
-- Until now a blob could name a session or a turn, and both of those are scopes on a
-- CONVERSATION. That is the right home for an image somebody pasted into a composer, and the wrong
-- one for a design mock the work itself needs: a task outlives every session that runs it (a
-- retry, a successor, a verification each open their own), so an input parked on the first run is
-- invisible to the second, and the person who attached it has no way to tell.
--
-- The new column is a TEMPLATE scope, not a delivery. Nothing hands a task-scoped row to a runner;
-- each dispatch copies it into that run's session (`copyTaskAttachments`), exactly as
-- `auto-retry.service.ts#copyAttachments` already copies a turn's images when it re-sends one, and
-- for the same reason stated there: moving the only row puts the user's picture behind whichever
-- consumer's lifecycle claimed it. Here that would be worse than a lost bubble -- the second run
-- would silently execute a task whose design mock had gone.
--
-- ON DELETE CASCADE, because unlike `creator_session_id` (SetNull: the task survives losing where
-- it came from) these bytes are PART of the task. A task that is gone has no inputs to keep, and a
-- template row that outlived its task would be unreachable by every read, all of which scope by
-- task or by session.
ALTER TABLE "attachment" ADD COLUMN "task_id" UUID;

ALTER TABLE "attachment"
  ADD CONSTRAINT "attachment_task_id_fkey"
  FOREIGN KEY ("task_id") REFERENCES "task"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- The referencing side of that foreign key as much as the read path. Without it, listing one
-- task's attachments seq-scans `attachment` (a table of blobs), and every task delete does the
-- same to find the rows its CASCADE applies to.
CREATE INDEX "attachment_task_id_idx" ON "attachment"("task_id");

-- The three scopes are mutually exclusive, and this says so where no writer can route around it.
-- A row is either a task's template (task_id set, the other two null) or a conversation's blob
-- (task_id null). Without this a copy that kept its `task_id` would be BOTH: handed to a runner as
-- part of a turn and still listed as the task's input, so deleting one image from the task detail
-- page would reach into a transcript and delete a picture out of a message somebody already sent.
ALTER TABLE "attachment"
  ADD CONSTRAINT "attachment_scope_exclusive"
  CHECK ("task_id" IS NULL OR ("session_id" IS NULL AND "turn_id" IS NULL));
