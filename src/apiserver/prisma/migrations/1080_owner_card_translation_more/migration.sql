-- ══════════════════════════════════════════════════════════════════════════════════════════════
-- 1080: more owner cards are translated (project 'Translate every owner card', criterion 4; decisions 1A–5A;
-- board docs/mocks/session-translation/04-owner-cards.html). 1070 did the coordinator question and the owner
-- request; this does completion evidence, the owner-confirmation review, crossings and criteria proposals.
-- START_REQUEST and DONE_REQUEST are project_open_item rows and use 1070's column. Wire shape: @orbit/shared
-- translation.ts (OwnerCardTranslation, EvidenceTranslation). Server flow: src/apiserver/src/sessions/card-translation.ts.
--
-- WHAT IT ADDS
-- ------------
-- task_completion_evidence.translation             JSONB, nullable: { lang, failed?, claim?, gaps? }.
-- task_owner_confirmation_review_record.translation JSONB, nullable: { lang, failed?, judgment?, needsYou?,
--                                                   reason?, problems? }.
-- project_handoff_approval.translation             JSONB, nullable: { lang, failed?, title?, reason? }.
-- project_criteria_proposal_translation            one row per translated criteria proposal, keyed by its
--                                                   project_ratified_action_intent id: { lang, failed?, proposed? }.
-- The card's own columns stay exactly what the agent wrote; the translation is kept beside them, and NULL (or no
-- row) means translation was not involved. Nothing is backfilled: a card still open is translated the first time it
-- is read with translation on (decision 1A).
--
-- WHY A TABLE FOR THE PROPOSAL
-- ----------------------------
-- 0195's BEFORE UPDATE OR DELETE trigger refuses every write to a filed project_ratified_action_intent: the
-- proposal is frozen the moment it is filed, which is the point. Its translation is a reader's copy, not part of
-- what is approved, so it lives in a table of its own and cascades away with the proposal.
--
-- GUARDS
-- ------
-- project_handoff_approval_guard (0155) checks named columns; `translation` is not one of them, and only a PENDING
-- row (a same-state write) is ever given one. Neither of the other two tables has an UPDATE guard; their
-- open_list_epoch statement triggers (0484) bump the owner's counter as any write does.
--
-- LOCKS
-- -----
-- As 1070: ADD COLUMN without a default is a catalogue change, no rewrite; each table's lock is asked for 2 s at a
-- time, 1 s apart, up to 60 tries, in one DO statement per table. CREATE TABLE takes a SHARE ROW EXCLUSIVE lock on
-- the referenced table for the foreign key only. No INSERT, UPDATE or DELETE.
--
-- NUMBERING, RE-RUNNABILITY
-- -------------------------
-- 1080: main stands at 0990 and every origin/project/* and pushed origin/orbit/* branch at or below 1070
-- (scanned 2026-11-18). Can run twice: ADD COLUMN IF NOT EXISTS, CREATE TABLE IF NOT EXISTS.
-- ══════════════════════════════════════════════════════════════════════════════════════════════

DO $$
DECLARE
  tries integer := 0;
BEGIN
  PERFORM set_config('lock_timeout', '2s', true);
  LOOP
    BEGIN
      ALTER TABLE "task_completion_evidence" ADD COLUMN IF NOT EXISTS "translation" JSONB;
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
      ALTER TABLE "task_owner_confirmation_review_record" ADD COLUMN IF NOT EXISTS "translation" JSONB;
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
      ALTER TABLE "project_handoff_approval" ADD COLUMN IF NOT EXISTS "translation" JSONB;
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

CREATE TABLE IF NOT EXISTS "project_criteria_proposal_translation" (
  "intent_id"   UUID         NOT NULL,
  "owner_id"    UUID         NOT NULL,
  "translation" JSONB        NOT NULL,
  "updated_at"  TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "project_criteria_proposal_translation_pkey" PRIMARY KEY ("intent_id"),
  CONSTRAINT "project_criteria_proposal_translation_intent_fkey" FOREIGN KEY ("intent_id")
    REFERENCES "project_ratified_action_intent"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
