-- 0585: the orphan sweep's ledger (docs/evidence-always-has-an-addressee-design.md §4, project
-- 34w9J4ycWBHKATEW1R7Pr task P4).
--
--   project_orphan_notice   one row per (project, orphan key): a pending item nobody could move or
--       nobody was told about, and who the sweep told: the project's coordinator conversation, or the
--       account owner when there is none. The key names the item and the state it was found in, so
--       the same orphan in the same state is reported once.
--
-- One new table; no existing row is read or rewritten, and no trigger is added or changed.
-- Every statement can run twice.
CREATE TABLE IF NOT EXISTS "project_orphan_notice" (
  "id" uuid NOT NULL,
  "project_id" uuid NOT NULL,
  "owner_id" uuid NOT NULL,
  "task_id" uuid NOT NULL,
  "orphan_key" text NOT NULL,
  "kind" text NOT NULL,
  "recipient" text NOT NULL,
  "session_id" uuid,
  "client_turn_id" text,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "project_orphan_notice_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "project_orphan_notice_project_fkey" FOREIGN KEY ("project_id")
    REFERENCES "project" ("id") ON DELETE CASCADE,
  CONSTRAINT "project_orphan_notice_kind_chk"
    CHECK ("kind" IN ('EVIDENCE', 'EXCEPTION_ITEM', 'TASK_RUN', 'DEPENDENCIES')),
  CONSTRAINT "project_orphan_notice_recipient_chk" CHECK ("recipient" IN ('COORDINATOR', 'OWNER'))
);

CREATE UNIQUE INDEX IF NOT EXISTS "project_orphan_notice_project_key"
  ON "project_orphan_notice" ("project_id", "orphan_key");
