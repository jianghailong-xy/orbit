-- ══════════════════════════════════════════════════════════════════════════════════════════════
-- `workspace.codex_account`: which Codex account a workspace's Codex sessions run on.
--
-- A runner can hold more than one Codex account: Default is the CODEX_HOME its own environment
-- selects, and every other account is a slot it added under $ORBIT_HOME/codex-accounts
-- (`src/runner-go/codex_account_slot.go`), reported per heartbeat in `runner.engines`. This column
-- is the workspace's choice among them, stored as the slot's id and never as a path: dispatch
-- resolves the id against the accounts the assigned runner reports and injects that slot's
-- CODEX_HOME into the session's environment. An id the runner does not report — the workspace
-- moved to another machine, or the slot is gone — runs on Default instead of failing.
--
--   codex_account   the slot id (8 lowercase hex). NULL is Default.
--
-- NULLABLE, and NULL is the old behaviour rather than a gap: every workspace written before this
-- migration ran its Codex sessions on the runner's own CODEX_HOME, which is Default.
--
-- ADD COLUMN only: no default, no NOT NULL, so the ALTER is catalog-only and no stored row is
-- rewritten.

ALTER TABLE "workspace" ADD COLUMN "codex_account" TEXT;
