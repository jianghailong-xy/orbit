-- ══════════════════════════════════════════════════════════════════════════════════════════════════
-- Orbit Wiki, server execution: a model call keeps the case file it was made from, so that a replay of its job asks
-- what the earlier attempt asked. contracts/wiki.contract.json `modelQueue.material` and
-- `maintenance.job.server.replay` are the authority, docs/wiki-contract.md §25.3 the prose.
--
-- WHY (2026-11-06)
-- ----------------
-- With the production host's CPU saturated, two maintain runs of the orbit space lost their lease and were replayed.
-- Each replay read a session that was still going on again, built its case file from the records it had by then, and
-- asked the question an earlier attempt had asked under the same unit with another prompt; the queue refused it
-- ("already exists with a different call") and both runs failed. The question a unit was first asked is the row's own;
-- what the replay was missing is the case file that question was made from, which it needs to read the answer.
--
-- WHAT CHANGES
-- ------------
-- `wiki_model_request.material`, a nullable JSONB column, with a CHECK that it is an object when it is set. The
-- maintain job writes it with the first question of each session, of its extraction and of the pass over the
-- agent's notes: the dossier, or the notes and their file. Every other call keeps NULL.
--
-- WHAT DOES NOT
-- -------------
-- No row is written, and every request made before this migration keeps NULL: a replay of a job that one of them
-- belongs to asks as it did before. Adding a nullable column with no default rewrites nothing. No stored row can fail
-- the CHECK, since the column is NULL everywhere, but PostgreSQL still reads every row to prove it (below). The code
-- before this migration neither reads nor writes the column, so a deployment still running it is unaffected.
--
-- TAKING THE LOCK IN SHORT TRIES (raised by the runner-link coordinator, 2026-11-06, before this reached main)
-- ------------------------------------------------------------------------------------------------------------
-- Adding the column and the CHECK needs ACCESS EXCLUSIVE on wiki_model_request, which the wiki worker's model queue
-- reads and writes on every call it makes. Holding the lock is short. Waiting for it is the danger, as for 0476 to
-- 0479: a waiting ALTER queues each later reader and writer of the table behind it. With production's lock_timeout
-- of 30 s (docker-compose.yml), a long wait would also fail the migration, and a failed migration stops the
-- apiserver from starting, the image before it too (P3009). So the lock is asked for 2 s at a time, with 1 s between
-- tries in which everything else runs, up to 60 tries: 3 minutes, inside statement_timeout's 300 s. One DO
-- statement, as in 0478, because a loop of tries needs PL/pgSQL. Under the lock it changes the catalog only: the
-- column, and the CHECK added NOT VALID, which holds every row written from then on and reads none already there.
--
-- THE CHECK, VALIDATED IN A TRANSACTION OF ITS OWN
-- ------------------------------------------------
-- Proving the CHECK of the stored rows reads all of them: about 90,000 rows and 810 MB in production (2026-11-06).
-- Added without NOT VALID, that read would run under ACCESS EXCLUSIVE and stop every reader and writer of the table
-- for as long as it takes. VALIDATE CONSTRAINT reads them under SHARE UPDATE EXCLUSIVE, which conflicts with DDL and
-- VACUUM alone, so neither holding it nor waiting for it holds up a reader or a writer. lock_timeout is therefore
-- lifted for it, as 0479 lifts it for its VALIDATEs; statement_timeout (300 s) still bounds it.
--
-- That is so only once the DO's transaction has ended, and the COMMIT between them is what ends it. `migrate deploy`
-- sends a file with a DO in it to the server whole, as one query, and PostgreSQL runs the statements of one query
-- as one transaction (drilled for 0476 with this repo's Prisma 7.10 and the server's statement log, task C5,
-- 2026-11-06, and again for this file). Without the COMMIT the VALIDATE would read the table under the lock the DO
-- took. A COMMIT inside such a query commits what came before it, and the statements after it run in a transaction
-- of their own; the server answers it with a WARNING, "there is no transaction in progress", which is expected here.
-- Sent a statement at a time, each statement would be its own transaction anyway and the COMMIT would only warn.
--
-- NUMBERING, RE-RUNNABILITY
-- -------------------------
-- 0482 follows 0481, the highest number on main, the project branches and the pushed task branches on 2026-11-06.
-- It was rewritten in place for the short tries before any deployment had applied it (production stood at 0478 on
-- 2026-11-06 16:42Z). The whole file can run twice: the column is added IF NOT EXISTS, the CHECK only when the
-- table has none of that name, and validating a CHECK already validated changes nothing. That is also the way back
-- from a failure. If the DO runs out of tries, nothing of it stays and its error says what to do. If the VALIDATE
-- passes statement_timeout, the column and the NOT VALID CHECK stay, Prisma records the migration as failed, and
-- every later deploy stops on P3009 until an operator runs
--   prisma migrate resolve --rolled-back 0482_wiki_model_request_material
-- and deploys again. src/apiserver/src/wiki-worker/wiki-model-request-material-migration.pg.spec.ts holds the file
-- to all of this against a real PostgreSQL, through the real `prisma migrate deploy`.
-- ══════════════════════════════════════════════════════════════════════════════════════════════════

DO $$
DECLARE
  tries integer := 0;
BEGIN
  PERFORM set_config('lock_timeout', '2s', true);
  LOOP
    BEGIN
      ALTER TABLE "wiki_model_request" ADD COLUMN IF NOT EXISTS "material" JSONB;
      IF NOT EXISTS (SELECT 1 FROM pg_constraint
                      WHERE conrelid = '"wiki_model_request"'::regclass
                        AND conname = 'wiki_model_request_material_chk') THEN
        ALTER TABLE "wiki_model_request" ADD CONSTRAINT "wiki_model_request_material_chk"
          CHECK ("material" IS NULL OR jsonb_typeof("material") = 'object') NOT VALID;
      END IF;
      EXIT;
    EXCEPTION WHEN lock_not_available THEN
      tries := tries + 1;
      IF tries >= 60 THEN
        RAISE EXCEPTION '0482: "wiki_model_request" was not free in 60 tries of 2 s each. Once what holds it has ended, mark the migration rolled back (prisma migrate resolve --rolled-back 0482_wiki_model_request_material) and deploy again: it is safe to run twice.'
          USING ERRCODE = 'lock_not_available';
      END IF;
      PERFORM pg_sleep(1);
    END;
  END LOOP;
END $$;

COMMIT;

SET lock_timeout = 0;

ALTER TABLE "wiki_model_request" VALIDATE CONSTRAINT "wiki_model_request_material_chk";

RESET lock_timeout;
