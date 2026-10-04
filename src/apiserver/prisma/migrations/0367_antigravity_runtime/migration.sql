-- 0367 — `antigravity` becomes a built-in runtime keyword: Google's Antigravity CLI (`agy`), driven
-- headless by the runner (docs/antigravity-runtime-contract.md). The same three moves 0080 made for
-- `opencode`, adapted to the schema as it stands now.
--
-- 1. MOVE ASIDE WHATEVER ALREADY ANSWERS TO THE NAME
-- ===================================================
-- Until now `antigravity` was an ordinary dispatch slug: a configured provider labelled
-- "Antigravity" (or a Gemini endpoint somebody named that) got exactly this slug from
-- provider-slug.ts, and since 0265 an account pool could hold it too — one namespace across both
-- tables, which `provider_dispatch_slug_guard` keeps unambiguous. Whichever holds it moves to the
-- first `antigravity-N` free in BOTH tables, and every stored reference moves with it, so its
-- sessions keep dispatching through the same row instead of turning into agy sessions.
--
-- Every reference moves, not only the ones a live row still answers: before this migration the
-- name could mean nothing BUT a configured identity, so a reference whose provider has since been
-- deleted is an orphan of that identity, and it keeps the meaning it had — 0077's reading of the
-- orphaned `kimi` references, not 0080's (which left such `opencode` references to become the new
-- runtime). An orphan moved to `antigravity-N` resolves to nothing exactly as it did under
-- `antigravity`: the Claude fallback on a session, "provider not available" on a pin.
--
-- What stores a dispatch slug today, and what is done with it — checked against every writer of a
-- provider identity in src/apiserver:
--   rewritten (they can hold a configured slug, and something still reads them):
--     * `session.provider`                     — the identity every claim/reclaim resolves.
--     * `task.provider`                        — a task's pin; the next run is created on it.
--     * `task_route_decision.provider`, and `baseline.provider` inside it — what the run beside it
--                                                is shown to have been routed to (0364).
--     * `task_run_request.target`, BOUND rows  — the frozen plan a takeover executes verbatim, which
--                                                names the provider at `provider`, at
--                                                `items[].provider` and inside each `route`.
--     * `workspace.provider_fallbacks`         — `[{provider, model?}]` (0121).
--     * `workspace.model_routing_providers`    — TEXT[] (0364).
--     * `agent.default_provider`, `agent.provider_fallbacks` — the project identity's (0129); no
--                                                writer sets them today, which makes the rewrite
--                                                free, not unnecessary.
--     * `user.preferences.defaultModels`       — the last model picked per provider, KEYED by slug:
--                                                the key moves, or the built-in runtime would
--                                                inherit a configured provider's model as its own.
--     * `wiki_space.settings.maintenance.provider` — the provider a space's maintenance runs on,
--                                                which has to be a configured one on the Claude
--                                                runtime; left as `antigravity` it would be refused.
--   left alone:
--     * `run_event` payloads                   — history; a `provider` there is the runtime the
--                                                runner reported, never a configured slug.
--     * `conversation_turn.content` of a reload — names the provider only as a staleness signal;
--                                                the credential is resolved from
--                                                `session.provider` (rewritten above) at delivery
--                                                (RunnerApiController.reloadProviderEnv).
--     * `task_run_request.result`, COMPLETED targets — an answer replayed byte for byte to a
--                                                repeat, never acted on again.
--     * `session.resolution`                   — the removed coordinator loop's frozen record:
--                                                nothing in the tree writes or reads it any more.
--     * `project_blocker.subject_id`           — would name a configured provider by its row id;
--                                                only a built-in is named by slug there.
--     * `task_route_decision.reasons`          — prose.
--     * `provider_pool_member`, pool keys and logins — reach their pool and provider by id.
--
-- 2. RESERVE THE NAME, AND FENCE THE CONTROL PLANE THAT DOES NOT KNOW IT
-- =======================================================================
-- A protected compatibility row now holds the slug. New code knows `antigravity` is built in and
-- never dispatches through it (ProvidersService hides it from every list). An older replica still
-- serving during the rolling deploy does not: it resolves the slug to this row, and the
-- deliberately invalid ciphertext fails its whole reclaim response before it can tell a restarted
-- runner to rebuild an agy session as Claude. Holding the slug also keeps the name from an older
-- replica: its slug picker sees it taken and moves on, and a direct write of it is refused — a
-- provider by the CHECK below, a pool by 0265's dispatch-slug guard.
--
-- 3. FENCE THE CLAIM
-- ==================
-- Every runner released before agy support reads an unknown provider as Claude, so the claim SQL
-- only hands an Antigravity row to a runner that advertises `antigravity`
-- (QueueService.trySessionClaim). An older replica's claim SQL has no such predicate; the session
-- trigger at the end drops its PENDING -> RUNNING on such a row unless the transaction set the
-- capability GUC, which only the new claim path does.
BEGIN;

DO $$
DECLARE
    candidate TEXT := 'antigravity-2';
    suffix INTEGER := 2;
BEGIN
    -- Keep candidate selection and the rewrite one atomic view of dispatch identity: the two
    -- tables that hold slugs, and the two that every dispatch resolves one from. Without these
    -- locks a concurrent older replica could take the chosen suffix, or write a new
    -- `provider = 'antigravity'` dispatch reference between the checks and the updates. Session
    -- before task, the canonical order (common/lock-order.ts). The other tables rewritten below
    -- take only their own row locks: a claim resolves a session's provider from `session` alone,
    -- and whatever acts on one of them later (a takeover creating a session) writes `session`.
    LOCK TABLE "model_provider", "provider_pool", "session", "task" IN SHARE ROW EXCLUSIVE MODE;

    WHILE EXISTS (SELECT 1 FROM "model_provider" WHERE "slug" = candidate)
       OR EXISTS (SELECT 1 FROM "provider_pool" WHERE "slug" = candidate) LOOP
        suffix := suffix + 1;
        candidate := 'antigravity-' || suffix;
    END LOOP;

    -- The holder, if there is one. 0265's guard keeps the slug in at most one of the two tables,
    -- and checks the new name against the other one as it is written.
    UPDATE "model_provider" SET "slug" = candidate WHERE "slug" = 'antigravity';
    UPDATE "provider_pool" SET "slug" = candidate WHERE "slug" = 'antigravity';

    -- Dispatch identities.
    UPDATE "session" SET "provider" = candidate WHERE "provider" = 'antigravity';
    UPDATE "task" SET "provider" = candidate WHERE "provider" = 'antigravity';

    -- What a run was routed to, beside it.
    UPDATE "task_route_decision" SET "provider" = candidate WHERE "provider" = 'antigravity';
    UPDATE "task_route_decision"
       SET "baseline" = jsonb_set("baseline", '{provider}', to_jsonb(candidate))
     WHERE "baseline"->>'provider' = 'antigravity';

    -- A bound plan names its provider at three depths and in two versions of two shapes (RUN and
    -- BATCH, task-run-receipt.ts). Rewritten on jsonb's canonical text, where a key and its value
    -- always read `"key": "value"` and a quote inside a string is always escaped: the pattern can
    -- only match an object member named exactly `provider` whose value is exactly `antigravity`,
    -- at any depth, and never prose that happens to contain the words.
    UPDATE "task_run_request"
       SET "target" = replace(
               "target"::text,
               '"provider": "antigravity"',
               '"provider": ' || to_jsonb(candidate)::text
           )::jsonb
     WHERE "status" = 'BOUND'
       AND strpos("target"::text, '"provider": "antigravity"') > 0;

    -- Fallback chains, `[{provider, model?}]`, element order kept.
    UPDATE "workspace" w
       SET "provider_fallbacks" = (
               SELECT jsonb_agg(
                          CASE WHEN f->>'provider' = 'antigravity'
                               THEN jsonb_set(f, '{provider}', to_jsonb(candidate))
                               ELSE f
                          END
                          ORDER BY n)
                 FROM jsonb_array_elements(w."provider_fallbacks") WITH ORDINALITY AS t(f, n)
           )
     WHERE w."provider_fallbacks" @> '[{"provider": "antigravity"}]'::jsonb;
    UPDATE "agent" a
       SET "provider_fallbacks" = (
               SELECT jsonb_agg(
                          CASE WHEN f->>'provider' = 'antigravity'
                               THEN jsonb_set(f, '{provider}', to_jsonb(candidate))
                               ELSE f
                          END
                          ORDER BY n)
                 FROM jsonb_array_elements(a."provider_fallbacks") WITH ORDINALITY AS t(f, n)
           )
     WHERE a."provider_fallbacks" @> '[{"provider": "antigravity"}]'::jsonb;
    UPDATE "agent" SET "default_provider" = candidate WHERE "default_provider" = 'antigravity';

    UPDATE "workspace"
       SET "model_routing_providers" = array_replace("model_routing_providers", 'antigravity', candidate)
     WHERE 'antigravity' = ANY("model_routing_providers");

    -- The last model picked for the provider travels with it, under its new key.
    UPDATE "user"
       SET "preferences" = jsonb_set(
               "preferences",
               '{defaultModels}',
               ("preferences"->'defaultModels') - 'antigravity'
                   || jsonb_build_object(candidate, "preferences"->'defaultModels'->'antigravity')
           )
     WHERE jsonb_typeof("preferences"->'defaultModels') = 'object'
       AND ("preferences"->'defaultModels') ? 'antigravity';

    UPDATE "wiki_space"
       SET "settings" = jsonb_set("settings", '{maintenance,provider}', to_jsonb(candidate))
     WHERE "settings"->'maintenance'->>'provider' = 'antigravity';
END $$;

-- Leave a protected compatibility fence at the old control plane's custom-provider lookup (see 2.
-- above). `runtime` is `claude` because that is what an older replica would have run it as; it
-- never gets that far, since the key cannot be decrypted. Inserted after the move, so 0265's
-- dispatch-slug guard finds no pool holding the name either.
INSERT INTO "model_provider" (
    "id", "slug", "label", "runtime", "base_url", "api_key_enc", "models",
    "default_model", "preset_slug", "follows_preset", "enabled", "position",
    "owner_id", "created_at", "updated_at"
) VALUES (
    '00000000-0000-7000-8000-000000000367',
    'antigravity',
    '__orbit_builtin_antigravity_guard__',
    'claude',
    'http://127.0.0.1',
    'orbit-antigravity-compatibility-guard',
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

-- Pin only what the fence depends on, exactly as 0080 does: the row must stay deployment-owned (no
-- owner), enabled (a disabled row makes an old replica fall back to Claude silently — the exact
-- outcome this guards against), and hold the invalid ciphertext that makes an old replica fail
-- loudly. Cosmetic columns are deliberately excluded so a future bulk UPDATE on this table still
-- works.
ALTER TABLE "model_provider"
    ADD CONSTRAINT "model_provider_builtin_antigravity_guard_shape"
    CHECK (
        "slug" <> 'antigravity'
        OR (
            "id" = '00000000-0000-7000-8000-000000000367'
            AND "owner_id" IS NULL
            AND "enabled" = true
            AND "api_key_enc" = 'orbit-antigravity-compatibility-guard'
        )
    );

CREATE OR REPLACE FUNCTION protect_builtin_antigravity_provider_guard()
RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'the antigravity provider slug is reserved for a built-in runtime'
        USING ERRCODE = '23514';
    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

-- Block only the two operations that would retire the fence — deleting the row or renaming it off
-- the reserved slug. An UPDATE that leaves `slug = 'antigravity'` still has to satisfy the CHECK
-- above, so ordinary table-wide maintenance is not turned into a hard error by this trigger.
CREATE TRIGGER model_provider_builtin_antigravity_guard_delete
BEFORE DELETE ON "model_provider"
FOR EACH ROW
WHEN (OLD."slug" = 'antigravity')
EXECUTE FUNCTION protect_builtin_antigravity_provider_guard();

CREATE TRIGGER model_provider_builtin_antigravity_guard_rename
BEFORE UPDATE ON "model_provider"
FOR EACH ROW
WHEN (OLD."slug" = 'antigravity' AND NEW."slug" IS DISTINCT FROM 'antigravity')
EXECUTE FUNCTION protect_builtin_antigravity_provider_guard();

-- INVARIANT: after this migration, PENDING -> RUNNING on an Antigravity session is only legal from
-- QueueService.trySessionClaim, which sets `orbit.runner_supports_antigravity` in the same
-- transaction. Any other code path making that transition is silently skipped by the trigger
-- below (a BEFORE trigger returning NULL drops the row update without raising). See
-- common/session-scheduling.ts, and antigravity-migration-guard.spec.ts which pins these
-- predicates.
--
-- A new apiserver can create Antigravity work while an older replica is still serving runner
-- long-polls. Old claim SQL does not understand the provider and would otherwise dispatch it as
-- Claude. New queue transactions set this custom GUC only after seeing a runner's positive
-- Antigravity capability header; legacy queue transactions leave it unset and this row update is
-- skipped. Returning NULL from a BEFORE trigger makes UPDATE ... RETURNING yield no claim.
CREATE OR REPLACE FUNCTION guard_antigravity_runner_claim()
RETURNS trigger AS $$
BEGIN
    IF OLD."status" = 'PENDING'
       AND NEW."status" = 'RUNNING'
       AND NEW."provider" = 'antigravity'
       AND COALESCE(current_setting('orbit.runner_supports_antigravity', true), '0') <> '1' THEN
        RETURN NULL;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER session_antigravity_runner_claim_guard
BEFORE UPDATE OF "status" ON "session"
FOR EACH ROW EXECUTE FUNCTION guard_antigravity_runner_claim();

COMMIT;
