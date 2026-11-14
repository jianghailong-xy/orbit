-- Claude Code on an OpenAI key, through Orbit's own gateway (docs/claude-engine-openai-gateway-design.md §4.2).
--
--   * `key_gateway_token` — the credential a Claude Code session on an OpenAI API key runs with instead of
--     the key. It reaches /api/gw/anthropic with it; the gateway sends on with the key, which stays on the
--     server. Only `token_hash` (SHA-256) is stored: the token itself exists in the claim payload the runner
--     receives and nowhere else. It is bound to (session, key, person): deleting any of the three deletes its
--     tokens in the same statement. A key disabled or rotated sets `revoked_at`.
--
-- A table of its own rather than a nullable pool id on `pool_gateway_token`, so the pool tables' invariants
-- stay as they are. Nothing existing is altered; no row is written at apply time.

-- CreateTable
CREATE TABLE "key_gateway_token" (
    "id" UUID NOT NULL,
    "token_hash" TEXT NOT NULL,
    "session_id" UUID NOT NULL,
    "provider_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "revoked_at" TIMESTAMP(3),

    CONSTRAINT "key_gateway_token_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "key_gateway_token_token_hash_key" ON "key_gateway_token"("token_hash");

-- CreateIndex
CREATE INDEX "key_gateway_token_session_id_idx" ON "key_gateway_token"("session_id");

-- CreateIndex
CREATE INDEX "key_gateway_token_provider_id_idx" ON "key_gateway_token"("provider_id");

-- CreateIndex
CREATE INDEX "key_gateway_token_user_id_idx" ON "key_gateway_token"("user_id");

-- AddForeignKey
ALTER TABLE "key_gateway_token" ADD CONSTRAINT "key_gateway_token_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "session"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "key_gateway_token" ADD CONSTRAINT "key_gateway_token_provider_id_fkey" FOREIGN KEY ("provider_id") REFERENCES "model_provider"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "key_gateway_token" ADD CONSTRAINT "key_gateway_token_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
