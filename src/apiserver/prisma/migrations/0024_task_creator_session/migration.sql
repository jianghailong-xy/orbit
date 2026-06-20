-- Task.creatorSessionId: the session an in-session agent created the task from (via the
-- orbit MCP task_create). Null for user-created tasks. Real FK; deleting the session
-- detaches but keeps the task (SET NULL). Lets the task detail page link to its origin run.
ALTER TABLE "task" ADD COLUMN "creator_session_id" UUID;

ALTER TABLE "task" ADD CONSTRAINT "task_creator_session_id_fkey" FOREIGN KEY ("creator_session_id") REFERENCES "session"("id") ON DELETE SET NULL ON UPDATE CASCADE;
