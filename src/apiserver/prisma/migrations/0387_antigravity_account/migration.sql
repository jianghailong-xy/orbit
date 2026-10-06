-- ══════════════════════════════════════════════════════════════════════════════════════════════
-- `workspace.antigravity_account`, `session.antigravity_account`, `session.antigravity_account_pinned`:
-- which of a runner's Antigravity Google accounts a session runs on.
--
-- A runner kept one Google sign-in for agy, <orbit home>/antigravity/google. It now keeps Antigravity
-- accounts the way it keeps Codex's CODEX_HOME and Claude Code's CLAUDE_CONFIG_DIR slots: Default is
-- that sign-in, and every other account is a Gemini directory it added under
-- $ORBIT_HOME/antigravity-accounts (src/runner-go/antigravity_account_slot.go), reported per heartbeat in
-- `runner.engines`. These columns are the same choice Codex's (0297, 0330, 0336) and Claude's (0309,
-- 0336) are, stored as the slot's id and never as a path: dispatch resolves it against the accounts the
-- assigned runner reports and hands that slot's directory to the runner as ORBIT_ANTIGRAVITY_GOOGLE_DIR.
--
--   workspace.antigravity_account        'default', or a slot id (8 lowercase hex). NULL is Automatic.
--   session.antigravity_account          the same values. NULL follows the workspace.
--   session.antigravity_account_pinned   BOOLEAN NOT NULL DEFAULT false: picked by hand (true) or
--                                        Automatic (false), which Orbit may move to an account with room.
--
-- Every stored row reads NULL / false, which is how every Antigravity session ran until now: on the
-- runner's own sign-in. ADD COLUMN with a constant default, or none, is catalog-only: no stored row is
-- rewritten.

ALTER TABLE "workspace" ADD COLUMN "antigravity_account" TEXT;
ALTER TABLE "session" ADD COLUMN "antigravity_account" TEXT;
ALTER TABLE "session" ADD COLUMN "antigravity_account_pinned" BOOLEAN NOT NULL DEFAULT false;
