-- 0393 — one landing queued with its merge check NOT RUN
-- (docs/project-integration-line-contract.md §2.4 J-S5, 附录 B v1 修订 11).
--
-- WHAT IT ADDS
-- ============
-- Four columns on `project_integration_job`, written only on the LAND_TASK generation queued through
-- `integration_skip_merge_check` and left at their defaults on every other row:
--   * `skip_merge_check` — false everywhere but that generation. It is what tells the relay not to
--     hand the runner a MERGE_CHECK at all (`runner-api/integration-job-relay.ts#checksFor`).
--   * `skip_reason` — the sentence the requester gave for why this check should not hold up this
--     landing.
--   * `skip_approved_by_user_id` — the person whose yes it is: the decider of the card the runner
--     filed, or the account owner on their own channel. Never a rule's: the door refuses a card that
--     no person answered.
--   * `skip_approval_id` — the confirmation card it was approved on, NULL when there was none
--     because the owner queued it themselves. A history reference with no foreign key, like
--     `retry_of_job_id`: a card can be deleted with its session, and this row's account of what
--     happened must not go with it.
--
-- WHY ON THE JOB
-- ==============
-- The check did not pass; it did not run. Every reader of that landing — the project page, the
-- exception item a later failure opens, whoever audits the branch — has to be able to say so from
-- the row itself rather than inferring it from an empty `checks` array, which is also what a project
-- with no merge check command at all produces. The flag is on the ONE generation that skipped
-- anything: the project's `merge_check_command` is not touched, and the next generation is queued
-- without any of these columns, so it runs the check exactly as before.
--
-- 0393: the next number free on main and on every branch of origin (2026-10-07). Every statement can
-- run twice — `IF NOT EXISTS`, and the CHECKs inside `duplicate_object` guards — so a rebase onto a
-- database that has already seen it changes nothing. No row is read or written: one column has a
-- default, so existing rows read false without being rewritten, and no trigger, function or type is
-- created, replaced or dropped.

ALTER TABLE "project_integration_job"
  ADD COLUMN IF NOT EXISTS "skip_merge_check" boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "skip_reason" text,
  ADD COLUMN IF NOT EXISTS "skip_approved_by_user_id" uuid,
  ADD COLUMN IF NOT EXISTS "skip_approval_id" uuid;

-- All four or none: a skip that does not say why, or whose yes nobody's name is on, is not a skip —
-- it is a check that went missing.
DO $$ BEGIN
  ALTER TABLE "project_integration_job"
    ADD CONSTRAINT "project_integration_job_skip_chk" CHECK (
      ("skip_merge_check" AND "skip_reason" IS NOT NULL AND "skip_approved_by_user_id" IS NOT NULL)
      OR (NOT "skip_merge_check" AND "skip_reason" IS NULL
        AND "skip_approved_by_user_id" IS NULL AND "skip_approval_id" IS NULL));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "project_integration_job"
    ADD CONSTRAINT "project_integration_job_skip_reason_chk" CHECK (
      "skip_reason" IS NULL OR char_length(btrim("skip_reason")) BETWEEN 1 AND 2000);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- The check exists on a landing onto the project's own branch (§2.3 J-S5). A promotion's job merges
-- a branch into main and is checked by the promotion lane's own rules; nothing there skips.
DO $$ BEGIN
  ALTER TABLE "project_integration_job"
    ADD CONSTRAINT "project_integration_job_skip_kind_chk" CHECK (
      NOT "skip_merge_check" OR "kind" = 'LAND_TASK');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
