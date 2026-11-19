-- 0519: what the health line says of the repository, and the streak that tells the owner (docs/wiki-repo-tiers-design.md
-- §6, §7.1; contract `maintenance.health.repo`, `maintenance.health.notifyRepository`).
--   wiki_maintenance_run.repo_detail      the run's reason as one redacted English sentence; NULL on git and before its probe.
--   wiki_maintenance_run.repo_checked_at  when the run's probe read the repository; NULL before it.
--   wiki_cursor.repo_attention_runs       maintenance runs in a row that read a red reason (wrong_repository,
--                                         root_mismatch, path_overlap, fetch_refused); a run that reads the repository
--                                         sets it back to 0.
-- Added columns only (two nullable, one with a default): no row is rewritten, and no trigger, fence or preserved function
-- is touched.
ALTER TABLE "wiki_maintenance_run" ADD COLUMN IF NOT EXISTS "repo_detail" text;
ALTER TABLE "wiki_maintenance_run" ADD COLUMN IF NOT EXISTS "repo_checked_at" timestamptz(3);
ALTER TABLE "wiki_cursor" ADD COLUMN IF NOT EXISTS "repo_attention_runs" integer NOT NULL DEFAULT 0;
