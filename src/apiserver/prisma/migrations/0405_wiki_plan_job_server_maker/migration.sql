-- ══════════════════════════════════════════════════════════════════════════════════════════════
-- Orbit Wiki, server execution P7: a plan job made by the wiki-worker's job rather than by a task.
-- contracts/wiki.contract.json `docs.build.server.made` and `plan.jobs.server` are the authority,
-- docs/wiki-server-execution-design.md §5.1 and §8 the design, and
-- src/apiserver/src/wiki-worker/wiki-docs-build-job.pg.spec.ts holds it.
--
-- WHAT CHANGES
-- ------------
--   wiki_plan_job_made_chk   0338 wrote "a job has a task from the moment it is made": a made or ended plan
--                            job named its task, and made_at was set exactly when task_id was. 0401 gave the
--                            row a second maker, job_id — the wiki_job that runs it on the server — and a
--                            CHECK (wiki_plan_job_maker_chk) that a made row names exactly one of the two, but
--                            left this one as it was, so no plan job could be made by a job at all: the
--                            server's build met 23514 and stayed queued. Restated over both makers: a made or
--                            ended job names a maker, and made_at is set exactly when one is.
--
-- WHAT IS NOT TOUCHED
-- -------------------
-- No row is written, backfilled or locked beyond what the CHECK's validation reads. Every stored row satisfies
-- the restated CHECK: none names a job yet (job_id is 0401's and nothing has written it), so for each it reads
-- exactly as 0338's did. wiki_plan_job_maker_chk stays as 0401 wrote it. No table, column, index, trigger,
-- function or type is created, replaced or dropped; `task`, `session`, `project` and the DONE fence are named
-- nowhere below.
--
-- NUMBERING, RE-RUNNABILITY
-- -------------------------
-- 0405: main stood at 0403_share_link_wiki_space and this project's line at 0403 when this was written
-- (2026-10-08); P6's branch holds 0404_wiki_plan_server_draft in its worktree, and no other branch, worktree
-- or stash on this host held 0404 or above. The statement can run twice: the CHECK is replaced only while it
-- still reads 0338's way.
-- ══════════════════════════════════════════════════════════════════════════════════════════════

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'wiki_plan_job_made_chk' AND pg_get_constraintdef(oid) LIKE '%job_id%'
  ) THEN
    ALTER TABLE "wiki_plan_job" DROP CONSTRAINT IF EXISTS "wiki_plan_job_made_chk";
    -- A job has a maker from the moment it is made: its task, or its wiki job on the server path.
    ALTER TABLE "wiki_plan_job" ADD CONSTRAINT "wiki_plan_job_made_chk" CHECK (
      ("state" IN ('made', 'ended')) = ("task_id" IS NOT NULL OR "job_id" IS NOT NULL)
      AND ("task_id" IS NULL AND "job_id" IS NULL) = ("made_at" IS NULL));
  END IF;
END $$;
