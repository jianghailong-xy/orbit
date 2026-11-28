-- 1808 — a config change that hands the engine another mode than the one asked for says so on the mode change it causes.
--
-- 1807 let a CLAIM row carry the mode asked for and why. A config change (SessionsService.updateConfig) now hands the
-- engine the mode asked for under the same two substitutions as the claim, and no prediction: Bypass on a root runner
-- (ROOT_RUNNER) and a scheduled run on Claude Code (SCHEDULED_RUN). Its setconfig or reload turn is recorded as the
-- session's actual mode with cause OWNER_PICK or ORBIT_CHANGE, and that row now carries the substitution too. The
-- check is re-declared to allow those two causes; every row it held before still meets it. Nothing is backfilled.

ALTER TABLE "session_permission_mode_change"
  DROP CONSTRAINT IF EXISTS "session_permission_mode_change_reason_chk";

ALTER TABLE "session_permission_mode_change"
  ADD CONSTRAINT "session_permission_mode_change_reason_chk" CHECK (
    ("reason" IS NULL AND "requested_mode" IS NULL)
    OR (
      "cause" IN ('CLAIM', 'OWNER_PICK', 'ORBIT_CHANGE')
      AND "requested_mode" IS NOT NULL
      AND "reason" IN ('ROOT_RUNNER', 'SCHEDULED_RUN')
    )
  );
