-- "Merge to main" button on the worktree status bar. The user can ask the runner that
-- ran a session to merge its `branch` into the repo's main. `merge_status` drives the UI:
-- 'pending' (queued for the assigned runner's next heartbeat) → 'merged' (merged_at set) |
-- 'conflict' | 'error' (merge_error carries git's message / the failed precondition). All
-- NULL until the user clicks merge; no backfill.
ALTER TABLE "session" ADD COLUMN "merge_status" TEXT;
ALTER TABLE "session" ADD COLUMN "merge_error" TEXT;
ALTER TABLE "session" ADD COLUMN "merge_requested_at" TIMESTAMP(3);
ALTER TABLE "session" ADD COLUMN "merged_at" TIMESTAMP(3);
