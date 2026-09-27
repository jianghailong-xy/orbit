-- ══════════════════════════════════════════════════════════════════════════════════════════════
-- `runner.account_remove_engine`: which engine's account store a pending removal is about.
--
-- The four `codex_account_remove_*` columns (0302) describe one removal in flight: the slot, its
-- status, the machine's own words, and the attempt every report names. They were written when Codex
-- was the only engine with accounts; Claude Code has them too now (`CLAUDE_CONFIG_DIR` slots,
-- src/runner-go/account_slot.go), so a removal needs to say which store it is in. This column is
-- that, and nothing else changes: it is NULL for every row written before this migration, which by
-- construction meant Codex, and a reader takes NULL as Codex.
--
--   account_remove_engine   'codex' | 'claude'. NULL means Codex.
--
-- ADD COLUMN only: no default, no NOT NULL, so the ALTER is catalog-only and no stored row is
-- rewritten.

ALTER TABLE "runner" ADD COLUMN "account_remove_engine" TEXT;
