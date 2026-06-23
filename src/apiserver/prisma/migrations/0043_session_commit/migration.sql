-- "Commit" button on the worktree status bar (for a live, worktree-isolated session). The
-- bar is now git-state-driven: `worktree_dirty` is the runner's last-reported `git status`
-- for the live checkout — true → the bar shows Commit (commit the uncommitted work onto the
-- session's branch), false → Merge to main. `commit_status` drives the button while it runs:
-- 'pending' (queued for the assigned runner's next heartbeat) → 'committed' | 'nochange' |
-- 'error' (commit_error carries git's message). All NULL until reported / clicked; no backfill.
ALTER TABLE "session" ADD COLUMN "worktree_dirty" BOOLEAN;
ALTER TABLE "session" ADD COLUMN "commit_status" TEXT;
ALTER TABLE "session" ADD COLUMN "commit_error" TEXT;
ALTER TABLE "session" ADD COLUMN "commit_requested_at" TIMESTAMP(3);
