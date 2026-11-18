-- 0740 — a merge a session asked for of itself while its own turn was running.
--
-- WHAT IT ADDS
-- ============
-- Two nullable columns on `session`: `merge_after_turn_at`, when the session asked to merge its own
-- branch during one of its turns, and `merge_after_turn_target`, the target it named (NULL → the default).
-- A merge cannot be queued while a turn runs, and a session's own request is always made during one, so
-- the request is kept here and queued when that turn ends (SessionsService.mergeAfterOwnTurn). Cleared by
-- the write that takes it up and by any merge that queues.
--
-- BACKWARD COMPATIBLE
-- ===================
-- Catalog-only ADD COLUMNs with no default and no constraint: no row is read, written or backfilled, and
-- every stored session reads NULL — no merge owed. No index, trigger, function, type or constraint is
-- created, replaced or dropped.
--
-- 0740: the highest numbers in use were 0720 on main and 0730 on an unlanded branch
-- (0730_session_work_subdir) when this was written (2026-11-14).

-- AlterTable
ALTER TABLE "session" ADD COLUMN     "merge_after_turn_at" TIMESTAMP(3),
ADD COLUMN     "merge_after_turn_target" TEXT;
