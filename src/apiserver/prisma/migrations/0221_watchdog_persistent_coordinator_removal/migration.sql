-- Watchdog and persistent-coordinator removal (0198, 0199 watchdog, 0206, 0214).
--
-- Four migrations totalling 4,156 lines of SQL built an independently deployed watchdog, a
-- persistent obligation coordinator, a current-binding ledger for that watchdog, and a goal
-- progress channel for it:
--
--   0198_outcome_persistent_coordinator             1,977 lines   13 tables, 20 functions
--   0199_outcome_independent_watchdog_slo_security    831 lines   schema outcome_watchdog
--   0206_watchdog_current_binding                     784 lines   3 tables, 1 view, 2 functions
--   0214_watchdog_goal_progress_channel               564 lines   outcome_watchdog.collect
--
-- Their only writers were the `watchdog`, `outcome-coordinator`,
-- `outcome-coordinator-secondary` and `executable-dead-man` Compose services, removed by
-- 852209f9. The last database writers that outlived those processes belonged to the
-- completion-ACK protocol (0201-0204), which 0220 removed: after it, no function, trigger,
-- foreign key or view outside these four migrations writes any of these tables.
--
-- Three kept subsystems borrowed pieces and are rewired first, before anything is dropped:
--
--   1. `executable_runtime_sanitize_metadata` (0220) called `outcome_watchdog.sanitize_payload`
--      to redact heartbeat metadata on an ordinary EXECUTABLE-runtime write path. The four
--      redaction helpers are re-created verbatim under neutral `outcome_redact_*` names and the
--      sanitizer is re-created to call them. `sanitize_payload`'s own two 65,536-byte bounds are
--      not carried over: the caller already refuses input above 16,384 bytes and output above
--      8,192, so neither bound was reachable through this, its only caller.
--   2. `executable_runtime_liveness` (view) and `executable_runtime_overlay_read_surface` were
--      created by 0200 and 0202 and *replaced* by 0206 to read the binding ledger. They are not
--      0206's to delete, so they are restored to their pre-0206 definitions rather than dropped.
--      `outcome_projection.read_surface` and `project_canonical_done_gate` keep calling the
--      overlay through the same signature; a stale runtime heartbeat still turns ALLOW into DENY.
--   3. `outcome_coordinator_owner_request_binding_trigger` came from 0199_outcome_actor_surfaces,
--      which this task must not remove. Its only subject is the 0198 owner-decision request
--      table, so the function goes with that table; nothing else in actor surfaces is touched.
--
-- Deliberately NOT removed: `executable_runtime_heartbeat`, `executable_runtime_expectation`,
-- `executable_dead_man_event` and the rest of the 0200/0202 EXECUTABLE acceptance runtime;
-- `task_executable_attempt` / `task_executable_admission`; `failure_continuation_*` /
-- `failure_successor_*`; `project_acceptance_*`; the obligation algebra and canonical DONE gate
-- (0194/0195/0196/0197). The `outcome-watchdog` member of
-- `executable_runtime_expectation.component` also stays: 27 live rows still carry it, and the
-- expectation ledger is a different subsystem's audit history.
--
-- Data removed with the tables (2026-09-01, production): outcome_watchdog.sample 23,433 rows;
-- executable_runtime_binding_fact 21,532; executable_runtime_binding 22; outcome_coordinator_*
-- 49 across nine tables; executable_runtime_binding_stream 1. No archive table is created.

-- 1. Re-home the redaction chain the surviving metadata sanitizer depends on. ---------------

CREATE OR REPLACE FUNCTION outcome_redact_text(p_value text) RETURNS text AS $$
DECLARE
  result text := p_value;
BEGIN
  result := regexp_replace(result, '(?i)Bearer[[:space:]]+[A-Za-z0-9._~+/=-]+',
                           '[REDACTED]', 'g');
  result := regexp_replace(result,
    '(?i)(gh[opsu]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{16})',
    '[REDACTED]', 'g');
  result := regexp_replace(result,
    '(?i)(api[_-]?key|token|secret|password)[[:space:]]*[:=][[:space:]]*[^[:space:],;]+',
    '\1=[REDACTED]', 'g');
  result := regexp_replace(result,
    '([A-Za-z][A-Za-z0-9+.-]*://[^[:space:]/:@]+:)[^@[:space:]/]+@',
    '\1[REDACTED]@', 'g');
  RETURN result;
END;
$$ LANGUAGE plpgsql IMMUTABLE STRICT PARALLEL SAFE;

CREATE OR REPLACE FUNCTION outcome_redact_raw_output(p_value text) RETURNS text AS $$
DECLARE
  result text := outcome_redact_text(p_value);
  suffix text := E'\n[TRUNCATED]';
  allowed integer := 16384 - octet_length(suffix);
BEGIN
  IF octet_length(result) <= 16384 THEN RETURN result; END IF;
  result := left(result, allowed);
  WHILE octet_length(result) > allowed LOOP
    result := left(result, length(result) - 1);
  END LOOP;
  RETURN result || suffix;
END;
$$ LANGUAGE plpgsql IMMUTABLE STRICT PARALLEL SAFE;

CREATE OR REPLACE FUNCTION outcome_secure_raw_output(p_value text) RETURNS jsonb AS $$
DECLARE
  secured text := outcome_redact_raw_output(p_value);
BEGIN
  RETURN jsonb_build_object(
    'content', secured,
    'originalBytes', octet_length(p_value),
    'storedBytes', octet_length(secured),
    'truncated', octet_length(p_value) > 16384,
    'redacted', secured IS DISTINCT FROM p_value,
    'originalSha256', encode(digest(convert_to(p_value, 'UTF8'), 'sha256'), 'hex')
  );
END;
$$ LANGUAGE plpgsql IMMUTABLE STRICT PARALLEL SAFE;

CREATE OR REPLACE FUNCTION outcome_redact_json(p_value jsonb) RETURNS jsonb AS $$
  SELECT CASE jsonb_typeof(p_value)
    WHEN 'object' THEN COALESCE((
      SELECT jsonb_object_agg(entry.key,
        CASE
          WHEN entry.key ~* '(authorization|cookie|token|secret|password|private[_-]?key|api[_-]?key|credential)'
            THEN to_jsonb('[REDACTED]'::text)
          WHEN entry.key ~* '^(rawCommandOutput|commandOutput|stdout|stderr)$'
               AND jsonb_typeof(entry.value) = 'string'
            THEN outcome_secure_raw_output(entry.value #>> '{}')
          ELSE outcome_redact_json(entry.value)
        END ORDER BY entry.key)
        FROM jsonb_each(p_value) entry
    ), '{}'::jsonb)
    WHEN 'array' THEN COALESCE((
      SELECT jsonb_agg(outcome_redact_json(item.value) ORDER BY item.ordinality)
        FROM jsonb_array_elements(p_value) WITH ORDINALITY item(value, ordinality)
    ), '[]'::jsonb)
    WHEN 'string' THEN to_jsonb(outcome_redact_text(p_value #>> '{}'))
    ELSE p_value
  END
$$ LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE;

CREATE OR REPLACE FUNCTION executable_runtime_sanitize_metadata(p_metadata jsonb)
  RETURNS jsonb LANGUAGE plpgsql IMMUTABLE SECURITY DEFINER
  SET search_path = pg_catalog, public AS $$
DECLARE
  v_sanitized jsonb;
BEGIN
  IF p_metadata IS NULL OR jsonb_typeof(p_metadata) <> 'object'
     OR octet_length(p_metadata::text) > 16384 THEN
    RAISE EXCEPTION 'EXECUTABLE_RUNTIME_METADATA_INVALID'
      USING ERRCODE = 'program_limit_exceeded';
  END IF;
  v_sanitized := outcome_redact_json(p_metadata);
  IF octet_length(v_sanitized::text) > 8192 THEN
    RAISE EXCEPTION 'EXECUTABLE_RUNTIME_METADATA_TOO_LARGE'
      USING ERRCODE = 'program_limit_exceeded';
  END IF;
  RETURN v_sanitized;
END;
$$;

-- 2. Restore the pre-0206 runtime liveness surfaces, then drop 0206's binding ledger. -------

DROP VIEW executable_runtime_liveness;
DROP VIEW executable_runtime_current_binding;

DROP INDEX executable_runtime_heartbeat_binding_watermark_idx;
DROP INDEX executable_runtime_heartbeat_binding_latest_idx;
ALTER TABLE executable_runtime_heartbeat
  DROP CONSTRAINT executable_runtime_heartbeat_binding_fk,
  DROP CONSTRAINT executable_runtime_heartbeat_binding_shape_chk,
  DROP COLUMN runtime_binding_digest,
  DROP COLUMN runtime_binding_logical_time;

CREATE VIEW executable_runtime_liveness AS
WITH latest_legacy_heartbeat AS (
  SELECT DISTINCT ON (heartbeat.component, heartbeat.instance_id) heartbeat.*
    FROM executable_runtime_heartbeat heartbeat
   WHERE heartbeat.expectation_generation IS NULL
     AND NOT EXISTS (
       SELECT 1 FROM executable_runtime_expectation expectation
        WHERE expectation.component = heartbeat.component
          AND expectation.instance_id = heartbeat.instance_id
     )
   ORDER BY heartbeat.component, heartbeat.instance_id, heartbeat.sequence DESC
), latest_legacy_event AS (
  SELECT DISTINCT ON (event.component, event.instance_id) event.*
    FROM executable_dead_man_event event
   WHERE event.expectation_generation IS NULL
   ORDER BY event.component, event.instance_id, event.checked_at DESC, event.created_at DESC
)
SELECT expected.component::text AS component,
       expected.instance_id::text AS instance_id,
       expected.expected_source_sha::text AS source_sha,
       COALESCE(expected.heartbeat_digest, expected.expectation_digest)::char(64)
         AS heartbeat_digest,
       COALESCE(expected.observed_at, expected.activated_at)::timestamptz AS observed_at,
       COALESCE(expected.deadline_at, expected.startup_deadline_at)::timestamptz AS deadline_at,
       COALESCE(expected.last_event_kind, expected.condition_code)::text AS last_event_kind,
       expected.state::text AS state,
       CASE WHEN expected.state = 'WATCHDOG_STALE' THEN 1 ELSE 0 END::integer
         AS active_obligation_count
  FROM executable_runtime_expected_liveness expected
UNION ALL
SELECT heartbeat.component::text,
       heartbeat.instance_id::text,
       heartbeat.source_sha::text,
       heartbeat.heartbeat_digest::char(64),
       heartbeat.observed_at::timestamptz,
       heartbeat.deadline_at::timestamptz,
       event.kind::text,
       CASE
         WHEN now() > heartbeat.deadline_at THEN 'WATCHDOG_STALE'
         WHEN event.kind = 'WATCHDOG_STALE' AND event.checked_at >= heartbeat.observed_at
           THEN 'WATCHDOG_STALE'
         ELSE 'HEALTHY'
       END::text,
       CASE
         WHEN now() > heartbeat.deadline_at
           OR (event.kind = 'WATCHDOG_STALE' AND event.checked_at >= heartbeat.observed_at)
         THEN 1 ELSE 0
       END::integer
  FROM latest_legacy_heartbeat heartbeat
  LEFT JOIN latest_legacy_event event USING (component, instance_id);

CREATE OR REPLACE FUNCTION executable_runtime_overlay_read_surface(
  p_payload jsonb,
  p_surface text
) RETURNS jsonb AS $$
DECLARE
  payload_value jsonb := COALESCE(p_payload, '{}'::jsonb);
  runtime_obligations jsonb;
  existing_obligations jsonb;
  existing_blocking jsonb;
  primary_obligation jsonb;
  merged_obligations jsonb;
BEGIN
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'obligationId', encode(digest(concat(
      'WATCHDOG_STALE', E'\n', live."component", E'\n', live."instance_id"
    ), 'sha256'), 'hex'),
    'obligationRevision', live."heartbeat_digest",
    'bindingDigest', live."heartbeat_digest",
    'binding', jsonb_build_object(
      'component', live."component",
      'instanceId', live."instance_id",
      'sourceSha', live."source_sha",
      'heartbeatDigest', live."heartbeat_digest"
    ),
    'kind', 'WATCHDOG_STALE',
    'owner', 'SYSTEM',
    'capability', 'watchdog.heartbeat',
    'reason', jsonb_build_object(
      'code', 'WATCHDOG_STALE',
      'category', 'RUNTIME_LIVENESS',
      'message', concat('External dead-man observed an expired watchdog heartbeat for ',
        live."instance_id", '.'),
      'owner', 'SYSTEM',
      'actor', 'EXTERNAL_DEAD_MAN',
      'nextAction', 'RESTORE_WATCHDOG_HEARTBEAT',
      'blocksGate', true,
      'evidenceFactIds', jsonb_build_array(live."heartbeat_digest"),
      'attemptedActions', '[]'::jsonb,
      'detail', jsonb_build_object(
        'component', live."component",
        'instanceId', live."instance_id",
        'observedAt', live."observed_at",
        'deadlineAt', live."deadline_at",
        'lastEventKind', live."last_event_kind"
      )
    ),
    'evaluatedThroughLogicalTime', NULL,
    'projectionRevision', NULL,
    'staleness', 'WATCHDOG_STALE'
  ) ORDER BY live."component", live."instance_id"), '[]'::jsonb)
    INTO runtime_obligations
    FROM executable_runtime_liveness live
   WHERE live."state" = 'WATCHDOG_STALE';

  IF jsonb_array_length(runtime_obligations) = 0 THEN
    RETURN payload_value;
  END IF;
  existing_obligations := CASE WHEN jsonb_typeof(payload_value->'obligations') = 'array'
    THEN payload_value->'obligations' ELSE '[]'::jsonb END;
  existing_blocking := CASE WHEN jsonb_typeof(payload_value->'blockingObligations') = 'array'
    THEN payload_value->'blockingObligations' ELSE '[]'::jsonb END;
  merged_obligations := existing_obligations || runtime_obligations;
  primary_obligation := runtime_obligations->0;

  RETURN payload_value || jsonb_build_object(
    'surface', COALESCE(payload_value->>'surface', p_surface),
    'staleness', 'WATCHDOG_STALE',
    'obligations', merged_obligations,
    'blockingObligations', existing_blocking || runtime_obligations,
    'activeObligationCount', jsonb_array_length(merged_obligations),
    'runtimeLiveness', runtime_obligations,
    'doneGate', COALESCE(payload_value->'doneGate', '{}'::jsonb) || jsonb_build_object(
      'allowed', false,
      'reason', primary_obligation->'reason',
      'obligationId', primary_obligation->>'obligationId',
      'obligationRevision', primary_obligation->>'obligationRevision',
      'owner', 'SYSTEM',
      'staleness', 'WATCHDOG_STALE'
    )
  );
END;
$$ LANGUAGE plpgsql STABLE;

COMMENT ON VIEW executable_runtime_liveness IS
  'Expected-generation liveness plus pre-expectation legacy heartbeats, as before 0206.';

DROP FUNCTION executable_runtime_append_current_heartbeat(
  p_component text, p_instance_id text, p_generation uuid, p_source_sha text,
  p_module_graph_digest text, p_observed_at timestamptz, p_deadline_at timestamptz,
  p_payload jsonb);
DROP FUNCTION executable_runtime_register_current_binding(
  p_component text, p_instance_id text, p_generation uuid, p_source_sha text,
  p_target_sha text, p_target_ref text, p_module_graph_digest text);

DROP TABLE executable_runtime_binding_fact;
DROP TABLE executable_runtime_binding;
DROP TABLE executable_runtime_binding_stream;

-- 3. Drop the independent watchdog (0199) and its goal progress channel (0214). -------------
--
-- The schema owns three tables, two append-only triggers and fourteen functions, all of them
-- named inside it; DROP SCHEMA CASCADE removes exactly that set and nothing outside it.

DROP INDEX outcome_fact_stream_watchdog_recent_idx;
DROP INDEX outcome_projection.outcome_projection_reconciler_watchdog_sample_idx;
DROP SCHEMA outcome_watchdog CASCADE;

-- 4. Drop the persistent coordinator (0198). ------------------------------------------------
--
-- Its five append-only triggers live on its own tables and go with them. The three indexes
-- 0199's watchdog added to those tables go with them too.

DROP FUNCTION outcome_advance_coordinator_clock(p_tenant_id uuid, p_clock_id uuid, p_logical_time bigint);
DROP FUNCTION outcome_append_coordinator_event(p_coordination_id uuid, p_event_key text, p_event_type text, p_from_status text, p_to_status text, p_progress_kind text, p_logical_time bigint, p_failure_fingerprint text, p_detail jsonb);
DROP FUNCTION outcome_apply_coordinator_failure(p_coordination_id uuid, p_failure_fingerprint text, p_reason_code text, p_logical_time bigint, p_retry_after bigint, p_detail jsonb);
DROP FUNCTION outcome_claim_next_coordination(p_tenant_id uuid, p_worker_id text, p_lease_logical_ticks bigint);
DROP FUNCTION outcome_coordinator_liveness_audit(p_tenant_id uuid);
DROP FUNCTION outcome_coordinator_now(p_tenant_id uuid);
DROP FUNCTION outcome_decide_coordinator_owner_request(p_tenant_id uuid, p_request_id uuid, p_request_revision text, p_obligation_id text, p_obligation_revision text, p_binding_digest text, p_idempotency_key text, p_decision jsonb);
DROP FUNCTION outcome_decide_coordinator_owner_request_unbound_0198(p_tenant_id uuid, p_request_id uuid, p_obligation_revision text, p_idempotency_key text, p_decision jsonb);
DROP FUNCTION outcome_deliver_coordinator_wake(p_tenant_id uuid, p_wake_id uuid, p_callback_key text);
DROP FUNCTION outcome_reconcile_active_obligations(p_tenant_id uuid, p_liveness_delta bigint, p_attempt_budget integer, p_wake_budget integer, p_same_failure_fingerprint_limit integer, p_max_lease_renewals integer);
DROP FUNCTION outcome_record_coordinator_result(p_tenant_id uuid, p_coordination_id uuid, p_lease_token uuid, p_worker_id text, p_callback_key text, p_result text, p_failure_fingerprint text, p_retry_after bigint, p_detail jsonb);
DROP FUNCTION outcome_register_coordinator_obligation(p_tenant_id uuid, p_project_id uuid, p_source_type text, p_source_key text, p_source_obligation jsonb, p_liveness_delta bigint, p_attempt_budget integer, p_wake_budget integer, p_same_failure_fingerprint_limit integer, p_max_lease_renewals integer);
DROP FUNCTION outcome_renew_coordinator_lease(p_tenant_id uuid, p_coordination_id uuid, p_lease_token uuid, p_worker_id text, p_extension_logical_ticks bigint);
DROP FUNCTION outcome_request_coordinator_owner_decision(p_tenant_id uuid, p_coordination_id uuid, p_lease_token uuid, p_worker_id text, p_reason text, p_request jsonb);
DROP FUNCTION outcome_schedule_coordinator_wake(p_coordination_id uuid, p_due_logical_time bigint, p_reason_code text, p_wait_status text);
DROP FUNCTION outcome_sweep_coordinator(p_tenant_id uuid);
DROP FUNCTION outcome_terminalize_coordination(p_coordination_id uuid, p_status text, p_reason_code text, p_progress_kind text, p_logical_time bigint, p_detail jsonb);

DROP TABLE outcome_coordinator_event;
DROP TABLE outcome_coordinator_attempt_result;
DROP TABLE outcome_coordinator_failure_fingerprint;
DROP TABLE outcome_coordinator_external_wait;
DROP TABLE outcome_coordinator_owner_decision_request;
DROP TABLE outcome_coordinator_wake_delivery;
DROP TABLE outcome_coordinator_wake;
DROP TABLE outcome_coordinator_lease;
DROP TABLE outcome_coordinator_obligation;
DROP TABLE outcome_coordinator_obligation_revision;
DROP TABLE outcome_coordinator_clock;
DROP TABLE outcome_coordinator_scheduler;
DROP TABLE outcome_coordinator_project_fairness;

-- The trigger it carried belonged to 0199_outcome_actor_surfaces, which stays; the function had
-- no other subject and cannot outlive the table it fenced.
DROP FUNCTION outcome_coordinator_owner_request_binding_trigger();

-- 5. Fail closed if anything named above survived, or if a kept subsystem lost a dependency. -
--
-- No explicit transaction is opened: Prisma already wraps the file, and an explicit COMMIT would
-- reduce a failed assertion to "current transaction is aborted".

DO $$
DECLARE
  leftover text;
BEGIN
  SELECT string_agg(name, ', ' ORDER BY name) INTO leftover FROM (
    SELECT c.relname AS name
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relkind IN ('r', 'v')
       AND (c.relname LIKE 'outcome\_coordinator\_%' OR c.relname LIKE 'executable\_runtime\_binding%'
            OR c.relname = 'executable_runtime_current_binding')
    UNION ALL
    SELECT p.proname
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND (p.proname LIKE 'outcome\_coordinator\_%'
            OR p.proname IN ('outcome_advance_coordinator_clock', 'outcome_append_coordinator_event',
              'outcome_apply_coordinator_failure', 'outcome_claim_next_coordination',
              'outcome_decide_coordinator_owner_request', 'outcome_deliver_coordinator_wake',
              'outcome_reconcile_active_obligations', 'outcome_record_coordinator_result',
              'outcome_register_coordinator_obligation', 'outcome_renew_coordinator_lease',
              'outcome_request_coordinator_owner_decision', 'outcome_schedule_coordinator_wake',
              'outcome_sweep_coordinator', 'outcome_terminalize_coordination',
              'executable_runtime_register_current_binding',
              'executable_runtime_append_current_heartbeat'))
    UNION ALL
    SELECT 'schema:' || nspname FROM pg_namespace WHERE nspname = 'outcome_watchdog'
    UNION ALL
    SELECT 'column:' || a.attname
      FROM pg_attribute a
     WHERE a.attrelid = 'executable_runtime_heartbeat'::regclass AND NOT a.attisdropped
       AND a.attname IN ('runtime_binding_digest', 'runtime_binding_logical_time')
  ) survivors;
  IF leftover IS NOT NULL THEN
    RAISE EXCEPTION 'WATCHDOG_COORDINATOR_REMOVAL_INCOMPLETE: %', leftover;
  END IF;

  SELECT string_agg(n.nspname || '.' || p.proname, ', ' ORDER BY p.proname) INTO leftover
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
     AND p.prokind IN ('f', 'p')
     AND (pg_get_functiondef(p.oid) LIKE '%outcome\_coordinator\_%'
          OR pg_get_functiondef(p.oid) LIKE '%outcome\_watchdog.%'
          OR pg_get_functiondef(p.oid) LIKE '%executable\_runtime\_binding%'
          OR pg_get_functiondef(p.oid) LIKE '%executable\_runtime\_current\_binding%');
  IF leftover IS NOT NULL THEN
    RAISE EXCEPTION 'WATCHDOG_COORDINATOR_REMOVAL_LEFT_DANGLING_CALLERS: %', leftover;
  END IF;

  PERFORM executable_runtime_sanitize_metadata('{"token": "abc", "note": "Bearer xyzxyzxyzxyz"}'::jsonb);
  PERFORM executable_runtime_overlay_read_surface('{"surface": "DONE_GATE"}'::jsonb, 'DONE_GATE');
END $$;
