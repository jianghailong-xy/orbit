-- What the runner last saw at an agent's work_dir on its own disk, refreshed each heartbeat so
-- the config form can report a missing path (or one that can't be worktree-isolated) at edit
-- time rather than when a session fails to start.
--
-- All three columns stay NULL until a runner new enough to probe reports on that agent, which is
-- the state the UI must not confuse with "probed, and it isn't there" — hence nullable booleans
-- rather than defaults.
-- AlterTable
ALTER TABLE "agent" ADD COLUMN "work_dir_exists"    BOOLEAN,
                    ADD COLUMN "work_dir_is_git"    BOOLEAN,
                    ADD COLUMN "work_dir_probed_at" TIMESTAMP(3);
