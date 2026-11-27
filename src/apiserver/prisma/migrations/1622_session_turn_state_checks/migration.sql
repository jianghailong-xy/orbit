-- ══════════════════════════════════════════════════════════════════════════════════════════════
-- 1622: the CHECKs on session.turn_state that are safe before the backfill has run, NOT VALID
-- (docs/session-status-retirement-plan.md §1.4, §1.5, §4.1; project 353SgnUjvamRr06Sho0EZ, task T5).
--
-- WHAT IT ADDS
-- ------------
--   session_turn_state_agrees_unless_null_chk   a turn_state that is SET is the stored word's: PENDING = QUEUED,
--                                               RUNNING = IN_FLIGHT, INTERRUPTED = ABANDONED, every other word none.
--                                               IS NOT DISTINCT FROM, so a value beside a word that means none is
--                                               compared and not waved through. A NULL passes: see below.
--   session_turn_state_released_chk             a released session holds no turn, slot or claim.
--
-- WHY NULL PASSES, AND NOTHING ELSE IS HERE
-- -----------------------------------------
-- The project branch reaches main as one merge, so this can be deployed together with 1611, before the backfill (task
-- T3) has filled any row. A NOT VALID CHECK still checks every row WRITTEN from now on, whatever column the write
-- names. A row the backfill has not reached (turn_state and phase NULL under a held word) must go on taking writes, so
-- neither CHECK may refuse a NULL, and nothing here may require phase. The plan's strict session_turn_state_agrees_chk,
-- the two VALIDATEs and phase NOT NULL are a later task's, which lands only after T3 has run on production; it drops
-- the NULL-tolerant CHECK.
--
-- WHAT A SERVER OLDER THAN THIS DOES
-- ----------------------------------
-- A server writes the word only, and 1611's trigger derives turn_state from it in the same row, so every write it makes
-- satisfies both. A write of turn_state alone that disagrees with the word is refused (the trigger fires on a statement
-- that names status only). Every existing row satisfies both: its turn_state is NULL or what 1611's trigger or the
-- backfill derived.
--
-- LOCKS, RE-RUNNABILITY, NUMBERING
-- --------------------------------
-- ADD CONSTRAINT … NOT VALID is a catalog change, no row checked, under ACCESS EXCLUSIVE, asked for 2 s at a time, 1 s
-- apart, up to 45 tries (1261, 1401, 1611). The file holds a DO block, so prisma migrate deploy (7.10) sends it whole,
-- as one transaction. Can run twice: IF EXISTS drops before the CHECKs. 1622, then 1627-1634 for the indexes: 1621 is
-- task T4's, the highest on main, every project/*, orbit/* and probe/* branch on 2026-11-25.
-- ══════════════════════════════════════════════════════════════════════════════════════════════

DO $$
DECLARE
  tries integer := 0;
BEGIN
  PERFORM set_config('lock_timeout', '2s', true);
  LOOP
    BEGIN
      ALTER TABLE "session" DROP CONSTRAINT IF EXISTS "session_turn_state_agrees_unless_null_chk";
      ALTER TABLE "session"
        ADD CONSTRAINT "session_turn_state_agrees_unless_null_chk"
        CHECK ("turn_state" IS NULL OR "turn_state" IS NOT DISTINCT FROM (CASE "status"
                 WHEN 'PENDING' THEN 'QUEUED' WHEN 'RUNNING' THEN 'IN_FLIGHT' WHEN 'INTERRUPTED' THEN 'ABANDONED' END))
        NOT VALID;
      ALTER TABLE "session" DROP CONSTRAINT IF EXISTS "session_turn_state_released_chk";
      ALTER TABLE "session"
        ADD CONSTRAINT "session_turn_state_released_chk"
        CHECK ("finished_at" IS NULL OR "turn_state" IS NULL) NOT VALID;
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
