-- 0456 — the single-task create card's "Create and start" (sessions/sessions.service.ts decideApproval,
-- runner-api/runner-api.controller.ts pollApproval): the owner's yes on an `orbit_task_create` card can also ask
-- that the new task start at once, and the runner reads that choice off the card's long-poll beside its status.
--
--   approval.start_after_create   BOOLEAN NOT NULL DEFAULT false. true only on an ALLOWED `orbit_task_create`
--                                 card answered with Create and start; every other card, and every card filed
--                                 before this column, reads false, which is the plain yes it always was.
--
-- A catalog-only ADD COLUMN: the default is a constant, so no row is read, written or backfilled. No index,
-- trigger, function or constraint; no trigger is declared on "approval".
--
-- 0456 was free on main, on every ref in this repository and in every worktree on this host (2026-10-29). The
-- statement can run twice.

ALTER TABLE "approval" ADD COLUMN IF NOT EXISTS "start_after_create" BOOLEAN NOT NULL DEFAULT false;
