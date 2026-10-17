-- 0378 — a coordinator's deliberate hand-over is durable owner-facing history.
-- The session id is provenance, not a relation: retaining the explanation must not retain a
-- conversation that may later be purged.
BEGIN;

ALTER TABLE "project_open_item"
  ADD COLUMN "handover_note" TEXT,
  ADD COLUMN "handed_over_at" TIMESTAMPTZ(3),
  ADD COLUMN "handed_over_by_session_id" UUID;

ALTER TABLE "project_open_item"
  ADD CONSTRAINT "project_open_item_handover_note_chk"
    CHECK ("handover_note" IS NULL OR char_length(btrim("handover_note")) BETWEEN 1 AND 2000),
  ADD CONSTRAINT "project_open_item_handover_fields_chk"
    CHECK (("handover_note" IS NULL) = ("handed_over_at" IS NULL)
      AND ("handover_note" IS NULL) = ("handed_over_by_session_id" IS NULL));

COMMIT;
