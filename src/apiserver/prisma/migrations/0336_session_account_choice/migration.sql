-- ══════════════════════════════════════════════════════════════════════════════════════════════
-- `session.codex_account_pinned`, `session.claude_account`, `session.claude_account_pinned`: which of
-- a runner's accounts a session runs on, and whether it was picked by hand.
--
-- 0330 gave a session a Codex account of its own: picked on the New Session screen or, when nothing
-- picked one, the account Automatic chose when it was created. A session its account's
-- usage limit stops now moves to another account with room when its workspace leaves the account to
-- Orbit — which must not happen to an account somebody picked by hand. `*_pinned` says which it is:
-- false is Automatic (Orbit may move it), true stays put and waits for that account's reset.
--
-- Claude Code keeps one login per CLAUDE_CONFIG_DIR as Codex does per CODEX_HOME, and a session now
-- has a Claude account of its own the same way: the same values as `workspace.claude_account`,
-- resolved against the accounts its runner reports, read ahead of the workspace's.
--
--   codex_account_pinned    BOOLEAN NOT NULL DEFAULT false
--   claude_account          'default', or a slot id (8 lowercase hex). NULL follows the workspace.
--   claude_account_pinned   BOOLEAN NOT NULL DEFAULT false
--
-- Every stored session reads false — Automatic — which is how every one of them was treated until
-- now, and NULL for its Claude account, which follows its workspace as they all did. ADD COLUMN with a
-- constant default, or none, is catalog-only: no stored row is rewritten.

ALTER TABLE "session" ADD COLUMN "codex_account_pinned" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "session" ADD COLUMN "claude_account" TEXT;
ALTER TABLE "session" ADD COLUMN "claude_account_pinned" BOOLEAN NOT NULL DEFAULT false;
