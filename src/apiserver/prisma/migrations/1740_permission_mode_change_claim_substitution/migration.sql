-- 1740 — a claim that hands the runner another mode than the session asked for says so on the mode change it records.
--
-- A claim records the mode it hands the runner as the session's actual mode (cause CLAIM, migration 1437). Where that
-- mode is not the one the session asked for, the row now carries the mode asked for and why
-- (CLAIM_PERMISSION_MODE_SUBSTITUTION_REASONS in @orbit/shared): Bypass on a root runner (ROOT_RUNNER), a scheduled run
-- on Claude Code (SCHEDULED_RUN). Both are NULL on every other row, and on every row written before this migration;
-- nothing is backfilled, since no record says what those claims were asked for.

ALTER TABLE "session_permission_mode_change"
  ADD COLUMN IF NOT EXISTS "requested_mode" TEXT,
  ADD COLUMN IF NOT EXISTS "reason" TEXT;

ALTER TABLE "session_permission_mode_change"
  ADD CONSTRAINT "session_permission_mode_change_reason_chk" CHECK (
    ("reason" IS NULL AND "requested_mode" IS NULL)
    OR ("cause" = 'CLAIM' AND "requested_mode" IS NOT NULL AND "reason" IN ('ROOT_RUNNER', 'SCHEDULED_RUN'))
  );
