-- ══════════════════════════════════════════════════════════════════════════════════════════════
-- 1100: why the owner's held message could not be translated (project 34zYPsLHOM8cXYreQJo4Q, "Translation failure
-- policy B", criterion 1; board docs/ux/translation-failure-policy.html). Wire shape: @orbit/shared translation.ts
-- (TurnTranslation.failureReason / httpStatus, TranslationFailureReason). Server flow: src/apiserver/src/sessions/
-- turn-translation.ts and SessionsService.translateHeldTurn.
--
-- WHAT IT ADDS
-- ------------
-- conversation_turn, two nullable columns:
--   translation_failure_reason  TIMEOUT | NETWORK | HTTP | EMPTY | TRUNCATED | MANGLED | NO_KEY | UNAVAILABLE.
--   translation_http_status     the translator's HTTP status, beside reason HTTP only.
-- conversation_turn_translation_failure_chk: a reason only on a FAILED turn and one of the eight; a status only
-- beside HTTP, and an HTTP status code (100–599). A FAILED turn may have no reason: every turn that failed before
-- this migration has none, and clients draw the generic failure line for it.
--
-- Nothing is backfilled.
--
-- LOCKS
-- -----
-- As 0532: ADD COLUMN without a default is a catalogue change, no rewrite; the lock is asked for 2 s at a time,
-- 1 s apart, up to 60 tries, in one DO statement. The CHECK is added NOT VALID and then validated (every row reads
-- NULL, so it holds). No function, trigger or type is created, replaced or dropped. No INSERT, UPDATE or DELETE.
--
-- NUMBERING, RE-RUNNABILITY
-- -------------------------
-- 1100: main stands at 1080; origin/orbit/* and origin/project/* branches use up to 1090 (scanned 2026-11-18).
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
        ADD COLUMN IF NOT EXISTS "translation_failure_reason" TEXT,
        ADD COLUMN IF NOT EXISTS "translation_http_status" INTEGER;
      ALTER TABLE "conversation_turn" DROP CONSTRAINT IF EXISTS "conversation_turn_translation_failure_chk";
      ALTER TABLE "conversation_turn"
        ADD CONSTRAINT "conversation_turn_translation_failure_chk" CHECK (
          (
            "translation_failure_reason" IS NULL
            OR (
              "translation_state" = 'FAILED'
              AND "translation_failure_reason" IN
                ('TIMEOUT', 'NETWORK', 'HTTP', 'EMPTY', 'TRUNCATED', 'MANGLED', 'NO_KEY', 'UNAVAILABLE')
            )
          )
          AND (
            "translation_http_status" IS NULL
            OR ("translation_failure_reason" = 'HTTP' AND "translation_http_status" BETWEEN 100 AND 599)
          )
        ) NOT VALID;
      EXIT;
    EXCEPTION WHEN lock_not_available THEN
      tries := tries + 1;
      IF tries >= 60 THEN
        RAISE;
      END IF;
      PERFORM pg_sleep(1);
    END;
  END LOOP;
END $$;

ALTER TABLE "conversation_turn" VALIDATE CONSTRAINT "conversation_turn_translation_failure_chk";
