-- 1000 — Set as default for Claude Code accounts: the swap relay's row on the runner.
--
-- Making an added Claude account the Default swaps its login with the one in ~/.claude on the machine
-- (docs/claude-default-swap-contract.md §5). Like the account removal it is one request per runner,
-- delivered on every heartbeat while `pending`, and answered by POST /runner/claude-account-swap-result:
--   claude_account_swap_account   the added account (slot id) being made the Default
--   claude_account_swap_status    NULL (none) | pending | done | failed
--   claude_account_swap_message   the reason a swap failed
--   claude_account_swap_waiting   pending: the sessions with a turn in progress the swap waits on
--   claude_account_swap_foreign   pending: Claude processes on either folder that are not Orbit sessions
--   claude_account_swap_at        when it was asked: the attempt every report names, and its deadline
--
-- BACKWARD COMPATIBLE: new nullable columns (and one with a default); an older apiserver neither reads nor writes them.
ALTER TABLE "runner" ADD COLUMN IF NOT EXISTS "claude_account_swap_account" TEXT;
ALTER TABLE "runner" ADD COLUMN IF NOT EXISTS "claude_account_swap_status" TEXT;
ALTER TABLE "runner" ADD COLUMN IF NOT EXISTS "claude_account_swap_message" TEXT;
ALTER TABLE "runner" ADD COLUMN IF NOT EXISTS "claude_account_swap_waiting" UUID[] NOT NULL DEFAULT '{}';
ALTER TABLE "runner" ADD COLUMN IF NOT EXISTS "claude_account_swap_foreign" JSONB;
ALTER TABLE "runner" ADD COLUMN IF NOT EXISTS "claude_account_swap_at" TIMESTAMP(3);
