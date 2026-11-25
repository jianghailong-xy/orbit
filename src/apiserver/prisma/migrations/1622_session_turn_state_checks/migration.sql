-- ══════════════════════════════════════════════════════════════════════════════════════════════
-- 1622: the CHECKs that hold the two spellings of a session's state equal while both exist (docs/session-status-retirement-plan.md
-- §1.4, §1.5, §4.1 deploy D2; project 353SgnUjvamRr06Sho0EZ, task T5).
--
-- WHAT IT ADDS
-- ------------
-- First it ASSERTS that no row disagrees with its derivation (scripts/session-turn-state-census.sql's two counts), and
-- refuses otherwise. Then, all NOT VALID (1623, 1624 and 1625 validate them, one file each):
--   session_turn_state_agrees_chk     turn_state is the stored word's: PENDING = QUEUED, RUNNING = IN_FLIGHT,
--                                     INTERRUPTED = ABANDONED, every other word none. IS NOT DISTINCT FROM, so a null on
--                                     either side is compared and not waved through. Transitional: D4 drops it.
--   session_turn_state_released_chk   a released session holds no turn, slot or claim.
--   session_phase_not_null_chk        phase IS NOT NULL: what lets 1626 SET NOT NULL without a scan, and goes there.
--
-- WHY THE ASSERTION
-- -----------------
-- A NOT VALID CHECK checks every row WRITTEN from now on. A row the backfill never reached (null turn_state under the
-- word PENDING) would refuse every later update of that session, whatever column it names. So a database whose backfill
-- (task T3, scripts/session-turn-state-backfill.sh) has not finished stops here, before any constraint exists: the old
-- server goes on serving. Run the backfill, then
--   prisma migrate resolve --rolled-back 1622_session_turn_state_checks
-- and deploy again. A database with no session (a new install) passes at once.
--
-- WHICH RELEASE IT MAY SHIP IN, WHAT A SERVER ONE RELEASE OLDER DOES
-- ------------------------------------------------------------------
-- Deploy D2, after 1611 has been live on every replica and the backfill has run. A D1 server writes the word only; 1611's
-- trigger derives turn_state and phase from it in the same row, so every write it makes satisfies all three. A write of
-- turn_state alone that disagrees with the word is refused (the trigger fires on a statement that names status only).
--
-- LOCKS
-- -----
-- The assertion reads session (ACCESS SHARE; one scan, no lock that holds anybody up). ADD CONSTRAINT … NOT VALID is a
-- catalog change under ACCESS EXCLUSIVE, asked for 2 s at a time, 1 s apart, up to 45 tries (1261, 1401, 1611). The file
-- holds a DO block, so prisma migrate deploy (7.10) sends it whole, as one transaction.
--
-- NUMBERING, RE-RUNNABILITY
-- -------------------------
-- 1622-1633: 1611/1612 are D1's and 1621 is task T4's, the highest on main, every project/*, orbit/* and probe/*
-- branch on 2026-11-25. No multiple of 10. Can run twice: IF EXISTS drops before the CHECKs.
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
                   '(prisma migrate resolve --rolled-back 1622_session_turn_state_checks) and deploy again.';
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
      ALTER TABLE "session" DROP CONSTRAINT IF EXISTS "session_turn_state_released_chk";
      ALTER TABLE "session"
        ADD CONSTRAINT "session_turn_state_released_chk"
        CHECK ("finished_at" IS NULL OR "turn_state" IS NULL) NOT VALID;
      ALTER TABLE "session" DROP CONSTRAINT IF EXISTS "session_phase_not_null_chk";
      ALTER TABLE "session"
        ADD CONSTRAINT "session_phase_not_null_chk"
        CHECK ("phase" IS NOT NULL) NOT VALID;
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
