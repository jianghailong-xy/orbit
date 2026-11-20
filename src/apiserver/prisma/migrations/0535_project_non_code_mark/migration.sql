-- 0535: a project is non-code only by an explicit mark (owner decision 2026-11-11), never inferred.
--
--   project.non_code                    the mark. A marked project reads no landing: its criteria carry no landing
--                                       reason, the done check reports none of them unlanded, and Record as done stores
--                                       no landing gaps. Satisfaction is unchanged.
--   project.non_code_set_by             who wrote the mark last, set or cleared: OWNER or COORDINATOR. NULL while nobody has.
--   project.non_code_set_by_session_id  the conversation a COORDINATOR wrote it from; NULL for the owner.
--   project.non_code_set_at             when.
--
-- Columns and one CHECK only: no row is written, no preserved trigger, function or DONE fence is named.
-- Every statement can run twice.
ALTER TABLE "project" ADD COLUMN IF NOT EXISTS "non_code" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "project" ADD COLUMN IF NOT EXISTS "non_code_set_by" TEXT;
ALTER TABLE "project" ADD COLUMN IF NOT EXISTS "non_code_set_by_session_id" UUID;
ALTER TABLE "project" ADD COLUMN IF NOT EXISTS "non_code_set_at" TIMESTAMPTZ(3);
ALTER TABLE "project" DROP CONSTRAINT IF EXISTS "project_non_code_set_by_chk";
ALTER TABLE "project" ADD CONSTRAINT "project_non_code_set_by_chk" CHECK (
  ("non_code_set_by" IS NULL AND "non_code_set_by_session_id" IS NULL AND "non_code_set_at" IS NULL)
  OR ("non_code_set_by" = 'OWNER' AND "non_code_set_by_session_id" IS NULL AND "non_code_set_at" IS NOT NULL)
  OR ("non_code_set_by" = 'COORDINATOR' AND "non_code_set_at" IS NOT NULL)
);
