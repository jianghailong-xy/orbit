-- ══════════════════════════════════════════════════════════════════════════════════════════════
-- `model_provider.key_check_state`, `model_provider.key_checked_at`: whether Cursor accepts a Cursor API
-- key, as Cursor CLI on a runner last answered when asked with it (project P2, docs/cursor-runtime-
-- contract.md §9).
--
-- A Cursor User API Key (runtime `cursor`) is spent by Cursor CLI alone, on a runner: nothing on this
-- side can call Cursor with it, and the CLI's own handshake proves nothing about it — `initialize`
-- succeeds signed out, and `session/new` answers an invalid key and an unreachable Cursor API with the
-- same -32603 (contract §2.3, §12). What tells them apart is `agent models` asked with the key: exit 0
-- for a key Cursor accepts, "The provided API key is invalid." for one it refuses, and "Failed to reach
-- the Cursor API" when it could not ask (§9). A runner asks before it starts a session on the key, and
-- reports the answer for that session's key (POST /runner/sessions/:id/cursor-key-check); it is kept
-- here, on the key:
--
--   key_check_state   'VALID', 'INVALID' (Cursor refused the key) or 'UNREACHABLE' (Cursor's API could
--                     not be reached to ask). NULL: never checked, or checked before the key was
--                     replaced — saving a new key, or moving the row off the `cursor` runtime, clears
--                     both columns in the same write.
--   key_checked_at    TIMESTAMP(3), as `created_at`: when that answer was given. Set exactly when
--                     key_check_state is.
--
-- Every stored row reads NULL / NULL, which is what no check means. ADD COLUMN with no default, and a
-- CHECK every stored row satisfies (both columns NULL), are catalog-only: no stored row is rewritten.
-- Only `model_provider` is named; no trigger, function or type is created, replaced or dropped.
--
-- 0428: the highest number on main, every project/* and pushed orbit/* branch and every session
-- worktree was 0427 (0427_cursor_account, P4a) when this was written (2026-10-17).

ALTER TABLE "model_provider" ADD COLUMN "key_check_state" TEXT;
ALTER TABLE "model_provider" ADD COLUMN "key_checked_at" TIMESTAMP(3);
ALTER TABLE "model_provider" ADD CONSTRAINT "model_provider_key_check_state_check"
  CHECK ("key_check_state" IS NULL OR "key_check_state" IN ('VALID', 'INVALID', 'UNREACHABLE'));
ALTER TABLE "model_provider" ADD CONSTRAINT "model_provider_key_check_pair"
  CHECK (("key_check_state" IS NULL) = ("key_checked_at" IS NULL));
