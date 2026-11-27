-- ══════════════════════════════════════════════════════════════════════════════════════════════
-- 1261: why a session was released (docs/session-three-state-plan.md §6 step 3.2, design §4.2 and §6.3,
-- decision D1; project 3508bDBDE5xPH43TYuiqP). `session.finished_at` is the release column: set when no
-- runner holds the session, null while one does. This adds the cause beside it.
--
-- WHAT IT ADDS
-- ------------
-- session, one nullable column:
--   release_cause   why the session was released. Today's end reasons (task_done, task_cancelled, ended,
--                   completed, deleted, cancelled, and the legacy idle and orphaned old rows carry), plus the
--                   causes no end reason records: turn_failed, runner_lost, setup_failed, engine_exited,
--                   import_failed, landing_settled.
-- session_release_cause_chk holds it to those values (common/session-release.ts SESSION_RELEASE_CAUSES).
--
-- Written by every write that sets a terminal status, in the same statement, and cleared with finished_at by
-- the revive. end_reason is written exactly as before. 1262 validates the CHECK and backfills.
--
-- LOCKS
-- -----
-- As 1201: ADD COLUMN without a default is a catalogue change, no rewrite. The lock is asked for in one DO
-- statement, 2 s at a time, 1 s apart, up to 45 tries. The CHECK is added NOT VALID here and validated by 1262,
-- a file with no DO, so the validating scan does not run inside the transaction holding this ACCESS EXCLUSIVE
-- lock. No function, trigger or type is created, replaced or dropped. No INSERT, UPDATE or DELETE.
--
-- NUMBERING, RE-RUNNABILITY
-- -------------------------
-- 1261: main, origin/orbit/* and origin/project/* use up to 1260 (rescanned 2026-11-20). Not a multiple of 10,
-- by the project rule. Can run twice: ADD COLUMN IF NOT EXISTS, DROP CONSTRAINT IF EXISTS.
-- ══════════════════════════════════════════════════════════════════════════════════════════════

DO $$
DECLARE
  tries integer := 0;
BEGIN
  PERFORM set_config('lock_timeout', '2s', true);
  LOOP
    BEGIN
      ALTER TABLE "session" ADD COLUMN IF NOT EXISTS "release_cause" TEXT;
      ALTER TABLE "session" DROP CONSTRAINT IF EXISTS "session_release_cause_chk";
      ALTER TABLE "session"
        ADD CONSTRAINT "session_release_cause_chk" CHECK (
          "release_cause" IS NULL
          OR "release_cause" IN (
            'task_done', 'task_cancelled', 'ended', 'completed', 'deleted', 'cancelled', 'idle', 'orphaned',
            'turn_failed', 'runner_lost', 'setup_failed', 'engine_exited', 'import_failed', 'landing_settled'
          )
        ) NOT VALID;
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
