-- 0436 — landing sessions: the platform's own container for one piece of landing work
-- (docs/project-integration-line-contract.md §2.9 LS1–LS3, revision 12; design
-- docs/landing-session-design.md §0.1).
--
-- 0281 SAID "It is not a session: nothing here starts an engine". THAT HALF NO LONGER STANDS.
-- A `project_integration_job` is not a session, and it is not the unit a reader follows either:
-- each job is ONE ATTEMPT inside a landing session. The session is the address, the record and the
-- live state of one piece of landing work; the job rows are the generations of git and check work
-- that belong to it. That is why this migration adds the discriminator below, the subject table the
-- session is opened for, and the `landing_id` that groups a subject's attempts.
--
-- WHAT IT ADDS
-- ============
--   1. `session.kind` — the closed set CONVERSATION | LANDING, default CONVERSATION. The column is
--      added with a constant default (catalog-only on PostgreSQL 11+), and its CHECK is added
--      NOT VALID inside this migration's transaction; the VALIDATE runs AFTER this file's COMMIT, as
--      a statement of its own. That placement is the point: ADD COLUMN takes ACCESS EXCLUSIVE and
--      holds it until the transaction ends, so a VALIDATE inside it would scan the hottest table in
--      the schema under that lock; standing alone, its scan holds SHARE UPDATE EXCLUSIVE and blocks
--      no reads or writes. The FIELD is spelled `sessionKind` everywhere (Prisma included) because
--      web list rows already spread a `kind: 'session'` into their payload.
--   2. `project_landing` — the landing subject: project / owner / codebase, subject (TASK |
--      PROMOTION), the task or promotion it is keyed by, its episode, the pre-generated session id,
--      and how/when it settled. One unsettled TASK segment per task, one unsettled PROMOTION round
--      per project and codebase, both enforced by partial unique indexes. A rank-60 child row,
--      written in the enqueue transaction.
--   3. `project_integration_job.landing_id` — the subject an attempt belongs to. Written at INSERT
--      only, never updated, so 0281's terminal guard (J4) has nothing to refuse. No foreign key, for
--      0423 / 0424's reason: an attempt outlives the row it names, and the id is a history
--      reference. `task_id`, `promotion_id` and `session_id` on `project_landing` are the same kind
--      of reference and also carry no foreign key.
--   4. `(session_id, created_at)` on `project_integration_job`, the index the derived label on
--      GET /sessions/:id reads to find the newest generation of a source work session. A second
--      index over `(landing_id, created_at)` is what `ensure` and the settlement edge read.
--   5. `orbit` becomes a reserved provider slug, exactly as 0426 did for `cursor`: whatever holds it
--      today — a key, an account pool or a retired name — moves to the first free `orbit-N`, every
--      stored reference follows, and a built-in compatibility row then holds the name. The session
--      rows this migration's `kind` enables are written with `provider = 'orbit'`,
--      `provider_builtin = true` and no engine; the row keeps an older API replica from resolving a
--      user's key under that name during a rolling deploy, and the CHECK below keeps a new one from
--      writing it.
--
-- WHAT IT DOES NOT DO
-- ===================
-- It writes no LANDING session rows and no landing subjects. The enqueue paths create subjects in
-- their own transactions; the session row is inserted by `ensure` at the compensation points a
-- later task enables. Until then this deployment's only landing rows are subjects, and no engine
-- path can reach a LANDING conversation.
--
-- 0436: the highest number on main, every project/* and pushed orbit/* branch and every session
-- worktree was 0435 when this was written (2026-10-19).
BEGIN;

-- ---------------------------------------------------------------------------------------------
-- 1. `orbit` stops being an ordinary dispatch slug.
-- ---------------------------------------------------------------------------------------------
-- Until now `orbit` was what a key labelled "Orbit" (or a pool, or a retired name) got from
-- provider-slug.ts. A landing session stores exactly that string as its provider, so one namespace
-- must not be able to mean both. The move is 0426's, adapted: the holder takes the first `orbit-N`
-- free in all three tables, every stored dispatch reference follows it, and then the compatibility
-- row holds the name.
--
-- What stores a dispatch slug today — 0367's and 0426's list, checked again against this tree:
--   rewritten:
--     * `session.provider`, `task.provider`            — what a claim resolves, and a task's pin.
--     * `session.model`, `task.model`                  — the old OpenCode spelling names the key in
--                                                        the model (`provider` `opencode`,
--                                                        `orbit-orbit/<model>`).
--     * `task_route_decision.provider`, and `baseline.provider` inside it.
--     * `task_run_request.target`, BOUND rows.
--     * `workspace.provider_fallbacks`, `workspace.model_routing_providers`.
--     * `agent.default_provider`, `agent.provider_fallbacks`.
--     * `user.preferences.defaultModels`.
--     * `wiki_space.settings.maintenance.provider`.
--   left alone, as 0367 and 0426 left them: run_event payloads and conversation_turn content
--   (history), COMPLETED task_run_request targets, `session.resolution`,
--   `project_blocker.subject_id`, `task_route_decision.reasons` and `.model`, the models inside
--   `provider_fallbacks` (stored, never dispatched), pool members, keys and logins, and
--   `managed_runner.initial_provider`.
DO $$
DECLARE
    candidate TEXT := 'orbit-2';
    suffix INTEGER := 2;
BEGIN
    -- Candidate selection and the rewrite are one atomic view of dispatch identity: the three tables
    -- that hold slugs, and the two every dispatch resolves one from. Session before task, the
    -- canonical order (common/lock-order.ts).
    LOCK TABLE "model_provider", "provider_pool", "provider_slug_alias", "session", "task"
        IN SHARE ROW EXCLUSIVE MODE;

    WHILE EXISTS (SELECT 1 FROM "model_provider" WHERE "slug" = candidate)
       OR EXISTS (SELECT 1 FROM "provider_pool" WHERE "slug" = candidate)
       OR EXISTS (SELECT 1 FROM "provider_slug_alias" WHERE "slug" = candidate) LOOP
        suffix := suffix + 1;
        candidate := 'orbit-' || suffix;
    END LOOP;

    UPDATE "model_provider" SET "slug" = candidate WHERE "slug" = 'orbit';
    UPDATE "provider_pool" SET "slug" = candidate WHERE "slug" = 'orbit';
    UPDATE "provider_slug_alias" SET "slug" = candidate WHERE "slug" = 'orbit';

    UPDATE "session" SET "provider" = candidate WHERE "provider" = 'orbit';
    UPDATE "task" SET "provider" = candidate WHERE "provider" = 'orbit';
    UPDATE "session"
       SET "model" = 'orbit-' || candidate || substr("model", length('orbit-orbit') + 1)
     WHERE "provider" = 'opencode' AND starts_with("model", 'orbit-orbit/');
    UPDATE "task"
       SET "model" = 'orbit-' || candidate || substr("model", length('orbit-orbit') + 1)
     WHERE "provider" = 'opencode' AND starts_with("model", 'orbit-orbit/');

    UPDATE "task_route_decision" SET "provider" = candidate WHERE "provider" = 'orbit';
    UPDATE "task_route_decision"
       SET "baseline" = jsonb_set("baseline", '{provider}', to_jsonb(candidate))
     WHERE "baseline"->>'provider' = 'orbit';

    -- A bound plan, rewritten on jsonb's canonical text as 0367 and 0426 rewrote theirs.
    UPDATE "task_run_request"
       SET "target" = replace(
               replace("target"::text, '"provider": "orbit"', '"provider": "' || candidate || '"'),
               '"model": "orbit-orbit/',
               '"model": "orbit-' || candidate || '/'
           )::jsonb
     WHERE "status" = 'BOUND'
       AND (strpos("target"::text, '"provider": "orbit"') > 0
            OR strpos("target"::text, '"model": "orbit-orbit/') > 0);

    UPDATE "workspace" w
       SET "provider_fallbacks" = (
               SELECT jsonb_agg(
                          CASE WHEN f->>'provider' = 'orbit'
                               THEN jsonb_set(f, '{provider}', to_jsonb(candidate))
                               ELSE f
                          END
                          ORDER BY n)
                 FROM jsonb_array_elements(w."provider_fallbacks") WITH ORDINALITY AS t(f, n)
           )
     WHERE w."provider_fallbacks" @> '[{"provider": "orbit"}]'::jsonb;
    UPDATE "agent" a
       SET "provider_fallbacks" = (
               SELECT jsonb_agg(
                          CASE WHEN f->>'provider' = 'orbit'
                               THEN jsonb_set(f, '{provider}', to_jsonb(candidate))
                               ELSE f
                          END
                          ORDER BY n)
                 FROM jsonb_array_elements(a."provider_fallbacks") WITH ORDINALITY AS t(f, n)
           )
     WHERE a."provider_fallbacks" @> '[{"provider": "orbit"}]'::jsonb;
    UPDATE "agent" SET "default_provider" = candidate WHERE "default_provider" = 'orbit';

    UPDATE "workspace"
       SET "model_routing_providers" = array_replace("model_routing_providers", 'orbit', candidate)
     WHERE 'orbit' = ANY("model_routing_providers");

    -- The last model picked for the provider travels with it, under its new key.
    UPDATE "user" u
       SET "preferences" = jsonb_set(u."preferences", '{defaultModels}', moved."models")
      FROM (
        SELECT owner."id", jsonb_object_agg(e."key", e."value" ORDER BY e."moved", e."key") AS "models"
          FROM "user" owner
          CROSS JOIN LATERAL (
            SELECT
              CASE
                WHEN d.key = 'orbit' THEN candidate
                WHEN d.key = 'opencode/orbit' THEN 'opencode/' || candidate
                WHEN d.key ~ '^[^:/]+:orbit$' THEN split_part(d.key, ':', 1) || ':' || candidate
                ELSE d.key
              END AS "key",
              CASE
                WHEN d.key IN ('opencode', 'opencode/orbit')
                 AND jsonb_typeof(d.value) = 'string'
                 AND starts_with(d.value #>> '{}', 'orbit-orbit/')
                  THEN to_jsonb('orbit-' || candidate || substr(d.value #>> '{}', length('orbit-orbit') + 1))
                ELSE d.value
              END AS "value",
              (d.key = 'orbit' OR d.key = 'opencode/orbit' OR d.key ~ '^[^:/]+:orbit$') AS "moved"
            FROM jsonb_each(owner."preferences"->'defaultModels') d
          ) e
         WHERE jsonb_typeof(owner."preferences"->'defaultModels') = 'object'
           AND EXISTS (
             SELECT 1 FROM jsonb_each(owner."preferences"->'defaultModels') d
              WHERE d.key = 'orbit' OR d.key = 'opencode/orbit' OR d.key ~ '^[^:/]+:orbit$'
                 OR (d.key = 'opencode' AND jsonb_typeof(d.value) = 'string'
                     AND starts_with(d.value #>> '{}', 'orbit-orbit/'))
           )
         GROUP BY owner."id"
      ) moved
     WHERE u."id" = moved."id";

    UPDATE "wiki_space"
       SET "settings" = jsonb_set("settings", '{maintenance,provider}', to_jsonb(candidate))
     WHERE "settings"->'maintenance'->>'provider' = 'orbit';
END $$;

-- The compatibility fence at an older control plane's provider lookup. `runtime` is `claude`
-- because that is what an older replica would have run it as; it never gets that far, since the key
-- cannot be decrypted. Inserted after the move, so the dispatch-slug guard finds nothing else
-- holding the name.
INSERT INTO "model_provider" (
    "id", "slug", "label", "runtime", "base_url", "api_key_enc", "models",
    "default_model", "preset_slug", "follows_preset", "enabled", "position",
    "owner_id", "created_at", "updated_at"
) VALUES (
    '00000000-0000-7000-8000-000000000436',
    'orbit',
    '__orbit_builtin_orbit_guard__',
    'claude',
    'http://127.0.0.1',
    'orbit-provider-compatibility-guard',
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

-- Pin only what the fence depends on, exactly as 0080, 0367 and 0426 do.
ALTER TABLE "model_provider"
    ADD CONSTRAINT "model_provider_builtin_orbit_guard_shape"
    CHECK (
        "slug" <> 'orbit'
        OR (
            "id" = '00000000-0000-7000-8000-000000000436'
            AND "owner_id" IS NULL
            AND "enabled" = true
            AND "api_key_enc" = 'orbit-provider-compatibility-guard'
        )
    );

CREATE OR REPLACE FUNCTION protect_builtin_orbit_provider_guard()
RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'the orbit provider slug is reserved for the platform'
        USING ERRCODE = '23514';
    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER model_provider_builtin_orbit_guard_delete
BEFORE DELETE ON "model_provider"
FOR EACH ROW
WHEN (OLD."slug" = 'orbit')
EXECUTE FUNCTION protect_builtin_orbit_provider_guard();

CREATE TRIGGER model_provider_builtin_orbit_guard_rename
BEFORE UPDATE ON "model_provider"
FOR EACH ROW
WHEN (OLD."slug" = 'orbit' AND NEW."slug" IS DISTINCT FROM 'orbit')
EXECUTE FUNCTION protect_builtin_orbit_provider_guard();

-- ---------------------------------------------------------------------------------------------
-- 2. The session discriminator.
-- ---------------------------------------------------------------------------------------------
-- A constant default is catalog-only: no rewrite, no scan. The CHECK is added NOT VALID here, so
-- this transaction's ACCESS EXCLUSIVE lock (held from ADD COLUMN to COMMIT) covers only catalog
-- changes; the VALIDATE is the statement after this file's COMMIT, in its own transaction.
ALTER TABLE "session" ADD COLUMN "kind" TEXT NOT NULL DEFAULT 'CONVERSATION';
ALTER TABLE "session" ADD CONSTRAINT "session_kind_check"
  CHECK ("kind" IN ('CONVERSATION', 'LANDING')) NOT VALID;

-- ---------------------------------------------------------------------------------------------
-- 3. The landing subject.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE "project_landing" (
    "id"           UUID          NOT NULL,
    "project_id"   UUID          NOT NULL,
    "owner_id"     UUID          NOT NULL,
    "codebase_id"  UUID          NOT NULL,
    "subject"      TEXT          NOT NULL,
    "task_id"      UUID,
    "promotion_id" UUID,
    "episode"      INTEGER       NOT NULL DEFAULT 1,
    "session_id"   UUID          NOT NULL,
    "opened_at"    TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "settled_at"   TIMESTAMPTZ(3),
    "settled_as"   TEXT,
    CONSTRAINT "project_landing_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "project_landing_project_fk"
      FOREIGN KEY ("project_id", "owner_id") REFERENCES "project"("id", "owner_id") ON DELETE CASCADE,
    CONSTRAINT "project_landing_codebase_fk"
      FOREIGN KEY ("codebase_id") REFERENCES "project_codebase"("id") ON DELETE CASCADE,
    CONSTRAINT "project_landing_subject_check" CHECK ("subject" IN ('TASK', 'PROMOTION')),
    CONSTRAINT "project_landing_settled_as_check"
      CHECK ("settled_as" IS NULL OR "settled_as" IN
             ('LANDED', 'ALREADY_LANDED', 'NOTHING_TO_LAND', 'MERGED',
              'HANDLED', 'DECLINED', 'CANCELLED', 'DELETED')),
    CONSTRAINT "project_landing_subject_shape_check"
      CHECK ((("subject" = 'TASK') AND "task_id" IS NOT NULL AND "promotion_id" IS NULL)
          OR (("subject" = 'PROMOTION') AND "promotion_id" IS NOT NULL AND "task_id" IS NULL)),
    CONSTRAINT "project_landing_settled_pair_check"
      CHECK (("settled_at" IS NULL) = ("settled_as" IS NULL)),
    CONSTRAINT "project_landing_episode_check" CHECK ("episode" >= 1)
);

-- One unsettled TASK segment per task, and one unsettled PROMOTION round per line. The partial
-- indexes are what make "open or join" a fact of the database rather than a read-then-write.
CREATE UNIQUE INDEX "project_landing_open_task_key"
    ON "project_landing" ("task_id")
 WHERE "subject" = 'TASK' AND "settled_at" IS NULL;
CREATE UNIQUE INDEX "project_landing_open_round_key"
    ON "project_landing" ("project_id", "codebase_id")
 WHERE "subject" = 'PROMOTION' AND "settled_at" IS NULL;

-- The pre-generated id addresses a landing before its session row exists (LS1), and the newest
-- round/generation reads go through these.
CREATE UNIQUE INDEX "project_landing_session_key" ON "project_landing" ("session_id");
CREATE INDEX "project_landing_task_idx" ON "project_landing" ("task_id");
CREATE INDEX "project_landing_promotion_idx" ON "project_landing" ("promotion_id");
CREATE INDEX "project_landing_project_idx" ON "project_landing" ("project_id", "opened_at");

-- ---------------------------------------------------------------------------------------------
-- 4. The attempt's link to its subject.
-- ---------------------------------------------------------------------------------------------
ALTER TABLE "project_integration_job" ADD COLUMN "landing_id" UUID;
CREATE INDEX "project_integration_job_session_created_idx"
    ON "project_integration_job" ("session_id", "created_at");
CREATE INDEX "project_integration_job_landing_idx"
    ON "project_integration_job" ("landing_id", "created_at");

COMMIT;

-- The discriminator's scan, deliberately OUTSIDE the transaction above: ADD COLUMN's ACCESS
-- EXCLUSIVE lock ended at the COMMIT, so this VALIDATE takes only its own SHARE UPDATE EXCLUSIVE
-- and blocks no reads or writes. Running it inside the transaction would have scanned the hottest
-- table in the schema while still holding ACCESS EXCLUSIVE.
ALTER TABLE "session" VALIDATE CONSTRAINT "session_kind_check";
