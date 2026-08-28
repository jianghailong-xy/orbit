-- Outcome Reconciler V2: canonical fact ingress and the linearizable evaluation boundary.
--
-- Canonical facts, their bindings/authority records, and sealed cuts are immutable ledgers.
-- The mutable projection is deliberately a different table and is never an input to replay.
-- One stream row per tenant/project allocates logical time and serializes append versus seal, so
-- a concurrent fact is either inside a cut or strictly after its watermark.
BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- PostgreSQL jsonb retains arbitrary-precision numeric spelling, while RFC 8785 uses the
-- ECMAScript/IEEE-754 shortest representation. PostgreSQL's float8 output already supplies the
-- shortest round-trippable mantissa; this function applies ECMAScript's decimal/scientific
-- thresholds and exponent spelling to it.
CREATE OR REPLACE FUNCTION outcome_canonical_number(p_value jsonb) RETURNS text AS $$
DECLARE
  raw_value text;
  sign_value text := '';
  mantissa text;
  digits text;
  exponent_value integer;
  decimal_position integer;
BEGIN
  raw_value := ((p_value #>> '{}')::double precision)::text;
  IF raw_value IN ('Infinity', '-Infinity', 'NaN') THEN
    RAISE EXCEPTION 'OUTCOME_CANONICAL_NUMBER_OUT_OF_RANGE' USING ERRCODE = '22003';
  END IF;
  IF strpos(raw_value, 'e') = 0 THEN
    RETURN raw_value;
  END IF;
  mantissa := split_part(raw_value, 'e', 1);
  exponent_value := split_part(raw_value, 'e', 2)::integer;
  IF left(mantissa, 1) = '-' THEN
    sign_value := '-';
    mantissa := substr(mantissa, 2);
  END IF;
  digits := replace(mantissa, '.', '');
  IF exponent_value BETWEEN -6 AND 20 THEN
    decimal_position := exponent_value + 1;
    IF decimal_position <= 0 THEN
      RETURN sign_value || '0.' || repeat('0', -decimal_position) || digits;
    ELSIF decimal_position >= length(digits) THEN
      RETURN sign_value || digits || repeat('0', decimal_position - length(digits));
    ELSE
      RETURN sign_value || substr(digits, 1, decimal_position) || '.'
             || substr(digits, decimal_position + 1);
    END IF;
  END IF;
  RETURN sign_value || mantissa || 'e'
         || CASE WHEN exponent_value >= 0 THEN '+' ELSE '' END || exponent_value::text;
END;
$$ LANGUAGE plpgsql IMMUTABLE STRICT PARALLEL SAFE;

CREATE OR REPLACE FUNCTION outcome_canonical_json(p_value jsonb) RETURNS text AS $$
DECLARE
  rendered text;
BEGIN
  CASE jsonb_typeof(p_value)
    WHEN 'object' THEN
      SELECT COALESCE(
        '{' || string_agg(to_jsonb(item.key)::text || ':' || outcome_canonical_json(item.value),
                          ',' ORDER BY item.key COLLATE "C") || '}',
        '{}'
      )
        INTO rendered
        FROM jsonb_each(p_value) AS item;
      RETURN rendered;
    WHEN 'array' THEN
      SELECT COALESCE(
        '[' || string_agg(outcome_canonical_json(item.value), ',' ORDER BY item.ordinality) || ']',
        '[]'
      )
        INTO rendered
        FROM jsonb_array_elements(p_value) WITH ORDINALITY AS item(value, ordinality);
      RETURN rendered;
    WHEN 'string' THEN
      RETURN to_jsonb(p_value #>> '{}')::text;
    WHEN 'number' THEN
      RETURN outcome_canonical_number(p_value);
    ELSE
      RETURN p_value::text;
  END CASE;
END;
$$ LANGUAGE plpgsql IMMUTABLE STRICT PARALLEL SAFE;

CREATE OR REPLACE FUNCTION outcome_sha256_json(p_value jsonb) RETURNS text AS $$
  SELECT encode(digest(convert_to(outcome_canonical_json(p_value), 'UTF8'), 'sha256'), 'hex')
$$ LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE;

CREATE OR REPLACE FUNCTION outcome_valid_digest(p_value text) RETURNS boolean AS $$
  SELECT p_value ~ '^[0-9a-f]{64}$'
$$ LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE;

CREATE OR REPLACE FUNCTION outcome_jsonb_exact_keys(p_value jsonb, p_expected text[])
RETURNS boolean AS $$
  SELECT jsonb_typeof(p_value) = 'object'
     AND (SELECT array_agg(item.key ORDER BY item.key COLLATE "C")
            FROM jsonb_object_keys(p_value) AS item(key))
         = (SELECT array_agg(item.key ORDER BY item.key COLLATE "C")
              FROM unnest(p_expected) AS item(key))
$$ LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE;

CREATE OR REPLACE FUNCTION outcome_append_only_guard() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'OUTCOME_APPEND_ONLY_VIOLATION:%', TG_TABLE_NAME
    USING ERRCODE = '23514',
          DETAIL = 'canonical facts, authority/binding history, and sealed cuts are immutable';
END;
$$ LANGUAGE plpgsql;

CREATE TABLE outcome_fact_stream (
  tenant_id uuid NOT NULL,
  project_id uuid NOT NULL,
  last_logical_time bigint NOT NULL DEFAULT 0 CHECK (last_logical_time >= 0),
  binding_epoch bigint NOT NULL DEFAULT 0 CHECK (binding_epoch >= 0),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, project_id)
);

CREATE TABLE outcome_fact_binding (
  tenant_id uuid NOT NULL,
  project_id uuid NOT NULL,
  binding_digest char(64) NOT NULL CHECK (outcome_valid_digest(binding_digest)),
  binding_epoch bigint NOT NULL CHECK (binding_epoch > 0),
  subject_type text NOT NULL CHECK (subject_type <> ''),
  subject_id text NOT NULL CHECK (subject_id <> ''),
  goal_id text NOT NULL CHECK (goal_id <> ''),
  goal_revision bigint NOT NULL CHECK (goal_revision >= 0),
  risk_policy_digest char(64) NOT NULL CHECK (outcome_valid_digest(risk_policy_digest)),
  fact_schema_digest char(64) NOT NULL CHECK (outcome_valid_digest(fact_schema_digest)),
  target_digest char(64) NOT NULL CHECK (outcome_valid_digest(target_digest)),
  target_ref text NOT NULL CHECK (target_ref <> ''),
  binding jsonb NOT NULL,
  registered_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, project_id, binding_digest),
  UNIQUE (tenant_id, project_id, binding_epoch),
  FOREIGN KEY (tenant_id, project_id) REFERENCES outcome_fact_stream(tenant_id, project_id)
);

CREATE INDEX outcome_fact_binding_current_idx
  ON outcome_fact_binding (tenant_id, project_id, binding_epoch DESC);

CREATE TABLE outcome_fact_authority_matrix (
  fact_kind text NOT NULL,
  claim_type text NOT NULL,
  principal_type text NOT NULL,
  source_system text NOT NULL,
  trust_class text NOT NULL CHECK (trust_class IN (
    'CLAIM_ONLY', 'CONTROL_PLANE_FACT', 'MECHANICAL_FACT', 'EVALUATOR_FACT',
    'REPOSITORY_ATTESTATION', 'OWNER_DECISION', 'PROVIDER_RECEIPT'
  )),
  proof_eligible boolean NOT NULL,
  signature_required boolean NOT NULL,
  requires_controlled_runner_exit boolean NOT NULL,
  requires_target_repository_verification boolean NOT NULL,
  requires_current_threat_model boolean NOT NULL,
  PRIMARY KEY (fact_kind, claim_type, principal_type, source_system),
  CHECK (principal_type <> 'AGENT' OR (trust_class = 'CLAIM_ONLY' AND NOT proof_eligible)),
  CHECK (NOT requires_controlled_runner_exit OR (
    trust_class = 'MECHANICAL_FACT' AND principal_type = 'RUNNER' AND proof_eligible
  )),
  CHECK (NOT requires_target_repository_verification OR (
    trust_class = 'REPOSITORY_ATTESTATION' AND proof_eligible
  )),
  CHECK (NOT requires_current_threat_model OR (
    trust_class = 'OWNER_DECISION' AND principal_type = 'OWNER' AND proof_eligible
  ))
);

INSERT INTO outcome_fact_authority_matrix (
  fact_kind, claim_type, principal_type, source_system, trust_class, proof_eligible,
  signature_required, requires_controlled_runner_exit,
  requires_target_repository_verification, requires_current_threat_model
) VALUES
  ('GOAL_DECLARED',                 'ATTESTATION', 'SYSTEM',   'ORBIT_CONTROL_PLANE',        'CONTROL_PLANE_FACT',     true,  false, false, false, false),
  ('GOAL_RATIFIED',                 'DECISION',    'OWNER',    'OWNER_DECISION',             'OWNER_DECISION',         true,  true,  false, false, true),
  ('GOAL_DISPOSITION_RECORDED',     'DECISION',    'OWNER',    'OWNER_DECISION',             'OWNER_DECISION',         true,  true,  false, false, true),
  ('ATTEMPT_STARTED',               'ATTESTATION', 'SYSTEM',   'ORBIT_CONTROL_PLANE',        'CONTROL_PLANE_FACT',     true,  false, false, false, false),
  ('ATTEMPT_TERMINATED',            'ATTESTATION', 'RUNNER',   'CONTROLLED_RUNNER',          'MECHANICAL_FACT',        true,  true,  true,  false, false),
  ('DIMENSION_EVALUATED',           'ATTESTATION', 'SYSTEM',   'OUTCOME_EVALUATOR',          'EVALUATOR_FACT',         true,  false, false, false, false),
  ('MODEL_GAP_DETECTED',            'ATTESTATION', 'SYSTEM',   'OUTCOME_EVALUATOR',          'EVALUATOR_FACT',         true,  false, false, false, false),
  ('TASK_STATUS_OBSERVED',          'OBSERVATION', 'AGENT',    'AGENT_COLLECTOR',            'CLAIM_ONLY',             false, true,  false, false, false),
  ('DONE_GATE_EVALUATED',           'ATTESTATION', 'SYSTEM',   'ORBIT_CONTROL_PLANE',        'CONTROL_PLANE_FACT',     true,  false, false, false, false),
  ('JUDGMENT_REQUESTED',            'INTENT',      'SYSTEM',   'ORBIT_CONTROL_PLANE',        'CONTROL_PLANE_FACT',     true,  false, false, false, false),
  ('JUDGMENT_DECIDED',              'DECISION',    'OWNER',    'OWNER_DECISION',             'OWNER_DECISION',         true,  true,  false, false, true),
  ('JUDGMENT_SIGNAL_OBSERVED',      'OBSERVATION', 'AGENT',    'AGENT_COLLECTOR',            'CLAIM_ONLY',             false, true,  false, false, false),
  ('BLOCKER_EPISODE_OBSERVED',      'OBSERVATION', 'AGENT',    'AGENT_COLLECTOR',            'CLAIM_ONLY',             false, true,  false, false, false),
  ('PROJECT_ATTENTION_OBSERVED',    'OBSERVATION', 'AGENT',    'AGENT_COLLECTOR',            'CLAIM_ONLY',             false, true,  false, false, false),
  ('DISPATCH_LEASE_OBSERVED',       'OBSERVATION', 'AGENT',    'AGENT_COLLECTOR',            'CLAIM_ONLY',             false, true,  false, false, false),
  ('MERGE_RECEIPT_RECORDED',        'RECEIPT',     'SYSTEM',   'TARGET_REPOSITORY_VERIFIER', 'REPOSITORY_ATTESTATION', true,  true,  false, true,  false),
  ('ACCEPTANCE_REVISION_RECORDED',  'ATTESTATION', 'SYSTEM',   'ORBIT_CONTROL_PLANE',        'CONTROL_PLANE_FACT',     true,  false, false, false, false),
  ('TIMER_SCHEDULED',               'INTENT',      'SYSTEM',   'ORBIT_CONTROL_PLANE',        'CONTROL_PLANE_FACT',     true,  false, false, false, false),
  ('TIMER_FIRED',                   'RECEIPT',     'SYSTEM',   'ORBIT_CONTROL_PLANE',        'CONTROL_PLANE_FACT',     true,  false, false, false, false),
  ('TIMER_CANCELLED',               'INVALIDATION','SYSTEM',   'ORBIT_CONTROL_PLANE',        'CONTROL_PLANE_FACT',     true,  false, false, false, false),
  ('ACTION_INTENT_RECORDED',        'INTENT',      'SYSTEM',   'ORBIT_CONTROL_PLANE',        'CONTROL_PLANE_FACT',     true,  false, false, false, false),
  ('ACTION_RECEIPT_RECORDED',       'RECEIPT',     'PROVIDER', 'ACTION_PROVIDER',            'PROVIDER_RECEIPT',       true,  true,  false, false, false),
  ('OBLIGATION_EXIT_RECORDED',      'INVALIDATION','SYSTEM',   'OUTCOME_EVALUATOR',          'EVALUATOR_FACT',         true,  false, false, false, false),
  ('CROSSING_HANDOFF_RECORDED',     'DECISION',    'OWNER',    'OWNER_DECISION',             'OWNER_DECISION',         true,  true,  false, false, true);

CREATE TABLE outcome_fact_authority_grant (
  tenant_id uuid NOT NULL,
  project_id uuid NOT NULL,
  grant_id uuid NOT NULL,
  grant_digest char(64) NOT NULL CHECK (outcome_valid_digest(grant_digest)),
  scope_digest char(64) NOT NULL CHECK (outcome_valid_digest(scope_digest)),
  delegation_chain_digest char(64) NOT NULL CHECK (outcome_valid_digest(delegation_chain_digest)),
  principal_type text NOT NULL,
  principal_id text NOT NULL CHECK (principal_id <> ''),
  fact_kind text NOT NULL,
  claim_type text NOT NULL,
  source_system text NOT NULL,
  collector_id text NOT NULL CHECK (collector_id <> ''),
  collector_version text NOT NULL CHECK (collector_version <> ''),
  signature_key_id text,
  valid_from_logical_time bigint NOT NULL CHECK (valid_from_logical_time >= 0),
  valid_through_logical_time bigint CHECK (
    valid_through_logical_time IS NULL OR valid_through_logical_time >= valid_from_logical_time
  ),
  risk_policy_digest char(64) NOT NULL CHECK (outcome_valid_digest(risk_policy_digest)),
  registered_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, project_id, grant_id),
  UNIQUE (tenant_id, project_id, grant_digest),
  FOREIGN KEY (tenant_id, project_id) REFERENCES outcome_fact_stream(tenant_id, project_id),
  FOREIGN KEY (fact_kind, claim_type, principal_type, source_system)
    REFERENCES outcome_fact_authority_matrix(fact_kind, claim_type, principal_type, source_system)
);

CREATE TABLE outcome_fact_authority_revocation (
  tenant_id uuid NOT NULL,
  project_id uuid NOT NULL,
  grant_id uuid NOT NULL,
  revoked_at_logical_time bigint NOT NULL CHECK (revoked_at_logical_time > 0),
  reason_digest char(64) NOT NULL CHECK (outcome_valid_digest(reason_digest)),
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, project_id, grant_id),
  FOREIGN KEY (tenant_id, project_id, grant_id)
    REFERENCES outcome_fact_authority_grant(tenant_id, project_id, grant_id)
);

CREATE TABLE outcome_canonical_fact (
  fact_id uuid NOT NULL,
  tenant_id uuid NOT NULL,
  project_id uuid NOT NULL,
  subject_type text NOT NULL,
  subject_id text NOT NULL,
  fact_kind text NOT NULL,
  claim_type text NOT NULL,
  principal_type text NOT NULL,
  principal_id text NOT NULL,
  source_system text NOT NULL,
  grant_id uuid NOT NULL,
  binding_digest char(64) NOT NULL CHECK (outcome_valid_digest(binding_digest)),
  schema_version integer NOT NULL CHECK (schema_version > 0),
  schema_digest char(64) NOT NULL CHECK (outcome_valid_digest(schema_digest)),
  payload jsonb NOT NULL,
  payload_digest char(64) NOT NULL CHECK (outcome_valid_digest(payload_digest)),
  observed_at timestamptz NOT NULL,
  recorded_at timestamptz NOT NULL,
  logical_time bigint NOT NULL CHECK (logical_time > 0),
  causal_predecessor_fact_id uuid,
  idempotency_key text NOT NULL CHECK (idempotency_key <> ''),
  request_digest char(64) NOT NULL CHECK (outcome_valid_digest(request_digest)),
  trust_class text NOT NULL,
  proof_eligible boolean NOT NULL,
  envelope jsonb NOT NULL,
  envelope_digest char(64) NOT NULL CHECK (outcome_valid_digest(envelope_digest)),
  PRIMARY KEY (fact_id),
  UNIQUE (tenant_id, project_id, fact_id),
  UNIQUE (tenant_id, project_id, logical_time),
  UNIQUE (tenant_id, project_id, idempotency_key),
  FOREIGN KEY (tenant_id, project_id) REFERENCES outcome_fact_stream(tenant_id, project_id),
  FOREIGN KEY (tenant_id, project_id, binding_digest)
    REFERENCES outcome_fact_binding(tenant_id, project_id, binding_digest),
  FOREIGN KEY (tenant_id, project_id, grant_id)
    REFERENCES outcome_fact_authority_grant(tenant_id, project_id, grant_id),
  FOREIGN KEY (fact_kind, claim_type, principal_type, source_system)
    REFERENCES outcome_fact_authority_matrix(fact_kind, claim_type, principal_type, source_system),
  FOREIGN KEY (tenant_id, project_id, causal_predecessor_fact_id)
    REFERENCES outcome_canonical_fact(tenant_id, project_id, fact_id),
  CHECK (payload_digest = outcome_sha256_json(payload)),
  CHECK (envelope_digest = outcome_sha256_json(envelope))
);

CREATE INDEX outcome_canonical_fact_cut_idx
  ON outcome_canonical_fact (tenant_id, project_id, binding_digest, logical_time, fact_id);
CREATE INDEX outcome_canonical_fact_subject_idx
  ON outcome_canonical_fact (tenant_id, project_id, subject_type, subject_id, logical_time DESC);

CREATE TABLE outcome_evaluation_cut (
  cut_id uuid NOT NULL,
  tenant_id uuid NOT NULL,
  project_id uuid NOT NULL,
  binding_digest char(64) NOT NULL CHECK (outcome_valid_digest(binding_digest)),
  watermark_logical_time bigint NOT NULL CHECK (watermark_logical_time >= 0),
  fact_count integer NOT NULL CHECK (fact_count >= 0),
  proof_fact_count integer NOT NULL CHECK (proof_fact_count >= 0 AND proof_fact_count <= fact_count),
  fact_set_digest char(64) NOT NULL CHECK (outcome_valid_digest(fact_set_digest)),
  opened_at timestamptz NOT NULL,
  sealed_at timestamptz NOT NULL CHECK (sealed_at >= opened_at),
  complete boolean NOT NULL CHECK (complete),
  linearizable boolean NOT NULL CHECK (linearizable),
  collector_version text NOT NULL CHECK (collector_version <> ''),
  idempotency_key text NOT NULL CHECK (idempotency_key <> ''),
  request_digest char(64) NOT NULL CHECK (outcome_valid_digest(request_digest)),
  cut_envelope jsonb NOT NULL,
  PRIMARY KEY (cut_id),
  UNIQUE (tenant_id, project_id, cut_id),
  UNIQUE (tenant_id, project_id, idempotency_key),
  FOREIGN KEY (tenant_id, project_id) REFERENCES outcome_fact_stream(tenant_id, project_id),
  FOREIGN KEY (tenant_id, project_id, binding_digest)
    REFERENCES outcome_fact_binding(tenant_id, project_id, binding_digest)
);

CREATE TABLE outcome_evaluation_cut_fact (
  tenant_id uuid NOT NULL,
  project_id uuid NOT NULL,
  cut_id uuid NOT NULL,
  fact_id uuid NOT NULL,
  ordinal integer NOT NULL CHECK (ordinal > 0),
  logical_time bigint NOT NULL CHECK (logical_time > 0),
  trust_decision text NOT NULL CHECK (trust_decision IN ('TRUSTED', 'CLAIM_ONLY', 'REVOKED')),
  proof_eligible boolean NOT NULL,
  envelope_digest char(64) NOT NULL CHECK (outcome_valid_digest(envelope_digest)),
  PRIMARY KEY (tenant_id, project_id, cut_id, fact_id),
  UNIQUE (tenant_id, project_id, cut_id, ordinal),
  FOREIGN KEY (tenant_id, project_id, cut_id)
    REFERENCES outcome_evaluation_cut(tenant_id, project_id, cut_id),
  FOREIGN KEY (tenant_id, project_id, fact_id)
    REFERENCES outcome_canonical_fact(tenant_id, project_id, fact_id)
);

CREATE TABLE outcome_evaluation_projection (
  tenant_id uuid NOT NULL,
  project_id uuid NOT NULL,
  subject_type text NOT NULL,
  subject_id text NOT NULL,
  binding_digest char(64) NOT NULL CHECK (outcome_valid_digest(binding_digest)),
  cut_id uuid NOT NULL,
  watermark_logical_time bigint NOT NULL CHECK (watermark_logical_time >= 0),
  projection jsonb NOT NULL,
  projection_digest char(64) NOT NULL CHECK (outcome_valid_digest(projection_digest)),
  is_closed boolean NOT NULL,
  projection_revision bigint NOT NULL CHECK (projection_revision > 0),
  written_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, project_id, subject_type, subject_id),
  FOREIGN KEY (tenant_id, project_id, cut_id)
    REFERENCES outcome_evaluation_cut(tenant_id, project_id, cut_id)
);

CREATE TRIGGER outcome_fact_binding_append_only
  BEFORE UPDATE OR DELETE ON outcome_fact_binding
  FOR EACH ROW EXECUTE FUNCTION outcome_append_only_guard();
CREATE TRIGGER outcome_fact_authority_matrix_append_only
  BEFORE UPDATE OR DELETE ON outcome_fact_authority_matrix
  FOR EACH ROW EXECUTE FUNCTION outcome_append_only_guard();
CREATE TRIGGER outcome_fact_authority_grant_append_only
  BEFORE UPDATE OR DELETE ON outcome_fact_authority_grant
  FOR EACH ROW EXECUTE FUNCTION outcome_append_only_guard();
CREATE TRIGGER outcome_fact_authority_revocation_append_only
  BEFORE UPDATE OR DELETE ON outcome_fact_authority_revocation
  FOR EACH ROW EXECUTE FUNCTION outcome_append_only_guard();
CREATE TRIGGER outcome_canonical_fact_append_only
  BEFORE UPDATE OR DELETE ON outcome_canonical_fact
  FOR EACH ROW EXECUTE FUNCTION outcome_append_only_guard();
CREATE TRIGGER outcome_evaluation_cut_append_only
  BEFORE UPDATE OR DELETE ON outcome_evaluation_cut
  FOR EACH ROW EXECUTE FUNCTION outcome_append_only_guard();
CREATE TRIGGER outcome_evaluation_cut_fact_append_only
  BEFORE UPDATE OR DELETE ON outcome_evaluation_cut_fact
  FOR EACH ROW EXECUTE FUNCTION outcome_append_only_guard();

CREATE OR REPLACE FUNCTION outcome_register_fact_binding(
  p_authenticated_tenant uuid,
  p_project_id uuid,
  p_binding jsonb
) RETURNS jsonb AS $$
DECLARE
  digest_value text;
  current_digest text;
  next_epoch bigint;
  expected_keys constant text[] := ARRAY[
    'tenantId', 'projectId', 'subjectType', 'subjectId', 'goalId', 'goalRevision',
    'contractDigest', 'evaluationPlanDigest', 'policyDigest', 'riskPolicyDigest',
    'permissionDigest', 'authorityGrantDigest', 'budgetDigest', 'capabilityRegistryDigest',
    'recipientDigest', 'evaluatorDigest', 'factSchemaDigest', 'environmentDigest',
    'artifactDigest', 'targetDigest', 'targetRef', 'asOfLogicalTime', 'factCutDigest'
  ];
BEGIN
  IF NOT outcome_jsonb_exact_keys(p_binding, expected_keys) THEN
    RAISE EXCEPTION 'OUTCOME_BINDING_SHAPE_INVALID' USING ERRCODE = '22023';
  END IF;
  IF (p_binding->>'tenantId')::uuid IS DISTINCT FROM p_authenticated_tenant
     OR (p_binding->>'projectId')::uuid IS DISTINCT FROM p_project_id THEN
    RAISE EXCEPTION 'OUTCOME_BINDING_SCOPE_MISMATCH' USING ERRCODE = '42501';
  END IF;
  IF p_binding->>'subjectType' = '' OR p_binding->>'subjectId' = ''
     OR p_binding->>'goalId' = '' OR p_binding->>'targetRef' = ''
     OR p_binding->>'goalRevision' !~ '^(0|[1-9][0-9]*)$'
     OR p_binding->>'asOfLogicalTime' !~ '^(0|[1-9][0-9]*)$' THEN
    RAISE EXCEPTION 'OUTCOME_BINDING_VALUE_INVALID' USING ERRCODE = '22023';
  END IF;
  IF EXISTS (
    SELECT 1
      FROM jsonb_each_text(p_binding) AS field(key, value)
     WHERE field.key LIKE '%Digest' AND NOT COALESCE(outcome_valid_digest(field.value), false)
  ) THEN
    RAISE EXCEPTION 'OUTCOME_BINDING_DIGEST_INVALID' USING ERRCODE = '22023';
  END IF;

  digest_value := outcome_sha256_json(p_binding);
  INSERT INTO outcome_fact_stream (tenant_id, project_id)
  VALUES (p_authenticated_tenant, p_project_id)
  ON CONFLICT DO NOTHING;
  PERFORM 1 FROM outcome_fact_stream
   WHERE tenant_id = p_authenticated_tenant AND project_id = p_project_id
   FOR UPDATE;

  SELECT binding_digest::text
    INTO current_digest
    FROM outcome_fact_binding
   WHERE tenant_id = p_authenticated_tenant AND project_id = p_project_id
   ORDER BY binding_epoch DESC
   LIMIT 1;
  IF current_digest = digest_value THEN
    SELECT binding_epoch INTO next_epoch
      FROM outcome_fact_binding
     WHERE tenant_id = p_authenticated_tenant AND project_id = p_project_id
       AND binding_digest = digest_value;
    RETURN jsonb_build_object('bindingDigest', digest_value, 'bindingEpoch', next_epoch::text);
  END IF;
  IF EXISTS (
    SELECT 1 FROM outcome_fact_binding
     WHERE tenant_id = p_authenticated_tenant AND project_id = p_project_id
       AND binding_digest = digest_value
  ) THEN
    RAISE EXCEPTION 'OUTCOME_STALE_BINDING_CANNOT_REACTIVATE' USING ERRCODE = 'P0001';
  END IF;

  UPDATE outcome_fact_stream
     SET binding_epoch = binding_epoch + 1, updated_at = clock_timestamp()
   WHERE tenant_id = p_authenticated_tenant AND project_id = p_project_id
   RETURNING binding_epoch INTO next_epoch;
  INSERT INTO outcome_fact_binding (
    tenant_id, project_id, binding_digest, binding_epoch, subject_type, subject_id,
    goal_id, goal_revision, risk_policy_digest, fact_schema_digest, target_digest,
    target_ref, binding
  ) VALUES (
    p_authenticated_tenant, p_project_id, digest_value, next_epoch,
    p_binding->>'subjectType', p_binding->>'subjectId', p_binding->>'goalId',
    (p_binding->>'goalRevision')::bigint, p_binding->>'riskPolicyDigest',
    p_binding->>'factSchemaDigest', p_binding->>'targetDigest', p_binding->>'targetRef',
    p_binding
  );
  RETURN jsonb_build_object('bindingDigest', digest_value, 'bindingEpoch', next_epoch::text);
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION outcome_register_authority_grant(
  p_authenticated_tenant uuid,
  p_project_id uuid,
  p_grant_id uuid,
  p_principal_type text,
  p_principal_id text,
  p_fact_kind text,
  p_claim_type text,
  p_source_system text,
  p_collector_id text,
  p_collector_version text,
  p_signature_key_id text,
  p_valid_from_logical_time bigint,
  p_valid_through_logical_time bigint,
  p_risk_policy_digest text
) RETURNS jsonb AS $$
DECLARE
  lane outcome_fact_authority_matrix%ROWTYPE;
  scope_digest_value text;
  delegation_digest_value text;
  grant_digest_value text;
  authority_value jsonb;
BEGIN
  IF p_principal_id = '' OR p_collector_id = '' OR p_collector_version = ''
     OR p_valid_from_logical_time < 0
     OR (p_valid_through_logical_time IS NOT NULL
         AND p_valid_through_logical_time < p_valid_from_logical_time)
     OR NOT COALESCE(outcome_valid_digest(p_risk_policy_digest), false) THEN
    RAISE EXCEPTION 'OUTCOME_AUTHORITY_GRANT_INVALID' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO lane
    FROM outcome_fact_authority_matrix
   WHERE fact_kind = p_fact_kind AND claim_type = p_claim_type
     AND principal_type = p_principal_type AND source_system = p_source_system;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'OUTCOME_AUTHORITY_LANE_REFUSED' USING ERRCODE = '42501';
  END IF;
  IF lane.signature_required AND COALESCE(p_signature_key_id, '') = '' THEN
    RAISE EXCEPTION 'OUTCOME_AUTHORITY_SIGNATURE_KEY_REQUIRED' USING ERRCODE = '22023';
  END IF;

  INSERT INTO outcome_fact_stream (tenant_id, project_id)
  VALUES (p_authenticated_tenant, p_project_id)
  ON CONFLICT DO NOTHING;
  PERFORM 1 FROM outcome_fact_stream
   WHERE tenant_id = p_authenticated_tenant AND project_id = p_project_id
   FOR UPDATE;

  scope_digest_value := outcome_sha256_json(jsonb_build_object(
    'tenantId', p_authenticated_tenant::text,
    'projectId', p_project_id::text,
    'principalType', p_principal_type,
    'principalId', p_principal_id,
    'factKind', p_fact_kind,
    'claimType', p_claim_type,
    'sourceSystem', p_source_system
  ));
  delegation_digest_value := outcome_sha256_json('[]'::jsonb);
  grant_digest_value := outcome_sha256_json(jsonb_build_object(
    'grantId', p_grant_id::text,
    'scopeDigest', scope_digest_value,
    'delegationChainDigest', delegation_digest_value,
    'collectorId', p_collector_id,
    'collectorVersion', p_collector_version,
    'signatureKeyId', p_signature_key_id,
    'validFromLogicalTime', p_valid_from_logical_time::text,
    'validThroughLogicalTime', CASE WHEN p_valid_through_logical_time IS NULL
      THEN NULL ELSE to_jsonb(p_valid_through_logical_time::text) END,
    'riskPolicyDigest', p_risk_policy_digest
  ));
  INSERT INTO outcome_fact_authority_grant (
    tenant_id, project_id, grant_id, grant_digest, scope_digest, delegation_chain_digest,
    principal_type, principal_id, fact_kind, claim_type, source_system, collector_id,
    collector_version, signature_key_id, valid_from_logical_time,
    valid_through_logical_time, risk_policy_digest
  ) VALUES (
    p_authenticated_tenant, p_project_id, p_grant_id, grant_digest_value,
    scope_digest_value, delegation_digest_value, p_principal_type, p_principal_id,
    p_fact_kind, p_claim_type, p_source_system, p_collector_id, p_collector_version,
    p_signature_key_id, p_valid_from_logical_time, p_valid_through_logical_time,
    p_risk_policy_digest
  );
  authority_value := jsonb_build_object(
    'grantId', p_grant_id::text,
    'grantDigest', grant_digest_value,
    'scopeDigest', scope_digest_value,
    'delegationChainDigest', delegation_digest_value,
    'validFromLogicalTime', p_valid_from_logical_time::text,
    'validThroughLogicalTime', CASE WHEN p_valid_through_logical_time IS NULL
      THEN NULL ELSE to_jsonb(p_valid_through_logical_time::text) END,
    'revokedAtLogicalTime', NULL
  );
  RETURN authority_value;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION outcome_revoke_authority_grant(
  p_authenticated_tenant uuid,
  p_project_id uuid,
  p_grant_id uuid,
  p_reason_digest text
) RETURNS bigint AS $$
DECLARE
  revoked_time bigint;
BEGIN
  IF NOT COALESCE(outcome_valid_digest(p_reason_digest), false) THEN
    RAISE EXCEPTION 'OUTCOME_REVOCATION_REASON_DIGEST_INVALID' USING ERRCODE = '22023';
  END IF;
  PERFORM 1 FROM outcome_fact_authority_grant
   WHERE tenant_id = p_authenticated_tenant AND project_id = p_project_id
     AND grant_id = p_grant_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'OUTCOME_AUTHORITY_GRANT_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;
  PERFORM 1 FROM outcome_fact_stream
   WHERE tenant_id = p_authenticated_tenant AND project_id = p_project_id
   FOR UPDATE;
  UPDATE outcome_fact_stream
     SET last_logical_time = last_logical_time + 1, updated_at = clock_timestamp()
   WHERE tenant_id = p_authenticated_tenant AND project_id = p_project_id
   RETURNING last_logical_time INTO revoked_time;
  INSERT INTO outcome_fact_authority_revocation (
    tenant_id, project_id, grant_id, revoked_at_logical_time, reason_digest
  ) VALUES (
    p_authenticated_tenant, p_project_id, p_grant_id, revoked_time, p_reason_digest
  );
  RETURN revoked_time;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION outcome_ingest_canonical_fact(
  p_authenticated_tenant uuid,
  p_authenticated_principal_type text,
  p_authenticated_principal_id text,
  p_draft jsonb
) RETURNS jsonb AS $$
DECLARE
  draft_keys constant text[] := ARRAY[
    'factKind', 'tenantId', 'subject', 'binding', 'schemaVersion', 'schemaDigest',
    'payload', 'payloadDigest', 'claimType', 'principal', 'authority', 'observedAt',
    'causalPredecessorFactId', 'idempotencyKey', 'source', 'signature'
  ];
  subject_keys constant text[] := ARRAY['type', 'id', 'projectId'];
  principal_keys constant text[] := ARRAY['type', 'id'];
  authority_keys constant text[] := ARRAY[
    'grantId', 'grantDigest', 'scopeDigest', 'delegationChainDigest',
    'validFromLogicalTime', 'validThroughLogicalTime', 'revokedAtLogicalTime'
  ];
  source_keys constant text[] := ARRAY['system', 'collectorId', 'collectorVersion'];
  signature_keys constant text[] := ARRAY['algorithm', 'keyId', 'value'];
  project_value uuid;
  binding_digest_value text;
  current_binding outcome_fact_binding%ROWTYPE;
  grant_value outcome_fact_authority_grant%ROWTYPE;
  lane outcome_fact_authority_matrix%ROWTYPE;
  revoked_time bigint;
  next_time bigint;
  request_digest_value text;
  existing_request_digest text;
  existing_envelope jsonb;
  expected_authority jsonb;
  fact_id_value uuid;
  recorded_time timestamptz;
  envelope_value jsonb;
  envelope_digest_value text;
  proof_value boolean;
  predecessor_time bigint;
BEGIN
  IF NOT outcome_jsonb_exact_keys(p_draft, draft_keys)
     OR NOT outcome_jsonb_exact_keys(p_draft->'subject', subject_keys)
     OR NOT outcome_jsonb_exact_keys(p_draft->'principal', principal_keys)
     OR NOT outcome_jsonb_exact_keys(p_draft->'authority', authority_keys)
     OR NOT outcome_jsonb_exact_keys(p_draft->'source', source_keys)
     OR (p_draft->'signature' <> 'null'::jsonb
         AND NOT outcome_jsonb_exact_keys(p_draft->'signature', signature_keys)) THEN
    RAISE EXCEPTION 'OUTCOME_FACT_DRAFT_SHAPE_INVALID' USING ERRCODE = '22023';
  END IF;
  IF (p_draft->>'tenantId')::uuid IS DISTINCT FROM p_authenticated_tenant
     OR p_draft->'binding'->>'tenantId' IS DISTINCT FROM p_draft->>'tenantId' THEN
    RAISE EXCEPTION 'OUTCOME_FACT_TENANT_MISMATCH' USING ERRCODE = '42501';
  END IF;
  project_value := (p_draft->'binding'->>'projectId')::uuid;
  IF (p_draft->'subject'->>'projectId')::uuid IS DISTINCT FROM project_value
     OR p_draft->'subject'->>'type' IS DISTINCT FROM p_draft->'binding'->>'subjectType'
     OR p_draft->'subject'->>'id' IS DISTINCT FROM p_draft->'binding'->>'subjectId' THEN
    RAISE EXCEPTION 'OUTCOME_FACT_SUBJECT_BINDING_MISMATCH' USING ERRCODE = '42501';
  END IF;
  IF p_draft->'principal'->>'type' IS DISTINCT FROM p_authenticated_principal_type
     OR p_draft->'principal'->>'id' IS DISTINCT FROM p_authenticated_principal_id THEN
    RAISE EXCEPTION 'OUTCOME_FACT_PRINCIPAL_FORGED' USING ERRCODE = '42501';
  END IF;
  IF p_draft->>'schemaVersion' !~ '^[1-9][0-9]*$'
     OR NOT COALESCE(outcome_valid_digest(p_draft->>'schemaDigest'), false)
     OR NOT COALESCE(outcome_valid_digest(p_draft->>'payloadDigest'), false)
     OR COALESCE(p_draft->>'idempotencyKey', '') = ''
     OR COALESCE(p_draft->'source'->>'system', '') = ''
     OR p_draft->'source'->>'system' LIKE 'PROJECTION:%' THEN
    RAISE EXCEPTION 'OUTCOME_FACT_DRAFT_VALUE_INVALID' USING ERRCODE = '22023';
  END IF;
  IF outcome_sha256_json(p_draft->'payload') <> p_draft->>'payloadDigest' THEN
    RAISE EXCEPTION 'OUTCOME_FACT_PAYLOAD_DIGEST_MISMATCH' USING ERRCODE = '22000';
  END IF;
  PERFORM (p_draft->>'observedAt')::timestamptz;

  binding_digest_value := outcome_sha256_json(p_draft->'binding');
  request_digest_value := outcome_sha256_json(p_draft);
  INSERT INTO outcome_fact_stream (tenant_id, project_id)
  VALUES (p_authenticated_tenant, project_value)
  ON CONFLICT DO NOTHING;
  PERFORM 1 FROM outcome_fact_stream
   WHERE tenant_id = p_authenticated_tenant AND project_id = project_value
   FOR UPDATE;

  SELECT request_digest::text, envelope
    INTO existing_request_digest, existing_envelope
    FROM outcome_canonical_fact
   WHERE tenant_id = p_authenticated_tenant AND project_id = project_value
     AND idempotency_key = p_draft->>'idempotencyKey';
  IF FOUND THEN
    IF existing_request_digest <> request_digest_value THEN
      RAISE EXCEPTION 'OUTCOME_FACT_IDEMPOTENCY_KEY_REUSED' USING ERRCODE = '23505';
    END IF;
    RETURN existing_envelope;
  END IF;

  SELECT * INTO current_binding
    FROM outcome_fact_binding
   WHERE tenant_id = p_authenticated_tenant AND project_id = project_value
   ORDER BY binding_epoch DESC LIMIT 1;
  IF NOT FOUND OR current_binding.binding_digest::text <> binding_digest_value
     OR current_binding.binding <> p_draft->'binding' THEN
    RAISE EXCEPTION 'OUTCOME_FACT_BINDING_STALE' USING ERRCODE = 'P0001';
  END IF;
  IF p_draft->>'schemaDigest' IS DISTINCT FROM current_binding.fact_schema_digest::text THEN
    RAISE EXCEPTION 'OUTCOME_FACT_SCHEMA_STALE' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO lane
    FROM outcome_fact_authority_matrix
   WHERE fact_kind = p_draft->>'factKind'
     AND claim_type = p_draft->>'claimType'
     AND principal_type = p_draft->'principal'->>'type'
     AND source_system = p_draft->'source'->>'system';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'OUTCOME_FACT_AUTHORITY_LANE_REFUSED' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO grant_value
    FROM outcome_fact_authority_grant
   WHERE tenant_id = p_authenticated_tenant AND project_id = project_value
     AND grant_id = (p_draft->'authority'->>'grantId')::uuid;
  IF NOT FOUND
     OR grant_value.principal_type IS DISTINCT FROM p_authenticated_principal_type
     OR grant_value.principal_id IS DISTINCT FROM p_authenticated_principal_id
     OR grant_value.fact_kind IS DISTINCT FROM p_draft->>'factKind'
     OR grant_value.claim_type IS DISTINCT FROM p_draft->>'claimType'
     OR grant_value.source_system IS DISTINCT FROM p_draft->'source'->>'system' THEN
    RAISE EXCEPTION 'OUTCOME_FACT_AUTHORITY_FORGED' USING ERRCODE = '42501';
  END IF;
  SELECT revoked_at_logical_time INTO revoked_time
    FROM outcome_fact_authority_revocation
   WHERE tenant_id = p_authenticated_tenant AND project_id = project_value
     AND grant_id = grant_value.grant_id;
  expected_authority := jsonb_build_object(
    'grantId', grant_value.grant_id::text,
    'grantDigest', grant_value.grant_digest::text,
    'scopeDigest', grant_value.scope_digest::text,
    'delegationChainDigest', grant_value.delegation_chain_digest::text,
    'validFromLogicalTime', grant_value.valid_from_logical_time::text,
    'validThroughLogicalTime', CASE WHEN grant_value.valid_through_logical_time IS NULL
      THEN NULL ELSE to_jsonb(grant_value.valid_through_logical_time::text) END,
    'revokedAtLogicalTime', CASE WHEN revoked_time IS NULL
      THEN NULL ELSE to_jsonb(revoked_time::text) END
  );
  IF p_draft->'authority' <> expected_authority
     OR grant_value.grant_digest::text <> p_draft->'binding'->>'authorityGrantDigest' THEN
    RAISE EXCEPTION 'OUTCOME_FACT_AUTHORITY_FORGED' USING ERRCODE = '42501';
  END IF;

  SELECT last_logical_time + 1 INTO next_time
    FROM outcome_fact_stream
   WHERE tenant_id = p_authenticated_tenant AND project_id = project_value;
  IF next_time < grant_value.valid_from_logical_time
     OR (grant_value.valid_through_logical_time IS NOT NULL
         AND next_time > grant_value.valid_through_logical_time)
     OR (revoked_time IS NOT NULL AND next_time >= revoked_time) THEN
    RAISE EXCEPTION 'OUTCOME_FACT_AUTHORITY_NOT_CURRENT' USING ERRCODE = '42501';
  END IF;
  IF lane.requires_current_threat_model AND (
    grant_value.risk_policy_digest::text IS DISTINCT FROM current_binding.risk_policy_digest::text
    OR p_draft->'payload'->>'riskPolicyDigest' IS DISTINCT FROM current_binding.risk_policy_digest::text
    OR p_draft->'payload'->>'threatModelDigest' IS DISTINCT FROM current_binding.risk_policy_digest::text
  ) THEN
    RAISE EXCEPTION 'OUTCOME_OWNER_DECISION_THREAT_MODEL_STALE' USING ERRCODE = '42501';
  END IF;
  IF lane.requires_controlled_runner_exit AND (
    COALESCE(p_draft->'payload'->>'exitCode' !~ '^(0|[1-9][0-9]*)$', true)
    OR NOT COALESCE(outcome_valid_digest(p_draft->'payload'->>'commandDigest'), false)
    OR NOT COALESCE(outcome_valid_digest(p_draft->'payload'->>'executionReceiptDigest'), false)
  ) THEN
    RAISE EXCEPTION 'OUTCOME_RUNNER_EXIT_RECEIPT_INVALID' USING ERRCODE = '22023';
  END IF;
  IF lane.requires_target_repository_verification AND (
    p_draft->'payload'->>'targetRepositoryDigest' IS DISTINCT FROM current_binding.target_digest::text
    OR p_draft->'payload'->>'targetRef' IS DISTINCT FROM current_binding.target_ref
    OR p_draft->'payload'->>'targetPresenceVerified' IS DISTINCT FROM 'true'
    OR NOT COALESCE(outcome_valid_digest(p_draft->'payload'->>'verificationReceiptDigest'), false)
  ) THEN
    RAISE EXCEPTION 'OUTCOME_MERGE_TARGET_NOT_REVERIFIED' USING ERRCODE = '22023';
  END IF;
  IF p_draft->'source'->>'collectorId' IS DISTINCT FROM grant_value.collector_id
     OR p_draft->'source'->>'collectorVersion' IS DISTINCT FROM grant_value.collector_version THEN
    RAISE EXCEPTION 'OUTCOME_FACT_SOURCE_FORGED' USING ERRCODE = '42501';
  END IF;
  IF lane.signature_required AND (
    p_draft->'signature' = 'null'::jsonb
    OR p_draft->'signature'->>'keyId' IS DISTINCT FROM grant_value.signature_key_id
    OR COALESCE(p_draft->'signature'->>'algorithm', '') = ''
    OR COALESCE(p_draft->'signature'->>'value', '') = ''
  ) THEN
    RAISE EXCEPTION 'OUTCOME_FACT_SIGNATURE_INVALID' USING ERRCODE = '42501';
  END IF;

  IF p_draft->'causalPredecessorFactId' <> 'null'::jsonb THEN
    SELECT logical_time INTO predecessor_time
      FROM outcome_canonical_fact
     WHERE tenant_id = p_authenticated_tenant AND project_id = project_value
       AND fact_id = (p_draft->>'causalPredecessorFactId')::uuid;
    IF NOT FOUND OR predecessor_time >= next_time THEN
      RAISE EXCEPTION 'OUTCOME_FACT_CAUSAL_PREDECESSOR_INVALID' USING ERRCODE = '23503';
    END IF;
  END IF;

  fact_id_value := gen_random_uuid();
  recorded_time := clock_timestamp();
  proof_value := lane.proof_eligible AND lane.trust_class <> 'CLAIM_ONLY';
  envelope_value := jsonb_build_object(
    'factId', fact_id_value::text,
    'factKind', p_draft->>'factKind',
    'tenantId', p_authenticated_tenant::text,
    'subject', p_draft->'subject',
    'binding', p_draft->'binding',
    'schemaVersion', (p_draft->>'schemaVersion')::integer,
    'schemaDigest', p_draft->>'schemaDigest',
    'payload', p_draft->'payload',
    'payloadDigest', p_draft->>'payloadDigest',
    'claimType', p_draft->>'claimType',
    'principal', p_draft->'principal',
    'authority', expected_authority,
    'observedAt', p_draft->>'observedAt',
    'recordedAt', recorded_time,
    'logicalTime', next_time::text,
    'causalPredecessorFactId', p_draft->'causalPredecessorFactId',
    'idempotencyKey', p_draft->>'idempotencyKey',
    'source', p_draft->'source',
    'signature', p_draft->'signature'
  );
  envelope_digest_value := outcome_sha256_json(envelope_value);
  INSERT INTO outcome_canonical_fact (
    fact_id, tenant_id, project_id, subject_type, subject_id, fact_kind, claim_type,
    principal_type, principal_id, source_system, grant_id, binding_digest,
    schema_version, schema_digest, payload, payload_digest, observed_at, recorded_at,
    logical_time, causal_predecessor_fact_id, idempotency_key, request_digest,
    trust_class, proof_eligible, envelope, envelope_digest
  ) VALUES (
    fact_id_value, p_authenticated_tenant, project_value, p_draft->'subject'->>'type',
    p_draft->'subject'->>'id', p_draft->>'factKind', p_draft->>'claimType',
    p_authenticated_principal_type, p_authenticated_principal_id,
    p_draft->'source'->>'system', grant_value.grant_id, binding_digest_value,
    (p_draft->>'schemaVersion')::integer, p_draft->>'schemaDigest', p_draft->'payload',
    p_draft->>'payloadDigest', (p_draft->>'observedAt')::timestamptz, recorded_time,
    next_time, CASE WHEN p_draft->'causalPredecessorFactId' = 'null'::jsonb THEN NULL
      ELSE (p_draft->>'causalPredecessorFactId')::uuid END,
    p_draft->>'idempotencyKey', request_digest_value, lane.trust_class, proof_value,
    envelope_value, envelope_digest_value
  );
  UPDATE outcome_fact_stream
     SET last_logical_time = next_time, updated_at = clock_timestamp()
   WHERE tenant_id = p_authenticated_tenant AND project_id = project_value;
  RETURN envelope_value;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION outcome_seal_evaluation_cut(
  p_authenticated_tenant uuid,
  p_project_id uuid,
  p_binding_digest text,
  p_idempotency_key text,
  p_collector_version text
) RETURNS jsonb AS $$
DECLARE
  current_digest text;
  watermark bigint;
  request_digest_value text;
  existing_request_digest text;
  existing_cut jsonb;
  facts_value jsonb;
  fact_ids_value uuid[];
  fact_count_value integer;
  proof_count_value integer;
  fact_set_digest_value text;
  cut_id_value uuid;
  opened_time timestamptz;
  sealed_time timestamptz;
  cut_value jsonb;
BEGIN
  IF NOT COALESCE(outcome_valid_digest(p_binding_digest), false) OR COALESCE(p_idempotency_key, '') = ''
     OR COALESCE(p_collector_version, '') = '' THEN
    RAISE EXCEPTION 'OUTCOME_EVALUATION_CUT_REQUEST_INVALID' USING ERRCODE = '22023';
  END IF;
  request_digest_value := outcome_sha256_json(jsonb_build_object(
    'tenantId', p_authenticated_tenant::text,
    'projectId', p_project_id::text,
    'bindingDigest', p_binding_digest,
    'idempotencyKey', p_idempotency_key,
    'collectorVersion', p_collector_version
  ));
  INSERT INTO outcome_fact_stream (tenant_id, project_id)
  VALUES (p_authenticated_tenant, p_project_id)
  ON CONFLICT DO NOTHING;
  PERFORM 1 FROM outcome_fact_stream
   WHERE tenant_id = p_authenticated_tenant AND project_id = p_project_id
   FOR UPDATE;

  SELECT request_digest::text, cut_envelope
    INTO existing_request_digest, existing_cut
    FROM outcome_evaluation_cut
   WHERE tenant_id = p_authenticated_tenant AND project_id = p_project_id
     AND idempotency_key = p_idempotency_key;
  IF FOUND THEN
    IF existing_request_digest <> request_digest_value THEN
      RAISE EXCEPTION 'OUTCOME_CUT_IDEMPOTENCY_KEY_REUSED' USING ERRCODE = '23505';
    END IF;
    RETURN existing_cut;
  END IF;

  SELECT binding_digest::text INTO current_digest
    FROM outcome_fact_binding
   WHERE tenant_id = p_authenticated_tenant AND project_id = p_project_id
   ORDER BY binding_epoch DESC LIMIT 1;
  IF current_digest IS NULL OR current_digest <> p_binding_digest THEN
    RAISE EXCEPTION 'OUTCOME_EVALUATION_CUT_BINDING_STALE' USING ERRCODE = 'P0001';
  END IF;
  SELECT last_logical_time INTO watermark
    FROM outcome_fact_stream
   WHERE tenant_id = p_authenticated_tenant AND project_id = p_project_id;

  SELECT COALESCE(jsonb_agg(f.envelope ORDER BY f.logical_time, f.fact_id), '[]'::jsonb),
         COALESCE(array_agg(f.fact_id ORDER BY f.logical_time, f.fact_id), ARRAY[]::uuid[]),
         count(*)::integer,
         count(*) FILTER (
           WHERE f.proof_eligible
             AND NOT EXISTS (
               SELECT 1 FROM outcome_fact_authority_revocation r
                WHERE r.tenant_id = f.tenant_id AND r.project_id = f.project_id
                  AND r.grant_id = f.grant_id
                  AND r.revoked_at_logical_time <= watermark
             )
         )::integer
    INTO facts_value, fact_ids_value, fact_count_value, proof_count_value
    FROM outcome_canonical_fact f
   WHERE f.tenant_id = p_authenticated_tenant AND f.project_id = p_project_id
     AND f.binding_digest = p_binding_digest AND f.logical_time <= watermark;
  fact_set_digest_value := outcome_sha256_json(facts_value);
  cut_id_value := gen_random_uuid();
  opened_time := clock_timestamp();
  sealed_time := clock_timestamp();
  cut_value := jsonb_build_object(
    'cutId', cut_id_value::text,
    'tenantId', p_authenticated_tenant::text,
    'projectId', p_project_id::text,
    'watermarkLogicalTime', watermark::text,
    'factIds', to_jsonb(fact_ids_value),
    'factCount', fact_count_value,
    'factSetDigest', fact_set_digest_value,
    'openedAt', opened_time,
    'sealedAt', sealed_time,
    'complete', true,
    'linearizable', true,
    'collectorVersion', p_collector_version
  );
  INSERT INTO outcome_evaluation_cut (
    cut_id, tenant_id, project_id, binding_digest, watermark_logical_time, fact_count,
    proof_fact_count, fact_set_digest, opened_at, sealed_at, complete, linearizable,
    collector_version, idempotency_key, request_digest, cut_envelope
  ) VALUES (
    cut_id_value, p_authenticated_tenant, p_project_id, p_binding_digest, watermark,
    fact_count_value, proof_count_value, fact_set_digest_value, opened_time, sealed_time,
    true, true, p_collector_version, p_idempotency_key, request_digest_value, cut_value
  );
  INSERT INTO outcome_evaluation_cut_fact (
    tenant_id, project_id, cut_id, fact_id, ordinal, logical_time, trust_decision,
    proof_eligible, envelope_digest
  )
  SELECT f.tenant_id, f.project_id, cut_id_value, f.fact_id,
         row_number() OVER (ORDER BY f.logical_time, f.fact_id)::integer,
         f.logical_time,
         CASE
           WHEN EXISTS (
             SELECT 1 FROM outcome_fact_authority_revocation r
              WHERE r.tenant_id = f.tenant_id AND r.project_id = f.project_id
                AND r.grant_id = f.grant_id AND r.revoked_at_logical_time <= watermark
           ) THEN 'REVOKED'
           WHEN f.trust_class = 'CLAIM_ONLY' THEN 'CLAIM_ONLY'
           ELSE 'TRUSTED'
         END,
         f.proof_eligible AND NOT EXISTS (
           SELECT 1 FROM outcome_fact_authority_revocation r
            WHERE r.tenant_id = f.tenant_id AND r.project_id = f.project_id
              AND r.grant_id = f.grant_id AND r.revoked_at_logical_time <= watermark
         ),
         f.envelope_digest
    FROM outcome_canonical_fact f
   WHERE f.tenant_id = p_authenticated_tenant AND f.project_id = p_project_id
     AND f.binding_digest = p_binding_digest AND f.logical_time <= watermark
   ORDER BY f.logical_time, f.fact_id;
  RETURN cut_value;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION outcome_replay_fact_set_digest(
  p_authenticated_tenant uuid,
  p_cut_id uuid
) RETURNS text AS $$
  SELECT outcome_sha256_json(COALESCE(jsonb_agg(f.envelope ORDER BY cf.ordinal), '[]'::jsonb))
    FROM outcome_evaluation_cut c
    LEFT JOIN outcome_evaluation_cut_fact cf
      ON cf.tenant_id = c.tenant_id AND cf.project_id = c.project_id AND cf.cut_id = c.cut_id
    LEFT JOIN outcome_canonical_fact f
      ON f.tenant_id = cf.tenant_id AND f.project_id = cf.project_id AND f.fact_id = cf.fact_id
   WHERE c.tenant_id = p_authenticated_tenant AND c.cut_id = p_cut_id
   GROUP BY c.cut_id
$$ LANGUAGE sql STABLE;

CREATE OR REPLACE FUNCTION outcome_read_evaluation_cut(
  p_authenticated_tenant uuid,
  p_cut_id uuid,
  p_proof_only boolean DEFAULT false
) RETURNS TABLE (
  ordinal integer,
  trust_decision text,
  proof_eligible boolean,
  envelope jsonb
) AS $$
  SELECT cf.ordinal, cf.trust_decision, cf.proof_eligible, f.envelope
    FROM outcome_evaluation_cut c
    JOIN outcome_evaluation_cut_fact cf
      ON cf.tenant_id = c.tenant_id AND cf.project_id = c.project_id AND cf.cut_id = c.cut_id
    JOIN outcome_canonical_fact f
      ON f.tenant_id = cf.tenant_id AND f.project_id = cf.project_id AND f.fact_id = cf.fact_id
   WHERE c.tenant_id = p_authenticated_tenant AND c.cut_id = p_cut_id
     AND (NOT p_proof_only OR cf.proof_eligible)
   ORDER BY cf.ordinal
$$ LANGUAGE sql STABLE;

CREATE OR REPLACE FUNCTION outcome_publish_evaluation_projection(
  p_authenticated_tenant uuid,
  p_project_id uuid,
  p_subject_type text,
  p_subject_id text,
  p_cut_id uuid,
  p_projection jsonb,
  p_is_closed boolean
) RETURNS jsonb AS $$
DECLARE
  cut_value outcome_evaluation_cut%ROWTYPE;
  stream_head bigint;
  current_binding_digest text;
  digest_value text;
  revision_value bigint;
BEGIN
  PERFORM 1 FROM outcome_fact_stream
   WHERE tenant_id = p_authenticated_tenant AND project_id = p_project_id
   FOR UPDATE;
  SELECT * INTO cut_value
    FROM outcome_evaluation_cut
   WHERE tenant_id = p_authenticated_tenant AND project_id = p_project_id
     AND cut_id = p_cut_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'OUTCOME_EVALUATION_CUT_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;
  SELECT last_logical_time INTO stream_head
    FROM outcome_fact_stream
   WHERE tenant_id = p_authenticated_tenant AND project_id = p_project_id;
  SELECT binding_digest::text INTO current_binding_digest
    FROM outcome_fact_binding
   WHERE tenant_id = p_authenticated_tenant AND project_id = p_project_id
   ORDER BY binding_epoch DESC LIMIT 1;
  IF cut_value.watermark_logical_time <> stream_head
     OR cut_value.binding_digest::text <> current_binding_digest THEN
    RAISE EXCEPTION 'OUTCOME_EVALUATION_CUT_STALE' USING ERRCODE = '40001';
  END IF;
  digest_value := outcome_sha256_json(p_projection);
  INSERT INTO outcome_evaluation_projection (
    tenant_id, project_id, subject_type, subject_id, binding_digest, cut_id,
    watermark_logical_time, projection, projection_digest, is_closed, projection_revision
  ) VALUES (
    p_authenticated_tenant, p_project_id, p_subject_type, p_subject_id,
    cut_value.binding_digest, cut_value.cut_id, cut_value.watermark_logical_time,
    p_projection, digest_value, p_is_closed, 1
  )
  ON CONFLICT (tenant_id, project_id, subject_type, subject_id) DO UPDATE
    SET binding_digest = EXCLUDED.binding_digest,
        cut_id = EXCLUDED.cut_id,
        watermark_logical_time = EXCLUDED.watermark_logical_time,
        projection = EXCLUDED.projection,
        projection_digest = EXCLUDED.projection_digest,
        is_closed = EXCLUDED.is_closed,
        projection_revision = outcome_evaluation_projection.projection_revision + 1,
        written_at = clock_timestamp()
  RETURNING projection_revision INTO revision_value;
  RETURN jsonb_build_object(
    'projectionDigest', digest_value,
    'projectionRevision', revision_value::text,
    'watermarkLogicalTime', stream_head::text
  );
END;
$$ LANGUAGE plpgsql;

CREATE VIEW outcome_current_evaluation_projection AS
SELECT p.*,
       (p.projection_digest = outcome_sha256_json(p.projection)
        AND p.watermark_logical_time = s.last_logical_time
        AND p.binding_digest = current_binding.binding_digest) AS is_current,
       (p.is_closed
        AND p.projection_digest = outcome_sha256_json(p.projection)
        AND p.watermark_logical_time = s.last_logical_time
        AND p.binding_digest = current_binding.binding_digest) AS effective_closed
  FROM outcome_evaluation_projection p
  JOIN outcome_fact_stream s
    ON s.tenant_id = p.tenant_id AND s.project_id = p.project_id
  LEFT JOIN LATERAL (
    SELECT b.binding_digest
      FROM outcome_fact_binding b
     WHERE b.tenant_id = p.tenant_id AND b.project_id = p.project_id
     ORDER BY b.binding_epoch DESC LIMIT 1
  ) AS current_binding ON true;

REVOKE INSERT, UPDATE, DELETE ON outcome_fact_binding FROM PUBLIC;
REVOKE INSERT, UPDATE, DELETE ON outcome_fact_authority_matrix FROM PUBLIC;
REVOKE INSERT, UPDATE, DELETE ON outcome_fact_authority_grant FROM PUBLIC;
REVOKE INSERT, UPDATE, DELETE ON outcome_fact_authority_revocation FROM PUBLIC;
REVOKE INSERT, UPDATE, DELETE ON outcome_canonical_fact FROM PUBLIC;
REVOKE INSERT, UPDATE, DELETE ON outcome_evaluation_cut FROM PUBLIC;
REVOKE INSERT, UPDATE, DELETE ON outcome_evaluation_cut_fact FROM PUBLIC;

COMMENT ON TABLE outcome_canonical_fact IS
  'Append-only canonical facts. recorded_at/logical_time/fact_id are allocated by outcome_ingest_canonical_fact.';
COMMENT ON TABLE outcome_evaluation_cut IS
  'Immutable linearizable watermark sealed under the same stream lock used by canonical fact append.';
COMMENT ON TABLE outcome_evaluation_projection IS
  'Mutable, rebuildable output only; never an evaluator or replay input.';
COMMENT ON VIEW outcome_current_evaluation_projection IS
  'Projection freshness is derived from canonical stream head and current binding; effective_closed fails closed.';

COMMIT;
