-- Completion-ACK remediation: reachable, typed owner-decision child protocol.
--
-- A completion-ACK incident remains one ACTIVE, AGENT-owned canonical obligation.  The exact
-- coordinator delivery may pause that same coordination for one of four irreducibly owner-shaped
-- inputs, but the request is a child record: it cannot mint, revise or close the 0201 lifecycle.
-- The binding below is append-only proof that the request came from the exact, non-revoked
-- delivery Session that was current when it was asked.
BEGIN;

CREATE TABLE completion_ack_owner_decision_binding (
  binding_id              uuid        PRIMARY KEY,
  tenant_id               uuid        NOT NULL,
  project_id              uuid        NOT NULL,
  coordination_id         uuid        NOT NULL,
  obligation_id           char(64)    NOT NULL CHECK (outcome_valid_digest(obligation_id)),
  obligation_revision     char(64)    NOT NULL CHECK (outcome_valid_digest(obligation_revision)),
  request_id              uuid        NOT NULL UNIQUE,
  delivery_receipt_id     uuid        NOT NULL,
  coordinator_session_id  uuid        NOT NULL,
  runner_id_snapshot      uuid        NOT NULL,
  reason                  text        NOT NULL CHECK (reason IN (
    'GOAL_DECISION', 'RISK_ACCEPTANCE', 'NEW_AUTHORIZATION', 'EXTERNAL_IDENTITY'
  )),
  request_digest          char(64)    NOT NULL CHECK (outcome_valid_digest(request_digest)),
  binding_digest          char(64)    NOT NULL UNIQUE CHECK (outcome_valid_digest(binding_digest)),
  recorded_logical_time   bigint      NOT NULL CHECK (recorded_logical_time >= 0),
  recorded_at             timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (request_id)
    REFERENCES outcome_coordinator_owner_decision_request(request_id)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  FOREIGN KEY (delivery_receipt_id)
    REFERENCES completion_ack_coordinator_delivery_receipt(delivery_receipt_id)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  FOREIGN KEY (coordination_id)
    REFERENCES outcome_coordinator_obligation(coordination_id)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  FOREIGN KEY (obligation_id, obligation_revision)
    REFERENCES completion_ack_obligation_revision(obligation_id, obligation_revision)
    ON DELETE RESTRICT ON UPDATE RESTRICT
);

CREATE INDEX completion_ack_owner_decision_scope_idx
  ON completion_ack_owner_decision_binding(
    tenant_id, project_id, obligation_id, obligation_revision, recorded_at DESC
  );

CREATE TRIGGER completion_ack_owner_decision_binding_append_only
  BEFORE UPDATE OR DELETE ON completion_ack_owner_decision_binding
  FOR EACH ROW EXECUTE FUNCTION outcome_append_only_guard();

CREATE OR REPLACE FUNCTION completion_ack_owner_decision_binding_insert_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_request outcome_coordinator_owner_decision_request%ROWTYPE;
  v_delivery record;
  v_session session%ROWTYPE;
  v_expected_digest char(64);
BEGIN
  -- Serialize authority use with 0203's append-only delivery revocation/requeue transaction.
  PERFORM pg_advisory_xact_lock(hashtextextended(
    'completion-ack-delivery-authority:v1:' || NEW.obligation_revision::text, 0
  ));

  SELECT * INTO v_request
    FROM outcome_coordinator_owner_decision_request request
   WHERE request.request_id = NEW.request_id
   FOR KEY SHARE;
  SELECT * INTO v_session
    FROM session coordinator_session
   WHERE coordinator_session.id = NEW.coordinator_session_id
   FOR KEY SHARE;
  SELECT current.* INTO v_delivery
    FROM completion_ack_current_coordinator_delivery current
   WHERE current.tenant_id = NEW.tenant_id
     AND current.project_id = NEW.project_id
     AND current.coordination_id = NEW.coordination_id
     AND current.obligation_id = NEW.obligation_id
     AND current.obligation_revision = NEW.obligation_revision
     AND current.delivery_receipt_id = NEW.delivery_receipt_id
     AND current.session_id = NEW.coordinator_session_id;

  IF v_request.request_id IS NULL OR v_delivery.delivery_receipt_id IS NULL
     OR v_session.id IS NULL
     OR v_session.owner_id IS DISTINCT FROM NEW.tenant_id
     OR v_session.assigned_runner_id IS DISTINCT FROM NEW.runner_id_snapshot
     OR v_request.tenant_id IS DISTINCT FROM NEW.tenant_id
     OR v_request.project_id IS DISTINCT FROM NEW.project_id
     OR v_request.coordination_id IS DISTINCT FROM NEW.coordination_id
     OR v_request.obligation_revision IS DISTINCT FROM NEW.obligation_revision
     OR v_request.reason IS DISTINCT FROM NEW.reason
     OR v_request.request_digest IS DISTINCT FROM NEW.request_digest
     OR NEW.recorded_logical_time IS DISTINCT FROM outcome_coordinator_now(NEW.tenant_id) THEN
    RAISE EXCEPTION 'COMPLETION_ACK_OWNER_DECISION_BINDING_SCOPE_INVALID:%', NEW.request_id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  v_expected_digest := outcome_sha256_json(jsonb_build_array(
    'completion-ack-owner-decision-binding:v1', NEW.tenant_id::text,
    NEW.project_id::text, NEW.coordination_id::text, NEW.obligation_id::text,
    NEW.obligation_revision::text, NEW.request_id::text,
    NEW.delivery_receipt_id::text, NEW.coordinator_session_id::text,
    NEW.runner_id_snapshot::text, NEW.reason, NEW.request_digest::text
  ));
  IF NEW.binding_digest IS DISTINCT FROM v_expected_digest
     OR NEW.binding_id IS DISTINCT FROM completion_ack_uuid_from_digest(v_expected_digest::text) THEN
    RAISE EXCEPTION 'COMPLETION_ACK_OWNER_DECISION_BINDING_IDENTITY_INVALID:%', NEW.request_id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  NEW.recorded_at := clock_timestamp();
  RETURN NEW;
END;
$$;

CREATE TRIGGER completion_ack_owner_decision_binding_insert_guard
  BEFORE INSERT ON completion_ack_owner_decision_binding
  FOR EACH ROW EXECUTE FUNCTION completion_ack_owner_decision_binding_insert_guard();

-- Direct SQL must not be able to put a completion coordination into OWNER_DECISION without the
-- exact delivery binding.  Deferred execution allows the request row (the FK parent) and its
-- append-only binding to be inserted in the same transaction without weakening the invariant.
CREATE OR REPLACE FUNCTION completion_ack_owner_decision_request_binding_required()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_standing outcome_coordinator_obligation%ROWTYPE;
BEGIN
  SELECT * INTO v_standing
    FROM outcome_coordinator_obligation standing
   WHERE standing.coordination_id = NEW.coordination_id;
  IF NOT FOUND OR v_standing.source_type <> 'COMPLETION_ACK' THEN RETURN NULL; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM completion_ack_owner_decision_binding binding
     WHERE binding.request_id = NEW.request_id
       AND binding.tenant_id = NEW.tenant_id
       AND binding.project_id = NEW.project_id
       AND binding.coordination_id = NEW.coordination_id
       AND binding.obligation_revision = NEW.obligation_revision
       AND binding.reason = NEW.reason
       AND binding.request_digest = NEW.request_digest
  ) THEN
    RAISE EXCEPTION 'COMPLETION_ACK_OWNER_DECISION_BINDING_REQUIRED:%', NEW.request_id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER outcome_coordinator_completion_owner_decision_binding_required
  AFTER INSERT OR UPDATE OF status, decision, decision_digest
  ON outcome_coordinator_owner_decision_request
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION completion_ack_owner_decision_request_binding_required();

CREATE OR REPLACE FUNCTION completion_ack_request_owner_decision(
  p_tenant_id uuid,
  p_project_id uuid,
  p_runner_id uuid,
  p_coordinator_session_id uuid,
  p_obligation_id text,
  p_obligation_revision text,
  p_reason text,
  p_request jsonb
) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE
  v_standing outcome_coordinator_obligation%ROWTYPE;
  v_delivery record;
  v_previous outcome_coordinator_owner_decision_request%ROWTYPE;
  v_request_id uuid;
  v_request_digest char(64);
  v_binding_digest char(64);
  v_binding_id uuid;
  v_now bigint;
  v_from_status text;
BEGIN
  IF NOT COALESCE(outcome_valid_digest(p_obligation_id), false)
     OR NOT COALESCE(outcome_valid_digest(p_obligation_revision), false)
     OR p_reason NOT IN (
       'GOAL_DECISION', 'RISK_ACCEPTANCE', 'NEW_AUTHORIZATION', 'EXTERNAL_IDENTITY'
     ) THEN
    RAISE EXCEPTION 'COMPLETION_ACK_OWNER_DECISION_ARGUMENT_INVALID'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF jsonb_typeof(p_request) <> 'object'
     OR octet_length(p_request::text) > 16384
     OR NOT (p_request ?& ARRAY[
       'whyNotAgent', 'options', 'impacts', 'recommendation', 'noActionConsequence',
       'cost', 'deadline', 'resumeBehavior', 'idempotencyKey'
     ]) THEN
    RAISE EXCEPTION 'COMPLETION_ACK_OWNER_DECISION_PAYLOAD_INCOMPLETE'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF length(btrim(COALESCE(p_request->>'whyNotAgent', ''))) NOT BETWEEN 1 AND 4000
     OR jsonb_typeof(p_request->'options') <> 'array'
     OR jsonb_array_length(p_request->'options') NOT BETWEEN 1 AND 16
     OR jsonb_typeof(p_request->'impacts') <> 'array'
     OR jsonb_array_length(p_request->'impacts') NOT BETWEEN 1 AND 16
     OR p_request->'recommendation' = 'null'::jsonb
     OR p_request->'noActionConsequence' = 'null'::jsonb
     OR p_request->'cost' = 'null'::jsonb
     OR p_request->'deadline' = 'null'::jsonb
     OR p_request->'resumeBehavior' = 'null'::jsonb
     OR length(btrim(COALESCE(p_request->>'idempotencyKey', ''))) NOT BETWEEN 1 AND 200 THEN
    RAISE EXCEPTION 'COMPLETION_ACK_OWNER_DECISION_PROTOCOL_INVALID'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(
    'completion-ack-delivery-authority:v1:' || p_obligation_revision, 0
  ));
  SELECT * INTO v_standing
    FROM outcome_coordinator_obligation standing
   WHERE standing.tenant_id = p_tenant_id
     AND standing.project_id = p_project_id
     AND standing.obligation_id::text = p_obligation_id
     AND standing.obligation_revision::text = p_obligation_revision
   FOR UPDATE;
  IF NOT FOUND OR v_standing.source_type <> 'COMPLETION_ACK'
     OR v_standing.capability <> 'completion-ack.recover'
     OR v_standing.requested_owner <> 'PROJECT_COORDINATOR'
     OR v_standing.durable_owner <> 'AGENT'
     OR v_standing.status NOT IN (
       'READY', 'CLAIMED', 'SCHEDULED', 'EXTERNAL_WAIT', 'OWNER_DECISION'
     ) THEN
    RAISE EXCEPTION 'COMPLETION_ACK_OWNER_DECISION_OBLIGATION_NOT_ACTIVE'
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  SELECT current.* INTO v_delivery
    FROM completion_ack_current_coordinator_delivery current
    JOIN session coordinator_session
      ON coordinator_session.id = current.session_id
     AND coordinator_session.owner_id = current.tenant_id
     AND coordinator_session.assigned_runner_id = p_runner_id
   WHERE current.tenant_id = p_tenant_id
     AND current.project_id = p_project_id
     AND current.coordination_id = v_standing.coordination_id
     AND current.obligation_id::text = p_obligation_id
     AND current.obligation_revision::text = p_obligation_revision
     AND current.session_id = p_coordinator_session_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'COMPLETION_ACK_OWNER_DECISION_CURRENT_DELIVERY_REQUIRED'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  v_now := outcome_coordinator_now(p_tenant_id);
  v_request_digest := outcome_sha256_json(p_request);
  SELECT * INTO v_previous
    FROM outcome_coordinator_owner_decision_request request
   WHERE request.tenant_id = p_tenant_id
     AND request.project_id = p_project_id
     AND request.idempotency_key = btrim(p_request->>'idempotencyKey');
  IF FOUND THEN
    IF v_previous.coordination_id IS DISTINCT FROM v_standing.coordination_id
       OR v_previous.obligation_revision IS DISTINCT FROM v_standing.obligation_revision
       OR v_previous.reason IS DISTINCT FROM p_reason
       OR v_previous.request_digest IS DISTINCT FROM v_request_digest
       OR NOT EXISTS (
         SELECT 1 FROM completion_ack_owner_decision_binding binding
          WHERE binding.request_id = v_previous.request_id
            AND binding.delivery_receipt_id = v_delivery.delivery_receipt_id
            AND binding.coordinator_session_id = p_coordinator_session_id
            AND binding.runner_id_snapshot = p_runner_id
       ) THEN
      RAISE EXCEPTION 'COMPLETION_ACK_OWNER_DECISION_IDEMPOTENCY_CONFLICT'
        USING ERRCODE = 'unique_violation';
    END IF;
    RETURN jsonb_build_object(
      'requestId', v_previous.request_id::text,
      'coordinationId', v_previous.coordination_id::text,
      'obligationId', p_obligation_id,
      'obligationRevision', p_obligation_revision,
      'status', v_previous.status,
      'reason', v_previous.reason,
      'durableOwner', 'AGENT',
      'canonicalSourceState', 'ACTIVE',
      'replayed', true
    );
  END IF;
  IF EXISTS (
    SELECT 1 FROM outcome_coordinator_owner_decision_request request
     WHERE request.coordination_id = v_standing.coordination_id
       AND request.obligation_revision = v_standing.obligation_revision
       AND request.status = 'OPEN'
  ) THEN
    RAISE EXCEPTION 'COMPLETION_ACK_OWNER_DECISION_ALREADY_OPEN'
      USING ERRCODE = 'unique_violation';
  END IF;

  v_request_id := completion_ack_uuid_from_digest(outcome_sha256_json(jsonb_build_array(
    'completion-ack-owner-decision-request:v1', p_tenant_id::text, p_project_id::text,
    v_standing.coordination_id::text, p_obligation_revision,
    btrim(p_request->>'idempotencyKey')
  ))::text);
  INSERT INTO outcome_coordinator_owner_decision_request (
    request_id, tenant_id, project_id, coordination_id, obligation_revision,
    reason, why_not_agent, idempotency_key, request, request_digest,
    status, requested_logical_time
  ) VALUES (
    v_request_id, p_tenant_id, p_project_id, v_standing.coordination_id,
    v_standing.obligation_revision, p_reason, btrim(p_request->>'whyNotAgent'),
    btrim(p_request->>'idempotencyKey'), p_request, v_request_digest, 'OPEN', v_now
  );

  v_binding_digest := outcome_sha256_json(jsonb_build_array(
    'completion-ack-owner-decision-binding:v1', p_tenant_id::text,
    p_project_id::text, v_standing.coordination_id::text, p_obligation_id,
    p_obligation_revision, v_request_id::text, v_delivery.delivery_receipt_id::text,
    p_coordinator_session_id::text, p_runner_id::text, p_reason,
    v_request_digest::text
  ));
  v_binding_id := completion_ack_uuid_from_digest(v_binding_digest::text);
  INSERT INTO completion_ack_owner_decision_binding (
    binding_id, tenant_id, project_id, coordination_id, obligation_id,
    obligation_revision, request_id, delivery_receipt_id,
    coordinator_session_id, runner_id_snapshot, reason, request_digest,
    binding_digest, recorded_logical_time
  ) VALUES (
    v_binding_id, p_tenant_id, p_project_id, v_standing.coordination_id,
    v_standing.obligation_id, v_standing.obligation_revision, v_request_id,
    v_delivery.delivery_receipt_id, p_coordinator_session_id, p_runner_id,
    p_reason, v_request_digest, v_binding_digest, v_now
  );

  v_from_status := v_standing.status;
  UPDATE outcome_coordinator_wake
     SET state = 'CANCELLED', updated_at = clock_timestamp()
   WHERE coordination_id = v_standing.coordination_id AND state = 'SCHEDULED';
  UPDATE outcome_coordinator_external_wait
     SET state = 'SUPERSEDED', updated_at = clock_timestamp()
   WHERE coordination_id = v_standing.coordination_id AND state = 'ACTIVE';
  UPDATE outcome_coordinator_obligation
     SET status = 'OWNER_DECISION', durable_owner = 'AGENT',
         decision_request_id = v_request_id,
         next_wake_logical_time = NULL,
         lease_id = NULL, lease_token = NULL, lease_owner = NULL,
         lease_expires_logical_time = NULL, external_wait_id = NULL,
         last_progress_logical_time = v_now,
         progress_deadline_logical_time = v_now + liveness_delta,
         diagnostic_path = 'VALIDATED_COMPLETION_ACK_OWNER_DECISION',
         updated_at = clock_timestamp()
   WHERE coordination_id = v_standing.coordination_id;
  PERFORM outcome_append_coordinator_event(
    v_standing.coordination_id,
    'completion-owner-request:' || v_request_id::text,
    'COMPLETION_ACK_OWNER_DECISION_REQUESTED', v_from_status, 'OWNER_DECISION',
    'OWNER_DECISION_REQUEST', v_now, NULL,
    jsonb_build_object(
      'requestId', v_request_id::text,
      'deliveryReceiptId', v_delivery.delivery_receipt_id::text,
      'coordinatorSessionId', p_coordinator_session_id::text,
      'reason', p_reason,
      'durableOwner', 'AGENT',
      'canonicalSourceState', 'ACTIVE'
    )
  );
  RETURN jsonb_build_object(
    'requestId', v_request_id::text,
    'coordinationId', v_standing.coordination_id::text,
    'obligationId', p_obligation_id,
    'obligationRevision', p_obligation_revision,
    'deliveryReceiptId', v_delivery.delivery_receipt_id::text,
    'status', 'OPEN',
    'reason', p_reason,
    'durableOwner', 'AGENT',
    'canonicalSourceState', 'ACTIVE',
    'replayed', false
  );
END;
$$;

CREATE OR REPLACE FUNCTION completion_ack_decide_owner_decision(
  p_tenant_id uuid,
  p_project_id uuid,
  p_request_id uuid,
  p_obligation_revision text,
  p_idempotency_key text,
  p_decision jsonb
) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE
  v_request outcome_coordinator_owner_decision_request%ROWTYPE;
  v_binding completion_ack_owner_decision_binding%ROWTYPE;
  v_standing outcome_coordinator_obligation%ROWTYPE;
  v_now bigint;
  v_decision_digest char(64);
  v_wake jsonb;
BEGIN
  IF NOT COALESCE(outcome_valid_digest(p_obligation_revision), false)
     OR length(btrim(COALESCE(p_idempotency_key, ''))) NOT BETWEEN 1 AND 200
     OR jsonb_typeof(p_decision) <> 'object'
     OR octet_length(p_decision::text) > 16384 THEN
    RAISE EXCEPTION 'COMPLETION_ACK_OWNER_DECISION_CALLBACK_INVALID'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  SELECT * INTO v_request
    FROM outcome_coordinator_owner_decision_request request
   WHERE request.tenant_id = p_tenant_id
     AND request.project_id = p_project_id
     AND request.request_id = p_request_id
   FOR UPDATE;
  SELECT * INTO v_binding
    FROM completion_ack_owner_decision_binding binding
   WHERE binding.tenant_id = p_tenant_id
     AND binding.project_id = p_project_id
     AND binding.request_id = p_request_id;
  IF v_request.request_id IS NULL OR v_binding.binding_id IS NULL
     OR v_request.obligation_revision::text <> p_obligation_revision
     OR v_binding.obligation_revision::text <> p_obligation_revision THEN
    RAISE EXCEPTION 'COMPLETION_ACK_OWNER_DECISION_REQUEST_NOT_FOUND'
      USING ERRCODE = 'no_data_found';
  END IF;
  v_decision_digest := outcome_sha256_json(p_decision);
  IF v_request.status = 'DECIDED' THEN
    IF v_request.decision_idempotency_key IS DISTINCT FROM btrim(p_idempotency_key)
       OR v_request.decision_digest IS DISTINCT FROM v_decision_digest THEN
      RAISE EXCEPTION 'COMPLETION_ACK_OWNER_DECISION_CALLBACK_CONFLICT'
        USING ERRCODE = 'unique_violation';
    END IF;
    RETURN jsonb_build_object(
      'requestId', v_request.request_id::text,
      'coordinationId', v_request.coordination_id::text,
      'obligationId', v_binding.obligation_id::text,
      'obligationRevision', v_binding.obligation_revision::text,
      'status', 'DECIDED', 'resumed', true, 'replayed', true
    );
  END IF;
  IF v_request.status <> 'OPEN' THEN
    RAISE EXCEPTION 'COMPLETION_ACK_OWNER_DECISION_REQUEST_STALE'
      USING ERRCODE = 'serialization_failure';
  END IF;
  SELECT * INTO v_standing
    FROM outcome_coordinator_obligation standing
   WHERE standing.tenant_id = p_tenant_id
     AND standing.project_id = p_project_id
     AND standing.coordination_id = v_request.coordination_id
   FOR UPDATE;
  IF NOT FOUND OR v_standing.source_type <> 'COMPLETION_ACK'
     OR v_standing.status <> 'OWNER_DECISION'
     OR v_standing.durable_owner <> 'AGENT'
     OR v_standing.obligation_revision IS DISTINCT FROM v_request.obligation_revision
     OR v_standing.decision_request_id IS DISTINCT FROM v_request.request_id
     OR NOT EXISTS (
       SELECT 1 FROM completion_ack_active_obligation active
        WHERE active.tenant_id = p_tenant_id
          AND active.project_id = p_project_id
          AND active.obligation_id = v_binding.obligation_id
          AND active.obligation_revision = v_binding.obligation_revision
     ) THEN
    RAISE EXCEPTION 'COMPLETION_ACK_OWNER_DECISION_REQUEST_STALE'
      USING ERRCODE = 'serialization_failure';
  END IF;

  v_now := outcome_coordinator_now(p_tenant_id);
  UPDATE outcome_coordinator_owner_decision_request
     SET status = 'DECIDED', decision = p_decision,
         decision_digest = v_decision_digest,
         decision_idempotency_key = btrim(p_idempotency_key),
         decided_logical_time = v_now, decided_at = clock_timestamp()
   WHERE request_id = v_request.request_id;
  UPDATE outcome_coordinator_obligation
     SET diagnostic_path = 'COMPLETION_ACK_OWNER_DECISION_DELIVERED',
         last_progress_logical_time = v_now,
         progress_deadline_logical_time = v_now + liveness_delta,
         updated_at = clock_timestamp()
   WHERE coordination_id = v_standing.coordination_id;
  PERFORM outcome_append_coordinator_event(
    v_standing.coordination_id,
    'completion-owner-decision:' || v_request.request_id::text,
    'COMPLETION_ACK_OWNER_DECISION_DELIVERED', 'OWNER_DECISION', 'SCHEDULED',
    'EXTERNAL_DELIVERY', v_now, NULL,
    jsonb_build_object(
      'requestId', v_request.request_id::text,
      'decisionDigest', v_decision_digest::text,
      'resumeBehavior', v_request.request->'resumeBehavior',
      'durableOwner', 'AGENT',
      'canonicalSourceState', 'ACTIVE'
    )
  );
  v_wake := completion_ack_schedule_coordinator_wake(
    v_standing.coordination_id, v_now, 'COMPLETION_ACK_OWNER_DECISION_RESUME'
  );
  RETURN jsonb_build_object(
    'requestId', v_request.request_id::text,
    'coordinationId', v_request.coordination_id::text,
    'obligationId', v_binding.obligation_id::text,
    'obligationRevision', v_binding.obligation_revision::text,
    'status', 'DECIDED', 'resumed', true,
    'durableOwner', 'AGENT', 'canonicalSourceState', 'ACTIVE',
    'wake', v_wake, 'replayed', false
  );
END;
$$;

COMMIT;
