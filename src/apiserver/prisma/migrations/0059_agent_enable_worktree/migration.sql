-- Per-agent toggle for per-session git worktree isolation. Default true so every existing
-- agent keeps today's behavior (each session runs isolated in its own worktree on its branch).
-- When false, session creation assigns no branch, so the runner runs the session directly in
-- the agent's workDir with no worktree.
ALTER TABLE "agent" ADD COLUMN "enable_worktree" BOOLEAN NOT NULL DEFAULT true;
