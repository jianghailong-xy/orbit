-- The reaper's sweep that brings a filed session with a question waiting on the owner back to Open
-- (sessions/return-to-open.ts#returnWaitingSessionsToOpen) starts from the questions, not from the
-- sessions: PENDING owner requests and PENDING task moves are a handful of rows, filed sessions are
-- most of the table.
--
-- The PENDING task moves are already indexed by 0386's partial unique
-- "project_handoff_approval_pending_move_idx" (WHERE kind = 'MOVE_TASK' AND state = 'PENDING').
-- PENDING owner requests had only "owner_request_owner_state_idx", which leads with owner_id and so
-- does not serve an every-account read. This partial index holds only the PENDING rows, so the
-- sweep reads them with an index scan every tick instead of scanning the table. Index only; no row is
-- written. schema.prisma cannot express a partial index, so it lives here alone.

CREATE INDEX IF NOT EXISTS "owner_request_pending_asker_idx"
  ON "owner_request" ("asked_by_session_id", "expires_at")
  WHERE "state" = 'PENDING';
