-- First-class integration obligation evidence. A task/worktree result is intentionally absent:
-- only a repository-bound provider attestation and a clean rerun of the exact target SHA enter
-- this ledger. Target advances create a binding revision while preserving the stable delivery
-- binding, which is what makes EVER_DELIVERED and CURRENT_TARGET_CONTAINS different policies.
BEGIN;

CREATE TABLE outcome_delivery_binding (
  delivery_binding_id uuid PRIMARY KEY,
  binding_sequence bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  tenant_id uuid NOT NULL,
  project_id uuid NOT NULL,
  goal_id text NOT NULL CHECK (goal_id <> ''),
  goal_revision bigint NOT NULL CHECK (goal_revision >= 0),
  canonical_binding_digest char(64) NOT NULL CHECK (outcome_valid_digest(canonical_binding_digest)),
  delivery_binding_digest char(64) NOT NULL CHECK (outcome_valid_digest(delivery_binding_digest)),
  binding_revision_digest char(64) NOT NULL CHECK (outcome_valid_digest(binding_revision_digest)),
  policy_mode text NOT NULL CHECK (policy_mode IN ('EVER_DELIVERED', 'CURRENT_TARGET_CONTAINS')),
  repository_provider text NOT NULL CHECK (repository_provider <> ''),
  repository_id text NOT NULL CHECK (repository_id <> ''),
  repository_digest char(64) NOT NULL CHECK (outcome_valid_digest(repository_digest)),
  target_ref text NOT NULL CHECK (target_ref <> ''),
  current_target_sha text NOT NULL CHECK (current_target_sha ~ '^(?:[0-9a-f]{40}|[0-9a-f]{64})$'),
  current_target_content_digest char(64) NOT NULL CHECK (outcome_valid_digest(current_target_content_digest)),
  artifact_digest char(64) NOT NULL CHECK (outcome_valid_digest(artifact_digest)),
  evaluation_plan_digest char(64) NOT NULL CHECK (outcome_valid_digest(evaluation_plan_digest)),
  acceptance_command_digest char(64) NOT NULL CHECK (outcome_valid_digest(acceptance_command_digest)),
  integration_provider_identity text NOT NULL CHECK (integration_provider_identity <> ''),
  verification_provider_identity text NOT NULL CHECK (verification_provider_identity <> ''),
  as_of_logical_time bigint NOT NULL CHECK (as_of_logical_time >= 0),
  idempotency_key text NOT NULL CHECK (idempotency_key <> ''),
  request_digest char(64) NOT NULL CHECK (outcome_valid_digest(request_digest)),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (tenant_id, project_id, binding_revision_digest),
  UNIQUE (tenant_id, project_id, idempotency_key),
  FOREIGN KEY (tenant_id, project_id, canonical_binding_digest)
    REFERENCES outcome_fact_binding(tenant_id, project_id, binding_digest)
);

CREATE INDEX outcome_delivery_binding_current_idx
  ON outcome_delivery_binding (tenant_id, project_id, delivery_binding_digest, binding_sequence DESC);

CREATE TABLE outcome_delivery_attestation (
  attestation_id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  project_id uuid NOT NULL,
  delivery_binding_digest char(64) NOT NULL CHECK (outcome_valid_digest(delivery_binding_digest)),
  binding_revision_digest char(64) NOT NULL CHECK (outcome_valid_digest(binding_revision_digest)),
  provider_receipt_id text NOT NULL CHECK (provider_receipt_id <> ''),
  provider_identity text NOT NULL CHECK (provider_identity <> ''),
  repository_provider text NOT NULL CHECK (repository_provider <> ''),
  repository_id text NOT NULL CHECK (repository_id <> ''),
  repository_digest char(64) NOT NULL CHECK (outcome_valid_digest(repository_digest)),
  target_ref text NOT NULL CHECK (target_ref <> ''),
  target_sha text NOT NULL CHECK (target_sha ~ '^(?:[0-9a-f]{40}|[0-9a-f]{64})$'),
  target_content_digest char(64) NOT NULL CHECK (outcome_valid_digest(target_content_digest)),
  artifact_digest char(64) NOT NULL CHECK (outcome_valid_digest(artifact_digest)),
  result text NOT NULL CHECK (result IN (
    'INTEGRATED', 'ALREADY_INTEGRATED', 'CONFLICT', 'FAILED', 'PARTIAL_EFFECT',
    'EFFECT_RECONCILED'
  )),
  external_effect_state text NOT NULL CHECK (external_effect_state IN ('NONE', 'PARTIAL', 'UNKNOWN')),
  verified_at timestamptz NOT NULL,
  verified_logical_time bigint NOT NULL CHECK (verified_logical_time >= 0),
  idempotency_key text NOT NULL CHECK (idempotency_key <> ''),
  receipt jsonb NOT NULL,
  receipt_digest char(64) NOT NULL CHECK (outcome_valid_digest(receipt_digest)),
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (tenant_id, project_id, provider_identity, provider_receipt_id),
  UNIQUE (tenant_id, project_id, idempotency_key),
  FOREIGN KEY (tenant_id, project_id, binding_revision_digest)
    REFERENCES outcome_delivery_binding(tenant_id, project_id, binding_revision_digest)
);

CREATE INDEX outcome_delivery_attestation_binding_idx
  ON outcome_delivery_attestation (
    tenant_id, project_id, delivery_binding_digest, verified_logical_time DESC, attestation_id
  );

CREATE TABLE outcome_delivery_verification (
  verification_id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  project_id uuid NOT NULL,
  delivery_binding_digest char(64) NOT NULL CHECK (outcome_valid_digest(delivery_binding_digest)),
  binding_revision_digest char(64) NOT NULL CHECK (outcome_valid_digest(binding_revision_digest)),
  provider_receipt_id text NOT NULL CHECK (provider_receipt_id <> ''),
  provider_identity text NOT NULL CHECK (provider_identity <> ''),
  repository_digest char(64) NOT NULL CHECK (outcome_valid_digest(repository_digest)),
  target_ref text NOT NULL CHECK (target_ref <> ''),
  target_sha text NOT NULL CHECK (target_sha ~ '^(?:[0-9a-f]{40}|[0-9a-f]{64})$'),
  target_content_digest char(64) NOT NULL CHECK (outcome_valid_digest(target_content_digest)),
  artifact_digest char(64) NOT NULL CHECK (outcome_valid_digest(artifact_digest)),
  evaluation_plan_digest char(64) NOT NULL CHECK (outcome_valid_digest(evaluation_plan_digest)),
  acceptance_command_digest char(64) NOT NULL CHECK (outcome_valid_digest(acceptance_command_digest)),
  environment text NOT NULL CHECK (environment = 'CLEAN_TARGET_SHA'),
  result text NOT NULL CHECK (result IN ('PASS', 'FAIL', 'ERROR')),
  exit_code integer NOT NULL,
  skip_count integer NOT NULL CHECK (skip_count >= 0),
  verified_at timestamptz NOT NULL,
  verified_logical_time bigint NOT NULL CHECK (verified_logical_time >= 0),
  idempotency_key text NOT NULL CHECK (idempotency_key <> ''),
  receipt jsonb NOT NULL,
  receipt_digest char(64) NOT NULL CHECK (outcome_valid_digest(receipt_digest)),
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (tenant_id, project_id, provider_identity, provider_receipt_id),
  UNIQUE (tenant_id, project_id, idempotency_key),
  FOREIGN KEY (tenant_id, project_id, binding_revision_digest)
    REFERENCES outcome_delivery_binding(tenant_id, project_id, binding_revision_digest),
  CHECK (result <> 'PASS' OR (exit_code = 0 AND skip_count = 0))
);

CREATE INDEX outcome_delivery_verification_binding_idx
  ON outcome_delivery_verification (
    tenant_id, project_id, delivery_binding_digest, verified_logical_time DESC, verification_id
  );

CREATE TRIGGER outcome_delivery_binding_append_only
  BEFORE UPDATE OR DELETE ON outcome_delivery_binding
  FOR EACH ROW EXECUTE FUNCTION outcome_append_only_guard();
CREATE TRIGGER outcome_delivery_attestation_append_only
  BEFORE UPDATE OR DELETE ON outcome_delivery_attestation
  FOR EACH ROW EXECUTE FUNCTION outcome_append_only_guard();
CREATE TRIGGER outcome_delivery_verification_append_only
  BEFORE UPDATE OR DELETE ON outcome_delivery_verification
  FOR EACH ROW EXECUTE FUNCTION outcome_append_only_guard();

CREATE OR REPLACE FUNCTION outcome_register_delivery_binding(
  p_authenticated_tenant uuid,
  p_project_id uuid,
  p_spec jsonb
) RETURNS jsonb AS $$
DECLARE
  expected_keys constant text[] := ARRAY[
    'schemaVersion', 'goalId', 'goalRevision', 'canonicalBindingDigest', 'policyMode',
    'repositoryProvider', 'repositoryId', 'repositoryDigest', 'targetRef',
    'currentTargetSha', 'currentTargetContentDigest', 'artifactDigest',
    'evaluationPlanDigest', 'acceptanceCommandDigest', 'integrationProviderIdentity',
    'verificationProviderIdentity', 'asOfLogicalTime', 'idempotencyKey'
  ];
  canonical_binding outcome_fact_binding%ROWTYPE;
  current_canonical_digest text;
  stable_material jsonb;
  stable_digest text;
  revision_digest text;
  request_digest_value text;
  existing outcome_delivery_binding%ROWTYPE;
  binding_id uuid;
BEGIN
  IF NOT outcome_jsonb_exact_keys(p_spec, expected_keys)
     OR p_spec->>'schemaVersion' <> '1'
     OR p_spec->>'policyMode' NOT IN ('EVER_DELIVERED', 'CURRENT_TARGET_CONTAINS')
     OR COALESCE(p_spec->>'goalId', '') = ''
     OR COALESCE(p_spec->>'repositoryProvider', '') = ''
     OR COALESCE(p_spec->>'repositoryId', '') = ''
     OR COALESCE(p_spec->>'targetRef', '') = ''
     OR COALESCE(p_spec->>'integrationProviderIdentity', '') = ''
     OR COALESCE(p_spec->>'verificationProviderIdentity', '') = ''
     OR p_spec->>'goalRevision' !~ '^(0|[1-9][0-9]*)$'
     OR p_spec->>'asOfLogicalTime' !~ '^(0|[1-9][0-9]*)$'
     OR p_spec->>'currentTargetSha' !~ '^(?:[0-9a-f]{40}|[0-9a-f]{64})$'
     OR COALESCE(p_spec->>'idempotencyKey', '') = '' THEN
    RAISE EXCEPTION 'OUTCOME_DELIVERY_BINDING_SHAPE_INVALID' USING ERRCODE = '22023';
  END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_each_text(p_spec) field
     WHERE field.key LIKE '%Digest' AND NOT COALESCE(outcome_valid_digest(field.value), false)
  ) THEN
    RAISE EXCEPTION 'OUTCOME_DELIVERY_BINDING_DIGEST_INVALID' USING ERRCODE = '22023';
  END IF;

  SELECT binding_digest::text INTO current_canonical_digest
    FROM outcome_fact_binding
   WHERE tenant_id = p_authenticated_tenant AND project_id = p_project_id
   ORDER BY binding_epoch DESC LIMIT 1;
  SELECT * INTO canonical_binding
    FROM outcome_fact_binding
   WHERE tenant_id = p_authenticated_tenant AND project_id = p_project_id
     AND binding_digest = p_spec->>'canonicalBindingDigest';
  IF NOT FOUND OR current_canonical_digest IS DISTINCT FROM p_spec->>'canonicalBindingDigest' THEN
    RAISE EXCEPTION 'OUTCOME_DELIVERY_CANONICAL_BINDING_NOT_CURRENT' USING ERRCODE = '40001';
  END IF;
  IF canonical_binding.goal_id IS DISTINCT FROM p_spec->>'goalId'
     OR canonical_binding.goal_revision IS DISTINCT FROM (p_spec->>'goalRevision')::bigint
     OR canonical_binding.target_ref IS DISTINCT FROM p_spec->>'targetRef'
     OR canonical_binding.target_digest::text IS DISTINCT FROM p_spec->>'repositoryDigest'
     OR canonical_binding.binding->>'artifactDigest' IS DISTINCT FROM p_spec->>'artifactDigest'
     OR canonical_binding.binding->>'evaluationPlanDigest' IS DISTINCT FROM p_spec->>'evaluationPlanDigest' THEN
    RAISE EXCEPTION 'OUTCOME_DELIVERY_REQUIREMENT_CANONICAL_MISMATCH' USING ERRCODE = '42501';
  END IF;

  stable_material := jsonb_build_object(
    'namespace', 'orbit.delivery-binding.v1',
    'schemaVersion', 1,
    'tenantId', p_authenticated_tenant::text,
    'projectId', p_project_id::text,
    'goalId', p_spec->>'goalId',
    'goalRevision', p_spec->>'goalRevision',
    'canonicalBindingDigest', p_spec->>'canonicalBindingDigest',
    'policyMode', p_spec->>'policyMode',
    'repositoryProvider', p_spec->>'repositoryProvider',
    'repositoryId', p_spec->>'repositoryId',
    'repositoryDigest', p_spec->>'repositoryDigest',
    'targetRef', p_spec->>'targetRef',
    'artifactDigest', p_spec->>'artifactDigest',
    'evaluationPlanDigest', p_spec->>'evaluationPlanDigest',
    'acceptanceCommandDigest', p_spec->>'acceptanceCommandDigest',
    'integrationProviderIdentity', p_spec->>'integrationProviderIdentity',
    'verificationProviderIdentity', p_spec->>'verificationProviderIdentity'
  );
  stable_digest := outcome_sha256_json(stable_material);
  revision_digest := outcome_sha256_json(jsonb_build_object(
    'namespace', 'orbit.delivery-binding-revision.v1',
    'deliveryBindingDigest', stable_digest,
    'currentTargetSha', p_spec->>'currentTargetSha',
    'currentTargetContentDigest', p_spec->>'currentTargetContentDigest',
    'asOfLogicalTime', p_spec->>'asOfLogicalTime'
  ));
  request_digest_value := outcome_sha256_json(p_spec);

  SELECT * INTO existing FROM outcome_delivery_binding
   WHERE tenant_id = p_authenticated_tenant AND project_id = p_project_id
     AND idempotency_key = p_spec->>'idempotencyKey';
  IF FOUND THEN
    IF existing.request_digest::text IS DISTINCT FROM request_digest_value THEN
      RAISE EXCEPTION 'OUTCOME_DELIVERY_BINDING_IDEMPOTENCY_CONFLICT' USING ERRCODE = '23505';
    END IF;
    RETURN jsonb_build_object(
      'deliveryBindingId', existing.delivery_binding_id::text,
      'deliveryBindingDigest', existing.delivery_binding_digest::text,
      'bindingRevisionDigest', existing.binding_revision_digest::text,
      'replayed', true
    );
  END IF;
  SELECT * INTO existing FROM outcome_delivery_binding
   WHERE tenant_id = p_authenticated_tenant AND project_id = p_project_id
     AND binding_revision_digest = revision_digest;
  IF FOUND THEN
    RETURN jsonb_build_object(
      'deliveryBindingId', existing.delivery_binding_id::text,
      'deliveryBindingDigest', existing.delivery_binding_digest::text,
      'bindingRevisionDigest', existing.binding_revision_digest::text,
      'replayed', true
    );
  END IF;

  binding_id := gen_random_uuid();
  INSERT INTO outcome_delivery_binding (
    delivery_binding_id, tenant_id, project_id, goal_id, goal_revision,
    canonical_binding_digest, delivery_binding_digest, binding_revision_digest,
    policy_mode, repository_provider, repository_id, repository_digest, target_ref,
    current_target_sha, current_target_content_digest, artifact_digest,
    evaluation_plan_digest, acceptance_command_digest, integration_provider_identity,
    verification_provider_identity, as_of_logical_time, idempotency_key, request_digest
  ) VALUES (
    binding_id, p_authenticated_tenant, p_project_id, p_spec->>'goalId',
    (p_spec->>'goalRevision')::bigint, p_spec->>'canonicalBindingDigest', stable_digest,
    revision_digest, p_spec->>'policyMode', p_spec->>'repositoryProvider',
    p_spec->>'repositoryId', p_spec->>'repositoryDigest', p_spec->>'targetRef',
    p_spec->>'currentTargetSha', p_spec->>'currentTargetContentDigest',
    p_spec->>'artifactDigest', p_spec->>'evaluationPlanDigest',
    p_spec->>'acceptanceCommandDigest', p_spec->>'integrationProviderIdentity',
    p_spec->>'verificationProviderIdentity', (p_spec->>'asOfLogicalTime')::bigint,
    p_spec->>'idempotencyKey', request_digest_value
  );
  RETURN jsonb_build_object(
    'deliveryBindingId', binding_id::text,
    'deliveryBindingDigest', stable_digest,
    'bindingRevisionDigest', revision_digest,
    'replayed', false
  );
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION outcome_record_delivery_attestation(
  p_authenticated_tenant uuid,
  p_project_id uuid,
  p_authenticated_provider_identity text,
  p_receipt jsonb
) RETURNS jsonb AS $$
DECLARE
  expected_keys constant text[] := ARRAY[
    'schemaVersion', 'deliveryBindingDigest', 'bindingRevisionDigest',
    'providerReceiptId', 'providerIdentity',
    'repositoryProvider', 'repositoryId', 'repositoryDigest', 'targetRef', 'targetSha',
    'targetContentDigest', 'artifactDigest', 'result', 'externalEffectState', 'verifiedAt',
    'verifiedLogicalTime', 'idempotencyKey'
  ];
  requirement outcome_delivery_binding%ROWTYPE;
  receipt_digest_value text;
  existing outcome_delivery_attestation%ROWTYPE;
  attestation_id_value uuid;
BEGIN
  IF NOT outcome_jsonb_exact_keys(p_receipt, expected_keys)
     OR p_receipt->>'schemaVersion' <> '1'
     OR p_receipt->>'result' NOT IN (
       'INTEGRATED', 'ALREADY_INTEGRATED', 'CONFLICT', 'FAILED', 'PARTIAL_EFFECT',
       'EFFECT_RECONCILED'
     )
     OR p_receipt->>'externalEffectState' NOT IN ('NONE', 'PARTIAL', 'UNKNOWN')
     OR p_receipt->>'targetSha' !~ '^(?:[0-9a-f]{40}|[0-9a-f]{64})$'
     OR p_receipt->>'verifiedLogicalTime' !~ '^(0|[1-9][0-9]*)$'
     OR COALESCE(p_receipt->>'providerReceiptId', '') = ''
     OR COALESCE(p_receipt->>'providerIdentity', '') = ''
     OR COALESCE(p_authenticated_provider_identity, '') = ''
     OR COALESCE(p_receipt->>'idempotencyKey', '') = '' THEN
    RAISE EXCEPTION 'OUTCOME_DELIVERY_ATTESTATION_SHAPE_INVALID' USING ERRCODE = '22023';
  END IF;
  IF p_authenticated_provider_identity IS DISTINCT FROM p_receipt->>'providerIdentity' THEN
    RAISE EXCEPTION 'OUTCOME_DELIVERY_PROVIDER_AUTH_MISMATCH' USING ERRCODE = '42501';
  END IF;
  IF NOT COALESCE(outcome_valid_digest(p_receipt->>'deliveryBindingDigest'), false)
     OR NOT COALESCE(outcome_valid_digest(p_receipt->>'bindingRevisionDigest'), false)
     OR NOT COALESCE(outcome_valid_digest(p_receipt->>'repositoryDigest'), false)
     OR NOT COALESCE(outcome_valid_digest(p_receipt->>'targetContentDigest'), false)
     OR NOT COALESCE(outcome_valid_digest(p_receipt->>'artifactDigest'), false) THEN
    RAISE EXCEPTION 'OUTCOME_DELIVERY_ATTESTATION_DIGEST_INVALID' USING ERRCODE = '22023';
  END IF;
  IF (p_receipt->>'result' = 'PARTIAL_EFFECT') IS DISTINCT FROM
     (p_receipt->>'externalEffectState' = 'PARTIAL') THEN
    RAISE EXCEPTION 'OUTCOME_DELIVERY_ATTESTATION_EFFECT_STATE_INVALID' USING ERRCODE = '22023';
  END IF;
  IF p_receipt->>'result' = 'EFFECT_RECONCILED'
     AND p_receipt->>'externalEffectState' <> 'NONE' THEN
    RAISE EXCEPTION 'OUTCOME_DELIVERY_ATTESTATION_EFFECT_STATE_INVALID' USING ERRCODE = '22023';
  END IF;
  PERFORM (p_receipt->>'verifiedAt')::timestamptz;
  receipt_digest_value := outcome_sha256_json(p_receipt);
  PERFORM pg_advisory_xact_lock(hashtextextended(concat_ws(
    E'\x1f', p_authenticated_tenant::text, p_project_id::text, 'delivery-attestation',
    p_authenticated_provider_identity, p_receipt->>'providerReceiptId'
  ), 0));

  SELECT * INTO existing FROM outcome_delivery_attestation
   WHERE tenant_id = p_authenticated_tenant AND project_id = p_project_id
     AND provider_identity = p_receipt->>'providerIdentity'
     AND provider_receipt_id = p_receipt->>'providerReceiptId';
  IF FOUND THEN
    IF existing.receipt_digest::text IS DISTINCT FROM receipt_digest_value THEN
      RAISE EXCEPTION 'OUTCOME_DELIVERY_PROVIDER_REPLAY_CONFLICT' USING ERRCODE = '23505';
    END IF;
    RETURN jsonb_build_object(
      'attestationId', existing.attestation_id::text,
      'receiptDigest', existing.receipt_digest::text,
      'replayed', true
    );
  END IF;
  SELECT * INTO existing FROM outcome_delivery_attestation
   WHERE tenant_id = p_authenticated_tenant AND project_id = p_project_id
     AND idempotency_key = p_receipt->>'idempotencyKey';
  IF FOUND THEN
    IF existing.receipt_digest::text IS DISTINCT FROM receipt_digest_value THEN
      RAISE EXCEPTION 'OUTCOME_DELIVERY_ATTESTATION_IDEMPOTENCY_CONFLICT' USING ERRCODE = '23505';
    END IF;
    RETURN jsonb_build_object(
      'attestationId', existing.attestation_id::text,
      'receiptDigest', existing.receipt_digest::text,
      'replayed', true
    );
  END IF;

  SELECT * INTO requirement FROM outcome_delivery_binding
   WHERE tenant_id = p_authenticated_tenant AND project_id = p_project_id
     AND delivery_binding_digest = p_receipt->>'deliveryBindingDigest'
   ORDER BY binding_sequence DESC LIMIT 1;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'OUTCOME_DELIVERY_BINDING_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;
  IF requirement.integration_provider_identity IS DISTINCT FROM p_receipt->>'providerIdentity'
     OR requirement.binding_revision_digest::text IS DISTINCT FROM p_receipt->>'bindingRevisionDigest'
     OR requirement.repository_provider IS DISTINCT FROM p_receipt->>'repositoryProvider'
     OR requirement.repository_id IS DISTINCT FROM p_receipt->>'repositoryId'
     OR requirement.repository_digest::text IS DISTINCT FROM p_receipt->>'repositoryDigest'
     OR requirement.target_ref IS DISTINCT FROM p_receipt->>'targetRef'
     OR requirement.current_target_sha IS DISTINCT FROM p_receipt->>'targetSha'
     OR requirement.current_target_content_digest::text IS DISTINCT FROM p_receipt->>'targetContentDigest'
     OR requirement.artifact_digest::text IS DISTINCT FROM p_receipt->>'artifactDigest' THEN
    RAISE EXCEPTION 'OUTCOME_DELIVERY_ATTESTATION_SCOPE_MISMATCH' USING ERRCODE = '42501';
  END IF;
  attestation_id_value := gen_random_uuid();
  INSERT INTO outcome_delivery_attestation (
    attestation_id, tenant_id, project_id, delivery_binding_digest, binding_revision_digest,
    provider_receipt_id,
    provider_identity, repository_provider, repository_id, repository_digest, target_ref,
    target_sha, target_content_digest, artifact_digest, result, external_effect_state,
    verified_at, verified_logical_time, idempotency_key, receipt, receipt_digest
  ) VALUES (
    attestation_id_value, p_authenticated_tenant, p_project_id,
    p_receipt->>'deliveryBindingDigest', p_receipt->>'bindingRevisionDigest',
    p_receipt->>'providerReceiptId',
    p_receipt->>'providerIdentity', p_receipt->>'repositoryProvider',
    p_receipt->>'repositoryId', p_receipt->>'repositoryDigest', p_receipt->>'targetRef',
    p_receipt->>'targetSha', p_receipt->>'targetContentDigest', p_receipt->>'artifactDigest',
    p_receipt->>'result', p_receipt->>'externalEffectState',
    (p_receipt->>'verifiedAt')::timestamptz,
    (p_receipt->>'verifiedLogicalTime')::bigint, p_receipt->>'idempotencyKey',
    p_receipt, receipt_digest_value
  );
  RETURN jsonb_build_object(
    'attestationId', attestation_id_value::text,
    'receiptDigest', receipt_digest_value,
    'replayed', false
  );
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION outcome_record_delivery_verification(
  p_authenticated_tenant uuid,
  p_project_id uuid,
  p_authenticated_provider_identity text,
  p_receipt jsonb
) RETURNS jsonb AS $$
DECLARE
  expected_keys constant text[] := ARRAY[
    'schemaVersion', 'deliveryBindingDigest', 'bindingRevisionDigest',
    'providerReceiptId', 'providerIdentity',
    'repositoryDigest', 'targetRef', 'targetSha', 'targetContentDigest', 'artifactDigest',
    'evaluationPlanDigest', 'acceptanceCommandDigest', 'environment', 'result', 'exitCode',
    'skipCount', 'verifiedAt', 'verifiedLogicalTime', 'idempotencyKey'
  ];
  requirement outcome_delivery_binding%ROWTYPE;
  matching_attestation outcome_delivery_attestation%ROWTYPE;
  receipt_digest_value text;
  existing outcome_delivery_verification%ROWTYPE;
  verification_id_value uuid;
BEGIN
  IF NOT outcome_jsonb_exact_keys(p_receipt, expected_keys)
     OR p_receipt->>'schemaVersion' <> '1'
     OR p_receipt->>'environment' <> 'CLEAN_TARGET_SHA'
     OR p_receipt->>'result' NOT IN ('PASS', 'FAIL', 'ERROR')
     OR p_receipt->>'targetSha' !~ '^(?:[0-9a-f]{40}|[0-9a-f]{64})$'
     OR p_receipt->>'verifiedLogicalTime' !~ '^(0|[1-9][0-9]*)$'
     OR p_receipt->>'exitCode' !~ '^-?[0-9]+$'
     OR p_receipt->>'skipCount' !~ '^(0|[1-9][0-9]*)$'
     OR COALESCE(p_receipt->>'providerReceiptId', '') = ''
     OR COALESCE(p_receipt->>'providerIdentity', '') = ''
     OR COALESCE(p_authenticated_provider_identity, '') = ''
     OR COALESCE(p_receipt->>'idempotencyKey', '') = '' THEN
    RAISE EXCEPTION 'OUTCOME_DELIVERY_VERIFICATION_SHAPE_INVALID' USING ERRCODE = '22023';
  END IF;
  IF p_authenticated_provider_identity IS DISTINCT FROM p_receipt->>'providerIdentity' THEN
    RAISE EXCEPTION 'OUTCOME_DELIVERY_PROVIDER_AUTH_MISMATCH' USING ERRCODE = '42501';
  END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_each_text(p_receipt) field
     WHERE field.key LIKE '%Digest' AND NOT COALESCE(outcome_valid_digest(field.value), false)
  ) THEN
    RAISE EXCEPTION 'OUTCOME_DELIVERY_VERIFICATION_DIGEST_INVALID' USING ERRCODE = '22023';
  END IF;
  IF p_receipt->>'result' = 'PASS' AND (
    (p_receipt->>'exitCode')::integer <> 0 OR (p_receipt->>'skipCount')::integer <> 0
  ) THEN
    RAISE EXCEPTION 'OUTCOME_DELIVERY_VERIFICATION_FALSE_PASS' USING ERRCODE = '23514';
  END IF;
  PERFORM (p_receipt->>'verifiedAt')::timestamptz;
  receipt_digest_value := outcome_sha256_json(p_receipt);
  PERFORM pg_advisory_xact_lock(hashtextextended(concat_ws(
    E'\x1f', p_authenticated_tenant::text, p_project_id::text, 'delivery-verification',
    p_authenticated_provider_identity, p_receipt->>'providerReceiptId'
  ), 0));

  SELECT * INTO existing FROM outcome_delivery_verification
   WHERE tenant_id = p_authenticated_tenant AND project_id = p_project_id
     AND provider_identity = p_receipt->>'providerIdentity'
     AND provider_receipt_id = p_receipt->>'providerReceiptId';
  IF FOUND THEN
    IF existing.receipt_digest::text IS DISTINCT FROM receipt_digest_value THEN
      RAISE EXCEPTION 'OUTCOME_DELIVERY_PROVIDER_REPLAY_CONFLICT' USING ERRCODE = '23505';
    END IF;
    RETURN jsonb_build_object(
      'verificationId', existing.verification_id::text,
      'receiptDigest', existing.receipt_digest::text,
      'replayed', true
    );
  END IF;
  SELECT * INTO existing FROM outcome_delivery_verification
   WHERE tenant_id = p_authenticated_tenant AND project_id = p_project_id
     AND idempotency_key = p_receipt->>'idempotencyKey';
  IF FOUND THEN
    IF existing.receipt_digest::text IS DISTINCT FROM receipt_digest_value THEN
      RAISE EXCEPTION 'OUTCOME_DELIVERY_VERIFICATION_IDEMPOTENCY_CONFLICT' USING ERRCODE = '23505';
    END IF;
    RETURN jsonb_build_object(
      'verificationId', existing.verification_id::text,
      'receiptDigest', existing.receipt_digest::text,
      'replayed', true
    );
  END IF;

  SELECT * INTO requirement FROM outcome_delivery_binding
   WHERE tenant_id = p_authenticated_tenant AND project_id = p_project_id
     AND delivery_binding_digest = p_receipt->>'deliveryBindingDigest'
   ORDER BY binding_sequence DESC LIMIT 1;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'OUTCOME_DELIVERY_BINDING_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;
  IF requirement.verification_provider_identity IS DISTINCT FROM p_receipt->>'providerIdentity'
     OR requirement.binding_revision_digest::text IS DISTINCT FROM p_receipt->>'bindingRevisionDigest'
     OR requirement.repository_digest::text IS DISTINCT FROM p_receipt->>'repositoryDigest'
     OR requirement.target_ref IS DISTINCT FROM p_receipt->>'targetRef'
     OR requirement.current_target_sha IS DISTINCT FROM p_receipt->>'targetSha'
     OR requirement.current_target_content_digest::text IS DISTINCT FROM p_receipt->>'targetContentDigest'
     OR requirement.artifact_digest::text IS DISTINCT FROM p_receipt->>'artifactDigest'
     OR requirement.evaluation_plan_digest::text IS DISTINCT FROM p_receipt->>'evaluationPlanDigest'
     OR requirement.acceptance_command_digest::text IS DISTINCT FROM p_receipt->>'acceptanceCommandDigest' THEN
    RAISE EXCEPTION 'OUTCOME_DELIVERY_VERIFICATION_SCOPE_MISMATCH' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO matching_attestation FROM outcome_delivery_attestation a
     WHERE a.tenant_id = p_authenticated_tenant AND a.project_id = p_project_id
       AND a.delivery_binding_digest = p_receipt->>'deliveryBindingDigest'
       AND a.binding_revision_digest = p_receipt->>'bindingRevisionDigest'
       AND a.target_sha = p_receipt->>'targetSha'
       AND a.target_content_digest::text = p_receipt->>'targetContentDigest'
       AND a.result IN ('INTEGRATED', 'ALREADY_INTEGRATED')
     ORDER BY a.verified_logical_time DESC, a.provider_receipt_id DESC LIMIT 1;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'OUTCOME_DELIVERY_VERIFICATION_WITHOUT_INTEGRATION' USING ERRCODE = '23503';
  END IF;
  IF matching_attestation.verified_logical_time > (p_receipt->>'verifiedLogicalTime')::bigint
     OR matching_attestation.verified_at > (p_receipt->>'verifiedAt')::timestamptz THEN
    RAISE EXCEPTION 'OUTCOME_DELIVERY_VERIFICATION_PRECEDES_INTEGRATION' USING ERRCODE = '22023';
  END IF;
  verification_id_value := gen_random_uuid();
  INSERT INTO outcome_delivery_verification (
    verification_id, tenant_id, project_id, delivery_binding_digest, binding_revision_digest,
    provider_receipt_id,
    provider_identity, repository_digest, target_ref, target_sha, target_content_digest,
    artifact_digest, evaluation_plan_digest, acceptance_command_digest, environment, result,
    exit_code, skip_count, verified_at, verified_logical_time, idempotency_key,
    receipt, receipt_digest
  ) VALUES (
    verification_id_value, p_authenticated_tenant, p_project_id,
    p_receipt->>'deliveryBindingDigest', p_receipt->>'bindingRevisionDigest',
    p_receipt->>'providerReceiptId',
    p_receipt->>'providerIdentity', p_receipt->>'repositoryDigest', p_receipt->>'targetRef',
    p_receipt->>'targetSha', p_receipt->>'targetContentDigest', p_receipt->>'artifactDigest',
    p_receipt->>'evaluationPlanDigest', p_receipt->>'acceptanceCommandDigest',
    p_receipt->>'environment', p_receipt->>'result', (p_receipt->>'exitCode')::integer,
    (p_receipt->>'skipCount')::integer, (p_receipt->>'verifiedAt')::timestamptz,
    (p_receipt->>'verifiedLogicalTime')::bigint, p_receipt->>'idempotencyKey',
    p_receipt, receipt_digest_value
  );
  RETURN jsonb_build_object(
    'verificationId', verification_id_value::text,
    'receiptDigest', receipt_digest_value,
    'replayed', false
  );
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION outcome_read_delivery_evidence(
  p_authenticated_tenant uuid,
  p_project_id uuid,
  p_delivery_binding_digest text
) RETURNS jsonb AS $$
DECLARE
  requirement outcome_delivery_binding%ROWTYPE;
  attestation_values jsonb;
  verification_values jsonb;
BEGIN
  SELECT * INTO requirement FROM outcome_delivery_binding
   WHERE tenant_id = p_authenticated_tenant AND project_id = p_project_id
     AND delivery_binding_digest = p_delivery_binding_digest
   ORDER BY binding_sequence DESC LIMIT 1;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'OUTCOME_DELIVERY_BINDING_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'schemaVersion', 1,
    'attestationId', a.attestation_id::text,
    'deliveryBindingDigest', a.delivery_binding_digest::text,
    'bindingRevisionDigest', a.binding_revision_digest::text,
    'providerReceiptId', a.provider_receipt_id,
    'providerIdentity', a.provider_identity,
    'repositoryProvider', a.repository_provider,
    'repositoryId', a.repository_id,
    'repositoryDigest', a.repository_digest::text,
    'targetRef', a.target_ref,
    'targetSha', a.target_sha,
    'targetContentDigest', a.target_content_digest::text,
    'artifactDigest', a.artifact_digest::text,
    'result', a.result,
    'externalEffectState', a.external_effect_state,
    'verifiedAt', to_char(a.verified_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'verifiedLogicalTime', a.verified_logical_time::text,
    'idempotencyKey', a.idempotency_key,
    'receiptDigest', a.receipt_digest::text
  ) ORDER BY a.verified_logical_time, a.provider_receipt_id), '[]'::jsonb)
    INTO attestation_values
    FROM outcome_delivery_attestation a
   WHERE a.tenant_id = p_authenticated_tenant AND a.project_id = p_project_id
     AND a.delivery_binding_digest = p_delivery_binding_digest;
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'schemaVersion', 1,
    'verificationId', v.verification_id::text,
    'deliveryBindingDigest', v.delivery_binding_digest::text,
    'bindingRevisionDigest', v.binding_revision_digest::text,
    'providerReceiptId', v.provider_receipt_id,
    'providerIdentity', v.provider_identity,
    'repositoryDigest', v.repository_digest::text,
    'targetRef', v.target_ref,
    'targetSha', v.target_sha,
    'targetContentDigest', v.target_content_digest::text,
    'artifactDigest', v.artifact_digest::text,
    'evaluationPlanDigest', v.evaluation_plan_digest::text,
    'acceptanceCommandDigest', v.acceptance_command_digest::text,
    'environment', v.environment,
    'result', v.result,
    'exitCode', v.exit_code,
    'skipCount', v.skip_count,
    'verifiedAt', to_char(v.verified_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'verifiedLogicalTime', v.verified_logical_time::text,
    'idempotencyKey', v.idempotency_key,
    'receiptDigest', v.receipt_digest::text
  ) ORDER BY v.verified_logical_time, v.provider_receipt_id), '[]'::jsonb)
    INTO verification_values
    FROM outcome_delivery_verification v
   WHERE v.tenant_id = p_authenticated_tenant AND v.project_id = p_project_id
     AND v.delivery_binding_digest = p_delivery_binding_digest;
  RETURN jsonb_build_object(
    'requirement', jsonb_build_object(
      'schemaVersion', 1,
      'tenantId', requirement.tenant_id::text,
      'projectId', requirement.project_id::text,
      'goalId', requirement.goal_id,
      'goalRevision', requirement.goal_revision::text,
      'canonicalBindingDigest', requirement.canonical_binding_digest::text,
      'deliveryBindingDigest', requirement.delivery_binding_digest::text,
      'bindingRevisionDigest', requirement.binding_revision_digest::text,
      'policyMode', requirement.policy_mode,
      'repositoryProvider', requirement.repository_provider,
      'repositoryId', requirement.repository_id,
      'repositoryDigest', requirement.repository_digest::text,
      'targetRef', requirement.target_ref,
      'currentTargetSha', requirement.current_target_sha,
      'currentTargetContentDigest', requirement.current_target_content_digest::text,
      'artifactDigest', requirement.artifact_digest::text,
      'evaluationPlanDigest', requirement.evaluation_plan_digest::text,
      'acceptanceCommandDigest', requirement.acceptance_command_digest::text,
      'integrationProviderIdentity', requirement.integration_provider_identity,
      'verificationProviderIdentity', requirement.verification_provider_identity,
      'asOfLogicalTime', requirement.as_of_logical_time::text
    ),
    'attestations', attestation_values,
    'verifications', verification_values
  );
END;
$$ LANGUAGE plpgsql STABLE;

REVOKE INSERT, UPDATE, DELETE ON outcome_delivery_binding FROM PUBLIC;
REVOKE INSERT, UPDATE, DELETE ON outcome_delivery_attestation FROM PUBLIC;
REVOKE INSERT, UPDATE, DELETE ON outcome_delivery_verification FROM PUBLIC;

COMMENT ON TABLE outcome_delivery_binding IS
  'Append-only delivery policy and current-target revisions bound to one canonical Outcome binding.';
COMMENT ON TABLE outcome_delivery_attestation IS
  'Trusted provider claims about one repository/ref/SHA/content/artifact; worktree exits never enter this table.';
COMMENT ON TABLE outcome_delivery_verification IS
  'Acceptance reruns in a clean checkout of the exact attested target SHA; PASS requires exit 0 and skip 0.';
COMMENT ON FUNCTION outcome_read_delivery_evidence IS
  'Returns the newest target revision plus append-only receipts; the pure delivery reducer derives obligations afresh.';

COMMIT;
