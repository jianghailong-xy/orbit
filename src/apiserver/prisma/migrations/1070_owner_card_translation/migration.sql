-- ══════════════════════════════════════════════════════════════════════════════════════════════
-- 1070: owner cards outside a session are translated (project 'Translate every owner card', decisions 1A–5A;
-- board docs/mocks/session-translation/04-owner-cards.html). Wire shape: @orbit/shared translation.ts
-- (OwnerCardTranslation). Server flow: src/apiserver/src/sessions/card-translation.ts.
--
-- WHY
-- ---
-- With Settings › Translation on, a coordinator's question (project_open_item, kind COORDINATOR_QUESTION) and an
-- owner request (owner_request, filed by request_owner_action) are shown in the owner's language. The card's own
-- columns stay exactly what the agent wrote — the answer is read against them; the translation is kept beside them.
--
-- WHAT IT ADDS
-- ------------
-- project_open_item.translation  JSONB, nullable: { lang, failed?, question?, options?, ifUnanswered? }.
-- owner_request.translation      JSONB, nullable: { lang, failed?, title?, why?, ifUnanswered?, options?, steps?,
--                                verifyHint? }.
-- NULL on every card translation was not involved in, and while a card is being translated. Nothing is backfilled:
-- a card still open is translated the first time it is read with translation on (decision 1A).
--
-- LOCKS
-- -----
-- As 0550: ADD COLUMN without a default is a catalogue change, no rewrite; each table's lock is asked for 2 s at a
-- time, 1 s apart, up to 60 tries, in one DO statement per table. No constraint, function, trigger or type. No
-- INSERT, UPDATE or DELETE. project_open_item's open_list_epoch triggers are statement triggers on rows written,
-- and an ALTER writes none.
--
-- NUMBERING, RE-RUNNABILITY
-- -------------------------
-- 1070: main stands at 0990 and every origin/project/* and pushed origin/orbit/* branch at or below 1060
-- (scanned 2026-11-18). Can run twice: ADD COLUMN IF NOT EXISTS.
-- ══════════════════════════════════════════════════════════════════════════════════════════════

DO $$
DECLARE
  tries integer := 0;
BEGIN
  PERFORM set_config('lock_timeout', '2s', true);
  LOOP
    BEGIN
      ALTER TABLE "project_open_item" ADD COLUMN IF NOT EXISTS "translation" JSONB;
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

DO $$
DECLARE
  tries integer := 0;
BEGIN
  PERFORM set_config('lock_timeout', '2s', true);
  LOOP
    BEGIN
      ALTER TABLE "owner_request" ADD COLUMN IF NOT EXISTS "translation" JSONB;
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
