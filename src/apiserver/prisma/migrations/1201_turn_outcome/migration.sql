-- ══════════════════════════════════════════════════════════════════════════════════════════════
-- 1201: every turn's outcome on the turn (docs/session-three-state-plan.md §5 step 2.1, design §4.2;
-- project 3508bDBDE5xPH43TYuiqP). Today a failed or interrupted turn is recorded only as the session's
-- status; `conversation_turn.status` says only where the turn is in the queue.
--
-- WHAT IT ADDS
-- ------------
-- conversation_turn, two nullable columns:
--   outcome   ANSWERED | FAILED | INTERRUPTED | CANCELLED: how the turn's latest completion ended.
--   error     what it failed or was stopped with, as the runner reported it.
-- session, one nullable column:
--   last_turn_outcome   the same value as the outcome of the session's latest completed turn, for list rows.
-- conversation_turn_outcome_chk and session_last_turn_outcome_chk hold each to the four values.
--
-- Written by runner turn-complete (runner-api.controller.ts) in the statements that already write the turn's
-- and the session's status. Nothing reads them yet. Turns written before this stay null; 1202 backfills
-- session.last_turn_outcome.
--
-- LOCKS
-- -----
-- As 1100: ADD COLUMN without a default is a catalogue change, no rewrite. Both tables' locks are asked for in
-- one DO statement, 2 s at a time, 1 s apart, up to 45 tries (a try can wait 2 s for each table). The CHECKs
-- are added NOT VALID here, and validated by 1202, a file with no DO, so the validating scan does not run
-- inside the transaction holding these ACCESS EXCLUSIVE locks. No function, trigger or type is created,
-- replaced or dropped. No INSERT, UPDATE or DELETE.
--
-- NUMBERING, RE-RUNNABILITY
-- -------------------------
-- 1201: main stands at 1200; origin/orbit/* and origin/project/* use up to 1170 (rescanned 2026-11-19 13:54Z). Not a multiple of 10, by the project rule.
-- Can run twice: ADD COLUMN IF NOT EXISTS, DROP CONSTRAINT IF EXISTS.
-- ══════════════════════════════════════════════════════════════════════════════════════════════

DO $$
DECLARE
  tries integer := 0;
BEGIN
  PERFORM set_config('lock_timeout', '2s', true);
  LOOP
    BEGIN
      ALTER TABLE "conversation_turn"
        ADD COLUMN IF NOT EXISTS "outcome" TEXT,
        ADD COLUMN IF NOT EXISTS "error" TEXT;
      ALTER TABLE "conversation_turn" DROP CONSTRAINT IF EXISTS "conversation_turn_outcome_chk";
      ALTER TABLE "conversation_turn"
        ADD CONSTRAINT "conversation_turn_outcome_chk" CHECK (
          "outcome" IS NULL OR "outcome" IN ('ANSWERED', 'FAILED', 'INTERRUPTED', 'CANCELLED')
        ) NOT VALID;
      ALTER TABLE "session" ADD COLUMN IF NOT EXISTS "last_turn_outcome" TEXT;
      ALTER TABLE "session" DROP CONSTRAINT IF EXISTS "session_last_turn_outcome_chk";
      ALTER TABLE "session"
        ADD CONSTRAINT "session_last_turn_outcome_chk" CHECK (
          "last_turn_outcome" IS NULL
          OR "last_turn_outcome" IN ('ANSWERED', 'FAILED', 'INTERRUPTED', 'CANCELLED')
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
