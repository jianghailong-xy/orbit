-- 0970 — owner rulings as project records (docs/coordinator-handoff-v2-design.md §2).
--
-- A ruling the owner gave a coordinator used to live only in the handoff note's "Agreed with the
-- owner" prose, and each handoff summarized the last summary. A `project_ruling` row keeps it:
-- the ruling in one sentence, the owner's own words, where those words were said, who recorded it
-- and when.
--
--   * `source_kind` ASK_OWNER: an answered coordinator question (`source_id` is the open item);
--     written by the answer itself, in the same transaction. TURN: a coordinator conversation turn
--     (`source_id` is the conversation_turn), recorded by `project_ruling_record`, whose quote must
--     be found in that turn's owner text.
--   * `recorded_by_session_id`: the coordinator that recorded it; null for an automatic ruling.
--   * `superseded_by_id`: a later ruling replaced this one. A superseded ruling is kept, not deleted.
--
-- Owner-scoped like other project rows: (project_id, owner_id) points at the project's own pair.
-- No foreign key on source_id or recorded_by_session_id: a ruling is what the owner said, and it
-- outlives the conversation or item it was said in. Re-runnable. `down.sql` reverses it.

CREATE TABLE IF NOT EXISTS "project_ruling" (
    "id" UUID NOT NULL,
    "owner_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "ruling" TEXT NOT NULL,
    "quote" TEXT NOT NULL,
    "source_kind" TEXT NOT NULL,
    "source_id" UUID NOT NULL,
    "recorded_by_session_id" UUID,
    "superseded_by_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "project_ruling_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "project_ruling_source_kind_chk" CHECK ("source_kind" IN ('ASK_OWNER', 'TURN')),
    CONSTRAINT "project_ruling_not_self_chk" CHECK ("superseded_by_id" IS NULL OR "superseded_by_id" <> "id")
);

-- One automatic ruling per answered question: a retried answer cannot write a second.
CREATE UNIQUE INDEX IF NOT EXISTS "project_ruling_ask_owner_source_key"
  ON "project_ruling"("source_id")
  WHERE "source_kind" = 'ASK_OWNER';

CREATE INDEX IF NOT EXISTS "project_ruling_project_id_created_at_idx"
  ON "project_ruling"("project_id", "created_at");

DO $$ BEGIN
  ALTER TABLE "project_ruling" ADD CONSTRAINT "project_ruling_project_fkey"
    FOREIGN KEY ("project_id", "owner_id") REFERENCES "project"("id", "owner_id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
