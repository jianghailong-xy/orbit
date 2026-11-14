-- ══════════════════════════════════════════════════════════════════════════════════════════════
-- A SubAgent on a Codex account pool (docs/subagent-design.md §4.2, §4.3). A SubAgent's child runs on the pool
-- member chosen for it alone, recorded on its `subagent_run` attempt, and never on the parent session's own pool
-- fields. A login pool's token names no credential (0355): the gateway sends on the account the session row is on.
-- A SubAgent's child has no session row of its own, so its token now names the credential it was chosen.
--
-- WHAT CHANGES
-- ------------
-- `pool_login_token` gains two nullable columns, NULL on every token a session's own claim mints:
--   * `account_id` (TEXT) — the pool's ChatGPT account a SubAgent's child sends on;
--   * `key_id` (UUID) — or the pool's API key it sends on, when none of the accounts could run.
-- At most one is set, and a token with either set is a SubAgent's. Neither has a foreign key, as 0355 removed the
-- account's: an account or key that leaves the pool leaves the token naming nothing, which the gateway refuses
-- with the reason, and the SubAgent's next attempt chooses again.
--
-- LOCKS
-- -----
-- Two ADD COLUMNs with no default: catalog-only, ACCESS EXCLUSIVE on pool_login_token for that instant, no
-- rewrite and no scan. No index, constraint, trigger or function changes; no row is written.
--
-- NUMBERING, RE-RUNNABILITY
-- -------------------------
-- 0800: after 0790, free on main and every branch this checkout knows. Can run twice: ADD COLUMN IF NOT EXISTS.
-- ══════════════════════════════════════════════════════════════════════════════════════════════

ALTER TABLE "pool_login_token" ADD COLUMN IF NOT EXISTS "account_id" TEXT;
ALTER TABLE "pool_login_token" ADD COLUMN IF NOT EXISTS "key_id" UUID;
