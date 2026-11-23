-- ══════════════════════════════════════════════════════════════════════════════════════════════
-- Signing a runner's Default account out (docs/default-sign-out-design.md) rides on the account
-- removal's relay: one request per runner, on the same columns, with what it asks of the account.
--
--   runner.account_remove_action   TEXT: NULL for a removal, which every stored row is; 'sign-out'
--                                  for a sign-out of Default, handed to the runner as
--                                  AccountRemoveCommand.action.
--   runner.account_remove_force    BOOLEAN: with a sign-out, the person confirmed after a refusal
--                                  named the sessions running on Default. false otherwise.
--
-- ADD COLUMN with no default, and with a constant default, is catalog-only: no stored row is
-- rewritten.
--
-- 1465: the highest number on main, every project/* and pushed orbit/* branch below 1470 and every
-- session worktree below 1470 was 1464 (1464_open_list_scope_keys) when this was written
-- (2026-11-23); 1470 and 1490/1491 are taken on other branches.

ALTER TABLE "runner" ADD COLUMN "account_remove_action" TEXT;
ALTER TABLE "runner" ADD COLUMN "account_remove_force" BOOLEAN NOT NULL DEFAULT false;
