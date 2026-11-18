-- 0514: the repository tier a maintenance run read, and why it read less than git (docs/wiki-repo-tiers-design.md §3,
-- contract `repoOps.tiers`). NULL on every run before it, and on a run whose latest attempt has not reached the probe.
-- Nullable columns only: no row is rewritten, and no trigger, fence or preserved function is touched.
ALTER TABLE "wiki_maintenance_run" ADD COLUMN IF NOT EXISTS "repo_tier" text;
ALTER TABLE "wiki_maintenance_run" ADD COLUMN IF NOT EXISTS "repo_reason" text;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'wiki_maintenance_run_repo_tier_chk') THEN
    ALTER TABLE "wiki_maintenance_run" ADD CONSTRAINT "wiki_maintenance_run_repo_tier_chk"
      CHECK ("repo_tier" IS NULL OR "repo_tier" IN ('git', 'folder', 'sessions', 'wrong_repository'));
  END IF;
END $$;
