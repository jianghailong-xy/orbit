-- Runner, Workspace and Provider availability changes are Project dirty signals too. Keep the
-- producer at the authoritative database row so heartbeats, the offline reaper, API writes and
-- rolling-version callers all get the same atomic business-write + outbox contract.

-- Every provider lookup below is Project- or Workspace-bounded. Give each of those bounded reads
-- its matching access path so "relevant Project" never degrades into scanning all Task/Session
-- history as the account grows.
CREATE INDEX "project_event_task_provider_idx"
    ON "task"("project_id", "provider")
    WHERE "project_id" IS NOT NULL AND "provider" IS NOT NULL;
CREATE INDEX "project_event_session_task_provider_idx"
    ON "session"("task_id", "provider")
    WHERE "task_id" IS NOT NULL;
CREATE INDEX "project_event_session_workspace_provider_seed_idx"
    ON "session"("workspace_id", "created_at" DESC, "id" DESC)
    WHERE "workspace_id" IS NOT NULL;

-- Built-in providers have no model_provider row. Their availability is scoped to one runner, so
-- give that (runner, provider) pair a stable UUID-shaped audit identity without inventing a row.
CREATE OR REPLACE FUNCTION "project_event_stable_uuid"(p_identity TEXT) RETURNS UUID
LANGUAGE sql IMMUTABLE STRICT AS $$
  SELECT (
    substr(md5(p_identity), 1, 8) || '-' ||
    substr(md5(p_identity), 9, 4) || '-' ||
    substr(md5(p_identity), 13, 4) || '-' ||
    substr(md5(p_identity), 17, 4) || '-' ||
    substr(md5(p_identity), 21, 12)
  )::uuid
$$;

-- The current schema represents an Agent with its workspace row and does not yet carry PAC's
-- project_workspace table. These are the three authoritative ways a Project currently names a
-- workspace: team membership, a filed Task's assignee, and the coordinator landing. Starting at
-- workspace.runner_id (indexed) keeps a machine event bounded to that machine's Project set.
CREATE OR REPLACE FUNCTION "project_event_runner_projects"(p_runner_id UUID)
RETURNS TABLE(project_id UUID)
LANGUAGE sql STABLE AS $$
  SELECT DISTINCT candidates.project_id
    FROM (
      SELECT pm."project_id"
        FROM "workspace" w
        JOIN "project_member" pm ON pm."agent_id" = w."id"
       WHERE w."runner_id" = p_runner_id
      UNION ALL
      SELECT t."project_id"
        FROM "workspace" w
        JOIN "task" t ON t."assignee_id" = w."id"
       WHERE w."runner_id" = p_runner_id AND t."project_id" IS NOT NULL
      UNION ALL
      SELECT p."id"
        FROM "workspace" w
        JOIN "project" p ON p."coordinator_workspace_id" = w."id"
       WHERE w."runner_id" = p_runner_id
    ) candidates
    JOIN "project" p ON p."id" = candidates.project_id
   WHERE p."coordinator_enabled" = true
$$;

CREATE OR REPLACE FUNCTION "project_event_workspace_projects"(p_workspace_id UUID)
RETURNS TABLE(project_id UUID)
LANGUAGE sql STABLE AS $$
  SELECT DISTINCT candidates.project_id
    FROM (
      SELECT pm."project_id"
        FROM "project_member" pm
       WHERE pm."agent_id" = p_workspace_id
      UNION ALL
      SELECT t."project_id"
        FROM "task" t
       WHERE t."assignee_id" = p_workspace_id AND t."project_id" IS NOT NULL
      UNION ALL
      SELECT p."id"
        FROM "project" p
       WHERE p."coordinator_workspace_id" = p_workspace_id
    ) candidates
    JOIN "project" p ON p."id" = candidates.project_id
   WHERE p."coordinator_enabled" = true
$$;

-- A Project uses a provider when it is explicitly pinned on one of its Tasks, is frozen on one
-- of the Project's Sessions, is the coordinator Session's provider, or is the current provider
-- seed of one of its member/assignee workspaces. The latest-session clauses mirror
-- lastProviderByWorkspace: historical providers are not candidates and must not wake a Project.
CREATE OR REPLACE FUNCTION "project_event_project_uses_provider"(
    p_project_id UUID,
    p_provider TEXT
) RETURNS BOOLEAN
LANGUAGE sql STABLE AS $$
  SELECT
    EXISTS (
      SELECT 1 FROM "task" t
       WHERE t."project_id" = p_project_id AND t."provider" = p_provider
    )
    OR EXISTS (
      SELECT 1
        FROM "session" s
        JOIN "task" t ON t."id" = s."task_id"
       WHERE t."project_id" = p_project_id AND s."provider" = p_provider
    )
    OR EXISTS (
      SELECT 1
        FROM "project" p
        JOIN "session" s ON s."id" = p."coordinator_session_id"
       WHERE p."id" = p_project_id AND s."provider" = p_provider
    )
    OR EXISTS (
      SELECT 1
        FROM "project_member" pm
        JOIN LATERAL (
          SELECT s."provider"
            FROM "session" s
           WHERE s."workspace_id" = pm."agent_id"
           ORDER BY s."created_at" DESC, s."id" DESC
           LIMIT 1
        ) latest ON latest."provider" = p_provider
       WHERE pm."project_id" = p_project_id
    )
    OR EXISTS (
      SELECT 1
        FROM "task" t
        JOIN LATERAL (
          SELECT s."provider"
            FROM "session" s
           WHERE s."workspace_id" = t."assignee_id"
           ORDER BY s."created_at" DESC, s."id" DESC
           LIMIT 1
        ) latest ON latest."provider" = p_provider
       WHERE t."project_id" = p_project_id
         AND t."provider" IS NULL
         AND t."assignee_id" IS NOT NULL
    )
$$;

CREATE OR REPLACE FUNCTION "project_event_fanout_runner"(
    p_runner_id UUID,
    p_kind TEXT,
    p_payload JSONB,
    p_dedupe_key TEXT
) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
    target RECORD;
BEGIN
    FOR target IN SELECT project_id FROM "project_event_runner_projects"(p_runner_id)
    LOOP
      PERFORM "project_event_enqueue_signal"(
        target.project_id,
        p_kind,
        'RUNNER',
        p_runner_id,
        COALESCE(p_payload, '{}'::jsonb) || jsonb_build_object('runnerId', p_runner_id),
        p_dedupe_key
      );
    END LOOP;
END;
$$;

-- Provider-specific capability changes (engine health, model catalog and runtime default) only
-- wake Projects that use that provider on this runner. Machine-wide capacity changes use the
-- unfiltered helper above.
CREATE OR REPLACE FUNCTION "project_event_fanout_runner_capability"(
    p_runner_id UUID,
    p_provider TEXT,
    p_payload JSONB
) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
    target RECORD;
BEGIN
    FOR target IN
      SELECT rp.project_id
        FROM "project_event_runner_projects"(p_runner_id) rp
       WHERE "project_event_project_uses_provider"(rp.project_id, p_provider)
    LOOP
      PERFORM "project_event_enqueue_signal"(
        target.project_id,
        'runner.capabilities_changed',
        'RUNNER',
        p_runner_id,
        COALESCE(p_payload, '{}'::jsonb) ||
          jsonb_build_object('runnerId', p_runner_id, 'provider', p_provider),
        'runner.capabilities_changed:' || p_runner_id::text || ':provider:' || p_provider
      );
    END LOOP;
END;
$$;

CREATE OR REPLACE FUNCTION "project_event_fanout_workspace"(
    p_workspace_id UUID,
    p_runner_id UUID,
    p_payload JSONB
) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
    target RECORD;
    source_id UUID := COALESCE(p_runner_id, p_workspace_id);
BEGIN
    FOR target IN SELECT project_id FROM "project_event_workspace_projects"(p_workspace_id)
    LOOP
      PERFORM "project_event_enqueue_signal"(
        target.project_id,
        'runner.capabilities_changed',
        'RUNNER',
        source_id,
        COALESCE(p_payload, '{}'::jsonb) || jsonb_build_object(
          'runnerId', p_runner_id,
          'workspaceId', p_workspace_id
        ),
        'runner.capabilities_changed:workspace:' || p_workspace_id::text
      );
    END LOOP;
END;
$$;

CREATE OR REPLACE FUNCTION "project_event_fanout_provider"(
    p_source_id UUID,
    p_provider TEXT,
    p_runner_id UUID,
    p_owner_id UUID,
    p_kind TEXT,
    p_payload JSONB
) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
    target RECORD;
BEGIN
    FOR target IN
      SELECT p."id" AS project_id
        FROM "project" p
       WHERE p."coordinator_enabled" = true
         AND (p_owner_id IS NULL OR p."owner_id" = p_owner_id)
         AND "project_event_project_uses_provider"(p."id", p_provider)
         AND (
           p_runner_id IS NULL
           OR p."id" IN (SELECT project_id FROM "project_event_runner_projects"(p_runner_id))
         )
    LOOP
      PERFORM "project_event_enqueue_signal"(
        target.project_id,
        p_kind,
        'PROVIDER',
        p_source_id,
        COALESCE(p_payload, '{}'::jsonb) || jsonb_build_object(
          'provider', p_provider,
          'runnerId', p_runner_id
        ),
        p_kind || ':' || p_source_id::text
      );
    END LOOP;
END;
$$;

-- A signed-out installed login engine is the only engine-health state the control plane treats as
-- definitively unavailable. Missing/not-installed/unknown remain "not proven unavailable", which
-- matches signedOutEngineRefusal and avoids turning old or partially probing runners into outages.
CREATE OR REPLACE FUNCTION "project_event_engine_state"(
    p_engines JSONB,
    p_provider TEXT
) RETURNS JSONB
LANGUAGE sql IMMUTABLE AS $$
  SELECT entry
    FROM jsonb_array_elements(
      CASE WHEN jsonb_typeof(p_engines) = 'array' THEN p_engines ELSE '[]'::jsonb END
    ) entry
   WHERE entry->>'engine' = p_provider
   LIMIT 1
$$;

CREATE OR REPLACE FUNCTION "project_event_engine_unavailable"(
    p_engines JSONB,
    p_provider TEXT
) RETURNS BOOLEAN
LANGUAGE sql IMMUTABLE AS $$
  SELECT COALESCE(
    "project_event_engine_state"(p_engines, p_provider)->>'installed' = 'true'
    AND "project_event_engine_state"(p_engines, p_provider)->>'auth' = 'no',
    false
  )
$$;

CREATE OR REPLACE FUNCTION "project_event_quota_window_exhausted"(
    p_window JSONB,
    p_at TIMESTAMPTZ
) RETURNS BOOLEAN
LANGUAGE plpgsql STABLE AS $$
DECLARE
    reset_at TIMESTAMPTZ;
BEGIN
    IF jsonb_typeof(p_window) <> 'object'
       OR jsonb_typeof(p_window->'utilization') <> 'number'
       OR (p_window->>'utilization')::numeric < 100
       OR NULLIF(p_window->>'resetsAt', '') IS NULL THEN
      RETURN false;
    END IF;
    BEGIN
      reset_at := (p_window->>'resetsAt')::timestamptz;
    EXCEPTION WHEN OTHERS THEN
      RETURN false;
    END;
    -- NULL asks what the snapshot itself claims, independent of wall time. The trigger uses that
    -- form for OLD vs NEW so crossing resetsAt without a new provider measurement cannot invent a
    -- repeated recovery on every heartbeat. A concrete time is the dispatch-compatible verdict.
    RETURN p_at IS NULL OR reset_at > p_at;
END;
$$;

CREATE OR REPLACE FUNCTION "project_event_quota_exhausted"(
    p_usage JSONB,
    p_provider TEXT,
    p_at TIMESTAMPTZ
) RETURNS BOOLEAN
LANGUAGE plpgsql STABLE AS $$
DECLARE
    snapshot JSONB;
    bucket JSONB;
    field TEXT;
BEGIN
    IF jsonb_typeof(p_usage) <> 'object' THEN
      RETURN false;
    END IF;
    IF jsonb_typeof(p_usage->p_provider) = 'object' THEN
      snapshot := p_usage->p_provider;
    ELSIF p_usage->>'provider' = p_provider THEN
      snapshot := p_usage;
    ELSE
      RETURN false;
    END IF;

    FOREACH field IN ARRAY ARRAY[
      'fiveHour', 'sevenDay', 'sevenDayOpus', 'sevenDaySonnet', 'primary', 'secondary'
    ]
    LOOP
      IF "project_event_quota_window_exhausted"(snapshot->field, p_at) THEN
        RETURN true;
      END IF;
    END LOOP;
    IF jsonb_typeof(snapshot->'rateLimits') = 'array' THEN
      FOR bucket IN SELECT value FROM jsonb_array_elements(snapshot->'rateLimits')
      LOOP
        IF "project_event_quota_window_exhausted"(bucket->'primary', p_at)
           OR "project_event_quota_window_exhausted"(bucket->'secondary', p_at) THEN
          RETURN true;
        END IF;
      END LOOP;
    END IF;
    RETURN false;
END;
$$;

CREATE OR REPLACE FUNCTION "project_runner_availability_event_source"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    provider TEXT;
    source_id UUID;
    old_engine_unavailable BOOLEAN;
    new_engine_unavailable BOOLEAN;
    old_quota_claimed BOOLEAN;
    new_quota_claimed BOOLEAN;
    new_quota_effective BOOLEAN;
    old_available BOOLEAN;
    new_available BOOLEAN;
    old_capability JSONB;
    new_capability JSONB;
    happened_at TIMESTAMPTZ := statement_timestamp();
BEGIN
    -- Offline is materialized by the Project availability reaper. Recovery is the next heartbeat,
    -- which writes ONLINE and last_heartbeat_at together. A timestamp-only heartbeat is no edge.
    IF NEW."status" = 'OFFLINE' AND OLD."status" <> 'OFFLINE' THEN
      PERFORM "project_event_fanout_runner"(
        NEW."id",
        'runner.offline',
        jsonb_build_object('from', OLD."status", 'to', NEW."status"),
        'runner.offline:' || NEW."id"::text
      );
    ELSIF NEW."status" <> 'OFFLINE' AND OLD."status" = 'OFFLINE' THEN
      PERFORM "project_event_fanout_runner"(
        NEW."id",
        'runner.online',
        jsonb_build_object('from', OLD."status", 'to', NEW."status"),
        'runner.online:' || NEW."id"::text
      );
    END IF;

    IF ROW(NEW."labels", NEW."max_concurrent", NEW."min_free_disk_mb", NEW."runs_as_root")
       IS DISTINCT FROM
       ROW(OLD."labels", OLD."max_concurrent", OLD."min_free_disk_mb", OLD."runs_as_root") THEN
      PERFORM "project_event_fanout_runner"(
        NEW."id",
        'runner.capabilities_changed',
        jsonb_build_object('scope', 'runner'),
        'runner.capabilities_changed:' || NEW."id"::text
      );
    END IF;

    FOREACH provider IN ARRAY ARRAY['claude', 'codex', 'kimi', 'opencode']
    LOOP
      old_capability := jsonb_build_object(
        'engine', "project_event_engine_state"(OLD."engines", provider),
        'models', OLD."model_catalog"->provider,
        'defaultModel', OLD."runtime_default_models"->provider
      );
      new_capability := jsonb_build_object(
        'engine', "project_event_engine_state"(NEW."engines", provider),
        'models', NEW."model_catalog"->provider,
        'defaultModel', NEW."runtime_default_models"->provider
      );
      IF new_capability IS DISTINCT FROM old_capability THEN
        PERFORM "project_event_fanout_runner_capability"(
          NEW."id", provider, jsonb_build_object('scope', 'provider')
        );
      END IF;

      old_engine_unavailable := "project_event_engine_unavailable"(OLD."engines", provider);
      new_engine_unavailable := "project_event_engine_unavailable"(NEW."engines", provider);
      old_quota_claimed := "project_event_quota_exhausted"(OLD."plan_usage", provider, NULL);
      new_quota_claimed := "project_event_quota_exhausted"(NEW."plan_usage", provider, NULL);
      new_quota_effective := "project_event_quota_exhausted"(
        NEW."plan_usage", provider, happened_at
      );
      old_available := NOT old_engine_unavailable AND NOT old_quota_claimed;
      new_available := NOT new_engine_unavailable AND NOT new_quota_claimed;
      source_id := "project_event_stable_uuid"(
        'runner:' || NEW."id"::text || ':provider:' || provider
      );

      IF new_quota_claimed AND NOT old_quota_claimed AND new_quota_effective THEN
        PERFORM "project_event_fanout_provider"(
          source_id, provider, NEW."id", NEW."owner_id", 'provider.quota_exhausted',
          jsonb_build_object('reason', 'quota')
        );
      ELSIF old_available AND NOT new_available THEN
        PERFORM "project_event_fanout_provider"(
          source_id, provider, NEW."id", NEW."owner_id", 'provider.unavailable',
          jsonb_build_object('reason', 'engine')
        );
      ELSIF NOT old_available AND new_available THEN
        PERFORM "project_event_fanout_provider"(
          source_id, provider, NEW."id", NEW."owner_id", 'provider.restored',
          jsonb_build_object('reason', 'availability')
        );
      END IF;
    END LOOP;
    RETURN NULL;
END;
$$;

CREATE TRIGGER "project_runner_availability_event_source"
AFTER UPDATE OF "status", "labels", "max_concurrent", "min_free_disk_mb", "plan_usage",
  "model_catalog", "runtime_default_models", "runs_as_root", "engines" ON "runner"
FOR EACH ROW EXECUTE FUNCTION "project_runner_availability_event_source"();

CREATE OR REPLACE FUNCTION "project_workspace_availability_event_source"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    old_floor BIGINT;
    new_floor BIGINT;
    old_available BOOLEAN;
    new_available BOOLEAN;
BEGIN
    SELECT CASE WHEN r."min_free_disk_mb" IS NULL THEN NULL
                ELSE r."min_free_disk_mb"::bigint * 1024 * 1024 END
      INTO old_floor FROM "runner" r WHERE r."id" = OLD."runner_id";
    SELECT CASE WHEN r."min_free_disk_mb" IS NULL THEN NULL
                ELSE r."min_free_disk_mb"::bigint * 1024 * 1024 END
      INTO new_floor FROM "runner" r WHERE r."id" = NEW."runner_id";

    -- Missing telemetry is deliberately fail-open, matching diskBelowFloor and workspace path
    -- preflight. Only a positive unavailable fact changes the effective state.
    old_available := OLD."enabled" AND OLD."deleted_at" IS NULL AND OLD."runner_id" IS NOT NULL
      AND OLD."work_dir_exists" IS DISTINCT FROM false
      AND (old_floor IS NULL OR OLD."work_dir_free_bytes" IS NULL
           OR OLD."work_dir_free_bytes" >= old_floor);
    new_available := NEW."enabled" AND NEW."deleted_at" IS NULL AND NEW."runner_id" IS NOT NULL
      AND NEW."work_dir_exists" IS DISTINCT FROM false
      AND (new_floor IS NULL OR NEW."work_dir_free_bytes" IS NULL
           OR NEW."work_dir_free_bytes" >= new_floor);

    IF old_available IS DISTINCT FROM new_available
       OR OLD."runner_id" IS DISTINCT FROM NEW."runner_id" THEN
      PERFORM "project_event_fanout_workspace"(
        NEW."id",
        COALESCE(NEW."runner_id", OLD."runner_id"),
        jsonb_build_object(
          'fromAvailable', old_available,
          'toAvailable', new_available,
          'fromRunnerId', OLD."runner_id",
          'toRunnerId', NEW."runner_id"
        )
      );
    END IF;
    RETURN NULL;
END;
$$;

CREATE TRIGGER "project_workspace_availability_event_source"
AFTER UPDATE OF "enabled", "deleted_at", "runner_id", "work_dir_exists", "work_dir_free_bytes"
ON "workspace"
FOR EACH ROW EXECUTE FUNCTION "project_workspace_availability_event_source"();

CREATE OR REPLACE FUNCTION "project_model_provider_availability_event_source"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    row_id UUID := CASE WHEN TG_OP = 'DELETE' THEN OLD."id" ELSE NEW."id" END;
    slug TEXT := CASE WHEN TG_OP = 'DELETE' THEN OLD."slug" ELSE NEW."slug" END;
    owner_id UUID := CASE WHEN TG_OP = 'DELETE' THEN OLD."owner_id" ELSE NEW."owner_id" END;
    event_kind TEXT;
BEGIN
    IF TG_OP = 'INSERT' AND NEW."enabled" THEN
      event_kind := 'provider.restored';
    ELSIF TG_OP = 'DELETE' AND OLD."enabled" THEN
      event_kind := 'provider.unavailable';
    ELSIF TG_OP = 'UPDATE' AND NEW."enabled" IS DISTINCT FROM OLD."enabled" THEN
      event_kind := CASE WHEN NEW."enabled" THEN 'provider.restored'
                         ELSE 'provider.unavailable' END;
    END IF;
    IF event_kind IS NOT NULL THEN
      PERFORM "project_event_fanout_provider"(
        row_id, slug, NULL, owner_id, event_kind,
        jsonb_build_object('reason', 'configured_provider_enabled', 'operation', TG_OP)
      );
    END IF;
    RETURN NULL;
END;
$$;

CREATE TRIGGER "project_model_provider_availability_event_source"
AFTER INSERT OR UPDATE OF "enabled" OR DELETE ON "model_provider"
FOR EACH ROW EXECUTE FUNCTION "project_model_provider_availability_event_source"();
