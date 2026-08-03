-- `opencode` becomes a built-in runtime keyword. Older deployments could already have a
-- user-created ModelProvider with that slug, so move that provider (and every reference to it)
-- to the first free suffixed slug before the application starts treating `opencode` as built-in.
BEGIN;

DO $$
DECLARE
    candidate TEXT := 'opencode-2';
    suffix INTEGER := 2;
BEGIN
    -- Keep candidate selection and the three-table rewrite one atomic view of provider
    -- identity. Without these locks, a concurrent old app instance could insert an occupied
    -- suffix or write a new `provider = 'opencode'` reference between the checks and updates.
    LOCK TABLE "model_provider", "agent", "session" IN SHARE ROW EXCLUSIVE MODE;

    IF EXISTS (SELECT 1 FROM "model_provider" WHERE "slug" = 'opencode') THEN
        WHILE EXISTS (SELECT 1 FROM "model_provider" WHERE "slug" = candidate) LOOP
            suffix := suffix + 1;
            candidate := 'opencode-' || suffix;
        END LOOP;

        UPDATE "agent" SET "provider" = candidate WHERE "provider" = 'opencode';
        UPDATE "session" SET "provider" = candidate WHERE "provider" = 'opencode';
        UPDATE "model_provider" SET "slug" = candidate WHERE "slug" = 'opencode';
    END IF;
END $$;

-- Leave a protected compatibility fence at the old control plane's custom-provider lookup.
-- New code recognizes `opencode` as built-in and never dispatches through this row. An older
-- replica does not: resolving the deliberately invalid ciphertext fails the whole reclaim
-- response before it can tell a restarted runner to rebuild an OpenCode session as Claude.
-- The unique slug also permanently reserves the built-in keyword against legacy creates.
INSERT INTO "model_provider" (
    "id", "slug", "label", "runtime", "base_url", "api_key_enc", "models",
    "default_model", "preset_slug", "follows_preset", "enabled", "position",
    "owner_id", "created_at", "updated_at"
) VALUES (
    '00000000-0000-7000-8000-000000000082',
    'opencode',
    '__orbit_builtin_opencode_guard__',
    'claude',
    'http://127.0.0.1',
    'orbit-opencode-compatibility-guard',
    '[]'::jsonb,
    NULL,
    NULL,
    false,
    true,
    NULL,
    NULL,
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
);

-- Pin only what the fence depends on: the row must stay deployment-owned (no owner), enabled
-- (a disabled row makes an old replica fall back to Claude silently — the exact outcome this
-- guards against), and hold the invalid ciphertext that makes an old replica fail loudly.
-- Cosmetic columns are deliberately excluded so a future bulk UPDATE on this table still works.
ALTER TABLE "model_provider"
    ADD CONSTRAINT "model_provider_builtin_opencode_guard_shape"
    CHECK (
        "slug" <> 'opencode'
        OR (
            "id" = '00000000-0000-7000-8000-000000000082'
            AND "owner_id" IS NULL
            AND "enabled" = true
            AND "api_key_enc" = 'orbit-opencode-compatibility-guard'
        )
    );

CREATE OR REPLACE FUNCTION protect_builtin_opencode_provider_guard()
RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'the opencode provider slug is reserved for a built-in runtime'
        USING ERRCODE = '23514';
    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

-- Block only the two operations that would retire the fence — deleting the row or renaming it
-- off the reserved slug. An UPDATE that leaves `slug = 'opencode'` still has to satisfy the CHECK
-- above, so ordinary table-wide maintenance is not turned into a hard error by this trigger.
CREATE TRIGGER model_provider_builtin_opencode_guard_delete
BEFORE DELETE ON "model_provider"
FOR EACH ROW
WHEN (OLD."slug" = 'opencode')
EXECUTE FUNCTION protect_builtin_opencode_provider_guard();

CREATE TRIGGER model_provider_builtin_opencode_guard_rename
BEFORE UPDATE ON "model_provider"
FOR EACH ROW
WHEN (OLD."slug" = 'opencode' AND NEW."slug" IS DISTINCT FROM 'opencode')
EXECUTE FUNCTION protect_builtin_opencode_provider_guard();

-- INVARIANT: after this migration, PENDING -> RUNNING on an OpenCode session is only legal from
-- QueueService.trySessionClaim, which sets `orbit.runner_supports_opencode` in the same
-- transaction. Any other code path making that transition is silently skipped by the trigger
-- below (a BEFORE trigger returning NULL drops the row update without raising). See
-- common/session-scheduling.ts, and opencode-migration-guard.spec.ts which pins these predicates.
--
-- A new apiserver can create OpenCode work while an older replica is still serving runner
-- long-polls. Old claim SQL does not understand the provider and would otherwise dispatch it
-- as Claude. New queue transactions set this custom GUC only after seeing a runner's positive
-- OpenCode capability header; legacy queue transactions leave it unset and this row update is
-- skipped. Returning NULL from a BEFORE trigger makes UPDATE ... RETURNING yield no claim.
CREATE OR REPLACE FUNCTION guard_opencode_runner_claim()
RETURNS trigger AS $$
BEGIN
    IF OLD."status" = 'PENDING'
       AND NEW."status" = 'RUNNING'
       AND NEW."provider" = 'opencode'
       AND COALESCE(current_setting('orbit.runner_supports_opencode', true), '0') <> '1' THEN
        RETURN NULL;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER session_opencode_runner_claim_guard
BEFORE UPDATE OF "status" ON "session"
FOR EACH ROW EXECUTE FUNCTION guard_opencode_runner_claim();

COMMIT;
