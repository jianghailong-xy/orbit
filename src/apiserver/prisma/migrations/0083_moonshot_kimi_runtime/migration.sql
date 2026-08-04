-- Kimi (Moonshot) providers move onto the Kimi CLI. Until now a Moonshot key borrowed the Claude
-- runtime against that vendor's Anthropic-compatible shim, so picking "Kimi" in the New Session
-- picker ran `claude`. The Kimi CLI speaks Moonshot's own API natively (the KIMI_MODEL_* provider
-- it synthesizes from injected credentials), so these rows now dispatch as `kimi` against the
-- platform endpoint.
BEGIN;

-- Every row created from this preset points at the shipped Anthropic-compatible URL (.ai or .cn,
-- with or without a trailing slash); the same host serves the platform API at /v1. A base URL that
-- matches neither was typed by hand: the runtime still flips, and its owner can correct the
-- endpoint from the provider form rather than have a guess written over their choice.
UPDATE "model_provider"
SET "runtime" = 'kimi',
    "base_url" = regexp_replace("base_url", '/anthropic/?$', '/v1')
WHERE "preset_slug" = 'moonshot';

-- These sessions carry a Claude-style session id the control plane pre-generated for a runtime
-- that never created it, so Kimi would open its first turn by resuming a conversation that does
-- not exist. Clearing it makes the next spawn start a fresh Kimi thread. Turns already recorded
-- stay in Orbit's own transcript; what is lost is the old runtime's private context, which Kimi
-- could not have read in any case.
UPDATE "session"
SET "runtime_session_id" = NULL
WHERE "runtime_session_id" IS NOT NULL
  AND COALESCE(
        "provider",
        (SELECT "provider" FROM "agent" WHERE "agent"."id" = "session"."agent_id")
      ) IN (SELECT "slug" FROM "model_provider" WHERE "preset_slug" = 'moonshot');

COMMIT;
