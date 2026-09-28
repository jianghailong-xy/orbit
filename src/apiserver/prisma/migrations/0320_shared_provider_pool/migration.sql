-- 0320 — shared Codex pools: several Orbit users run Codex sessions on organization/project OpenAI API
-- keys that live only on this server (docs/codex-shared-pool-design.md §2.2–§2.5, "account" read as
-- "key" throughout).
--
-- WHAT IT ADDS
-- ============
--   * `provider_pool` gains `engine`, `shared`, `members_can_add` and `own_key_first`. A personal pool
--     (0265) is `shared = false` on `claude`, which is every row that exists today — the constant
--     defaults are catalog-only, so no stored pool is rewritten. A shared pool is `shared = true` on
--     `codex`, the only kind this builds; `provider_pool_engine_check` holds the two together, so no code
--     that reads a personal pool can be handed a shared one it would dispatch as Claude. `owner_id` stays
--     NOT NULL: on a shared pool it is the person who created it, who is always one of its admins.
--   * `provider_pool_person` — who is in a shared pool, and whether as ADMIN or MEMBER.
--   * `pool_api_key` — one organization/project OpenAI key in a shared pool. The secret is at rest only
--     as `secret_encrypted` (PROVIDER_SECRET_KEY, providers/provider-crypto.ts); `key_fingerprint` is the
--     SHA-256 of the key, what two adds of one key collide on (`pool_api_key_pool_id_key_fingerprint_key`,
--     one pool at a time), and `key_hint` its last four characters, which is all a response ever shows of
--     it ("sk-…AB12"). The composite foreign key (pool_id, contributor_id) → provider_pool_person is the
--     tenant fence 0265 draws with its own keys: the database refuses a key whose contributor is not in
--     the pool, and a person leaving takes their keys with them. `state` is what OpenAI last said about
--     the key — ACTIVE, INVALID (a 401: the key is wrong or was revoked) or DISABLED (refused for its
--     organization or project) — and `enabled` is its contributor's own switch; a claim chooses only a
--     key that is both ACTIVE and enabled. `share_cap` is how many whole US dollars a calendar month
--     everyone but the contributor may spend on it, NULL for no cap; the contributor's own use is never
--     capped.
--   * `pool_gateway_token` — the credential a session on a shared pool runs with instead of a key. Only
--     `token_hash` (SHA-256) is stored; the token itself exists in the claim payload the runner receives
--     and nowhere else. It is bound to (pool, person, session): the key (pool_id, user_id) →
--     provider_pool_person means removing the person, or deleting the pool, deletes their tokens in the
--     same statement, and deleting the session deletes its tokens too.
--   * `pool_usage` — the ledger: what one person spent on one key in one calendar month (UTC),
--     `window_start` being its first day. Written by the gateway; read by the pool page and by the claim,
--     which passes over a key whose share cap the others have spent. (key_id, pool_id) → pool_api_key
--     keeps a row on a key of its own pool, and a key removed takes its rows with it.
--   * `session.pool_key_id` — the key a shared-pool session's last claim chose, which the next claim stays
--     on while it can run. No foreign key, as 0268 has none for `pool_member_provider_id`: a key removed
--     matches no key of the pool and the claim simply chooses again, and a key here would put
--     `pool_api_key` into the lock set of every session write that re-checks the row's foreign keys.
--
-- The personal Claude pools' tables and keys (0265, 0268) are not touched beyond the four columns above.
--
-- No backfill, no row written: every new table starts empty, and every new column of an existing table
-- is NULL or a constant default. BEGIN/COMMIT of its own, as 0265 has: the tables and their keys mean
-- nothing apart.

BEGIN;

-- AlterTable
ALTER TABLE "provider_pool"
  ADD COLUMN "engine" TEXT NOT NULL DEFAULT 'claude',
  ADD COLUMN "shared" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "members_can_add" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "own_key_first" BOOLEAN NOT NULL DEFAULT true;

ALTER TABLE "provider_pool"
  ADD CONSTRAINT "provider_pool_engine_check"
  CHECK (("shared" AND "engine" = 'codex') OR (NOT "shared" AND "engine" = 'claude'));

-- AlterTable
ALTER TABLE "session" ADD COLUMN "pool_key_id" UUID;

-- CreateTable
CREATE TABLE "provider_pool_person" (
    "pool_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "role" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "provider_pool_person_pkey" PRIMARY KEY ("pool_id","user_id"),
    CONSTRAINT "provider_pool_person_role_check" CHECK ("role" IN ('ADMIN', 'MEMBER'))
);

-- CreateTable
CREATE TABLE "pool_api_key" (
    "id" UUID NOT NULL,
    "pool_id" UUID NOT NULL,
    "contributor_id" UUID NOT NULL,
    "label" TEXT NOT NULL,
    "key_fingerprint" TEXT NOT NULL,
    "key_hint" TEXT NOT NULL,
    "secret_encrypted" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'ACTIVE',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "share_cap" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "pool_api_key_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "pool_api_key_state_check" CHECK ("state" IN ('ACTIVE', 'INVALID', 'DISABLED')),
    CONSTRAINT "pool_api_key_share_cap_check" CHECK ("share_cap" IS NULL OR "share_cap" >= 0)
);

-- CreateTable
CREATE TABLE "pool_gateway_token" (
    "id" UUID NOT NULL,
    "token_hash" TEXT NOT NULL,
    "pool_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "session_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "revoked_at" TIMESTAMP(3),

    CONSTRAINT "pool_gateway_token_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pool_usage" (
    "pool_id" UUID NOT NULL,
    "key_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "window_start" DATE NOT NULL,
    "input_tokens" BIGINT NOT NULL DEFAULT 0,
    "output_tokens" BIGINT NOT NULL DEFAULT 0,
    "cost_micros" BIGINT NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "pool_usage_pkey" PRIMARY KEY ("key_id","user_id","window_start")
);

-- CreateIndex
CREATE INDEX "provider_pool_person_user_id_idx" ON "provider_pool_person"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "pool_api_key_pool_id_key_fingerprint_key" ON "pool_api_key"("pool_id", "key_fingerprint");

-- CreateIndex
CREATE UNIQUE INDEX "pool_api_key_id_pool_id_key" ON "pool_api_key"("id", "pool_id");

-- CreateIndex
CREATE INDEX "pool_api_key_pool_id_contributor_id_idx" ON "pool_api_key"("pool_id", "contributor_id");

-- CreateIndex
CREATE UNIQUE INDEX "pool_gateway_token_token_hash_key" ON "pool_gateway_token"("token_hash");

-- CreateIndex
CREATE INDEX "pool_gateway_token_session_id_idx" ON "pool_gateway_token"("session_id");

-- CreateIndex
CREATE INDEX "pool_gateway_token_pool_id_user_id_idx" ON "pool_gateway_token"("pool_id", "user_id");

-- CreateIndex
CREATE INDEX "pool_usage_pool_id_window_start_idx" ON "pool_usage"("pool_id", "window_start");

-- CreateIndex
CREATE INDEX "pool_usage_user_id_idx" ON "pool_usage"("user_id");

-- AddForeignKey
ALTER TABLE "provider_pool_person" ADD CONSTRAINT "provider_pool_person_pool_id_fkey" FOREIGN KEY ("pool_id") REFERENCES "provider_pool"("id") ON DELETE CASCADE;

-- AddForeignKey
ALTER TABLE "provider_pool_person" ADD CONSTRAINT "provider_pool_person_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE;

-- AddForeignKey
ALTER TABLE "pool_api_key" ADD CONSTRAINT "pool_api_key_pool_id_contributor_id_fkey" FOREIGN KEY ("pool_id", "contributor_id") REFERENCES "provider_pool_person"("pool_id", "user_id") ON DELETE CASCADE;

-- AddForeignKey
ALTER TABLE "pool_gateway_token" ADD CONSTRAINT "pool_gateway_token_pool_id_user_id_fkey" FOREIGN KEY ("pool_id", "user_id") REFERENCES "provider_pool_person"("pool_id", "user_id") ON DELETE CASCADE;

-- AddForeignKey
ALTER TABLE "pool_gateway_token" ADD CONSTRAINT "pool_gateway_token_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "session"("id") ON DELETE CASCADE;

-- AddForeignKey
ALTER TABLE "pool_usage" ADD CONSTRAINT "pool_usage_key_id_pool_id_fkey" FOREIGN KEY ("key_id", "pool_id") REFERENCES "pool_api_key"("id", "pool_id") ON DELETE CASCADE;

-- AddForeignKey
ALTER TABLE "pool_usage" ADD CONSTRAINT "pool_usage_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE;

COMMIT;
