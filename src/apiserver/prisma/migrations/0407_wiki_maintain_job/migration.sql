-- ══════════════════════════════════════════════════════════════════════════════════════════════
-- Orbit Wiki, server execution P8: a maintenance run the wiki-worker's job runs rather than a session.
-- contracts/wiki.contract.json `maintenance.job.server` and `jobs.kindRuns.maintain` are the authority,
-- docs/wiki-server-execution-design.md §5.1 and §8 the design, and
-- src/apiserver/src/wiki-worker/wiki-maintain-job.pg.spec.ts holds it.
--
-- WHAT IS ADDED
-- -------------
--   wiki_changeset.job_id            the wiki_job whose pipeline recorded the changeset, for a run the
--                                    server made (P8): a maintenance run's changesets are one run to the
--                                    circuit breaker and one proposer to the verification list, and a
--                                    server run has no session to be those things by (contract
--                                    `maintenance.job.server.identity`). NULL for every session's
--                                    changeset and for the owner's own, exactly as session_id is NULL for
--                                    a server run's. The column is a history reference with no foreign
--                                    key, as wiki_maintenance_run.job_id and wiki_plan.author_job_id are.
--   wiki_plan_proposal.author_job_id  the wiki_job that filed a plan proposal (P8): a proposal's author
--                                    was a maintenance session, and the server's maintenance run has
--                                    none. author_session_id loses NOT NULL and a CHECK holds a proposal
--                                    to exactly one author, as wiki_plan_author_chk holds a plan version
--                                    (0404).
--
-- WHAT IS NOT TOUCHED
-- -------------------
-- No row is written, backfilled or locked: every stored changeset and proposal names its session and
-- keeps it. Both columns are NULL for every stored row, so the CHECK added over the proposal's two
-- authors holds for each as it stands. No table, index, trigger, function or type is created, replaced
-- or dropped; `task`, `session`, `wiki_maintenance_run` and the DONE fence are named nowhere below.
--
-- NUMBERING, RE-RUNNABILITY
-- -------------------------
-- 0407: main stands at 0403_share_link_wiki_space and this project's line at 0405_wiki_plan_job_server_maker
-- when this was written (2026-10-08); no other branch or worktree on this host held 0407. Every statement
-- can run twice: ADD COLUMN IF NOT EXISTS, CREATE INDEX IF NOT EXISTS, DROP NOT NULL on an already-nullable
-- column, and the CHECK added only while it is absent.
-- ══════════════════════════════════════════════════════════════════════════════════════════════

ALTER TABLE "wiki_changeset" ADD COLUMN IF NOT EXISTS "job_id" UUID;

-- One space's job's changesets, which is what a run's breaker reading and its own op list are read from.
CREATE INDEX IF NOT EXISTS "wiki_changeset_job_idx" ON "wiki_changeset" ("job_id") WHERE "job_id" IS NOT NULL;

ALTER TABLE "wiki_plan_proposal" ADD COLUMN IF NOT EXISTS "author_job_id" UUID;
ALTER TABLE "wiki_plan_proposal" ALTER COLUMN "author_session_id" DROP NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'wiki_plan_proposal_author_chk') THEN
    -- A maintenance proposal names its author: a session's run, or the server's wiki job. An owner's
    -- decision is recorded on the row beside them and is neither.
    ALTER TABLE "wiki_plan_proposal" ADD CONSTRAINT "wiki_plan_proposal_author_chk" CHECK (
      ("author_session_id" IS NULL) <> ("author_job_id" IS NULL));
  END IF;
END $$;
