-- 0376 — a coordinator's deliberate hand-over is durable owner-facing history.
--
-- The session id is intentionally not a foreign key: deleting a conversation must not erase the
-- explanation the owner was given.  The three columns are written together by the hand-over CAS;
-- the all-or-none check keeps a partially written history out even if an older client reaches the
-- table directly.

BEGIN;

ALTER TABLE "project_open_item"
  ADD COLUMN "handover_note" text,
  ADD COLUMN "handed_over_at" TIMESTAMPTZ(3),
  ADD COLUMN "handed_over_by_session_id" uuid,
  ADD CONSTRAINT "project_open_item_handover_note_chk"
    CHECK ("handover_note" IS NULL
      OR char_length(btrim("handover_note")) BETWEEN 1 AND 2000),
  ADD CONSTRAINT "project_open_item_handover_fields_chk"
    CHECK (("handover_note" IS NULL AND "handed_over_at" IS NULL
      AND "handed_over_by_session_id" IS NULL)
      OR ("handover_note" IS NOT NULL AND "handed_over_at" IS NOT NULL
      AND "handed_over_by_session_id" IS NOT NULL));

COMMIT;
