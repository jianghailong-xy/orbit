-- ══════════════════════════════════════════════════════════════════════════════════════════════
-- 0531: session translation, the owner's messages (project 34vcDOhN0OCStfnVuTyPq, task A1).
-- Wire shapes: @orbit/shared translation.ts. Server flow: src/apiserver/src/sessions/turn-translation.ts.
--
-- WHY
-- ---
-- With Settings › Translation on, the owner's message is translated into English by the server's DeepSeek
-- key before the engine gets it. The turn keeps both: `content` is what the runner delivers (English), and
-- the owner's words are kept beside it. While it is being translated, and after a translation failed, the
-- turn must not be delivered (decision 1A); it waits in status 'HELD', which no claim, inbox lease or
-- queue count reads (the status column is a plain string: no constraint lists its values).
--
-- WHAT IT ADDS
-- ------------
-- conversation_turn, three nullable columns:
--   display_prompt     what the owner wrote, as written. NULL on every turn translation was not involved in.
--   translation_state  TRANSLATING | FAILED | DONE | SENT_AS_WRITTEN; NULL likewise.
--   translation_lang   the language the owner wrote in (one of the seven codes); NULL likewise.
-- conversation_turn_translation_chk: the three are set together or not at all; a state is one of the four;
-- a turn being translated or whose translation failed is HELD, and a HELD turn is one of those.
--
-- User preferences (`translationEnabled`, `translationLanguage`) are keys of the existing `user.preferences`
-- JSON, which needs no migration.
--
-- Nothing is backfilled: every existing turn reads NULL, which is what every client drew before.
--
-- LOCKS
-- -----
-- As 0502: ADD COLUMN without a default is a catalogue change, no rewrite; the lock is asked for 2 s at a
-- time, 1 s apart, up to 60 tries, in one DO statement. The CHECK is added NOT VALID and then validated.
-- No function, trigger or type is created, replaced or dropped. No INSERT, UPDATE or DELETE.
--
-- NUMBERING, RE-RUNNABILITY
-- -------------------------
-- 0531: main, every origin/project/* and pushed origin/orbit/* branch stand at or below 0530 (scanned 2026-11-11).
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
        ADD COLUMN IF NOT EXISTS "display_prompt" TEXT,
        ADD COLUMN IF NOT EXISTS "translation_state" TEXT,
        ADD COLUMN IF NOT EXISTS "translation_lang" TEXT;
      ALTER TABLE "conversation_turn" DROP CONSTRAINT IF EXISTS "conversation_turn_translation_chk";
      ALTER TABLE "conversation_turn"
        ADD CONSTRAINT "conversation_turn_translation_chk" CHECK (
          (
            "display_prompt" IS NULL AND "translation_state" IS NULL AND "translation_lang" IS NULL
            AND "status" <> 'HELD'
          )
          OR (
            "display_prompt" IS NOT NULL AND "translation_lang" IS NOT NULL
            AND "translation_state" IN ('TRANSLATING', 'FAILED', 'DONE', 'SENT_AS_WRITTEN')
            AND (("status" = 'HELD') = ("translation_state" IN ('TRANSLATING', 'FAILED')))
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

ALTER TABLE "conversation_turn" VALIDATE CONSTRAINT "conversation_turn_translation_chk";
