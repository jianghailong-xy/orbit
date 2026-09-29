-- 0334 — "does this project move" is started and not paused, and pausing is a fact of its own.
--
-- WHAT IT ADDS
-- ============
--   * `project.paused_at`: when the project was paused. NULL is "not paused". While it is set,
--     nothing starts the project's tasks by itself — not the release of a task that depends on
--     nothing, not a prerequisite finishing (the instant path or the sweep), not a schedule coming
--     due, not the retry policy — an agent's `task_start` is refused 409 PROJECT_PAUSED, and nothing
--     is merged into main by the Automatic setting. The owner's own Run is not held, and a run that
--     is already going is not stopped.
--   * `project.paused_reason`: who paused it, from a closed set.
--       - 'OWNER' — the owner pressed Pause project (`POST /projects/:id/pause`).
--       - 'LEGACY_AUTOMATIC_OFF' — a client that only knows the one Automatic switch turned it off
--         (`PATCH /projects/:id {coordinatorEnabled: false}`). On those clients that switch was the
--         project's on switch, so its off keeps meaning "stop"; switching it back on lifts this pause
--         and no other.
--
-- Until now whether a project's independent tasks were released was read off `coordinator_enabled`,
-- which made Automatic double as the project's on switch. Automatic now says how the project is run
-- (its coordinator decides for the owner), and `started_at` (0331) and this column say whether it runs.
--
-- THE CHECK
-- =========
-- The two columns are set and cleared together, the reason is one of the two above, and only a
-- started project is paused: an unstarted one runs nothing already, and a pause left on it would
-- still be standing — silently — after the owner pressed Start.
--
-- THE BACKFILL
-- ============
-- A started project whose Automatic is off is paused, with the legacy reason. What the app promised
-- for those projects is "Nothing here starts or asks on its own", and Automatic no longer holds
-- anything back by itself, so without this they would start releasing their independent tasks. The
-- backfill keeps them exactly as still as they were, and more: prerequisites finishing and schedules
-- coming due, which the switch never stopped, stop too. Nothing starts that did not start before.
-- Measured on production 2026-09-29 09:15 UTC (0331 applied): 23 of 77 projects, the largest 127
-- tasks, 3 open auto-run tasks among them and all 3 in CANCELLED projects; the 109,878-task project
-- has Automatic on and is not touched.
--
-- BACKWARD COMPATIBLE
-- ===================
-- Two nullable `ADD COLUMN`s with no default (catalog-only), one CHECK every existing row satisfies
-- as both read NULL, and one UPDATE that writes these two columns and nothing else. No trigger on
-- `project` fires on either column, and none is added.

BEGIN;

ALTER TABLE "project"
  ADD COLUMN "paused_at" TIMESTAMPTZ(3),
  ADD COLUMN "paused_reason" TEXT,
  ADD CONSTRAINT "project_paused_shape" CHECK (
    ("paused_at" IS NULL AND "paused_reason" IS NULL)
    OR (
      "paused_at" IS NOT NULL
      AND "paused_reason" IN ('OWNER', 'LEGACY_AUTOMATIC_OFF')
      AND "started_at" IS NOT NULL
    )
  );

UPDATE "project"
   SET "paused_at" = now(),
       "paused_reason" = 'LEGACY_AUTOMATIC_OFF'
 WHERE "started_at" IS NOT NULL
   AND "coordinator_enabled" = false
   AND "paused_at" IS NULL;

COMMIT;
