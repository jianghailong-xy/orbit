-- Outcome Reconciler V2: independent watchdog, SLO evidence and bounded security ingress.
--
-- This schema has no write dependency on the reconciler, projection reducer or coordinator.  Its
-- collector reads their durable ledgers directly and writes an append-only sample.  A stopped
-- reducer therefore cannot stop, rewrite or make the watchdog observation look current.
BEGIN;

CREATE SCHEMA outcome_watchdog;
REVOKE CREATE ON SCHEMA outcome_watchdog FROM PUBLIC;

-- The bounded probes below are deliberately backed by indexes owned by the source ledgers.  They
-- never call a reconciler function and each fetches at most the policy's maximumRowsPerProbe.
CREATE INDEX outcome_fact_stream_watchdog_recent_idx
  ON outcome_fact_stream (tenant_id, updated_at DESC, project_id)
  INCLUDE (last_logical_time);
CREATE INDEX outcome_coordinator_watchdog_lease_idx
  ON outcome_coordinator_obligation (
    tenant_id, status, lease_expires_logical_time, project_id, coordination_id
  ) WHERE status = 'CLAIMED';
CREATE INDEX outcome_coordinator_watchdog_active_idx
  ON outcome_coordinator_obligation (
    tenant_id, last_progress_logical_time, project_id, coordination_id
  ) INCLUDE (status, progress_deadline_logical_time)
  WHERE status IN ('READY', 'CLAIMED', 'SCHEDULED', 'EXTERNAL_WAIT', 'OWNER_DECISION');
CREATE INDEX outcome_coordinator_attempt_result_watchdog_idx
  ON outcome_coordinator_attempt_result (tenant_id, logical_time DESC, result, result_id);
CREATE INDEX outcome_projection_reconciler_watchdog_sample_idx
  ON outcome_projection.reconciler_state (
    tenant_id, written_at, project_id, subject_type, subject_id
  ) INCLUDE (
    evaluated_through_logical_time, projection_checksum, semantic_checksum, binding_digest
  );

CREATE OR REPLACE FUNCTION outcome_watchdog.redact_text(p_value text) RETURNS text AS $$
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

CREATE OR REPLACE FUNCTION outcome_watchdog.redact_raw_output(p_value text) RETURNS text AS $$
DECLARE
  result text := outcome_watchdog.redact_text(p_value);
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

CREATE OR REPLACE FUNCTION outcome_watchdog.secure_raw_output(p_value text) RETURNS jsonb AS $$
DECLARE
  secured text := outcome_watchdog.redact_raw_output(p_value);
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

CREATE OR REPLACE FUNCTION outcome_watchdog.redact_json(p_value jsonb) RETURNS jsonb AS $$
  SELECT CASE jsonb_typeof(p_value)
    WHEN 'object' THEN COALESCE((
      SELECT jsonb_object_agg(entry.key,
        CASE
          WHEN entry.key ~* '(authorization|cookie|token|secret|password|private[_-]?key|api[_-]?key|credential)'
            THEN to_jsonb('[REDACTED]'::text)
          WHEN entry.key ~* '^(rawCommandOutput|commandOutput|stdout|stderr)$'
               AND jsonb_typeof(entry.value) = 'string'
            THEN outcome_watchdog.secure_raw_output(entry.value #>> '{}')
          ELSE outcome_watchdog.redact_json(entry.value)
        END ORDER BY entry.key)
        FROM jsonb_each(p_value) entry
    ), '{}'::jsonb)
    WHEN 'array' THEN COALESCE((
      SELECT jsonb_agg(outcome_watchdog.redact_json(item.value) ORDER BY item.ordinality)
        FROM jsonb_array_elements(p_value) WITH ORDINALITY item(value, ordinality)
    ), '[]'::jsonb)
    WHEN 'string' THEN to_jsonb(outcome_watchdog.redact_text(p_value #>> '{}'))
    ELSE p_value
  END
$$ LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE;

CREATE OR REPLACE FUNCTION outcome_watchdog.sanitize_payload(p_payload jsonb) RETURNS jsonb AS $$
DECLARE
  sanitized jsonb;
BEGIN
  IF p_payload IS NULL OR octet_length(p_payload::text) > 65536 THEN
    RAISE EXCEPTION 'OUTCOME_WATCHDOG_PAYLOAD_TOO_LARGE'
      USING ERRCODE = '22001', DETAIL = 'maximum canonical JSON payload is 65536 bytes';
  END IF;
  sanitized := outcome_watchdog.redact_json(p_payload);
  IF octet_length(sanitized::text) > 65536 THEN
    RAISE EXCEPTION 'OUTCOME_WATCHDOG_SANITIZED_PAYLOAD_TOO_LARGE'
      USING ERRCODE = '22001';
  END IF;
  RETURN sanitized;
END;
$$ LANGUAGE plpgsql IMMUTABLE STRICT PARALLEL SAFE;

CREATE OR REPLACE FUNCTION outcome_watchdog.assert_authorized_project(
  p_authenticated_tenant uuid,
  p_tenant_id uuid,
  p_project_id uuid
) RETURNS void AS $$
BEGIN
  IF p_authenticated_tenant IS NULL OR p_authenticated_tenant <> p_tenant_id THEN
    RAISE EXCEPTION 'OUTCOME_WATCHDOG_TENANT_FORBIDDEN'
      USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM outcome_fact_stream
     WHERE tenant_id = p_tenant_id AND project_id = p_project_id
  ) THEN
    RAISE EXCEPTION 'OUTCOME_WATCHDOG_PROJECT_NOT_FOUND'
      USING ERRCODE = 'P0002';
  END IF;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER
   SET search_path = pg_catalog, public, outcome_watchdog;

CREATE TABLE outcome_watchdog.inbox (
  inbox_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  project_id uuid NOT NULL,
  event_key text NOT NULL CHECK (event_key <> ''),
  source_outbox_id bigint,
  state text NOT NULL DEFAULT 'RECEIVED' CHECK (state IN ('RECEIVED', 'PROCESSED', 'DEAD')),
  payload jsonb NOT NULL,
  payload_digest char(64) NOT NULL CHECK (outcome_valid_digest(payload_digest)),
  payload_bytes integer NOT NULL CHECK (payload_bytes BETWEEN 1 AND 65536),
  received_logical_time bigint NOT NULL CHECK (received_logical_time >= 0),
  received_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  processed_at timestamptz,
  UNIQUE (tenant_id, event_key),
  CHECK (payload_digest = outcome_sha256_json(payload)),
  CHECK (payload_bytes = octet_length(payload::text)),
  CHECK ((state = 'RECEIVED') = (processed_at IS NULL)),
  FOREIGN KEY (tenant_id, project_id) REFERENCES outcome_fact_stream(tenant_id, project_id)
);
CREATE INDEX outcome_watchdog_inbox_pending_idx
  ON outcome_watchdog.inbox (tenant_id, state, received_at, inbox_id)
  INCLUDE (project_id, received_logical_time, payload_digest);
CREATE UNIQUE INDEX outcome_watchdog_inbox_outbox_idx
  ON outcome_watchdog.inbox (tenant_id, source_outbox_id)
  WHERE source_outbox_id IS NOT NULL;

CREATE TABLE outcome_watchdog.evidence (
  evidence_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  project_id uuid NOT NULL,
  evidence_key text NOT NULL CHECK (evidence_key <> ''),
  evidence_kind text NOT NULL CHECK (evidence_kind <> ''),
  window_spec jsonb NOT NULL CHECK (jsonb_typeof(window_spec) = 'object'),
  denominator text NOT NULL CHECK (btrim(denominator) <> ''),
  min_sample_size integer NOT NULL CHECK (min_sample_size > 0),
  collector_sha char(40) NOT NULL CHECK (collector_sha ~ '^[0-9a-f]{40}$'),
  target_sha char(40) NOT NULL CHECK (target_sha ~ '^[0-9a-f]{40}$'),
  payload jsonb NOT NULL,
  payload_digest char(64) NOT NULL CHECK (outcome_valid_digest(payload_digest)),
  payload_bytes integer NOT NULL CHECK (payload_bytes BETWEEN 1 AND 65536),
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (tenant_id, project_id, evidence_key),
  CHECK (payload_digest = outcome_sha256_json(payload)),
  CHECK (payload_bytes = octet_length(payload::text)),
  FOREIGN KEY (tenant_id, project_id) REFERENCES outcome_fact_stream(tenant_id, project_id)
);
CREATE INDEX outcome_watchdog_evidence_tenant_idx
  ON outcome_watchdog.evidence (tenant_id, project_id, recorded_at DESC, evidence_id);

CREATE TABLE outcome_watchdog.sample (
  sample_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sample_sequence bigint GENERATED ALWAYS AS IDENTITY,
  tenant_id uuid NOT NULL,
  observed_logical_time bigint NOT NULL CHECK (observed_logical_time >= 0),
  observed_at timestamptz NOT NULL,
  window_started_at timestamptz NOT NULL,
  window_seconds integer NOT NULL CHECK (window_seconds > 0),
  window_logical_ticks bigint NOT NULL CHECK (window_logical_ticks > 0),
  collector_sha char(40) NOT NULL CHECK (collector_sha ~ '^[0-9a-f]{40}$'),
  target_sha char(40) NOT NULL CHECK (target_sha ~ '^[0-9a-f]{40}$'),
  policy_digest char(64) NOT NULL CHECK (outcome_valid_digest(policy_digest)),
  projection_status text NOT NULL CHECK (projection_status IN ('CURRENT', 'RECONCILER_STALE')),
  metrics jsonb NOT NULL CHECK (jsonb_typeof(metrics) = 'object'),
  snapshot jsonb NOT NULL CHECK (jsonb_typeof(snapshot) = 'object'),
  alerts jsonb NOT NULL CHECK (jsonb_typeof(alerts) = 'array'),
  sample_digest char(64) NOT NULL CHECK (outcome_valid_digest(sample_digest)),
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (sample_digest = outcome_sha256_json(jsonb_build_object(
    'tenantId', tenant_id::text,
    'observedLogicalTime', observed_logical_time::text,
    'observedAt', to_char(observed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    'collectorSha', collector_sha::text,
    'targetSha', target_sha::text,
    'policyDigest', policy_digest::text,
    'projectionStatus', projection_status,
    'metrics', metrics,
    'snapshot', snapshot,
    'alerts', alerts
  )))
);
CREATE UNIQUE INDEX outcome_watchdog_sample_replay_idx
  ON outcome_watchdog.sample (tenant_id, collector_sha, target_sha, sample_sequence)
  INCLUDE (sample_digest, projection_status);

CREATE TRIGGER outcome_watchdog_evidence_append_only
  BEFORE UPDATE OR DELETE ON outcome_watchdog.evidence
  FOR EACH ROW EXECUTE FUNCTION outcome_append_only_guard();
CREATE TRIGGER outcome_watchdog_sample_append_only
  BEFORE UPDATE OR DELETE ON outcome_watchdog.sample
  FOR EACH ROW EXECUTE FUNCTION outcome_append_only_guard();

CREATE OR REPLACE FUNCTION outcome_watchdog.ingest_inbox(
  p_authenticated_tenant uuid,
  p_tenant_id uuid,
  p_project_id uuid,
  p_event_key text,
  p_payload jsonb,
  p_received_logical_time bigint
) RETURNS jsonb AS $$
DECLARE
  sanitized jsonb;
  digest_value text;
  outbox_id_value bigint;
  standing outcome_watchdog.inbox%ROWTYPE;
BEGIN
  PERFORM outcome_watchdog.assert_authorized_project(
    p_authenticated_tenant, p_tenant_id, p_project_id
  );
  IF COALESCE(p_event_key, '') = '' OR p_received_logical_time < 0 THEN
    RAISE EXCEPTION 'OUTCOME_WATCHDOG_INBOX_ARGUMENT_INVALID' USING ERRCODE = '22023';
  END IF;
  sanitized := outcome_watchdog.sanitize_payload(p_payload);
  digest_value := outcome_sha256_json(sanitized);
  SELECT outbox_id INTO outbox_id_value
    FROM outcome_projection.outbox
   WHERE tenant_id = p_tenant_id AND project_id = p_project_id
     AND event_key::text = p_event_key
   LIMIT 1;
  INSERT INTO outcome_watchdog.inbox (
    tenant_id, project_id, event_key, source_outbox_id, payload, payload_digest,
    payload_bytes, received_logical_time
  ) VALUES (
    p_tenant_id, p_project_id, p_event_key, outbox_id_value, sanitized, digest_value,
    octet_length(sanitized::text), p_received_logical_time
  ) ON CONFLICT (tenant_id, event_key) DO NOTHING;
  SELECT * INTO standing FROM outcome_watchdog.inbox
   WHERE tenant_id = p_tenant_id AND event_key = p_event_key;
  IF standing.project_id <> p_project_id OR standing.payload_digest::text <> digest_value THEN
    RAISE EXCEPTION 'OUTCOME_WATCHDOG_INBOX_IDEMPOTENCY_CONFLICT' USING ERRCODE = '23505';
  END IF;
  RETURN jsonb_build_object(
    'inboxId', standing.inbox_id::text,
    'tenantId', standing.tenant_id::text,
    'projectId', standing.project_id::text,
    'state', standing.state,
    'payload', standing.payload,
    'payloadDigest', standing.payload_digest::text,
    'payloadBytes', standing.payload_bytes,
    'sourceOutboxId', standing.source_outbox_id
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER
   SET search_path = pg_catalog, public, outcome_watchdog, outcome_projection;

CREATE OR REPLACE FUNCTION outcome_watchdog.complete_inbox(
  p_authenticated_tenant uuid,
  p_tenant_id uuid,
  p_inbox_id uuid,
  p_state text DEFAULT 'PROCESSED'
) RETURNS jsonb AS $$
DECLARE
  standing outcome_watchdog.inbox%ROWTYPE;
BEGIN
  IF p_authenticated_tenant IS NULL OR p_authenticated_tenant <> p_tenant_id THEN
    RAISE EXCEPTION 'OUTCOME_WATCHDOG_TENANT_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  IF p_state NOT IN ('PROCESSED', 'DEAD') THEN
    RAISE EXCEPTION 'OUTCOME_WATCHDOG_INBOX_STATE_INVALID' USING ERRCODE = '22023';
  END IF;
  UPDATE outcome_watchdog.inbox
     SET state = p_state, processed_at = COALESCE(processed_at, clock_timestamp())
   WHERE tenant_id = p_tenant_id AND inbox_id = p_inbox_id
   RETURNING * INTO standing;
  IF NOT FOUND THEN RAISE EXCEPTION 'OUTCOME_WATCHDOG_INBOX_NOT_FOUND' USING ERRCODE = 'P0002'; END IF;
  RETURN jsonb_build_object('inboxId', standing.inbox_id::text, 'state', standing.state);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER
   SET search_path = pg_catalog, public, outcome_watchdog;

-- SQL CASE cannot RAISE, so authorization failures use this deliberately non-returning helper.
CREATE OR REPLACE FUNCTION outcome_watchdog.raise_tenant_forbidden() RETURNS jsonb AS $$
BEGIN
  RAISE EXCEPTION 'OUTCOME_WATCHDOG_TENANT_FORBIDDEN' USING ERRCODE = '42501';
END;
$$ LANGUAGE plpgsql VOLATILE;

-- Re-create after the helper exists (PostgreSQL resolves function references at CREATE time).
CREATE OR REPLACE FUNCTION outcome_watchdog.read_inbox(
  p_authenticated_tenant uuid,
  p_tenant_id uuid,
  p_inbox_id uuid
) RETURNS jsonb AS $$
  SELECT CASE
    WHEN p_authenticated_tenant IS NULL OR p_authenticated_tenant <> p_tenant_id
      THEN outcome_watchdog.raise_tenant_forbidden()
    ELSE (
      SELECT jsonb_build_object(
        'inboxId', inbox_id::text, 'tenantId', tenant_id::text,
        'projectId', project_id::text, 'state', state, 'payload', payload,
        'payloadDigest', payload_digest::text, 'payloadBytes', payload_bytes
      ) FROM outcome_watchdog.inbox
       WHERE tenant_id = p_tenant_id AND inbox_id = p_inbox_id
    )
  END
$$ LANGUAGE sql STABLE SECURITY DEFINER
   SET search_path = pg_catalog, public, outcome_watchdog;

CREATE OR REPLACE FUNCTION outcome_watchdog.submit_evidence(
  p_authenticated_tenant uuid,
  p_tenant_id uuid,
  p_project_id uuid,
  p_evidence_key text,
  p_evidence_kind text,
  p_window_spec jsonb,
  p_denominator text,
  p_min_sample_size integer,
  p_collector_sha text,
  p_target_sha text,
  p_payload jsonb
) RETURNS jsonb AS $$
DECLARE
  sanitized jsonb;
  digest_value text;
  standing outcome_watchdog.evidence%ROWTYPE;
BEGIN
  PERFORM outcome_watchdog.assert_authorized_project(
    p_authenticated_tenant, p_tenant_id, p_project_id
  );
  IF COALESCE(p_evidence_key, '') = '' OR COALESCE(p_evidence_kind, '') = ''
     OR jsonb_typeof(p_window_spec) <> 'object'
     OR NOT (p_window_spec ? 'seconds' AND p_window_spec ? 'logicalTicks')
     OR COALESCE(btrim(p_denominator), '') = '' OR p_min_sample_size < 1
     OR p_collector_sha !~ '^[0-9a-f]{40}$' OR p_target_sha !~ '^[0-9a-f]{40}$' THEN
    RAISE EXCEPTION 'OUTCOME_WATCHDOG_EVIDENCE_CONTRACT_INVALID' USING ERRCODE = '22023';
  END IF;
  sanitized := outcome_watchdog.sanitize_payload(p_payload);
  digest_value := outcome_sha256_json(sanitized);
  INSERT INTO outcome_watchdog.evidence (
    tenant_id, project_id, evidence_key, evidence_kind, window_spec, denominator,
    min_sample_size, collector_sha, target_sha, payload, payload_digest, payload_bytes
  ) VALUES (
    p_tenant_id, p_project_id, p_evidence_key, p_evidence_kind, p_window_spec,
    p_denominator, p_min_sample_size, p_collector_sha, p_target_sha, sanitized,
    digest_value, octet_length(sanitized::text)
  ) ON CONFLICT (tenant_id, project_id, evidence_key) DO NOTHING;
  SELECT * INTO standing FROM outcome_watchdog.evidence
   WHERE tenant_id = p_tenant_id AND project_id = p_project_id
     AND evidence_key = p_evidence_key;
  IF standing.payload_digest::text <> digest_value
     OR standing.collector_sha::text <> p_collector_sha
     OR standing.target_sha::text <> p_target_sha THEN
    RAISE EXCEPTION 'OUTCOME_WATCHDOG_EVIDENCE_IDEMPOTENCY_CONFLICT' USING ERRCODE = '23505';
  END IF;
  RETURN jsonb_build_object(
    'evidenceId', standing.evidence_id::text,
    'tenantId', standing.tenant_id::text,
    'projectId', standing.project_id::text,
    'payload', standing.payload,
    'payloadDigest', standing.payload_digest::text,
    'payloadBytes', standing.payload_bytes,
    'collectorSha', standing.collector_sha::text,
    'targetSha', standing.target_sha::text
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER
   SET search_path = pg_catalog, public, outcome_watchdog;

CREATE OR REPLACE FUNCTION outcome_watchdog.subject_checksum_status(
  p_tenant_id uuid,
  p_project_id uuid,
  p_subject_type text,
  p_subject_id text
) RETURNS text AS $$
DECLARE
  state_row outcome_projection.reconciler_state%ROWTYPE;
  stream_head bigint;
  current_binding text;
  rowset_checksum text;
  proof_checksum text;
  gate_checksum text;
  actual_projection text;
  surface_count integer;
  surfaces_match boolean;
BEGIN
  SELECT * INTO state_row FROM outcome_projection.reconciler_state
   WHERE tenant_id = p_tenant_id AND project_id = p_project_id
     AND subject_type = p_subject_type AND subject_id = p_subject_id;
  IF NOT FOUND THEN RETURN 'MISSING'; END IF;
  SELECT s.last_logical_time, b.binding_digest::text INTO stream_head, current_binding
    FROM outcome_fact_stream s
    JOIN LATERAL (
      SELECT binding_digest FROM outcome_fact_binding b
       WHERE b.tenant_id = s.tenant_id AND b.project_id = s.project_id
       ORDER BY binding_epoch DESC LIMIT 1
    ) b ON true
   WHERE s.tenant_id = p_tenant_id AND s.project_id = p_project_id;
  IF stream_head IS DISTINCT FROM state_row.evaluated_through_logical_time
     OR current_binding IS DISTINCT FROM state_row.binding_digest::text THEN
    RETURN 'RECONCILER_STALE';
  END IF;
  SELECT outcome_sha256_json(COALESCE(jsonb_agg(o.obligation ORDER BY o.obligation_id), '[]'::jsonb))
    INTO rowset_checksum
    FROM outcome_projection.obligation o
   WHERE o.tenant_id = p_tenant_id AND o.project_id = p_project_id
     AND o.subject_type = p_subject_type AND o.subject_id = p_subject_id;
  SELECT outcome_sha256_json(jsonb_build_object('proof', p.proof, 'proofGraph', p.proof_graph))
    INTO proof_checksum
    FROM outcome_projection.proof p
   WHERE p.tenant_id = p_tenant_id AND p.project_id = p_project_id
     AND p.subject_type = p_subject_type AND p.subject_id = p_subject_id;
  SELECT outcome_sha256_json(d.gate) INTO gate_checksum
    FROM outcome_projection.done_gate d
   WHERE d.tenant_id = p_tenant_id AND d.project_id = p_project_id
     AND d.subject_type = p_subject_type AND d.subject_id = p_subject_id;
  IF proof_checksum IS NULL OR gate_checksum IS NULL THEN RETURN 'CHECKSUM_MISMATCH'; END IF;
  actual_projection := outcome_projection.projection_checksum_value(
    state_row.projection_schema_version, state_row.binding_digest::text,
    state_row.evaluated_through_logical_time, rowset_checksum, proof_checksum, gate_checksum
  );
  SELECT count(*)::integer,
         bool_and(r.semantic_checksum = state_row.semantic_checksum)
    INTO surface_count, surfaces_match
    FROM outcome_projection.read_model r
   WHERE r.tenant_id = p_tenant_id AND r.project_id = p_project_id
     AND r.subject_type = p_subject_type AND r.subject_id = p_subject_id;
  IF actual_projection IS DISTINCT FROM state_row.projection_checksum::text
     OR surface_count <> 6 OR NOT COALESCE(surfaces_match, false) THEN
    RETURN 'CHECKSUM_MISMATCH';
  END IF;
  RETURN 'MATCH';
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER
   SET search_path = pg_catalog, public, outcome_watchdog, outcome_projection;

CREATE OR REPLACE FUNCTION outcome_watchdog.collect(
  p_authenticated_tenant uuid,
  p_tenant_id uuid,
  p_policy jsonb,
  p_collector_sha text,
  p_target_sha text,
  p_observed_at timestamptz DEFAULT clock_timestamp()
) RETURNS jsonb AS $$
DECLARE
  logical_now bigint;
  row_limit integer;
  checksum_limit integer;
  window_seconds integer;
  window_ticks bigint;
  watermark_limit bigint;
  active_limit bigint;
  outbox_age_limit numeric;
  inbox_age_limit numeric;
  retry_ratio_limit numeric;
  retry_cost_limit numeric;
  streams_examined integer := 0;
  watermark_lag bigint := 0;
  active_examined integer := 0;
  oldest_active bigint := 0;
  expired_examined integer := 0;
  expired_count integer := 0;
  dead_examined integer := 0;
  dead_count integer := 0;
  outbox_examined integer := 0;
  outbox_count integer := 0;
  oldest_outbox numeric := 0;
  scheduler_examined integer := 0;
  scheduler_starved integer := 0;
  retry_total integer := 0;
  retry_count integer := 0;
  retry_cost numeric := 0;
  inbox_examined integer := 0;
  inbox_count integer := 0;
  oldest_inbox numeric := 0;
  checksum_examined integer := 0;
  checksum_mismatch integer := 0;
  snapshot_value jsonb;
  metrics_value jsonb;
  alerts_value jsonb := '[]'::jsonb;
  projection_status_value text := 'CURRENT';
  policy_digest_value text;
  sample_digest_value text;
  sample_row outcome_watchdog.sample%ROWTYPE;
  retry_ratio numeric;
BEGIN
  IF p_authenticated_tenant IS NULL OR p_authenticated_tenant <> p_tenant_id THEN
    RAISE EXCEPTION 'OUTCOME_WATCHDOG_TENANT_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  IF p_collector_sha !~ '^[0-9a-f]{40}$' OR p_target_sha !~ '^[0-9a-f]{40}$' THEN
    RAISE EXCEPTION 'OUTCOME_WATCHDOG_RUNTIME_SHA_REQUIRED' USING ERRCODE = '22023';
  END IF;
  IF COALESCE((p_policy->>'schemaVersion')::integer, 0) <> 1
     OR jsonb_typeof(p_policy->'metrics') <> 'object'
     OR (SELECT count(*) FROM jsonb_object_keys(p_policy->'metrics')) < 9 THEN
    RAISE EXCEPTION 'OUTCOME_WATCHDOG_POLICY_INVALID' USING ERRCODE = '22023';
  END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_each(p_policy->'metrics') metric
     WHERE jsonb_typeof(metric.value->'window') <> 'object'
        OR COALESCE(metric.value->>'denominator', '') = ''
        OR COALESCE((metric.value->>'minSampleSize')::integer, 0) < 1
        OR metric.value->>'collectorSha' <> 'RUNTIME_REQUIRED'
        OR metric.value->>'targetSha' <> 'RUNTIME_REQUIRED'
        OR jsonb_typeof(metric.value->'abortThreshold') <> 'object'
  ) THEN
    RAISE EXCEPTION 'OUTCOME_WATCHDOG_METRIC_CONTRACT_INVALID' USING ERRCODE = '22023';
  END IF;
  row_limit := LEAST(GREATEST((p_policy#>>'{collector,maximumRowsPerProbe}')::integer, 2), 1024);
  checksum_limit := LEAST(GREATEST((p_policy#>>'{collector,checksumSubjectsPerProbe}')::integer, 1), 256);
  window_seconds := (p_policy#>>'{metrics,retryCost,window,seconds}')::integer;
  window_ticks := (p_policy#>>'{metrics,retryCost,window,logicalTicks}')::bigint;
  watermark_limit := (p_policy#>>'{metrics,evaluatedThroughWatermarkLag,threshold,maximumLogicalTicks}')::bigint;
  active_limit := (p_policy#>>'{metrics,oldestActiveObligation,threshold,maximumLogicalTicksWithoutProgress}')::bigint;
  outbox_age_limit := (p_policy#>>'{metrics,outboxBacklog,threshold,maximumOldestAgeSeconds}')::numeric;
  inbox_age_limit := (p_policy#>>'{metrics,inboxAge,threshold,maximumOldestAgeSeconds}')::numeric;
  retry_ratio_limit := (p_policy#>>'{metrics,retryCost,threshold,maximumRetryRatio}')::numeric;
  retry_cost_limit := (p_policy#>>'{metrics,retryCost,threshold,maximumRetryCostUnits}')::numeric;
  IF row_limit IS NULL OR checksum_limit IS NULL OR window_seconds <= 0 OR window_ticks <= 0 THEN
    RAISE EXCEPTION 'OUTCOME_WATCHDOG_POLICY_BOUND_INVALID' USING ERRCODE = '22023';
  END IF;
  SELECT COALESCE(c.logical_time, (
    SELECT max(last_logical_time) FROM outcome_fact_stream WHERE tenant_id = p_tenant_id
  ), 0) INTO logical_now
    FROM (SELECT 1) seed
    LEFT JOIN outcome_coordinator_clock c ON c.tenant_id = p_tenant_id;

  WITH recent AS (
    SELECT s.tenant_id, s.project_id, s.last_logical_time
      FROM outcome_fact_stream s
     WHERE s.tenant_id = p_tenant_id
     ORDER BY s.updated_at DESC, s.project_id
     LIMIT row_limit
  ), lagged AS (
    SELECT recent.*,
           (SELECT min(r.evaluated_through_logical_time)
              FROM outcome_projection.reconciler_state r
             WHERE r.tenant_id = recent.tenant_id AND r.project_id = recent.project_id) AS evaluated
      FROM recent
  )
  SELECT count(*)::integer,
         COALESCE(max(CASE WHEN evaluated IS NULL THEN last_logical_time
                           ELSE GREATEST(last_logical_time - evaluated, 0) END), 0)
    INTO streams_examined, watermark_lag FROM lagged;

  WITH bounded AS (
    SELECT last_progress_logical_time
      FROM outcome_coordinator_obligation
     WHERE tenant_id = p_tenant_id
       AND status IN ('READY', 'CLAIMED', 'SCHEDULED', 'EXTERNAL_WAIT', 'OWNER_DECISION')
     ORDER BY last_progress_logical_time, project_id, coordination_id
     LIMIT row_limit
  ) SELECT count(*)::integer,
           COALESCE(max(GREATEST(logical_now - last_progress_logical_time, 0)), 0)
      INTO active_examined, oldest_active FROM bounded;

  WITH bounded AS (
    SELECT lease_expires_logical_time
      FROM outcome_coordinator_obligation
     WHERE tenant_id = p_tenant_id AND status = 'CLAIMED'
       AND lease_expires_logical_time <= logical_now
     ORDER BY lease_expires_logical_time, project_id, coordination_id
     LIMIT row_limit
  ) SELECT count(*)::integer, count(*)::integer
      INTO expired_examined, expired_count FROM bounded;

  WITH bounded AS (
    SELECT wake_id FROM outcome_coordinator_wake
     WHERE tenant_id = p_tenant_id AND state = 'DEAD'
     ORDER BY due_logical_time, project_id, wake_id LIMIT row_limit
  ) SELECT count(*)::integer, count(*)::integer INTO dead_examined, dead_count FROM bounded;

  WITH bounded AS (
    SELECT o.occurred_at
      FROM outcome_projection.outbox o
      LEFT JOIN outcome_watchdog.inbox i
        ON i.tenant_id = o.tenant_id AND i.source_outbox_id = o.outbox_id
     WHERE o.tenant_id = p_tenant_id AND i.inbox_id IS NULL
     ORDER BY o.outbox_id LIMIT row_limit
  ) SELECT count(*)::integer, count(*)::integer,
           COALESCE(max(GREATEST(extract(epoch FROM (p_observed_at - occurred_at)), 0)), 0)
      INTO outbox_examined, outbox_count, oldest_outbox FROM bounded;

  WITH bounded AS (
    SELECT coordination_id
      FROM outcome_coordinator_obligation
     WHERE tenant_id = p_tenant_id
       AND (status = 'READY' OR (
         status = 'SCHEDULED' AND next_wake_logical_time <= logical_now
       ))
       AND logical_now - last_progress_logical_time > active_limit
     ORDER BY progress_deadline_logical_time, project_id, coordination_id
     LIMIT row_limit
  ) SELECT count(*)::integer, count(*)::integer
      INTO scheduler_examined, scheduler_starved FROM bounded;

  WITH bounded AS (
    SELECT result FROM outcome_coordinator_attempt_result
     WHERE tenant_id = p_tenant_id
       AND logical_time >= GREATEST(logical_now - window_ticks, 0)
     ORDER BY logical_time DESC, result_id LIMIT row_limit
  ) SELECT count(*)::integer,
           count(*) FILTER (WHERE result = 'RETRYABLE_FAILURE')::integer,
           count(*) FILTER (WHERE result = 'RETRYABLE_FAILURE')::numeric
      INTO retry_total, retry_count, retry_cost FROM bounded;
  retry_ratio := CASE WHEN retry_total = 0 THEN 0 ELSE retry_count::numeric / retry_total END;

  WITH bounded AS (
    SELECT received_at FROM outcome_watchdog.inbox
     WHERE tenant_id = p_tenant_id AND state = 'RECEIVED'
     ORDER BY received_at, inbox_id LIMIT row_limit
  ) SELECT count(*)::integer, count(*)::integer,
           COALESCE(max(GREATEST(extract(epoch FROM (p_observed_at - received_at)), 0)), 0)
      INTO inbox_examined, inbox_count, oldest_inbox FROM bounded;

  WITH selected AS (
    SELECT project_id, subject_type, subject_id
      FROM outcome_projection.reconciler_state
     WHERE tenant_id = p_tenant_id
     ORDER BY written_at, project_id, subject_type, subject_id
     LIMIT checksum_limit
  ), checked AS (
    SELECT outcome_watchdog.subject_checksum_status(
      p_tenant_id, project_id, subject_type, subject_id
    ) AS status FROM selected
  ) SELECT count(*)::integer,
           count(*) FILTER (WHERE status = 'CHECKSUM_MISMATCH')::integer
      INTO checksum_examined, checksum_mismatch FROM checked;

  snapshot_value := jsonb_build_object(
    'watermarkLagLogicalTicks', watermark_lag,
    'oldestActiveObligationLogicalTicks', oldest_active,
    'expiredLeaseCount', expired_count,
    'deadLetterCount', dead_count,
    'outboxBacklogCount', outbox_count,
    'oldestOutboxAgeSeconds', round(oldest_outbox, 3),
    'schedulerStarvationCount', scheduler_starved,
    'retryAttempts', retry_count,
    'totalAttempts', retry_total,
    'retryCostUnits', retry_cost,
    'retryRatio', round(retry_ratio, 6),
    'pendingInboxCount', inbox_count,
    'oldestInboxAgeSeconds', round(oldest_inbox, 3),
    'checksumMismatchCount', checksum_mismatch,
    'denominators', jsonb_build_object(
      'canonicalStreamsExamined', streams_examined,
      'activeObligationsExamined', active_examined,
      'claimedLeasesExamined', expired_examined,
      'deadLettersExamined', dead_examined,
      'outboxEventsExamined', outbox_examined,
      'schedulerCandidatesExamined', scheduler_examined,
      'attemptResultsExamined', retry_total,
      'inboxRecordsExamined', inbox_examined,
      'checksumSubjectsExamined', checksum_examined
    ),
    'probeBounds', jsonb_build_object(
      'maximumRowsPerProbe', row_limit,
      'checksumSubjectsPerProbe', checksum_limit
    )
  );
  IF watermark_lag > watermark_limit THEN
    alerts_value := alerts_value || jsonb_build_array(
      jsonb_build_object('code', 'RECONCILER_STOPPED', 'observed', watermark_lag, 'threshold', watermark_limit),
      jsonb_build_object('code', 'PROJECTION_STALE', 'observed', watermark_lag, 'threshold', watermark_limit)
    );
    projection_status_value := 'RECONCILER_STALE';
  END IF;
  IF oldest_active > active_limit THEN alerts_value := alerts_value || jsonb_build_array(
    jsonb_build_object('code', 'OLDEST_ACTIVE_OBLIGATION', 'observed', oldest_active, 'threshold', active_limit)); END IF;
  IF expired_count > 0 THEN alerts_value := alerts_value || jsonb_build_array(
    jsonb_build_object('code', 'LEASE_EXPIRED', 'observed', expired_count, 'threshold', 0)); END IF;
  IF dead_count > 0 THEN alerts_value := alerts_value || jsonb_build_array(
    jsonb_build_object('code', 'DEAD_LETTER_BACKLOG', 'observed', dead_count, 'threshold', 0)); END IF;
  IF outbox_count > 0 AND oldest_outbox > outbox_age_limit THEN alerts_value := alerts_value || jsonb_build_array(
    jsonb_build_object('code', 'OUTBOX_BLOCKED', 'observed', round(oldest_outbox, 3), 'threshold', outbox_age_limit)); END IF;
  IF scheduler_starved > 0 THEN alerts_value := alerts_value || jsonb_build_array(
    jsonb_build_object('code', 'SCHEDULER_STARVATION', 'observed', scheduler_starved, 'threshold', 0)); END IF;
  IF retry_ratio > retry_ratio_limit OR retry_cost > retry_cost_limit THEN alerts_value := alerts_value || jsonb_build_array(
    jsonb_build_object('code', 'RETRY_STORM', 'observedRatio', round(retry_ratio, 6),
      'observedCostUnits', retry_cost, 'ratioThreshold', retry_ratio_limit,
      'costThreshold', retry_cost_limit)); END IF;
  IF inbox_count > 0 AND oldest_inbox > inbox_age_limit THEN alerts_value := alerts_value || jsonb_build_array(
    jsonb_build_object('code', 'INBOX_STALE', 'observed', round(oldest_inbox, 3), 'threshold', inbox_age_limit)); END IF;
  IF checksum_mismatch > 0 THEN
    alerts_value := alerts_value || jsonb_build_array(
      jsonb_build_object('code', 'CHECKSUM_DRIFT', 'observed', checksum_mismatch, 'threshold', 0));
    projection_status_value := 'RECONCILER_STALE';
  END IF;

  SELECT jsonb_object_agg(metric.key,
    metric.value || jsonb_build_object(
      'collectorSha', p_collector_sha,
      'targetSha', p_target_sha,
      'sampleObservedAt', to_jsonb(p_observed_at),
      'sampleObservedLogicalTime', logical_now::text
    ) ORDER BY metric.key)
    INTO metrics_value FROM jsonb_each(p_policy->'metrics') metric;
  policy_digest_value := outcome_sha256_json(p_policy);
  sample_digest_value := outcome_sha256_json(jsonb_build_object(
    'tenantId', p_tenant_id::text,
    'observedLogicalTime', logical_now::text,
    'observedAt', to_char(p_observed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    'collectorSha', p_collector_sha,
    'targetSha', p_target_sha,
    'policyDigest', policy_digest_value,
    'projectionStatus', projection_status_value,
    'metrics', metrics_value,
    'snapshot', snapshot_value,
    'alerts', alerts_value
  ));
  INSERT INTO outcome_watchdog.sample (
    tenant_id, observed_logical_time, observed_at, window_started_at, window_seconds,
    window_logical_ticks, collector_sha, target_sha, policy_digest, projection_status,
    metrics, snapshot, alerts, sample_digest
  ) VALUES (
    p_tenant_id, logical_now, p_observed_at,
    p_observed_at - make_interval(secs => window_seconds), window_seconds, window_ticks,
    p_collector_sha, p_target_sha, policy_digest_value, projection_status_value,
    metrics_value, snapshot_value, alerts_value, sample_digest_value
  ) RETURNING * INTO sample_row;
  RETURN jsonb_build_object(
    'sampleId', sample_row.sample_id::text,
    'sampleSequence', sample_row.sample_sequence::text,
    'tenantId', sample_row.tenant_id::text,
    'observedLogicalTime', sample_row.observed_logical_time::text,
    'observedAt', sample_row.observed_at,
    'collectorSha', sample_row.collector_sha::text,
    'targetSha', sample_row.target_sha::text,
    'projectionStatus', sample_row.projection_status,
    'metrics', sample_row.metrics,
    'snapshot', sample_row.snapshot,
    'alerts', sample_row.alerts,
    'sampleDigest', sample_row.sample_digest::text
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER
   SET search_path = pg_catalog, public, outcome_watchdog, outcome_projection;

CREATE OR REPLACE FUNCTION outcome_watchdog.replay_samples(
  p_authenticated_tenant uuid,
  p_tenant_id uuid,
  p_collector_sha text,
  p_target_sha text
) RETURNS jsonb AS $$
DECLARE
  sample_count bigint;
  stale_count bigint;
  alert_count bigint;
  replay_digest text;
BEGIN
  IF p_authenticated_tenant IS NULL OR p_authenticated_tenant <> p_tenant_id THEN
    RAISE EXCEPTION 'OUTCOME_WATCHDOG_TENANT_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  IF p_collector_sha !~ '^[0-9a-f]{40}$' OR p_target_sha !~ '^[0-9a-f]{40}$' THEN
    RAISE EXCEPTION 'OUTCOME_WATCHDOG_RUNTIME_SHA_REQUIRED' USING ERRCODE = '22023';
  END IF;
  SELECT count(*), count(*) FILTER (WHERE projection_status = 'RECONCILER_STALE'),
         COALESCE(sum(jsonb_array_length(alerts)), 0),
         encode(digest(COALESCE(string_agg(sample_digest::text, '' ORDER BY sample_sequence), ''),
                       'sha256'), 'hex')
    INTO sample_count, stale_count, alert_count, replay_digest
   FROM outcome_watchdog.sample
   WHERE tenant_id = p_tenant_id
     AND collector_sha = p_collector_sha::char(40)
     AND target_sha = p_target_sha::char(40);
  RETURN jsonb_build_object(
    'sampleCount', sample_count,
    'staleSampleCount', stale_count,
    'alertCount', alert_count,
    'collectorSha', p_collector_sha,
    'targetSha', p_target_sha,
    'replayDigest', replay_digest
  );
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER
   SET search_path = pg_catalog, public, outcome_watchdog;

REVOKE ALL ON ALL TABLES IN SCHEMA outcome_watchdog FROM PUBLIC;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA outcome_watchdog FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA outcome_watchdog FROM PUBLIC;
GRANT USAGE ON SCHEMA outcome_watchdog TO PUBLIC;
GRANT EXECUTE ON FUNCTION outcome_watchdog.ingest_inbox(uuid,uuid,uuid,text,jsonb,bigint) TO PUBLIC;
GRANT EXECUTE ON FUNCTION outcome_watchdog.complete_inbox(uuid,uuid,uuid,text) TO PUBLIC;
GRANT EXECUTE ON FUNCTION outcome_watchdog.read_inbox(uuid,uuid,uuid) TO PUBLIC;
GRANT EXECUTE ON FUNCTION outcome_watchdog.submit_evidence(uuid,uuid,uuid,text,text,jsonb,text,integer,text,text,jsonb) TO PUBLIC;
GRANT EXECUTE ON FUNCTION outcome_watchdog.collect(uuid,uuid,jsonb,text,text,timestamptz) TO PUBLIC;
GRANT EXECUTE ON FUNCTION outcome_watchdog.replay_samples(uuid,uuid,text,text) TO PUBLIC;

COMMENT ON SCHEMA outcome_watchdog IS
  'Independent append-only operational observer; it never calls or writes the outcome reducer.';
COMMENT ON TABLE outcome_watchdog.sample IS
  'Every observation binds windows, denominators and sample requirements to collector/target SHA.';
COMMENT ON TABLE outcome_watchdog.inbox IS
  'Tenant-fenced, size-bounded, redacted delivery inbox; unredacted command output is never stored.';
COMMENT ON TABLE outcome_watchdog.evidence IS
  'Tenant-fenced SLO/canary evidence carrying window, denominator, minimum sample and both SHAs.';
COMMENT ON FUNCTION outcome_watchdog.collect IS
  'Bounded independent probes for lag, liveness, leases, dead letters, outbox, starvation, retries, inbox and drift.';

COMMIT;
