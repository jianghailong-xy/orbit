-- ══════════════════════════════════════════════════════════════════════════════════════════════
-- 0550: session translation, the agent's question cards and approvals (project 34vcDOhN0OCStfnVuTyPq, task A2).
-- Wire shapes: @orbit/shared translation.ts (ApprovalTranslation). Server flow: src/apiserver/src/sessions/reply-translation.ts.
--
-- WHY
-- ---
-- With Settings › Translation on, what an approval card shows the owner — an AskUserQuestion's questions and
-- options, a tool card's description and plan — is translated into the owner's language (decision 3A). The
-- card's `input` stays exactly what the engine sent, because the answer is read against it; the translation
-- is kept beside it.
--
-- WHAT IT ADDS
-- ------------
-- approval.translation  JSONB, nullable: { lang, failed? , description?, plan?, questions? }. NULL on every card
--                       translation was not involved in, and while a card is being translated.
--
-- Agent replies need no migration: their translation is written into the run_event's own payload.
-- Nothing is backfilled.
--
-- LOCKS
-- -----
-- As 0531: ADD COLUMN without a default is a catalogue change, no rewrite; the lock is asked for 2 s at a
-- time, 1 s apart, up to 60 tries, in one DO statement. No constraint, function, trigger or type. No INSERT,
-- UPDATE or DELETE.
--
-- NUMBERING, RE-RUNNABILITY
-- -------------------------
-- 0550: main, every origin/project/* and pushed origin/orbit/* branch stand at or below 0545 (scanned 2026-11-12).
-- Can run twice: ADD COLUMN IF NOT EXISTS.
-- ══════════════════════════════════════════════════════════════════════════════════════════════

DO $$
DECLARE
  tries integer := 0;
BEGIN
  PERFORM set_config('lock_timeout', '2s', true);
  LOOP
    BEGIN
      ALTER TABLE "approval" ADD COLUMN IF NOT EXISTS "translation" JSONB;
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
