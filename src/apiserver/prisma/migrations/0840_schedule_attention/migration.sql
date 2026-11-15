-- 0840 — a scheduled task's items in Waiting on you (docs/scheduled-tasks-design.md §6.4, §7.3).
--
-- WHAT IT ADDS
-- ============
-- Four owner-request kinds that no session files, written by the schedule's own code (schedules/schedule-attention.ts):
-- SCHEDULE_FAILED, SCHEDULE_HELD, SCHEDULE_APPROVAL (a card a run stopped at) and SCHEDULE_WIDEN (a run asking for a
-- wider envelope). `kind` is free text (0503), so the kinds need no DDL; what they point at does:
--   * `owner_request.schedule_id`, `schedule_run_id`: the schedule and the run an item is about;
--   * `owner_request.approval_id`: SCHEDULE_APPROVAL's card, answered on the card itself;
--   * `owner_request.schedule_change_request_id`: SCHEDULE_WIDEN's request, answered with Allow or Decline.
-- History references, no foreign keys, like `asked_by_session_id`: a deleted session or a purged run keeps the item.
--   * `owner_request_schedule_pending_idx`: what closes items, the PENDING ones of one schedule.
--
-- BACKWARD COMPATIBLE
-- ===================
-- Four nullable columns with no default and one partial index: no stored row is rewritten. An older apiserver never
-- writes or reads them; an older client reads the new kinds as rows it does not know (the Apple apps drop such a row,
-- Android and web show it by its title).
--
-- 0840: the highest number in use on the local branches, origin/main, every origin/project/* and origin/orbit/* was
-- 0830 on 2026-11-15.

ALTER TABLE "owner_request"
  ADD COLUMN "schedule_id" UUID,
  ADD COLUMN "schedule_run_id" UUID,
  ADD COLUMN "approval_id" UUID,
  ADD COLUMN "schedule_change_request_id" UUID;

CREATE INDEX "owner_request_schedule_pending_idx"
  ON "owner_request" ("schedule_id")
  WHERE "state" = 'PENDING' AND "schedule_id" IS NOT NULL;
