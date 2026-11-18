-- 0555: three records the project done card draws (project 34vfv0OR79IojfYntb8SA, boards 01–03).
--
--   project.non_code_reason   the short reason the coordinator or the owner may give with the
--       non-code mark (0535), written with it and with who/when; NULL when none was given.
--   project_criterion_confirmation.criterion_text / criterion_verification_method
--       the wording a confirmation was given for, kept with it, so a confirmation that went stale on
--       a revision can show what was confirmed beside what the criterion says now. Rows written
--       before this migration keep them only where their revision is still the criterion's own.
--   two partial indexes on activity for the criterion move record (CRITERION_MOVED_ACTIVITY,
--       `project.criterion_moved`): the project detail read finds the moves out of and into one
--       project by the payload's fromProjectId / toProjectId, never by scanning activity.
--
-- No preserved row, trigger, function or DONE fence is named. Every statement can run twice.
ALTER TABLE "project" ADD COLUMN IF NOT EXISTS "non_code_reason" TEXT;

ALTER TABLE "project_criterion_confirmation" ADD COLUMN IF NOT EXISTS "criterion_text" TEXT;
ALTER TABLE "project_criterion_confirmation" ADD COLUMN IF NOT EXISTS "criterion_verification_method" TEXT;
UPDATE "project_criterion_confirmation" AS c
   SET "criterion_text" = d."text",
       "criterion_verification_method" = d."verification_method"
  FROM "project_acceptance_criterion_definition" AS d
 WHERE d."id" = c."definition_id"
   AND d."revision" = c."revision"
   AND c."criterion_text" IS NULL;

CREATE INDEX IF NOT EXISTS "activity_criterion_moved_from_idx"
  ON "activity" ((payload->>'fromProjectId'))
  WHERE "type" = 'project.criterion_moved';
CREATE INDEX IF NOT EXISTS "activity_criterion_moved_to_idx"
  ON "activity" ((payload->>'toProjectId'))
  WHERE "type" = 'project.criterion_moved';
