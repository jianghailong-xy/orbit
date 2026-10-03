-- 0345 — who recorded a project done, and the owner's request card that asks them to.
--
-- WHAT IT ADDS
-- ============
--   * Four columns on `project`, the record a DONE carries:
--       `done_by`              OWNER — the account owner in person, on `POST /projects/:id/done` —
--                              or DERIVED — the projection from committed facts. NULL while the
--                              project is not recorded done by either.
--       `done_at`              when it was recorded; present exactly when `done_by` is.
--       `done_criteria_digest` the seal of the criteria it was recorded against. An OWNER record
--                              is reopened when the seal moves, and by nothing else but a task
--                              serving a criterion being reopened.
--       `accepted_gaps`        the criteria Orbit could not prove that the owner accepted, as the
--                              card sent them; an empty array for every other record.
--   * `DONE_REQUEST` joins `project_open_item_kind_chk`: a coordinator asking its owner to record
--     the project done, which the owner's DONE resolves (APPROVED).
--   * `DONE_REQUEST` joins `project_open_item_owner_only_chk`: it is asked OF the owner and never
--     worked by the coordinator, like a start request.
--
-- BACKWARD COMPATIBLE
-- ===================
-- The columns are nullable, or default to an empty array. A project already DONE was put there by
-- the projection or by a status write nobody can tell apart from it now, so it is recorded DERIVED,
-- as of its last update: the projection goes on treating it exactly as it did, and only the new
-- columns are written — no status, task, criterion or confirmation row moves. The two open-item
-- CHECKs are replaced by wider ones every stored row satisfies, since no row holds the new kind yet.

BEGIN;

ALTER TABLE "project"
  ADD COLUMN "done_by" text,
  ADD COLUMN "done_at" TIMESTAMPTZ(3),
  ADD COLUMN "done_criteria_digest" char(64),
  ADD COLUMN "accepted_gaps" jsonb NOT NULL DEFAULT '[]'::jsonb;

-- `updated_at` is a timestamp without time zone that Prisma writes in UTC.
UPDATE "project"
   SET "done_by" = 'DERIVED',
       "done_at" = "updated_at" AT TIME ZONE 'UTC'
 WHERE "status" = 'DONE';

ALTER TABLE "project"
  ADD CONSTRAINT "project_done_by_chk"
    CHECK ("done_by" IS NULL OR "done_by" IN ('OWNER', 'DERIVED')),
  ADD CONSTRAINT "project_done_at_chk"
    CHECK (("done_by" IS NULL) = ("done_at" IS NULL)),
  ADD CONSTRAINT "project_done_criteria_digest_chk"
    CHECK ("done_criteria_digest" IS NULL OR "done_criteria_digest" ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT "project_accepted_gaps_chk"
    CHECK (jsonb_typeof("accepted_gaps") = 'array');

ALTER TABLE "project_open_item"
  DROP CONSTRAINT "project_open_item_kind_chk",
  ADD CONSTRAINT "project_open_item_kind_chk" CHECK ("kind" IN (
    'INTEGRATION_CONFLICT', 'INTEGRATION_CHECK_FAILED', 'INTEGRATION_ERROR', 'TASK_FAILED',
    'PROMOTION_APPROVAL', 'COORDINATOR_QUESTION', 'FUSE_PAUSED', 'START_REQUEST', 'DONE_REQUEST')),
  DROP CONSTRAINT "project_open_item_owner_only_chk",
  ADD CONSTRAINT "project_open_item_owner_only_chk" CHECK (
    "kind" NOT IN ('PROMOTION_APPROVAL', 'COORDINATOR_QUESTION', 'FUSE_PAUSED', 'START_REQUEST',
                   'DONE_REQUEST')
    OR "assignee" = 'OWNER');

COMMIT;
