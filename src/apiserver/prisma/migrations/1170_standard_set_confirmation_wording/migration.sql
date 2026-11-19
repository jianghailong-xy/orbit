-- 1170 — what a confirmation of a project's criteria said, kept with the confirmation.
--
-- `project_standard_set_confirmation` recorded WHICH version was confirmed (`criteria_material`: each
-- criterion's id, revision and content hash) and nothing a person can read. Its receipt in the
-- conversation could therefore say only "7 criteria at seal …", and once a criterion was edited the
-- words that had been confirmed were gone (the account owner, 2026-11-19: once confirmed, the card
-- cannot be opened to see what was confirmed). Two nullable JSONB columns, written in the same INSERT
-- as the row and never afterwards:
--   * `criteria_wording`: one object per criterion — `definitionId`, `ordinal`, `text`,
--     `verificationMethod` — as the set stood when it was confirmed (0555 kept the same two words for a
--     single criterion's confirmation);
--   * `criteria_changes`: what that set changed since the confirmation before it, as the "Confirm the
--     new criteria?" card showed it (`@orbit/shared` `CriteriaChangesSinceConfirmed`), or NULL when
--     there was no confirmation before it.
--
-- Rows written before this read NULL in both; the receipt says so rather than inventing either. Each
-- CHECK is satisfied by NULL, so no stored row is refused or rewritten. No INSERT, UPDATE or DELETE.
-- Every statement can run twice.

BEGIN;

ALTER TABLE "project_standard_set_confirmation"
  ADD COLUMN IF NOT EXISTS "criteria_wording" jsonb,
  ADD COLUMN IF NOT EXISTS "criteria_changes" jsonb;

ALTER TABLE "project_standard_set_confirmation"
  DROP CONSTRAINT IF EXISTS "project_standard_set_confirmation_wording_shape",
  ADD CONSTRAINT "project_standard_set_confirmation_wording_shape"
    CHECK ("criteria_wording" IS NULL OR jsonb_typeof("criteria_wording") = 'array'),
  DROP CONSTRAINT IF EXISTS "project_standard_set_confirmation_changes_shape",
  ADD CONSTRAINT "project_standard_set_confirmation_changes_shape"
    CHECK ("criteria_changes" IS NULL OR jsonb_typeof("criteria_changes") = 'object');

COMMIT;
