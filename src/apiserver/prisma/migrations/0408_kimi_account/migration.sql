-- ══════════════════════════════════════════════════════════════════════════════════════════════
-- `workspace.kimi_account`, `session.kimi_account`, `session.kimi_account_pinned`: which of a runner's
-- Kimi Code accounts a session runs on.
--
-- Kimi Code keeps its whole login in one directory, KIMI_CODE_HOME (config.toml and credentials/), so
-- a runner keeps Kimi accounts the way it keeps Codex's CODEX_HOME and Claude Code's CLAUDE_CONFIG_DIR
-- slots: Default is the KIMI_CODE_HOME its own environment selects (else ~/.kimi-code), and every
-- other account is a directory it added under $ORBIT_HOME/kimi-accounts (src/runner-go
-- account_slot.go), reported per heartbeat in `runner.engines`. These columns are the same choice
-- Codex's (0297, 0330, 0336), Claude's (0309, 0336) and Antigravity's (0387) are, stored as the slot's
-- id and never as a path: dispatch resolves it against the accounts the assigned runner reports and
-- hands that slot's directory to the runner as KIMI_CODE_HOME.
--
--   workspace.kimi_account        'default', or a slot id (8 lowercase hex). NULL is Automatic.
--   session.kimi_account          the same values. NULL follows the workspace.
--   session.kimi_account_pinned   BOOLEAN NOT NULL DEFAULT false: picked by hand (true) or Automatic
--                                 (false), which Orbit may move to an account with room.
--
-- Every stored row reads NULL / false, which is how every Kimi session ran until now: on the runner's
-- own login. ADD COLUMN with a constant default, or none, is catalog-only: no stored row is rewritten.

ALTER TABLE "workspace" ADD COLUMN "kimi_account" TEXT;
ALTER TABLE "session" ADD COLUMN "kimi_account" TEXT;
ALTER TABLE "session" ADD COLUMN "kimi_account_pinned" BOOLEAN NOT NULL DEFAULT false;
