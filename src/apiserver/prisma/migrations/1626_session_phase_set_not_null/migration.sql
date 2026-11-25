-- ══════════════════════════════════════════════════════════════════════════════════════════════
-- 1626: session.phase NOT NULL (docs/session-status-retirement-plan.md §1.5, §4.6; project 353SgnUjvamRr06Sho0EZ, task T5).
--
-- SET NOT NULL scans nothing here: the validated session_phase_not_null_chk (1622, 1625) already proves no row is null.
-- The helper CHECK is dropped in the same statement list, having done its work. Both are catalog changes under ACCESS
-- EXCLUSIVE, asked for 2 s at a time, 1 s apart, up to 45 tries (1261, 1401, 1611). A server one release older never
-- writes phase: 1611's BEFORE trigger gives every inserted and updated row one before the NOT NULL is checked. Can run
-- twice: SET NOT NULL on a NOT NULL column is a no-op, and the drop is IF EXISTS.
-- ══════════════════════════════════════════════════════════════════════════════════════════════

DO $$
DECLARE
  tries integer := 0;
BEGIN
  PERFORM set_config('lock_timeout', '2s', true);
  LOOP
    BEGIN
      ALTER TABLE "session" ALTER COLUMN "phase" SET NOT NULL;
      ALTER TABLE "session" DROP CONSTRAINT IF EXISTS "session_phase_not_null_chk";
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
