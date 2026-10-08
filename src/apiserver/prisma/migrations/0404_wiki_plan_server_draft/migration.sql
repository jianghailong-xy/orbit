-- ══════════════════════════════════════════════════════════════════════════════════════════════
-- Orbit Wiki, server execution P6: the plan drafted and revised by the wiki-worker.
-- contracts/wiki.contract.json `plan.jobs.server` is the authority for everything below,
-- docs/wiki-server-execution-design.md §8 is the design, and
-- src/apiserver/src/wiki-worker/wiki-plan-draft-job.pg.spec.ts holds it to the contract.
--
-- WHAT IS ADDED
-- -------------
--   wiki_plan.author_job_id   the wiki_job that drafted a version when the server ran the plan job. A version
--                             of origin maintenance was always a session's (0325): the server's job has no
--                             session, so `wiki_plan_author_chk` now asks for exactly one of the two — the
--                             session or the job — and the owner's version for neither. A history reference
--                             with no foreign key, as author_session_id is.
--   wiki_plan_job_made_chk    a plan job made by the server is made by its wiki_job and has no task: 0401 added
--                             job_id and a CHECK of one maker, and left 0338's made CHECK asking for a task. It now
--                             asks for a maker — the task or the job — exactly while the job is made or ended, and
--                             made_at with it. Word for word the rewrite the docs build's migration (P7, 0405) makes,
--                             each only while the old definition stands, so whichever runs second finds it done.
--   wiki_plan_job.materials   what a server-run draft drafts from, kept at its first run: the snapshot's sha,
--                             the plan's materials and the repository texts the snapshot does not carry. A
--                             replay of the job reads them instead of reading again, so it asks the model the
--                             questions it asked before and meets the answers the queue already holds. NULL for
--                             a task-run job, which keeps its materials in its runner's work directory.
--
-- WHAT IS NOT TOUCHED
-- -------------------
-- No row is written, backfilled or locked beyond what the CHECKs' validation reads. Every stored version
-- satisfies the new `wiki_plan_author_chk`: a maintenance one names its session and no job (the column is
-- new and NULL), an owner's names its user and neither of the others — exactly what the old CHECK held. Every
-- stored plan job satisfies the new `wiki_plan_job_made_chk`: none names a job yet outside a server's run, so
-- for every row it reads as the old one did. No
-- trigger, function or type is created, replaced or dropped; `task`, `session` and `task_list` are named
-- nowhere below.
--
-- NUMBERING, RE-RUNNABILITY
-- -------------------------
-- 0404: main stood at 0403_share_link_wiki_space and this project's line at 0402_wiki_repo_op when this was
-- written (2026-10-08), and no other branch, worktree or stash on this host held 0404 or above. Every statement
-- can run twice: ADD COLUMN IF NOT EXISTS, and the CHECK replaced only while it still reads the old way.
-- ══════════════════════════════════════════════════════════════════════════════════════════════

ALTER TABLE "wiki_plan" ADD COLUMN IF NOT EXISTS "author_job_id" UUID;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'wiki_plan_author_chk' AND pg_get_constraintdef(oid) LIKE '%author_job_id%'
  ) THEN
    ALTER TABLE "wiki_plan" DROP CONSTRAINT IF EXISTS "wiki_plan_author_chk";
    -- A drafting job's version names what drafted it — the maintenance run's session, or the server's job —
    -- and only that; the owner's, the owner.
    ALTER TABLE "wiki_plan" ADD CONSTRAINT "wiki_plan_author_chk" CHECK (
      ("origin" = 'maintenance' AND "author_user_id" IS NULL
        AND ("author_session_id" IS NOT NULL) <> ("author_job_id" IS NOT NULL))
      OR ("origin" = 'owner' AND "author_user_id" IS NOT NULL AND "author_session_id" IS NULL AND "author_job_id" IS NULL));
  END IF;
END $$;

ALTER TABLE "wiki_plan_job" ADD COLUMN IF NOT EXISTS "materials" JSONB;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'wiki_plan_job_materials_chk') THEN
    ALTER TABLE "wiki_plan_job" ADD CONSTRAINT "wiki_plan_job_materials_chk"
      CHECK ("materials" IS NULL OR jsonb_typeof("materials") = 'object');
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'wiki_plan_job_made_chk' AND pg_get_constraintdef(oid) NOT LIKE '%job_id%'
  ) THEN
    ALTER TABLE "wiki_plan_job" DROP CONSTRAINT "wiki_plan_job_made_chk";
    -- A job has a maker — its task, or the server's job — from the moment it is made.
    ALTER TABLE "wiki_plan_job" ADD CONSTRAINT "wiki_plan_job_made_chk" CHECK (
      ("state" IN ('made', 'ended')) = ("task_id" IS NOT NULL OR "job_id" IS NOT NULL)
      AND ("task_id" IS NULL AND "job_id" IS NULL) = ("made_at" IS NULL));
  END IF;
END $$;
