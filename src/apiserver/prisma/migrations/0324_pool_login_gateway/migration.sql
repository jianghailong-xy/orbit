-- 0324 — the pool gateway for a pool of the account owner's own ChatGPT login (P3-b): the session
-- tokens its claims mint, its ledger, what the gateway learns of the account from the upstream's own
-- answers, and the account a session is bound to.
--
-- WHAT IT ADDS
-- ============
--   * `pool_codex_login` gains three nullable columns with no default (catalog-only):
--       - `spent_until` — until when the account's subscription said its usage limit is reached: the
--         `resets_at` of the Codex backend's 429 `usage_limit_reached`, as the official codex CLI reads
--         it. The gateway writes it before that answer goes back, and clears it on the next answer the
--         backend takes; what waits on it is the session's retry (QueueService.accountPoolResumesAt). It
--         is never a reason to switch accounts: a login pool has one.
--       - `usage`, `usage_read_at` — the last x-codex-* window reading the backend answered with (a Codex
--         PlanUsageSnapshot: used percent, window length and reset of the primary and secondary windows),
--         and when; the pool page's quota.
--     No token column is touched, and none is added.
--   * `session` gains `pool_codex_account_id` — nullable, no default, no index, no CHECK, no foreign key,
--     like 0321's `pool_key_id` — the account (pool_codex_login.account_id) a login-pool session's last
--     claim bound it to. No stored session row is rewritten or constrained.
--   * `pool_login_token` — a login pool's session tokens, the twin of 0321's `pool_gateway_token`, which
--     cannot hold one: that table's person is a `provider_pool_person` row and a login pool has no
--     people. Only the SHA-256 of a token is stored. Three foreign keys, each ON DELETE CASCADE:
--       - (pool_id, user_id) → provider_pool(id, owner_id): the token's person is the pool's owner, the
--         same composite fence 0323 draws for the login itself, so no token row can name anybody else;
--       - (pool_id, account_id) → pool_codex_login(pool_id, account_id): a token is bound to the account
--         its claim found, so taking that account out of the pool deletes it in the same statement.
--         MATCH SIMPLE, so a token minted while the pool held no account (account_id NULL) is not
--         checked — the gateway answers it with that;
--       - session_id → session(id): a deleted session's tokens go with it.
--   * `pool_login_usage` — the ledger: per session, per account, per UTC hour (`window_start`), the
--     requests, input (cached among it) and output tokens, and what they would have cost at OpenAI's API
--     prices in micro-dollars. Whole hours, so a subscription's five-hour or weekly window is a sum of
--     rows. pool_id → provider_pool and session_id → session, each ON DELETE CASCADE; `account_id` has no
--     foreign key, so the history outlives the account's leaving the pool.
--
-- Nothing else is touched: 0265's personal Claude pools, 0321/0322's shared pools, keys, tokens and
-- ledger, and 0323's login rows as they stand. Every new table starts empty and nothing is backfilled.
-- No function, trigger, type or enum is created, replaced or dropped. BEGIN/COMMIT of its own, as 0265,
-- 0321 and 0323 have.

BEGIN;

-- AlterTable
ALTER TABLE "pool_codex_login"
  ADD COLUMN "spent_until" TIMESTAMP(3),
  ADD COLUMN "usage" JSONB,
  ADD COLUMN "usage_read_at" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "session" ADD COLUMN "pool_codex_account_id" TEXT;

-- CreateTable
CREATE TABLE "pool_login_token" (
    "id" UUID NOT NULL,
    "token_hash" TEXT NOT NULL,
    "pool_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "account_id" TEXT,
    "session_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "revoked_at" TIMESTAMP(3),

    CONSTRAINT "pool_login_token_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pool_login_usage" (
    "pool_id" UUID NOT NULL,
    "account_id" TEXT NOT NULL,
    "session_id" UUID NOT NULL,
    "window_start" TIMESTAMP(3) NOT NULL,
    "requests" INTEGER NOT NULL DEFAULT 0,
    "input_tokens" BIGINT NOT NULL DEFAULT 0,
    "cached_input_tokens" BIGINT NOT NULL DEFAULT 0,
    "output_tokens" BIGINT NOT NULL DEFAULT 0,
    "cost_micros" BIGINT NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "pool_login_usage_pkey" PRIMARY KEY ("session_id","account_id","window_start")
);

-- CreateIndex
CREATE UNIQUE INDEX "pool_login_token_token_hash_key" ON "pool_login_token"("token_hash");

-- CreateIndex
CREATE INDEX "pool_login_token_session_id_idx" ON "pool_login_token"("session_id");

-- CreateIndex
CREATE INDEX "pool_login_token_pool_id_account_id_idx" ON "pool_login_token"("pool_id", "account_id");

-- CreateIndex
CREATE INDEX "pool_login_usage_pool_id_window_start_idx" ON "pool_login_usage"("pool_id", "window_start");

-- AddForeignKey
ALTER TABLE "pool_login_token" ADD CONSTRAINT "pool_login_token_pool_id_user_id_fkey"
  FOREIGN KEY ("pool_id", "user_id") REFERENCES "provider_pool"("id", "owner_id")
  ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "pool_login_token" ADD CONSTRAINT "pool_login_token_pool_id_account_id_fkey"
  FOREIGN KEY ("pool_id", "account_id") REFERENCES "pool_codex_login"("pool_id", "account_id")
  ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "pool_login_token" ADD CONSTRAINT "pool_login_token_session_id_fkey"
  FOREIGN KEY ("session_id") REFERENCES "session"("id")
  ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "pool_login_usage" ADD CONSTRAINT "pool_login_usage_pool_id_fkey"
  FOREIGN KEY ("pool_id") REFERENCES "provider_pool"("id")
  ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "pool_login_usage" ADD CONSTRAINT "pool_login_usage_session_id_fkey"
  FOREIGN KEY ("session_id") REFERENCES "session"("id")
  ON DELETE CASCADE ON UPDATE NO ACTION;

COMMIT;
