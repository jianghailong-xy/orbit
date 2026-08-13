-- Worktree isolation covers each session's files, not the checkout they all fork from and merge
-- back into. Agents step into that shared checkout for builds (the toolchain lives there) and
-- `git stash` is repo-global, so a conflicted stash pop can leave it mid-merge — after which every
-- session's "Merge to main" on that machine fails with what reads like its own problem.
--
-- Runners now report each shared checkout's state on the heartbeat so the control plane can say it
-- once, for the machine, before a merge fails. Heartbeat-owned cache (array of @orbit/shared
-- RunnerRepoHealth); NULL means no runner has reported yet, which reads as "unknown", never "clean".
ALTER TABLE "runner" ADD COLUMN "repo_health" JSONB;

-- And the repair the warning offers: a one-slot relay (same shape as the sign-in / install ones),
-- because a machine repairs one checkout at a time. The runner rescues whatever the checkout holds
-- onto an orbit/rescue-* branch before returning it to HEAD, so the repair can never be the thing
-- that loses someone's afternoon; repo_cleanup_branch is the pointer back to it and outlives the
-- relay.
ALTER TABLE "runner" ADD COLUMN "repo_cleanup_status" TEXT;
ALTER TABLE "runner" ADD COLUMN "repo_cleanup_root" TEXT;
ALTER TABLE "runner" ADD COLUMN "repo_cleanup_branch" TEXT;
ALTER TABLE "runner" ADD COLUMN "repo_cleanup_message" TEXT;
ALTER TABLE "runner" ADD COLUMN "repo_cleanup_at" TIMESTAMP(3);
