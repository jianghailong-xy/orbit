-- 0426 — `cursor` becomes the seventh engine: Cursor CLI, driven through its own ACP server
-- (`agent acp`, docs/cursor-runtime-contract.md). Four moves. The first and third are 0367's for
-- `antigravity`, adapted to the schema as it stands now; the fourth is 0377's DeepSeek Harness runner
-- gate, keyed on the recorded engine as 0414 keyed it.
--
-- 1. MOVE ASIDE WHATEVER ALREADY ANSWERS TO THE NAME
-- ===================================================
-- Until now `cursor` was an ordinary dispatch slug: a key labelled "Cursor" got exactly this slug from
-- provider-slug.ts, an account pool could hold it (0265), and so could a retired provider name (0415).
-- That is one namespace across three tables, which `provider_dispatch_slug_guard` keeps unambiguous.
-- Whichever holds it moves to the first `cursor-N` free in all three, and every stored reference moves
-- with it, so what named that key, pool or name keeps naming it instead of becoming a Cursor CLI
-- session. A reference whose holder has since been deleted moves too, as 0367's did: before this
-- migration the name could mean nothing but a configured identity, and under `cursor-N` it resolves to
-- nothing exactly as it did.
--
-- What stores a dispatch slug today — 0367's list, checked again against the provider/engine split
-- (0414, 0415, docs/provider-engine-contract.md §1.6, §6.5, §7.3–§7.5) and every writer of a provider
-- identity in src/apiserver:
--   rewritten:
--     * `session.provider`, `task.provider`    — what a claim resolves, and a task's pin. The engine
--                                                 recorded beside either is left as it is: it names the
--                                                 CLI the conversation belongs to, which this does not
--                                                 change.
--     * `session.model`, `task.model`          — the old OpenCode spelling names the key in the model
--                                                 (`provider` `opencode`, `orbit-cursor/<model>`).
--     * `task_route_decision.provider`, and `baseline.provider` inside it.
--     * `task_run_request.target`, BOUND rows  — the frozen plan a takeover executes verbatim: a
--                                                 `provider` at any depth, and an OpenCode `model`
--                                                 naming the key.
--     * `workspace.provider_fallbacks`, `workspace.model_routing_providers`.
--     * `agent.default_provider`, `agent.provider_fallbacks`.
--     * `user.preferences.defaultModels`       — the last model picked, keyed by the old form (`cursor`,
--                                                 `opencode/cursor`) or the new one (`<engine>:cursor`);
--                                                 an `opencode` entry may name the key in its value
--                                                 (`orbit-cursor/<model>`). The moved entry wins over
--                                                 one already under the new name.
--     * `wiki_space.settings.maintenance.provider`.
--   left alone, as 0367 left them: run_event payloads and conversation_turn content (history),
--   COMPLETED task_run_request targets (an answer replayed byte for byte), `session.resolution`,
--   `project_blocker.subject_id`, `task_route_decision.reasons` and `.model`, the models inside
--   `provider_fallbacks` (stored, never dispatched), pool members, keys and logins (they reach their
--   pool and key by id), and `managed_runner.initial_provider` (only ever a built-in engine's name).
--
-- 2. THE ENGINE CHECKS
-- ===================
-- `session_engine_check` and `task_engine_check` (0414) admit `cursor`. Only widened: every row that
-- passed them passes.
--
-- 3. RESERVE THE NAME, AND FENCE THE CONTROL PLANE THAT DOES NOT KNOW IT
-- =====================================================================
-- A protected compatibility row now holds the slug, as 0080's and 0367's hold theirs. New code knows
-- `cursor` is built in and never dispatches through it (ProvidersService.COMPATIBILITY_GUARD_SLUGS). An
-- older replica still serving during the rolling deploy does not: it resolves the slug to this row, and
-- the deliberately invalid ciphertext fails what it would build from it before a runner is told to run
-- a Cursor CLI session as Claude. Holding the slug also keeps the name from an older replica: its slug
-- picker sees it taken and moves on, and a direct write of it is refused — a key by the CHECK below, a
-- pool or a retired name by 0265's dispatch-slug guard.
--
-- 4. FENCE THE CLAIM AND THE LEASE
-- ===============================
-- A runner released before Cursor CLI support does not know the engine, so a Cursor CLI session is
-- acquired — claimed PENDING -> RUNNING, or its inbox lease taken — only by a transaction that declares
-- `orbit.runner_supports_cursor`, for a runner whose persisted heartbeat declares `provider:cursor`
-- (docs/cursor-runtime-contract.md §16.1). Only an API replica that knows Cursor CLI ever declares it:
-- QueueService.trySessionClaim after the runner's request and heartbeat both name it, and the runner
-- lease routes (RunnerApiController takeover-leases and activate-leases). An older replica's claim is
-- skipped and its lease write refused, which it checks lands (0414); a replica older than 0414 reads no
-- engine and is refused by `session_acquisition_engine_guard` before this guard speaks.
--
-- 0426: the highest number on main, every project/* and pushed orbit/* branch and every session
-- worktree was 0425 (0425_login_session_push_binding) when this was written (2026-10-17).
BEGIN;

DO $$
DECLARE
    candidate TEXT := 'cursor-2';
    suffix INTEGER := 2;
BEGIN
    -- Candidate selection and the rewrite are one atomic view of dispatch identity: the three tables
    -- that hold slugs, and the two every dispatch resolves one from. Without these locks a concurrent
    -- older replica could take the chosen suffix, or write a new `provider = 'cursor'` reference
    -- between the checks and the updates. Session before task, the canonical order
    -- (common/lock-order.ts). The other tables rewritten below take only their own row locks, as in
    -- 0367: a claim resolves a session's provider from `session` alone.
    LOCK TABLE "model_provider", "provider_pool", "provider_slug_alias", "session", "task"
        IN SHARE ROW EXCLUSIVE MODE;

    WHILE EXISTS (SELECT 1 FROM "model_provider" WHERE "slug" = candidate)
       OR EXISTS (SELECT 1 FROM "provider_pool" WHERE "slug" = candidate)
       OR EXISTS (SELECT 1 FROM "provider_slug_alias" WHERE "slug" = candidate) LOOP
        suffix := suffix + 1;
        candidate := 'cursor-' || suffix;
    END LOOP;

    -- The holder, if there is one. The dispatch-slug guard keeps the slug in at most one of the three
    -- tables, and checks the new name against the other two as it is written.
    UPDATE "model_provider" SET "slug" = candidate WHERE "slug" = 'cursor';
    UPDATE "provider_pool" SET "slug" = candidate WHERE "slug" = 'cursor';
    UPDATE "provider_slug_alias" SET "slug" = candidate WHERE "slug" = 'cursor';

    -- Dispatch identities, and the key an old OpenCode spelling names in its model.
    UPDATE "session" SET "provider" = candidate WHERE "provider" = 'cursor';
    UPDATE "task" SET "provider" = candidate WHERE "provider" = 'cursor';
    UPDATE "session"
       SET "model" = 'orbit-' || candidate || substr("model", length('orbit-cursor') + 1)
     WHERE "provider" = 'opencode' AND starts_with("model", 'orbit-cursor/');
    UPDATE "task"
       SET "model" = 'orbit-' || candidate || substr("model", length('orbit-cursor') + 1)
     WHERE "provider" = 'opencode' AND starts_with("model", 'orbit-cursor/');

    -- What a run was routed to, beside it.
    UPDATE "task_route_decision" SET "provider" = candidate WHERE "provider" = 'cursor';
    UPDATE "task_route_decision"
       SET "baseline" = jsonb_set("baseline", '{provider}', to_jsonb(candidate))
     WHERE "baseline"->>'provider' = 'cursor';

    -- A bound plan, rewritten on jsonb's canonical text as 0367 rewrote it: a key and its value always
    -- read `"key": "value"` there and a quote inside a string is always escaped, so each pattern can
    -- only match an object member of exactly that name and value (or, for the model, that prefix), at
    -- any depth — never prose that happens to contain the words. `candidate` needs no escaping.
    UPDATE "task_run_request"
       SET "target" = replace(
               replace("target"::text, '"provider": "cursor"', '"provider": "' || candidate || '"'),
               '"model": "orbit-cursor/',
               '"model": "orbit-' || candidate || '/'
           )::jsonb
     WHERE "status" = 'BOUND'
       AND (strpos("target"::text, '"provider": "cursor"') > 0
            OR strpos("target"::text, '"model": "orbit-cursor/') > 0);

    -- Fallback chains, `[{provider, model?}]`, element order kept.
    UPDATE "workspace" w
       SET "provider_fallbacks" = (
               SELECT jsonb_agg(
                          CASE WHEN f->>'provider' = 'cursor'
                               THEN jsonb_set(f, '{provider}', to_jsonb(candidate))
                               ELSE f
                          END
                          ORDER BY n)
                 FROM jsonb_array_elements(w."provider_fallbacks") WITH ORDINALITY AS t(f, n)
           )
     WHERE w."provider_fallbacks" @> '[{"provider": "cursor"}]'::jsonb;
    UPDATE "agent" a
       SET "provider_fallbacks" = (
               SELECT jsonb_agg(
                          CASE WHEN f->>'provider' = 'cursor'
                               THEN jsonb_set(f, '{provider}', to_jsonb(candidate))
                               ELSE f
                          END
                          ORDER BY n)
                 FROM jsonb_array_elements(a."provider_fallbacks") WITH ORDINALITY AS t(f, n)
           )
     WHERE a."provider_fallbacks" @> '[{"provider": "cursor"}]'::jsonb;
    UPDATE "agent" SET "default_provider" = candidate WHERE "default_provider" = 'cursor';

    UPDATE "workspace"
       SET "model_routing_providers" = array_replace("model_routing_providers", 'cursor', candidate)
     WHERE 'cursor' = ANY("model_routing_providers");

    -- The last model picked for the provider travels with it, under its new key. The entries are
    -- rebuilt in one pass; a moved entry is aggregated last, so it wins over one already under its
    -- new name (jsonb keeps the last value of a duplicate key).
    UPDATE "user" u
       SET "preferences" = jsonb_set(u."preferences", '{defaultModels}', moved."models")
      FROM (
        SELECT owner."id", jsonb_object_agg(e."key", e."value" ORDER BY e."moved", e."key") AS "models"
          FROM "user" owner
          CROSS JOIN LATERAL (
            SELECT
              CASE
                WHEN d.key = 'cursor' THEN candidate
                WHEN d.key = 'opencode/cursor' THEN 'opencode/' || candidate
                WHEN d.key ~ '^[^:/]+:cursor$' THEN split_part(d.key, ':', 1) || ':' || candidate
                ELSE d.key
              END AS "key",
              CASE
                WHEN d.key IN ('opencode', 'opencode/cursor')
                 AND jsonb_typeof(d.value) = 'string'
                 AND starts_with(d.value #>> '{}', 'orbit-cursor/')
                  THEN to_jsonb('orbit-' || candidate || substr(d.value #>> '{}', length('orbit-cursor') + 1))
                ELSE d.value
              END AS "value",
              (d.key = 'cursor' OR d.key = 'opencode/cursor' OR d.key ~ '^[^:/]+:cursor$') AS "moved"
            FROM jsonb_each(owner."preferences"->'defaultModels') d
          ) e
         WHERE jsonb_typeof(owner."preferences"->'defaultModels') = 'object'
           AND EXISTS (
             SELECT 1 FROM jsonb_each(owner."preferences"->'defaultModels') d
              WHERE d.key = 'cursor' OR d.key = 'opencode/cursor' OR d.key ~ '^[^:/]+:cursor$'
                 OR (d.key = 'opencode' AND jsonb_typeof(d.value) = 'string'
                     AND starts_with(d.value #>> '{}', 'orbit-cursor/'))
           )
         GROUP BY owner."id"
      ) moved
     WHERE u."id" = moved."id";

    UPDATE "wiki_space"
       SET "settings" = jsonb_set("settings", '{maintenance,provider}', to_jsonb(candidate))
     WHERE "settings"->'maintenance'->>'provider' = 'cursor';
END $$;

-- 2. The engine checks: the six engines and Cursor CLI.
ALTER TABLE "session" DROP CONSTRAINT "session_engine_check";
ALTER TABLE "session" ADD CONSTRAINT "session_engine_check"
  CHECK ("engine" IS NULL OR "engine" IN ('claude', 'codex', 'kimi', 'antigravity', 'opencode', 'dsh', 'cursor'));
ALTER TABLE "task" DROP CONSTRAINT "task_engine_check";
ALTER TABLE "task" ADD CONSTRAINT "task_engine_check"
  CHECK ("engine" IS NULL OR "engine" IN ('claude', 'codex', 'kimi', 'antigravity', 'opencode', 'dsh', 'cursor'));

-- 3. The compatibility fence at an older control plane's provider lookup. `runtime` is `claude`
-- because that is what an older replica would have run it as; it never gets that far, since the key
-- cannot be decrypted. Inserted after the move, so the dispatch-slug guard finds nothing else holding
-- the name.
INSERT INTO "model_provider" (
    "id", "slug", "label", "runtime", "base_url", "api_key_enc", "models",
    "default_model", "preset_slug", "follows_preset", "enabled", "position",
    "owner_id", "created_at", "updated_at"
) VALUES (
    '00000000-0000-7000-8000-000000000426',
    'cursor',
    '__orbit_builtin_cursor_guard__',
    'claude',
    'http://127.0.0.1',
    'orbit-cursor-compatibility-guard',
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

-- Pin only what the fence depends on, exactly as 0080 and 0367 do: deployment-owned (no owner),
-- enabled (a disabled row makes an older replica fall back to Claude silently, the outcome this guards
-- against), and holding the invalid ciphertext. Cosmetic columns stay writable, so a later bulk UPDATE
-- of this table still works.
ALTER TABLE "model_provider"
    ADD CONSTRAINT "model_provider_builtin_cursor_guard_shape"
    CHECK (
        "slug" <> 'cursor'
        OR (
            "id" = '00000000-0000-7000-8000-000000000426'
            AND "owner_id" IS NULL
            AND "enabled" = true
            AND "api_key_enc" = 'orbit-cursor-compatibility-guard'
        )
    );

CREATE OR REPLACE FUNCTION protect_builtin_cursor_provider_guard()
RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'the cursor provider slug is reserved for a built-in engine'
        USING ERRCODE = '23514';
    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

-- Block only the two operations that would retire the fence: deleting the row, or renaming it off the
-- reserved slug. An UPDATE that leaves `slug = 'cursor'` still has to satisfy the CHECK above.
CREATE TRIGGER model_provider_builtin_cursor_guard_delete
BEFORE DELETE ON "model_provider"
FOR EACH ROW
WHEN (OLD."slug" = 'cursor')
EXECUTE FUNCTION protect_builtin_cursor_provider_guard();

CREATE TRIGGER model_provider_builtin_cursor_guard_rename
BEFORE UPDATE ON "model_provider"
FOR EACH ROW
WHEN (OLD."slug" = 'cursor' AND NEW."slug" IS DISTINCT FROM 'cursor')
EXECUTE FUNCTION protect_builtin_cursor_provider_guard();

-- 4. INVARIANT: acquiring a Cursor CLI session — PENDING -> RUNNING, or taking its inbox lease (a new
-- owner or a new generation) — requires BOTH the transaction's own declaration and the assigned
-- runner's positive heartbeat snapshot, as 0377 requires them for DeepSeek Harness. The session is
-- Cursor CLI's by its recorded engine, whatever credential it spends; a row without one, which an older
-- replica wrote, by its slug, which since the move above only the built-in can hold. A server terminal
-- revive's v5 handoff marker is not an acquisition, and clearing a lease never is, so cancellation,
-- release and maintenance still work. Returning NULL makes a legacy UPDATE ... RETURNING claim nothing,
-- and a lease write that does not land is refused by the route that checks it (0414).
CREATE OR REPLACE FUNCTION guard_cursor_runner_acquisition()
RETURNS trigger AS $$
BEGIN
    IF (
           (OLD."status" = 'PENDING' AND NEW."status" = 'RUNNING')
           OR (NEW."inbox_lease_owner" IS NOT NULL
               AND NEW."inbox_lease_owner" IS DISTINCT FROM OLD."inbox_lease_owner"
               AND NOT (OLD."status" IN ('SUCCEEDED', 'FAILED', 'CANCELLED')
                        AND NEW."status" = 'PENDING'
                        AND substring(NEW."inbox_lease_owner"::text, 15, 1) = '5'))
           OR (NEW."inbox_lease_generation" IS NOT NULL
               AND NEW."inbox_lease_generation" IS DISTINCT FROM OLD."inbox_lease_generation")
       )
       AND COALESCE(NEW."engine", NEW."provider") = 'cursor' THEN
        IF COALESCE(current_setting('orbit.runner_supports_cursor', true), '0') <> '1' THEN
            RETURN NULL;
        END IF;
        -- Keep the heartbeat declaration true through acquisition commit. The Session row is already
        -- locked, so never wait in the reverse runner -> session deletion order: a heartbeat or delete
        -- holding the runner makes this attempt skip and the poll retry.
        BEGIN
            PERFORM 1 FROM "runner" r
            WHERE r."id" = NEW."assigned_runner_id"
              AND r."owner_id" = NEW."owner_id"
              AND r."capabilities_reported_at" IS NOT NULL
              AND 'provider:cursor' = ANY(r."capabilities")
            FOR SHARE NOWAIT;
            IF NOT FOUND THEN RETURN NULL; END IF;
        EXCEPTION WHEN lock_not_available THEN
            RETURN NULL;
        END;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Named to sort after `session_acquisition_engine_guard` (0414): a table's BEFORE triggers fire in
-- name order, and that guard refuses an older replica's lease write outright, which this one would
-- only skip.
CREATE TRIGGER session_cursor_runner_acquisition_guard
BEFORE UPDATE OF "status", "inbox_lease_owner", "inbox_lease_generation" ON "session"
FOR EACH ROW EXECUTE FUNCTION guard_cursor_runner_acquisition();

COMMIT;
