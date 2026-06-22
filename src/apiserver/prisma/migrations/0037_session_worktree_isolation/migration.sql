-- Per-session git worktree isolation. When an agent's workDir is a git repo, the runner
-- runs each session in its own `git worktree` on `branch`, forked from `base_sha` (the
-- workDir HEAD at claim time), commits the work to the branch on terminal completion, and
-- reports `changed_files` (a compact per-file {path,additions,deletions,status} summary).
-- `isolation_status` records what actually happened: 'worktree' (isolated) or 'shared-nogit'
-- (workDir wasn't a git repo → ran in the shared dir, no isolation). All NULL for existing
-- rows; no backfill — these only matter for sessions that run under the new runner.
ALTER TABLE "session" ADD COLUMN "branch" TEXT;
ALTER TABLE "session" ADD COLUMN "base_sha" TEXT;
ALTER TABLE "session" ADD COLUMN "changed_files" JSONB;
ALTER TABLE "session" ADD COLUMN "isolation_status" TEXT;
