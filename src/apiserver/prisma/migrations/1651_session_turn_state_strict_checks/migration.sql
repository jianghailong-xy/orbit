-- ══════════════════════════════════════════════════════════════════════════════════════════════
-- 1651: the strict CHECK that holds the two spellings of a session's state equal while both exist, once the backfill has
-- run (docs/session-status-retirement-plan.md §1.4, §1.5, §4.1 D2, §4.6; project 353SgnUjvamRr06Sho0EZ, the task that
-- follows T3; restated from task T5's commit 1daa60562d).
--
-- WHAT IT DOES
-- ------------
-- First it FILLS every row that was never filled: no phase, or no turn_state under a word that means one. The write is
-- scripts/session-turn-state-backfill.sql's own (turn_state from session_turn_state_of_status, in a statement naming it,
-- so 1611's session_zz_phase writes phase from session_phase_of). A turn_state that is null because the word means none,
-- beside a phase, is filled already and is not written. Then it ASSERTS that no row disagrees with its derivation
-- (scripts/session-turn-state-census.sql's two counts): what is left is filled and wrong, and it refuses. Then, both NOT
-- VALID (1652 and 1654 validate them, one file each):
--   session_turn_state_agrees_chk     turn_state is the stored word's: PENDING = QUEUED, RUNNING = IN_FLIGHT,
--                                     INTERRUPTED = ABANDONED, every other word none. IS NOT DISTINCT FROM, so a null on
--                                     either side is compared and not waved through. Transitional: D4 drops it.
--   session_phase_not_null_chk        phase IS NOT NULL: what lets 1655 SET NOT NULL without a scan, and goes there.
-- and it drops 1622's NULL-tolerant session_turn_state_agrees_unless_null_chk, in the same transaction.
-- 1622's session_turn_state_released_chk stays; 1653 validates it.
--
-- WHY IT FILLS, AND WHY IT STILL ASSERTS
-- --------------------------------------
-- The server runs prisma migrate deploy as it starts, and an upgrade needs no manual step: a self-hosted database that
-- goes straight from before 1611 to this release has never run the backfill (1611 writes no row), so this file does it.
-- On a database the batched backfill has filled (task T3, production, 2026-11-26) the UPDATE writes no row; the batches
-- were that big table's path, since one UPDATE holds the lock of every row it writes until it commits.
-- A NOT VALID CHECK checks every row WRITTEN from now on, so a filled row that disagrees would refuse every later update
-- of that session. No release writes one; it stops here, before any constraint changes. Correct it, then
--   prisma migrate resolve --rolled-back 1651_session_turn_state_strict_checks
-- and deploy again.
--
-- WHAT A SERVER ONE RELEASE OLDER DOES
-- ------------------------------------
-- It writes the word (alone, or with the turn state it means), and 1611's trigger derives turn_state and phase from it
-- in the same row, so every write it makes satisfies both. A write of turn_state alone that disagrees with the word is
-- refused (the trigger fires on a statement that names status only).
--
-- LOCKS
-- -----
-- The UPDATE takes ROW EXCLUSIVE and the locks of the rows it writes, waiting as long as it must. The COMMIT after it
-- releases them: held into the DO block, they would keep a server still writing those rows and the ALTER TABLE waiting on
-- each other. prisma migrate deploy (7.10) sends a file with a DO block whole, so without the COMMIT the file is one
-- transaction (0482). The fill stays if the rest fails, and running it again writes nothing.
-- The assertion reads session (ACCESS SHARE; one scan, no lock that holds anybody up). ADD and DROP CONSTRAINT are
-- catalog changes under ACCESS EXCLUSIVE, asked for 2 s at a time, 1 s apart, up to 45 tries (1261, 1401, 1611, 1622).
-- The DO block is one transaction: the assertion and the swap of the CHECKs happen together or not at all.
--
-- NUMBERING, RE-RUNNABILITY
-- -------------------------
-- 1651-1655: 1643 is the highest on main, every project/*, orbit/* and probe/* branch on 2026-11-26. No multiple of 10.
-- Can run twice: the UPDATE finds nothing left, and IF EXISTS drops come before the CHECKs.
-- ══════════════════════════════════════════════════════════════════════════════════════════════

SET lock_timeout = 0;

UPDATE "session" s
   SET "turn_state" = session_turn_state_of_status(s."status")
 WHERE s."phase" IS NULL
    OR (s."turn_state" IS NULL AND session_turn_state_of_status(s."status") IS NOT NULL);

COMMIT;

RESET lock_timeout;

DO $$
DECLARE
  tries integer := 0;
  disagreeing bigint;
  example uuid;
BEGIN
  SELECT count(*), (array_agg("id"))[1] INTO disagreeing, example
    FROM "session"
   WHERE "turn_state" IS DISTINCT FROM session_turn_state_of_status("status")
      OR "phase" IS DISTINCT FROM session_phase_of("finished_at", session_turn_state_of_status("status"),
                                                  "engine_turn_active", "running_subagents", "running_bg_jobs");
  IF disagreeing > 0 THEN
    RAISE EXCEPTION '% session rows have a filled turn_state or phase that is not derived from their status, for example %',
      disagreeing, example
      USING HINT = 'Empty rows were filled just now, so something wrote these against the status: find what did. '
                   'scripts/session-turn-state-census.sql counts them and scripts/session-turn-state-backfill.sh '
                   'rewrites them from the status. Then mark this migration rolled back '
                   '(prisma migrate resolve --rolled-back 1651_session_turn_state_strict_checks) and deploy again.';
  END IF;

  PERFORM set_config('lock_timeout', '2s', true);
  LOOP
    BEGIN
      ALTER TABLE "session" DROP CONSTRAINT IF EXISTS "session_turn_state_agrees_chk";
      ALTER TABLE "session"
        ADD CONSTRAINT "session_turn_state_agrees_chk"
        CHECK ("turn_state" IS NOT DISTINCT FROM (CASE "status"
                 WHEN 'PENDING' THEN 'QUEUED' WHEN 'RUNNING' THEN 'IN_FLIGHT' WHEN 'INTERRUPTED' THEN 'ABANDONED' END))
        NOT VALID;
      ALTER TABLE "session" DROP CONSTRAINT IF EXISTS "session_phase_not_null_chk";
      ALTER TABLE "session"
        ADD CONSTRAINT "session_phase_not_null_chk"
        CHECK ("phase" IS NOT NULL) NOT VALID;
      ALTER TABLE "session" DROP CONSTRAINT IF EXISTS "session_turn_state_agrees_unless_null_chk";
      EXIT;
    EXCEPTION WHEN lock_not_available OR deadlock_detected THEN
      tries := tries + 1;
      IF tries >= 45 THEN
        RAISE;
      END IF;
      PERFORM pg_sleep(1);
    END;
  END LOOP;
END $$;
