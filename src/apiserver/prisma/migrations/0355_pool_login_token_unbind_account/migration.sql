-- 0355 — a login pool's session token stops naming an account. It authenticates one (pool, owner,
-- session) and nothing else; which account its requests go out on is the session's own
-- (`session.pool_codex_account_id`, migration 0324), which the pool gateway reads at every request.
--
-- WHY
-- ===
-- 0324 bound `pool_login_token.account_id` to the account its claim found, by (pool_id, account_id) →
-- pool_codex_login ON DELETE CASCADE. Two consequences, both wrong once a pool holds more than one
-- account (the 2026-10-02 direction):
--   * a warm engine keeps the token its claim minted, so a session that moved to another account went
--     on sending through the account its token named — the old one, whatever the session said;
--   * taking one account out of the pool deleted every token bound to it, including those of sessions
--     already running on another account.
-- The token's account is not needed for anything else: the gateway never chose an account from it (it
-- was the pool's first when a claim found no account to name), and what a session ran on is recorded on
-- the session row.
--
-- WHAT IT CHANGES
-- ===============
--   * `pool_login_token` loses `account_id`, and with it the (pool_id, account_id) → pool_codex_login
--     foreign key and the index over that pair. A token row is now exactly its identity — (pool_id,
--     user_id, session_id) — plus its hash and its times; no account is named anywhere on it, and no
--     account's removal can reach it.
--   * NOTHING ELSE IS TOUCHED. In particular the pool-owner fence 0324 drew on this same table,
--     (pool_id, user_id) → provider_pool(id, owner_id), and 0323's on pool_codex_login, are left exactly
--     as they stand: the person a token names is still held to the pool's owner by the database. The
--     dropped column is not part of either fence, so this migration neither weakens nor restates them.
--
-- No function, trigger, type or enum is created, replaced or dropped, and no data is rewritten: the
-- tokens that exist keep their pool, person, session, hash, expiry and revocation, and the rows deleted
-- by an account's removal from here on are the account's own. BEGIN/COMMIT of its own, as 0324 has.
--
-- Was written as 0348 and renumbered 0355 before it reached main, where 0348_session_folder had taken
-- the number (and 0349–0353 followed it there); 0354 is spelled by two branches not yet landed.

BEGIN;

-- DropForeignKey
ALTER TABLE "pool_login_token" DROP CONSTRAINT "pool_login_token_pool_id_account_id_fkey";

-- DropIndex
DROP INDEX "pool_login_token_pool_id_account_id_idx";

-- AlterTable
ALTER TABLE "pool_login_token" DROP COLUMN "account_id";

COMMIT;
