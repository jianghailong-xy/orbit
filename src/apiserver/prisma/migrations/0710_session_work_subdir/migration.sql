-- 0710: the folder below its workspace's workDir a no-worktree session runs in (POST /sessions `workSubdir`, what
-- `orbit` typed in a subfolder sends). Relative and normalized, checked by the apiserver; the runner checks it again on
-- disk. Nullable without a default, so adding it rewrites nothing; null runs the session at workDir as before.
-- Highest migration on any pushed ref was 0700 (2026-11-14). The statement can run twice.
ALTER TABLE "session" ADD COLUMN IF NOT EXISTS "work_subdir" TEXT;
