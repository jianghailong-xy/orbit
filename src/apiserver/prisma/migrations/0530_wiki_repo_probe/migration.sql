-- 0530: the settings' probe and the owner's run now (docs/wiki-repo-tiers-design.md §7.3, contract `repoOps.kinds` probe
-- and `maintenance.run`).
--
--   wiki_repo_op    a fifth kind, `probe`: which tier a workspace's folder would be read on, asked by the maintenance
--                   settings with no job behind it. So `job_id` may be NULL — for a probe only, which the new CHECK holds;
--                   every other kind is still some job's, and a probe that is a job's keeps its job.
--   wiki_maintenance_run  a third `due`, `owner`: a run the owner asked for with Check again and run now, counted against
--                   the day like the other two.
--
-- Constraint swaps and one DROP NOT NULL only: no row is written, no preserved trigger, function or DONE fence is named.
-- Every statement can run twice.
ALTER TABLE "wiki_repo_op" DROP CONSTRAINT IF EXISTS "wiki_repo_op_kind_chk";
ALTER TABLE "wiki_repo_op" ADD CONSTRAINT "wiki_repo_op_kind_chk" CHECK ("kind" IN ('snapshot', 'read', 'diff', 'anchors', 'probe'));
ALTER TABLE "wiki_repo_op" ALTER COLUMN "job_id" DROP NOT NULL;
ALTER TABLE "wiki_repo_op" DROP CONSTRAINT IF EXISTS "wiki_repo_op_job_chk";
ALTER TABLE "wiki_repo_op" ADD CONSTRAINT "wiki_repo_op_job_chk" CHECK ("job_id" IS NOT NULL OR "kind" = 'probe');

ALTER TABLE "wiki_maintenance_run" DROP CONSTRAINT IF EXISTS "wiki_maintenance_run_due_chk";
ALTER TABLE "wiki_maintenance_run" ADD CONSTRAINT "wiki_maintenance_run_due_chk" CHECK ("due" IS NULL OR "due" IN ('backlog', 'age', 'owner'));
