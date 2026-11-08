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
--
-- TAKING THE LOCK IN SHORT TRIES (task C5, at the coordinator's request, before this reached main)
-- ------------------------------------------------------------------------------------------------
-- wiki_job is read and written by the wiki worker all the time, and a pg_dump or any long reader holds ACCESS
-- SHARE on it for its whole run. Each statement here needs a lock on it: the CHECK swap and the drop ACCESS
-- EXCLUSIVE, each index build SHARE. A statement waiting for a lock queues every later reader and writer of the
-- table behind it. At production's lock_timeout of 30 s (docker-compose.yml) a long wait fails the migration,
-- which then stops the apiserver from starting, and the image before it too (P3009). So the four statements run
-- in ONE DO, which first takes ACCESS EXCLUSIVE on wiki_job in short tries: lock_timeout 2 s, 1 s between tries
-- in which everything else runs, a deadlock taken as a failed try too, at most 60 tries (3 minutes, inside
-- statement_timeout's 300 s), then a clear error that says what to do. `migrate deploy` sends a file with a DO in
-- it as one statement, one transaction, so the lock is held until the four are done (drilled with this repo's
-- Prisma 7.10 and the server's statement log, task C5, 2026-11-06). The order stays: the two new indexes first,
-- the old one dropped last, so no moment leaves a space's running jobs unguarded. wiki_job is small, so the
-- CHECK's scan and the two partial builds run under the held lock: on 50,000 jobs the DO holds it for 10 ms, on
-- 10,000 for 7 ms (drilled the same day).

DO $$
DECLARE
  tries integer := 0;
BEGIN
  PERFORM set_config('lock_timeout', '2s', true);
  LOOP
    BEGIN
      LOCK TABLE "wiki_job" IN ACCESS EXCLUSIVE MODE;

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
      EXIT;
    EXCEPTION WHEN lock_not_available OR deadlock_detected THEN
      tries := tries + 1;
      IF tries >= 60 THEN
        RAISE EXCEPTION '0477: "wiki_job" was not free in 60 tries of 2 s each. Once what holds it has ended, mark the migration rolled back (prisma migrate resolve --rolled-back 0477_wiki_docs_follow) and deploy again: it is safe to run twice.'
          USING ERRCODE = 'lock_not_available';
      END IF;
      PERFORM pg_sleep(1);
    END;
  END LOOP;
END $$;
