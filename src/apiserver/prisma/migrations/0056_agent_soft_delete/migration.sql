-- Soft delete for agents: `remove` now stamps `deleted_at` instead of hard-deleting the
-- row. Keeps the agent's sessions/tasks linked (no FK SET NULL orphaning) and makes the
-- agent restorable. Existing agents get NULL = live; user-facing listings filter it out.
ALTER TABLE "agent" ADD COLUMN "deleted_at" TIMESTAMP(3);
