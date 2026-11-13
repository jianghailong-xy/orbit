-- Claude Code on an OpenAI key, through Orbit's own gateway (docs/claude-engine-openai-gateway-design.md §5.4).
--
--   * `model_provider.spent_until` — until when OpenAI said the key is out of budget: the gateway writes it
--     when OpenAI answers `insufficient_quota` (the reset OpenAI names, else the first of the next month, as
--     the pool gateway's `spentUntil` reads it), and clears it on the key's next answered request and on a
--     new secret. NULL = not known to be spent. Only the /api/gw/anthropic gateway writes it.
--
-- One nullable column, no default, no index: nothing is rewritten at apply time and no row is written.

-- AlterTable
ALTER TABLE "model_provider" ADD COLUMN "spent_until" TIMESTAMP(3);
