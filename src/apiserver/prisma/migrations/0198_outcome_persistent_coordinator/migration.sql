-- Outcome Reconciler V2: persistent obligation coordinator.
--
-- The mutable obligation row is a rebuildable scheduling projection. Definitions, leases,
-- callbacks and transitions are immutable evidence. Logical time is explicit and persistent;
-- wall time is audit only. Every claim spends finite attempt budget, every wake spends finite wake
-- budget, and lease renewal never advances the liveness watermark.
BEGIN;

CREATE TABLE outcome_coordinator_clock (
  tenant_id uuid PRIMARY KEY,
  clock_id uuid NOT NULL,
  logical_time bigint NOT NULL CHECK (logical_time >= 0),
  advanced_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE outcome_coordinator_obligation_revision (
  tenant_id uuid NOT NULL,
  project_id uuid NOT NULL,
  coordination_revision char(64) NOT NULL CHECK (outcome_valid_digest(coordination_revision)),
  source_type text NOT NULL CHECK (source_type IN ('CANONICAL', 'EXECUTOR')),
  source_key text NOT NULL CHECK (source_key <> ''),
  obligation_id char(64) NOT NULL CHECK (outcome_valid_digest(obligation_id)),
  obligation_revision char(64) NOT NULL CHECK (outcome_valid_digest(obligation_revision)),
  binding_digest char(64) NOT NULL CHECK (outcome_valid_digest(binding_digest)),
  kind text NOT NULL CHECK (kind <> ''),
  requested_owner text NOT NULL CHECK (requested_owner IN ('SYSTEM', 'AGENT', 'OWNER', 'EXTERNAL')),
  capability text NOT NULL CHECK (capability <> ''),
  liveness_delta bigint NOT NULL CHECK (liveness_delta > 0),
  attempt_budget integer NOT NULL CHECK (attempt_budget > 0),
  wake_budget integer NOT NULL CHECK (wake_budget > 0),
  same_failure_fingerprint_limit integer NOT NULL CHECK (same_failure_fingerprint_limit > 0),
  max_lease_renewals integer NOT NULL CHECK (max_lease_renewals >= 0),
  source_obligation jsonb NOT NULL CHECK (jsonb_typeof(source_obligation) = 'object'),
  source_digest char(64) NOT NULL CHECK (outcome_valid_digest(source_digest)),
  created_logical_time bigint NOT NULL CHECK (created_logical_time >= 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, project_id, coordination_revision),
  UNIQUE (tenant_id, project_id, obligation_id, obligation_revision, coordination_revision),
  FOREIGN KEY (tenant_id, project_id)
    REFERENCES outcome_fact_stream(tenant_id, project_id),
  CHECK (source_digest = outcome_sha256_json(source_obligation))
);

CREATE TABLE outcome_coordinator_obligation (
  coordination_id uuid PRIMARY KEY,
  queue_sequence bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  tenant_id uuid NOT NULL,
  project_id uuid NOT NULL,
  coordination_revision char(64) NOT NULL,
  source_type text NOT NULL CHECK (source_type IN ('CANONICAL', 'EXECUTOR')),
  source_key text NOT NULL CHECK (source_key <> ''),
  obligation_id char(64) NOT NULL CHECK (outcome_valid_digest(obligation_id)),
  obligation_revision char(64) NOT NULL CHECK (outcome_valid_digest(obligation_revision)),
  binding_digest char(64) NOT NULL CHECK (outcome_valid_digest(binding_digest)),
  kind text NOT NULL CHECK (kind <> ''),
  capability text NOT NULL CHECK (capability <> ''),
  requested_owner text NOT NULL CHECK (requested_owner IN ('SYSTEM', 'AGENT', 'OWNER', 'EXTERNAL')),
  durable_owner text NOT NULL CHECK (durable_owner IN ('SYSTEM', 'AGENT', 'OWNER')),
  status text NOT NULL CHECK (status IN (
    'READY', 'CLAIMED', 'SCHEDULED', 'EXTERNAL_WAIT', 'OWNER_DECISION',
    'RESOLVED', 'SUPERSEDED', 'ESCALATED', 'TERMINAL'
  )),
  diagnostic_path text NOT NULL DEFAULT 'PRIMARY_RECOVERY' CHECK (diagnostic_path <> ''),
  attempt_budget_max integer NOT NULL CHECK (attempt_budget_max > 0),
  attempt_budget_remaining integer NOT NULL CHECK (
    attempt_budget_remaining >= 0 AND attempt_budget_remaining <= attempt_budget_max
  ),
  wake_budget_max integer NOT NULL CHECK (wake_budget_max > 0),
  wake_budget_remaining integer NOT NULL CHECK (
    wake_budget_remaining >= 0 AND wake_budget_remaining <= wake_budget_max
  ),
  same_failure_fingerprint_limit integer NOT NULL CHECK (same_failure_fingerprint_limit > 0),
  max_lease_renewals integer NOT NULL CHECK (max_lease_renewals >= 0),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  lease_generation bigint NOT NULL DEFAULT 0 CHECK (lease_generation >= 0),
  lease_renewal_count integer NOT NULL DEFAULT 0 CHECK (lease_renewal_count >= 0),
  wake_generation bigint NOT NULL DEFAULT 0 CHECK (wake_generation >= 0),
  liveness_delta bigint NOT NULL CHECK (liveness_delta > 0),
  last_progress_logical_time bigint NOT NULL CHECK (last_progress_logical_time >= 0),
  progress_deadline_logical_time bigint NOT NULL CHECK (
    progress_deadline_logical_time >= last_progress_logical_time
  ),
  next_wake_logical_time bigint,
  lease_id uuid,
  lease_token uuid,
  lease_owner text,
  lease_expires_logical_time bigint,
  action_intent_id uuid,
  decision_request_id uuid,
  external_wait_id uuid,
  terminal_reason text,
  source_obligation jsonb NOT NULL CHECK (jsonb_typeof(source_obligation) = 'object'),
  source_digest char(64) NOT NULL CHECK (outcome_valid_digest(source_digest)),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (tenant_id, project_id, source_type, source_key),
  UNIQUE (tenant_id, project_id, obligation_id),
  FOREIGN KEY (tenant_id, project_id, coordination_revision)
    REFERENCES outcome_coordinator_obligation_revision(tenant_id, project_id, coordination_revision),
  CHECK (source_digest = outcome_sha256_json(source_obligation)),
  CHECK ((status = 'CLAIMED') = (lease_id IS NOT NULL)),
  CHECK ((lease_id IS NULL) = (lease_token IS NULL)),
  CHECK ((lease_id IS NULL) = (lease_owner IS NULL)),
  CHECK ((lease_id IS NULL) = (lease_expires_logical_time IS NULL)),
  CHECK (status NOT IN ('SCHEDULED', 'EXTERNAL_WAIT') OR next_wake_logical_time IS NOT NULL),
  CHECK (status <> 'OWNER_DECISION' OR decision_request_id IS NOT NULL)
);

CREATE INDEX outcome_coordinator_ready_idx
  ON outcome_coordinator_obligation (
    tenant_id, status, project_id, queue_sequence
  );
CREATE INDEX outcome_coordinator_liveness_idx
  ON outcome_coordinator_obligation (
    tenant_id, status, progress_deadline_logical_time, project_id
  );

CREATE TABLE outcome_coordinator_lease (
  lease_id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  project_id uuid NOT NULL,
  coordination_id uuid NOT NULL REFERENCES outcome_coordinator_obligation(coordination_id),
  obligation_revision char(64) NOT NULL CHECK (outcome_valid_digest(obligation_revision)),
  generation bigint NOT NULL CHECK (generation > 0),
  attempt_number integer NOT NULL CHECK (attempt_number > 0),
  worker_id text NOT NULL CHECK (worker_id <> ''),
  lease_token uuid NOT NULL,
  claimed_logical_time bigint NOT NULL CHECK (claimed_logical_time >= 0),
  expires_logical_time bigint NOT NULL CHECK (expires_logical_time > claimed_logical_time),
  claimed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (coordination_id, generation),
  UNIQUE (coordination_id, lease_token)
);

CREATE TABLE outcome_coordinator_wake (
  wake_id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  project_id uuid NOT NULL,
  coordination_id uuid NOT NULL REFERENCES outcome_coordinator_obligation(coordination_id),
  obligation_revision char(64) NOT NULL CHECK (outcome_valid_digest(obligation_revision)),
  generation bigint NOT NULL CHECK (generation > 0),
  clock_id uuid NOT NULL,
  due_logical_time bigint NOT NULL CHECK (due_logical_time >= 0),
  due_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  reason_code text NOT NULL CHECK (reason_code <> ''),
  state text NOT NULL CHECK (state IN ('SCHEDULED', 'DELIVERED', 'CANCELLED', 'DEAD')),
  delivery_attempts integer NOT NULL DEFAULT 0 CHECK (delivery_attempts >= 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (coordination_id, generation)
);

CREATE INDEX outcome_coordinator_wake_due_idx
  ON outcome_coordinator_wake (tenant_id, state, due_logical_time, project_id, wake_id);

CREATE TABLE outcome_coordinator_wake_delivery (
  delivery_id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  project_id uuid NOT NULL,
  wake_id uuid NOT NULL REFERENCES outcome_coordinator_wake(wake_id),
  callback_key text NOT NULL CHECK (callback_key <> ''),
  outcome text NOT NULL CHECK (outcome IN ('DELIVERED', 'DUPLICATE', 'EARLY', 'STALE')),
  logical_time bigint NOT NULL CHECK (logical_time >= 0),
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (tenant_id, callback_key)
);

CREATE TABLE outcome_coordinator_attempt_result (
  result_id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  project_id uuid NOT NULL,
  coordination_id uuid NOT NULL REFERENCES outcome_coordinator_obligation(coordination_id),
  lease_id uuid NOT NULL REFERENCES outcome_coordinator_lease(lease_id),
  obligation_revision char(64) NOT NULL CHECK (outcome_valid_digest(obligation_revision)),
  callback_key text NOT NULL CHECK (callback_key <> ''),
  result text NOT NULL CHECK (result IN (
    'DELIVERED', 'ACTION_ENQUEUED', 'RETRYABLE_FAILURE', 'QUOTA_WAIT', 'EXTERNAL_WAIT',
    'OWNER_DECISION_REQUESTED', 'RESOLVED', 'SUPERSEDED', 'ESCALATED', 'TERMINAL'
  )),
  failure_fingerprint char(64),
  detail jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(detail) = 'object'),
  logical_time bigint NOT NULL CHECK (logical_time >= 0),
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (lease_id),
  UNIQUE (tenant_id, callback_key),
  CHECK (failure_fingerprint IS NULL OR outcome_valid_digest(failure_fingerprint))
);

CREATE TABLE outcome_coordinator_failure_fingerprint (
  tenant_id uuid NOT NULL,
  project_id uuid NOT NULL,
  coordination_id uuid NOT NULL REFERENCES outcome_coordinator_obligation(coordination_id),
  obligation_revision char(64) NOT NULL CHECK (outcome_valid_digest(obligation_revision)),
  failure_fingerprint char(64) NOT NULL CHECK (outcome_valid_digest(failure_fingerprint)),
  occurrence_count integer NOT NULL CHECK (occurrence_count > 0),
  last_logical_time bigint NOT NULL CHECK (last_logical_time >= 0),
  diagnostic_path text NOT NULL CHECK (diagnostic_path <> ''),
  PRIMARY KEY (coordination_id, obligation_revision, failure_fingerprint)
);

CREATE TABLE outcome_coordinator_external_wait (
  wait_id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  project_id uuid NOT NULL,
  coordination_id uuid NOT NULL REFERENCES outcome_coordinator_obligation(coordination_id),
  obligation_revision char(64) NOT NULL CHECK (outcome_valid_digest(obligation_revision)),
  provider text NOT NULL CHECK (provider <> ''),
  condition jsonb NOT NULL,
  condition_digest char(64) NOT NULL CHECK (outcome_valid_digest(condition_digest)),
  poll_budget_max integer NOT NULL CHECK (poll_budget_max > 0),
  poll_budget_remaining integer NOT NULL CHECK (
    poll_budget_remaining >= 0 AND poll_budget_remaining <= poll_budget_max
  ),
  next_poll_logical_time bigint NOT NULL CHECK (next_poll_logical_time >= 0),
  state text NOT NULL CHECK (state IN ('ACTIVE', 'SATISFIED', 'EXHAUSTED', 'SUPERSEDED')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (coordination_id, obligation_revision, condition_digest),
  CHECK (condition_digest = outcome_sha256_json(condition))
);

CREATE TABLE outcome_coordinator_owner_decision_request (
  request_id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  project_id uuid NOT NULL,
  coordination_id uuid NOT NULL REFERENCES outcome_coordinator_obligation(coordination_id),
  obligation_revision char(64) NOT NULL CHECK (outcome_valid_digest(obligation_revision)),
  reason text NOT NULL CHECK (reason IN (
    'GOAL_DECISION', 'RISK_ACCEPTANCE', 'NEW_AUTHORIZATION', 'EXTERNAL_IDENTITY'
  )),
  why_not_agent text NOT NULL CHECK (btrim(why_not_agent) <> ''),
  idempotency_key text NOT NULL CHECK (idempotency_key <> ''),
  request jsonb NOT NULL CHECK (jsonb_typeof(request) = 'object'),
  request_digest char(64) NOT NULL CHECK (outcome_valid_digest(request_digest)),
  status text NOT NULL CHECK (status IN ('OPEN', 'DECIDED', 'SUPERSEDED')),
  decision jsonb,
  decision_digest char(64),
  decision_idempotency_key text,
  requested_logical_time bigint NOT NULL CHECK (requested_logical_time >= 0),
  decided_logical_time bigint,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  decided_at timestamptz,
  UNIQUE (tenant_id, project_id, idempotency_key),
  CHECK (request_digest = outcome_sha256_json(request)),
  CHECK (decision_digest IS NULL OR outcome_valid_digest(decision_digest)),
  CHECK ((status = 'DECIDED') = (decision IS NOT NULL)),
  CHECK (decision IS NULL OR decision_digest = outcome_sha256_json(decision))
);

CREATE INDEX outcome_coordinator_owner_open_idx
  ON outcome_coordinator_owner_decision_request (tenant_id, status, created_at, request_id);

CREATE TABLE outcome_coordinator_event (
  event_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id uuid NOT NULL,
  project_id uuid NOT NULL,
  coordination_id uuid NOT NULL REFERENCES outcome_coordinator_obligation(coordination_id),
  obligation_revision char(64) NOT NULL CHECK (outcome_valid_digest(obligation_revision)),
  event_key text NOT NULL CHECK (event_key <> ''),
  event_type text NOT NULL CHECK (event_type <> ''),
  from_status text,
  to_status text NOT NULL CHECK (to_status <> ''),
  progress_kind text CHECK (progress_kind IS NULL OR progress_kind IN (
    'VALID_ATTEMPT', 'EXTERNAL_DELIVERY', 'EXTERNAL_WAIT', 'SUPERSEDE', 'ESCALATE',
    'TERMINAL_DISPOSITION', 'OWNER_DECISION_REQUEST'
  )),
  logical_time bigint NOT NULL CHECK (logical_time >= 0),
  failure_fingerprint char(64),
  diagnostic_path text NOT NULL CHECK (diagnostic_path <> ''),
  detail jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(detail) = 'object'),
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (tenant_id, event_key),
  CHECK (failure_fingerprint IS NULL OR outcome_valid_digest(failure_fingerprint))
);

CREATE INDEX outcome_coordinator_event_trace_idx
  ON outcome_coordinator_event (tenant_id, project_id, coordination_id, event_id);
CREATE INDEX outcome_coordinator_event_progress_idx
  ON outcome_coordinator_event (tenant_id, progress_kind, logical_time, coordination_id);

CREATE TABLE outcome_coordinator_scheduler (
  tenant_id uuid PRIMARY KEY,
  dispatch_sequence bigint NOT NULL DEFAULT 0 CHECK (dispatch_sequence >= 0)
);

CREATE TABLE outcome_coordinator_project_fairness (
  tenant_id uuid NOT NULL,
  project_id uuid NOT NULL,
  last_dispatched_sequence bigint NOT NULL CHECK (last_dispatched_sequence > 0),
  dispatch_count bigint NOT NULL CHECK (dispatch_count > 0),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, project_id)
);

CREATE TRIGGER outcome_coordinator_obligation_revision_append_only
  BEFORE UPDATE OR DELETE ON outcome_coordinator_obligation_revision
  FOR EACH ROW EXECUTE FUNCTION outcome_append_only_guard();
CREATE TRIGGER outcome_coordinator_lease_append_only
  BEFORE UPDATE OR DELETE ON outcome_coordinator_lease
  FOR EACH ROW EXECUTE FUNCTION outcome_append_only_guard();
CREATE TRIGGER outcome_coordinator_wake_delivery_append_only
  BEFORE UPDATE OR DELETE ON outcome_coordinator_wake_delivery
  FOR EACH ROW EXECUTE FUNCTION outcome_append_only_guard();
CREATE TRIGGER outcome_coordinator_attempt_result_append_only
  BEFORE UPDATE OR DELETE ON outcome_coordinator_attempt_result
  FOR EACH ROW EXECUTE FUNCTION outcome_append_only_guard();
CREATE TRIGGER outcome_coordinator_event_append_only
  BEFORE UPDATE OR DELETE ON outcome_coordinator_event
  FOR EACH ROW EXECUTE FUNCTION outcome_append_only_guard();

CREATE OR REPLACE FUNCTION outcome_advance_coordinator_clock(
  p_tenant_id uuid,
  p_clock_id uuid,
  p_logical_time bigint
) RETURNS jsonb AS $$
DECLARE
  standing outcome_coordinator_clock%ROWTYPE;
BEGIN
  IF p_tenant_id IS NULL OR p_clock_id IS NULL OR p_logical_time < 0 THEN
    RAISE EXCEPTION 'OUTCOME_COORDINATOR_CLOCK_INVALID' USING ERRCODE = '22023';
  END IF;
  INSERT INTO outcome_coordinator_clock (tenant_id, clock_id, logical_time)
  VALUES (p_tenant_id, p_clock_id, p_logical_time)
  ON CONFLICT (tenant_id) DO NOTHING;
  SELECT * INTO standing
    FROM outcome_coordinator_clock
   WHERE tenant_id = p_tenant_id
   FOR UPDATE;
  IF standing.clock_id IS DISTINCT FROM p_clock_id THEN
    RAISE EXCEPTION 'OUTCOME_COORDINATOR_CLOCK_ID_MISMATCH' USING ERRCODE = '22023';
  END IF;
  IF p_logical_time < standing.logical_time THEN
    RAISE EXCEPTION 'OUTCOME_COORDINATOR_CLOCK_REGRESSION' USING ERRCODE = '22023';
  END IF;
  UPDATE outcome_coordinator_clock
     SET logical_time = p_logical_time, advanced_at = clock_timestamp()
   WHERE tenant_id = p_tenant_id;
  RETURN jsonb_build_object(
    'tenantId', p_tenant_id::text,
    'clockId', p_clock_id::text,
    'logicalTime', p_logical_time::text,
    'replayed', p_logical_time = standing.logical_time
  );
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION outcome_coordinator_now(p_tenant_id uuid) RETURNS bigint AS $$
DECLARE
  value bigint;
BEGIN
  SELECT logical_time INTO value
    FROM outcome_coordinator_clock
   WHERE tenant_id = p_tenant_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'OUTCOME_COORDINATOR_CLOCK_NOT_INITIALIZED' USING ERRCODE = 'P0002';
  END IF;
  RETURN value;
END;
$$ LANGUAGE plpgsql STABLE;

CREATE OR REPLACE FUNCTION outcome_append_coordinator_event(
  p_coordination_id uuid,
  p_event_key text,
  p_event_type text,
  p_from_status text,
  p_to_status text,
  p_progress_kind text,
  p_logical_time bigint,
  p_failure_fingerprint text DEFAULT NULL,
  p_detail jsonb DEFAULT '{}'::jsonb
) RETURNS bigint AS $$
DECLARE
  standing outcome_coordinator_obligation%ROWTYPE;
  event_value bigint;
BEGIN
  SELECT * INTO standing
    FROM outcome_coordinator_obligation
   WHERE coordination_id = p_coordination_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'OUTCOME_COORDINATOR_OBLIGATION_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;
  IF COALESCE(p_event_key, '') = '' OR COALESCE(p_event_type, '') = ''
     OR COALESCE(p_to_status, '') = '' OR p_logical_time < 0
     OR jsonb_typeof(p_detail) <> 'object'
     OR (p_failure_fingerprint IS NOT NULL
       AND NOT COALESCE(outcome_valid_digest(p_failure_fingerprint), false)) THEN
    RAISE EXCEPTION 'OUTCOME_COORDINATOR_EVENT_INVALID' USING ERRCODE = '22023';
  END IF;
  INSERT INTO outcome_coordinator_event (
    tenant_id, project_id, coordination_id, obligation_revision, event_key,
    event_type, from_status, to_status, progress_kind, logical_time,
    failure_fingerprint, diagnostic_path, detail
  ) VALUES (
    standing.tenant_id, standing.project_id, standing.coordination_id,
    standing.obligation_revision, p_event_key, p_event_type, p_from_status,
    p_to_status, p_progress_kind, p_logical_time, p_failure_fingerprint,
    standing.diagnostic_path, p_detail
  ) ON CONFLICT (tenant_id, event_key) DO NOTHING
  RETURNING event_id INTO event_value;
  IF event_value IS NULL THEN
    SELECT event_id INTO event_value
      FROM outcome_coordinator_event
     WHERE tenant_id = standing.tenant_id AND event_key = p_event_key;
  END IF;
  RETURN event_value;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION outcome_terminalize_coordination(
  p_coordination_id uuid,
  p_status text,
  p_reason_code text,
  p_progress_kind text,
  p_logical_time bigint,
  p_detail jsonb DEFAULT '{}'::jsonb
) RETURNS jsonb AS $$
DECLARE
  standing outcome_coordinator_obligation%ROWTYPE;
BEGIN
  IF p_status NOT IN ('RESOLVED', 'SUPERSEDED', 'ESCALATED', 'TERMINAL')
     OR COALESCE(p_reason_code, '') = '' THEN
    RAISE EXCEPTION 'OUTCOME_COORDINATOR_TERMINAL_INVALID' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO standing
    FROM outcome_coordinator_obligation
   WHERE coordination_id = p_coordination_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'OUTCOME_COORDINATOR_OBLIGATION_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;
  IF standing.status IN ('RESOLVED', 'SUPERSEDED', 'ESCALATED', 'TERMINAL') THEN
    RETURN jsonb_build_object(
      'coordinationId', standing.coordination_id::text,
      'status', standing.status,
      'reasonCode', standing.terminal_reason,
      'replayed', true
    );
  END IF;
  UPDATE outcome_coordinator_wake
     SET state = 'CANCELLED', updated_at = clock_timestamp()
   WHERE coordination_id = standing.coordination_id AND state = 'SCHEDULED';
  UPDATE outcome_coordinator_external_wait
     SET state = 'SUPERSEDED', updated_at = clock_timestamp()
   WHERE coordination_id = standing.coordination_id AND state = 'ACTIVE';
  UPDATE outcome_coordinator_owner_decision_request
     SET status = 'SUPERSEDED'
   WHERE coordination_id = standing.coordination_id AND status = 'OPEN';
  UPDATE outcome_coordinator_obligation
     SET status = p_status,
         durable_owner = CASE WHEN p_status = 'ESCALATED' THEN 'AGENT' ELSE durable_owner END,
         diagnostic_path = CASE WHEN p_status = 'ESCALATED' THEN p_reason_code
           ELSE diagnostic_path END,
         terminal_reason = p_reason_code,
         next_wake_logical_time = NULL,
         lease_id = NULL, lease_token = NULL, lease_owner = NULL,
         lease_expires_logical_time = NULL,
         last_progress_logical_time = p_logical_time,
         progress_deadline_logical_time = p_logical_time,
         updated_at = clock_timestamp()
   WHERE coordination_id = standing.coordination_id;
  PERFORM outcome_append_coordinator_event(
    standing.coordination_id,
    'terminal:' || standing.obligation_revision::text || ':' || p_status || ':' || p_reason_code,
    p_reason_code,
    standing.status,
    p_status,
    p_progress_kind,
    p_logical_time,
    NULL,
    p_detail
  );
  RETURN jsonb_build_object(
    'coordinationId', standing.coordination_id::text,
    'status', p_status,
    'reasonCode', p_reason_code,
    'replayed', false
  );
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION outcome_schedule_coordinator_wake(
  p_coordination_id uuid,
  p_due_logical_time bigint,
  p_reason_code text,
  p_wait_status text DEFAULT 'SCHEDULED'
) RETURNS jsonb AS $$
DECLARE
  standing outcome_coordinator_obligation%ROWTYPE;
  clock_value outcome_coordinator_clock%ROWTYPE;
  wake_value uuid;
  generation_value bigint;
  now_value bigint;
BEGIN
  IF p_wait_status NOT IN ('SCHEDULED', 'EXTERNAL_WAIT') OR COALESCE(p_reason_code, '') = '' THEN
    RAISE EXCEPTION 'OUTCOME_COORDINATOR_WAKE_INVALID' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO standing
    FROM outcome_coordinator_obligation
   WHERE coordination_id = p_coordination_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'OUTCOME_COORDINATOR_OBLIGATION_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;
  now_value := outcome_coordinator_now(standing.tenant_id);
  SELECT * INTO clock_value
    FROM outcome_coordinator_clock
   WHERE tenant_id = standing.tenant_id;
  IF p_due_logical_time < now_value
     OR p_due_logical_time > now_value + standing.liveness_delta THEN
    RAISE EXCEPTION 'OUTCOME_COORDINATOR_WAKE_OUTSIDE_LIVENESS_BOUND' USING ERRCODE = '22023';
  END IF;
  IF standing.status IN ('RESOLVED', 'SUPERSEDED', 'ESCALATED', 'TERMINAL') THEN
    RETURN jsonb_build_object(
      'coordinationId', standing.coordination_id::text,
      'status', standing.status,
      'scheduled', false,
      'reasonCode', 'TERMINAL_COORDINATION'
    );
  END IF;
  IF standing.wake_budget_remaining <= 0 THEN
    RETURN outcome_terminalize_coordination(
      standing.coordination_id,
      'ESCALATED',
      'WAKE_BUDGET_EXHAUSTED',
      'ESCALATE',
      now_value,
      jsonb_build_object('requestedReason', p_reason_code)
    );
  END IF;
  UPDATE outcome_coordinator_wake
     SET state = 'CANCELLED', updated_at = clock_timestamp()
   WHERE coordination_id = standing.coordination_id AND state = 'SCHEDULED';
  generation_value := standing.wake_generation + 1;
  wake_value := gen_random_uuid();
  INSERT INTO outcome_coordinator_wake (
    wake_id, tenant_id, project_id, coordination_id, obligation_revision,
    generation, clock_id, due_logical_time, reason_code, state
  ) VALUES (
    wake_value, standing.tenant_id, standing.project_id, standing.coordination_id,
    standing.obligation_revision, generation_value, clock_value.clock_id,
    p_due_logical_time, p_reason_code, 'SCHEDULED'
  );
  UPDATE outcome_coordinator_obligation
     SET status = p_wait_status,
         durable_owner = CASE WHEN p_wait_status = 'EXTERNAL_WAIT' THEN 'SYSTEM'
           ELSE durable_owner END,
         wake_generation = generation_value,
         wake_budget_remaining = wake_budget_remaining - 1,
         next_wake_logical_time = p_due_logical_time,
         lease_id = NULL, lease_token = NULL, lease_owner = NULL,
         lease_expires_logical_time = NULL,
         updated_at = clock_timestamp()
   WHERE coordination_id = standing.coordination_id;
  PERFORM outcome_append_coordinator_event(
    standing.coordination_id,
    'wake-scheduled:' || generation_value::text,
    'WAKE_SCHEDULED',
    standing.status,
    p_wait_status,
    NULL,
    now_value,
    NULL,
    jsonb_build_object(
      'wakeId', wake_value::text,
      'dueLogicalTime', p_due_logical_time::text,
      'reasonCode', p_reason_code,
      'wakeBudgetRemaining', standing.wake_budget_remaining - 1
    )
  );
  RETURN jsonb_build_object(
    'coordinationId', standing.coordination_id::text,
    'wakeId', wake_value::text,
    'generation', generation_value::text,
    'dueLogicalTime', p_due_logical_time::text,
    'status', p_wait_status,
    'scheduled', true,
    'wakeBudgetRemaining', standing.wake_budget_remaining - 1
  );
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION outcome_register_coordinator_obligation(
  p_tenant_id uuid,
  p_project_id uuid,
  p_source_type text,
  p_source_key text,
  p_source_obligation jsonb,
  p_liveness_delta bigint,
  p_attempt_budget integer,
  p_wake_budget integer,
  p_same_failure_fingerprint_limit integer,
  p_max_lease_renewals integer DEFAULT 1
) RETURNS jsonb AS $$
DECLARE
  standing outcome_coordinator_obligation%ROWTYPE;
  now_value bigint;
  coordination_value uuid;
  source_digest_value text;
  coordination_revision_value text;
  requested_owner_value text;
  durable_owner_value text;
  wake_receipt jsonb;
BEGIN
  now_value := outcome_coordinator_now(p_tenant_id);
  IF p_source_type NOT IN ('CANONICAL', 'EXECUTOR') OR COALESCE(p_source_key, '') = ''
     OR jsonb_typeof(p_source_obligation) <> 'object'
     OR NOT COALESCE(outcome_valid_digest(p_source_obligation->>'obligationId'), false)
     OR NOT COALESCE(outcome_valid_digest(p_source_obligation->>'obligationRevision'), false)
     OR NOT COALESCE(outcome_valid_digest(p_source_obligation->>'bindingDigest'), false)
     OR COALESCE(p_source_obligation->>'kind', '') = ''
     OR COALESCE(p_source_obligation->>'capability', '') = ''
     OR p_source_obligation->>'owner' NOT IN ('SYSTEM', 'AGENT', 'OWNER', 'EXTERNAL')
     OR p_liveness_delta <= 0 OR p_attempt_budget <= 0 OR p_wake_budget <= 0
     OR p_same_failure_fingerprint_limit <= 0
     OR p_same_failure_fingerprint_limit > p_attempt_budget
     OR p_max_lease_renewals < 0 THEN
    RAISE EXCEPTION 'OUTCOME_COORDINATOR_OBLIGATION_INVALID' USING ERRCODE = '22023';
  END IF;
  PERFORM 1 FROM outcome_fact_stream
   WHERE tenant_id = p_tenant_id AND project_id = p_project_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'OUTCOME_COORDINATOR_STREAM_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;
  source_digest_value := outcome_sha256_json(p_source_obligation);
  requested_owner_value := p_source_obligation->>'owner';
  durable_owner_value := CASE
    WHEN requested_owner_value IN ('SYSTEM', 'EXTERNAL') THEN 'SYSTEM'
    ELSE 'AGENT'
  END;
  coordination_revision_value := outcome_sha256_json(jsonb_build_object(
    'namespace', 'orbit.outcome-coordinator.revision.v2',
    'tenantId', p_tenant_id::text,
    'projectId', p_project_id::text,
    'sourceType', p_source_type,
    'sourceKey', p_source_key,
    'obligationRevision', p_source_obligation->>'obligationRevision',
    'bindingDigest', p_source_obligation->>'bindingDigest',
    'livenessDelta', p_liveness_delta::text,
    'attemptBudget', p_attempt_budget,
    'wakeBudget', p_wake_budget,
    'sameFailureFingerprintLimit', p_same_failure_fingerprint_limit,
    'maxLeaseRenewals', p_max_lease_renewals
  ));
  INSERT INTO outcome_coordinator_obligation_revision (
    tenant_id, project_id, coordination_revision, source_type, source_key,
    obligation_id, obligation_revision, binding_digest, kind, requested_owner,
    capability, liveness_delta, attempt_budget, wake_budget,
    same_failure_fingerprint_limit, max_lease_renewals, source_obligation,
    source_digest, created_logical_time
  ) VALUES (
    p_tenant_id, p_project_id, coordination_revision_value, p_source_type, p_source_key,
    p_source_obligation->>'obligationId', p_source_obligation->>'obligationRevision',
    p_source_obligation->>'bindingDigest', p_source_obligation->>'kind',
    requested_owner_value, p_source_obligation->>'capability', p_liveness_delta,
    p_attempt_budget, p_wake_budget, p_same_failure_fingerprint_limit,
    p_max_lease_renewals, p_source_obligation, source_digest_value, now_value
  ) ON CONFLICT (tenant_id, project_id, coordination_revision) DO NOTHING;

  SELECT * INTO standing
    FROM outcome_coordinator_obligation
   WHERE tenant_id = p_tenant_id AND project_id = p_project_id
     AND source_type = p_source_type AND source_key = p_source_key
   FOR UPDATE;
  IF FOUND AND standing.coordination_revision::text = coordination_revision_value THEN
    RETURN jsonb_build_object(
      'coordinationId', standing.coordination_id::text,
      'coordinationRevision', standing.coordination_revision::text,
      'status', standing.status,
      'durableOwner', standing.durable_owner,
      'replayed', true
    );
  END IF;
  IF FOUND THEN
    PERFORM outcome_append_coordinator_event(
      standing.coordination_id,
      'revision-superseded:' || standing.coordination_revision::text,
      'OBLIGATION_REVISION_SUPERSEDED',
      standing.status,
      'SUPERSEDED',
      'SUPERSEDE',
      now_value,
      NULL,
      jsonb_build_object('successorRevision', coordination_revision_value)
    );
    UPDATE outcome_coordinator_wake
       SET state = 'CANCELLED', updated_at = clock_timestamp()
     WHERE coordination_id = standing.coordination_id AND state = 'SCHEDULED';
    UPDATE outcome_coordinator_external_wait
       SET state = 'SUPERSEDED', updated_at = clock_timestamp()
     WHERE coordination_id = standing.coordination_id AND state = 'ACTIVE';
    UPDATE outcome_coordinator_owner_decision_request
       SET status = 'SUPERSEDED'
     WHERE coordination_id = standing.coordination_id AND status = 'OPEN';
    coordination_value := standing.coordination_id;
    UPDATE outcome_coordinator_obligation
       SET coordination_revision = coordination_revision_value,
           obligation_id = p_source_obligation->>'obligationId',
           obligation_revision = p_source_obligation->>'obligationRevision',
           binding_digest = p_source_obligation->>'bindingDigest',
           kind = p_source_obligation->>'kind', capability = p_source_obligation->>'capability',
           requested_owner = requested_owner_value, durable_owner = durable_owner_value,
           status = 'READY', diagnostic_path = 'PRIMARY_RECOVERY',
           attempt_budget_max = p_attempt_budget,
           attempt_budget_remaining = p_attempt_budget,
           wake_budget_max = p_wake_budget, wake_budget_remaining = p_wake_budget,
           same_failure_fingerprint_limit = p_same_failure_fingerprint_limit,
           max_lease_renewals = p_max_lease_renewals,
           attempt_count = 0, lease_generation = lease_generation + 1,
           lease_renewal_count = 0, wake_generation = wake_generation + 1,
           liveness_delta = p_liveness_delta,
           last_progress_logical_time = now_value,
           progress_deadline_logical_time = now_value + p_liveness_delta,
           next_wake_logical_time = NULL,
           lease_id = NULL, lease_token = NULL, lease_owner = NULL,
           lease_expires_logical_time = NULL, action_intent_id = NULL,
           decision_request_id = NULL, external_wait_id = NULL, terminal_reason = NULL,
           source_obligation = p_source_obligation, source_digest = source_digest_value,
           updated_at = clock_timestamp()
     WHERE coordination_id = standing.coordination_id;
  ELSE
    coordination_value := gen_random_uuid();
    INSERT INTO outcome_coordinator_obligation (
      coordination_id, tenant_id, project_id, coordination_revision,
      source_type, source_key, obligation_id, obligation_revision, binding_digest,
      kind, capability, requested_owner, durable_owner, status, diagnostic_path,
      attempt_budget_max, attempt_budget_remaining, wake_budget_max,
      wake_budget_remaining, same_failure_fingerprint_limit, max_lease_renewals,
      liveness_delta, last_progress_logical_time, progress_deadline_logical_time,
      source_obligation, source_digest
    ) VALUES (
      coordination_value, p_tenant_id, p_project_id, coordination_revision_value,
      p_source_type, p_source_key, p_source_obligation->>'obligationId',
      p_source_obligation->>'obligationRevision', p_source_obligation->>'bindingDigest',
      p_source_obligation->>'kind', p_source_obligation->>'capability',
      requested_owner_value, durable_owner_value, 'READY', 'PRIMARY_RECOVERY',
      p_attempt_budget, p_attempt_budget, p_wake_budget, p_wake_budget,
      p_same_failure_fingerprint_limit, p_max_lease_renewals, p_liveness_delta,
      now_value, now_value + p_liveness_delta, p_source_obligation, source_digest_value
    );
  END IF;
  PERFORM outcome_append_coordinator_event(
    coordination_value,
    'ownership:' || coordination_revision_value,
    'DURABLE_OWNERSHIP_ASSIGNED',
    NULL,
    'READY',
    NULL,
    now_value,
    NULL,
    jsonb_build_object(
      'requestedOwner', requested_owner_value,
      'durableOwner', durable_owner_value,
      'ownerDecisionRequiresValidatedRequest', requested_owner_value = 'OWNER'
    )
  );
  wake_receipt := outcome_schedule_coordinator_wake(
    coordination_value, now_value, 'OBLIGATION_ACTIVATED', 'SCHEDULED'
  );
  SELECT * INTO standing
    FROM outcome_coordinator_obligation
   WHERE coordination_id = coordination_value;
  RETURN jsonb_build_object(
    'coordinationId', coordination_value::text,
    'coordinationRevision', coordination_revision_value,
    'status', standing.status,
    'durableOwner', standing.durable_owner,
    'wake', wake_receipt,
    'replayed', false
  );
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION outcome_deliver_coordinator_wake(
  p_tenant_id uuid,
  p_wake_id uuid,
  p_callback_key text
) RETURNS jsonb AS $$
DECLARE
  wake_value outcome_coordinator_wake%ROWTYPE;
  standing outcome_coordinator_obligation%ROWTYPE;
  previous outcome_coordinator_wake_delivery%ROWTYPE;
  now_value bigint;
  delivery_outcome text;
BEGIN
  IF COALESCE(p_callback_key, '') = '' THEN
    RAISE EXCEPTION 'OUTCOME_COORDINATOR_WAKE_CALLBACK_INVALID' USING ERRCODE = '22023';
  END IF;
  now_value := outcome_coordinator_now(p_tenant_id);
  SELECT * INTO previous
    FROM outcome_coordinator_wake_delivery
   WHERE tenant_id = p_tenant_id AND callback_key = p_callback_key;
  IF FOUND THEN
    RETURN jsonb_build_object(
      'wakeId', previous.wake_id::text,
      'outcome', previous.outcome,
      'replayed', true
    );
  END IF;
  SELECT * INTO wake_value
    FROM outcome_coordinator_wake
   WHERE wake_id = p_wake_id AND tenant_id = p_tenant_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'OUTCOME_COORDINATOR_WAKE_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;
  SELECT * INTO standing
    FROM outcome_coordinator_obligation
   WHERE coordination_id = wake_value.coordination_id
   FOR UPDATE;
  IF wake_value.due_logical_time > now_value THEN
    delivery_outcome := 'EARLY';
  ELSIF wake_value.state <> 'SCHEDULED' THEN
    delivery_outcome := 'DUPLICATE';
  ELSIF standing.obligation_revision IS DISTINCT FROM wake_value.obligation_revision
     OR standing.wake_generation IS DISTINCT FROM wake_value.generation
     OR standing.status NOT IN ('SCHEDULED', 'EXTERNAL_WAIT') THEN
    delivery_outcome := 'STALE';
  ELSE
    delivery_outcome := 'DELIVERED';
    UPDATE outcome_coordinator_wake
       SET state = 'DELIVERED', delivery_attempts = delivery_attempts + 1,
           updated_at = clock_timestamp()
     WHERE wake_id = wake_value.wake_id;
    UPDATE outcome_coordinator_obligation
       SET status = 'READY', next_wake_logical_time = NULL,
           updated_at = clock_timestamp()
     WHERE coordination_id = standing.coordination_id;
    PERFORM outcome_append_coordinator_event(
      standing.coordination_id,
      'wake-delivered:' || wake_value.generation::text,
      'WAKE_DELIVERED',
      standing.status,
      'READY',
      NULL,
      now_value,
      NULL,
      jsonb_build_object('wakeId', wake_value.wake_id::text, 'callbackKey', p_callback_key)
    );
  END IF;
  IF delivery_outcome <> 'DELIVERED' THEN
    UPDATE outcome_coordinator_wake
       SET delivery_attempts = delivery_attempts + 1, updated_at = clock_timestamp()
     WHERE wake_id = wake_value.wake_id;
  END IF;
  INSERT INTO outcome_coordinator_wake_delivery (
    delivery_id, tenant_id, project_id, wake_id, callback_key, outcome, logical_time
  ) VALUES (
    gen_random_uuid(), p_tenant_id, wake_value.project_id, wake_value.wake_id,
    p_callback_key, delivery_outcome, now_value
  );
  RETURN jsonb_build_object(
    'wakeId', wake_value.wake_id::text,
    'coordinationId', wake_value.coordination_id::text,
    'outcome', delivery_outcome,
    'replayed', delivery_outcome <> 'DELIVERED'
  );
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION outcome_apply_coordinator_failure(
  p_coordination_id uuid,
  p_failure_fingerprint text,
  p_reason_code text,
  p_logical_time bigint,
  p_retry_after bigint DEFAULT 1,
  p_detail jsonb DEFAULT '{}'::jsonb
) RETURNS jsonb AS $$
DECLARE
  standing outcome_coordinator_obligation%ROWTYPE;
  occurrence_value integer;
  path_value text;
  wake_receipt jsonb;
BEGIN
  IF NOT COALESCE(outcome_valid_digest(p_failure_fingerprint), false)
     OR COALESCE(p_reason_code, '') = '' OR p_retry_after <= 0
     OR jsonb_typeof(p_detail) <> 'object' THEN
    RAISE EXCEPTION 'OUTCOME_COORDINATOR_FAILURE_INVALID' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO standing
    FROM outcome_coordinator_obligation
   WHERE coordination_id = p_coordination_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'OUTCOME_COORDINATOR_OBLIGATION_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;
  INSERT INTO outcome_coordinator_failure_fingerprint (
    tenant_id, project_id, coordination_id, obligation_revision,
    failure_fingerprint, occurrence_count, last_logical_time, diagnostic_path
  ) VALUES (
    standing.tenant_id, standing.project_id, standing.coordination_id,
    standing.obligation_revision, p_failure_fingerprint, 1, p_logical_time,
    'PRIMARY_RECOVERY'
  ) ON CONFLICT (coordination_id, obligation_revision, failure_fingerprint) DO UPDATE SET
    occurrence_count = outcome_coordinator_failure_fingerprint.occurrence_count + 1,
    last_logical_time = EXCLUDED.last_logical_time
  RETURNING occurrence_count INTO occurrence_value;
  path_value := CASE
    WHEN standing.attempt_budget_remaining = 0 THEN 'ATTEMPT_BUDGET_EXHAUSTED'
    WHEN occurrence_value > standing.same_failure_fingerprint_limit
      THEN 'REPEATED_FAILURE_ESCALATION'
    WHEN occurrence_value = standing.same_failure_fingerprint_limit
      THEN 'ALTERNATE_DIAGNOSIS'
    ELSE 'PRIMARY_RECOVERY'
  END;
  UPDATE outcome_coordinator_failure_fingerprint
     SET diagnostic_path = path_value
   WHERE coordination_id = standing.coordination_id
     AND obligation_revision = standing.obligation_revision
     AND failure_fingerprint = p_failure_fingerprint;
  UPDATE outcome_coordinator_obligation
     SET diagnostic_path = path_value,
         lease_renewal_count = 0,
         updated_at = clock_timestamp()
   WHERE coordination_id = standing.coordination_id;
  PERFORM outcome_append_coordinator_event(
    standing.coordination_id,
    'failure:' || standing.obligation_revision::text || ':'
      || p_failure_fingerprint || ':' || occurrence_value::text,
    p_reason_code,
    standing.status,
    CASE WHEN path_value IN ('ATTEMPT_BUDGET_EXHAUSTED', 'REPEATED_FAILURE_ESCALATION')
      THEN 'ESCALATED' ELSE 'SCHEDULED' END,
    CASE WHEN path_value IN ('ATTEMPT_BUDGET_EXHAUSTED', 'REPEATED_FAILURE_ESCALATION')
      THEN 'ESCALATE' ELSE NULL END,
    p_logical_time,
    p_failure_fingerprint,
    p_detail || jsonb_build_object(
      'occurrenceCount', occurrence_value,
      'sameFailureFingerprintLimit', standing.same_failure_fingerprint_limit,
      'attemptBudgetRemaining', standing.attempt_budget_remaining,
      'diagnosticPath', path_value
    )
  );
  IF path_value IN ('ATTEMPT_BUDGET_EXHAUSTED', 'REPEATED_FAILURE_ESCALATION') THEN
    RETURN outcome_terminalize_coordination(
      standing.coordination_id,
      'ESCALATED',
      path_value,
      'ESCALATE',
      p_logical_time,
      p_detail || jsonb_build_object(
        'failureFingerprint', p_failure_fingerprint,
        'occurrenceCount', occurrence_value
      )
    );
  END IF;
  wake_receipt := outcome_schedule_coordinator_wake(
    standing.coordination_id,
    p_logical_time + LEAST(p_retry_after, standing.liveness_delta),
    CASE WHEN path_value = 'ALTERNATE_DIAGNOSIS'
      THEN 'ALTERNATE_DIAGNOSIS_DUE' ELSE 'RETRY_BACKOFF_DUE' END,
    'SCHEDULED'
  );
  RETURN jsonb_build_object(
    'coordinationId', standing.coordination_id::text,
    'status', COALESCE(wake_receipt->>'status', 'SCHEDULED'),
    'failureFingerprint', p_failure_fingerprint,
    'occurrenceCount', occurrence_value,
    'diagnosticPath', path_value,
    'wake', wake_receipt
  );
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION outcome_sweep_coordinator(
  p_tenant_id uuid
) RETURNS jsonb AS $$
DECLARE
  standing outcome_coordinator_obligation%ROWTYPE;
  wake_value outcome_coordinator_wake%ROWTYPE;
  now_value bigint;
  fingerprint_value text;
  rebuilt_count integer := 0;
  delivered_count integer := 0;
  expired_count integer := 0;
  escalated_count integer := 0;
  receipt jsonb;
BEGIN
  now_value := outcome_coordinator_now(p_tenant_id);

  -- A timer backend may lose its message or mark it dead. The obligation row is the durable due
  -- index, so a sweep reconstructs one bounded wake rather than silently waiting forever.
  FOR standing IN
    SELECT c.*
      FROM outcome_coordinator_obligation c
     WHERE c.tenant_id = p_tenant_id
       AND c.status IN ('SCHEDULED', 'EXTERNAL_WAIT')
       AND c.next_wake_logical_time <= now_value
       AND NOT EXISTS (
         SELECT 1 FROM outcome_coordinator_wake w
          WHERE w.coordination_id = c.coordination_id
            AND w.generation = c.wake_generation
            AND w.state = 'SCHEDULED'
       )
     ORDER BY c.project_id, c.queue_sequence
     FOR UPDATE
  LOOP
    receipt := outcome_schedule_coordinator_wake(
      standing.coordination_id, now_value, 'RECOVER_LOST_WAKE', standing.status
    );
    IF receipt->>'scheduled' = 'true' THEN
      rebuilt_count := rebuilt_count + 1;
      PERFORM outcome_append_coordinator_event(
        standing.coordination_id,
        'wake-rebuilt:' || (standing.wake_generation + 1)::text,
        'WAKE_REBUILT',
        standing.status,
        standing.status,
        NULL,
        now_value,
        NULL,
        jsonb_build_object('lostGeneration', standing.wake_generation::text)
      );
    ELSE
      escalated_count := escalated_count + 1;
    END IF;
  END LOOP;

  FOR wake_value IN
    SELECT * FROM outcome_coordinator_wake
     WHERE tenant_id = p_tenant_id AND state = 'SCHEDULED'
       AND due_logical_time <= now_value
     ORDER BY due_logical_time, project_id, wake_id
     FOR UPDATE
  LOOP
    receipt := outcome_deliver_coordinator_wake(
      p_tenant_id,
      wake_value.wake_id,
      'sweep:' || wake_value.wake_id::text || ':' || wake_value.generation::text
    );
    IF receipt->>'outcome' = 'DELIVERED' THEN
      delivered_count := delivered_count + 1;
    END IF;
  END LOOP;

  FOR standing IN
    SELECT * FROM outcome_coordinator_obligation
     WHERE tenant_id = p_tenant_id AND status = 'CLAIMED'
       AND lease_expires_logical_time <= now_value
     ORDER BY project_id, queue_sequence
     FOR UPDATE
  LOOP
    fingerprint_value := outcome_sha256_json(jsonb_build_object(
      'namespace', 'orbit.outcome-coordinator.failure.v2',
      'code', 'LEASE_EXPIRED',
      'obligationRevision', standing.obligation_revision::text
    ));
    receipt := outcome_apply_coordinator_failure(
      standing.coordination_id,
      fingerprint_value,
      'LEASE_EXPIRED',
      now_value,
      1,
      jsonb_build_object(
        'leaseId', standing.lease_id::text,
        'leaseGeneration', standing.lease_generation::text,
        'workerId', standing.lease_owner
      )
    );
    expired_count := expired_count + 1;
    IF receipt->>'status' = 'ESCALATED' THEN escalated_count := escalated_count + 1; END IF;
  END LOOP;

  -- CLAIMED leases are bounded by the same deadline. OWNER_DECISION and EXTERNAL_WAIT are explicit
  -- legal waits; every other overdue active row receives a non-human escalation disposition.
  FOR standing IN
    SELECT * FROM outcome_coordinator_obligation
     WHERE tenant_id = p_tenant_id
       AND status IN ('READY', 'SCHEDULED', 'CLAIMED')
       AND progress_deadline_logical_time <= now_value
     ORDER BY project_id, queue_sequence
     FOR UPDATE
  LOOP
    PERFORM outcome_terminalize_coordination(
      standing.coordination_id,
      'ESCALATED',
      'LIVENESS_DELTA_EXCEEDED',
      'ESCALATE',
      now_value,
      jsonb_build_object(
        'progressDeadlineLogicalTime', standing.progress_deadline_logical_time::text,
        'lastProgressLogicalTime', standing.last_progress_logical_time::text
      )
    );
    escalated_count := escalated_count + 1;
  END LOOP;
  RETURN jsonb_build_object(
    'logicalNow', now_value::text,
    'wakesRebuilt', rebuilt_count,
    'wakesDelivered', delivered_count,
    'leasesExpired', expired_count,
    'escalated', escalated_count
  );
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION outcome_reconcile_active_obligations(
  p_tenant_id uuid,
  p_liveness_delta bigint,
  p_attempt_budget integer,
  p_wake_budget integer,
  p_same_failure_fingerprint_limit integer,
  p_max_lease_renewals integer DEFAULT 1
) RETURNS jsonb AS $$
DECLARE
  source_value record;
  standing outcome_coordinator_obligation%ROWTYPE;
  now_value bigint;
  registered_count integer := 0;
  replayed_count integer := 0;
  superseded_count integer := 0;
  receipt jsonb;
BEGIN
  now_value := outcome_coordinator_now(p_tenant_id);
  FOR source_value IN
    SELECT a.project_id, 'CANONICAL'::text AS source_type,
           a.obligation_id::text AS source_key, a.obligation
      FROM outcome_active_obligation a
     WHERE a.tenant_id = p_tenant_id
    UNION ALL
    SELECT a.project_id, 'EXECUTOR'::text AS source_type,
           a.action_intent_id::text AS source_key, a.obligation
      FROM outcome_executor_active_obligation a
     WHERE a.tenant_id = p_tenant_id
     ORDER BY project_id, source_type, source_key
  LOOP
    receipt := outcome_register_coordinator_obligation(
      p_tenant_id, source_value.project_id, source_value.source_type,
      source_value.source_key, source_value.obligation, p_liveness_delta,
      p_attempt_budget, p_wake_budget, p_same_failure_fingerprint_limit,
      p_max_lease_renewals
    );
    registered_count := registered_count + 1;
    IF receipt->>'replayed' = 'true' THEN replayed_count := replayed_count + 1; END IF;
  END LOOP;

  FOR standing IN
    SELECT * FROM outcome_coordinator_obligation c
     WHERE c.tenant_id = p_tenant_id
       AND c.status IN ('READY', 'CLAIMED', 'SCHEDULED', 'EXTERNAL_WAIT', 'OWNER_DECISION')
       AND (
         (c.source_type = 'CANONICAL' AND NOT EXISTS (
           SELECT 1 FROM outcome_active_obligation a
            WHERE a.tenant_id = c.tenant_id AND a.project_id = c.project_id
              AND a.obligation_id = c.obligation_id
              AND a.obligation_revision = c.obligation_revision
         ))
         OR
         (c.source_type = 'EXECUTOR' AND NOT EXISTS (
           SELECT 1 FROM outcome_executor_active_obligation a
            WHERE a.tenant_id = c.tenant_id AND a.project_id = c.project_id
              AND a.action_intent_id::text = c.source_key
              AND a.obligation_revision = c.obligation_revision
         ))
       )
     ORDER BY c.project_id, c.queue_sequence
     FOR UPDATE
  LOOP
    PERFORM outcome_terminalize_coordination(
      standing.coordination_id,
      'SUPERSEDED',
      'SOURCE_OBLIGATION_NO_LONGER_ACTIVE',
      'SUPERSEDE',
      now_value,
      jsonb_build_object('sourceType', standing.source_type, 'sourceKey', standing.source_key)
    );
    superseded_count := superseded_count + 1;
  END LOOP;
  RETURN jsonb_build_object(
    'logicalNow', now_value::text,
    'registered', registered_count,
    'replayed', replayed_count,
    'superseded', superseded_count
  );
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION outcome_claim_next_coordination(
  p_tenant_id uuid,
  p_worker_id text,
  p_lease_logical_ticks bigint
) RETURNS jsonb AS $$
DECLARE
  standing outcome_coordinator_obligation%ROWTYPE;
  scheduler_value outcome_coordinator_scheduler%ROWTYPE;
  lease_value uuid;
  token_value uuid;
  generation_value bigint;
  attempt_value integer;
  dispatch_value bigint;
  expiry_value bigint;
  now_value bigint;
BEGIN
  IF COALESCE(p_worker_id, '') = '' OR p_lease_logical_ticks <= 0 THEN
    RAISE EXCEPTION 'OUTCOME_COORDINATOR_CLAIM_INVALID' USING ERRCODE = '22023';
  END IF;
  now_value := outcome_coordinator_now(p_tenant_id);
  PERFORM outcome_sweep_coordinator(p_tenant_id);
  INSERT INTO outcome_coordinator_scheduler (tenant_id) VALUES (p_tenant_id)
  ON CONFLICT DO NOTHING;
  SELECT * INTO scheduler_value
    FROM outcome_coordinator_scheduler
   WHERE tenant_id = p_tenant_id
   FOR UPDATE;
  SELECT candidate.* INTO standing
    FROM (
      SELECT DISTINCT ON (project_id) c.*
        FROM outcome_coordinator_obligation c
       WHERE c.tenant_id = p_tenant_id AND c.status = 'READY'
         AND c.attempt_budget_remaining > 0
         AND c.progress_deadline_logical_time >= now_value
       ORDER BY project_id, queue_sequence, coordination_id
    ) candidate
    LEFT JOIN outcome_coordinator_project_fairness fairness
      ON fairness.tenant_id = candidate.tenant_id
     AND fairness.project_id = candidate.project_id
   ORDER BY fairness.last_dispatched_sequence ASC NULLS FIRST,
            candidate.project_id, candidate.queue_sequence, candidate.coordination_id
   LIMIT 1;
  IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT * INTO standing
    FROM outcome_coordinator_obligation
   WHERE coordination_id = standing.coordination_id
   FOR UPDATE;
  IF standing.status <> 'READY' OR standing.attempt_budget_remaining <= 0 THEN RETURN NULL; END IF;
  IF p_lease_logical_ticks > standing.liveness_delta THEN
    RAISE EXCEPTION 'OUTCOME_COORDINATOR_LEASE_OUTSIDE_LIVENESS_BOUND' USING ERRCODE = '22023';
  END IF;
  dispatch_value := scheduler_value.dispatch_sequence + 1;
  UPDATE outcome_coordinator_scheduler
     SET dispatch_sequence = dispatch_value
   WHERE tenant_id = p_tenant_id;
  INSERT INTO outcome_coordinator_project_fairness (
    tenant_id, project_id, last_dispatched_sequence, dispatch_count
  ) VALUES (
    p_tenant_id, standing.project_id, dispatch_value, 1
  ) ON CONFLICT (tenant_id, project_id) DO UPDATE SET
    last_dispatched_sequence = EXCLUDED.last_dispatched_sequence,
    dispatch_count = outcome_coordinator_project_fairness.dispatch_count + 1,
    updated_at = clock_timestamp();
  lease_value := gen_random_uuid();
  token_value := gen_random_uuid();
  generation_value := standing.lease_generation + 1;
  attempt_value := standing.attempt_count + 1;
  expiry_value := now_value + p_lease_logical_ticks;
  UPDATE outcome_coordinator_obligation
     SET status = 'CLAIMED', durable_owner = CASE
           WHEN durable_owner = 'OWNER' THEN 'AGENT' ELSE durable_owner END,
         attempt_count = attempt_value,
         attempt_budget_remaining = attempt_budget_remaining - 1,
         lease_generation = generation_value, lease_renewal_count = 0,
         lease_id = lease_value, lease_token = token_value, lease_owner = p_worker_id,
         lease_expires_logical_time = expiry_value,
         next_wake_logical_time = NULL,
         last_progress_logical_time = now_value,
         progress_deadline_logical_time = now_value + liveness_delta,
         updated_at = clock_timestamp()
   WHERE coordination_id = standing.coordination_id;
  INSERT INTO outcome_coordinator_lease (
    lease_id, tenant_id, project_id, coordination_id, obligation_revision,
    generation, attempt_number, worker_id, lease_token,
    claimed_logical_time, expires_logical_time
  ) VALUES (
    lease_value, standing.tenant_id, standing.project_id, standing.coordination_id,
    standing.obligation_revision, generation_value, attempt_value, p_worker_id,
    token_value, now_value, expiry_value
  );
  PERFORM outcome_append_coordinator_event(
    standing.coordination_id,
    'claim:' || generation_value::text,
    'VALID_ATTEMPT_STARTED',
    'READY',
    'CLAIMED',
    'VALID_ATTEMPT',
    now_value,
    NULL,
    jsonb_build_object(
      'leaseId', lease_value::text,
      'workerId', p_worker_id,
      'attemptNumber', attempt_value,
      'attemptBudgetRemaining', standing.attempt_budget_remaining - 1,
      'dispatchSequence', dispatch_value::text
    )
  );
  RETURN jsonb_build_object(
    'coordinationId', standing.coordination_id::text,
    'tenantId', standing.tenant_id::text,
    'projectId', standing.project_id::text,
    'obligationId', standing.obligation_id::text,
    'obligationRevision', standing.obligation_revision::text,
    'capability', standing.capability,
    'attemptNumber', attempt_value,
    'attemptBudgetRemaining', standing.attempt_budget_remaining - 1,
    'diagnosticPath', standing.diagnostic_path,
    'leaseId', lease_value::text,
    'leaseToken', token_value::text,
    'leaseExpiresLogicalTime', expiry_value::text,
    'sourceObligation', standing.source_obligation
  );
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION outcome_renew_coordinator_lease(
  p_tenant_id uuid,
  p_coordination_id uuid,
  p_lease_token uuid,
  p_worker_id text,
  p_extension_logical_ticks bigint
) RETURNS jsonb AS $$
DECLARE
  standing outcome_coordinator_obligation%ROWTYPE;
  now_value bigint;
  new_expiry bigint;
BEGIN
  IF COALESCE(p_worker_id, '') = '' OR p_extension_logical_ticks <= 0 THEN
    RAISE EXCEPTION 'OUTCOME_COORDINATOR_RENEWAL_INVALID' USING ERRCODE = '22023';
  END IF;
  now_value := outcome_coordinator_now(p_tenant_id);
  SELECT * INTO standing
    FROM outcome_coordinator_obligation
   WHERE tenant_id = p_tenant_id AND coordination_id = p_coordination_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'OUTCOME_COORDINATOR_OBLIGATION_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;
  IF standing.status <> 'CLAIMED' OR standing.lease_token IS DISTINCT FROM p_lease_token
     OR standing.lease_owner IS DISTINCT FROM p_worker_id
     OR standing.lease_expires_logical_time <= now_value THEN
    RAISE EXCEPTION 'OUTCOME_COORDINATOR_LEASE_STALE' USING ERRCODE = '40001';
  END IF;
  IF standing.lease_renewal_count >= standing.max_lease_renewals THEN
    RETURN jsonb_build_object(
      'coordinationId', standing.coordination_id::text,
      'renewed', false,
      'code', 'LEASE_RENEWAL_BUDGET_EXHAUSTED',
      'leaseExpiresLogicalTime', standing.lease_expires_logical_time::text
    );
  END IF;
  new_expiry := LEAST(
    now_value + p_extension_logical_ticks,
    standing.progress_deadline_logical_time
  );
  IF new_expiry <= standing.lease_expires_logical_time THEN
    RETURN jsonb_build_object(
      'coordinationId', standing.coordination_id::text,
      'renewed', false,
      'code', 'LIVENESS_FENCE_PREVENTS_RENEWAL',
      'leaseExpiresLogicalTime', standing.lease_expires_logical_time::text
    );
  END IF;
  UPDATE outcome_coordinator_obligation
     SET lease_expires_logical_time = new_expiry,
         lease_renewal_count = lease_renewal_count + 1,
         updated_at = clock_timestamp()
   WHERE coordination_id = standing.coordination_id;
  PERFORM outcome_append_coordinator_event(
    standing.coordination_id,
    'lease-renewed:' || standing.lease_generation::text || ':'
      || (standing.lease_renewal_count + 1)::text,
    'LEASE_RENEWED',
    'CLAIMED',
    'CLAIMED',
    NULL,
    now_value,
    NULL,
    jsonb_build_object(
      'leaseId', standing.lease_id::text,
      'expiresLogicalTime', new_expiry::text,
      'progressDeadlineLogicalTime', standing.progress_deadline_logical_time::text,
      'countsAsProgress', false
    )
  );
  RETURN jsonb_build_object(
    'coordinationId', standing.coordination_id::text,
    'renewed', true,
    'leaseExpiresLogicalTime', new_expiry::text,
    'renewalsRemaining', standing.max_lease_renewals - standing.lease_renewal_count - 1,
    'progressDeadlineLogicalTime', standing.progress_deadline_logical_time::text
  );
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION outcome_record_coordinator_result(
  p_tenant_id uuid,
  p_coordination_id uuid,
  p_lease_token uuid,
  p_worker_id text,
  p_callback_key text,
  p_result text,
  p_failure_fingerprint text DEFAULT NULL,
  p_retry_after bigint DEFAULT NULL,
  p_detail jsonb DEFAULT '{}'::jsonb
) RETURNS jsonb AS $$
DECLARE
  standing outcome_coordinator_obligation%ROWTYPE;
  lease_value outcome_coordinator_lease%ROWTYPE;
  previous outcome_coordinator_attempt_result%ROWTYPE;
  action_value outcome_action_intent%ROWTYPE;
  wait_value outcome_coordinator_external_wait%ROWTYPE;
  now_value bigint;
  delay_value bigint;
  condition_value jsonb;
  condition_digest_value text;
  poll_budget_value integer;
  poll_remaining_value integer;
  wait_id_value uuid;
  wake_receipt jsonb;
  transition_receipt jsonb;
BEGIN
  IF COALESCE(p_worker_id, '') = '' OR COALESCE(p_callback_key, '') = ''
     OR p_result NOT IN (
       'DELIVERED', 'ACTION_ENQUEUED', 'RETRYABLE_FAILURE', 'QUOTA_WAIT', 'EXTERNAL_WAIT',
       'RESOLVED', 'SUPERSEDED', 'ESCALATED', 'TERMINAL'
     ) OR jsonb_typeof(p_detail) <> 'object' THEN
    RAISE EXCEPTION 'OUTCOME_COORDINATOR_RESULT_INVALID' USING ERRCODE = '22023';
  END IF;
  IF (p_result = 'RETRYABLE_FAILURE')
     <> (p_failure_fingerprint IS NOT NULL
       AND COALESCE(outcome_valid_digest(p_failure_fingerprint), false)) THEN
    RAISE EXCEPTION 'OUTCOME_COORDINATOR_FAILURE_FINGERPRINT_INVALID' USING ERRCODE = '22023';
  END IF;
  now_value := outcome_coordinator_now(p_tenant_id);
  SELECT * INTO previous
    FROM outcome_coordinator_attempt_result
   WHERE tenant_id = p_tenant_id AND callback_key = p_callback_key;
  IF FOUND THEN
    RETURN jsonb_build_object(
      'coordinationId', previous.coordination_id::text,
      'result', previous.result,
      'replayed', true
    );
  END IF;
  SELECT * INTO standing
    FROM outcome_coordinator_obligation
   WHERE tenant_id = p_tenant_id AND coordination_id = p_coordination_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'OUTCOME_COORDINATOR_OBLIGATION_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;
  IF standing.status <> 'CLAIMED' OR standing.lease_token IS DISTINCT FROM p_lease_token
     OR standing.lease_owner IS DISTINCT FROM p_worker_id
     OR standing.lease_expires_logical_time < now_value THEN
    RAISE EXCEPTION 'OUTCOME_COORDINATOR_LEASE_STALE' USING ERRCODE = '40001';
  END IF;
  SELECT * INTO lease_value
    FROM outcome_coordinator_lease
   WHERE lease_id = standing.lease_id AND lease_token = p_lease_token;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'OUTCOME_COORDINATOR_LEASE_EVIDENCE_MISSING' USING ERRCODE = '23514';
  END IF;
  SELECT * INTO previous
    FROM outcome_coordinator_attempt_result
   WHERE lease_id = lease_value.lease_id;
  IF FOUND THEN
    RETURN jsonb_build_object(
      'coordinationId', previous.coordination_id::text,
      'result', previous.result,
      'replayed', true
    );
  END IF;

  IF p_result = 'ACTION_ENQUEUED' THEN
    IF COALESCE(p_detail->>'actionIntentId', '') = '' THEN
      RAISE EXCEPTION 'OUTCOME_COORDINATOR_ACTION_INTENT_REQUIRED' USING ERRCODE = '22023';
    END IF;
    SELECT * INTO action_value
      FROM outcome_action_intent
     WHERE tenant_id = standing.tenant_id AND project_id = standing.project_id
       AND action_intent_id::text = p_detail->>'actionIntentId'
       AND obligation_id = standing.obligation_id
       AND obligation_revision = standing.obligation_revision;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'OUTCOME_COORDINATOR_ACTION_NOT_CONSTRAINED_OR_BOUND'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  INSERT INTO outcome_coordinator_attempt_result (
    result_id, tenant_id, project_id, coordination_id, lease_id,
    obligation_revision, callback_key, result, failure_fingerprint,
    detail, logical_time
  ) VALUES (
    gen_random_uuid(), standing.tenant_id, standing.project_id, standing.coordination_id,
    lease_value.lease_id, standing.obligation_revision, p_callback_key, p_result,
    p_failure_fingerprint, p_detail, now_value
  );
  UPDATE outcome_coordinator_obligation
     SET last_progress_logical_time = now_value,
         progress_deadline_logical_time = now_value + liveness_delta,
         updated_at = clock_timestamp()
   WHERE coordination_id = standing.coordination_id;

  IF p_result = 'RETRYABLE_FAILURE' THEN
    delay_value := COALESCE(p_retry_after, GREATEST(1, standing.attempt_count));
    RETURN outcome_apply_coordinator_failure(
      standing.coordination_id,
      p_failure_fingerprint,
      'ATTEMPT_RETRYABLE_FAILURE',
      now_value,
      delay_value,
      p_detail || jsonb_build_object('leaseId', lease_value.lease_id::text)
    );
  ELSIF p_result IN ('QUOTA_WAIT', 'EXTERNAL_WAIT') THEN
    IF COALESCE(p_detail->>'provider', '') = ''
       OR NOT (p_detail ? 'condition')
       OR COALESCE(p_detail->>'pollBudget', '') !~ '^[1-9][0-9]*$'
       OR p_retry_after IS NULL OR p_retry_after <= 0 THEN
      RAISE EXCEPTION 'OUTCOME_COORDINATOR_EXTERNAL_WAIT_INVALID' USING ERRCODE = '22023';
    END IF;
    IF p_retry_after > standing.liveness_delta THEN
      RAISE EXCEPTION 'OUTCOME_COORDINATOR_EXTERNAL_WAIT_OUTSIDE_LIVENESS_BOUND'
        USING ERRCODE = '22023';
    END IF;
    condition_value := p_detail->'condition';
    condition_digest_value := outcome_sha256_json(condition_value);
    poll_budget_value := (p_detail->>'pollBudget')::integer;
    SELECT * INTO wait_value
      FROM outcome_coordinator_external_wait
     WHERE coordination_id = standing.coordination_id
       AND obligation_revision = standing.obligation_revision
       AND state = 'ACTIVE'
     ORDER BY created_at DESC LIMIT 1
     FOR UPDATE;
    IF FOUND THEN
      poll_budget_value := wait_value.poll_budget_max;
      poll_remaining_value := wait_value.poll_budget_remaining - 1;
      IF wait_value.condition_digest::text <> condition_digest_value THEN
        UPDATE outcome_coordinator_external_wait
           SET state = 'SUPERSEDED', updated_at = clock_timestamp()
         WHERE wait_id = wait_value.wait_id;
        wait_value.wait_id := NULL;
      END IF;
    ELSE
      poll_remaining_value := poll_budget_value - 1;
    END IF;
    IF poll_remaining_value < 0 THEN
      UPDATE outcome_coordinator_obligation
         SET diagnostic_path = 'EXTERNAL_WAIT_BUDGET_EXHAUSTED'
       WHERE coordination_id = standing.coordination_id;
      RETURN outcome_terminalize_coordination(
        standing.coordination_id,
        'ESCALATED',
        'EXTERNAL_WAIT_BUDGET_EXHAUSTED',
        'ESCALATE',
        now_value,
        jsonb_build_object('provider', p_detail->>'provider', 'condition', condition_value)
      );
    END IF;
    wait_id_value := COALESCE(wait_value.wait_id, gen_random_uuid());
    INSERT INTO outcome_coordinator_external_wait (
      wait_id, tenant_id, project_id, coordination_id, obligation_revision,
      provider, condition, condition_digest, poll_budget_max, poll_budget_remaining,
      next_poll_logical_time, state
    ) VALUES (
      wait_id_value, standing.tenant_id, standing.project_id, standing.coordination_id,
      standing.obligation_revision, p_detail->>'provider', condition_value,
      condition_digest_value, poll_budget_value, poll_remaining_value,
      now_value + p_retry_after, 'ACTIVE'
    ) ON CONFLICT (coordination_id, obligation_revision, condition_digest) DO UPDATE SET
      provider = EXCLUDED.provider,
      poll_budget_remaining = EXCLUDED.poll_budget_remaining,
      next_poll_logical_time = EXCLUDED.next_poll_logical_time,
      state = 'ACTIVE', updated_at = clock_timestamp()
    RETURNING wait_id INTO wait_id_value;
    UPDATE outcome_coordinator_obligation
       SET durable_owner = 'SYSTEM', external_wait_id = wait_id_value,
           diagnostic_path = CASE WHEN p_result = 'QUOTA_WAIT'
             THEN 'QUOTA_MONITOR' ELSE 'EXTERNAL_MONITOR' END,
           updated_at = clock_timestamp()
     WHERE coordination_id = standing.coordination_id;
    PERFORM outcome_append_coordinator_event(
      standing.coordination_id,
      'external-wait:' || wait_id_value::text || ':' || poll_remaining_value::text,
      CASE WHEN p_result = 'QUOTA_WAIT' THEN 'QUOTA_WAIT_OBSERVED'
        ELSE 'EXTERNAL_WAIT_OBSERVED' END,
      'CLAIMED',
      'EXTERNAL_WAIT',
      'EXTERNAL_WAIT',
      now_value,
      NULL,
      jsonb_build_object(
        'provider', p_detail->>'provider',
        'conditionDigest', condition_digest_value,
        'pollBudgetRemaining', poll_remaining_value,
        'ownerNotified', false
      )
    );
    wake_receipt := outcome_schedule_coordinator_wake(
      standing.coordination_id,
      now_value + p_retry_after,
      CASE WHEN p_result = 'QUOTA_WAIT' THEN 'QUOTA_RECHECK_DUE'
        ELSE 'EXTERNAL_RECHECK_DUE' END,
      'EXTERNAL_WAIT'
    );
    RETURN jsonb_build_object(
      'coordinationId', standing.coordination_id::text,
      'status', COALESCE(wake_receipt->>'status', 'EXTERNAL_WAIT'),
      'durableOwner', 'SYSTEM',
      'ownerNotified', false,
      'waitId', wait_id_value::text,
      'pollBudgetRemaining', poll_remaining_value,
      'wake', wake_receipt,
      'replayed', false
    );
  ELSIF p_result IN ('DELIVERED', 'ACTION_ENQUEUED') THEN
    UPDATE outcome_coordinator_obligation
       SET action_intent_id = CASE WHEN p_result = 'ACTION_ENQUEUED'
             THEN action_value.action_intent_id ELSE action_intent_id END,
           diagnostic_path = CASE WHEN p_result = 'ACTION_ENQUEUED'
             THEN 'ACTION_EXECUTOR_FOLLOWUP' ELSE 'DELIVERY_FOLLOWUP' END,
           updated_at = clock_timestamp()
     WHERE coordination_id = standing.coordination_id;
    PERFORM outcome_append_coordinator_event(
      standing.coordination_id,
      'attempt-delivery:' || lease_value.lease_id::text,
      CASE WHEN p_result = 'ACTION_ENQUEUED' THEN 'CONSTRAINED_ACTION_ENQUEUED'
        ELSE 'ATTEMPT_DELIVERED' END,
      'CLAIMED',
      'SCHEDULED',
      'EXTERNAL_DELIVERY',
      now_value,
      NULL,
      p_detail
    );
    wake_receipt := outcome_schedule_coordinator_wake(
      standing.coordination_id,
      now_value + LEAST(1, standing.liveness_delta),
      CASE WHEN p_result = 'ACTION_ENQUEUED' THEN 'ACTION_FOLLOWUP_DUE'
        ELSE 'DELIVERY_REEVALUATION_DUE' END,
      'SCHEDULED'
    );
    RETURN jsonb_build_object(
      'coordinationId', standing.coordination_id::text,
      'status', COALESCE(wake_receipt->>'status', 'SCHEDULED'),
      'result', p_result,
      'wake', wake_receipt,
      'replayed', false
    );
  ELSIF p_result = 'RESOLVED' THEN
    transition_receipt := outcome_terminalize_coordination(
      standing.coordination_id, 'RESOLVED', 'OBLIGATION_RESOLVED',
      'TERMINAL_DISPOSITION', now_value, p_detail
    );
  ELSIF p_result = 'SUPERSEDED' THEN
    transition_receipt := outcome_terminalize_coordination(
      standing.coordination_id, 'SUPERSEDED', 'OBLIGATION_SUPERSEDED',
      'SUPERSEDE', now_value, p_detail
    );
  ELSIF p_result = 'ESCALATED' THEN
    transition_receipt := outcome_terminalize_coordination(
      standing.coordination_id, 'ESCALATED', 'AGENT_ESCALATION_RECORDED',
      'ESCALATE', now_value, p_detail
    );
  ELSE
    transition_receipt := outcome_terminalize_coordination(
      standing.coordination_id, 'TERMINAL', 'EXPLICIT_TERMINAL_DISPOSITION',
      'TERMINAL_DISPOSITION', now_value, p_detail
    );
  END IF;
  RETURN transition_receipt || jsonb_build_object('result', p_result, 'replayed', false);
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION outcome_request_coordinator_owner_decision(
  p_tenant_id uuid,
  p_coordination_id uuid,
  p_lease_token uuid,
  p_worker_id text,
  p_reason text,
  p_request jsonb
) RETURNS jsonb AS $$
DECLARE
  standing outcome_coordinator_obligation%ROWTYPE;
  lease_value outcome_coordinator_lease%ROWTYPE;
  previous outcome_coordinator_owner_decision_request%ROWTYPE;
  request_value uuid;
  request_digest_value text;
  expected_kind text;
  now_value bigint;
BEGIN
  IF p_reason NOT IN ('GOAL_DECISION', 'RISK_ACCEPTANCE', 'NEW_AUTHORIZATION', 'EXTERNAL_IDENTITY') THEN
    RAISE EXCEPTION 'OUTCOME_OWNER_DECISION_REASON_FORBIDDEN' USING ERRCODE = '22023';
  END IF;
  IF jsonb_typeof(p_request) <> 'object'
     OR NOT (p_request ?& ARRAY[
       'whyNotAgent', 'options', 'impacts', 'recommendation', 'noActionConsequence',
       'cost', 'deadline', 'resumeBehavior', 'idempotencyKey'
     ]) THEN
    RAISE EXCEPTION 'OUTCOME_OWNER_DECISION_PAYLOAD_INCOMPLETE' USING ERRCODE = '22023';
  END IF;
  IF btrim(COALESCE(p_request->>'whyNotAgent', '')) = '' THEN
    RAISE EXCEPTION 'OUTCOME_OWNER_DECISION_WHY_NOT_AGENT_REQUIRED' USING ERRCODE = '22023';
  END IF;
  IF jsonb_typeof(p_request->'options') <> 'array'
     OR jsonb_array_length(p_request->'options') = 0
     OR jsonb_typeof(p_request->'impacts') <> 'array'
     OR jsonb_array_length(p_request->'impacts') = 0
     OR btrim(COALESCE(p_request->>'idempotencyKey', '')) = '' THEN
    RAISE EXCEPTION 'OUTCOME_OWNER_DECISION_PROTOCOL_INVALID' USING ERRCODE = '22023';
  END IF;
  expected_kind := CASE p_reason
    WHEN 'GOAL_DECISION' THEN 'REQUEST_GOAL_DECISION'
    WHEN 'RISK_ACCEPTANCE' THEN 'REQUEST_RISK_ACCEPTANCE'
    WHEN 'NEW_AUTHORIZATION' THEN 'REQUEST_NEW_AUTHORIZATION'
    WHEN 'EXTERNAL_IDENTITY' THEN 'REQUEST_EXTERNAL_IDENTITY'
  END;
  now_value := outcome_coordinator_now(p_tenant_id);
  SELECT * INTO standing
    FROM outcome_coordinator_obligation
   WHERE tenant_id = p_tenant_id AND coordination_id = p_coordination_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'OUTCOME_COORDINATOR_OBLIGATION_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;
  IF standing.kind <> expected_kind THEN
    RAISE EXCEPTION 'OUTCOME_OWNER_DECISION_KIND_MISMATCH' USING ERRCODE = '22023';
  END IF;
  IF standing.status <> 'CLAIMED' OR standing.lease_token IS DISTINCT FROM p_lease_token
     OR standing.lease_owner IS DISTINCT FROM p_worker_id
     OR standing.lease_expires_logical_time < now_value THEN
    RAISE EXCEPTION 'OUTCOME_COORDINATOR_LEASE_STALE' USING ERRCODE = '40001';
  END IF;
  SELECT * INTO lease_value FROM outcome_coordinator_lease
   WHERE lease_id = standing.lease_id AND lease_token = p_lease_token;
  request_digest_value := outcome_sha256_json(p_request);
  SELECT * INTO previous
    FROM outcome_coordinator_owner_decision_request
   WHERE tenant_id = standing.tenant_id AND project_id = standing.project_id
     AND idempotency_key = p_request->>'idempotencyKey';
  IF FOUND THEN
    IF previous.request_digest::text <> request_digest_value
       OR previous.obligation_revision IS DISTINCT FROM standing.obligation_revision THEN
      RAISE EXCEPTION 'OUTCOME_OWNER_DECISION_IDEMPOTENCY_CONFLICT' USING ERRCODE = '23505';
    END IF;
    RETURN jsonb_build_object(
      'requestId', previous.request_id::text,
      'coordinationId', previous.coordination_id::text,
      'status', previous.status,
      'replayed', true
    );
  END IF;
  IF EXISTS (
    SELECT 1 FROM outcome_coordinator_owner_decision_request
     WHERE coordination_id = standing.coordination_id AND status = 'OPEN'
  ) THEN
    RAISE EXCEPTION 'OUTCOME_OWNER_DECISION_ALREADY_OPEN' USING ERRCODE = '23505';
  END IF;
  request_value := gen_random_uuid();
  INSERT INTO outcome_coordinator_attempt_result (
    result_id, tenant_id, project_id, coordination_id, lease_id,
    obligation_revision, callback_key, result, detail, logical_time
  ) VALUES (
    gen_random_uuid(), standing.tenant_id, standing.project_id, standing.coordination_id,
    lease_value.lease_id, standing.obligation_revision,
    'owner-request:' || (p_request->>'idempotencyKey'),
    'OWNER_DECISION_REQUESTED', p_request, now_value
  );
  INSERT INTO outcome_coordinator_owner_decision_request (
    request_id, tenant_id, project_id, coordination_id, obligation_revision,
    reason, why_not_agent, idempotency_key, request, request_digest,
    status, requested_logical_time
  ) VALUES (
    request_value, standing.tenant_id, standing.project_id, standing.coordination_id,
    standing.obligation_revision, p_reason, p_request->>'whyNotAgent',
    p_request->>'idempotencyKey', p_request, request_digest_value, 'OPEN', now_value
  );
  UPDATE outcome_coordinator_obligation
     SET status = 'OWNER_DECISION', durable_owner = 'OWNER',
         decision_request_id = request_value,
         lease_id = NULL, lease_token = NULL, lease_owner = NULL,
         lease_expires_logical_time = NULL,
         last_progress_logical_time = now_value,
         progress_deadline_logical_time = now_value + liveness_delta,
         diagnostic_path = 'VALIDATED_OWNER_DECISION',
         updated_at = clock_timestamp()
   WHERE coordination_id = standing.coordination_id;
  PERFORM outcome_append_coordinator_event(
    standing.coordination_id,
    'owner-request:' || request_value::text,
    'OWNER_DECISION_REQUESTED',
    'CLAIMED',
    'OWNER_DECISION',
    'OWNER_DECISION_REQUEST',
    now_value,
    NULL,
    jsonb_build_object(
      'requestId', request_value::text,
      'reason', p_reason,
      'whyNotAgent', p_request->>'whyNotAgent'
    )
  );
  RETURN jsonb_build_object(
    'requestId', request_value::text,
    'coordinationId', standing.coordination_id::text,
    'status', 'OPEN',
    'reason', p_reason,
    'replayed', false
  );
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION outcome_decide_coordinator_owner_request(
  p_tenant_id uuid,
  p_request_id uuid,
  p_obligation_revision text,
  p_idempotency_key text,
  p_decision jsonb
) RETURNS jsonb AS $$
DECLARE
  request_value outcome_coordinator_owner_decision_request%ROWTYPE;
  standing outcome_coordinator_obligation%ROWTYPE;
  now_value bigint;
  wake_receipt jsonb;
BEGIN
  IF NOT COALESCE(outcome_valid_digest(p_obligation_revision), false)
     OR COALESCE(p_idempotency_key, '') = '' OR jsonb_typeof(p_decision) <> 'object' THEN
    RAISE EXCEPTION 'OUTCOME_OWNER_DECISION_CALLBACK_INVALID' USING ERRCODE = '22023';
  END IF;
  now_value := outcome_coordinator_now(p_tenant_id);
  SELECT * INTO request_value
    FROM outcome_coordinator_owner_decision_request
   WHERE tenant_id = p_tenant_id AND request_id = p_request_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'OUTCOME_OWNER_DECISION_REQUEST_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;
  IF request_value.status = 'DECIDED' THEN
    IF request_value.decision_idempotency_key IS DISTINCT FROM p_idempotency_key
       OR request_value.decision_digest IS DISTINCT FROM outcome_sha256_json(p_decision) THEN
      RAISE EXCEPTION 'OUTCOME_OWNER_DECISION_CALLBACK_CONFLICT' USING ERRCODE = '23505';
    END IF;
    RETURN jsonb_build_object(
      'requestId', request_value.request_id::text,
      'status', 'DECIDED',
      'replayed', true
    );
  END IF;
  IF request_value.status <> 'OPEN'
     OR request_value.obligation_revision::text <> p_obligation_revision THEN
    RAISE EXCEPTION 'OUTCOME_OWNER_DECISION_REQUEST_STALE' USING ERRCODE = '40001';
  END IF;
  SELECT * INTO standing
    FROM outcome_coordinator_obligation
   WHERE coordination_id = request_value.coordination_id
   FOR UPDATE;
  IF standing.status <> 'OWNER_DECISION'
     OR standing.obligation_revision::text <> p_obligation_revision
     OR standing.decision_request_id IS DISTINCT FROM request_value.request_id THEN
    RAISE EXCEPTION 'OUTCOME_OWNER_DECISION_REQUEST_STALE' USING ERRCODE = '40001';
  END IF;
  UPDATE outcome_coordinator_owner_decision_request
     SET status = 'DECIDED', decision = p_decision,
         decision_digest = outcome_sha256_json(p_decision),
         decision_idempotency_key = p_idempotency_key,
         decided_logical_time = now_value, decided_at = clock_timestamp()
   WHERE request_id = request_value.request_id;
  UPDATE outcome_coordinator_obligation
     SET status = 'READY', durable_owner = 'AGENT',
         diagnostic_path = 'OWNER_DECISION_DELIVERED',
         last_progress_logical_time = now_value,
         progress_deadline_logical_time = now_value + liveness_delta,
         updated_at = clock_timestamp()
   WHERE coordination_id = standing.coordination_id;
  PERFORM outcome_append_coordinator_event(
    standing.coordination_id,
    'owner-decision:' || request_value.request_id::text,
    'OWNER_DECISION_DELIVERED',
    'OWNER_DECISION',
    'READY',
    'EXTERNAL_DELIVERY',
    now_value,
    NULL,
    jsonb_build_object(
      'requestId', request_value.request_id::text,
      'decisionDigest', outcome_sha256_json(p_decision),
      'resumeBehavior', request_value.request->'resumeBehavior'
    )
  );
  wake_receipt := outcome_schedule_coordinator_wake(
    standing.coordination_id, now_value, 'OWNER_DECISION_RESUME', 'SCHEDULED'
  );
  RETURN jsonb_build_object(
    'requestId', request_value.request_id::text,
    'coordinationId', standing.coordination_id::text,
    'status', 'DECIDED',
    'resumed', true,
    'wake', wake_receipt,
    'replayed', false
  );
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION outcome_coordinator_liveness_audit(
  p_tenant_id uuid
) RETURNS TABLE (
  coordination_id uuid,
  status text,
  violation_code text
) AS $$
DECLARE
  now_value bigint;
BEGIN
  now_value := outcome_coordinator_now(p_tenant_id);
  RETURN QUERY
  SELECT c.coordination_id, c.status,
    CASE
      WHEN c.status = 'CLAIMED' AND (
        c.lease_id IS NULL OR c.lease_expires_logical_time <= now_value
        OR c.progress_deadline_logical_time <= now_value
      ) THEN 'EXPIRED_OR_UNBOUNDED_LEASE'
      WHEN c.status = 'SCHEDULED' AND (
        c.next_wake_logical_time IS NULL
        OR c.next_wake_logical_time > c.progress_deadline_logical_time
        OR NOT EXISTS (
          SELECT 1 FROM outcome_coordinator_wake w
           WHERE w.coordination_id = c.coordination_id
             AND w.generation = c.wake_generation AND w.state = 'SCHEDULED'
        )
      ) THEN 'MISSING_OR_UNBOUNDED_WAKE'
      WHEN c.status = 'READY' AND c.progress_deadline_logical_time <= now_value
        THEN 'STARVED_READY_OBLIGATION'
      WHEN c.status = 'EXTERNAL_WAIT' AND (
        c.next_wake_logical_time IS NULL
        OR c.next_wake_logical_time > c.progress_deadline_logical_time
        OR NOT EXISTS (
          SELECT 1 FROM outcome_coordinator_external_wait w
           WHERE w.wait_id = c.external_wait_id AND w.state = 'ACTIVE'
             AND w.poll_budget_remaining >= 0
        )
      ) THEN 'INVALID_EXTERNAL_WAIT'
      WHEN c.status = 'OWNER_DECISION' AND NOT EXISTS (
        SELECT 1 FROM outcome_coordinator_owner_decision_request r
         WHERE r.request_id = c.decision_request_id AND r.status = 'OPEN'
           AND btrim(r.why_not_agent) <> ''
           AND r.reason IN (
             'GOAL_DECISION', 'RISK_ACCEPTANCE', 'NEW_AUTHORIZATION', 'EXTERNAL_IDENTITY'
           )
      ) THEN 'INVALID_OWNER_DECISION_REQUEST'
      ELSE NULL
    END AS violation_code
  FROM outcome_coordinator_obligation c
  WHERE c.tenant_id = p_tenant_id
    AND c.status IN ('READY', 'CLAIMED', 'SCHEDULED', 'EXTERNAL_WAIT', 'OWNER_DECISION')
    AND CASE
      WHEN c.status = 'CLAIMED' THEN c.lease_id IS NULL
        OR c.lease_expires_logical_time <= now_value
        OR c.progress_deadline_logical_time <= now_value
      WHEN c.status = 'SCHEDULED' THEN c.next_wake_logical_time IS NULL
        OR c.next_wake_logical_time > c.progress_deadline_logical_time
        OR NOT EXISTS (
          SELECT 1 FROM outcome_coordinator_wake w
           WHERE w.coordination_id = c.coordination_id
             AND w.generation = c.wake_generation AND w.state = 'SCHEDULED'
        )
      WHEN c.status = 'READY' THEN c.progress_deadline_logical_time <= now_value
      WHEN c.status = 'EXTERNAL_WAIT' THEN c.next_wake_logical_time IS NULL
        OR c.next_wake_logical_time > c.progress_deadline_logical_time
        OR NOT EXISTS (
          SELECT 1 FROM outcome_coordinator_external_wait w
           WHERE w.wait_id = c.external_wait_id AND w.state = 'ACTIVE'
             AND w.poll_budget_remaining >= 0
        )
      WHEN c.status = 'OWNER_DECISION' THEN NOT EXISTS (
        SELECT 1 FROM outcome_coordinator_owner_decision_request r
         WHERE r.request_id = c.decision_request_id AND r.status = 'OPEN'
           AND btrim(r.why_not_agent) <> ''
           AND r.reason IN (
             'GOAL_DECISION', 'RISK_ACCEPTANCE', 'NEW_AUTHORIZATION', 'EXTERNAL_IDENTITY'
           )
      )
      ELSE false
    END;
END;
$$ LANGUAGE plpgsql STABLE;

COMMIT;
