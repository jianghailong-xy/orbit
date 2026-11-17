-- LAND runs commit in their own worktree; the server lands them after the turn has settled.
ALTER TYPE "schedule_access_level" ADD VALUE 'LAND';
ALTER TABLE "schedule_run"
  ADD COLUMN "landing_status" TEXT,
  ADD COLUMN "landed_sha" CHAR(40);
