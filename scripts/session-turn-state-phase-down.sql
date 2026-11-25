-- Undo migrations 1611 and 1612 (deploy D1 of docs/session-status-retirement-plan.md §4.1): drop session.turn_state,
-- session.phase, their CHECKs, the two triggers and the four functions. Only while nothing reads or writes the two
-- columns, that is before deploy D2: D1 code does not declare them.
--
--   psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 -f scripts/session-turn-state-phase-down.sql
--
-- After it, delete the two rows of _prisma_migrations, or the next `prisma migrate deploy` will not put them back:
--   DELETE FROM _prisma_migrations WHERE migration_name IN ('1611_session_turn_state_phase',
--                                                             '1612_session_turn_state_phase_validate');
--
-- The locks are asked for as 1611 asks for them: one DO statement, 2 s at a time, 1 s apart, up to 45 tries.
-- DROP COLUMN rewrites no row. Can run twice: IF EXISTS on everything.

DO $$
DECLARE
  tries integer := 0;
BEGIN
  PERFORM set_config('lock_timeout', '2s', true);
  LOOP
    BEGIN
      DROP TRIGGER IF EXISTS "session_zz_phase" ON "session";
      DROP TRIGGER IF EXISTS "session_aa_turn_state_from_status" ON "session";
      ALTER TABLE "session" DROP CONSTRAINT IF EXISTS "session_phase_chk";
      ALTER TABLE "session" DROP CONSTRAINT IF EXISTS "session_turn_state_chk";
      ALTER TABLE "session" DROP COLUMN IF EXISTS "phase";
      ALTER TABLE "session" DROP COLUMN IF EXISTS "turn_state";
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

DROP FUNCTION IF EXISTS session_phase_from_facts();
DROP FUNCTION IF EXISTS session_turn_state_from_status();
DROP FUNCTION IF EXISTS session_phase_of(timestamp, text, boolean, text[], text[]);
DROP FUNCTION IF EXISTS session_turn_state_of_status(run_status);
