-- What Claude Code sessions on an OpenAI key spend through /api/gw/anthropic (docs/claude-engine-openai-gateway-design.md
-- §5.5, decision D8).
--
--   * `key_gateway_usage` — one row per answer OpenAI gave such a session: the model, its tier, the input
--     (cached included), cached, output (reasoning included) and reasoning tokens the Responses stream's final
--     event counted, and their price from openai-prices.ts in US dollars × 1,000,000. Per session and key:
--     deleting either deletes its rows.
--
-- Nothing existing is altered; no row is written at apply time.

-- CreateTable
CREATE TABLE "key_gateway_usage" (
    "id" UUID NOT NULL,
    "session_id" UUID NOT NULL,
    "provider_id" UUID NOT NULL,
    "model" TEXT NOT NULL,
    "service_tier" TEXT,
    "input_tokens" BIGINT NOT NULL DEFAULT 0,
    "cached_input_tokens" BIGINT NOT NULL DEFAULT 0,
    "output_tokens" BIGINT NOT NULL DEFAULT 0,
    "reasoning_tokens" BIGINT NOT NULL DEFAULT 0,
    "cost_micros" BIGINT NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "key_gateway_usage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "key_gateway_usage_session_id_idx" ON "key_gateway_usage"("session_id");

-- CreateIndex
CREATE INDEX "key_gateway_usage_provider_id_idx" ON "key_gateway_usage"("provider_id");

-- AddForeignKey
ALTER TABLE "key_gateway_usage" ADD CONSTRAINT "key_gateway_usage_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "session"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "key_gateway_usage" ADD CONSTRAINT "key_gateway_usage_provider_id_fkey" FOREIGN KEY ("provider_id") REFERENCES "model_provider"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
