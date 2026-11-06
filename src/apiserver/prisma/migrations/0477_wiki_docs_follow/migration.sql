-- ══════════════════════════════════════════════════════════════════════════════════════════════
-- Orbit Wiki, the wiki chat (project 34sYUuoSpnReXXn6j28WR, task C4): the follow job, `docs_follow`.
-- docs/wiki-chat-design.md sections 8.1 to 8.3 and 8.5, and docs/wiki-contract.md sections 24.2 and 29
-- (contracts/wiki.contract.json `docs.follow`, `jobs.onePerSpace`) are the authority for everything below;
-- src/apiserver/src/wiki-worker/wiki-docs-follow-job.pg.spec.ts holds the rule to it.
--
-- WHAT CHANGES
-- ------------
--   wiki_job_kind_chk   admits a ninth kind, `docs_follow`: the job that rewrites the sections a chat's press
--                       or a change that reached main touched (docs.follow.kind).
--   one job a space     becomes the owner's exception of 2026-11-06 (design section 8.5): a follow job runs
--                       beside a job of its space that writes no document (articles, verify, import, smoke)
--                       and waits for one that does (maintain, docs_build, plan_draft, plan_revise, another
--                       docs_follow). The one partial unique index over a space's running job,
--                       `wiki_job_space_running_key`, is replaced by two:
--                         wiki_job_space_running_other_key    WHERE state = 'running' AND kind <> 'docs_follow'
--                                                             (of everything but the follow job, at most one)
--                         wiki_job_space_running_writer_key   WHERE state = 'running' AND kind IN (the five
--                                                             kinds that write documents) (at most one writer)
--                       so two jobs of a space run at once only when one is docs_follow and the other writes no
--                       document, which is what the claim reads (wiki-worker/wiki-jobs.ts `claimWikiJobs`).
--
-- WHAT DOES NOT
-- -------------
-- No row is written. Every stored job is of one of the eight kinds the CHECK held before, so it satisfies the new
-- one as it stands; and every space has at most one running job today, so each of the two new indexes, over a
-- subset of what the old one covered, is built over rows that are already unique. The new indexes are made before
-- the old one is dropped, so no moment of this file leaves a space's running jobs unguarded. No column, function,
-- trigger or type is created, replaced or dropped, and nothing outside wiki_job is named. The code before this
-- migration claims at most one job a space, which both indexes allow, and makes no docs_follow job.
--
-- NUMBERING, RE-RUNNABILITY
-- -------------------------
-- 0477: main, every origin/project/* and every pushed orbit/* branch stood at 0475 or below when this was written
-- (2026-11-06), and 0476 was task C5's (0476_wiki_chat_session), told to the project's coordinator. Every
-- statement can run twice: the CHECK is dropped IF EXISTS before it is added, the indexes are made IF NOT EXISTS
-- and the old one dropped IF EXISTS.
-- ══════════════════════════════════════════════════════════════════════════════════════════════

ALTER TABLE "wiki_job"
  DROP CONSTRAINT IF EXISTS "wiki_job_kind_chk",
  ADD CONSTRAINT "wiki_job_kind_chk" CHECK ("kind" IN
    ('verify', 'articles', 'import', 'plan_draft', 'plan_revise', 'docs_build', 'maintain', 'smoke', 'docs_follow'));

-- Of every kind but the follow job, one running job a space, as before.
CREATE UNIQUE INDEX IF NOT EXISTS "wiki_job_space_running_other_key" ON "wiki_job" ("space_id")
  WHERE "state" = 'running' AND "kind" <> 'docs_follow';
-- Of the jobs that write documents, the follow job among them, one running job a space.
CREATE UNIQUE INDEX IF NOT EXISTS "wiki_job_space_running_writer_key" ON "wiki_job" ("space_id")
  WHERE "state" = 'running' AND "kind" IN ('maintain', 'docs_build', 'plan_draft', 'plan_revise', 'docs_follow');
DROP INDEX IF EXISTS "wiki_job_space_running_key";
