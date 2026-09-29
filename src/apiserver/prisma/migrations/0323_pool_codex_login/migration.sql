-- 0323 — the pool that runs on the account owner's own ChatGPT/Codex subscription login, held by this
-- server alone (docs/codex-shared-pool-design.md §2.4–§2.5 read in this direction).
--
-- WHAT IT ADDS
-- ============
--   * `provider_pool_engine_check` is WIDENED: a pool that is not shared may now be `codex` as well as
--     `claude`. 0265's personal pools stay `claude` — they dispatch on the Claude subscription providers
--     their owner put in them. A personal `codex` pool is this one: it has no member providers at all;
--     its credential is one ChatGPT login the server signed in itself and holds encrypted. A SHARED pool
--     is still `codex` and nothing else: organizational API keys (0321/0322) are the only thing several
--     people may share, and nothing about this migration lets a login be pooled between users. The old
--     CHECK read `(shared AND codex) OR (NOT shared AND claude)`; the new one reads the same for shared,
--     and admits both engines when not shared. No stored row is affected: every pool that exists is
--     either a 0265 personal Claude pool or a 0321 shared Codex one, and both still satisfy it. The drop
--     and the add are one transaction, so the table is never unconstrained for anyone reading it.
--   * `pool_codex_login` — the account such a pool runs on. One row per (pool, account): the primary key
--     is the pair, which is what a second add of the same account collides on. It holds:
--       - `account_id` — the ChatGPT account id out of the login's own token claims; TEXT and not UUID,
--         because it is OpenAI's identifier and not one of this database's rows. Nothing outside this
--         table addresses it, and what a response shows of it is `maskedAccount`'s last four characters.
--       - `email` and `plan` — what the token claims say of the account, the two things a pool page
--         names. Both nullable: a login whose claims carry neither is still a login.
--       - `access_token_enc`, `refresh_token_enc` — the tokens, AES-256-GCM under PROVIDER_SECRET_KEY,
--         exactly as every other credential on this server is (`providers/provider-crypto.ts`). There is
--         no column that holds either in the clear, and none is ever written to a log, a claim payload or
--         a response body: a response carries the email and the masked account id and nothing else.
--       - `expires_at` — when the ACCESS token stops being good, read off its own claims at login; the
--         refresh token is what survives it, and only this server ever rotates the pair.
--       - `state` — ACTIVE, or SIGNED_OUT when the upstream refused the credential (a 401 through the
--         pool gateway) — and nothing else sets it. A usage reading that could not be taken is NOT this:
--         it is no reading at all, and a pool's account stays ACTIVE without one.
--       - `last_error` — why it is SIGNED_OUT, in the upstream's own words, so the page can say it.
--     `created_at` is when the account joined the pool and `updated_at` moves with every write to it,
--     which is how a re-login (the owner signing in again after a 401) is visible without a second row.
--
-- The person is the pool's owner, held by the database rather than by the service:
-- (pool_id, user_id) → provider_pool(id, owner_id) is the same composite-key fence 0265 and 0321 draw —
-- the pool's own unique key (0265's `provider_pool_id_owner_id_key`) is what makes it expressible here,
-- so a row whose `user_id` is not the owner of that pool cannot be inserted at all, and deleting the
-- pool (or the owner) takes the login with it. This is the "just me" boundary of a login pool: there is
-- no membership table for one, and no row of one can name anybody but its owner.
--
-- Nothing else is touched. The personal Claude pools (0265/0268), the shared pools and their keys,
-- tokens, ledger and `spent_until` (0321/0322) are left exactly as they are, and no row of any table is
-- rewritten: the CHECK is catalog-only over rows that already satisfy it, and the new table starts
-- empty. BEGIN/COMMIT of its own, as 0265 and 0321 have.

BEGIN;

-- AlterTable: a shared pool is Codex; a personal one may be either engine.
ALTER TABLE "provider_pool" DROP CONSTRAINT "provider_pool_engine_check";

ALTER TABLE "provider_pool"
  ADD CONSTRAINT "provider_pool_engine_check"
  CHECK ((NOT "shared" AND "engine" IN ('claude', 'codex')) OR ("shared" AND "engine" = 'codex'));

-- CreateTable
CREATE TABLE "pool_codex_login" (
    "pool_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "account_id" TEXT NOT NULL,
    "email" TEXT,
    "plan" TEXT,
    "access_token_enc" TEXT NOT NULL,
    "refresh_token_enc" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'ACTIVE',
    "last_error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "pool_codex_login_pkey" PRIMARY KEY ("pool_id","account_id"),
    CONSTRAINT "pool_codex_login_state_check" CHECK ("state" IN ('ACTIVE', 'SIGNED_OUT'))
);

-- AddForeignKey
ALTER TABLE "pool_codex_login" ADD CONSTRAINT "pool_codex_login_pool_id_user_id_fkey"
  FOREIGN KEY ("pool_id", "user_id") REFERENCES "provider_pool"("id", "owner_id")
  ON DELETE CASCADE ON UPDATE NO ACTION;

COMMIT;
