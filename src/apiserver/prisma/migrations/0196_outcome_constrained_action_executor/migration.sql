-- Outcome Reconciler V2: constrained, fenced and fairly scheduled side-effect execution.
--
-- Action intents and receipts are immutable evidence. Mutable rows are explicitly projections:
-- budget counters, queue state, failure counters, fairness cursors and the active executor-
-- obligation set. Every state transition is retained in outcome_action_event, and every blocking
-- projection has a canonical obligation revision/event trace.
BEGIN;

CREATE TABLE outcome_action_budget_account (
  tenant_id uuid NOT NULL,
  project_id uuid NOT NULL,
  account_id text NOT NULL CHECK (account_id <> ''),
  budget_digest char(64) NOT NULL CHECK (outcome_valid_digest(budget_digest)),
  unit text NOT NULL CHECK (unit <> ''),
  limit_amount numeric(30, 6) NOT NULL CHECK (limit_amount >= 0),
  reserved_amount numeric(30, 6) NOT NULL DEFAULT 0 CHECK (reserved_amount >= 0),
  spent_amount numeric(30, 6) NOT NULL DEFAULT 0 CHECK (spent_amount >= 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, project_id, account_id, budget_digest, unit),
  FOREIGN KEY (tenant_id, project_id)
    REFERENCES outcome_fact_stream(tenant_id, project_id),
  CHECK (reserved_amount + spent_amount <= limit_amount)
);

CREATE TABLE outcome_action_precondition (
  tenant_id uuid NOT NULL,
  project_id uuid NOT NULL,
  resource_type text NOT NULL CHECK (resource_type <> ''),
  resource_id text NOT NULL CHECK (resource_id <> ''),
  generation bigint NOT NULL CHECK (generation > 0),
  precondition_digest char(64) NOT NULL CHECK (outcome_valid_digest(precondition_digest)),
  target_digest char(64) NOT NULL CHECK (outcome_valid_digest(target_digest)),
  recorded_logical_time bigint NOT NULL CHECK (recorded_logical_time > 0),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, project_id, resource_type, resource_id),
  FOREIGN KEY (tenant_id, project_id)
    REFERENCES outcome_fact_stream(tenant_id, project_id)
);

CREATE TABLE outcome_action_intent (
  action_intent_id uuid PRIMARY KEY,
  queue_sequence bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  tenant_id uuid NOT NULL,
  project_id uuid NOT NULL,
  obligation_id char(64) NOT NULL CHECK (outcome_valid_digest(obligation_id)),
  obligation_revision char(64) NOT NULL CHECK (outcome_valid_digest(obligation_revision)),
  binding_digest char(64) NOT NULL CHECK (outcome_valid_digest(binding_digest)),
  protocol_digest char(64) NOT NULL CHECK (outcome_valid_digest(protocol_digest)),
  action_kind text NOT NULL CHECK (action_kind <> ''),
  effect_class text NOT NULL CHECK (effect_class IN (
    'READ_ONLY', 'REVERSIBLE_INTERNAL', 'IRREVERSIBLE_INTERNAL',
    'EXTERNAL_REVERSIBLE', 'EXTERNAL_IRREVERSIBLE'
  )),
  resource_type text NOT NULL CHECK (resource_type <> ''),
  resource_id text NOT NULL CHECK (resource_id <> ''),
  target_digest char(64) NOT NULL CHECK (outcome_valid_digest(target_digest)),
  principal_type text NOT NULL CHECK (principal_type IN ('SYSTEM', 'AGENT', 'OWNER', 'RUNNER', 'PROVIDER')),
  principal_id text NOT NULL CHECK (principal_id <> ''),
  authority_grant_digest char(64) NOT NULL CHECK (outcome_valid_digest(authority_grant_digest)),
  policy_digest char(64) NOT NULL CHECK (outcome_valid_digest(policy_digest)),
  precondition_digest char(64) NOT NULL CHECK (outcome_valid_digest(precondition_digest)),
  evaluated_through_logical_time bigint NOT NULL CHECK (evaluated_through_logical_time >= 0),
  idempotency_key text NOT NULL CHECK (idempotency_key <> ''),
  budget_account_id text NOT NULL CHECK (budget_account_id <> ''),
  budget_digest char(64) NOT NULL CHECK (outcome_valid_digest(budget_digest)),
  budget_unit text NOT NULL CHECK (budget_unit <> ''),
  budget_charge numeric(30, 6) NOT NULL CHECK (budget_charge >= 0),
  budget_limit numeric(30, 6) NOT NULL CHECK (budget_limit >= budget_charge),
  budget_reservation_id text NOT NULL CHECK (budget_reservation_id <> ''),
  retry_max_attempts integer NOT NULL CHECK (retry_max_attempts > 0),
  retry_same_fingerprint_limit integer NOT NULL CHECK (
    retry_same_fingerprint_limit > 0 AND retry_same_fingerprint_limit <= retry_max_attempts
  ),
  retry_backoff_digest char(64) NOT NULL CHECK (outcome_valid_digest(retry_backoff_digest)),
  retry_backoff_logical_ticks bigint[] NOT NULL CHECK (
    cardinality(retry_backoff_logical_ticks) > 0 AND 0 < ALL(retry_backoff_logical_ticks)
  ),
  timeout_logical_ticks bigint NOT NULL CHECK (timeout_logical_ticks > 0),
  timeout_wall_clock_ms integer NOT NULL CHECK (timeout_wall_clock_ms > 0),
  compensator_capability text,
  manual_recovery text,
  remediation_obligation_kind text NOT NULL CHECK (remediation_obligation_kind = 'REMEDIATE_SIDE_EFFECT'),
  status text NOT NULL CHECK (status IN (
    'QUEUED', 'BLOCKED_BUDGET', 'CLAIMED', 'COMMITTING', 'BACKOFF', 'WAITING_QUOTA',
    'SUCCEEDED', 'COMPENSATED', 'FAILED', 'REMEDIATION_REQUIRED', 'TIMED_OUT',
    'CANCELLED', 'REFUSED'
  )),
  effect_state text NOT NULL DEFAULT 'NONE' CHECK (effect_state IN (
    'NONE', 'POSSIBLE', 'CONFIRMED', 'UNKNOWN', 'COMPENSATED'
  )),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  next_eligible_logical_time bigint NOT NULL CHECK (next_eligible_logical_time >= 0),
  deadline_logical_time bigint NOT NULL CHECK (deadline_logical_time >= next_eligible_logical_time),
  lease_token uuid,
  lease_owner text,
  lease_expires_logical_time bigint,
  commit_txid bigint,
  source_obligation jsonb NOT NULL,
  intent jsonb NOT NULL,
  request_digest char(64) NOT NULL CHECK (outcome_valid_digest(request_digest)),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (tenant_id, project_id, idempotency_key),
  UNIQUE (tenant_id, project_id, budget_reservation_id),
  UNIQUE (tenant_id, project_id, action_intent_id),
  FOREIGN KEY (tenant_id, project_id, binding_digest)
    REFERENCES outcome_fact_binding(tenant_id, project_id, binding_digest),
  FOREIGN KEY (tenant_id, project_id, obligation_revision)
    REFERENCES outcome_obligation_revision(tenant_id, project_id, obligation_revision),
  FOREIGN KEY (tenant_id, project_id, budget_account_id, budget_digest, budget_unit)
    REFERENCES outcome_action_budget_account(tenant_id, project_id, account_id, budget_digest, unit),
  CHECK ((compensator_capability IS NOT NULL) OR (manual_recovery IS NOT NULL)),
  CHECK ((lease_token IS NULL) = (lease_owner IS NULL)),
  CHECK ((lease_token IS NULL) = (lease_expires_logical_time IS NULL)),
  CHECK ((status = 'COMMITTING') = (commit_txid IS NOT NULL))
);

CREATE INDEX outcome_action_intent_ready_idx
  ON outcome_action_intent (
    tenant_id, status, next_eligible_logical_time, project_id, queue_sequence
  );
CREATE INDEX outcome_action_intent_project_idx
  ON outcome_action_intent (tenant_id, project_id, created_at DESC);

CREATE TABLE outcome_action_attempt (
  attempt_id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  project_id uuid NOT NULL,
  action_intent_id uuid NOT NULL REFERENCES outcome_action_intent(action_intent_id),
  attempt_number integer NOT NULL CHECK (attempt_number > 0),
  worker_id text NOT NULL CHECK (worker_id <> ''),
  lease_token uuid NOT NULL,
  claimed_logical_time bigint NOT NULL CHECK (claimed_logical_time >= 0),
  lease_expires_logical_time bigint NOT NULL CHECK (lease_expires_logical_time > claimed_logical_time),
  claimed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (action_intent_id, attempt_number),
  UNIQUE (action_intent_id, lease_token),
  FOREIGN KEY (tenant_id, project_id, action_intent_id)
    REFERENCES outcome_action_intent(tenant_id, project_id, action_intent_id)
);

CREATE TABLE outcome_action_receipt (
  receipt_id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  project_id uuid NOT NULL,
  action_intent_id uuid NOT NULL,
  attempt_number integer NOT NULL CHECK (attempt_number > 0),
  provider_identity text NOT NULL CHECK (provider_identity <> ''),
  effect_digest char(64) NOT NULL CHECK (outcome_valid_digest(effect_digest)),
  observed_at timestamptz NOT NULL,
  result text NOT NULL CHECK (result IN (
    'SUCCEEDED', 'RETRYABLE_FAILURE', 'PERMANENT_FAILURE', 'QUOTA_WAIT',
    'PARTIAL_EFFECT', 'WRONG_EFFECT', 'TIMED_OUT'
  )),
  idempotency_key text NOT NULL CHECK (idempotency_key <> ''),
  failure_fingerprint char(64),
  retry_after_logical_ticks bigint CHECK (retry_after_logical_ticks IS NULL OR retry_after_logical_ticks > 0),
  compensation jsonb,
  receipt jsonb NOT NULL,
  receipt_digest char(64) NOT NULL CHECK (outcome_valid_digest(receipt_digest)),
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (action_intent_id, attempt_number),
  FOREIGN KEY (tenant_id, project_id, action_intent_id)
    REFERENCES outcome_action_intent(tenant_id, project_id, action_intent_id),
  CHECK (failure_fingerprint IS NULL OR outcome_valid_digest(failure_fingerprint)),
  CHECK ((result = 'QUOTA_WAIT') = (retry_after_logical_ticks IS NOT NULL)),
  CHECK (receipt_digest = outcome_sha256_json(receipt))
);

CREATE TABLE outcome_action_failure_fingerprint (
  tenant_id uuid NOT NULL,
  project_id uuid NOT NULL,
  action_intent_id uuid NOT NULL,
  failure_fingerprint char(64) NOT NULL CHECK (outcome_valid_digest(failure_fingerprint)),
  occurrence_count integer NOT NULL CHECK (occurrence_count > 0),
  last_logical_time bigint NOT NULL CHECK (last_logical_time >= 0),
  PRIMARY KEY (action_intent_id, failure_fingerprint),
  FOREIGN KEY (tenant_id, project_id, action_intent_id)
    REFERENCES outcome_action_intent(tenant_id, project_id, action_intent_id)
);

CREATE TABLE outcome_action_event (
  event_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id uuid NOT NULL,
  project_id uuid NOT NULL,
  action_intent_id uuid NOT NULL,
  attempt_number integer,
  from_status text,
  to_status text NOT NULL,
  reason_code text NOT NULL CHECK (reason_code <> ''),
  logical_time bigint NOT NULL CHECK (logical_time >= 0),
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (tenant_id, project_id, action_intent_id)
    REFERENCES outcome_action_intent(tenant_id, project_id, action_intent_id)
);

CREATE INDEX outcome_action_event_trace_idx
  ON outcome_action_event (tenant_id, project_id, action_intent_id, event_id);

CREATE TABLE outcome_action_scheduler (
  tenant_id uuid PRIMARY KEY,
  dispatch_sequence bigint NOT NULL DEFAULT 0 CHECK (dispatch_sequence >= 0)
);

CREATE TABLE outcome_action_project_fairness (
  tenant_id uuid NOT NULL,
  project_id uuid NOT NULL,
  last_dispatched_sequence bigint NOT NULL CHECK (last_dispatched_sequence > 0),
  dispatch_count bigint NOT NULL CHECK (dispatch_count > 0),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, project_id)
);

CREATE TABLE outcome_executor_obligation_revision (
  tenant_id uuid NOT NULL,
  project_id uuid NOT NULL,
  action_intent_id uuid NOT NULL,
  obligation_id char(64) NOT NULL CHECK (outcome_valid_digest(obligation_id)),
  obligation_revision char(64) NOT NULL CHECK (outcome_valid_digest(obligation_revision)),
  binding_digest char(64) NOT NULL CHECK (outcome_valid_digest(binding_digest)),
  kind text NOT NULL CHECK (kind <> ''),
  owner text NOT NULL CHECK (owner IN ('SYSTEM', 'AGENT', 'OWNER', 'EXTERNAL')),
  human_decision_reason text CHECK (human_decision_reason IS NULL OR human_decision_reason IN (
    'GOAL_DECISION', 'RISK_ACCEPTANCE', 'NEW_AUTHORIZATION', 'EXTERNAL_IDENTITY'
  )),
  due_logical_time bigint,
  obligation jsonb NOT NULL,
  obligation_digest char(64) NOT NULL CHECK (outcome_valid_digest(obligation_digest)),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, project_id, obligation_revision),
  UNIQUE (tenant_id, project_id, obligation_id, obligation_revision),
  FOREIGN KEY (tenant_id, project_id, action_intent_id)
    REFERENCES outcome_action_intent(tenant_id, project_id, action_intent_id),
  CHECK ((owner = 'OWNER') = (human_decision_reason IS NOT NULL)),
  CHECK (obligation_digest = outcome_sha256_json(obligation))
);

CREATE TABLE outcome_executor_obligation_event (
  event_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id uuid NOT NULL,
  project_id uuid NOT NULL,
  action_intent_id uuid NOT NULL,
  obligation_id char(64) NOT NULL CHECK (outcome_valid_digest(obligation_id)),
  obligation_revision char(64) NOT NULL CHECK (outcome_valid_digest(obligation_revision)),
  from_state text CHECK (from_state IS NULL OR from_state = 'ACTIVE'),
  to_state text NOT NULL CHECK (to_state IN ('ACTIVE', 'RESOLVED', 'SUPERSEDED', 'CANCELLED', 'TIMED_OUT')),
  reason_code text NOT NULL CHECK (reason_code <> ''),
  logical_time bigint NOT NULL CHECK (logical_time >= 0),
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (tenant_id, project_id, obligation_revision)
    REFERENCES outcome_executor_obligation_revision(tenant_id, project_id, obligation_revision)
);

CREATE TABLE outcome_executor_active_obligation (
  tenant_id uuid NOT NULL,
  project_id uuid NOT NULL,
  action_intent_id uuid NOT NULL,
  obligation_id char(64) NOT NULL CHECK (outcome_valid_digest(obligation_id)),
  obligation_revision char(64) NOT NULL CHECK (outcome_valid_digest(obligation_revision)),
  binding_digest char(64) NOT NULL CHECK (outcome_valid_digest(binding_digest)),
  kind text NOT NULL CHECK (kind <> ''),
  owner text NOT NULL CHECK (owner IN ('SYSTEM', 'AGENT', 'OWNER', 'EXTERNAL')),
  human_decision_reason text CHECK (human_decision_reason IS NULL OR human_decision_reason IN (
    'GOAL_DECISION', 'RISK_ACCEPTANCE', 'NEW_AUTHORIZATION', 'EXTERNAL_IDENTITY'
  )),
  due_logical_time bigint,
  obligation jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, project_id, action_intent_id),
  UNIQUE (tenant_id, project_id, obligation_revision),
  FOREIGN KEY (tenant_id, project_id, obligation_revision)
    REFERENCES outcome_executor_obligation_revision(tenant_id, project_id, obligation_revision),
  CHECK ((owner = 'OWNER') = (human_decision_reason IS NOT NULL))
);

CREATE TABLE outcome_action_diagnostic (
  diagnostic_id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  project_id uuid NOT NULL,
  obligation_id char(64) NOT NULL CHECK (outcome_valid_digest(obligation_id)),
  obligation_revision char(64) NOT NULL CHECK (outcome_valid_digest(obligation_revision)),
  idempotency_key text NOT NULL CHECK (idempotency_key <> ''),
  code text NOT NULL CHECK (code <> ''),
  request_digest char(64) NOT NULL CHECK (outcome_valid_digest(request_digest)),
  canonical_obligation jsonb NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (tenant_id, project_id, idempotency_key),
  FOREIGN KEY (tenant_id, project_id, obligation_revision)
    REFERENCES outcome_obligation_revision(tenant_id, project_id, obligation_revision),
  CHECK (canonical_obligation->>'kind' = 'DIAGNOSE_MODEL_GAP'),
  CHECK (canonical_obligation->>'owner' = 'AGENT'),
  CHECK (canonical_obligation#>>'{reason,humanDecisionReason}' IS NULL)
);

CREATE TRIGGER outcome_action_attempt_append_only
  BEFORE UPDATE OR DELETE ON outcome_action_attempt
  FOR EACH ROW EXECUTE FUNCTION outcome_append_only_guard();
CREATE TRIGGER outcome_action_receipt_append_only
  BEFORE UPDATE OR DELETE ON outcome_action_receipt
  FOR EACH ROW EXECUTE FUNCTION outcome_append_only_guard();
CREATE TRIGGER outcome_action_event_append_only
  BEFORE UPDATE OR DELETE ON outcome_action_event
  FOR EACH ROW EXECUTE FUNCTION outcome_append_only_guard();
CREATE TRIGGER outcome_executor_obligation_revision_append_only
  BEFORE UPDATE OR DELETE ON outcome_executor_obligation_revision
  FOR EACH ROW EXECUTE FUNCTION outcome_append_only_guard();
CREATE TRIGGER outcome_executor_obligation_event_append_only
  BEFORE UPDATE OR DELETE ON outcome_executor_obligation_event
  FOR EACH ROW EXECUTE FUNCTION outcome_append_only_guard();
CREATE TRIGGER outcome_action_diagnostic_append_only
  BEFORE UPDATE OR DELETE ON outcome_action_diagnostic
  FOR EACH ROW EXECUTE FUNCTION outcome_append_only_guard();

CREATE OR REPLACE FUNCTION outcome_action_committing_guard() RETURNS trigger AS $$
DECLARE
  standing_status text;
BEGIN
  IF NEW.status <> 'COMMITTING' THEN
    RETURN NULL;
  END IF;
  SELECT status INTO standing_status
    FROM outcome_action_intent
   WHERE action_intent_id = NEW.action_intent_id;
  IF standing_status = 'COMMITTING' THEN
    RAISE EXCEPTION 'OUTCOME_ACTION_COMMIT_NOT_FINISHED_IN_FENCED_TRANSACTION'
      USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

-- A caller cannot persist BEGIN without FINISH and then perform an unfenced side effect. If the
-- process or connection dies, BEGIN rolls back to CLAIMED and the provider idempotency key is used
-- again on recovery.
CREATE CONSTRAINT TRIGGER outcome_action_committing_must_finish
  AFTER INSERT OR UPDATE OF status ON outcome_action_intent
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION outcome_action_committing_guard();

CREATE OR REPLACE FUNCTION outcome_append_action_event(
  p_action_intent_id uuid,
  p_attempt_number integer,
  p_from_status text,
  p_to_status text,
  p_reason_code text,
  p_logical_time bigint,
  p_detail jsonb DEFAULT '{}'::jsonb
) RETURNS bigint AS $$
DECLARE
  action_value outcome_action_intent%ROWTYPE;
  event_value bigint;
BEGIN
  SELECT * INTO action_value
    FROM outcome_action_intent
   WHERE action_intent_id = p_action_intent_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'OUTCOME_ACTION_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;
  IF COALESCE(p_to_status, '') = '' OR COALESCE(p_reason_code, '') = ''
     OR p_logical_time < 0 OR jsonb_typeof(p_detail) <> 'object' THEN
    RAISE EXCEPTION 'OUTCOME_ACTION_EVENT_INVALID' USING ERRCODE = '22023';
  END IF;
  INSERT INTO outcome_action_event (
    tenant_id, project_id, action_intent_id, attempt_number, from_status, to_status,
    reason_code, logical_time, detail
  ) VALUES (
    action_value.tenant_id, action_value.project_id, p_action_intent_id, p_attempt_number,
    p_from_status, p_to_status, p_reason_code, p_logical_time, p_detail
  ) RETURNING event_id INTO event_value;
  RETURN event_value;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION outcome_register_action_budget(
  p_authenticated_tenant uuid,
  p_project_id uuid,
  p_account_id text,
  p_budget_digest text,
  p_unit text,
  p_limit numeric
) RETURNS jsonb AS $$
DECLARE
  standing outcome_action_budget_account%ROWTYPE;
BEGIN
  IF COALESCE(p_account_id, '') = '' OR COALESCE(p_unit, '') = '' OR p_limit < 0
     OR NOT COALESCE(outcome_valid_digest(p_budget_digest), false) THEN
    RAISE EXCEPTION 'OUTCOME_ACTION_BUDGET_INVALID' USING ERRCODE = '22023';
  END IF;
  PERFORM 1 FROM outcome_fact_stream
   WHERE tenant_id = p_authenticated_tenant AND project_id = p_project_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'OUTCOME_ACTION_STREAM_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;
  SELECT * INTO standing
    FROM outcome_action_budget_account
   WHERE tenant_id = p_authenticated_tenant AND project_id = p_project_id
     AND account_id = p_account_id AND budget_digest = p_budget_digest AND unit = p_unit
   FOR UPDATE;
  IF FOUND THEN
    IF standing.limit_amount IS DISTINCT FROM p_limit THEN
      RAISE EXCEPTION 'OUTCOME_ACTION_BUDGET_DIGEST_REUSED' USING ERRCODE = '23505';
    END IF;
  ELSE
    INSERT INTO outcome_action_budget_account (
      tenant_id, project_id, account_id, budget_digest, unit, limit_amount
    ) VALUES (
      p_authenticated_tenant, p_project_id, p_account_id, p_budget_digest, p_unit, p_limit
    );
    SELECT * INTO standing
      FROM outcome_action_budget_account
     WHERE tenant_id = p_authenticated_tenant AND project_id = p_project_id
       AND account_id = p_account_id AND budget_digest = p_budget_digest AND unit = p_unit;
  END IF;
  RETURN jsonb_build_object(
    'accountId', standing.account_id,
    'budgetDigest', standing.budget_digest::text,
    'unit', standing.unit,
    'limit', standing.limit_amount,
    'reserved', standing.reserved_amount,
    'spent', standing.spent_amount
  );
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION outcome_register_action_precondition(
  p_authenticated_tenant uuid,
  p_project_id uuid,
  p_resource_type text,
  p_resource_id text,
  p_precondition_digest text,
  p_target_digest text
) RETURNS jsonb AS $$
DECLARE
  standing outcome_action_precondition%ROWTYPE;
  next_generation bigint;
  logical_time_value bigint;
BEGIN
  IF COALESCE(p_resource_type, '') = '' OR COALESCE(p_resource_id, '') = ''
     OR NOT COALESCE(outcome_valid_digest(p_precondition_digest), false)
     OR NOT COALESCE(outcome_valid_digest(p_target_digest), false) THEN
    RAISE EXCEPTION 'OUTCOME_ACTION_PRECONDITION_INVALID' USING ERRCODE = '22023';
  END IF;
  PERFORM 1 FROM outcome_fact_stream
   WHERE tenant_id = p_authenticated_tenant AND project_id = p_project_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'OUTCOME_ACTION_STREAM_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;
  SELECT * INTO standing
    FROM outcome_action_precondition
   WHERE tenant_id = p_authenticated_tenant AND project_id = p_project_id
     AND resource_type = p_resource_type AND resource_id = p_resource_id;
  IF FOUND AND standing.precondition_digest::text = p_precondition_digest
     AND standing.target_digest::text = p_target_digest THEN
    RETURN jsonb_build_object(
      'generation', standing.generation::text,
      'preconditionDigest', standing.precondition_digest::text,
      'targetDigest', standing.target_digest::text,
      'logicalTime', standing.recorded_logical_time::text,
      'replayed', true
    );
  END IF;
  next_generation := COALESCE(standing.generation, 0) + 1;
  UPDATE outcome_fact_stream
     SET last_logical_time = last_logical_time + 1, updated_at = clock_timestamp()
   WHERE tenant_id = p_authenticated_tenant AND project_id = p_project_id
   RETURNING last_logical_time INTO logical_time_value;
  INSERT INTO outcome_action_precondition (
    tenant_id, project_id, resource_type, resource_id, generation,
    precondition_digest, target_digest, recorded_logical_time
  ) VALUES (
    p_authenticated_tenant, p_project_id, p_resource_type, p_resource_id,
    next_generation, p_precondition_digest, p_target_digest, logical_time_value
  ) ON CONFLICT (tenant_id, project_id, resource_type, resource_id) DO UPDATE SET
    generation = EXCLUDED.generation,
    precondition_digest = EXCLUDED.precondition_digest,
    target_digest = EXCLUDED.target_digest,
    recorded_logical_time = EXCLUDED.recorded_logical_time,
    updated_at = clock_timestamp();
  RETURN jsonb_build_object(
    'generation', next_generation::text,
    'preconditionDigest', p_precondition_digest,
    'targetDigest', p_target_digest,
    'logicalTime', logical_time_value::text,
    'replayed', false
  );
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION outcome_activate_executor_obligation(
  p_action_intent_id uuid,
  p_reason_code text,
  p_logical_time bigint,
  p_due_logical_time bigint DEFAULT NULL,
  p_detail jsonb DEFAULT '{}'::jsonb
) RETURNS jsonb AS $$
DECLARE
  action_value outcome_action_intent%ROWTYPE;
  old_active outcome_executor_active_obligation%ROWTYPE;
  obligation_id_value text;
  revision_value text;
  kind_value text;
  owner_value text;
  capability_value text;
  next_action_value text;
  human_reason_value text;
  action_profile_value text;
  obligation_value jsonb;
BEGIN
  SELECT * INTO action_value
    FROM outcome_action_intent
   WHERE action_intent_id = p_action_intent_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'OUTCOME_ACTION_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;
  IF COALESCE(p_reason_code, '') = '' OR p_logical_time < 0
     OR (p_due_logical_time IS NOT NULL AND p_due_logical_time < p_logical_time)
     OR jsonb_typeof(p_detail) <> 'object' THEN
    RAISE EXCEPTION 'OUTCOME_EXECUTOR_OBLIGATION_INVALID' USING ERRCODE = '22023';
  END IF;

  human_reason_value := NULL;
  CASE p_reason_code
    WHEN 'GOAL_DECISION_REQUIRED' THEN
      kind_value := 'REQUEST_GOAL_DECISION'; owner_value := 'OWNER';
      capability_value := 'owner.goal-decision'; next_action_value := 'DECIDE_GOAL_DISPOSITION';
      human_reason_value := 'GOAL_DECISION';
    WHEN 'RISK_ACCEPTANCE_REQUIRED' THEN
      kind_value := 'REQUEST_RISK_ACCEPTANCE'; owner_value := 'OWNER';
      capability_value := 'owner.risk-acceptance'; next_action_value := 'DECIDE_RISK_ACCEPTANCE';
      human_reason_value := 'RISK_ACCEPTANCE';
    WHEN 'AUTHORITY_UNAVAILABLE' THEN
      kind_value := 'REQUEST_NEW_AUTHORIZATION'; owner_value := 'OWNER';
      capability_value := 'owner.authorization'; next_action_value := 'PROVIDE_BOUND_AUTHORIZATION';
      human_reason_value := 'NEW_AUTHORIZATION';
    WHEN 'AUTHORITY_REVOKED' THEN
      kind_value := 'REQUEST_NEW_AUTHORIZATION'; owner_value := 'OWNER';
      capability_value := 'owner.authorization'; next_action_value := 'PROVIDE_BOUND_AUTHORIZATION';
      human_reason_value := 'NEW_AUTHORIZATION';
    WHEN 'AUTHORITY_SCOPE_MISMATCH' THEN
      kind_value := 'REQUEST_NEW_AUTHORIZATION'; owner_value := 'OWNER';
      capability_value := 'owner.authorization'; next_action_value := 'PROVIDE_BOUND_AUTHORIZATION';
      human_reason_value := 'NEW_AUTHORIZATION';
    WHEN 'EXTERNAL_IDENTITY_REQUIRED' THEN
      kind_value := 'REQUEST_EXTERNAL_IDENTITY'; owner_value := 'OWNER';
      capability_value := 'owner.external-identity'; next_action_value := 'SELECT_EXTERNAL_IDENTITY';
      human_reason_value := 'EXTERNAL_IDENTITY';
    WHEN 'QUOTA_WAIT' THEN
      kind_value := 'MONITOR_EXTERNAL_WAIT'; owner_value := 'SYSTEM';
      capability_value := 'external-wait.monitor'; next_action_value := 'MONITOR_QUOTA';
    WHEN 'BINDING_CHANGED' THEN
      kind_value := 'REFRESH_STALE_BINDING'; owner_value := 'SYSTEM';
      capability_value := 'binding.refresh'; next_action_value := 'REEVALUATE_AND_REBIND';
    WHEN 'POLICY_CHANGED' THEN
      kind_value := 'REFRESH_STALE_BINDING'; owner_value := 'SYSTEM';
      capability_value := 'binding.refresh'; next_action_value := 'REEVALUATE_AND_REBIND';
    WHEN 'TARGET_CHANGED' THEN
      kind_value := 'REFRESH_STALE_BINDING'; owner_value := 'SYSTEM';
      capability_value := 'binding.refresh'; next_action_value := 'REEVALUATE_AND_REBIND';
    WHEN 'PRECONDITION_CHANGED' THEN
      kind_value := 'REFRESH_STALE_BINDING'; owner_value := 'SYSTEM';
      capability_value := 'binding.refresh'; next_action_value := 'REEVALUATE_AND_REBIND';
    WHEN 'WATERMARK_STALE' THEN
      kind_value := 'REFRESH_STALE_BINDING'; owner_value := 'SYSTEM';
      capability_value := 'binding.refresh'; next_action_value := 'REEVALUATE_AND_REBIND';
    WHEN 'OBLIGATION_STALE' THEN
      kind_value := 'REFRESH_STALE_BINDING'; owner_value := 'SYSTEM';
      capability_value := 'binding.refresh'; next_action_value := 'REEVALUATE_AND_REBIND';
    WHEN 'PARTIAL_EFFECT' THEN
      kind_value := 'REMEDIATE_SIDE_EFFECT'; owner_value := 'AGENT';
      capability_value := 'effect.remediate'; next_action_value := 'RECONCILE_OR_REVERSE_RECORDED_EFFECT';
    WHEN 'WRONG_EFFECT' THEN
      kind_value := 'REMEDIATE_SIDE_EFFECT'; owner_value := 'AGENT';
      capability_value := 'effect.remediate'; next_action_value := 'RECONCILE_OR_REVERSE_RECORDED_EFFECT';
    WHEN 'EFFECT_STATUS_UNKNOWN' THEN
      kind_value := 'REMEDIATE_SIDE_EFFECT'; owner_value := 'AGENT';
      capability_value := 'effect.remediate'; next_action_value := 'RECONCILE_OR_REVERSE_RECORDED_EFFECT';
    WHEN 'COMPENSATION_FAILED' THEN
      kind_value := 'REMEDIATE_SIDE_EFFECT'; owner_value := 'AGENT';
      capability_value := 'effect.remediate'; next_action_value := 'RECONCILE_OR_REVERSE_RECORDED_EFFECT';
    WHEN 'COMPENSATOR_UNAVAILABLE' THEN
      kind_value := 'REMEDIATE_SIDE_EFFECT'; owner_value := 'AGENT';
      capability_value := 'effect.remediate'; next_action_value := 'RECONCILE_OR_REVERSE_RECORDED_EFFECT';
    WHEN 'ACTION_TIMEOUT' THEN
      kind_value := 'RECOVER_RECONCILER'; owner_value := 'SYSTEM';
      capability_value := 'reconciler.recover'; next_action_value := 'RECOVER_TIMED_OUT_ACTION';
    WHEN 'BUDGET_EXHAUSTED' THEN
      kind_value := action_value.source_obligation->>'kind';
      owner_value := 'AGENT';
      capability_value := 'budget.reconcile';
      next_action_value := 'REDUCE_COST_OR_OBTAIN_A_NEW_BOUND_BUDGET';
    WHEN 'BACKOFF_ACTIVE' THEN
      kind_value := action_value.source_obligation->>'kind';
      owner_value := 'SYSTEM';
      capability_value := 'action.scheduler';
      next_action_value := 'RESUME_WHEN_DUE';
    WHEN 'FAIR_SCHEDULER_WAIT' THEN
      kind_value := action_value.source_obligation->>'kind';
      owner_value := 'SYSTEM';
      capability_value := 'action.scheduler';
      next_action_value := 'RESUME_WHEN_DUE';
    ELSE
      kind_value := 'DIAGNOSE_MODEL_GAP'; owner_value := 'AGENT';
      capability_value := 'model-gap.diagnose'; next_action_value := 'DIAGNOSE_ACTION_MODEL_GAP';
  END CASE;
  IF kind_value IS NULL OR owner_value NOT IN ('SYSTEM', 'AGENT', 'OWNER', 'EXTERNAL')
     OR capability_value IS NULL THEN
    kind_value := 'DIAGNOSE_MODEL_GAP'; owner_value := 'AGENT';
    capability_value := 'model-gap.diagnose'; next_action_value := 'DIAGNOSE_ACTION_MODEL_GAP';
    human_reason_value := NULL;
  END IF;
  action_profile_value := CASE owner_value
    WHEN 'OWNER' THEN 'OWNER_DECISION'
    WHEN 'AGENT' THEN 'AGENT_ACTION'
    WHEN 'EXTERNAL' THEN 'EXTERNAL_MONITOR'
    ELSE 'SYSTEM_ACTION'
  END;
  obligation_id_value := outcome_sha256_json(jsonb_build_object(
    'namespace', 'orbit.action-executor-obligation.v2',
    'tenantId', action_value.tenant_id::text,
    'projectId', action_value.project_id::text,
    'sourceObligationId', action_value.obligation_id::text,
    'actionIntentId', action_value.action_intent_id::text,
    'kind', kind_value
  ));
  revision_value := outcome_sha256_json(jsonb_build_object(
    'namespace', 'orbit.action-executor-obligation-revision.v2',
    'obligationId', obligation_id_value,
    'sourceObligationRevision', action_value.obligation_revision::text,
    'bindingDigest', action_value.binding_digest::text,
    'protocolDigest', action_value.protocol_digest::text,
    'targetDigest', action_value.target_digest::text,
    'authorityGrantDigest', action_value.authority_grant_digest::text,
    'policyDigest', action_value.policy_digest::text,
    'preconditionDigest', action_value.precondition_digest::text,
    'reasonCode', p_reason_code,
    'owner', owner_value,
    'capability', capability_value,
    'dueLogicalTime', CASE WHEN p_due_logical_time IS NULL THEN NULL
      ELSE to_jsonb(p_due_logical_time::text) END
  ));
  obligation_value := jsonb_build_object(
    'obligationId', obligation_id_value,
    'obligationRevision', revision_value,
    'kind', kind_value,
    'state', 'ACTIVE',
    'mandatory', true,
    'owner', owner_value,
    'capability', capability_value,
    'binding', action_value.source_obligation->'binding',
    'bindingDigest', action_value.binding_digest::text,
    'goalId', action_value.source_obligation->>'goalId',
    'goalRevision', action_value.source_obligation->>'goalRevision',
    'reason', jsonb_build_object(
      'code', p_reason_code,
      'message', p_reason_code || ' prevents ' || action_value.action_kind || ' on '
        || action_value.resource_type || ':' || action_value.resource_id || '.',
      'evidenceFactIds', '[]'::jsonb,
      'attemptedActions', CASE WHEN action_value.attempt_count > 0
        THEN jsonb_build_array(action_value.action_kind) ELSE '[]'::jsonb END,
      'nextAction', next_action_value,
      'sourceActionIntentId', action_value.action_intent_id::text,
      'humanDecisionReason', human_reason_value,
      'recovery', jsonb_build_object(
        'compensatorCapability', action_value.compensator_capability,
        'manualRecovery', action_value.manual_recovery,
        'remediationObligationKind', action_value.remediation_obligation_kind
      )
    ),
    'actionProtocolProfile', action_profile_value,
    'servesCriterionIds', COALESCE(action_value.source_obligation->'servesCriterionIds', '[]'::jsonb),
    'blocksClosureOf', COALESCE(action_value.source_obligation->'blocksClosureOf', '[]'::jsonb),
    'ownership', action_value.source_obligation->'ownership',
    'resolverProfile', 'STANDARD_MANDATORY',
    'createdAtLogicalTime', p_logical_time::text,
    'dueLogicalTime', CASE WHEN p_due_logical_time IS NULL THEN NULL
      ELSE to_jsonb(p_due_logical_time::text) END
  );

  SELECT * INTO old_active
    FROM outcome_executor_active_obligation
   WHERE tenant_id = action_value.tenant_id AND project_id = action_value.project_id
     AND action_intent_id = action_value.action_intent_id
   FOR UPDATE;
  IF FOUND AND old_active.obligation_revision::text = revision_value THEN
    RETURN old_active.obligation;
  END IF;
  IF FOUND THEN
    INSERT INTO outcome_executor_obligation_event (
      tenant_id, project_id, action_intent_id, obligation_id, obligation_revision,
      from_state, to_state, reason_code, logical_time, detail
    ) VALUES (
      old_active.tenant_id, old_active.project_id, old_active.action_intent_id,
      old_active.obligation_id, old_active.obligation_revision, 'ACTIVE', 'SUPERSEDED',
      p_reason_code, p_logical_time, p_detail
    );
    DELETE FROM outcome_executor_active_obligation
     WHERE tenant_id = old_active.tenant_id AND project_id = old_active.project_id
       AND action_intent_id = old_active.action_intent_id;
  END IF;
  INSERT INTO outcome_executor_obligation_revision (
    tenant_id, project_id, action_intent_id, obligation_id, obligation_revision,
    binding_digest, kind, owner, human_decision_reason, due_logical_time,
    obligation, obligation_digest
  ) VALUES (
    action_value.tenant_id, action_value.project_id, action_value.action_intent_id,
    obligation_id_value, revision_value, action_value.binding_digest, kind_value,
    owner_value, human_reason_value, p_due_logical_time, obligation_value,
    outcome_sha256_json(obligation_value)
  ) ON CONFLICT DO NOTHING;
  INSERT INTO outcome_executor_obligation_event (
    tenant_id, project_id, action_intent_id, obligation_id, obligation_revision,
    from_state, to_state, reason_code, logical_time, detail
  ) VALUES (
    action_value.tenant_id, action_value.project_id, action_value.action_intent_id,
    obligation_id_value, revision_value, NULL, 'ACTIVE', p_reason_code, p_logical_time, p_detail
  );
  INSERT INTO outcome_executor_active_obligation (
    tenant_id, project_id, action_intent_id, obligation_id, obligation_revision,
    binding_digest, kind, owner, human_decision_reason, due_logical_time, obligation
  ) VALUES (
    action_value.tenant_id, action_value.project_id, action_value.action_intent_id,
    obligation_id_value, revision_value, action_value.binding_digest, kind_value,
    owner_value, human_reason_value, p_due_logical_time, obligation_value
  );
  RETURN obligation_value;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION outcome_resolve_executor_obligation(
  p_action_intent_id uuid,
  p_logical_time bigint,
  p_reason_code text
) RETURNS boolean AS $$
DECLARE
  old_active outcome_executor_active_obligation%ROWTYPE;
BEGIN
  SELECT * INTO old_active
    FROM outcome_executor_active_obligation
   WHERE action_intent_id = p_action_intent_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN false;
  END IF;
  INSERT INTO outcome_executor_obligation_event (
    tenant_id, project_id, action_intent_id, obligation_id, obligation_revision,
    from_state, to_state, reason_code, logical_time
  ) VALUES (
    old_active.tenant_id, old_active.project_id, old_active.action_intent_id,
    old_active.obligation_id, old_active.obligation_revision,
    'ACTIVE', 'RESOLVED', p_reason_code, p_logical_time
  );
  DELETE FROM outcome_executor_active_obligation
   WHERE tenant_id = old_active.tenant_id AND project_id = old_active.project_id
     AND action_intent_id = old_active.action_intent_id;
  RETURN true;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION outcome_enqueue_action(
  p_authenticated_tenant uuid,
  p_project_id uuid,
  p_intent jsonb,
  p_source_obligation jsonb,
  p_retry_backoff_logical_ticks bigint[],
  p_logical_now bigint,
  p_fair_wait_logical_ticks bigint DEFAULT 100
) RETURNS jsonb AS $$
DECLARE
  request_digest_value text;
  existing outcome_action_intent%ROWTYPE;
  stream_value outcome_fact_stream%ROWTYPE;
  binding_value outcome_fact_binding%ROWTYPE;
  revision_value outcome_obligation_revision%ROWTYPE;
  active_value outcome_active_obligation%ROWTYPE;
  grant_value outcome_fact_authority_grant%ROWTYPE;
  revocation_value outcome_fact_authority_revocation%ROWTYPE;
  precondition_value outcome_action_precondition%ROWTYPE;
  budget_value outcome_action_budget_account%ROWTYPE;
  refusal_code text;
  initial_status text;
  action_id_value uuid;
  budget_charge_value numeric;
  deadline_value bigint;
  reservation_made boolean := false;
  replayed boolean := false;
  obligation_value jsonb;
  active_found boolean := false;
  precondition_found boolean := false;
  grant_found boolean := false;
  revoked_found boolean := false;
BEGIN
  IF jsonb_typeof(p_intent) <> 'object' OR jsonb_typeof(p_source_obligation) <> 'object'
     OR p_logical_now < 0 OR p_fair_wait_logical_ticks <= 0
     OR cardinality(p_retry_backoff_logical_ticks) = 0
     OR NOT (0 < ALL(p_retry_backoff_logical_ticks)) THEN
    RAISE EXCEPTION 'OUTCOME_ACTION_ENQUEUE_SHAPE_INVALID' USING ERRCODE = '22023';
  END IF;
  IF (p_intent->>'tenantId')::uuid IS DISTINCT FROM p_authenticated_tenant
     OR (p_intent->>'projectId')::uuid IS DISTINCT FROM p_project_id THEN
    RAISE EXCEPTION 'OUTCOME_ACTION_SCOPE_MISMATCH' USING ERRCODE = '42501';
  END IF;
  action_id_value := (p_intent->>'actionIntentId')::uuid;
  request_digest_value := outcome_sha256_json(jsonb_build_object(
    'intent', p_intent,
    'sourceObligation', p_source_obligation,
    'retryBackoffLogicalTicks', to_jsonb(p_retry_backoff_logical_ticks)
  ));
  IF p_intent->>'schemaVersion' IS DISTINCT FROM '1'
     OR COALESCE(p_intent->>'actionKind', '') = ''
     OR p_intent->>'effectClass' NOT IN (
       'READ_ONLY', 'REVERSIBLE_INTERNAL', 'IRREVERSIBLE_INTERNAL',
       'EXTERNAL_REVERSIBLE', 'EXTERNAL_IRREVERSIBLE'
     )
     OR COALESCE(p_intent->>'resourceType', '') = ''
     OR COALESCE(p_intent->>'resourceId', '') = ''
     OR p_intent#>>'{principal,type}' NOT IN ('SYSTEM', 'AGENT', 'OWNER', 'RUNNER', 'PROVIDER')
     OR COALESCE(p_intent#>>'{principal,id}', '') = ''
     OR COALESCE(p_intent->>'idempotencyKey', '') = ''
     OR COALESCE(p_intent#>>'{budget,accountId}', '') = ''
     OR COALESCE(p_intent#>>'{budget,unit}', '') = ''
     OR COALESCE(p_intent#>>'{budget,reservationId}', '') = ''
     OR COALESCE(p_intent#>>'{compensation,remediationObligationKind}', '') <> 'REMEDIATE_SIDE_EFFECT'
     OR (NULLIF(p_intent#>>'{compensation,compensatorCapability}', '') IS NULL
       AND NULLIF(p_intent#>>'{compensation,manualRecovery}', '') IS NULL)
     OR p_intent#>>'{receiptRequirements,providerIdentity}' IS DISTINCT FROM 'true'
     OR p_intent#>>'{receiptRequirements,effectDigest}' IS DISTINCT FROM 'true'
     OR p_intent#>>'{receiptRequirements,observedAt}' IS DISTINCT FROM 'true'
     OR p_intent#>>'{receiptRequirements,result}' IS DISTINCT FROM 'true'
     OR p_intent#>>'{receiptRequirements,idempotencyKey}' IS DISTINCT FROM 'true' THEN
    RAISE EXCEPTION 'OUTCOME_ACTION_CONTEXT_INVALID' USING ERRCODE = '22023';
  END IF;
  IF EXISTS (
    SELECT 1 FROM (VALUES
      (p_intent->>'obligationId'), (p_intent->>'obligationRevision'),
      (p_intent->>'bindingDigest'), (p_intent->>'protocolDigest'),
      (p_intent->>'targetDigest'),
      (p_intent->>'authorityGrantDigest'), (p_intent->>'policyDigest'),
      (p_intent->>'preconditionDigest'), (p_intent#>>'{retryPolicy,backoffDigest}')
    ) AS required(value)
    WHERE NOT COALESCE(outcome_valid_digest(required.value), false)
  ) THEN
    RAISE EXCEPTION 'OUTCOME_ACTION_DIGEST_INVALID' USING ERRCODE = '22023';
  END IF;
  IF p_intent->>'evaluatedThroughLogicalTime' !~ '^(0|[1-9][0-9]*)$'
     OR p_intent#>>'{retryPolicy,maxAttempts}' !~ '^[1-9][0-9]*$'
     OR p_intent#>>'{retryPolicy,sameFailureFingerprintLimit}' !~ '^[1-9][0-9]*$'
     OR p_intent#>>'{timeout,logicalTicks}' !~ '^[1-9][0-9]*$'
     OR p_intent#>>'{timeout,wallClockMs}' !~ '^[1-9][0-9]*$'
     OR (p_intent#>>'{retryPolicy,sameFailureFingerprintLimit}')::integer
       > (p_intent#>>'{retryPolicy,maxAttempts}')::integer
     OR p_intent#>>'{retryPolicy,backoffDigest}' IS DISTINCT FROM
       outcome_sha256_json(to_jsonb(p_retry_backoff_logical_ticks)) THEN
    RAISE EXCEPTION 'OUTCOME_ACTION_RETRY_TIMEOUT_INVALID' USING ERRCODE = '22023';
  END IF;
  budget_charge_value := (p_intent#>>'{budget,charge}')::numeric;
  IF budget_charge_value < 0 OR (p_intent#>>'{budget,limit}')::numeric < budget_charge_value THEN
    RAISE EXCEPTION 'OUTCOME_ACTION_BUDGET_ENVELOPE_INVALID' USING ERRCODE = '22023';
  END IF;
  deadline_value := p_logical_now + (p_intent#>>'{timeout,logicalTicks}')::bigint;

  PERFORM 1 FROM outcome_fact_stream
   WHERE tenant_id = p_authenticated_tenant AND project_id = p_project_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'OUTCOME_ACTION_STREAM_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;
  -- The stream row serializes first insert and replay. Without this recheck, two concurrent uses
  -- of one idempotency key can both observe absence and make the loser surface a unique violation
  -- instead of the standing result.
  SELECT * INTO existing
    FROM outcome_action_intent
   WHERE tenant_id = p_authenticated_tenant AND project_id = p_project_id
     AND idempotency_key = p_intent->>'idempotencyKey';
  IF FOUND THEN
    IF existing.request_digest::text IS DISTINCT FROM request_digest_value
       OR existing.action_intent_id IS DISTINCT FROM action_id_value THEN
      RAISE EXCEPTION 'OUTCOME_ACTION_IDEMPOTENCY_CONFLICT' USING ERRCODE = '23505';
    END IF;
    RETURN jsonb_build_object(
      'actionIntentId', existing.action_intent_id::text,
      'status', existing.status,
      'effectState', existing.effect_state,
      'attemptCount', existing.attempt_count,
      'nextEligibleLogicalTime', existing.next_eligible_logical_time::text,
      'deadlineLogicalTime', existing.deadline_logical_time::text,
      'replayed', true,
      'obligation', (SELECT obligation FROM outcome_executor_active_obligation
        WHERE action_intent_id = existing.action_intent_id)
    );
  END IF;
  SELECT * INTO stream_value FROM outcome_fact_stream
   WHERE tenant_id = p_authenticated_tenant AND project_id = p_project_id;
  SELECT * INTO binding_value
    FROM outcome_fact_binding
   WHERE tenant_id = p_authenticated_tenant AND project_id = p_project_id
   ORDER BY binding_epoch DESC LIMIT 1;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'OUTCOME_ACTION_BINDING_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;
  SELECT * INTO revision_value
    FROM outcome_obligation_revision
   WHERE tenant_id = p_authenticated_tenant AND project_id = p_project_id
     AND obligation_revision = p_intent->>'obligationRevision';
  IF NOT FOUND OR revision_value.obligation_id::text IS DISTINCT FROM p_intent->>'obligationId'
     OR revision_value.obligation IS DISTINCT FROM p_source_obligation THEN
    RAISE EXCEPTION 'OUTCOME_ACTION_SOURCE_OBLIGATION_INVALID' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO active_value
    FROM outcome_active_obligation
   WHERE tenant_id = p_authenticated_tenant AND project_id = p_project_id
     AND obligation_id = p_intent->>'obligationId';
  active_found := FOUND;

  SELECT * INTO budget_value
    FROM outcome_action_budget_account
   WHERE tenant_id = p_authenticated_tenant AND project_id = p_project_id
     AND account_id = p_intent#>>'{budget,accountId}'
     AND budget_digest = binding_value.binding->>'budgetDigest'
     AND unit = p_intent#>>'{budget,unit}'
   FOR UPDATE;
  IF NOT FOUND OR budget_value.limit_amount IS DISTINCT FROM (p_intent#>>'{budget,limit}')::numeric THEN
    RAISE EXCEPTION 'OUTCOME_ACTION_BOUND_BUDGET_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;

  refusal_code := NULL;
  IF binding_value.binding_digest::text IS DISTINCT FROM p_intent->>'bindingDigest' THEN
    refusal_code := 'BINDING_CHANGED';
  ELSIF NOT active_found OR active_value.obligation_revision::text IS DISTINCT FROM p_intent->>'obligationRevision' THEN
    refusal_code := 'OBLIGATION_STALE';
  ELSIF stream_value.last_logical_time IS DISTINCT FROM (p_intent->>'evaluatedThroughLogicalTime')::bigint
     OR stream_value.last_logical_time IS DISTINCT FROM p_logical_now THEN
    refusal_code := 'WATERMARK_STALE';
  ELSIF binding_value.binding->>'targetDigest' IS DISTINCT FROM p_intent->>'targetDigest' THEN
    refusal_code := 'TARGET_CHANGED';
  ELSIF binding_value.binding->>'policyDigest' IS DISTINCT FROM p_intent->>'policyDigest' THEN
    refusal_code := 'POLICY_CHANGED';
  ELSIF binding_value.binding->>'authorityGrantDigest' IS DISTINCT FROM p_intent->>'authorityGrantDigest' THEN
    refusal_code := 'AUTHORITY_UNAVAILABLE';
  END IF;
  SELECT * INTO precondition_value
    FROM outcome_action_precondition
   WHERE tenant_id = p_authenticated_tenant AND project_id = p_project_id
     AND resource_type = p_intent->>'resourceType' AND resource_id = p_intent->>'resourceId';
  precondition_found := FOUND;
  IF refusal_code IS NULL AND (
    NOT precondition_found OR precondition_value.precondition_digest::text IS DISTINCT FROM p_intent->>'preconditionDigest'
    OR precondition_value.target_digest::text IS DISTINCT FROM p_intent->>'targetDigest'
  ) THEN
    refusal_code := 'PRECONDITION_CHANGED';
  END IF;
  SELECT * INTO grant_value
    FROM outcome_fact_authority_grant
   WHERE tenant_id = p_authenticated_tenant AND project_id = p_project_id
     AND grant_digest = p_intent->>'authorityGrantDigest';
  grant_found := FOUND;
  IF refusal_code IS NULL AND (
    NOT grant_found OR grant_value.principal_type IS DISTINCT FROM p_intent#>>'{principal,type}'
    OR grant_value.principal_id IS DISTINCT FROM p_intent#>>'{principal,id}'
  ) THEN
    refusal_code := 'AUTHORITY_UNAVAILABLE';
  END IF;
  IF refusal_code IS NULL AND (
    grant_value.fact_kind IS DISTINCT FROM 'ACTION_INTENT_RECORDED'
    OR grant_value.claim_type IS DISTINCT FROM 'INTENT'
    OR grant_value.source_system IS DISTINCT FROM 'ORBIT_CONTROL_PLANE'
  ) THEN
    refusal_code := 'AUTHORITY_SCOPE_MISMATCH';
  END IF;
  IF refusal_code IS NULL
     AND grant_value.risk_policy_digest IS DISTINCT FROM binding_value.risk_policy_digest THEN
    refusal_code := 'POLICY_CHANGED';
  END IF;
  IF grant_found THEN
    SELECT * INTO revocation_value
      FROM outcome_fact_authority_revocation
     WHERE tenant_id = p_authenticated_tenant AND project_id = p_project_id
       AND grant_id = grant_value.grant_id;
    revoked_found := FOUND;
    IF refusal_code IS NULL AND (
      revoked_found OR grant_value.valid_from_logical_time > p_logical_now
      OR (grant_value.valid_through_logical_time IS NOT NULL
        AND grant_value.valid_through_logical_time < p_logical_now)
    ) THEN
      refusal_code := 'AUTHORITY_REVOKED';
    END IF;
  END IF;

  IF refusal_code IS NOT NULL THEN
    initial_status := 'REFUSED';
  ELSIF budget_value.spent_amount + budget_value.reserved_amount + budget_charge_value
        > budget_value.limit_amount THEN
    initial_status := 'BLOCKED_BUDGET';
    refusal_code := 'BUDGET_EXHAUSTED';
  ELSE
    initial_status := 'QUEUED';
    UPDATE outcome_action_budget_account
       SET reserved_amount = reserved_amount + budget_charge_value,
           updated_at = clock_timestamp()
     WHERE tenant_id = budget_value.tenant_id AND project_id = budget_value.project_id
       AND account_id = budget_value.account_id AND budget_digest = budget_value.budget_digest
       AND unit = budget_value.unit;
    reservation_made := true;
  END IF;

  INSERT INTO outcome_action_intent (
    action_intent_id, tenant_id, project_id, obligation_id, obligation_revision,
    binding_digest, protocol_digest, action_kind, effect_class, resource_type, resource_id, target_digest,
    principal_type, principal_id, authority_grant_digest, policy_digest, precondition_digest,
    evaluated_through_logical_time, idempotency_key,
    budget_account_id, budget_digest, budget_unit, budget_charge, budget_limit,
    budget_reservation_id, retry_max_attempts, retry_same_fingerprint_limit,
    retry_backoff_digest, retry_backoff_logical_ticks, timeout_logical_ticks,
    timeout_wall_clock_ms, compensator_capability, manual_recovery,
    remediation_obligation_kind, status, next_eligible_logical_time,
    deadline_logical_time, source_obligation, intent, request_digest
  ) VALUES (
    action_id_value, p_authenticated_tenant, p_project_id,
    p_intent->>'obligationId', p_intent->>'obligationRevision', p_intent->>'bindingDigest',
    p_intent->>'protocolDigest',
    p_intent->>'actionKind', p_intent->>'effectClass', p_intent->>'resourceType',
    p_intent->>'resourceId', p_intent->>'targetDigest', p_intent#>>'{principal,type}',
    p_intent#>>'{principal,id}', p_intent->>'authorityGrantDigest', p_intent->>'policyDigest',
    p_intent->>'preconditionDigest', (p_intent->>'evaluatedThroughLogicalTime')::bigint,
    p_intent->>'idempotencyKey', p_intent#>>'{budget,accountId}',
    binding_value.binding->>'budgetDigest', p_intent#>>'{budget,unit}', budget_charge_value,
    (p_intent#>>'{budget,limit}')::numeric, p_intent#>>'{budget,reservationId}',
    (p_intent#>>'{retryPolicy,maxAttempts}')::integer,
    (p_intent#>>'{retryPolicy,sameFailureFingerprintLimit}')::integer,
    p_intent#>>'{retryPolicy,backoffDigest}', p_retry_backoff_logical_ticks,
    (p_intent#>>'{timeout,logicalTicks}')::bigint,
    (p_intent#>>'{timeout,wallClockMs}')::integer,
    NULLIF(p_intent#>>'{compensation,compensatorCapability}', ''),
    NULLIF(p_intent#>>'{compensation,manualRecovery}', ''),
    p_intent#>>'{compensation,remediationObligationKind}', initial_status,
    p_logical_now, deadline_value, p_source_obligation, p_intent, request_digest_value
  );
  PERFORM outcome_append_action_event(
    action_id_value, NULL, NULL, initial_status,
    COALESCE(refusal_code, 'ACTION_ENQUEUED'), p_logical_now,
    jsonb_build_object('reservationMade', reservation_made)
  );
  IF refusal_code IS NOT NULL THEN
    obligation_value := outcome_activate_executor_obligation(
      action_id_value, refusal_code, p_logical_now, NULL,
      jsonb_build_object('phase', 'ENQUEUE')
    );
  ELSE
    obligation_value := outcome_activate_executor_obligation(
      action_id_value, 'FAIR_SCHEDULER_WAIT', p_logical_now,
      p_logical_now + p_fair_wait_logical_ticks,
      jsonb_build_object('phase', 'QUEUE')
    );
  END IF;
  RETURN jsonb_build_object(
    'actionIntentId', action_id_value::text,
    'status', initial_status,
    'effectState', 'NONE',
    'attemptCount', 0,
    'nextEligibleLogicalTime', p_logical_now::text,
    'deadlineLogicalTime', deadline_value::text,
    'replayed', replayed,
    'obligation', obligation_value
  );
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION outcome_sweep_action_queue(
  p_authenticated_tenant uuid,
  p_logical_now bigint
) RETURNS jsonb AS $$
DECLARE
  action_value outcome_action_intent%ROWTYPE;
  budget_value outcome_action_budget_account%ROWTYPE;
  next_status text;
  next_due bigint;
  reason_code_value text;
  reserve_retry boolean;
  timed_out_count integer := 0;
  lease_requeued_count integer := 0;
BEGIN
  IF p_logical_now < 0 THEN
    RAISE EXCEPTION 'OUTCOME_ACTION_LOGICAL_TIME_INVALID' USING ERRCODE = '22023';
  END IF;
  FOR action_value IN
    SELECT * FROM outcome_action_intent
     WHERE tenant_id = p_authenticated_tenant
       AND status IN ('QUEUED', 'CLAIMED', 'BACKOFF', 'WAITING_QUOTA')
       AND (
         deadline_logical_time <= p_logical_now
         OR (status = 'CLAIMED' AND lease_expires_logical_time <= p_logical_now)
       )
     ORDER BY project_id, queue_sequence
     FOR UPDATE
  LOOP
    SELECT * INTO budget_value
      FROM outcome_action_budget_account
     WHERE tenant_id = action_value.tenant_id AND project_id = action_value.project_id
       AND account_id = action_value.budget_account_id
       AND budget_digest = action_value.budget_digest AND unit = action_value.budget_unit
     FOR UPDATE;
    IF NOT FOUND OR budget_value.reserved_amount < action_value.budget_charge THEN
      RAISE EXCEPTION 'OUTCOME_ACTION_BUDGET_RESERVATION_LOST' USING ERRCODE = '23514';
    END IF;
    IF action_value.deadline_logical_time <= p_logical_now THEN
      IF action_value.status = 'CLAIMED' THEN
        UPDATE outcome_action_budget_account
           SET spent_amount = spent_amount + action_value.budget_charge,
               reserved_amount = reserved_amount - action_value.budget_charge,
               updated_at = clock_timestamp()
         WHERE tenant_id = budget_value.tenant_id AND project_id = budget_value.project_id
           AND account_id = budget_value.account_id AND budget_digest = budget_value.budget_digest
           AND unit = budget_value.unit;
        IF action_value.effect_class = 'READ_ONLY' THEN
          next_status := 'TIMED_OUT';
          reason_code_value := 'ACTION_TIMEOUT';
        ELSE
          next_status := 'REMEDIATION_REQUIRED';
          reason_code_value := 'EFFECT_STATUS_UNKNOWN';
        END IF;
      ELSE
        UPDATE outcome_action_budget_account
           SET reserved_amount = reserved_amount - action_value.budget_charge,
               updated_at = clock_timestamp()
         WHERE tenant_id = budget_value.tenant_id AND project_id = budget_value.project_id
           AND account_id = budget_value.account_id AND budget_digest = budget_value.budget_digest
           AND unit = budget_value.unit;
        next_status := 'TIMED_OUT';
        reason_code_value := 'ACTION_TIMEOUT';
      END IF;
      UPDATE outcome_action_intent
         SET status = next_status,
             effect_state = CASE WHEN next_status = 'REMEDIATION_REQUIRED' THEN 'UNKNOWN'
               ELSE effect_state END,
             lease_token = NULL, lease_owner = NULL,
             lease_expires_logical_time = NULL, updated_at = clock_timestamp()
       WHERE action_intent_id = action_value.action_intent_id;
      PERFORM outcome_append_action_event(
        action_value.action_intent_id, action_value.attempt_count, action_value.status,
        next_status, reason_code_value, p_logical_now,
        jsonb_build_object('phase', 'QUEUE_SWEEP')
      );
      PERFORM outcome_activate_executor_obligation(
        action_value.action_intent_id, reason_code_value, p_logical_now, NULL,
        jsonb_build_object('phase', 'QUEUE_SWEEP')
      );
      timed_out_count := timed_out_count + 1;
    ELSE
      reserve_retry := false;
      next_due := NULL;
      IF action_value.attempt_count < action_value.retry_max_attempts
         AND budget_value.spent_amount + budget_value.reserved_amount + action_value.budget_charge
           <= budget_value.limit_amount THEN
        next_status := 'BACKOFF';
        reason_code_value := 'BACKOFF_ACTIVE';
        reserve_retry := true;
        next_due := p_logical_now + action_value.retry_backoff_logical_ticks[
          LEAST(action_value.attempt_count, cardinality(action_value.retry_backoff_logical_ticks))
        ];
      ELSIF action_value.effect_class <> 'READ_ONLY' THEN
        next_status := 'REMEDIATION_REQUIRED';
        reason_code_value := 'EFFECT_STATUS_UNKNOWN';
      ELSIF action_value.attempt_count >= action_value.retry_max_attempts THEN
        next_status := 'FAILED';
        reason_code_value := 'RETRY_BUDGET_EXHAUSTED';
      ELSE
        next_status := 'BLOCKED_BUDGET';
        reason_code_value := 'BUDGET_EXHAUSTED';
      END IF;
      UPDATE outcome_action_budget_account
         SET spent_amount = spent_amount + action_value.budget_charge,
             reserved_amount = reserved_amount - action_value.budget_charge
               + CASE WHEN reserve_retry THEN action_value.budget_charge ELSE 0 END,
             updated_at = clock_timestamp()
       WHERE tenant_id = action_value.tenant_id AND project_id = action_value.project_id
         AND account_id = action_value.budget_account_id
         AND budget_digest = action_value.budget_digest AND unit = action_value.budget_unit;
      UPDATE outcome_action_intent
         SET status = next_status,
             effect_state = CASE
               WHEN next_status = 'REMEDIATION_REQUIRED' THEN 'UNKNOWN'
               WHEN next_status = 'BACKOFF' AND effect_class <> 'READ_ONLY' THEN 'POSSIBLE'
               ELSE effect_state END,
             next_eligible_logical_time = COALESCE(next_due, next_eligible_logical_time),
             lease_token = NULL, lease_owner = NULL, lease_expires_logical_time = NULL,
             updated_at = clock_timestamp()
       WHERE action_intent_id = action_value.action_intent_id;
      PERFORM outcome_append_action_event(
        action_value.action_intent_id, action_value.attempt_count, 'CLAIMED', next_status,
        reason_code_value, p_logical_now,
        jsonb_build_object('previousLease', action_value.lease_token::text)
      );
      PERFORM outcome_activate_executor_obligation(
        action_value.action_intent_id, reason_code_value, p_logical_now, next_due,
        jsonb_build_object('phase', 'LEASE_RECOVERY')
      );
      lease_requeued_count := lease_requeued_count + 1;
    END IF;
  END LOOP;
  RETURN jsonb_build_object(
    'timedOut', timed_out_count,
    'leaseRequeued', lease_requeued_count
  );
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION outcome_claim_next_action(
  p_authenticated_tenant uuid,
  p_worker_id text,
  p_logical_now bigint,
  p_lease_logical_ticks bigint
) RETURNS jsonb AS $$
DECLARE
  scheduler_value outcome_action_scheduler%ROWTYPE;
  action_value outcome_action_intent%ROWTYPE;
  lease_value uuid;
  attempt_value uuid;
  next_dispatch_sequence bigint;
BEGIN
  IF COALESCE(p_worker_id, '') = '' OR p_logical_now < 0 OR p_lease_logical_ticks <= 0 THEN
    RAISE EXCEPTION 'OUTCOME_ACTION_CLAIM_INVALID' USING ERRCODE = '22023';
  END IF;
  PERFORM outcome_sweep_action_queue(p_authenticated_tenant, p_logical_now);
  INSERT INTO outcome_action_scheduler (tenant_id) VALUES (p_authenticated_tenant)
  ON CONFLICT DO NOTHING;
  SELECT * INTO scheduler_value
    FROM outcome_action_scheduler
   WHERE tenant_id = p_authenticated_tenant
   FOR UPDATE;

  SELECT candidate.* INTO action_value
    FROM (
      SELECT DISTINCT ON (project_id) i.*
        FROM outcome_action_intent i
       WHERE i.tenant_id = p_authenticated_tenant
         AND i.status IN ('QUEUED', 'BACKOFF', 'WAITING_QUOTA')
         AND i.next_eligible_logical_time <= p_logical_now
         AND i.deadline_logical_time > p_logical_now
       ORDER BY project_id, queue_sequence, action_intent_id
    ) candidate
    LEFT JOIN outcome_action_project_fairness fairness
      ON fairness.tenant_id = candidate.tenant_id AND fairness.project_id = candidate.project_id
   ORDER BY fairness.last_dispatched_sequence ASC NULLS FIRST,
            candidate.project_id, candidate.queue_sequence, candidate.action_intent_id
   LIMIT 1;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  SELECT * INTO action_value
    FROM outcome_action_intent
   WHERE action_intent_id = action_value.action_intent_id
   FOR UPDATE;
  IF action_value.status NOT IN ('QUEUED', 'BACKOFF', 'WAITING_QUOTA')
     OR action_value.next_eligible_logical_time > p_logical_now
     OR action_value.deadline_logical_time <= p_logical_now THEN
    RETURN NULL;
  END IF;

  next_dispatch_sequence := scheduler_value.dispatch_sequence + 1;
  UPDATE outcome_action_scheduler
     SET dispatch_sequence = next_dispatch_sequence
   WHERE tenant_id = p_authenticated_tenant;
  INSERT INTO outcome_action_project_fairness (
    tenant_id, project_id, last_dispatched_sequence, dispatch_count
  ) VALUES (
    p_authenticated_tenant, action_value.project_id, next_dispatch_sequence, 1
  ) ON CONFLICT (tenant_id, project_id) DO UPDATE SET
    last_dispatched_sequence = EXCLUDED.last_dispatched_sequence,
    dispatch_count = outcome_action_project_fairness.dispatch_count + 1,
    updated_at = clock_timestamp();

  lease_value := gen_random_uuid();
  attempt_value := gen_random_uuid();
  UPDATE outcome_action_intent
     SET status = 'CLAIMED', attempt_count = attempt_count + 1,
         lease_token = lease_value, lease_owner = p_worker_id,
         lease_expires_logical_time = p_logical_now + p_lease_logical_ticks,
         updated_at = clock_timestamp()
   WHERE action_intent_id = action_value.action_intent_id
   RETURNING * INTO action_value;
  INSERT INTO outcome_action_attempt (
    attempt_id, tenant_id, project_id, action_intent_id, attempt_number,
    worker_id, lease_token, claimed_logical_time, lease_expires_logical_time
  ) VALUES (
    attempt_value, action_value.tenant_id, action_value.project_id,
    action_value.action_intent_id, action_value.attempt_count, p_worker_id,
    lease_value, p_logical_now, p_logical_now + p_lease_logical_ticks
  );
  PERFORM outcome_append_action_event(
    action_value.action_intent_id, action_value.attempt_count, NULL, 'CLAIMED',
    'FAIR_SCHEDULER_CLAIM', p_logical_now,
    jsonb_build_object('dispatchSequence', next_dispatch_sequence::text, 'workerId', p_worker_id)
  );
  PERFORM outcome_resolve_executor_obligation(
    action_value.action_intent_id, p_logical_now, 'ACTION_CLAIMED'
  );
  RETURN jsonb_build_object(
    'actionIntentId', action_value.action_intent_id::text,
    'attemptNumber', action_value.attempt_count,
    'leaseToken', lease_value::text,
    'leaseExpiresLogicalTime', (p_logical_now + p_lease_logical_ticks)::text,
    'dispatchSequence', next_dispatch_sequence::text,
    'intent', action_value.intent,
    'sourceObligation', action_value.source_obligation
  );
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION outcome_begin_action_commit(
  p_authenticated_tenant uuid,
  p_action_intent_id uuid,
  p_lease_token uuid,
  p_worker_id text,
  p_logical_now bigint
) RETURNS jsonb AS $$
DECLARE
  initial_action outcome_action_intent%ROWTYPE;
  action_value outcome_action_intent%ROWTYPE;
  stream_value outcome_fact_stream%ROWTYPE;
  binding_value outcome_fact_binding%ROWTYPE;
  active_value outcome_active_obligation%ROWTYPE;
  grant_value outcome_fact_authority_grant%ROWTYPE;
  revocation_value outcome_fact_authority_revocation%ROWTYPE;
  precondition_value outcome_action_precondition%ROWTYPE;
  budget_value outcome_action_budget_account%ROWTYPE;
  receipt_value outcome_action_receipt%ROWTYPE;
  refusal_code text;
  active_found boolean := false;
  grant_found boolean := false;
  revoked_found boolean := false;
  precondition_found boolean := false;
BEGIN
  IF COALESCE(p_worker_id, '') = '' OR p_logical_now < 0 THEN
    RAISE EXCEPTION 'OUTCOME_ACTION_BEGIN_INVALID' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO initial_action
    FROM outcome_action_intent
   WHERE action_intent_id = p_action_intent_id
     AND tenant_id = p_authenticated_tenant;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'OUTCOME_ACTION_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;
  SELECT * INTO receipt_value
    FROM outcome_action_receipt
   WHERE action_intent_id = p_action_intent_id
   ORDER BY attempt_number DESC LIMIT 1;
  IF FOUND AND initial_action.status IN ('SUCCEEDED', 'COMPENSATED', 'FAILED', 'REMEDIATION_REQUIRED', 'TIMED_OUT') THEN
    RETURN jsonb_build_object(
      'authorized', false,
      'replayed', true,
      'code', 'TERMINAL_RECEIPT_REPLAY',
      'status', initial_action.status,
      'receipt', receipt_value.receipt
    );
  END IF;

  -- This is the same serialization row used by authority revocation, binding replacement,
  -- precondition replacement and evaluator publication. The caller must keep this transaction
  -- open through provider invocation and FINISH; the deferred guard forbids any other use.
  PERFORM 1 FROM outcome_fact_stream
   WHERE tenant_id = initial_action.tenant_id AND project_id = initial_action.project_id
   FOR UPDATE;
  SELECT * INTO stream_value FROM outcome_fact_stream
   WHERE tenant_id = initial_action.tenant_id AND project_id = initial_action.project_id;
  SELECT * INTO action_value
    FROM outcome_action_intent
   WHERE action_intent_id = p_action_intent_id
   FOR UPDATE;
  IF action_value.status <> 'CLAIMED' OR action_value.lease_token IS DISTINCT FROM p_lease_token
     OR action_value.lease_owner IS DISTINCT FROM p_worker_id
     OR action_value.lease_expires_logical_time < p_logical_now THEN
    RAISE EXCEPTION 'OUTCOME_ACTION_LEASE_STALE' USING ERRCODE = '40001';
  END IF;

  SELECT * INTO binding_value
    FROM outcome_fact_binding
   WHERE tenant_id = action_value.tenant_id AND project_id = action_value.project_id
   ORDER BY binding_epoch DESC LIMIT 1;
  SELECT * INTO active_value
    FROM outcome_active_obligation
   WHERE tenant_id = action_value.tenant_id AND project_id = action_value.project_id
     AND obligation_id = action_value.obligation_id;
  active_found := FOUND;
  SELECT * INTO precondition_value
    FROM outcome_action_precondition
   WHERE tenant_id = action_value.tenant_id AND project_id = action_value.project_id
     AND resource_type = action_value.resource_type AND resource_id = action_value.resource_id;
  precondition_found := FOUND;
  SELECT * INTO grant_value
    FROM outcome_fact_authority_grant
   WHERE tenant_id = action_value.tenant_id AND project_id = action_value.project_id
     AND grant_digest = action_value.authority_grant_digest;
  grant_found := FOUND;
  IF grant_found THEN
    SELECT * INTO revocation_value
      FROM outcome_fact_authority_revocation
     WHERE tenant_id = action_value.tenant_id AND project_id = action_value.project_id
       AND grant_id = grant_value.grant_id;
    revoked_found := FOUND;
  END IF;
  SELECT * INTO budget_value
    FROM outcome_action_budget_account
   WHERE tenant_id = action_value.tenant_id AND project_id = action_value.project_id
     AND account_id = action_value.budget_account_id
     AND budget_digest = action_value.budget_digest AND unit = action_value.budget_unit
   FOR UPDATE;

  refusal_code := NULL;
  IF action_value.deadline_logical_time <= p_logical_now THEN
    refusal_code := 'ACTION_TIMEOUT';
  ELSIF binding_value.binding_digest IS DISTINCT FROM action_value.binding_digest THEN
    refusal_code := 'BINDING_CHANGED';
  ELSIF NOT active_found OR active_value.obligation_revision IS DISTINCT FROM action_value.obligation_revision THEN
    refusal_code := 'OBLIGATION_STALE';
  ELSIF binding_value.binding->>'targetDigest' IS DISTINCT FROM action_value.target_digest::text THEN
    refusal_code := 'TARGET_CHANGED';
  ELSIF binding_value.binding->>'policyDigest' IS DISTINCT FROM action_value.policy_digest::text THEN
    refusal_code := 'POLICY_CHANGED';
  ELSIF NOT precondition_found
     OR precondition_value.precondition_digest IS DISTINCT FROM action_value.precondition_digest
     OR precondition_value.target_digest IS DISTINCT FROM action_value.target_digest THEN
    refusal_code := 'PRECONDITION_CHANGED';
  ELSIF NOT grant_found
     OR grant_value.principal_type IS DISTINCT FROM action_value.principal_type
     OR grant_value.principal_id IS DISTINCT FROM action_value.principal_id THEN
    refusal_code := 'AUTHORITY_UNAVAILABLE';
  ELSIF grant_value.fact_kind IS DISTINCT FROM 'ACTION_INTENT_RECORDED'
     OR grant_value.claim_type IS DISTINCT FROM 'INTENT'
     OR grant_value.source_system IS DISTINCT FROM 'ORBIT_CONTROL_PLANE' THEN
    refusal_code := 'AUTHORITY_SCOPE_MISMATCH';
  ELSIF grant_value.risk_policy_digest IS DISTINCT FROM binding_value.risk_policy_digest THEN
    refusal_code := 'POLICY_CHANGED';
  ELSIF revoked_found OR grant_value.valid_from_logical_time > stream_value.last_logical_time
     OR (grant_value.valid_through_logical_time IS NOT NULL
       AND grant_value.valid_through_logical_time < stream_value.last_logical_time) THEN
    refusal_code := 'AUTHORITY_REVOKED';
  ELSIF stream_value.last_logical_time IS DISTINCT FROM action_value.evaluated_through_logical_time THEN
    refusal_code := 'WATERMARK_STALE';
  ELSIF budget_value.reserved_amount < action_value.budget_charge THEN
    refusal_code := 'BUDGET_EXHAUSTED';
  END IF;

  IF refusal_code IS NOT NULL THEN
    UPDATE outcome_action_budget_account
       SET reserved_amount = GREATEST(0, reserved_amount - action_value.budget_charge),
           updated_at = clock_timestamp()
     WHERE tenant_id = action_value.tenant_id AND project_id = action_value.project_id
       AND account_id = action_value.budget_account_id
       AND budget_digest = action_value.budget_digest AND unit = action_value.budget_unit;
    UPDATE outcome_action_intent
       SET status = CASE WHEN refusal_code = 'ACTION_TIMEOUT' THEN 'TIMED_OUT' ELSE 'REFUSED' END,
           lease_token = NULL, lease_owner = NULL, lease_expires_logical_time = NULL,
           updated_at = clock_timestamp()
     WHERE action_intent_id = action_value.action_intent_id;
    PERFORM outcome_append_action_event(
      action_value.action_intent_id, action_value.attempt_count, 'CLAIMED',
      CASE WHEN refusal_code = 'ACTION_TIMEOUT' THEN 'TIMED_OUT' ELSE 'REFUSED' END,
      refusal_code, p_logical_now, jsonb_build_object('phase', 'COMMIT_RECHECK')
    );
    PERFORM outcome_activate_executor_obligation(
      action_value.action_intent_id, refusal_code, p_logical_now, NULL,
      jsonb_build_object('phase', 'COMMIT_RECHECK')
    );
    RETURN jsonb_build_object(
      'authorized', false, 'replayed', false, 'code', refusal_code,
      'status', CASE WHEN refusal_code = 'ACTION_TIMEOUT' THEN 'TIMED_OUT' ELSE 'REFUSED' END
    );
  END IF;

  UPDATE outcome_action_intent
     SET status = 'COMMITTING', commit_txid = txid_current(),
         effect_state = CASE WHEN effect_class = 'READ_ONLY' THEN 'NONE' ELSE 'POSSIBLE' END,
         updated_at = clock_timestamp()
   WHERE action_intent_id = action_value.action_intent_id;
  PERFORM outcome_append_action_event(
    action_value.action_intent_id, action_value.attempt_count, 'CLAIMED', 'COMMITTING',
    'COMMIT_FENCE_ACQUIRED', p_logical_now,
    jsonb_build_object(
      'bindingDigest', action_value.binding_digest::text,
      'authorityGrantDigest', action_value.authority_grant_digest::text,
      'policyDigest', action_value.policy_digest::text,
      'preconditionDigest', action_value.precondition_digest::text,
      'targetDigest', action_value.target_digest::text,
      'transactionId', txid_current()::text
    )
  );
  RETURN jsonb_build_object(
    'authorized', true,
    'replayed', false,
    'code', 'COMMIT_FENCE_ACQUIRED',
    'transactionId', txid_current()::text,
    'attemptNumber', action_value.attempt_count,
    'intent', action_value.intent,
    'sourceObligation', action_value.source_obligation
  );
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION outcome_finish_action_commit(
  p_authenticated_tenant uuid,
  p_action_intent_id uuid,
  p_lease_token uuid,
  p_receipt jsonb,
  p_compensation jsonb,
  p_logical_now bigint
) RETURNS jsonb AS $$
DECLARE
  action_value outcome_action_intent%ROWTYPE;
  budget_value outcome_action_budget_account%ROWTYPE;
  existing_receipt outcome_action_receipt%ROWTYPE;
  receipt_digest_value text;
  result_value text;
  failure_fingerprint_value text;
  fingerprint_count integer := 0;
  retry_due bigint;
  next_status text;
  reason_code_value text;
  reserve_retry boolean := false;
  consume_charge boolean := false;
  compensation_result text;
  obligation_value jsonb;
BEGIN
  IF p_logical_now < 0 OR jsonb_typeof(p_receipt) <> 'object'
     OR (p_compensation IS NOT NULL AND jsonb_typeof(p_compensation) <> 'object') THEN
    RAISE EXCEPTION 'OUTCOME_ACTION_FINISH_INVALID' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO action_value
    FROM outcome_action_intent
   WHERE action_intent_id = p_action_intent_id AND tenant_id = p_authenticated_tenant
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'OUTCOME_ACTION_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;
  IF action_value.status <> 'COMMITTING' OR action_value.commit_txid IS DISTINCT FROM txid_current()
     OR action_value.lease_token IS DISTINCT FROM p_lease_token THEN
    RAISE EXCEPTION 'OUTCOME_ACTION_COMMIT_FENCE_LOST' USING ERRCODE = '40001';
  END IF;
  result_value := p_receipt->>'result';
  failure_fingerprint_value := NULLIF(p_receipt->>'failureFingerprint', '');
  IF COALESCE(p_receipt->>'providerIdentity', '') = ''
     OR NOT COALESCE(outcome_valid_digest(p_receipt->>'effectDigest'), false)
     OR COALESCE(p_receipt->>'observedAt', '') = ''
     OR result_value NOT IN (
       'SUCCEEDED', 'RETRYABLE_FAILURE', 'PERMANENT_FAILURE', 'QUOTA_WAIT',
       'PARTIAL_EFFECT', 'WRONG_EFFECT', 'TIMED_OUT'
     )
     OR p_receipt->>'idempotencyKey' IS DISTINCT FROM action_value.idempotency_key
     OR (result_value IN ('RETRYABLE_FAILURE', 'PERMANENT_FAILURE', 'QUOTA_WAIT')
       AND NOT COALESCE(outcome_valid_digest(failure_fingerprint_value), false))
     OR ((result_value = 'QUOTA_WAIT') IS DISTINCT FROM
       (COALESCE(p_receipt->>'retryAfterLogicalTicks', '') ~ '^[1-9][0-9]*$')) THEN
    RAISE EXCEPTION 'OUTCOME_ACTION_RECEIPT_INVALID' USING ERRCODE = '22023';
  END IF;
  PERFORM (p_receipt->>'observedAt')::timestamptz;
  IF p_compensation IS NOT NULL THEN
    compensation_result := p_compensation->>'result';
    IF compensation_result NOT IN ('COMPENSATED', 'FAILED', 'UNAVAILABLE')
       OR p_compensation->>'capability' IS DISTINCT FROM action_value.compensator_capability
       OR NOT COALESCE(outcome_valid_digest(p_compensation->>'effectDigest'), false)
       OR p_compensation->>'idempotencyKey' IS DISTINCT FROM action_value.idempotency_key || ':compensation' THEN
      RAISE EXCEPTION 'OUTCOME_ACTION_COMPENSATION_RECEIPT_INVALID' USING ERRCODE = '22023';
    END IF;
  ELSE
    compensation_result := NULL;
  END IF;
  receipt_digest_value := outcome_sha256_json(p_receipt);
  SELECT * INTO existing_receipt
    FROM outcome_action_receipt
   WHERE action_intent_id = p_action_intent_id AND attempt_number = action_value.attempt_count;
  IF FOUND THEN
    IF existing_receipt.receipt_digest::text IS DISTINCT FROM receipt_digest_value
       OR existing_receipt.compensation IS DISTINCT FROM p_compensation THEN
      RAISE EXCEPTION 'OUTCOME_ACTION_RECEIPT_NONDETERMINISTIC' USING ERRCODE = '23505';
    END IF;
    RETURN jsonb_build_object(
      'actionIntentId', action_value.action_intent_id::text,
      'status', action_value.status,
      'effectState', action_value.effect_state,
      'replayed', true,
      'receiptDigest', receipt_digest_value
    );
  END IF;

  INSERT INTO outcome_action_receipt (
    receipt_id, tenant_id, project_id, action_intent_id, attempt_number,
    provider_identity, effect_digest, observed_at, result, idempotency_key,
    failure_fingerprint, retry_after_logical_ticks, compensation, receipt, receipt_digest
  ) VALUES (
    gen_random_uuid(), action_value.tenant_id, action_value.project_id,
    action_value.action_intent_id, action_value.attempt_count,
    p_receipt->>'providerIdentity', p_receipt->>'effectDigest',
    (p_receipt->>'observedAt')::timestamptz, result_value, p_receipt->>'idempotencyKey',
    failure_fingerprint_value,
    CASE WHEN result_value = 'QUOTA_WAIT' THEN (p_receipt->>'retryAfterLogicalTicks')::bigint ELSE NULL END,
    p_compensation, p_receipt, receipt_digest_value
  );
  SELECT * INTO budget_value
    FROM outcome_action_budget_account
   WHERE tenant_id = action_value.tenant_id AND project_id = action_value.project_id
     AND account_id = action_value.budget_account_id
     AND budget_digest = action_value.budget_digest AND unit = action_value.budget_unit
   FOR UPDATE;

  IF failure_fingerprint_value IS NOT NULL THEN
    INSERT INTO outcome_action_failure_fingerprint (
      tenant_id, project_id, action_intent_id, failure_fingerprint,
      occurrence_count, last_logical_time
    ) VALUES (
      action_value.tenant_id, action_value.project_id, action_value.action_intent_id,
      failure_fingerprint_value, 1, p_logical_now
    ) ON CONFLICT (action_intent_id, failure_fingerprint) DO UPDATE SET
      occurrence_count = outcome_action_failure_fingerprint.occurrence_count + 1,
      last_logical_time = EXCLUDED.last_logical_time
    RETURNING occurrence_count INTO fingerprint_count;
  END IF;

  retry_due := NULL;
  obligation_value := NULL;
  CASE result_value
    WHEN 'SUCCEEDED' THEN
      next_status := 'SUCCEEDED'; reason_code_value := 'ACTION_SUCCEEDED'; consume_charge := true;
    WHEN 'PARTIAL_EFFECT' THEN
      consume_charge := true;
      IF compensation_result = 'COMPENSATED' THEN
        next_status := 'COMPENSATED'; reason_code_value := 'AUTOMATIC_COMPENSATION_SUCCEEDED';
      ELSE
        next_status := 'REMEDIATION_REQUIRED';
        reason_code_value := CASE compensation_result
          WHEN 'FAILED' THEN 'COMPENSATION_FAILED'
          WHEN 'UNAVAILABLE' THEN 'COMPENSATOR_UNAVAILABLE'
          ELSE 'PARTIAL_EFFECT' END;
      END IF;
    WHEN 'WRONG_EFFECT' THEN
      consume_charge := true;
      IF compensation_result = 'COMPENSATED' THEN
        next_status := 'COMPENSATED'; reason_code_value := 'AUTOMATIC_COMPENSATION_SUCCEEDED';
      ELSE
        next_status := 'REMEDIATION_REQUIRED';
        reason_code_value := CASE compensation_result
          WHEN 'FAILED' THEN 'COMPENSATION_FAILED'
          WHEN 'UNAVAILABLE' THEN 'COMPENSATOR_UNAVAILABLE'
          ELSE 'WRONG_EFFECT' END;
      END IF;
    WHEN 'QUOTA_WAIT' THEN
      next_status := 'WAITING_QUOTA'; reason_code_value := 'QUOTA_WAIT';
      retry_due := p_logical_now + (p_receipt->>'retryAfterLogicalTicks')::bigint;
    WHEN 'TIMED_OUT' THEN
      consume_charge := true;
      IF action_value.effect_class = 'READ_ONLY' THEN
        next_status := 'TIMED_OUT'; reason_code_value := 'ACTION_TIMEOUT';
      ELSE
        next_status := 'REMEDIATION_REQUIRED'; reason_code_value := 'EFFECT_STATUS_UNKNOWN';
      END IF;
    WHEN 'PERMANENT_FAILURE' THEN
      consume_charge := true;
      next_status := 'FAILED'; reason_code_value := 'ACTION_PERMANENT_FAILURE';
    WHEN 'RETRYABLE_FAILURE' THEN
      consume_charge := true;
      IF action_value.attempt_count >= action_value.retry_max_attempts
         OR fingerprint_count >= action_value.retry_same_fingerprint_limit THEN
        next_status := 'FAILED'; reason_code_value := 'RETRY_BUDGET_EXHAUSTED';
      ELSE
        retry_due := p_logical_now + action_value.retry_backoff_logical_ticks[
          LEAST(action_value.attempt_count, cardinality(action_value.retry_backoff_logical_ticks))
        ];
        IF budget_value.spent_amount + budget_value.reserved_amount + action_value.budget_charge
           <= budget_value.limit_amount THEN
          next_status := 'BACKOFF'; reason_code_value := 'BACKOFF_ACTIVE'; reserve_retry := true;
        ELSE
          next_status := 'BLOCKED_BUDGET'; reason_code_value := 'BUDGET_EXHAUSTED';
          retry_due := NULL;
        END IF;
      END IF;
  END CASE;

  IF consume_charge THEN
    UPDATE outcome_action_budget_account
       SET spent_amount = spent_amount + action_value.budget_charge,
           reserved_amount = reserved_amount - action_value.budget_charge
             + CASE WHEN reserve_retry THEN action_value.budget_charge ELSE 0 END,
           updated_at = clock_timestamp()
     WHERE tenant_id = budget_value.tenant_id AND project_id = budget_value.project_id
       AND account_id = budget_value.account_id AND budget_digest = budget_value.budget_digest
       AND unit = budget_value.unit;
  END IF;

  UPDATE outcome_action_intent
     SET status = next_status,
         effect_state = CASE
           WHEN next_status = 'SUCCEEDED' AND effect_class <> 'READ_ONLY' THEN 'CONFIRMED'
           WHEN next_status = 'COMPENSATED' THEN 'COMPENSATED'
           WHEN next_status = 'REMEDIATION_REQUIRED' THEN 'UNKNOWN'
           WHEN result_value IN ('RETRYABLE_FAILURE', 'PERMANENT_FAILURE', 'QUOTA_WAIT') THEN 'NONE'
           ELSE effect_state
         END,
         next_eligible_logical_time = COALESCE(retry_due, next_eligible_logical_time),
         lease_token = NULL, lease_owner = NULL, lease_expires_logical_time = NULL,
         commit_txid = NULL, updated_at = clock_timestamp()
   WHERE action_intent_id = action_value.action_intent_id
   RETURNING * INTO action_value;
  PERFORM outcome_append_action_event(
    action_value.action_intent_id, action_value.attempt_count, 'COMMITTING', next_status,
    reason_code_value, p_logical_now,
    jsonb_build_object(
      'receiptDigest', receipt_digest_value,
      'failureFingerprintCount', fingerprint_count,
      'compensation', p_compensation
    )
  );

  IF next_status = 'SUCCEEDED' THEN
    PERFORM outcome_resolve_executor_obligation(
      action_value.action_intent_id, p_logical_now, 'ACTION_SUCCEEDED'
    );
  ELSIF next_status = 'COMPENSATED' THEN
    obligation_value := outcome_activate_executor_obligation(
      action_value.action_intent_id,
      CASE WHEN result_value = 'WRONG_EFFECT' THEN 'WRONG_EFFECT' ELSE 'PARTIAL_EFFECT' END,
      p_logical_now, NULL,
      jsonb_build_object('automaticCompensation', p_compensation)
    );
    PERFORM outcome_resolve_executor_obligation(
      action_value.action_intent_id, p_logical_now, 'AUTOMATIC_COMPENSATION_SUCCEEDED'
    );
    obligation_value := NULL;
  ELSE
    obligation_value := outcome_activate_executor_obligation(
      action_value.action_intent_id, reason_code_value, p_logical_now, retry_due,
      jsonb_build_object('receiptDigest', receipt_digest_value, 'compensation', p_compensation)
    );
  END IF;
  RETURN jsonb_build_object(
    'actionIntentId', action_value.action_intent_id::text,
    'status', next_status,
    'effectState', action_value.effect_state,
    'attemptCount', action_value.attempt_count,
    'nextEligibleLogicalTime', CASE WHEN retry_due IS NULL THEN NULL ELSE retry_due::text END,
    'receiptDigest', receipt_digest_value,
    'replayed', false,
    'obligation', obligation_value
  );
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION outcome_fail_claimed_action_diagnosis(
  p_authenticated_tenant uuid,
  p_action_intent_id uuid,
  p_lease_token uuid,
  p_reason_code text,
  p_logical_now bigint
) RETURNS jsonb AS $$
DECLARE
  action_value outcome_action_intent%ROWTYPE;
  obligation_value jsonb;
BEGIN
  IF COALESCE(p_reason_code, '') = '' OR p_logical_now < 0 THEN
    RAISE EXCEPTION 'OUTCOME_ACTION_DIAGNOSIS_INVALID' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO action_value
    FROM outcome_action_intent
   WHERE action_intent_id = p_action_intent_id AND tenant_id = p_authenticated_tenant
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'OUTCOME_ACTION_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;
  IF action_value.status <> 'CLAIMED' OR action_value.lease_token IS DISTINCT FROM p_lease_token THEN
    RAISE EXCEPTION 'OUTCOME_ACTION_LEASE_STALE' USING ERRCODE = '40001';
  END IF;
  UPDATE outcome_action_budget_account
     SET reserved_amount = reserved_amount - action_value.budget_charge,
         updated_at = clock_timestamp()
   WHERE tenant_id = action_value.tenant_id AND project_id = action_value.project_id
     AND account_id = action_value.budget_account_id
     AND budget_digest = action_value.budget_digest AND unit = action_value.budget_unit;
  UPDATE outcome_action_intent
     SET status = 'FAILED', lease_token = NULL, lease_owner = NULL,
         lease_expires_logical_time = NULL, updated_at = clock_timestamp()
   WHERE action_intent_id = action_value.action_intent_id;
  PERFORM outcome_append_action_event(
    action_value.action_intent_id, action_value.attempt_count, 'CLAIMED', 'FAILED',
    p_reason_code, p_logical_now, jsonb_build_object('phase', 'RUNTIME_REGISTRY')
  );
  obligation_value := outcome_activate_executor_obligation(
    action_value.action_intent_id, p_reason_code, p_logical_now, NULL,
    jsonb_build_object('phase', 'RUNTIME_REGISTRY')
  );
  RETURN jsonb_build_object(
    'actionIntentId', action_value.action_intent_id::text,
    'status', 'FAILED',
    'code', p_reason_code,
    'obligation', obligation_value
  );
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION outcome_assert_action_commit_fence(
  p_authenticated_tenant uuid,
  p_action_intent_id uuid,
  p_lease_token uuid
) RETURNS text AS $$
DECLARE
  action_value outcome_action_intent%ROWTYPE;
BEGIN
  SELECT * INTO action_value
    FROM outcome_action_intent
   WHERE action_intent_id = p_action_intent_id AND tenant_id = p_authenticated_tenant;
  IF NOT FOUND OR action_value.status <> 'COMMITTING'
     OR action_value.commit_txid IS DISTINCT FROM txid_current()
     OR action_value.lease_token IS DISTINCT FROM p_lease_token THEN
    RAISE EXCEPTION 'OUTCOME_ACTION_COMMIT_FENCE_LOST' USING ERRCODE = '40001';
  END IF;
  RETURN txid_current()::text;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION outcome_record_action_diagnostic(
  p_authenticated_tenant uuid,
  p_project_id uuid,
  p_obligation_revision text,
  p_idempotency_key text,
  p_code text,
  p_request jsonb,
  p_canonical_obligation jsonb
) RETURNS jsonb AS $$
DECLARE
  source_revision outcome_obligation_revision%ROWTYPE;
  existing outcome_action_diagnostic%ROWTYPE;
  request_digest_value text;
BEGIN
  IF COALESCE(p_idempotency_key, '') = '' OR COALESCE(p_code, '') = ''
     OR NOT COALESCE(outcome_valid_digest(p_obligation_revision), false)
     OR jsonb_typeof(p_request) <> 'object' OR jsonb_typeof(p_canonical_obligation) <> 'object'
     OR p_canonical_obligation->>'kind' IS DISTINCT FROM 'DIAGNOSE_MODEL_GAP'
     OR p_canonical_obligation->>'owner' IS DISTINCT FROM 'AGENT'
     OR p_canonical_obligation#>>'{reason,humanDecisionReason}' IS NOT NULL THEN
    RAISE EXCEPTION 'OUTCOME_ACTION_DIAGNOSTIC_INVALID' USING ERRCODE = '22023';
  END IF;
  PERFORM 1 FROM outcome_fact_stream
   WHERE tenant_id = p_authenticated_tenant AND project_id = p_project_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'OUTCOME_ACTION_STREAM_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;
  SELECT * INTO source_revision
    FROM outcome_obligation_revision
   WHERE tenant_id = p_authenticated_tenant AND project_id = p_project_id
     AND obligation_revision = p_obligation_revision;
  IF NOT FOUND OR source_revision.obligation_id::text IS DISTINCT FROM p_canonical_obligation#>>'{reason,sourceObligationId}'
     AND p_canonical_obligation#>>'{reason,sourceObligationId}' IS NOT NULL THEN
    RAISE EXCEPTION 'OUTCOME_ACTION_DIAGNOSTIC_SOURCE_INVALID' USING ERRCODE = '42501';
  END IF;
  request_digest_value := outcome_sha256_json(p_request);
  SELECT * INTO existing
    FROM outcome_action_diagnostic
   WHERE tenant_id = p_authenticated_tenant AND project_id = p_project_id
     AND idempotency_key = p_idempotency_key;
  IF FOUND THEN
    IF existing.request_digest::text IS DISTINCT FROM request_digest_value
       OR existing.code IS DISTINCT FROM p_code
       OR existing.canonical_obligation IS DISTINCT FROM p_canonical_obligation THEN
      RAISE EXCEPTION 'OUTCOME_ACTION_DIAGNOSTIC_IDEMPOTENCY_CONFLICT' USING ERRCODE = '23505';
    END IF;
    RETURN jsonb_build_object(
      'diagnosticId', existing.diagnostic_id::text,
      'code', existing.code,
      'obligation', existing.canonical_obligation,
      'replayed', true
    );
  END IF;
  INSERT INTO outcome_action_diagnostic (
    diagnostic_id, tenant_id, project_id, obligation_id, obligation_revision,
    idempotency_key, code, request_digest, canonical_obligation
  ) VALUES (
    gen_random_uuid(), p_authenticated_tenant, p_project_id, source_revision.obligation_id,
    p_obligation_revision, p_idempotency_key, p_code, request_digest_value,
    p_canonical_obligation
  ) RETURNING * INTO existing;
  RETURN jsonb_build_object(
    'diagnosticId', existing.diagnostic_id::text,
    'code', existing.code,
    'obligation', existing.canonical_obligation,
    'replayed', false
  );
END;
$$ LANGUAGE plpgsql;

CREATE VIEW outcome_canonical_active_obligation AS
SELECT
  active.tenant_id,
  active.project_id,
  active.obligation_id,
  active.obligation_revision,
  active.binding_digest,
  active.kind,
  active.obligation->>'owner' AS owner,
  active.evaluated_through_logical_time,
  active.obligation,
  'OUTCOME_EVALUATOR'::text AS origin,
  active.evaluation_id,
  NULL::uuid AS action_intent_id
FROM outcome_active_obligation active
UNION ALL
SELECT
  active.tenant_id,
  active.project_id,
  active.obligation_id,
  active.obligation_revision,
  active.binding_digest,
  active.kind,
  active.owner,
  COALESCE((active.obligation->>'createdAtLogicalTime')::bigint, 0),
  active.obligation,
  'ACTION_EXECUTOR'::text AS origin,
  NULL::uuid AS evaluation_id,
  active.action_intent_id
FROM outcome_executor_active_obligation active;

COMMIT;
