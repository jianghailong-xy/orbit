-- 1390: the history of a project's landing-check changes (contract revision 42, section 12.15 P-R1, board rulings D6 and D7).
--
-- One insert-only row per write of the project's landing check or of one task's landing-check exemption:
-- the project, the field, the value before, the value after, the writer's origin, why, the writing session and
-- when. The coordinator's cardless writes (P-C1, P-C2) are COORDINATOR rows and carry a reason and the session;
-- the owner's own writes and the card-approved ones are OWNER and CARD rows, listed so the owner reads one
-- history per field, and are never revertible.
--
-- The owner's revert (`POST /projects/:id/setting-changes/:id/revert`) is its own OWNER row: `reverts_change_id`
-- names the change it put back, old_value is what the field held when it was pressed and new_value is the
-- change's old value. The partial unique index lets a change be reverted once. A change is revertible while it
-- is a COORDINATOR row, nothing reverted it, and its new value is still the field's current value.
--
--   field         LANDING_CHECK               old/new {command, timeoutSeconds, none} of the project's binding
--                 TASK_LANDING_CHECK_EXEMPT   old/new {exempt, reason} of the task `task_id` names
--
-- The project_ruling ledger (0970) was not used: its rows hold an owner's quote and its source_kind is closed to
-- ASK_OWNER and TURN, which say where an OWNER said something. A coordinator's act with a reason would bend both.
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
    "origin" TEXT NOT NULL,
    "old_value" JSONB NOT NULL,
    "new_value" JSONB NOT NULL,
    "reason" TEXT,
    "written_by_session_id" UUID,
    "reverts_change_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "project_setting_change_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "project_setting_change_field_chk" CHECK ("field" IN ('LANDING_CHECK', 'TASK_LANDING_CHECK_EXEMPT')),
    CONSTRAINT "project_setting_change_origin_chk" CHECK ("origin" IN ('COORDINATOR', 'OWNER', 'CARD')),
    CONSTRAINT "project_setting_change_reason_chk" CHECK ("reason" IS NULL OR char_length("reason") BETWEEN 1 AND 280),
    CONSTRAINT "project_setting_change_coordinator_chk" CHECK (
      "origin" <> 'COORDINATOR' OR ("reason" IS NOT NULL AND "written_by_session_id" IS NOT NULL)),
    CONSTRAINT "project_setting_change_task_chk" CHECK (("field" = 'TASK_LANDING_CHECK_EXEMPT') = ("task_id" IS NOT NULL)),
    CONSTRAINT "project_setting_change_reverts_chk" CHECK ("reverts_change_id" IS NULL OR "origin" = 'OWNER')
);

CREATE INDEX IF NOT EXISTS "project_setting_change_project_id_created_at_idx"
  ON "project_setting_change"("project_id", "created_at");

-- A change is reverted at most once.
CREATE UNIQUE INDEX IF NOT EXISTS "project_setting_change_reverts_change_id_key"
  ON "project_setting_change"("reverts_change_id") WHERE "reverts_change_id" IS NOT NULL;

DO $$ BEGIN
  ALTER TABLE "project_setting_change" ADD CONSTRAINT "project_setting_change_project_fkey"
    FOREIGN KEY ("project_id", "owner_id") REFERENCES "project"("id", "owner_id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "project_setting_change" ADD CONSTRAINT "project_setting_change_reverts_fkey"
    FOREIGN KEY ("reverts_change_id") REFERENCES "project_setting_change"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE "task" ADD COLUMN IF NOT EXISTS "landing_check_exempt_owner_set_at" TIMESTAMP(3);
