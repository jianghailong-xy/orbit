-- 1213 — the commits of a session's branch, for the status bar's commit list (docs/mocks/session-commits-first).
--
-- The runner reads them between the branch's base and tip with each turn-boundary, diff and finalize report, beside
-- changed_files. Null until a runner that reads them reports. Adding a nullable column writes no row.

ALTER TABLE "session" ADD COLUMN IF NOT EXISTS "branch_commits" JSONB;
