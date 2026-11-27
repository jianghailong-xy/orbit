-- A scheduled task's change conversation (docs/scheduled-tasks-design.md §8.2, owner 2026-11-19):
--   * `session_run_source` gains SCHEDULE_CHANGE: a session opened by a schedule's Change…, in no session list.
--     No statement here uses the value, so ADD VALUE is safe inside the migration's transaction.
--   * `session.change_schedule_id` names the schedule it changes; `session.schedule_change_opening` keeps the
--     opening Orbit drew from the schedule as it was then.
--   * `schedule_revision.asked_text` and `schedule_change_request.asked_text`: the person's words that asked for
--     a change made from that conversation.
ALTER TYPE "session_run_source" ADD VALUE IF NOT EXISTS 'SCHEDULE_CHANGE';

ALTER TABLE "session" ADD COLUMN "change_schedule_id" UUID;
ALTER TABLE "session" ADD COLUMN "schedule_change_opening" JSONB;
ALTER TABLE "session" ADD CONSTRAINT "session_change_schedule_id_fkey"
  FOREIGN KEY ("change_schedule_id") REFERENCES "schedule"("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "session_change_schedule_idx" ON "session" ("change_schedule_id", "created_at" DESC)
  WHERE "change_schedule_id" IS NOT NULL;

ALTER TABLE "schedule_revision" ADD COLUMN "asked_text" TEXT;
ALTER TABLE "schedule_change_request" ADD COLUMN "asked_text" TEXT;
