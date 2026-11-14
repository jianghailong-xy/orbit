-- ══════════════════════════════════════════════════════════════════════════════════════════════
-- Main checkout Discard (docs/main-checkout-git-contract.md): a fifth action kind, 'discard', which puts the chosen
-- files back at HEAD after saving the checkout to orbit/rescue-*. main_checkout_request_action_chk (0534) allowed
-- move, commit, push and rescue only, so queuing a discard failed the CHECK and was answered 500.
--
-- WHAT CHANGES
-- ------------
-- main_checkout_request_action_chk also allows 'discard'. Its other clause (an action has a request_id) is unchanged.
--
-- LOCKS
-- -----
-- Dropped and added NOT VALID, then validated: the scan of existing rows (every one of them passes the narrower check
-- already) runs under SHARE UPDATE EXCLUSIVE. No column, function, trigger or type changes; no row is written.
--
-- NUMBERING, RE-RUNNABILITY
-- -------------------------
-- 0770: after 0760, free on main and every branch this checkout knows. Can run twice: DROP CONSTRAINT IF EXISTS.
-- ══════════════════════════════════════════════════════════════════════════════════════════════

ALTER TABLE "main_checkout_request" DROP CONSTRAINT IF EXISTS "main_checkout_request_action_chk";
ALTER TABLE "main_checkout_request"
  ADD CONSTRAINT "main_checkout_request_action_chk" CHECK (
    "op" <> 'action' OR ("request_id" IS NOT NULL AND "kind" IN ('move', 'commit', 'push', 'rescue', 'discard'))
  ) NOT VALID;
ALTER TABLE "main_checkout_request" VALIDATE CONSTRAINT "main_checkout_request_action_chk";
