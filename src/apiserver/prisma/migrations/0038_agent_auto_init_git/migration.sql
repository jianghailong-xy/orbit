-- Opt-in per-agent flag: when the agent's workDir is NOT a git repo, the runner
-- auto-`git init`s it (default .gitignore + baseline commit) on the next claim so its
-- sessions can be worktree-isolated. Set by the web "Enable isolation" action shown on a
-- non-git run. Defaults false — existing agents keep the shared-dir (no isolation) behavior.
ALTER TABLE "agent" ADD COLUMN "auto_init_git" BOOLEAN NOT NULL DEFAULT false;
