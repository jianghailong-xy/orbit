ALTER TABLE "runner" ADD COLUMN "account_pauses" JSONB;

ALTER TABLE "provider_pool_member"
  ADD COLUMN "paused_at" TIMESTAMPTZ(3),
  ADD COLUMN "paused_until" TIMESTAMPTZ(3);
ALTER TABLE "pool_api_key"
  ADD COLUMN "paused_at" TIMESTAMPTZ(3),
  ADD COLUMN "paused_until" TIMESTAMPTZ(3);
ALTER TABLE "pool_codex_login"
  ADD COLUMN "paused_at" TIMESTAMPTZ(3),
  ADD COLUMN "paused_until" TIMESTAMPTZ(3);
