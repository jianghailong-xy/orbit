-- Outcome Reconciler V2: disposable obligation/proof/done-gate/read projections.
--
-- Immutable facts, cuts, bindings and evaluator results remain in public.  Every mutable read
-- model lives in the physically separate outcome_projection schema and is written through one
-- reducer door.  The evaluator-result trigger makes publication and its outbox event part of the
-- same transaction; a full rebuild replays immutable evaluator outputs and never reads a mutable
-- projection as authority.
BEGIN;

CREATE SCHEMA outcome_projection;
REVOKE CREATE ON SCHEMA outcome_projection FROM PUBLIC;

CREATE OR REPLACE FUNCTION outcome_projection.binding_stamp_valid(
  p_binding jsonb,
  p_binding_digest text,
  p_contract_digest text,
  p_criteria_digest text,
  p_artifact_digest text,
  p_target_digest text,
  p_policy_digest text,
  p_registry_digest text,
  p_evaluator_digest text,
  p_fact_schema_digest text,
  p_environment_digest text,
  p_as_of_logical_time bigint
) RETURNS boolean AS $$
  SELECT jsonb_typeof(p_binding) = 'object'
     AND p_binding_digest = outcome_sha256_json(p_binding)
     AND p_contract_digest = p_binding->>'contractDigest'
     -- V2 freezes criteria plus their executable wiring in evaluationPlanDigest.  The explicit
     -- criteria column gives projection readers a stable name without inventing a second digest.
     AND p_criteria_digest = p_binding->>'evaluationPlanDigest'
     AND p_artifact_digest = p_binding->>'artifactDigest'
     AND p_target_digest = p_binding->>'targetDigest'
     AND p_policy_digest = p_binding->>'policyDigest'
     AND p_registry_digest = p_binding->>'capabilityRegistryDigest'
     AND p_evaluator_digest = p_binding->>'evaluatorDigest'
     AND p_fact_schema_digest = p_binding->>'factSchemaDigest'
     AND p_environment_digest = p_binding->>'environmentDigest'
     AND p_binding->>'asOfLogicalTime' ~ '^(0|[1-9][0-9]*)$'
     AND p_as_of_logical_time = (p_binding->>'asOfLogicalTime')::bigint
$$ LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE;

CREATE OR REPLACE FUNCTION outcome_projection.write_guard() RETURNS trigger AS $$
DECLARE
  row_value jsonb;
BEGIN
  IF current_setting('outcome_projection.reducer_write', true) IS DISTINCT FROM 'on' THEN
    RAISE EXCEPTION 'OUTCOME_PROJECTION_REDUCER_ONLY:%', TG_TABLE_NAME
      USING ERRCODE = '42501',
            DETAIL = 'projection rows may only be written by outcome_projection.reduce_evaluation';
  END IF;
  IF TG_OP = 'TRUNCATE' THEN
    RETURN NULL;
  END IF;
  row_value := to_jsonb(CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END);
  IF row_value ? 'binding' AND NOT outcome_projection.binding_stamp_valid(
    row_value->'binding', row_value->>'binding_digest', row_value->>'contract_digest',
    row_value->>'criteria_digest', row_value->>'artifact_digest', row_value->>'target_digest',
    row_value->>'policy_digest', row_value->>'registry_digest', row_value->>'evaluator_digest',
    row_value->>'fact_schema_digest', row_value->>'environment_digest',
    (row_value->>'as_of_logical_time')::bigint
  ) THEN
    RAISE EXCEPTION 'OUTCOME_PROJECTION_BINDING_STAMP_INVALID:%', TG_TABLE_NAME
      USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION outcome_projection.outbox_append_only_guard() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'OUTCOME_PROJECTION_OUTBOX_APPEND_ONLY'
    USING ERRCODE = '23514';
END;
$$ LANGUAGE plpgsql;

CREATE TABLE outcome_projection.reconciler_state (
  tenant_id uuid NOT NULL,
  project_id uuid NOT NULL,
  subject_type text NOT NULL CHECK (subject_type <> ''),
  subject_id text NOT NULL CHECK (subject_id <> ''),
  source_evaluation_id uuid NOT NULL REFERENCES outcome_evaluator_result(evaluation_id),
  source_cut_id uuid NOT NULL,
  source_order_key text NOT NULL,
  binding_epoch bigint NOT NULL CHECK (binding_epoch > 0),
  projection_schema_version integer NOT NULL CHECK (projection_schema_version > 0),
  reducer_version text NOT NULL CHECK (reducer_version <> ''),
  projection_revision bigint NOT NULL CHECK (projection_revision > 0),
  binding_digest char(64) NOT NULL CHECK (outcome_valid_digest(binding_digest)),
  binding jsonb NOT NULL,
  contract_digest char(64) NOT NULL CHECK (outcome_valid_digest(contract_digest)),
  criteria_digest char(64) NOT NULL CHECK (outcome_valid_digest(criteria_digest)),
  artifact_digest char(64) NOT NULL CHECK (outcome_valid_digest(artifact_digest)),
  target_digest char(64) NOT NULL CHECK (outcome_valid_digest(target_digest)),
  target_ref text NOT NULL CHECK (target_ref <> ''),
  policy_digest char(64) NOT NULL CHECK (outcome_valid_digest(policy_digest)),
  registry_digest char(64) NOT NULL CHECK (outcome_valid_digest(registry_digest)),
  evaluator_version text NOT NULL CHECK (evaluator_version <> ''),
  evaluator_digest char(64) NOT NULL CHECK (outcome_valid_digest(evaluator_digest)),
  fact_schema_digest char(64) NOT NULL CHECK (outcome_valid_digest(fact_schema_digest)),
  environment_digest char(64) NOT NULL CHECK (outcome_valid_digest(environment_digest)),
  as_of_logical_time bigint NOT NULL CHECK (as_of_logical_time >= 0),
  evaluated_through_logical_time bigint NOT NULL CHECK (evaluated_through_logical_time >= 0),
  obligation_count integer NOT NULL CHECK (obligation_count BETWEEN 0 AND 256),
  obligation_rowset_checksum char(64) NOT NULL CHECK (outcome_valid_digest(obligation_rowset_checksum)),
  proof_checksum char(64) NOT NULL CHECK (outcome_valid_digest(proof_checksum)),
  done_gate_checksum char(64) NOT NULL CHECK (outcome_valid_digest(done_gate_checksum)),
  semantic_checksum char(64) NOT NULL CHECK (outcome_valid_digest(semantic_checksum)),
  projection_checksum char(64) NOT NULL CHECK (outcome_valid_digest(projection_checksum)),
  staleness text NOT NULL CHECK (staleness = 'CURRENT'),
  rebuild_id uuid,
  written_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, project_id, subject_type, subject_id)
);

CREATE TABLE outcome_projection.obligation (
  tenant_id uuid NOT NULL,
  project_id uuid NOT NULL,
  subject_type text NOT NULL,
  subject_id text NOT NULL,
  obligation_id char(64) NOT NULL CHECK (outcome_valid_digest(obligation_id)),
  obligation_revision char(64) NOT NULL CHECK (outcome_valid_digest(obligation_revision)),
  kind text NOT NULL CHECK (kind <> ''),
  owner text NOT NULL CHECK (owner IN ('SYSTEM', 'AGENT', 'OWNER', 'EXTERNAL')),
  capability text NOT NULL CHECK (capability <> ''),
  reason jsonb NOT NULL CHECK (jsonb_typeof(reason) = 'object' AND reason <> '{}'::jsonb),
  obligation jsonb NOT NULL,
  obligation_checksum char(64) NOT NULL CHECK (outcome_valid_digest(obligation_checksum)),
  projection_revision bigint NOT NULL CHECK (projection_revision > 0),
  binding_digest char(64) NOT NULL CHECK (outcome_valid_digest(binding_digest)),
  binding jsonb NOT NULL,
  contract_digest char(64) NOT NULL CHECK (outcome_valid_digest(contract_digest)),
  criteria_digest char(64) NOT NULL CHECK (outcome_valid_digest(criteria_digest)),
  artifact_digest char(64) NOT NULL CHECK (outcome_valid_digest(artifact_digest)),
  target_digest char(64) NOT NULL CHECK (outcome_valid_digest(target_digest)),
  target_ref text NOT NULL CHECK (target_ref <> ''),
  policy_digest char(64) NOT NULL CHECK (outcome_valid_digest(policy_digest)),
  registry_digest char(64) NOT NULL CHECK (outcome_valid_digest(registry_digest)),
  evaluator_digest char(64) NOT NULL CHECK (outcome_valid_digest(evaluator_digest)),
  fact_schema_digest char(64) NOT NULL CHECK (outcome_valid_digest(fact_schema_digest)),
  environment_digest char(64) NOT NULL CHECK (outcome_valid_digest(environment_digest)),
  as_of_logical_time bigint NOT NULL CHECK (as_of_logical_time >= 0),
  evaluated_through_logical_time bigint NOT NULL CHECK (evaluated_through_logical_time >= 0),
  staleness text NOT NULL CHECK (staleness = 'CURRENT'),
  written_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, project_id, subject_type, subject_id, obligation_id),
  UNIQUE (tenant_id, project_id, subject_type, subject_id, obligation_revision),
  FOREIGN KEY (tenant_id, project_id, subject_type, subject_id)
    REFERENCES outcome_projection.reconciler_state(tenant_id, project_id, subject_type, subject_id)
    DEFERRABLE INITIALLY DEFERRED
);

CREATE INDEX outcome_projection_obligation_owner_target_idx
  ON outcome_projection.obligation (
    tenant_id, owner, kind, target_digest, project_id, obligation_id
  ) INCLUDE (
    obligation_revision, binding_digest, evaluated_through_logical_time, reason, capability
  );
CREATE INDEX outcome_projection_obligation_project_idx
  ON outcome_projection.obligation (
    tenant_id, project_id, subject_type, subject_id, obligation_id
  ) INCLUDE (obligation_revision, binding_digest, owner, reason, evaluated_through_logical_time);

CREATE TABLE outcome_projection.proof (
  tenant_id uuid NOT NULL,
  project_id uuid NOT NULL,
  subject_type text NOT NULL,
  subject_id text NOT NULL,
  proof_digest char(64) NOT NULL CHECK (outcome_valid_digest(proof_digest)),
  proof_checksum char(64) NOT NULL CHECK (outcome_valid_digest(proof_checksum)),
  proof jsonb NOT NULL,
  proof_graph jsonb NOT NULL,
  closed boolean NOT NULL,
  projection_revision bigint NOT NULL CHECK (projection_revision > 0),
  binding_digest char(64) NOT NULL CHECK (outcome_valid_digest(binding_digest)),
  binding jsonb NOT NULL,
  contract_digest char(64) NOT NULL CHECK (outcome_valid_digest(contract_digest)),
  criteria_digest char(64) NOT NULL CHECK (outcome_valid_digest(criteria_digest)),
  artifact_digest char(64) NOT NULL CHECK (outcome_valid_digest(artifact_digest)),
  target_digest char(64) NOT NULL CHECK (outcome_valid_digest(target_digest)),
  target_ref text NOT NULL CHECK (target_ref <> ''),
  policy_digest char(64) NOT NULL CHECK (outcome_valid_digest(policy_digest)),
  registry_digest char(64) NOT NULL CHECK (outcome_valid_digest(registry_digest)),
  evaluator_digest char(64) NOT NULL CHECK (outcome_valid_digest(evaluator_digest)),
  fact_schema_digest char(64) NOT NULL CHECK (outcome_valid_digest(fact_schema_digest)),
  environment_digest char(64) NOT NULL CHECK (outcome_valid_digest(environment_digest)),
  as_of_logical_time bigint NOT NULL CHECK (as_of_logical_time >= 0),
  evaluated_through_logical_time bigint NOT NULL CHECK (evaluated_through_logical_time >= 0),
  staleness text NOT NULL CHECK (staleness = 'CURRENT'),
  written_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, project_id, subject_type, subject_id),
  FOREIGN KEY (tenant_id, project_id, subject_type, subject_id)
    REFERENCES outcome_projection.reconciler_state(tenant_id, project_id, subject_type, subject_id)
    DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE outcome_projection.done_gate (
  tenant_id uuid NOT NULL,
  project_id uuid NOT NULL,
  subject_type text NOT NULL,
  subject_id text NOT NULL,
  allowed boolean NOT NULL,
  reason jsonb NOT NULL CHECK (jsonb_typeof(reason) = 'object' AND reason <> '{}'::jsonb),
  obligation_id char(64),
  obligation_revision char(64),
  proof_digest char(64) NOT NULL CHECK (outcome_valid_digest(proof_digest)),
  gate jsonb NOT NULL,
  gate_checksum char(64) NOT NULL CHECK (outcome_valid_digest(gate_checksum)),
  projection_revision bigint NOT NULL CHECK (projection_revision > 0),
  binding_digest char(64) NOT NULL CHECK (outcome_valid_digest(binding_digest)),
  binding jsonb NOT NULL,
  contract_digest char(64) NOT NULL CHECK (outcome_valid_digest(contract_digest)),
  criteria_digest char(64) NOT NULL CHECK (outcome_valid_digest(criteria_digest)),
  artifact_digest char(64) NOT NULL CHECK (outcome_valid_digest(artifact_digest)),
  target_digest char(64) NOT NULL CHECK (outcome_valid_digest(target_digest)),
  target_ref text NOT NULL CHECK (target_ref <> ''),
  policy_digest char(64) NOT NULL CHECK (outcome_valid_digest(policy_digest)),
  registry_digest char(64) NOT NULL CHECK (outcome_valid_digest(registry_digest)),
  evaluator_digest char(64) NOT NULL CHECK (outcome_valid_digest(evaluator_digest)),
  fact_schema_digest char(64) NOT NULL CHECK (outcome_valid_digest(fact_schema_digest)),
  environment_digest char(64) NOT NULL CHECK (outcome_valid_digest(environment_digest)),
  as_of_logical_time bigint NOT NULL CHECK (as_of_logical_time >= 0),
  evaluated_through_logical_time bigint NOT NULL CHECK (evaluated_through_logical_time >= 0),
  staleness text NOT NULL CHECK (staleness = 'CURRENT'),
  written_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, project_id, subject_type, subject_id),
  CHECK ((obligation_id IS NULL) = (obligation_revision IS NULL)),
  CHECK (obligation_id IS NULL OR outcome_valid_digest(obligation_id)),
  CHECK (obligation_revision IS NULL OR outcome_valid_digest(obligation_revision)),
  FOREIGN KEY (tenant_id, project_id, subject_type, subject_id)
    REFERENCES outcome_projection.reconciler_state(tenant_id, project_id, subject_type, subject_id)
    DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE outcome_projection.read_model (
  tenant_id uuid NOT NULL,
  project_id uuid NOT NULL,
  subject_type text NOT NULL,
  subject_id text NOT NULL,
  surface text NOT NULL CHECK (surface IN (
    'DONE_GATE', 'AGENT_QUEUE', 'OWNER_DECISION_INBOX',
    'PROJECT_ATTENTION', 'MUTATION_RESPONSE', 'WEB'
  )),
  semantic_identity jsonb NOT NULL CHECK (jsonb_typeof(semantic_identity) = 'object'),
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  semantic_checksum char(64) NOT NULL CHECK (outcome_valid_digest(semantic_checksum)),
  obligation_count integer NOT NULL CHECK (obligation_count BETWEEN 0 AND 256),
  projection_revision bigint NOT NULL CHECK (projection_revision > 0),
  binding_digest char(64) NOT NULL CHECK (outcome_valid_digest(binding_digest)),
  binding jsonb NOT NULL,
  contract_digest char(64) NOT NULL CHECK (outcome_valid_digest(contract_digest)),
  criteria_digest char(64) NOT NULL CHECK (outcome_valid_digest(criteria_digest)),
  artifact_digest char(64) NOT NULL CHECK (outcome_valid_digest(artifact_digest)),
  target_digest char(64) NOT NULL CHECK (outcome_valid_digest(target_digest)),
  target_ref text NOT NULL CHECK (target_ref <> ''),
  policy_digest char(64) NOT NULL CHECK (outcome_valid_digest(policy_digest)),
  registry_digest char(64) NOT NULL CHECK (outcome_valid_digest(registry_digest)),
  evaluator_digest char(64) NOT NULL CHECK (outcome_valid_digest(evaluator_digest)),
  fact_schema_digest char(64) NOT NULL CHECK (outcome_valid_digest(fact_schema_digest)),
  environment_digest char(64) NOT NULL CHECK (outcome_valid_digest(environment_digest)),
  as_of_logical_time bigint NOT NULL CHECK (as_of_logical_time >= 0),
  evaluated_through_logical_time bigint NOT NULL CHECK (evaluated_through_logical_time >= 0),
  staleness text NOT NULL CHECK (staleness = 'CURRENT'),
  written_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, project_id, subject_type, subject_id, surface),
  FOREIGN KEY (tenant_id, project_id, subject_type, subject_id)
    REFERENCES outcome_projection.reconciler_state(tenant_id, project_id, subject_type, subject_id)
    DEFERRABLE INITIALLY DEFERRED
);

-- One exact index-only lookup is the only supported online read.  The semantic payload is capped
-- by obligation_count, so neither the row count nor a hidden fallback graph walk can grow with the
-- tenant's total task count.
CREATE UNIQUE INDEX outcome_projection_read_model_target_idx
  ON outcome_projection.read_model (tenant_id, project_id, subject_type, subject_id, surface)
  INCLUDE (
    semantic_checksum, binding_digest, evaluated_through_logical_time, projection_revision
  );

CREATE TABLE outcome_projection.outbox (
  outbox_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  event_key char(64) NOT NULL UNIQUE CHECK (outcome_valid_digest(event_key)),
  event_type text NOT NULL CHECK (event_type IN (
    'INCREMENTAL', 'FULL_REBUILD', 'CHECKSUM_RECONCILE', 'SCHEMA_UPGRADE'
  )),
  tenant_id uuid NOT NULL,
  project_id uuid NOT NULL,
  subject_type text NOT NULL,
  subject_id text NOT NULL,
  source_evaluation_id uuid NOT NULL REFERENCES outcome_evaluator_result(evaluation_id),
  projection_revision bigint NOT NULL CHECK (projection_revision > 0),
  projection_checksum char(64) NOT NULL CHECK (outcome_valid_digest(projection_checksum)),
  payload jsonb NOT NULL,
  payload_checksum char(64) NOT NULL CHECK (outcome_valid_digest(payload_checksum)),
  binding_digest char(64) NOT NULL CHECK (outcome_valid_digest(binding_digest)),
  binding jsonb NOT NULL,
  contract_digest char(64) NOT NULL CHECK (outcome_valid_digest(contract_digest)),
  criteria_digest char(64) NOT NULL CHECK (outcome_valid_digest(criteria_digest)),
  artifact_digest char(64) NOT NULL CHECK (outcome_valid_digest(artifact_digest)),
  target_digest char(64) NOT NULL CHECK (outcome_valid_digest(target_digest)),
  target_ref text NOT NULL CHECK (target_ref <> ''),
  policy_digest char(64) NOT NULL CHECK (outcome_valid_digest(policy_digest)),
  registry_digest char(64) NOT NULL CHECK (outcome_valid_digest(registry_digest)),
  evaluator_digest char(64) NOT NULL CHECK (outcome_valid_digest(evaluator_digest)),
  fact_schema_digest char(64) NOT NULL CHECK (outcome_valid_digest(fact_schema_digest)),
  environment_digest char(64) NOT NULL CHECK (outcome_valid_digest(environment_digest)),
  as_of_logical_time bigint NOT NULL CHECK (as_of_logical_time >= 0),
  evaluated_through_logical_time bigint NOT NULL CHECK (evaluated_through_logical_time >= 0),
  staleness text NOT NULL CHECK (staleness = 'CURRENT'),
  rebuild_id uuid,
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX outcome_projection_outbox_delivery_idx
  ON outcome_projection.outbox (outbox_id)
  INCLUDE (event_type, tenant_id, project_id, subject_type, subject_id, payload);

CREATE TABLE outcome_projection.rebuild_run (
  rebuild_id uuid PRIMARY KEY,
  projection_schema_version integer NOT NULL CHECK (projection_schema_version > 0),
  reducer_version text NOT NULL CHECK (reducer_version <> ''),
  source_evaluation_count bigint NOT NULL DEFAULT 0 CHECK (source_evaluation_count >= 0),
  projected_subject_count bigint NOT NULL DEFAULT 0 CHECK (projected_subject_count >= 0),
  aggregate_checksum char(64),
  started_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  completed_at timestamptz,
  CHECK (aggregate_checksum IS NULL OR outcome_valid_digest(aggregate_checksum))
);

-- A stable source ordinal is independent of incremental delivery order and survives a complete
-- projection truncate.  Binding epoch dominates watermark so evaluator/schema upgrades replay in
-- their canonical order even when they do not append a new fact.
CREATE OR REPLACE FUNCTION outcome_projection.source_revision(p_evaluation_id uuid)
RETURNS bigint AS $$
  SELECT numbered.ordinal
    FROM (
      SELECT r.evaluation_id,
             row_number() OVER (
               PARTITION BY r.tenant_id, r.project_id, r.subject_type, r.subject_id
               ORDER BY b.binding_epoch, r.watermark_logical_time,
                        r.evaluator_digest::text, r.evaluation_id::text
             )::bigint AS ordinal
        FROM outcome_evaluator_result r
        JOIN outcome_fact_binding b
          ON b.tenant_id = r.tenant_id AND b.project_id = r.project_id
         AND b.binding_digest = r.binding_digest
    ) numbered
   WHERE numbered.evaluation_id = p_evaluation_id
$$ LANGUAGE sql STABLE STRICT;

CREATE OR REPLACE FUNCTION outcome_projection.done_gate_value(
  p_result jsonb,
  p_proof_digest text,
  p_closed boolean,
  p_binding_digest text,
  p_watermark bigint,
  p_projection_revision bigint
) RETURNS jsonb AS $$
DECLARE
  primary_obligation jsonb;
  reason_value jsonb;
  obligation_count integer;
BEGIN
  obligation_count := jsonb_array_length(p_result->'activeMandatoryObligations');
  SELECT value INTO primary_obligation
    FROM jsonb_array_elements(p_result->'activeMandatoryObligations') item(value)
   ORDER BY value->>'obligationId'
   LIMIT 1;
  IF p_closed AND obligation_count = 0 THEN
    reason_value := jsonb_build_object(
      'code', 'OUTCOME_CLOSED',
      'message', 'Every bound completion dimension is closed by the current proof.',
      'evidenceFactIds', '[]'::jsonb,
      'attemptedActions', '[]'::jsonb,
      'nextAction', 'NONE'
    );
  ELSIF primary_obligation IS NOT NULL THEN
    reason_value := primary_obligation->'reason';
  ELSE
    reason_value := jsonb_build_object(
      'code', 'OUTCOME_NOT_CLOSED',
      'message', 'The current proof is not closed.',
      'evidenceFactIds', '[]'::jsonb,
      'attemptedActions', '[]'::jsonb,
      'nextAction', 'RECONCILE_OUTCOME'
    );
  END IF;
  RETURN jsonb_build_object(
    'allowed', p_closed AND obligation_count = 0,
    'reason', reason_value,
    'obligationId', primary_obligation->>'obligationId',
    'obligationRevision', primary_obligation->>'obligationRevision',
    'owner', primary_obligation->>'owner',
    'bindingDigest', p_binding_digest,
    'evaluatedThroughLogicalTime', p_watermark::text,
    'projectionRevision', p_projection_revision::text,
    'proofDigest', p_proof_digest,
    'staleness', 'CURRENT'
  );
END;
$$ LANGUAGE plpgsql IMMUTABLE STRICT;

CREATE OR REPLACE FUNCTION outcome_projection.obligation_read_set(
  p_result jsonb,
  p_binding jsonb,
  p_watermark bigint,
  p_projection_revision bigint
) RETURNS jsonb AS $$
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'obligationId', value->>'obligationId',
    'obligationRevision', value->>'obligationRevision',
    'bindingDigest', value->>'bindingDigest',
    'binding', p_binding,
    'kind', value->>'kind',
    'owner', value->>'owner',
    'capability', value->>'capability',
    'reason', value->'reason',
    'evaluatedThroughLogicalTime', p_watermark::text,
    'projectionRevision', p_projection_revision::text,
    'staleness', 'CURRENT'
  ) ORDER BY value->>'obligationId'), '[]'::jsonb)
    FROM jsonb_array_elements(p_result->'activeMandatoryObligations') item(value)
$$ LANGUAGE sql IMMUTABLE STRICT;

CREATE OR REPLACE FUNCTION outcome_projection.semantic_payload(
  p_result jsonb,
  p_binding jsonb,
  p_gate jsonb,
  p_watermark bigint,
  p_projection_revision bigint,
  p_projection_schema_version integer
) RETURNS jsonb AS $$
  SELECT jsonb_build_object(
    'schemaVersion', p_projection_schema_version,
    'staleness', 'CURRENT',
    'canonicalIdentity', jsonb_build_object(
      'bindingDigest', p_result->>'bindingDigest',
      'contractDigest', p_binding->>'contractDigest',
      'criteriaDigest', p_binding->>'evaluationPlanDigest',
      'artifactDigest', p_binding->>'artifactDigest',
      'targetDigest', p_binding->>'targetDigest',
      'policyDigest', p_binding->>'policyDigest',
      'registryDigest', p_binding->>'capabilityRegistryDigest',
      'evaluatorDigest', p_binding->>'evaluatorDigest',
      'factSchemaDigest', p_binding->>'factSchemaDigest',
      'environmentDigest', p_binding->>'environmentDigest',
      'asOfLogicalTime', p_binding->>'asOfLogicalTime',
      'evaluatedThroughLogicalTime', p_watermark::text,
      'projectionRevision', p_projection_revision::text,
      'proofDigest', p_result#>>'{proof,proofDigest}'
    ),
    'doneGate', p_gate,
    'obligations', outcome_projection.obligation_read_set(
      p_result, p_binding, p_watermark, p_projection_revision
    )
  )
$$ LANGUAGE sql IMMUTABLE STRICT;

CREATE OR REPLACE FUNCTION outcome_projection.projection_checksum_value(
  p_schema_version integer,
  p_binding_digest text,
  p_watermark bigint,
  p_obligation_checksum text,
  p_proof_checksum text,
  p_gate_checksum text
) RETURNS text AS $$
  SELECT outcome_sha256_json(jsonb_build_object(
    'schemaVersion', p_schema_version,
    'bindingDigest', p_binding_digest,
    'evaluatedThroughLogicalTime', p_watermark::text,
    'obligationRowsetChecksum', p_obligation_checksum,
    'proofChecksum', p_proof_checksum,
    'doneGateChecksum', p_gate_checksum
  ))
$$ LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE;

CREATE OR REPLACE FUNCTION outcome_projection.reduce_evaluation(
  p_evaluation_id uuid,
  p_projection_schema_version integer DEFAULT 1,
  p_reducer_version text DEFAULT 'outcome-projection-reducer-v1',
  p_event_type text DEFAULT 'INCREMENTAL',
  p_rebuild_id uuid DEFAULT NULL
) RETURNS jsonb AS $$
DECLARE
  source_result outcome_evaluator_result%ROWTYPE;
  source_binding outcome_fact_binding%ROWTYPE;
  existing_state outcome_projection.reconciler_state%ROWTYPE;
  projection_revision_value bigint;
  source_order_key_value text;
  obligation_count_value integer;
  obligation_rowset jsonb;
  obligation_rowset_checksum_value text;
  proof_checksum_value text;
  gate_value jsonb;
  gate_checksum_value text;
  semantic_payload_value jsonb;
  semantic_checksum_value text;
  projection_checksum_result text;
  identity_value jsonb;
  outbox_payload jsonb;
  outbox_key text;
  obligation_value jsonb;
  surface_value text;
  previous_writer_setting text;
BEGIN
  IF p_projection_schema_version <= 0 OR COALESCE(p_reducer_version, '') = ''
     OR p_event_type NOT IN ('INCREMENTAL', 'FULL_REBUILD', 'CHECKSUM_RECONCILE', 'SCHEMA_UPGRADE') THEN
    RAISE EXCEPTION 'OUTCOME_PROJECTION_REDUCER_ARGUMENT_INVALID' USING ERRCODE = '22023';
  END IF;
  IF p_event_type = 'FULL_REBUILD' AND p_rebuild_id IS NULL THEN
    RAISE EXCEPTION 'OUTCOME_PROJECTION_REBUILD_ID_REQUIRED' USING ERRCODE = '22023';
  END IF;
  IF p_rebuild_id IS NULL THEN
    PERFORM pg_advisory_xact_lock_shared(hashtextextended('outcome_projection.full_rebuild', 0));
  END IF;

  SELECT * INTO source_result
    FROM outcome_evaluator_result
   WHERE evaluation_id = p_evaluation_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'OUTCOME_PROJECTION_SOURCE_EVALUATION_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;
  SELECT * INTO source_binding
    FROM outcome_fact_binding
   WHERE tenant_id = source_result.tenant_id AND project_id = source_result.project_id
     AND binding_digest = source_result.binding_digest;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'OUTCOME_PROJECTION_SOURCE_BINDING_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;
  IF source_result.result->>'bindingDigest' IS DISTINCT FROM source_result.binding_digest::text
     OR source_result.result->>'evaluatedThroughLogicalTime'
          IS DISTINCT FROM source_result.watermark_logical_time::text
     OR source_result.result#>>'{proof,proofDigest}' IS DISTINCT FROM source_result.proof_digest::text
     OR source_result.result->>'evaluatorDigest' IS DISTINCT FROM source_result.evaluator_digest::text
     OR source_binding.binding->>'evaluatorDigest' IS DISTINCT FROM source_result.evaluator_digest::text
     OR jsonb_typeof(source_result.result->'activeMandatoryObligations') <> 'array'
     OR jsonb_typeof(source_result.result->'proof') <> 'object'
     OR jsonb_typeof(source_result.result->'proofGraph') <> 'object' THEN
    RAISE EXCEPTION 'OUTCOME_PROJECTION_SOURCE_RESULT_INVALID' USING ERRCODE = '23514';
  END IF;
  obligation_count_value := jsonb_array_length(source_result.result->'activeMandatoryObligations');
  IF obligation_count_value > 256 THEN
    RAISE EXCEPTION 'OUTCOME_PROJECTION_CARDINALITY_EXCEEDED:%', obligation_count_value
      USING ERRCODE = '54000';
  END IF;
  projection_revision_value := outcome_projection.source_revision(p_evaluation_id);
  IF projection_revision_value IS NULL THEN
    RAISE EXCEPTION 'OUTCOME_PROJECTION_SOURCE_REVISION_MISSING' USING ERRCODE = '23514';
  END IF;
  source_order_key_value := lpad(source_binding.binding_epoch::text, 20, '0') || ':'
    || lpad(source_result.watermark_logical_time::text, 20, '0') || ':'
    || source_result.evaluator_digest::text || ':' || source_result.evaluation_id::text;

  SELECT * INTO existing_state
    FROM outcome_projection.reconciler_state
   WHERE tenant_id = source_result.tenant_id AND project_id = source_result.project_id
     AND subject_type = source_result.subject_type AND subject_id = source_result.subject_id
   FOR UPDATE;
  IF FOUND AND existing_state.source_order_key > source_order_key_value THEN
    RETURN jsonb_build_object(
      'applied', false, 'reason', 'OLDER_SOURCE_IGNORED',
      'sourceEvaluationId', p_evaluation_id::text,
      'projectionRevision', existing_state.projection_revision::text,
      'projectionChecksum', existing_state.projection_checksum::text
    );
  END IF;

  SELECT COALESCE(jsonb_agg(value ORDER BY value->>'obligationId'), '[]'::jsonb)
    INTO obligation_rowset
    FROM jsonb_array_elements(source_result.result->'activeMandatoryObligations') item(value);
  obligation_rowset_checksum_value := outcome_sha256_json(obligation_rowset);
  proof_checksum_value := outcome_sha256_json(jsonb_build_object(
    'proof', source_result.result->'proof', 'proofGraph', source_result.result->'proofGraph'
  ));
  gate_value := outcome_projection.done_gate_value(
    source_result.result, source_result.proof_digest::text, source_result.is_closed,
    source_result.binding_digest::text, source_result.watermark_logical_time,
    projection_revision_value
  );
  gate_checksum_value := outcome_sha256_json(gate_value);
  semantic_payload_value := outcome_projection.semantic_payload(
    source_result.result, source_binding.binding, gate_value,
    source_result.watermark_logical_time, projection_revision_value,
    p_projection_schema_version
  );
  semantic_checksum_value := outcome_sha256_json(semantic_payload_value);
  projection_checksum_result := outcome_projection.projection_checksum_value(
    p_projection_schema_version, source_result.binding_digest::text,
    source_result.watermark_logical_time, obligation_rowset_checksum_value,
    proof_checksum_value, gate_checksum_value
  );
  identity_value := semantic_payload_value->'canonicalIdentity';

  previous_writer_setting := current_setting('outcome_projection.reducer_write', true);
  PERFORM set_config('outcome_projection.reducer_write', 'on', true);

  DELETE FROM outcome_projection.obligation
   WHERE tenant_id = source_result.tenant_id AND project_id = source_result.project_id
     AND subject_type = source_result.subject_type AND subject_id = source_result.subject_id;
  DELETE FROM outcome_projection.read_model
   WHERE tenant_id = source_result.tenant_id AND project_id = source_result.project_id
     AND subject_type = source_result.subject_type AND subject_id = source_result.subject_id;

  INSERT INTO outcome_projection.reconciler_state (
    tenant_id, project_id, subject_type, subject_id, source_evaluation_id, source_cut_id,
    source_order_key, binding_epoch, projection_schema_version, reducer_version,
    projection_revision, binding_digest, binding, contract_digest, criteria_digest,
    artifact_digest, target_digest, target_ref, policy_digest, registry_digest,
    evaluator_version, evaluator_digest, fact_schema_digest, environment_digest,
    as_of_logical_time, evaluated_through_logical_time, obligation_count,
    obligation_rowset_checksum, proof_checksum, done_gate_checksum, semantic_checksum,
    projection_checksum, staleness, rebuild_id, written_at
  ) VALUES (
    source_result.tenant_id, source_result.project_id, source_result.subject_type,
    source_result.subject_id, source_result.evaluation_id, source_result.cut_id,
    source_order_key_value, source_binding.binding_epoch, p_projection_schema_version,
    p_reducer_version, projection_revision_value, source_result.binding_digest,
    source_binding.binding, source_binding.binding->>'contractDigest',
    source_binding.binding->>'evaluationPlanDigest', source_binding.binding->>'artifactDigest',
    source_binding.binding->>'targetDigest', source_binding.binding->>'targetRef',
    source_binding.binding->>'policyDigest', source_binding.binding->>'capabilityRegistryDigest',
    source_result.evaluator_version, source_result.evaluator_digest,
    source_binding.binding->>'factSchemaDigest', source_binding.binding->>'environmentDigest',
    (source_binding.binding->>'asOfLogicalTime')::bigint,
    source_result.watermark_logical_time, obligation_count_value,
    obligation_rowset_checksum_value, proof_checksum_value, gate_checksum_value,
    semantic_checksum_value, projection_checksum_result, 'CURRENT', p_rebuild_id,
    clock_timestamp()
  ) ON CONFLICT (tenant_id, project_id, subject_type, subject_id) DO UPDATE SET
    source_evaluation_id = EXCLUDED.source_evaluation_id,
    source_cut_id = EXCLUDED.source_cut_id,
    source_order_key = EXCLUDED.source_order_key,
    binding_epoch = EXCLUDED.binding_epoch,
    projection_schema_version = EXCLUDED.projection_schema_version,
    reducer_version = EXCLUDED.reducer_version,
    projection_revision = EXCLUDED.projection_revision,
    binding_digest = EXCLUDED.binding_digest,
    binding = EXCLUDED.binding,
    contract_digest = EXCLUDED.contract_digest,
    criteria_digest = EXCLUDED.criteria_digest,
    artifact_digest = EXCLUDED.artifact_digest,
    target_digest = EXCLUDED.target_digest,
    target_ref = EXCLUDED.target_ref,
    policy_digest = EXCLUDED.policy_digest,
    registry_digest = EXCLUDED.registry_digest,
    evaluator_version = EXCLUDED.evaluator_version,
    evaluator_digest = EXCLUDED.evaluator_digest,
    fact_schema_digest = EXCLUDED.fact_schema_digest,
    environment_digest = EXCLUDED.environment_digest,
    as_of_logical_time = EXCLUDED.as_of_logical_time,
    evaluated_through_logical_time = EXCLUDED.evaluated_through_logical_time,
    obligation_count = EXCLUDED.obligation_count,
    obligation_rowset_checksum = EXCLUDED.obligation_rowset_checksum,
    proof_checksum = EXCLUDED.proof_checksum,
    done_gate_checksum = EXCLUDED.done_gate_checksum,
    semantic_checksum = EXCLUDED.semantic_checksum,
    projection_checksum = EXCLUDED.projection_checksum,
    staleness = 'CURRENT',
    rebuild_id = EXCLUDED.rebuild_id,
    written_at = clock_timestamp();

  FOR obligation_value IN
    SELECT value FROM jsonb_array_elements(source_result.result->'activeMandatoryObligations') item(value)
     ORDER BY value->>'obligationId'
  LOOP
    INSERT INTO outcome_projection.obligation (
      tenant_id, project_id, subject_type, subject_id, obligation_id, obligation_revision,
      kind, owner, capability, reason, obligation, obligation_checksum, projection_revision,
      binding_digest, binding, contract_digest, criteria_digest, artifact_digest, target_digest,
      target_ref, policy_digest, registry_digest, evaluator_digest, fact_schema_digest,
      environment_digest, as_of_logical_time, evaluated_through_logical_time, staleness
    ) VALUES (
      source_result.tenant_id, source_result.project_id, source_result.subject_type,
      source_result.subject_id, obligation_value->>'obligationId',
      obligation_value->>'obligationRevision', obligation_value->>'kind',
      obligation_value->>'owner', obligation_value->>'capability', obligation_value->'reason',
      obligation_value, outcome_sha256_json(obligation_value), projection_revision_value,
      source_result.binding_digest, source_binding.binding,
      source_binding.binding->>'contractDigest', source_binding.binding->>'evaluationPlanDigest',
      source_binding.binding->>'artifactDigest', source_binding.binding->>'targetDigest',
      source_binding.binding->>'targetRef', source_binding.binding->>'policyDigest',
      source_binding.binding->>'capabilityRegistryDigest', source_result.evaluator_digest,
      source_binding.binding->>'factSchemaDigest', source_binding.binding->>'environmentDigest',
      (source_binding.binding->>'asOfLogicalTime')::bigint,
      source_result.watermark_logical_time, 'CURRENT'
    );
  END LOOP;

  INSERT INTO outcome_projection.proof (
    tenant_id, project_id, subject_type, subject_id, proof_digest, proof_checksum,
    proof, proof_graph, closed, projection_revision, binding_digest, binding,
    contract_digest, criteria_digest, artifact_digest, target_digest, target_ref,
    policy_digest, registry_digest, evaluator_digest, fact_schema_digest,
    environment_digest, as_of_logical_time, evaluated_through_logical_time, staleness,
    written_at
  ) VALUES (
    source_result.tenant_id, source_result.project_id, source_result.subject_type,
    source_result.subject_id, source_result.proof_digest, proof_checksum_value,
    source_result.result->'proof', source_result.result->'proofGraph', source_result.is_closed,
    projection_revision_value, source_result.binding_digest, source_binding.binding,
    source_binding.binding->>'contractDigest', source_binding.binding->>'evaluationPlanDigest',
    source_binding.binding->>'artifactDigest', source_binding.binding->>'targetDigest',
    source_binding.binding->>'targetRef', source_binding.binding->>'policyDigest',
    source_binding.binding->>'capabilityRegistryDigest', source_result.evaluator_digest,
    source_binding.binding->>'factSchemaDigest', source_binding.binding->>'environmentDigest',
    (source_binding.binding->>'asOfLogicalTime')::bigint, source_result.watermark_logical_time,
    'CURRENT', clock_timestamp()
  ) ON CONFLICT (tenant_id, project_id, subject_type, subject_id) DO UPDATE SET
    proof_digest = EXCLUDED.proof_digest, proof_checksum = EXCLUDED.proof_checksum,
    proof = EXCLUDED.proof, proof_graph = EXCLUDED.proof_graph, closed = EXCLUDED.closed,
    projection_revision = EXCLUDED.projection_revision, binding_digest = EXCLUDED.binding_digest,
    binding = EXCLUDED.binding, contract_digest = EXCLUDED.contract_digest,
    criteria_digest = EXCLUDED.criteria_digest, artifact_digest = EXCLUDED.artifact_digest,
    target_digest = EXCLUDED.target_digest, target_ref = EXCLUDED.target_ref,
    policy_digest = EXCLUDED.policy_digest, registry_digest = EXCLUDED.registry_digest,
    evaluator_digest = EXCLUDED.evaluator_digest, fact_schema_digest = EXCLUDED.fact_schema_digest,
    environment_digest = EXCLUDED.environment_digest,
    as_of_logical_time = EXCLUDED.as_of_logical_time,
    evaluated_through_logical_time = EXCLUDED.evaluated_through_logical_time,
    staleness = 'CURRENT', written_at = clock_timestamp();

  INSERT INTO outcome_projection.done_gate (
    tenant_id, project_id, subject_type, subject_id, allowed, reason, obligation_id,
    obligation_revision, proof_digest, gate, gate_checksum, projection_revision,
    binding_digest, binding, contract_digest, criteria_digest, artifact_digest, target_digest,
    target_ref, policy_digest, registry_digest, evaluator_digest, fact_schema_digest,
    environment_digest, as_of_logical_time, evaluated_through_logical_time, staleness,
    written_at
  ) VALUES (
    source_result.tenant_id, source_result.project_id, source_result.subject_type,
    source_result.subject_id, (gate_value->>'allowed')::boolean, gate_value->'reason',
    gate_value->>'obligationId', gate_value->>'obligationRevision', source_result.proof_digest,
    gate_value, gate_checksum_value, projection_revision_value, source_result.binding_digest,
    source_binding.binding, source_binding.binding->>'contractDigest',
    source_binding.binding->>'evaluationPlanDigest', source_binding.binding->>'artifactDigest',
    source_binding.binding->>'targetDigest', source_binding.binding->>'targetRef',
    source_binding.binding->>'policyDigest', source_binding.binding->>'capabilityRegistryDigest',
    source_result.evaluator_digest, source_binding.binding->>'factSchemaDigest',
    source_binding.binding->>'environmentDigest',
    (source_binding.binding->>'asOfLogicalTime')::bigint, source_result.watermark_logical_time,
    'CURRENT', clock_timestamp()
  ) ON CONFLICT (tenant_id, project_id, subject_type, subject_id) DO UPDATE SET
    allowed = EXCLUDED.allowed, reason = EXCLUDED.reason, obligation_id = EXCLUDED.obligation_id,
    obligation_revision = EXCLUDED.obligation_revision, proof_digest = EXCLUDED.proof_digest,
    gate = EXCLUDED.gate, gate_checksum = EXCLUDED.gate_checksum,
    projection_revision = EXCLUDED.projection_revision, binding_digest = EXCLUDED.binding_digest,
    binding = EXCLUDED.binding, contract_digest = EXCLUDED.contract_digest,
    criteria_digest = EXCLUDED.criteria_digest, artifact_digest = EXCLUDED.artifact_digest,
    target_digest = EXCLUDED.target_digest, target_ref = EXCLUDED.target_ref,
    policy_digest = EXCLUDED.policy_digest, registry_digest = EXCLUDED.registry_digest,
    evaluator_digest = EXCLUDED.evaluator_digest, fact_schema_digest = EXCLUDED.fact_schema_digest,
    environment_digest = EXCLUDED.environment_digest,
    as_of_logical_time = EXCLUDED.as_of_logical_time,
    evaluated_through_logical_time = EXCLUDED.evaluated_through_logical_time,
    staleness = 'CURRENT', written_at = clock_timestamp();

  FOREACH surface_value IN ARRAY ARRAY[
    'DONE_GATE', 'AGENT_QUEUE', 'OWNER_DECISION_INBOX',
    'PROJECT_ATTENTION', 'MUTATION_RESPONSE', 'WEB'
  ] LOOP
    INSERT INTO outcome_projection.read_model (
      tenant_id, project_id, subject_type, subject_id, surface, semantic_identity, payload,
      semantic_checksum, obligation_count, projection_revision, binding_digest, binding,
      contract_digest, criteria_digest, artifact_digest, target_digest, target_ref,
      policy_digest, registry_digest, evaluator_digest, fact_schema_digest,
      environment_digest, as_of_logical_time, evaluated_through_logical_time, staleness
    ) VALUES (
      source_result.tenant_id, source_result.project_id, source_result.subject_type,
      source_result.subject_id, surface_value, identity_value,
      semantic_payload_value || jsonb_build_object('surface', surface_value),
      semantic_checksum_value, obligation_count_value, projection_revision_value,
      source_result.binding_digest, source_binding.binding,
      source_binding.binding->>'contractDigest', source_binding.binding->>'evaluationPlanDigest',
      source_binding.binding->>'artifactDigest', source_binding.binding->>'targetDigest',
      source_binding.binding->>'targetRef', source_binding.binding->>'policyDigest',
      source_binding.binding->>'capabilityRegistryDigest', source_result.evaluator_digest,
      source_binding.binding->>'factSchemaDigest', source_binding.binding->>'environmentDigest',
      (source_binding.binding->>'asOfLogicalTime')::bigint,
      source_result.watermark_logical_time, 'CURRENT'
    );
  END LOOP;

  outbox_payload := jsonb_build_object(
    'eventType', p_event_type,
    'sourceEvaluationId', source_result.evaluation_id::text,
    'bindingDigest', source_result.binding_digest::text,
    'evaluatedThroughLogicalTime', source_result.watermark_logical_time::text,
    'projectionRevision', projection_revision_value::text,
    'projectionSchemaVersion', p_projection_schema_version,
    'reducerVersion', p_reducer_version,
    'obligationCount', obligation_count_value,
    'obligationRowsetChecksum', obligation_rowset_checksum_value,
    'proofChecksum', proof_checksum_value,
    'doneGateChecksum', gate_checksum_value,
    'semanticChecksum', semantic_checksum_value,
    'projectionChecksum', projection_checksum_result
  );
  outbox_key := outcome_sha256_json(jsonb_build_object(
    'eventType', p_event_type,
    'sourceEvaluationId', source_result.evaluation_id::text,
    'projectionSchemaVersion', p_projection_schema_version,
    'reducerVersion', p_reducer_version,
    'rebuildId', p_rebuild_id::text
  ));
  INSERT INTO outcome_projection.outbox (
    event_key, event_type, tenant_id, project_id, subject_type, subject_id,
    source_evaluation_id, projection_revision, projection_checksum, payload,
    payload_checksum, binding_digest, binding, contract_digest, criteria_digest,
    artifact_digest, target_digest, target_ref, policy_digest, registry_digest,
    evaluator_digest, fact_schema_digest, environment_digest, as_of_logical_time,
    evaluated_through_logical_time, staleness, rebuild_id
  ) VALUES (
    outbox_key, p_event_type, source_result.tenant_id, source_result.project_id,
    source_result.subject_type, source_result.subject_id, source_result.evaluation_id,
    projection_revision_value, projection_checksum_result, outbox_payload,
    outcome_sha256_json(outbox_payload), source_result.binding_digest, source_binding.binding,
    source_binding.binding->>'contractDigest', source_binding.binding->>'evaluationPlanDigest',
    source_binding.binding->>'artifactDigest', source_binding.binding->>'targetDigest',
    source_binding.binding->>'targetRef', source_binding.binding->>'policyDigest',
    source_binding.binding->>'capabilityRegistryDigest', source_result.evaluator_digest,
    source_binding.binding->>'factSchemaDigest', source_binding.binding->>'environmentDigest',
    (source_binding.binding->>'asOfLogicalTime')::bigint,
    source_result.watermark_logical_time, 'CURRENT', p_rebuild_id
  ) ON CONFLICT (event_key) DO NOTHING;

  PERFORM set_config(
    'outcome_projection.reducer_write', COALESCE(previous_writer_setting, 'off'), true
  );
  RETURN jsonb_build_object(
    'applied', true,
    'sourceEvaluationId', source_result.evaluation_id::text,
    'projectionRevision', projection_revision_value::text,
    'projectionChecksum', projection_checksum_result,
    'proofChecksum', proof_checksum_value,
    'obligationRowsetChecksum', obligation_rowset_checksum_value,
    'outboxEventKey', outbox_key
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER
   SET search_path = pg_catalog, public, outcome_projection;

CREATE OR REPLACE FUNCTION outcome_projection.full_rebuild(
  p_projection_schema_version integer DEFAULT 1,
  p_reducer_version text DEFAULT 'outcome-projection-reducer-v1'
) RETURNS jsonb AS $$
DECLARE
  rebuild_id_value uuid := gen_random_uuid();
  source_row record;
  source_count bigint;
  projected_count bigint := 0;
  aggregate_checksum_value text;
  previous_writer_setting text;
BEGIN
  IF p_projection_schema_version <= 0 OR COALESCE(p_reducer_version, '') = '' THEN
    RAISE EXCEPTION 'OUTCOME_PROJECTION_REBUILD_ARGUMENT_INVALID' USING ERRCODE = '22023';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('outcome_projection.full_rebuild', 0));
  LOCK TABLE outcome_evaluator_result IN SHARE MODE;
  previous_writer_setting := current_setting('outcome_projection.reducer_write', true);
  PERFORM set_config('outcome_projection.reducer_write', 'on', true);
  INSERT INTO outcome_projection.rebuild_run (
    rebuild_id, projection_schema_version, reducer_version
  ) VALUES (rebuild_id_value, p_projection_schema_version, p_reducer_version);

  TRUNCATE TABLE outcome_projection.obligation,
    outcome_projection.proof,
    outcome_projection.done_gate,
    outcome_projection.read_model,
    outcome_projection.reconciler_state;

  SELECT count(*) INTO source_count FROM outcome_evaluator_result;
  FOR source_row IN
    SELECT DISTINCT ON (r.tenant_id, r.project_id, r.subject_type, r.subject_id)
           r.evaluation_id, r.tenant_id, r.project_id, r.subject_type, r.subject_id
      FROM outcome_evaluator_result r
      JOIN outcome_fact_binding b
        ON b.tenant_id = r.tenant_id AND b.project_id = r.project_id
       AND b.binding_digest = r.binding_digest
     ORDER BY r.tenant_id, r.project_id, r.subject_type, r.subject_id,
              b.binding_epoch DESC, r.watermark_logical_time DESC,
              r.evaluator_digest DESC, r.evaluation_id DESC
  LOOP
    PERFORM outcome_projection.reduce_evaluation(
      source_row.evaluation_id, p_projection_schema_version, p_reducer_version,
      CASE WHEN p_projection_schema_version = 1
        THEN 'FULL_REBUILD' ELSE 'SCHEMA_UPGRADE' END,
      rebuild_id_value
    );
    projected_count := projected_count + 1;
  END LOOP;

  SELECT outcome_sha256_json(COALESCE(jsonb_agg(jsonb_build_object(
    'tenantId', tenant_id::text,
    'projectId', project_id::text,
    'subjectType', subject_type,
    'subjectId', subject_id,
    'projectionChecksum', projection_checksum::text
  ) ORDER BY tenant_id, project_id, subject_type, subject_id), '[]'::jsonb))
    INTO aggregate_checksum_value
    FROM outcome_projection.reconciler_state;
  UPDATE outcome_projection.rebuild_run
     SET source_evaluation_count = source_count,
         projected_subject_count = projected_count,
         aggregate_checksum = aggregate_checksum_value,
         completed_at = clock_timestamp()
   WHERE rebuild_id = rebuild_id_value;
  PERFORM set_config(
    'outcome_projection.reducer_write', COALESCE(previous_writer_setting, 'off'), true
  );
  RETURN jsonb_build_object(
    'rebuildId', rebuild_id_value::text,
    'sourceEvaluationCount', source_count,
    'projectedSubjectCount', projected_count,
    'aggregateChecksum', aggregate_checksum_value,
    'projectionSchemaVersion', p_projection_schema_version,
    'reducerVersion', p_reducer_version
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER
   SET search_path = pg_catalog, public, outcome_projection;

CREATE OR REPLACE FUNCTION outcome_projection.shadow_compare(
  p_tenant_id uuid DEFAULT NULL,
  p_project_id uuid DEFAULT NULL
) RETURNS TABLE (
  tenant_id uuid,
  project_id uuid,
  subject_type text,
  subject_id text,
  source_evaluation_id uuid,
  comparison_status text,
  expected_projection_checksum text,
  actual_projection_checksum text,
  expected_proof_checksum text,
  actual_proof_checksum text
) AS $$
  WITH latest AS (
    SELECT DISTINCT ON (r.tenant_id, r.project_id, r.subject_type, r.subject_id)
           r.*, b.binding, b.binding_epoch,
           outcome_projection.source_revision(r.evaluation_id) AS projection_revision
      FROM outcome_evaluator_result r
      JOIN outcome_fact_binding b
        ON b.tenant_id = r.tenant_id AND b.project_id = r.project_id
       AND b.binding_digest = r.binding_digest
     WHERE (p_tenant_id IS NULL OR r.tenant_id = p_tenant_id)
       AND (p_project_id IS NULL OR r.project_id = p_project_id)
     ORDER BY r.tenant_id, r.project_id, r.subject_type, r.subject_id,
              b.binding_epoch DESC, r.watermark_logical_time DESC,
              r.evaluator_digest DESC, r.evaluation_id DESC
  ), expected AS (
    SELECT latest.*,
           outcome_sha256_json(latest.result->'activeMandatoryObligations') AS expected_rows,
           outcome_sha256_json(jsonb_build_object(
             'proof', latest.result->'proof', 'proofGraph', latest.result->'proofGraph'
           )) AS expected_proof,
           outcome_projection.done_gate_value(
             latest.result, latest.proof_digest::text, latest.is_closed,
             latest.binding_digest::text, latest.watermark_logical_time,
             latest.projection_revision
           ) AS expected_gate
      FROM latest
  ), calculated AS (
    SELECT expected.*,
           outcome_sha256_json(expected.expected_gate) AS expected_gate_checksum,
           outcome_sha256_json(COALESCE((
             SELECT jsonb_agg(o.obligation ORDER BY o.obligation_id)
               FROM outcome_projection.obligation o
              WHERE o.tenant_id = expected.tenant_id AND o.project_id = expected.project_id
                AND o.subject_type = expected.subject_type AND o.subject_id = expected.subject_id
           ), '[]'::jsonb)) AS actual_rows,
           (SELECT outcome_sha256_json(jsonb_build_object(
               'proof', p.proof, 'proofGraph', p.proof_graph
             )) FROM outcome_projection.proof p
             WHERE p.tenant_id = expected.tenant_id AND p.project_id = expected.project_id
               AND p.subject_type = expected.subject_type AND p.subject_id = expected.subject_id
           ) AS actual_proof,
           (SELECT outcome_sha256_json(d.gate) FROM outcome_projection.done_gate d
             WHERE d.tenant_id = expected.tenant_id AND d.project_id = expected.project_id
               AND d.subject_type = expected.subject_type AND d.subject_id = expected.subject_id
           ) AS actual_gate,
           (SELECT count(*) = 6
                   AND bool_and(rm.semantic_checksum = outcome_sha256_json(
                     outcome_projection.semantic_payload(
                       expected.result, expected.binding, expected.expected_gate,
                       expected.watermark_logical_time, expected.projection_revision,
                       COALESCE(s.projection_schema_version, 1)
                     )
                   ))
              FROM outcome_projection.read_model rm
             WHERE rm.tenant_id = expected.tenant_id AND rm.project_id = expected.project_id
               AND rm.subject_type = expected.subject_type AND rm.subject_id = expected.subject_id
           ) AS read_models_match,
           s.projection_schema_version, s.projection_checksum AS stored_projection_checksum,
           s.binding_digest AS projected_binding_digest,
           s.evaluated_through_logical_time AS projected_watermark,
           stream.last_logical_time AS stream_head,
           current_binding.binding_digest AS current_binding_digest
      FROM expected
      LEFT JOIN outcome_projection.reconciler_state s
        ON s.tenant_id = expected.tenant_id AND s.project_id = expected.project_id
       AND s.subject_type = expected.subject_type AND s.subject_id = expected.subject_id
      JOIN outcome_fact_stream stream
        ON stream.tenant_id = expected.tenant_id AND stream.project_id = expected.project_id
      JOIN LATERAL (
        SELECT binding_digest FROM outcome_fact_binding b
         WHERE b.tenant_id = expected.tenant_id AND b.project_id = expected.project_id
         ORDER BY binding_epoch DESC LIMIT 1
      ) current_binding ON true
  ), checks AS (
    SELECT calculated.*,
           outcome_projection.projection_checksum_value(
             COALESCE(calculated.projection_schema_version, 1),
             calculated.binding_digest::text, calculated.watermark_logical_time,
             calculated.expected_rows, calculated.expected_proof,
             calculated.expected_gate_checksum
           ) AS expected_projection,
           CASE WHEN calculated.actual_proof IS NULL OR calculated.actual_gate IS NULL THEN NULL
             ELSE outcome_projection.projection_checksum_value(
               calculated.projection_schema_version,
               calculated.projected_binding_digest::text, calculated.projected_watermark,
               calculated.actual_rows, calculated.actual_proof, calculated.actual_gate
             ) END AS actual_projection
      FROM calculated
  )
  SELECT checks.tenant_id, checks.project_id, checks.subject_type, checks.subject_id,
         checks.evaluation_id,
         CASE
           WHEN checks.stored_projection_checksum IS NULL THEN 'MISSING'
           WHEN checks.projected_binding_digest <> checks.current_binding_digest
             OR checks.projected_watermark <> checks.stream_head THEN 'RECONCILER_STALE'
           WHEN checks.expected_projection <> checks.actual_projection
             OR checks.stored_projection_checksum::text <> checks.actual_projection
             OR NOT COALESCE(checks.read_models_match, false) THEN 'CHECKSUM_MISMATCH'
           ELSE 'MATCH'
         END,
         checks.expected_projection, checks.actual_projection,
         checks.expected_proof, checks.actual_proof
    FROM checks
   ORDER BY checks.tenant_id, checks.project_id, checks.subject_type, checks.subject_id
$$ LANGUAGE sql STABLE SECURITY DEFINER
   SET search_path = pg_catalog, public, outcome_projection;

CREATE OR REPLACE FUNCTION outcome_projection.reconcile_subject(
  p_tenant_id uuid,
  p_project_id uuid,
  p_subject_type text,
  p_subject_id text,
  p_projection_schema_version integer DEFAULT 1,
  p_reducer_version text DEFAULT 'outcome-projection-reducer-v1'
) RETURNS jsonb AS $$
DECLARE
  evaluation_id_value uuid;
BEGIN
  SELECT r.evaluation_id INTO evaluation_id_value
    FROM outcome_evaluator_result r
    JOIN outcome_fact_binding b
      ON b.tenant_id = r.tenant_id AND b.project_id = r.project_id
     AND b.binding_digest = r.binding_digest
   WHERE r.tenant_id = p_tenant_id AND r.project_id = p_project_id
     AND r.subject_type = p_subject_type AND r.subject_id = p_subject_id
   ORDER BY b.binding_epoch DESC, r.watermark_logical_time DESC,
            r.evaluator_digest DESC, r.evaluation_id DESC
   LIMIT 1;
  IF evaluation_id_value IS NULL THEN
    RAISE EXCEPTION 'OUTCOME_PROJECTION_SOURCE_EVALUATION_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;
  RETURN outcome_projection.reduce_evaluation(
    evaluation_id_value, p_projection_schema_version, p_reducer_version,
    'CHECKSUM_RECONCILE', NULL
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER
   SET search_path = pg_catalog, public, outcome_projection;

CREATE OR REPLACE FUNCTION outcome_projection.read_surface(
  p_authenticated_tenant uuid,
  p_project_id uuid,
  p_subject_type text,
  p_subject_id text,
  p_surface text
) RETURNS jsonb AS $$
DECLARE
  model_row outcome_projection.read_model%ROWTYPE;
  state_row outcome_projection.reconciler_state%ROWTYPE;
  stream_head bigint;
  current_binding_digest text;
  current_evaluator_digest text;
  stale boolean;
BEGIN
  IF p_surface NOT IN (
    'DONE_GATE', 'AGENT_QUEUE', 'OWNER_DECISION_INBOX',
    'PROJECT_ATTENTION', 'MUTATION_RESPONSE', 'WEB'
  ) THEN
    RAISE EXCEPTION 'OUTCOME_PROJECTION_SURFACE_UNKNOWN:%', p_surface USING ERRCODE = '22023';
  END IF;
  SELECT s.last_logical_time, b.binding_digest::text, b.binding->>'evaluatorDigest'
    INTO stream_head, current_binding_digest, current_evaluator_digest
    FROM outcome_fact_stream s
    JOIN LATERAL (
      SELECT binding_digest, binding FROM outcome_fact_binding current_binding
       WHERE current_binding.tenant_id = s.tenant_id
         AND current_binding.project_id = s.project_id
       ORDER BY binding_epoch DESC LIMIT 1
    ) b ON true
   WHERE s.tenant_id = p_authenticated_tenant AND s.project_id = p_project_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'OUTCOME_PROJECTION_STREAM_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;
  SELECT * INTO model_row
    FROM outcome_projection.read_model
   WHERE tenant_id = p_authenticated_tenant AND project_id = p_project_id
     AND subject_type = p_subject_type AND subject_id = p_subject_id AND surface = p_surface
   LIMIT 1;
  SELECT * INTO state_row
    FROM outcome_projection.reconciler_state
   WHERE tenant_id = p_authenticated_tenant AND project_id = p_project_id
     AND subject_type = p_subject_type AND subject_id = p_subject_id
   LIMIT 1;
  stale := model_row.tenant_id IS NULL OR state_row.tenant_id IS NULL
    OR model_row.binding_digest::text IS DISTINCT FROM current_binding_digest
    OR model_row.evaluator_digest::text IS DISTINCT FROM current_evaluator_digest
    OR model_row.evaluated_through_logical_time IS DISTINCT FROM stream_head
    OR state_row.binding_digest::text IS DISTINCT FROM current_binding_digest
    OR state_row.evaluated_through_logical_time IS DISTINCT FROM stream_head
    OR model_row.semantic_checksum::text IS DISTINCT FROM state_row.semantic_checksum::text;
  IF stale THEN
    -- Deliberately omit `obligations`: an empty array would be an actionable claim that no work is
    -- due.  RECONCILER_STALE is a control-plane error and every surface receives the same identity.
    RETURN jsonb_build_object(
      'schemaVersion', COALESCE(state_row.projection_schema_version, 1),
      'surface', p_surface,
      'staleness', 'RECONCILER_STALE',
      'error', jsonb_build_object(
        'code', 'RECONCILER_STALE',
        'message', 'Projection watermark or semantic binding is behind the canonical fact stream.',
        'currentBindingDigest', current_binding_digest,
        'canonicalWatermarkLogicalTime', stream_head::text,
        'projectedBindingDigest', model_row.binding_digest::text,
        'evaluatedThroughLogicalTime', model_row.evaluated_through_logical_time::text,
        'nextAction', 'RECOVER_RECONCILER'
      ),
      'canonicalIdentity', COALESCE(model_row.semantic_identity, jsonb_build_object(
        'bindingDigest', current_binding_digest,
        'evaluatedThroughLogicalTime', NULL,
        'projectionRevision', NULL,
        'proofDigest', NULL
      ))
    );
  END IF;
  RETURN model_row.payload;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER
   SET search_path = pg_catalog, public, outcome_projection;

CREATE OR REPLACE FUNCTION outcome_projection.evaluator_result_reducer_trigger()
RETURNS trigger AS $$
BEGIN
  PERFORM outcome_projection.reduce_evaluation(
    NEW.evaluation_id, 1, 'outcome-projection-reducer-v1', 'INCREMENTAL', NULL
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER
   SET search_path = pg_catalog, public, outcome_projection;

CREATE TRIGGER outcome_evaluator_result_projection_reduce
  AFTER INSERT ON outcome_evaluator_result
  FOR EACH ROW EXECUTE FUNCTION outcome_projection.evaluator_result_reducer_trigger();

DO $$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'reconciler_state', 'obligation', 'proof', 'done_gate', 'read_model', 'outbox', 'rebuild_run'
  ] LOOP
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE INSERT OR UPDATE OR DELETE ON outcome_projection.%I '
      || 'FOR EACH ROW EXECUTE FUNCTION outcome_projection.write_guard()',
      'outcome_projection_' || table_name || '_write_guard', table_name
    );
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE TRUNCATE ON outcome_projection.%I '
      || 'FOR EACH STATEMENT EXECUTE FUNCTION outcome_projection.write_guard()',
      'outcome_projection_' || table_name || '_truncate_guard', table_name
    );
  END LOOP;
END;
$$;
CREATE TRIGGER outcome_projection_outbox_append_only
  BEFORE UPDATE OR DELETE ON outcome_projection.outbox
  FOR EACH ROW EXECUTE FUNCTION outcome_projection.outbox_append_only_guard();

REVOKE ALL ON ALL TABLES IN SCHEMA outcome_projection FROM PUBLIC;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA outcome_projection FROM PUBLIC;

COMMENT ON SCHEMA outcome_projection IS
  'Disposable Outcome Reconciler read side. Public canonical ledgers never depend on this schema.';
COMMENT ON TABLE outcome_projection.reconciler_state IS
  'One checksum-bearing reducer checkpoint per semantic subject; freshness is verified at read time.';
COMMENT ON TABLE outcome_projection.obligation IS
  'Disposable active obligation rows. Every row carries the full semantic binding stamp.';
COMMENT ON TABLE outcome_projection.proof IS
  'Disposable proof/proof-graph materialization from one immutable evaluator result.';
COMMENT ON TABLE outcome_projection.done_gate IS
  'Fail-closed done gate using the same obligation identity served by every other read surface.';
COMMENT ON TABLE outcome_projection.read_model IS
  'Six bounded indexed read surfaces over one canonical semantic payload.';
COMMENT ON TABLE outcome_projection.outbox IS
  'Append-only transactional projection outbox, inserted in the evaluator-result transaction.';
COMMENT ON FUNCTION outcome_projection.full_rebuild IS
  'Truncates only disposable projection tables and replays latest immutable evaluator results.';
COMMENT ON FUNCTION outcome_projection.shadow_compare IS
  'Recomputes rowset/proof/gate checksums and reports MATCH, MISSING, STALE or CHECKSUM_MISMATCH.';
COMMENT ON FUNCTION outcome_projection.read_surface IS
  'Bounded target-index read; a missing/lagging projection returns RECONCILER_STALE, never empty work.';

-- Backfill any evaluator results committed between migrations 0195 and 0196.  On a fresh database
-- this is an empty, checksum-bearing rebuild and proves the migration has no projection dependency.
SELECT outcome_projection.full_rebuild(1, 'outcome-projection-reducer-v1');

COMMIT;
