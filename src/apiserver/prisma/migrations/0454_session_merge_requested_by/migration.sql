-- 0454 — who pressed Merge, kept on the session beside the operation it queued (docs/project-integration-line-contract.md
-- §10.6 O-R3, revision 29).
--
--   session.merge_requested_by   'USER' when the Merge door's request carried the account owner's credential, 'AGENT'
--                                when it was made from a session (the runner door, or the user door with an acting
--                                session), NULL for an operation the server queued itself or one queued before this
--                                column existed. Written by the write that queues the operation
--                                (SessionsService.queueMerge) and read by the merge result, which copies it into the
--                                receipt's `detail.requestedBy`: O-R3 opens LANDED_WITHOUT_CONFIRMATION for a Merge
--                                pressed from a session, never for the owner's own, and judges no receipt that names
--                                no requester.
--
-- Catalog-only ADD COLUMN, nullable, with no default: no row is read, written or backfilled, and every stored row reads
-- NULL. No index, trigger, function or constraint: every trigger on "session" is scoped to other columns, and the two
-- values are closed by the one writer, as 0451's columns are.
--
-- 0454: the next number free on main, on every branch, in every commit of `git log --all` and in every worktree on this
-- host (2026-10-29; 0452 is held by another session). Every statement can run twice.

ALTER TABLE "session" ADD COLUMN IF NOT EXISTS "merge_requested_by" TEXT;
