-- One Claude account per ModelProvider row, instead of one token per user.
--
-- `user.claude_oauth_token_enc` could only ever hold a single subscription, so an agent had no
-- way to run on a second Claude account. Modelling each account as a provider row reuses the
-- machinery that already exists for API keys: per-owner rows, encrypted secrets, and — because
-- Agent.provider stores a slug — a per-agent choice with no new plumbing.
--
-- auth_mode says which secret api_key_enc holds and what gets injected at dispatch: an API key
-- pointing at a custom endpoint, or a `claude setup-token` that leaves the endpoint alone.
ALTER TABLE "model_provider" ADD COLUMN "auth_mode" TEXT NOT NULL DEFAULT 'api_key';
ALTER TABLE "model_provider" ADD COLUMN "is_default" BOOLEAN NOT NULL DEFAULT false;

-- Carry every stored token over as that user's first (and default) account. The slug is derived
-- from the owner's id rather than the label so it can't collide with an existing row — it is a
-- dispatch identifier nobody reads. follows_preset = true keeps the row's model list resolving
-- from the anthropic preset, so the account offers the current Claude models in the pickers.
INSERT INTO "model_provider" (
  "id", "slug", "label", "runtime", "base_url", "api_key_enc", "models", "default_model",
  "preset_slug", "follows_preset", "enabled", "owner_id", "auth_mode", "is_default",
  "created_at", "updated_at"
)
SELECT
  gen_random_uuid(),
  'claude-' || replace(u."id"::text, '-', ''),
  'Claude subscription',
  'claude',
  'https://api.anthropic.com',
  u."claude_oauth_token_enc",
  '[]'::jsonb,
  NULL,
  'anthropic',
  true,
  true,
  u."id",
  'subscription',
  true,
  COALESCE(u."claude_oauth_token_set_at", CURRENT_TIMESTAMP),
  CURRENT_TIMESTAMP
FROM "user" u
WHERE u."claude_oauth_token_enc" IS NOT NULL;

-- The old columns stay for now: nothing reads them after this, but keeping them makes the
-- migration reversible while it rolls out. A later migration drops them.
