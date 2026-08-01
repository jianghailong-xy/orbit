-- Support owner-scoped task cursor pagination and status/list filters without scanning
-- the full task table. The session index backs the owner-scoped live-state grouping.
CREATE INDEX "task_owner_created_id_idx"
  ON "task"("owner_id", "created_at" DESC, "id" DESC);

CREATE INDEX "task_owner_status_created_id_idx"
  ON "task"("owner_id", "status", "created_at" DESC, "id" DESC);

CREATE INDEX "task_owner_list_created_id_idx"
  ON "task"("owner_id", "list_id", "created_at" DESC, "id" DESC);

-- 0068_session_search enables pg_trgm. This index keeps case-insensitive title
-- filtering responsive for both Latin and CJK task names.
CREATE INDEX "task_title_search_trgm"
  ON "task" USING gin ("title" gin_trgm_ops);

CREATE INDEX "session_owner_status_task_idx"
  ON "session"("owner_id", "status", "task_id");
