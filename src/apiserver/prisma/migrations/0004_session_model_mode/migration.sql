-- Per-session model + permission-mode overrides (interactive sessions, Route B).
-- NULL falls back to the agent's value, then a server default.
ALTER TABLE "Task" ADD COLUMN "model" TEXT;
ALTER TABLE "Task" ADD COLUMN "permissionMode" TEXT;
