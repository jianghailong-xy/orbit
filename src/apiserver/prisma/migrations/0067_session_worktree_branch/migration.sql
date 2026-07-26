-- The worktree's actual current HEAD branch, as last reported by the runner. Differs from
-- `branch` after an in-worktree `git checkout -b`; drives the status bar's divergence flag and
-- the "Adopt" action. Additive nullable column, no backfill (older rows / non-isolated sessions
-- stay NULL and behave exactly as before).
ALTER TABLE "session" ADD COLUMN "worktree_branch" TEXT;
