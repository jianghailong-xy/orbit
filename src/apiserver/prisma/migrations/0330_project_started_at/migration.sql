-- 0330 — a project is started once, by its owner, and the start is a fact of its own.
--
-- WHAT IT ADDS
-- ============
--   * `project.started_at`: when the account owner started the project (`POST /projects/:id/start`,
--     or "Start the project" on the older card, which starts it with the default settings). NULL is
--     "not started", and only a start writes it — once, compare-and-set on NULL. Until now "started"
--     was read off `coordinator_enabled` and whether a confirmation existed, which made the Automatic
--     switch double as the project's on switch; the column separates the two.
--   * `project_standard_set_confirmation.started_with`: on the confirmation a start wrote, the
--     settings the start left the project with and which of them are not what it was asked for
--     (`@orbit/shared` `ProjectStartRecord`). NULL on a confirmation that only confirmed. It is what
--     the "Project started" card of the coordinator's conversation is drawn from, so the card shows
--     the start as it happened rather than whatever the settings say later.
--
-- THE BACKFILL
-- ============
-- A project that has already been started by any of the three ways a project could start before
-- this — its criteria confirmed, its coordinator switched on, or a task's work session run in it —
-- gets the earliest time of those that has one: the first confirmation, or the first task-work
-- session. `coordinator_enabled` carries no time of its own, so a project that is switched on with
-- neither of the other two takes its creation, when that column used to be written. Every other
-- project stays NULL, which is "not started". Session times are read however the session ended,
-- deleted ones included: a session that ran is a start that happened.
--
-- Both source columns are `timestamp(3)` holding UTC, so they are read AT TIME ZONE 'UTC' rather than
-- through the connection's zone.
--
-- BACKWARD COMPATIBLE
-- ===================
-- Two nullable `ADD COLUMN`s with no default (catalog-only) and one CHECK every existing confirmation
-- satisfies, since each reads NULL. The UPDATE writes `started_at` and nothing else: no trigger on
-- `project` fires on that column, and none is added.

BEGIN;

ALTER TABLE "project" ADD COLUMN "started_at" TIMESTAMPTZ(3);

ALTER TABLE "project_standard_set_confirmation"
  ADD COLUMN "started_with" jsonb,
  ADD CONSTRAINT "project_standard_set_confirmation_started_with_shape"
    CHECK ("started_with" IS NULL OR (
      jsonb_typeof("started_with") = 'object'
      AND jsonb_typeof("started_with" -> 'settings') = 'object'
      AND jsonb_typeof("started_with" -> 'differsFromRequest') = 'array'
    ));

UPDATE "project" p
   SET "started_at" = e."at"
  FROM (
    SELECT q."id",
           COALESCE(
             LEAST(
               (SELECT min(c."confirmed_at")
                  FROM "project_standard_set_confirmation" c
                 WHERE c."project_id" = q."id"),
               (SELECT min(s."created_at")
                  FROM "session" s
                  JOIN "task" t ON t."id" = s."task_id"
                 WHERE t."project_id" = q."id"
                   AND s."starts_task_work")
             ) AT TIME ZONE 'UTC',
             CASE WHEN q."coordinator_enabled" THEN q."created_at" AT TIME ZONE 'UTC' END
           ) AS "at"
      FROM "project" q
  ) e
 WHERE p."id" = e."id"
   AND e."at" IS NOT NULL;

COMMIT;
