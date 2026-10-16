-- ══════════════════════════════════════════════════════════════════════════════════════════════
-- `workspace.cursor_account`, `session.cursor_account`, `session.cursor_account_pinned`: which of a
-- runner's Cursor CLI accounts a session runs on. `runner.login_expires_at`, `runner.login_reason`:
-- how long the sign-in link a runner relays lasts, and why a sign-in failed when that is the link
-- running out.
--
-- A runner keeps Cursor CLI accounts the way it keeps Codex's, Claude Code's, Antigravity's and Kimi
-- Code's (docs/cursor-runtime-contract.md §16.2): Default is <orbit home>/cursor/default, and every
-- other account is a directory it added under <orbit home>/cursor-accounts, reported per heartbeat in
-- `runner.engines`. These columns are the same choice Codex's (0297, 0330, 0336), Claude's (0309,
-- 0336), Antigravity's (0387) and Kimi's (0408) are, stored as the account's id and never as a path:
-- dispatch resolves it against the accounts the assigned runner reports and hands that account's
-- directory to the runner as ORBIT_CURSOR_ACCOUNT_DIR. An id the runner does not report runs on
-- Default.
--
--   workspace.cursor_account        'default', or an account id (8 lowercase hex). NULL is Automatic.
--   session.cursor_account          the same values. NULL follows the workspace.
--   session.cursor_account_pinned   BOOLEAN NOT NULL DEFAULT false: picked by hand (true) or Automatic
--                                   (false), which Orbit may move to an account with room.
--
-- Cursor CLI signs in with one link that `agent login` prints and then waits on for about 27 minutes
-- (contract §9), far longer than any other engine's sign-in. The runner reports when the link stops
-- working, and says so when that is why a sign-in failed, so a client can count the time down and
-- offer a new link rather than a retry:
--
--   runner.login_expires_at   TIMESTAMP(3), as `login_at` (0073): when the link the relay holds stops
--                             working. NULL for a sign-in whose runner names no such time.
--   runner.login_reason       TEXT: why a failed sign-in failed, when a client answers it differently.
--                             'expired' is the only value: the link ran out before anyone signed in.
--
-- Every stored row reads NULL / false, which is how every Cursor CLI session ran until now (on the
-- runner's own sign-in) and what every sign-in ever was. ADD COLUMN with a constant default, or none,
-- is catalog-only: no stored row is rewritten.
--
-- 0427: the highest number on main, every project/* and pushed orbit/* branch and every session
-- worktree was 0426 (0426_cursor_engine) when this was written (2026-10-17).

ALTER TABLE "workspace" ADD COLUMN "cursor_account" TEXT;
ALTER TABLE "session" ADD COLUMN "cursor_account" TEXT;
ALTER TABLE "session" ADD COLUMN "cursor_account_pinned" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "runner" ADD COLUMN "login_expires_at" TIMESTAMP(3);
ALTER TABLE "runner" ADD COLUMN "login_reason" TEXT;
