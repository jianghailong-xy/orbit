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
-- Written as 1465 (2026-11-23), when main and every branch stopped at 1464; renumbered to 1492
-- after main took 1465 (1465_session_run_now_over_capacity) and 1491 (1491_feishu_details_by_default).
-- 1492 was on no branch or session worktree then. It was never on main, so no deployment applied it
-- under its old name.

ALTER TABLE "runner" ADD COLUMN "account_remove_action" TEXT;
ALTER TABLE "runner" ADD COLUMN "account_remove_force" BOOLEAN NOT NULL DEFAULT false;
