-- 1390: the record of the coordinator's cardless landing-check changes (contract revision 42, section 12.15 P-R1).
--
-- Every write the project's coordinator makes without a card to the project's landing check (P-C1) or to one
-- task's landing-check exemption (P-C2) leaves one row here, in the transaction that made the write: the project,
-- the field, the value before, the value after, why, the writing session and when. An owner write or a card write
-- leaves none. Rows are only inserted; the owner's revert (`POST /projects/:id/setting-changes/:id/revert`)
-- writes the old value back and leaves the row as it is.
--
--   field         LANDING_CHECK               old/new {command, timeoutSeconds, none} of the project's binding
--                 TASK_LANDING_CHECK_EXEMPT   old/new {exempt, reason} of the task `task_id` names
--
-- The project_ruling ledger (0970) was not used: its rows hold an owner's quote and its source_kind is closed to
-- ASK_OWNER and TURN, which say where an OWNER said something. This is an agent's act with a reason.
--
-- task.landing_check_exempt_owner_set_at: set when the owner writes or reverts a task's exemption, so the
-- coordinator's next cardless write of that field is refused (P-R1). NULL on every existing row.
--
-- Every statement can run twice.
CREATE TABLE IF NOT EXISTS "project_setting_change" (
    "id" UUID NOT NULL,
    "owner_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "task_id" UUID,
    "field" TEXT NOT NULL,
    "old_value" JSONB NOT NULL,
    "new_value" JSONB NOT NULL,
    "reason" TEXT NOT NULL,
    "written_by_session_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "project_setting_change_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "project_setting_change_field_chk" CHECK ("field" IN ('LANDING_CHECK', 'TASK_LANDING_CHECK_EXEMPT')),
    CONSTRAINT "project_setting_change_reason_chk" CHECK (char_length("reason") BETWEEN 1 AND 280),
    CONSTRAINT "project_setting_change_task_chk" CHECK (("field" = 'TASK_LANDING_CHECK_EXEMPT') = ("task_id" IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS "project_setting_change_project_id_created_at_idx"
  ON "project_setting_change"("project_id", "created_at");

DO $$ BEGIN
  ALTER TABLE "project_setting_change" ADD CONSTRAINT "project_setting_change_project_fkey"
    FOREIGN KEY ("project_id", "owner_id") REFERENCES "project"("id", "owner_id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE "task" ADD COLUMN IF NOT EXISTS "landing_check_exempt_owner_set_at" TIMESTAMP(3);
