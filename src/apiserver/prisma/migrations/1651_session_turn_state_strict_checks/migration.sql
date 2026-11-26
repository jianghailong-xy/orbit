-- ══════════════════════════════════════════════════════════════════════════════════════════════
-- 1651: the strict CHECK that holds the two spellings of a session's state equal while both exist, once the backfill has
-- run (docs/session-status-retirement-plan.md §1.4, §1.5, §4.1 D2, §4.6; project 353SgnUjvamRr06Sho0EZ, the task that
-- follows T3; restated from task T5's commit 1daa60562d).
--
-- WHAT IT DOES
-- ------------
-- First it ASSERTS that no row disagrees with its derivation (scripts/session-turn-state-census.sql's two counts), and
-- refuses otherwise. Then, both NOT VALID (1652 and 1654 validate them, one file each):
--   session_turn_state_agrees_chk     turn_state is the stored word's: PENDING = QUEUED, RUNNING = IN_FLIGHT,
--                                     INTERRUPTED = ABANDONED, every other word none. IS NOT DISTINCT FROM, so a null on
--                                     either side is compared and not waved through. Transitional: D4 drops it.
--   session_phase_not_null_chk        phase IS NOT NULL: what lets 1655 SET NOT NULL without a scan, and goes there.
-- and it drops 1622's NULL-tolerant session_turn_state_agrees_unless_null_chk, in the same transaction.
-- 1622's session_turn_state_released_chk stays; 1653 validates it.
--
-- WHY THE ASSERTION
-- -----------------
-- A NOT VALID CHECK checks every row WRITTEN from now on. A row the backfill never reached (null turn_state under the
-- word PENDING) would refuse every later update of that session, whatever column it names. So a database whose backfill
-- (task T3, scripts/session-turn-state-backfill.sh; run on production 2026-11-26) has not finished stops here, before
-- any constraint changes. Run the backfill, then
--   prisma migrate resolve --rolled-back 1651_session_turn_state_strict_checks
-- and deploy again. A database with no session (a new install) passes at once.
--
-- WHAT A SERVER ONE RELEASE OLDER DOES
-- ------------------------------------
-- It writes the word (alone, or with the turn state it means), and 1611's trigger derives turn_state and phase from it
-- in the same row, so every write it makes satisfies both. A write of turn_state alone that disagrees with the word is
-- refused (the trigger fires on a statement that names status only).
--
-- LOCKS
-- -----
-- The assertion reads session (ACCESS SHARE; one scan, no lock that holds anybody up). ADD and DROP CONSTRAINT are
-- catalog changes under ACCESS EXCLUSIVE, asked for 2 s at a time, 1 s apart, up to 45 tries (1261, 1401, 1611, 1622).
-- The file holds a DO block, so prisma migrate deploy (7.10) sends it whole, as one transaction.
--
-- NUMBERING, RE-RUNNABILITY
-- -------------------------
-- 1651-1655: 1643 is the highest on main, every project/*, orbit/* and probe/* branch on 2026-11-26. No multiple of 10.
-- Can run twice: IF EXISTS drops before the CHECKs.
-- ══════════════════════════════════════════════════════════════════════════════════════════════

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
    RAISE EXCEPTION '% session rows have a turn_state or phase that is not derived from their status, for example %',
      disagreeing, example
      USING HINT = 'Run scripts/session-turn-state-backfill.sh until it reports 0, mark this migration rolled back '
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
