-- Completion ACK removal.
--
-- 0201-0204 built a canonical completion-ACK obligation protocol, a persistent coordinator that
-- delivered it, a delivery-liveness auditor and an owner-decision binding: 7,146 lines of SQL over
-- 12 tables, 4 views and 55 functions. The four Compose sidecars that were its only writers were
-- removed; `completion_ack_active_obligation` has been empty since, both coordinator processes
-- reported `tenantCount: 0, reconciled: 0, attempted: 0` and the watchdog reported
-- `activeObligationCount: 0`. This migration deletes the protocol.
--
-- Five kept subsystems borrowed pieces of it and are rewired first, before anything is dropped:
--
--   1. `run_event_completion_ack_ingestion_guard` is NOT a completion-ACK guard. Despite its name
--      it owns `run_event.ingested_at` on INSERT and makes the ingestion provenance columns
--      immutable on UPDATE -- an ordinary run_event write path. It is re-created verbatim as
--      `run_event_ingestion_provenance_guard`; behaviour is byte-identical, only the name loses a
--      protocol it never belonged to.
--   2. `executable_runtime_*` (the EXECUTABLE acceptance liveness wall, created alongside the
--      protocol in 0202) called two completion-ACK helpers. They are re-created under neutral
--      names -- `outcome_uuid_from_digest` and `executable_runtime_sanitize_metadata` -- and the
--      five functions that call them are re-created with identical bodies.
--   3. `outcome_projection.read_surface` routed public reads through
--      `completion_ack_operational_read_surface`. That routing is preserved as
--      `outcome_operational_read_surface`, minus the completion-ACK overlay and minus the
--      no_data_found fallback that only an ACTIVE completion-ACK fact could ever activate.
--   4. `project_canonical_done_gate` kept its 0201 shape -- projection-integrity body first, then
--      operational overlays -- and keeps it here. Only the completion-ACK overlay and the
--      completion-ACK-gated `no_data_found` swallow are removed, so a missing canonical projection
--      raises again exactly as it did before 0201.
--   5. `outcome_register_coordinator_obligation`, `outcome_reconcile_active_obligations` and
--      `outcome_record_coordinator_result` were 0202 wrappers that delegated every CANONICAL and
--      EXECUTOR obligation to the 0198 implementation and handled COMPLETION_ACK themselves. The
--      wrappers are dropped and the `_0198` implementations are renamed back.
--
-- Deliberately NOT removed, because they are shared history on tables that stay rather than
-- completion-ACK objects: the `COMPLETION_ACK`/`COMPLETION_ACK_STALE` members of
-- `outcome_coordinator_obligation.source_type`, `project_blocker.kind`,
-- `project_coordinator_wake.event` and `executable_runtime_expectation.component` CHECK
-- constraints. Live rows still carry those values (one RESOLVED coordinator obligation, one
-- resolved project blocker, one opened wake, 27 runtime expectations), so narrowing the
-- constraints would either fail on real data or rewrite a subsystem this task must not touch.
-- Nothing can write them any more; they are unreachable, not referenced.

-- ---------------------------------------------------------------------------------------------
-- 1. run_event ingestion guard: same behaviour, name that no longer claims a protocol.
-- ---------------------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION run_event_ingestion_provenance_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.ingested_at := clock_timestamp();
    RETURN NEW;
  END IF;
  IF NEW.ingested_at IS DISTINCT FROM OLD.ingested_at THEN
    RAISE EXCEPTION 'RUN_EVENT_INGESTED_AT_DB_OWNED:%', OLD.id
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  IF NEW.ingested_by_runner_id IS DISTINCT FROM OLD.ingested_by_runner_id
     OR NEW.ingested_under_lease_generation
        IS DISTINCT FROM OLD.ingested_under_lease_generation THEN
    RAISE EXCEPTION 'RUN_EVENT_INGESTION_PROVENANCE_IMMUTABLE:%', OLD.id
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER run_event_completion_ack_ingestion_guard ON run_event;
DROP FUNCTION run_event_completion_ack_ingestion_guard();

CREATE TRIGGER run_event_ingestion_provenance_guard
  BEFORE INSERT OR UPDATE OF ingested_at, ingested_by_runner_id, ingested_under_lease_generation
  ON run_event
  FOR EACH ROW EXECUTE FUNCTION run_event_ingestion_provenance_guard();

COMMENT ON FUNCTION run_event_ingestion_provenance_guard() IS
  'The database owns run_event.ingested_at and the ingestion provenance columns. Introduced by 0201 under a completion-ACK name; the behaviour was never part of that protocol.';

-- ---------------------------------------------------------------------------------------------
-- 2. executable_runtime_*: neutral helpers, then the five bodies that call them.
-- ---------------------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION outcome_uuid_from_digest(p_digest text)
RETURNS uuid LANGUAGE sql IMMUTABLE PARALLEL SAFE STRICT AS $$
  SELECT (
    substr(p_digest, 1, 8) || '-' || substr(p_digest, 9, 4) || '-5' ||
    substr(p_digest, 14, 3) || '-a' || substr(p_digest, 18, 3) || '-' ||
    substr(p_digest, 21, 12)
  )::uuid
$$;

CREATE OR REPLACE FUNCTION executable_runtime_sanitize_metadata(p_metadata jsonb)
RETURNS jsonb LANGUAGE plpgsql IMMUTABLE SECURITY DEFINER
  SET search_path = pg_catalog, public, outcome_watchdog AS $$
DECLARE
  v_sanitized jsonb;
BEGIN
  IF p_metadata IS NULL OR jsonb_typeof(p_metadata) <> 'object'
     OR octet_length(p_metadata::text) > 16384 THEN
    RAISE EXCEPTION 'EXECUTABLE_RUNTIME_METADATA_INVALID'
      USING ERRCODE = 'program_limit_exceeded';
  END IF;
  v_sanitized := outcome_watchdog.sanitize_payload(p_metadata);
  IF octet_length(v_sanitized::text) > 8192 THEN
    RAISE EXCEPTION 'EXECUTABLE_RUNTIME_METADATA_TOO_LARGE'
      USING ERRCODE = 'program_limit_exceeded';
  END IF;
  RETURN v_sanitized;
END;
$$;

CREATE OR REPLACE FUNCTION public.executable_runtime_expectation_insert_guard()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE
  v_metadata jsonb;
  v_digest char(64);
  v_now timestamptz := clock_timestamp();
BEGIN
  v_metadata := executable_runtime_sanitize_metadata(NEW.metadata);
  v_digest := outcome_sha256_json(jsonb_build_array(
    'executable-runtime-expectation:v1', NEW.component, NEW.instance_id,
    NEW.generation::text, NEW.expected_source_sha,
    NEW.module_graph_digest::text, NEW.startup_grace_seconds, v_metadata
  ));
  IF NEW.metadata IS DISTINCT FROM v_metadata
     OR NEW.metadata_digest IS DISTINCT FROM outcome_sha256_json(v_metadata)
     OR NEW.expectation_digest IS DISTINCT FROM v_digest THEN
    RAISE EXCEPTION 'EXECUTABLE_RUNTIME_EXPECTATION_IDENTITY_INVALID:%', NEW.generation
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  NEW.activated_at := v_now;
  NEW.startup_deadline_at := v_now + make_interval(secs => NEW.startup_grace_seconds);
  NEW.recorded_at := v_now;
  RETURN NEW;
END;
$function$

;

CREATE OR REPLACE FUNCTION public.executable_runtime_expectation_event_insert_guard()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE
  v_expectation executable_runtime_expectation%ROWTYPE;
  v_digest char(64);
BEGIN
  SELECT * INTO v_expectation FROM executable_runtime_expectation expectation
   WHERE expectation.generation = NEW.generation FOR KEY SHARE;
  IF NOT FOUND OR v_expectation.component IS DISTINCT FROM NEW.component
     OR v_expectation.instance_id IS DISTINCT FROM NEW.instance_id THEN
    RAISE EXCEPTION 'EXECUTABLE_RUNTIME_EXPECTATION_EVENT_SCOPE_INVALID:%', NEW.generation
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.kind = 'ACTIVATED' AND EXISTS (
    SELECT 1 FROM executable_runtime_expectation_event event
     WHERE event.generation = NEW.generation
  ) THEN
    RAISE EXCEPTION 'EXECUTABLE_RUNTIME_EXPECTATION_REACTIVATION_FORBIDDEN:%', NEW.generation
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  IF NEW.kind IN ('SUPERSEDED', 'RETIRED') AND NOT EXISTS (
    SELECT 1 FROM executable_runtime_expectation_event event
     WHERE event.generation = NEW.generation AND event.kind = 'ACTIVATED'
  ) THEN
    RAISE EXCEPTION 'EXECUTABLE_RUNTIME_EXPECTATION_NOT_ACTIVE:%', NEW.generation
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  v_digest := outcome_sha256_json(jsonb_build_array(
    'executable-runtime-expectation-event:v1', NEW.generation::text,
    NEW.component, NEW.instance_id, NEW.kind, NEW.reason_code,
    NEW.idempotency_key
  ));
  IF NEW.event_id IS DISTINCT FROM outcome_uuid_from_digest(v_digest::text)
     OR NEW.event_digest IS DISTINCT FROM v_digest THEN
    RAISE EXCEPTION 'EXECUTABLE_RUNTIME_EXPECTATION_EVENT_IDENTITY_INVALID:%', NEW.event_id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  NEW.recorded_at := clock_timestamp();
  RETURN NEW;
END;
$function$

;

CREATE OR REPLACE FUNCTION public.executable_runtime_dead_man_expectation_guard()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE
  v_expectation executable_runtime_expectation%ROWTYPE;
  v_heartbeat executable_runtime_heartbeat%ROWTYPE;
  v_digest char(64);
BEGIN
  IF NEW.expectation_generation IS NULL THEN RETURN NEW; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(
    concat('runtime-expectation-observation:v1:',
      NEW.expectation_generation::text), 0
  ));
  SELECT * INTO v_expectation FROM executable_runtime_expectation expectation
   WHERE expectation.generation = NEW.expectation_generation FOR KEY SHARE;
  IF NOT FOUND OR v_expectation.component IS DISTINCT FROM NEW.component
     OR v_expectation.instance_id IS DISTINCT FROM NEW.instance_id
     OR v_expectation.expectation_digest IS DISTINCT FROM NEW.expectation_digest THEN
    RAISE EXCEPTION 'EXECUTABLE_DEAD_MAN_EXPECTATION_SCOPE_INVALID:%',
      NEW.expectation_generation USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.kind = 'WATCHDOG_MISSING' THEN
    IF clock_timestamp() <= v_expectation.startup_deadline_at THEN
      RAISE EXCEPTION 'EXECUTABLE_DEAD_MAN_STARTUP_GRACE_ACTIVE:%',
        NEW.expectation_generation USING ERRCODE = 'object_not_in_prerequisite_state';
    END IF;
    IF NEW.heartbeat_digest IS NOT NULL OR EXISTS (
      SELECT 1 FROM executable_runtime_heartbeat heartbeat
       WHERE heartbeat.expectation_generation = NEW.expectation_generation
    ) THEN
      RAISE EXCEPTION 'EXECUTABLE_DEAD_MAN_MISSING_HAS_HEARTBEAT:%',
        NEW.expectation_generation USING ERRCODE = 'object_not_in_prerequisite_state';
    END IF;
    NEW.deadline_at := v_expectation.startup_deadline_at;
  ELSE
    SELECT * INTO v_heartbeat FROM executable_runtime_heartbeat heartbeat
     WHERE heartbeat.expectation_generation = NEW.expectation_generation
     ORDER BY heartbeat.sequence DESC, heartbeat.ingested_at DESC,
              heartbeat.id DESC LIMIT 1;
    IF NOT FOUND OR v_heartbeat.heartbeat_digest IS DISTINCT FROM NEW.heartbeat_digest THEN
      RAISE EXCEPTION 'EXECUTABLE_DEAD_MAN_HEARTBEAT_NOT_BOUND:%', NEW.heartbeat_digest
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    IF NEW.kind = 'WATCHDOG_STALE' AND clock_timestamp() <= v_heartbeat.deadline_at THEN
      RAISE EXCEPTION 'EXECUTABLE_DEAD_MAN_HEARTBEAT_NOT_STALE:%', NEW.heartbeat_digest
        USING ERRCODE = 'object_not_in_prerequisite_state';
    ELSIF NEW.kind = 'WATCHDOG_RECOVERED' AND clock_timestamp() > v_heartbeat.deadline_at THEN
      RAISE EXCEPTION 'EXECUTABLE_DEAD_MAN_HEARTBEAT_NOT_HEALTHY:%', NEW.heartbeat_digest
        USING ERRCODE = 'object_not_in_prerequisite_state';
    END IF;
    NEW.deadline_at := v_heartbeat.deadline_at;
  END IF;
  NEW.checked_at := clock_timestamp();
  NEW.created_at := NEW.checked_at;
  v_digest := outcome_sha256_json(jsonb_build_array(
    'executable-runtime-expectation-observation:v1',
    NEW.expectation_generation::text, NEW.component, NEW.instance_id,
    NEW.kind, NEW.heartbeat_digest::text, NEW.source_sha,
    NEW.expectation_observation_key
  ));
  NEW.event_digest := v_digest;
  NEW.id := outcome_uuid_from_digest(v_digest::text);
  RETURN NEW;
END;
$function$

;

CREATE OR REPLACE FUNCTION public.executable_runtime_expect_generation(p_component text, p_instance_id text, p_generation uuid, p_expected_source_sha text, p_module_graph_digest text, p_startup_grace_seconds integer, p_idempotency_key text, p_metadata jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'outcome_watchdog'
AS $function$
DECLARE
  v_existing executable_runtime_expectation%ROWTYPE;
  v_prior executable_runtime_expectation%ROWTYPE;
  v_metadata jsonb;
  v_metadata_digest char(64);
  v_digest char(64);
  v_event_digest char(64);
  v_recorded_at timestamptz;
BEGIN
  IF p_component NOT IN (
       'outcome-coordinator', 'outcome-watchdog', 'completion-ack-watchdog'
     ) OR length(btrim(COALESCE(p_instance_id, ''))) NOT BETWEEN 1 AND 512
     OR p_generation IS NULL OR COALESCE(p_expected_source_sha, '') !~ '^[0-9a-f]{40}$'
     OR NOT COALESCE(outcome_valid_digest(p_module_graph_digest), false)
     OR p_startup_grace_seconds NOT BETWEEN 1 AND 3600
     OR length(btrim(COALESCE(p_idempotency_key, ''))) NOT BETWEEN 1 AND 1024 THEN
    RAISE EXCEPTION 'EXECUTABLE_RUNTIME_EXPECTATION_ARGUMENT_INVALID'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(
    concat('runtime-expectation:v1:', p_component, ':', p_instance_id), 0
  ));
  v_metadata := executable_runtime_sanitize_metadata(COALESCE(p_metadata, '{}'::jsonb));
  v_metadata_digest := outcome_sha256_json(v_metadata);
  v_digest := outcome_sha256_json(jsonb_build_array(
    'executable-runtime-expectation:v1', p_component, p_instance_id,
    p_generation::text, p_expected_source_sha, p_module_graph_digest,
    p_startup_grace_seconds, v_metadata
  ));
  SELECT * INTO v_existing FROM executable_runtime_expectation expectation
   WHERE expectation.idempotency_key = p_idempotency_key
      OR expectation.generation = p_generation
   ORDER BY (expectation.idempotency_key = p_idempotency_key) DESC LIMIT 1;
  IF FOUND THEN
    IF v_existing.generation IS DISTINCT FROM p_generation
       OR v_existing.component IS DISTINCT FROM p_component
       OR v_existing.instance_id IS DISTINCT FROM p_instance_id
       OR v_existing.expectation_digest IS DISTINCT FROM v_digest THEN
      RAISE EXCEPTION 'EXECUTABLE_RUNTIME_EXPECTATION_IDEMPOTENCY_CONFLICT'
        USING ERRCODE = 'unique_violation';
    END IF;
    RETURN jsonb_build_object(
      'generation', v_existing.generation::text,
      'component', v_existing.component,
      'instanceId', v_existing.instance_id,
      'expectationDigest', v_existing.expectation_digest::text,
      'startupDeadlineAt', v_existing.startup_deadline_at,
      'replayed', true
    );
  END IF;
  -- Capture the deployment admission clock once.  The insert guard independently
  -- enforces DB-owned timestamps, but the writer must still present the correct
  -- grace interval rather than relying on that guard to repair its semantics.
  v_recorded_at := clock_timestamp();
  INSERT INTO executable_runtime_expectation(
    generation, component, instance_id, expected_source_sha, module_graph_digest,
    startup_grace_seconds, idempotency_key, metadata, metadata_digest,
    expectation_digest, activated_at, startup_deadline_at, recorded_at
  ) VALUES (
    p_generation, p_component, p_instance_id, p_expected_source_sha,
    p_module_graph_digest::char(64), p_startup_grace_seconds, p_idempotency_key,
    v_metadata, v_metadata_digest, v_digest, v_recorded_at,
    v_recorded_at + make_interval(secs => p_startup_grace_seconds),
    v_recorded_at
  );
  SELECT * INTO STRICT v_existing FROM executable_runtime_expectation expectation
   WHERE expectation.generation = p_generation;

  FOR v_prior IN
    SELECT active.* FROM executable_runtime_active_expectation active
     WHERE active.component = p_component AND active.instance_id = p_instance_id
       AND active.generation <> p_generation
     ORDER BY active.activated_at, active.generation
  LOOP
    v_event_digest := outcome_sha256_json(jsonb_build_array(
      'executable-runtime-expectation-event:v1', v_prior.generation::text,
      v_prior.component, v_prior.instance_id, 'SUPERSEDED',
      'REPLACED_BY_DEPLOYMENT_GENERATION',
      'runtime-expectation:superseded-by:' || p_generation::text
    ));
    INSERT INTO executable_runtime_expectation_event(
      event_id, generation, component, instance_id, kind, reason_code,
      idempotency_key, event_digest
    ) VALUES (
      outcome_uuid_from_digest(v_event_digest::text), v_prior.generation,
      v_prior.component, v_prior.instance_id, 'SUPERSEDED',
      'REPLACED_BY_DEPLOYMENT_GENERATION',
      'runtime-expectation:superseded-by:' || p_generation::text,
      v_event_digest
    ) ON CONFLICT (generation) WHERE kind IN ('SUPERSEDED', 'RETIRED') DO NOTHING;
  END LOOP;
  v_event_digest := outcome_sha256_json(jsonb_build_array(
    'executable-runtime-expectation-event:v1', p_generation::text,
    p_component, p_instance_id, 'ACTIVATED', 'DEPLOYMENT_EXPECTED',
    'runtime-expectation:activated:' || p_generation::text
  ));
  INSERT INTO executable_runtime_expectation_event(
    event_id, generation, component, instance_id, kind, reason_code,
    idempotency_key, event_digest
  ) VALUES (
    outcome_uuid_from_digest(v_event_digest::text), p_generation,
    p_component, p_instance_id, 'ACTIVATED', 'DEPLOYMENT_EXPECTED',
    'runtime-expectation:activated:' || p_generation::text, v_event_digest
  );
  RETURN jsonb_build_object(
    'generation', v_existing.generation::text,
    'component', v_existing.component,
    'instanceId', v_existing.instance_id,
    'expectationDigest', v_existing.expectation_digest::text,
    'startupDeadlineAt', v_existing.startup_deadline_at,
    'replayed', false
  );
END;
$function$

;

CREATE OR REPLACE FUNCTION public.executable_runtime_retire_expectation(p_component text, p_instance_id text, p_generation uuid, p_reason_code text, p_idempotency_key text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE
  v_expectation executable_runtime_expectation%ROWTYPE;
  v_event executable_runtime_expectation_event%ROWTYPE;
  v_digest char(64);
  v_rows bigint;
BEGIN
  IF btrim(COALESCE(p_reason_code, '')) = '' OR btrim(COALESCE(p_idempotency_key, '')) = '' THEN
    RAISE EXCEPTION 'EXECUTABLE_RUNTIME_EXPECTATION_RETIRE_ARGUMENT_INVALID'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(
    concat('runtime-expectation:v1:', p_component, ':', p_instance_id), 0
  ));
  SELECT * INTO v_expectation FROM executable_runtime_expectation expectation
   WHERE expectation.generation = p_generation
     AND expectation.component = p_component
     AND expectation.instance_id = p_instance_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('retired', false, 'reason', 'EXPECTATION_NOT_FOUND');
  END IF;
  v_digest := outcome_sha256_json(jsonb_build_array(
    'executable-runtime-expectation-event:v1', p_generation::text,
    p_component, p_instance_id, 'RETIRED', p_reason_code, p_idempotency_key
  ));
  INSERT INTO executable_runtime_expectation_event(
    event_id, generation, component, instance_id, kind, reason_code,
    idempotency_key, event_digest
  ) VALUES (
    outcome_uuid_from_digest(v_digest::text), p_generation,
    p_component, p_instance_id, 'RETIRED', p_reason_code,
    p_idempotency_key, v_digest
  ) ON CONFLICT (generation) WHERE kind IN ('SUPERSEDED', 'RETIRED') DO NOTHING;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  SELECT * INTO STRICT v_event FROM executable_runtime_expectation_event event
   WHERE event.generation = p_generation
     AND event.kind IN ('SUPERSEDED', 'RETIRED');
  IF v_rows = 0 AND (v_event.kind <> 'RETIRED'
      OR v_event.idempotency_key <> p_idempotency_key
      OR v_event.event_digest IS DISTINCT FROM v_digest) THEN
    RAISE EXCEPTION 'EXECUTABLE_RUNTIME_EXPECTATION_ALREADY_TERMINAL'
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  RETURN jsonb_build_object(
    'generation', p_generation::text,
    'retired', v_event.kind = 'RETIRED',
    'state', v_event.kind,
    'replayed', v_rows = 0
  );
END;
$function$

;


-- ---------------------------------------------------------------------------------------------
-- 3. Public read surface: keep the projection-integrity routing, drop the completion-ACK overlay.
-- ---------------------------------------------------------------------------------------------

-- Same two-stage shape 0201 introduced -- projection-only read, then the runtime-liveness overlay,
-- with `canonicalDoneGate` and `projectionIntegritySource` recorded between them -- minus the
-- completion-ACK overlay and minus the `no_data_found` fallback, which only a tenant-bound ACTIVE
-- completion-ACK fact could ever activate. A missing 0194 stream is once again just an error.
CREATE OR REPLACE FUNCTION outcome_operational_read_surface(
  p_authenticated_tenant uuid,
  p_project_id uuid,
  p_subject_type text,
  p_subject_id text,
  p_surface text
) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
   SET search_path = pg_catalog, public, outcome_projection AS $$
DECLARE
  v_projection jsonb;
BEGIN
  v_projection := outcome_projection.read_surface_projection_only(
    p_authenticated_tenant, p_project_id, p_subject_type, p_subject_id, p_surface
  );
  RETURN executable_runtime_overlay_read_surface(
    v_projection || jsonb_build_object(
      'canonicalDoneGate', v_projection->'doneGate',
      'projectionIntegritySource', 'read_surface_projection_only'
    ),
    p_surface
  );
END;
$$;

CREATE OR REPLACE FUNCTION outcome_projection.read_surface(
  p_authenticated_tenant uuid,
  p_project_id uuid,
  p_subject_type text,
  p_subject_id text,
  p_surface text
) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER
   SET search_path = pg_catalog, public, outcome_projection AS $$
  SELECT CASE
    WHEN current_setting('orbit.projection_integrity_only', true) = 'on'
      THEN outcome_projection.read_surface_projection_only(
        p_authenticated_tenant, p_project_id, p_subject_type, p_subject_id, p_surface
      )
    ELSE outcome_operational_read_surface(
      p_authenticated_tenant, p_project_id, p_subject_type, p_subject_id, p_surface
    )
  END
$$;

COMMENT ON FUNCTION outcome_projection.read_surface IS
  'Six canonical read surfaces plus direct external dead-man liveness; WATCHDOG_STALE is never rendered as an empty obligation set. The transaction-local projection_integrity_only mode lets project_canonical_done_gate compare a projection-only value before any overlay applies.';

-- ---------------------------------------------------------------------------------------------
-- 4. DONE gate: projection-integrity body first, runtime liveness second, nothing else.
-- ---------------------------------------------------------------------------------------------

-- The conclusion path is unchanged for every project that has a canonical projection: the 0218
-- body decides ALLOW or DENY, and only `executable_runtime_overlay_read_surface` may still deny a
-- gate the body allowed (an expired watchdog heartbeat). What is gone is the completion-ACK
-- overlay and the completion-ACK-gated swallow of `no_data_found`: a project with no 0194 stream
-- raises again, as it did before 0201, instead of being handed a synthesised
-- CANONICAL_PROJECTION_UNAVAILABLE denial that only an ACTIVE completion-ACK fact could produce.
CREATE OR REPLACE FUNCTION project_canonical_done_gate(
  p_project uuid,
  p_subject_type text DEFAULT 'PROJECT',
  p_subject_id text DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER
   SET search_path = pg_catalog, public, outcome_projection AS $$
DECLARE
  v_previous_mode text := current_setting('orbit.projection_integrity_only', true);
  v_canonical_gate jsonb;
  v_operational_surface jsonb;
BEGIN
  PERFORM set_config('orbit.projection_integrity_only', 'on', true);
  BEGIN
    v_canonical_gate := project_canonical_done_gate_projection_integrity_body(
      p_project, p_subject_type, p_subject_id
    );
  EXCEPTION WHEN OTHERS THEN
    PERFORM set_config(
      'orbit.projection_integrity_only', COALESCE(v_previous_mode, ''), true
    );
    RAISE;
  END;
  PERFORM set_config(
    'orbit.projection_integrity_only', COALESCE(v_previous_mode, ''), true
  );

  -- Apply operational liveness only after the canonical projection/checksum comparison succeeded
  -- (or returned its own structured denial).  Operational state can deny closure but can no longer
  -- masquerade as a corrupt or stale canonical projection.
  v_operational_surface := executable_runtime_overlay_read_surface(
    jsonb_build_object(
      'surface', 'DONE_GATE',
      'canonicalDoneGate', v_canonical_gate,
      'projectionIntegritySource', 'project_canonical_done_gate_projection_integrity_body',
      'doneGate', v_canonical_gate,
      'obligations', '[]'::jsonb,
      'blockingObligations', '[]'::jsonb,
      'activeObligationCount', 0
    ),
    'DONE_GATE'
  );
  RETURN COALESCE(v_operational_surface->'doneGate', v_canonical_gate)
    || jsonb_build_object(
      'projectionIntegrity', 'PROJECTION_ONLY_CHECKED',
      'canonicalDoneGate', v_canonical_gate,
      'runtimeLiveness', COALESCE(v_operational_surface->'runtimeLiveness', '[]'::jsonb)
    );
END;
$$;

COMMENT ON FUNCTION project_canonical_done_gate(uuid, text, text) IS
  'Final DONE wall. The projection-integrity body concludes first against a projection-only read; runtime liveness may then deny, never allow. No operational overlay can present itself as a corrupt or stale canonical projection.';

-- ---------------------------------------------------------------------------------------------
-- 5. Coordinator entry points: drop the 0202 COMPLETION_ACK wrappers, restore the 0198 bodies.
-- ---------------------------------------------------------------------------------------------

DROP FUNCTION outcome_register_coordinator_obligation(
  uuid, uuid, text, text, jsonb, bigint, integer, integer, integer, integer);
ALTER FUNCTION outcome_register_coordinator_obligation_0198(
  uuid, uuid, text, text, jsonb, bigint, integer, integer, integer, integer)
  RENAME TO outcome_register_coordinator_obligation;

DROP FUNCTION outcome_reconcile_active_obligations(
  uuid, bigint, integer, integer, integer, integer);
ALTER FUNCTION outcome_reconcile_active_obligations_0198(
  uuid, bigint, integer, integer, integer, integer)
  RENAME TO outcome_reconcile_active_obligations;

DROP FUNCTION outcome_record_coordinator_result(
  uuid, uuid, uuid, text, text, text, text, bigint, jsonb);
ALTER FUNCTION outcome_record_coordinator_result_0198(
  uuid, uuid, uuid, text, text, text, text, bigint, jsonb)
  RENAME TO outcome_record_coordinator_result;

-- ---------------------------------------------------------------------------------------------
-- 6. Triggers on tables that stay. Each is dropped by name: a DROP TABLE cascade would take the
--    completion-ACK ones with it, but these sit on core tables that are not going anywhere.
-- ---------------------------------------------------------------------------------------------

DROP TRIGGER conversation_turn_completion_ack_insert_guard ON conversation_turn;
DROP TRIGGER conversation_turn_completion_ack_lease_guard ON conversation_turn;
DROP TRIGGER outcome_coordinator_completion_attempt_result_guard ON outcome_coordinator_attempt_result;
DROP TRIGGER outcome_coordinator_completion_terminal_guard ON outcome_coordinator_obligation;
DROP TRIGGER outcome_coordinator_completion_owner_decision_binding_required ON outcome_coordinator_owner_decision_request;
DROP TRIGGER session_completion_ack_dispatch_insert_guard ON session;
DROP TRIGGER session_completion_ack_dispatch_revive_guard ON session;
DROP TRIGGER task_completion_ack_remediation_action ON task;
DROP TRIGGER task_completion_ack_remediation_reactivation_guard ON task;
DROP TRIGGER zz_task_completion_ack_remediation_criterion_insert_guard ON task;
DROP TRIGGER zz_task_completion_ack_remediation_criterion_update_guard ON task;

-- Triggers on the completion-ACK tables themselves. 0164 set the convention that a trigger is
-- only gone when a DROP names it, so every one is named here rather than left to the cascade.

DROP TRIGGER completion_ack_delivery_adoption_append_only ON completion_ack_coordinator_delivery_adoption;
DROP TRIGGER completion_ack_delivery_adoption_insert_guard ON completion_ack_coordinator_delivery_adoption;
DROP TRIGGER completion_ack_delivery_plan_append_only ON completion_ack_coordinator_delivery_plan;
DROP TRIGGER completion_ack_delivery_plan_insert_guard ON completion_ack_coordinator_delivery_plan;
DROP TRIGGER completion_ack_delivery_receipt_append_only ON completion_ack_coordinator_delivery_receipt;
DROP TRIGGER completion_ack_delivery_receipt_insert_guard ON completion_ack_coordinator_delivery_receipt;
DROP TRIGGER completion_ack_delivery_progress_append_only ON completion_ack_delivery_progress_event;
DROP TRIGGER completion_ack_delivery_progress_insert_guard ON completion_ack_delivery_progress_event;
DROP TRIGGER completion_ack_fact_append_only ON completion_ack_fact;
DROP TRIGGER completion_ack_fact_before_insert ON completion_ack_fact;
DROP TRIGGER completion_ack_fact_observation_after_insert ON completion_ack_fact;
DROP TRIGGER completion_ack_event_append_only ON completion_ack_obligation_event;
DROP TRIGGER completion_ack_event_before_insert ON completion_ack_obligation_event;
DROP TRIGGER completion_ack_revision_append_only ON completion_ack_obligation_revision;
DROP TRIGGER completion_ack_revision_before_insert ON completion_ack_obligation_revision;
DROP TRIGGER completion_ack_observation_register_guard ON completion_ack_observation_register;
DROP TRIGGER completion_ack_owner_decision_binding_append_only ON completion_ack_owner_decision_binding;
DROP TRIGGER completion_ack_owner_decision_binding_insert_guard ON completion_ack_owner_decision_binding;
DROP TRIGGER completion_ack_remediation_action_append_only ON completion_ack_remediation_action;
DROP TRIGGER completion_ack_remediation_action_insert_guard ON completion_ack_remediation_action;
DROP TRIGGER completion_ack_rollout_epoch_append_only ON completion_ack_rollout_epoch;

-- ---------------------------------------------------------------------------------------------
-- 7. The completion-ACK pointer a kept table carried, and the index a dropped guard scanned.
-- ---------------------------------------------------------------------------------------------

ALTER TABLE outcome_coordinator_attempt_result
  DROP CONSTRAINT outcome_coordinator_attempt_completion_receipt_fk,
  DROP COLUMN completion_delivery_receipt_id;

-- Only conversation_turn_completion_ack_execution_guard's obligation scan used this partial
-- index; 0201 created it for that guard and nothing else reads the shape.
DROP INDEX conversation_turn_completion_ack_scan_idx;

-- ---------------------------------------------------------------------------------------------
-- 8. Views, then functions, then tables. Functions go before tables because two of them take a
--    completion_ack_obligation_revision row type as a parameter.
-- ---------------------------------------------------------------------------------------------

-- Two functions take a completion_ack_obligation_revision row type as a parameter, so they must
-- go before the table that defines it; the rest go after, because CHECK constraints on the
-- tables depend on five of them.
DROP FUNCTION completion_ack_append_fact(p_revision completion_ack_obligation_revision, p_lease_generation uuid, p_fact_kind text, p_source_observed_at timestamp with time zone, p_evidence_source jsonb, p_runner_provenance text, p_lease_provenance text);
DROP FUNCTION completion_ack_record_observation(p_revision completion_ack_obligation_revision, p_fact_id uuid, p_lease_generation uuid, p_fact_kind text, p_source_observed_at timestamp with time zone, p_evidence_source jsonb, p_runner_provenance text, p_lease_provenance text);

DROP VIEW completion_ack_operational_obligation;
DROP VIEW completion_ack_current_coordinator_delivery;
DROP VIEW completion_ack_coordinator_source;
DROP VIEW completion_ack_active_obligation;

-- Children before parents; every FK inside the set is named by an earlier DROP.
DROP TABLE completion_ack_delivery_progress_event;
DROP TABLE completion_ack_remediation_action;
DROP TABLE completion_ack_owner_decision_binding;
DROP TABLE completion_ack_coordinator_delivery_adoption;
DROP TABLE completion_ack_coordinator_delivery_receipt;
DROP TABLE completion_ack_coordinator_delivery_plan;
DROP TABLE completion_ack_obligation_event;
DROP TABLE completion_ack_fact;
DROP TABLE completion_ack_observation_register;
DROP TABLE completion_ack_obligation_revision;
DROP TABLE completion_ack_delivery_reconcile_cursor;
DROP TABLE completion_ack_rollout_epoch;

DROP FUNCTION completion_ack_append_only_guard();
DROP FUNCTION session_completion_ack_dispatch_guard();
DROP FUNCTION conversation_turn_completion_ack_execution_guard();
DROP FUNCTION completion_ack_attempt_result_insert_guard();
DROP FUNCTION completion_ack_bounded_observation_history(p_existing jsonb, p_observation jsonb);
DROP FUNCTION completion_ack_claim_next_coordination(p_tenant_id uuid, p_worker_id text, p_lease_logical_ticks bigint);
DROP FUNCTION completion_ack_coordination_state(p_tenant_id uuid, p_coordination_id uuid);
DROP FUNCTION completion_ack_coordination_state_0202(p_tenant_id uuid, p_coordination_id uuid);
DROP FUNCTION completion_ack_coordination_terminal_guard();
DROP FUNCTION completion_ack_decide_owner_decision(p_tenant_id uuid, p_project_id uuid, p_request_id uuid, p_obligation_revision text, p_idempotency_key text, p_decision jsonb);
DROP FUNCTION completion_ack_delivery_adoption_insert_guard();
DROP FUNCTION completion_ack_delivery_plan_insert_guard();
DROP FUNCTION completion_ack_delivery_progress_insert_guard();
DROP FUNCTION completion_ack_delivery_progress_snapshot(p_delivery_receipt_id uuid);
DROP FUNCTION completion_ack_delivery_receipt_insert_guard();
DROP FUNCTION completion_ack_done_gate_surface_probe(p_authenticated_tenant uuid, p_project_id uuid, p_subject_type text, p_subject_id text);
DROP FUNCTION completion_ack_evaluate(p_session_id uuid, p_turn_id uuid, p_observed_at timestamp with time zone, p_evidence_source jsonb);
DROP FUNCTION completion_ack_event_before_insert();
DROP FUNCTION completion_ack_fact_before_insert();
DROP FUNCTION completion_ack_fact_idempotency_key(p_obligation_revision character, p_fact_kind text, p_tenant_id uuid, p_project_id uuid, p_task_id uuid, p_session_id uuid, p_turn_id uuid, p_lease_generation uuid, p_error_fingerprint text, p_observation_bucket timestamp with time zone);
DROP FUNCTION completion_ack_fact_observation_after_insert();
DROP FUNCTION completion_ack_json_digest(p_value jsonb);
DROP FUNCTION completion_ack_obligation_id(p_task_id uuid, p_session_id uuid, p_turn_id uuid, p_error_fingerprint text);
DROP FUNCTION completion_ack_obligation_revision(p_task_id uuid, p_session_id uuid, p_turn_id uuid, p_error_fingerprint text);
DROP FUNCTION completion_ack_observation_bucket(p_recorded_at timestamp with time zone);
DROP FUNCTION completion_ack_observation_register_guard();
DROP FUNCTION completion_ack_observe_coordinator_delivery(p_delivery_receipt_id uuid, p_source_observed_at timestamp with time zone, p_detection_delta_seconds integer);
DROP FUNCTION completion_ack_operational_read_surface(p_authenticated_tenant uuid, p_project_id uuid, p_subject_type text, p_subject_id text, p_surface text);
DROP FUNCTION completion_ack_overlay_read_surface(p_payload jsonb, p_project_id uuid, p_surface text);
DROP FUNCTION completion_ack_owner_decision_binding_insert_guard();
DROP FUNCTION completion_ack_owner_decision_request_binding_required();
DROP FUNCTION completion_ack_plan_coordinator_delivery(p_tenant_id uuid, p_coordination_id uuid, p_lease_token uuid, p_worker_id text);
DROP FUNCTION completion_ack_rebuild_observation_baseline(p_obligation_revision character);
DROP FUNCTION completion_ack_reconcile_coordinator(p_tenant_id uuid, p_liveness_delta bigint, p_attempt_budget integer, p_wake_budget integer, p_same_failure_fingerprint_limit integer, p_max_lease_renewals integer);
DROP FUNCTION completion_ack_reconcile_stale(p_observed_at timestamp with time zone, p_detection_delta_seconds integer, p_limit integer);
DROP FUNCTION completion_ack_reconcile_stale_deliveries(p_source_observed_at timestamp with time zone, p_detection_delta_seconds integer, p_limit integer);
DROP FUNCTION completion_ack_record_coordinator_delivery(p_tenant_id uuid, p_coordination_id uuid, p_current_lease_token uuid, p_worker_id text, p_plan_id uuid, p_wake_id uuid, p_session_id uuid);
DROP FUNCTION completion_ack_record_failure(p_tenant_id uuid, p_project_id uuid, p_task_id uuid, p_session_id uuid, p_turn_id uuid, p_lease_generation uuid, p_fact_kind text, p_error_fingerprint text, p_observed_at timestamp with time zone, p_evidence_source jsonb);
DROP FUNCTION completion_ack_record_recovery(p_session_id uuid, p_turn_id uuid, p_observed_at timestamp with time zone, p_evidence_source jsonb);
DROP FUNCTION completion_ack_record_session_task_action(p_tenant_id uuid, p_coordinator_session_id uuid, p_task_id uuid, p_action_kind text, p_action_key text, p_evidence jsonb);
DROP FUNCTION completion_ack_remediation_action_insert_guard();
DROP FUNCTION completion_ack_remediation_task_criterion_guard();
DROP FUNCTION completion_ack_remediation_task_reactivation_guard();
DROP FUNCTION completion_ack_request_owner_decision(p_tenant_id uuid, p_project_id uuid, p_runner_id uuid, p_coordinator_session_id uuid, p_obligation_id text, p_obligation_revision text, p_reason text, p_request jsonb);
DROP FUNCTION completion_ack_requeue_revoked_delivery(p_delivery_receipt_id uuid);
DROP FUNCTION completion_ack_resolve_blocker(p_project_id uuid, p_obligation_id character, p_obligation_revision character, p_recorded_at timestamp with time zone);
DROP FUNCTION completion_ack_revision_before_insert();
DROP FUNCTION completion_ack_rollout_epoch_append_only();
DROP FUNCTION completion_ack_sanitize_action_evidence(p_evidence jsonb);
DROP FUNCTION completion_ack_sanitize_evidence(p_kind text, p_value jsonb);
DROP FUNCTION completion_ack_schedule_coordinator_wake(p_coordination_id uuid, p_due_logical_time bigint, p_reason_code text);
DROP FUNCTION completion_ack_sweep_coordinator(p_tenant_id uuid);
DROP FUNCTION completion_ack_sync_blocker(p_obligation_revision character, p_recorded_at timestamp with time zone);
DROP FUNCTION completion_ack_task_created_action();
DROP FUNCTION completion_ack_uuid_from_digest(p_digest text);
