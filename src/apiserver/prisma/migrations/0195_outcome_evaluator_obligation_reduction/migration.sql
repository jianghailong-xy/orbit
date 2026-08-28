-- Outcome Reconciler V2: linearizable evaluator publication and stable mandatory obligations.
--
-- The evaluator result is immutable evidence about one exact (binding, cut watermark, evaluator)
-- tuple. outcome_active_obligation is only a rebuildable current projection; every activation and
-- terminal reduction is retained in the append-only event ledger. The commit function takes the
-- same outcome_fact_stream lock used by append, seal and binding replacement, making a concurrent
-- writer land wholly before or wholly after the evaluation.
BEGIN;

CREATE TABLE outcome_evaluator_result (
  evaluation_id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  project_id uuid NOT NULL,
  subject_type text NOT NULL CHECK (subject_type <> ''),
  subject_id text NOT NULL CHECK (subject_id <> ''),
  binding_digest char(64) NOT NULL CHECK (outcome_valid_digest(binding_digest)),
  cut_id uuid NOT NULL,
  watermark_logical_time bigint NOT NULL CHECK (watermark_logical_time >= 0),
  evaluator_version text NOT NULL CHECK (evaluator_version <> ''),
  evaluator_digest char(64) NOT NULL CHECK (outcome_valid_digest(evaluator_digest)),
  evaluation_digest char(64) NOT NULL CHECK (outcome_valid_digest(evaluation_digest)),
  proof_digest char(64) NOT NULL CHECK (outcome_valid_digest(proof_digest)),
  result_digest char(64) NOT NULL CHECK (outcome_valid_digest(result_digest)),
  is_closed boolean NOT NULL,
  result jsonb NOT NULL,
  committed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (tenant_id, project_id, binding_digest, watermark_logical_time, evaluator_digest),
  UNIQUE (tenant_id, project_id, evaluation_digest),
  FOREIGN KEY (tenant_id, project_id, cut_id)
    REFERENCES outcome_evaluation_cut(tenant_id, project_id, cut_id),
  FOREIGN KEY (tenant_id, project_id, binding_digest)
    REFERENCES outcome_fact_binding(tenant_id, project_id, binding_digest)
);

CREATE INDEX outcome_evaluator_result_subject_idx
  ON outcome_evaluator_result (
    tenant_id, project_id, subject_type, subject_id, watermark_logical_time DESC, committed_at DESC
  );

CREATE TABLE outcome_obligation_revision (
  tenant_id uuid NOT NULL,
  project_id uuid NOT NULL,
  obligation_id char(64) NOT NULL CHECK (outcome_valid_digest(obligation_id)),
  obligation_revision char(64) NOT NULL CHECK (outcome_valid_digest(obligation_revision)),
  binding_digest char(64) NOT NULL CHECK (outcome_valid_digest(binding_digest)),
  goal_id text NOT NULL CHECK (goal_id <> ''),
  goal_revision bigint NOT NULL CHECK (goal_revision >= 0),
  kind text NOT NULL CHECK (kind <> ''),
  mandatory boolean NOT NULL CHECK (mandatory),
  obligation jsonb NOT NULL,
  obligation_digest char(64) NOT NULL CHECK (outcome_valid_digest(obligation_digest)),
  first_evaluation_id uuid NOT NULL REFERENCES outcome_evaluator_result(evaluation_id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, project_id, obligation_revision),
  UNIQUE (tenant_id, project_id, obligation_id, obligation_revision),
  FOREIGN KEY (tenant_id, project_id, binding_digest)
    REFERENCES outcome_fact_binding(tenant_id, project_id, binding_digest)
);

CREATE TABLE outcome_obligation_event (
  event_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id uuid NOT NULL,
  project_id uuid NOT NULL,
  obligation_id char(64) NOT NULL CHECK (outcome_valid_digest(obligation_id)),
  obligation_revision char(64) NOT NULL CHECK (outcome_valid_digest(obligation_revision)),
  from_state text CHECK (from_state IS NULL OR from_state = 'ACTIVE'),
  to_state text NOT NULL CHECK (to_state IN (
    'ACTIVE', 'RESOLVED', 'CANCELLED', 'SUPERSEDED', 'ESCALATED', 'TIMED_OUT'
  )),
  evaluation_id uuid NOT NULL REFERENCES outcome_evaluator_result(evaluation_id),
  evaluated_through_logical_time bigint NOT NULL CHECK (evaluated_through_logical_time >= 0),
  reason_code text NOT NULL CHECK (reason_code <> ''),
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (tenant_id, project_id, obligation_revision)
    REFERENCES outcome_obligation_revision(tenant_id, project_id, obligation_revision)
);

CREATE INDEX outcome_obligation_event_identity_idx
  ON outcome_obligation_event (tenant_id, project_id, obligation_id, event_id);

-- Disposable current set. It cannot feed the evaluator; outcome_commit_evaluation rebuilds it from
-- the immutable result and records every disappearance in outcome_obligation_event first.
CREATE TABLE outcome_active_obligation (
  tenant_id uuid NOT NULL,
  project_id uuid NOT NULL,
  obligation_id char(64) NOT NULL CHECK (outcome_valid_digest(obligation_id)),
  obligation_revision char(64) NOT NULL CHECK (outcome_valid_digest(obligation_revision)),
  binding_digest char(64) NOT NULL CHECK (outcome_valid_digest(binding_digest)),
  goal_id text NOT NULL CHECK (goal_id <> ''),
  goal_revision bigint NOT NULL CHECK (goal_revision >= 0),
  kind text NOT NULL CHECK (kind <> ''),
  evaluation_id uuid NOT NULL REFERENCES outcome_evaluator_result(evaluation_id),
  evaluated_through_logical_time bigint NOT NULL CHECK (evaluated_through_logical_time >= 0),
  obligation jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, project_id, obligation_id),
  UNIQUE (tenant_id, project_id, obligation_revision),
  FOREIGN KEY (tenant_id, project_id, obligation_revision)
    REFERENCES outcome_obligation_revision(tenant_id, project_id, obligation_revision)
);

-- Stable identity already makes these collide; this second, semantic key fails closed even if a
-- future evaluator accidentally changes that identity formula.
CREATE UNIQUE INDEX outcome_one_active_successor_idx
  ON outcome_active_obligation (tenant_id, project_id, goal_id, goal_revision, kind)
  WHERE kind = 'START_SUCCESSOR_ATTEMPT';

CREATE TRIGGER outcome_evaluator_result_append_only
  BEFORE UPDATE OR DELETE ON outcome_evaluator_result
  FOR EACH ROW EXECUTE FUNCTION outcome_append_only_guard();
CREATE TRIGGER outcome_obligation_revision_append_only
  BEFORE UPDATE OR DELETE ON outcome_obligation_revision
  FOR EACH ROW EXECUTE FUNCTION outcome_append_only_guard();
CREATE TRIGGER outcome_obligation_event_append_only
  BEFORE UPDATE OR DELETE ON outcome_obligation_event
  FOR EACH ROW EXECUTE FUNCTION outcome_append_only_guard();

CREATE OR REPLACE FUNCTION outcome_commit_evaluation(
  p_authenticated_tenant uuid,
  p_project_id uuid,
  p_subject_type text,
  p_subject_id text,
  p_cut_id uuid,
  p_expected_binding_digest text,
  p_expected_watermark_logical_time bigint,
  p_evaluator_version text,
  p_evaluator_digest text,
  p_evaluation jsonb
) RETURNS jsonb AS $$
DECLARE
  stream_head bigint;
  current_binding outcome_fact_binding%ROWTYPE;
  cut_value outcome_evaluation_cut%ROWTYPE;
  expected_evaluator_digest text;
  evaluation_digest_value text;
  proof_digest_value text;
  result_digest_value text;
  closed_value boolean;
  existing outcome_evaluator_result%ROWTYPE;
  evaluation_id_value uuid;
  obligation_value jsonb;
  old_active outcome_active_obligation%ROWTYPE;
  new_for_old jsonb;
  old_terminal_state text;
  old_reason text;
  revision_digest_value text;
  was_active boolean;
  active_count integer;
BEGIN
  IF COALESCE(p_subject_type, '') = '' OR COALESCE(p_subject_id, '') = ''
     OR COALESCE(p_evaluator_version, '') = ''
     OR NOT COALESCE(outcome_valid_digest(p_expected_binding_digest), false)
     OR NOT COALESCE(outcome_valid_digest(p_evaluator_digest), false)
     OR p_expected_watermark_logical_time < 0
     OR jsonb_typeof(p_evaluation) <> 'object' THEN
    RAISE EXCEPTION 'OUTCOME_EVALUATION_COMMIT_INVALID' USING ERRCODE = '22023';
  END IF;

  -- The result's self-digests are independently recomputed before taking the stream lock. A
  -- malformed or nondeterministically encoded evaluator cannot acquire the publication boundary.
  evaluation_digest_value := outcome_sha256_json(p_evaluation - 'evaluationDigest');
  IF p_evaluation->>'evaluationDigest' IS DISTINCT FROM evaluation_digest_value
     OR jsonb_typeof(p_evaluation->'proof') <> 'object'
     OR jsonb_typeof(p_evaluation->'proofGraph') <> 'object'
     OR jsonb_typeof(p_evaluation->'activeMandatoryObligations') <> 'array'
     OR jsonb_typeof(p_evaluation#>'{proof,dimensions}') <> 'array'
     OR jsonb_typeof(p_evaluation#>'{proof,modelGaps}') <> 'array'
     OR jsonb_typeof(p_evaluation#>'{proof,closedClauseResults}') <> 'object'
     OR jsonb_typeof(p_evaluation#>'{proofGraph,leaves}') <> 'array' THEN
    RAISE EXCEPTION 'OUTCOME_EVALUATION_RESULT_SHAPE_INVALID' USING ERRCODE = '22023';
  END IF;
  proof_digest_value := outcome_sha256_json((p_evaluation->'proof') - 'proofDigest');
  result_digest_value := outcome_sha256_json(p_evaluation);
  IF p_evaluation#>>'{proof,proofDigest}' IS DISTINCT FROM proof_digest_value
     OR p_evaluation#>>'{proof,proofGraphDigest}' IS DISTINCT FROM outcome_sha256_json(p_evaluation->'proofGraph')
     OR p_evaluation->>'bindingDigest' IS DISTINCT FROM p_expected_binding_digest
     OR p_evaluation->>'evaluatedThroughLogicalTime' IS DISTINCT FROM p_expected_watermark_logical_time::text
     OR p_evaluation#>>'{proof,evaluatedThroughLogicalTime}' IS DISTINCT FROM p_expected_watermark_logical_time::text
     OR p_evaluation->>'evaluatorVersion' IS DISTINCT FROM p_evaluator_version
     OR p_evaluation#>>'{proof,evaluatorVersion}' IS DISTINCT FROM p_evaluator_version
     OR p_evaluation->>'evaluatorDigest' IS DISTINCT FROM p_evaluator_digest
     OR jsonb_typeof(p_evaluation->'closed') <> 'boolean'
     OR jsonb_typeof(p_evaluation#>'{proof,closed}') <> 'boolean'
     OR (p_evaluation->>'closed')::boolean IS DISTINCT FROM (p_evaluation#>>'{proof,closed}')::boolean THEN
    RAISE EXCEPTION 'OUTCOME_EVALUATION_DIGEST_OR_BINDING_INVALID' USING ERRCODE = '22000';
  END IF;
  closed_value := (p_evaluation->>'closed')::boolean;

  -- Totality at the storage boundary: exactly one result for every required dimension, even when
  -- that result is UNKNOWN. Unknown/extra states and duplicate/omitted dimensions are refused.
  IF jsonb_array_length(p_evaluation#>'{proof,dimensions}') <> 15 OR EXISTS (
    WITH required(id, na_allowed) AS (VALUES
      ('GOAL_DISPOSITION', false), ('CONTRACT_RATIFICATION', false),
      ('CRITERIA_EVALUATION', false), ('FACT_CUT_INTEGRITY', false),
      ('EVIDENCE_TRUST', false), ('BINDING_FRESHNESS', false),
      ('AUTHORITY_VALIDITY', false), ('POLICY_COMPLIANCE', false),
      ('BUDGET_COMPLIANCE', false), ('ARTIFACT_INTEGRATION', true),
      ('TARGET_PRESENCE', true), ('POST_MERGE_VERIFICATION', true),
      ('EXTERNAL_CLOSURE_DEPENDENCIES', true), ('ACTION_REMEDIATION', true),
      ('MODEL_COVERAGE', false)
    )
    SELECT 1
      FROM required r
     WHERE (SELECT count(*) FROM jsonb_array_elements(p_evaluation#>'{proof,dimensions}') d
             WHERE d->>'dimensionId' = r.id) <> 1
        OR EXISTS (
          SELECT 1 FROM jsonb_array_elements(p_evaluation#>'{proof,dimensions}') d
           WHERE d->>'dimensionId' = r.id
             AND (d->>'state' NOT IN ('SATISFIED', 'UNSATISFIED', 'UNKNOWN', 'CONFLICT', 'NOT_APPLICABLE')
               OR (d->>'state' = 'NOT_APPLICABLE' AND NOT r.na_allowed))
        )
  ) THEN
    RAISE EXCEPTION 'OUTCOME_REQUIRED_DIMENSION_SET_INVALID' USING ERRCODE = '23514';
  END IF;

  -- Every non-terminal dimension must have a mandatory active obligation that explicitly blocks
  -- that dimension. This makes omission a failed commit, not a lost work item.
  IF EXISTS (
    SELECT 1
      FROM jsonb_array_elements(p_evaluation#>'{proof,dimensions}') d
     WHERE d->>'state' NOT IN ('SATISFIED', 'NOT_APPLICABLE')
       AND NOT EXISTS (
         SELECT 1
           FROM jsonb_array_elements(p_evaluation->'activeMandatoryObligations') o
          WHERE o->>'state' = 'ACTIVE'
            AND o->>'mandatory' = 'true'
            AND COALESCE(o->'blocksClosureOf', '[]'::jsonb) ? (d->>'dimensionId')
       )
  ) THEN
    RAISE EXCEPTION 'OUTCOME_LOST_OBLIGATION' USING ERRCODE = '23514';
  END IF;
  IF jsonb_array_length(p_evaluation#>'{proof,modelGaps}') > 0 AND NOT EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_evaluation->'activeMandatoryObligations') o
     WHERE o->>'kind' = 'DIAGNOSE_MODEL_GAP' AND o->>'state' = 'ACTIVE'
  ) THEN
    RAISE EXCEPTION 'OUTCOME_MODEL_GAP_WITHOUT_DIAGNOSIS' USING ERRCODE = '23514';
  END IF;

  PERFORM 1 FROM outcome_fact_stream
   WHERE tenant_id = p_authenticated_tenant AND project_id = p_project_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'OUTCOME_EVALUATION_STREAM_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;
  SELECT last_logical_time INTO stream_head
    FROM outcome_fact_stream
   WHERE tenant_id = p_authenticated_tenant AND project_id = p_project_id;
  SELECT * INTO current_binding
    FROM outcome_fact_binding
   WHERE tenant_id = p_authenticated_tenant AND project_id = p_project_id
   ORDER BY binding_epoch DESC LIMIT 1;
  SELECT * INTO cut_value
    FROM outcome_evaluation_cut
   WHERE tenant_id = p_authenticated_tenant AND project_id = p_project_id AND cut_id = p_cut_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'OUTCOME_EVALUATION_CUT_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;
  IF stream_head IS DISTINCT FROM p_expected_watermark_logical_time
     OR current_binding.binding_digest::text IS DISTINCT FROM p_expected_binding_digest
     OR cut_value.binding_digest::text IS DISTINCT FROM p_expected_binding_digest
     OR cut_value.watermark_logical_time IS DISTINCT FROM p_expected_watermark_logical_time
     OR NOT cut_value.complete OR NOT cut_value.linearizable THEN
    RAISE EXCEPTION 'OUTCOME_EXPECTED_BINDING_WATERMARK_STALE' USING ERRCODE = '40001';
  END IF;
  expected_evaluator_digest := outcome_sha256_json(jsonb_build_object(
    'id', 'OUTCOME_RECONCILER', 'version', p_evaluator_version
  ));
  IF expected_evaluator_digest IS DISTINCT FROM p_evaluator_digest
     OR current_binding.binding->>'evaluatorDigest' IS DISTINCT FROM p_evaluator_digest
     OR current_binding.subject_type IS DISTINCT FROM p_subject_type
     OR current_binding.subject_id IS DISTINCT FROM p_subject_id
     OR p_evaluation#>>'{proof,factCutDigest}' IS DISTINCT FROM cut_value.fact_set_digest::text
     OR p_evaluation#>>'{proof,contractDigest}' IS DISTINCT FROM current_binding.binding->>'contractDigest'
     OR p_evaluation#>>'{proof,evaluationPlanDigest}' IS DISTINCT FROM current_binding.binding->>'evaluationPlanDigest' THEN
    RAISE EXCEPTION 'OUTCOME_EVALUATOR_OR_CUT_BINDING_MISMATCH' USING ERRCODE = '40001';
  END IF;

  -- A second result for the same immutable input is an idempotent replay only when every semantic
  -- byte agrees. Otherwise the supposedly pure evaluator is nondeterministic and fails closed.
  SELECT * INTO existing
    FROM outcome_evaluator_result
   WHERE tenant_id = p_authenticated_tenant AND project_id = p_project_id
     AND binding_digest = p_expected_binding_digest
     AND watermark_logical_time = p_expected_watermark_logical_time
     AND evaluator_digest = p_evaluator_digest;
  IF FOUND THEN
    IF existing.evaluation_digest::text IS DISTINCT FROM evaluation_digest_value
       OR existing.result_digest::text IS DISTINCT FROM result_digest_value THEN
      RAISE EXCEPTION 'OUTCOME_EVALUATOR_NONDETERMINISTIC' USING ERRCODE = '23514';
    END IF;
    SELECT count(*)::integer INTO active_count
      FROM outcome_active_obligation
     WHERE tenant_id = p_authenticated_tenant AND project_id = p_project_id;
    RETURN jsonb_build_object(
      'evaluationId', existing.evaluation_id::text,
      'evaluationDigest', evaluation_digest_value,
      'bindingDigest', p_expected_binding_digest,
      'watermarkLogicalTime', p_expected_watermark_logical_time::text,
      'closed', existing.is_closed,
      'replayed', true,
      'activeMandatoryObligations', active_count
    );
  END IF;

  IF closed_value THEN
    IF cut_value.fact_count = 0
       OR EXISTS (
         SELECT 1 FROM jsonb_array_elements(p_evaluation#>'{proof,dimensions}') d
          WHERE d->>'state' NOT IN ('SATISFIED', 'NOT_APPLICABLE')
             OR jsonb_typeof(d->'evidenceFactIds') <> 'array'
             OR jsonb_array_length(d->'evidenceFactIds') = 0
       )
       OR jsonb_array_length(p_evaluation#>'{proof,modelGaps}') <> 0
       OR jsonb_array_length(p_evaluation->'activeMandatoryObligations') <> 0
       OR EXISTS (
         SELECT 1 FROM jsonb_each(p_evaluation#>'{proof,closedClauseResults}') clause
          WHERE jsonb_typeof(clause.value) <> 'boolean' OR clause.value <> 'true'::jsonb
       )
       OR (SELECT count(*) FROM jsonb_each(p_evaluation#>'{proof,closedClauseResults}')) <> 14
       OR NOT (p_evaluation#>'{proof,closedClauseResults}' ?& ARRAY[
         'CONTRACT_RATIFIED_FOR_EXACT_CONTRACT_DIGEST',
         'EVALUATION_PLAN_MATCHES_EXACT_EVALUATION_PLAN_DIGEST',
         'FACT_CUT_IS_COMPLETE_LINEARIZABLE_AND_TRUSTED',
         'EVALUATOR_VERSION_AND_DIGEST_MATCH_BINDING',
         'EVERY_MANDATORY_DIMENSION_IS_SATISFIED_OR_PROVEN_NOT_APPLICABLE',
         'NO_UNKNOWN_DIMENSION', 'NO_UNSATISFIED_DIMENSION', 'NO_CONFLICT_DIMENSION',
         'NO_MODEL_GAP', 'GOAL_DISPOSITION_IS_ACHIEVED',
         'NO_ACTIVE_MANDATORY_OBLIGATION', 'NO_STALE_OR_REVOKED_BINDING',
         'NO_UNREMEDIATED_SIDE_EFFECT', 'ALL_EXTERNAL_CLOSURE_DEPENDENCIES_SETTLED'
       ])
       OR p_evaluation#>>'{proofGraph,root,closed}' IS DISTINCT FROM 'true'
       OR EXISTS (
         SELECT 1 FROM jsonb_array_elements(p_evaluation#>'{proofGraph,leaves}') leaf
          WHERE leaf->>'authoritative' IS DISTINCT FROM 'true'
             OR leaf->>'trustDecision' IS DISTINCT FROM 'TRUSTED'
             OR leaf->>'proofEligible' IS DISTINCT FROM 'true'
             OR leaf->>'factId' !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
             OR NOT EXISTS (
               SELECT 1 FROM outcome_evaluation_cut_fact cf
                WHERE cf.tenant_id = p_authenticated_tenant
                  AND cf.project_id = p_project_id
                  AND cf.cut_id = p_cut_id
                  AND cf.fact_id = (leaf->>'factId')::uuid
                  AND cf.trust_decision = 'TRUSTED'
                  AND cf.proof_eligible
             )
       )
       OR EXISTS (
         SELECT 1
           FROM jsonb_array_elements(p_evaluation#>'{proof,dimensions}') d,
                jsonb_array_elements_text(d->'evidenceFactIds') evidence(fact_id)
          WHERE NOT EXISTS (
            SELECT 1 FROM jsonb_array_elements(p_evaluation#>'{proofGraph,leaves}') leaf
             WHERE leaf->>'factId' = evidence.fact_id
          )
       ) THEN
      RAISE EXCEPTION 'OUTCOME_FALSE_CLOSE_REFUSED' USING ERRCODE = '23514';
    END IF;
  END IF;

  -- Validate active identities before any durable write.
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_evaluation->'activeMandatoryObligations') o
     WHERE o->>'state' IS DISTINCT FROM 'ACTIVE'
        OR o->>'mandatory' IS DISTINCT FROM 'true'
        OR NOT COALESCE(outcome_valid_digest(o->>'obligationId'), false)
        OR NOT COALESCE(outcome_valid_digest(o->>'obligationRevision'), false)
        OR o->>'bindingDigest' IS DISTINCT FROM p_expected_binding_digest
        OR o->>'goalId' IS DISTINCT FROM current_binding.goal_id
        OR o->>'goalRevision' IS DISTINCT FROM current_binding.goal_revision::text
  ) OR EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_evaluation->'activeMandatoryObligations') o
     GROUP BY o->>'obligationId' HAVING count(*) > 1
  ) OR (
    SELECT count(*) FROM jsonb_array_elements(p_evaluation->'activeMandatoryObligations') o
     WHERE o->>'kind' = 'START_SUCCESSOR_ATTEMPT'
  ) > 1 THEN
    RAISE EXCEPTION 'OUTCOME_ACTIVE_OBLIGATION_SET_INVALID' USING ERRCODE = '23514';
  END IF;

  evaluation_id_value := gen_random_uuid();
  INSERT INTO outcome_evaluator_result (
    evaluation_id, tenant_id, project_id, subject_type, subject_id, binding_digest,
    cut_id, watermark_logical_time, evaluator_version, evaluator_digest,
    evaluation_digest, proof_digest, result_digest, is_closed, result
  ) VALUES (
    evaluation_id_value, p_authenticated_tenant, p_project_id, p_subject_type, p_subject_id,
    p_expected_binding_digest, p_cut_id, p_expected_watermark_logical_time,
    p_evaluator_version, p_evaluator_digest, evaluation_digest_value, proof_digest_value,
    result_digest_value, closed_value, p_evaluation
  );

  -- First terminate or supersede anything the new canonical reduction no longer emits. An absent
  -- obligation whose blocked dimension remains non-terminal is refused as a lost obligation.
  FOR old_active IN
    SELECT * FROM outcome_active_obligation
     WHERE tenant_id = p_authenticated_tenant AND project_id = p_project_id
     FOR UPDATE
  LOOP
    SELECT value INTO new_for_old
      FROM jsonb_array_elements(p_evaluation->'activeMandatoryObligations') item(value)
     WHERE value->>'obligationId' = old_active.obligation_id::text
     LIMIT 1;
    IF new_for_old IS NULL THEN
      IF old_active.binding_digest::text <> p_expected_binding_digest THEN
        old_terminal_state := 'SUPERSEDED';
        old_reason := 'BINDING_SUPERSEDED';
      ELSE
        IF old_active.kind = 'START_SUCCESSOR_ATTEMPT' AND EXISTS (
          SELECT 1 FROM jsonb_array_elements(COALESCE(p_evaluation->'attempts', '[]'::jsonb)) attempt
           WHERE attempt->>'status' IN ('OPEN', 'WINDING_DOWN')
              OR (attempt->>'status' = 'CLOSED' AND attempt->>'outcome' = 'SUCCEEDED')
        ) THEN
          old_terminal_state := 'RESOLVED';
          old_reason := 'SUCCESSOR_ATTEMPT_OBSERVED';
        ELSIF old_active.kind = 'DIAGNOSE_MODEL_GAP' AND NOT (
          p_evaluation#>'{proof,modelGaps}' ? (old_active.obligation#>>'{reason,code}')
        ) THEN
          old_terminal_state := 'RESOLVED';
          old_reason := 'MODEL_GAP_CLEARED';
        ELSIF EXISTS (
          SELECT 1 FROM jsonb_array_elements_text(old_active.obligation->'blocksClosureOf') blocked(dimension_id)
           WHERE NOT EXISTS (
             SELECT 1 FROM jsonb_array_elements(p_evaluation#>'{proof,dimensions}') d
              WHERE d->>'dimensionId' = blocked.dimension_id
                AND d->>'state' IN ('SATISFIED', 'NOT_APPLICABLE')
           )
        ) THEN
          RAISE EXCEPTION 'OUTCOME_LOST_OBLIGATION:%', old_active.obligation_id
            USING ERRCODE = '23514';
        ELSE
          old_terminal_state := 'RESOLVED';
          old_reason := 'AUTHORITATIVE_TERMINAL_DISPOSITION';
        END IF;
      END IF;
      INSERT INTO outcome_obligation_event (
        tenant_id, project_id, obligation_id, obligation_revision, from_state, to_state,
        evaluation_id, evaluated_through_logical_time, reason_code
      ) VALUES (
        p_authenticated_tenant, p_project_id, old_active.obligation_id,
        old_active.obligation_revision, 'ACTIVE', old_terminal_state, evaluation_id_value,
        p_expected_watermark_logical_time, old_reason
      );
      DELETE FROM outcome_active_obligation
       WHERE tenant_id = p_authenticated_tenant AND project_id = p_project_id
         AND obligation_id = old_active.obligation_id;
    ELSIF new_for_old->>'obligationRevision' <> old_active.obligation_revision::text THEN
      INSERT INTO outcome_obligation_event (
        tenant_id, project_id, obligation_id, obligation_revision, from_state, to_state,
        evaluation_id, evaluated_through_logical_time, reason_code
      ) VALUES (
        p_authenticated_tenant, p_project_id, old_active.obligation_id,
        old_active.obligation_revision, 'ACTIVE', 'SUPERSEDED', evaluation_id_value,
        p_expected_watermark_logical_time, 'OBLIGATION_REVISION_SUPERSEDED'
      );
      DELETE FROM outcome_active_obligation
       WHERE tenant_id = p_authenticated_tenant AND project_id = p_project_id
         AND obligation_id = old_active.obligation_id;
    END IF;
  END LOOP;

  FOR obligation_value IN
    SELECT value FROM jsonb_array_elements(p_evaluation->'activeMandatoryObligations') item(value)
     ORDER BY value->>'obligationId'
  LOOP
    revision_digest_value := outcome_sha256_json(obligation_value);
    INSERT INTO outcome_obligation_revision (
      tenant_id, project_id, obligation_id, obligation_revision, binding_digest,
      goal_id, goal_revision, kind, mandatory, obligation, obligation_digest,
      first_evaluation_id
    ) VALUES (
      p_authenticated_tenant, p_project_id, obligation_value->>'obligationId',
      obligation_value->>'obligationRevision', p_expected_binding_digest,
      obligation_value->>'goalId', (obligation_value->>'goalRevision')::bigint,
      obligation_value->>'kind', true, obligation_value, revision_digest_value,
      evaluation_id_value
    ) ON CONFLICT (tenant_id, project_id, obligation_revision) DO NOTHING;
    IF NOT EXISTS (
      SELECT 1 FROM outcome_obligation_revision r
       WHERE r.tenant_id = p_authenticated_tenant AND r.project_id = p_project_id
         AND r.obligation_revision = obligation_value->>'obligationRevision'
         AND r.obligation_id = obligation_value->>'obligationId'
         AND r.binding_digest = p_expected_binding_digest
         AND r.goal_id = obligation_value->>'goalId'
         AND r.goal_revision = (obligation_value->>'goalRevision')::bigint
         AND r.kind = obligation_value->>'kind'
    ) THEN
      RAISE EXCEPTION 'OUTCOME_OBLIGATION_REVISION_COLLISION' USING ERRCODE = '23505';
    END IF;

    SELECT EXISTS (
      SELECT 1 FROM outcome_active_obligation a
       WHERE a.tenant_id = p_authenticated_tenant AND a.project_id = p_project_id
         AND a.obligation_id = obligation_value->>'obligationId'
         AND a.obligation_revision = obligation_value->>'obligationRevision'
    ) INTO was_active;
    INSERT INTO outcome_active_obligation (
      tenant_id, project_id, obligation_id, obligation_revision, binding_digest,
      goal_id, goal_revision, kind, evaluation_id, evaluated_through_logical_time, obligation
    ) VALUES (
      p_authenticated_tenant, p_project_id, obligation_value->>'obligationId',
      obligation_value->>'obligationRevision', p_expected_binding_digest,
      obligation_value->>'goalId', (obligation_value->>'goalRevision')::bigint,
      obligation_value->>'kind', evaluation_id_value, p_expected_watermark_logical_time,
      obligation_value
    ) ON CONFLICT (tenant_id, project_id, obligation_id) DO UPDATE
      SET evaluation_id = EXCLUDED.evaluation_id,
          evaluated_through_logical_time = EXCLUDED.evaluated_through_logical_time,
          obligation = EXCLUDED.obligation,
          updated_at = clock_timestamp()
      WHERE outcome_active_obligation.obligation_revision = EXCLUDED.obligation_revision;
    IF NOT was_active THEN
      INSERT INTO outcome_obligation_event (
        tenant_id, project_id, obligation_id, obligation_revision, from_state, to_state,
        evaluation_id, evaluated_through_logical_time, reason_code
      ) VALUES (
        p_authenticated_tenant, p_project_id, obligation_value->>'obligationId',
        obligation_value->>'obligationRevision', NULL, 'ACTIVE', evaluation_id_value,
        p_expected_watermark_logical_time, obligation_value#>>'{reason,code}'
      );
    END IF;
  END LOOP;

  SELECT count(*)::integer INTO active_count
    FROM outcome_active_obligation
   WHERE tenant_id = p_authenticated_tenant AND project_id = p_project_id;
  RETURN jsonb_build_object(
    'evaluationId', evaluation_id_value::text,
    'evaluationDigest', evaluation_digest_value,
    'bindingDigest', p_expected_binding_digest,
    'watermarkLogicalTime', p_expected_watermark_logical_time::text,
    'closed', closed_value,
    'replayed', false,
    'activeMandatoryObligations', active_count
  );
END;
$$ LANGUAGE plpgsql;

CREATE VIEW outcome_current_evaluator_result AS
SELECT latest.*,
       (latest.binding_digest = current_binding.binding_digest
        AND latest.watermark_logical_time = stream.last_logical_time
        AND latest.evaluator_digest = current_binding.binding->>'evaluatorDigest') AS is_current,
       (latest.is_closed
        AND latest.binding_digest = current_binding.binding_digest
        AND latest.watermark_logical_time = stream.last_logical_time
        AND latest.evaluator_digest = current_binding.binding->>'evaluatorDigest') AS effective_closed
  FROM (
    SELECT DISTINCT ON (tenant_id, project_id, subject_type, subject_id) *
      FROM outcome_evaluator_result
     ORDER BY tenant_id, project_id, subject_type, subject_id,
              watermark_logical_time DESC, committed_at DESC, evaluation_id DESC
  ) latest
  JOIN outcome_fact_stream stream
    ON stream.tenant_id = latest.tenant_id AND stream.project_id = latest.project_id
  JOIN LATERAL (
    SELECT b.binding_digest, b.binding
      FROM outcome_fact_binding b
     WHERE b.tenant_id = latest.tenant_id AND b.project_id = latest.project_id
     ORDER BY b.binding_epoch DESC LIMIT 1
  ) current_binding ON true;

REVOKE INSERT, UPDATE, DELETE ON outcome_evaluator_result FROM PUBLIC;
REVOKE INSERT, UPDATE, DELETE ON outcome_obligation_revision FROM PUBLIC;
REVOKE INSERT, UPDATE, DELETE ON outcome_obligation_event FROM PUBLIC;
REVOKE INSERT, UPDATE, DELETE ON outcome_active_obligation FROM PUBLIC;

COMMENT ON FUNCTION outcome_commit_evaluation IS
  'Commits one deterministic evaluator result iff its expected binding and watermark are still current; atomically reduces active mandatory obligations.';
COMMENT ON TABLE outcome_obligation_event IS
  'Append-only obligation activation/terminal ledger. No active obligation may disappear without one event.';
COMMENT ON TABLE outcome_active_obligation IS
  'Rebuildable current mandatory-obligation projection; never an evaluator input.';
COMMENT ON VIEW outcome_current_evaluator_result IS
  'Only an exact current binding/watermark/evaluator result may be effectively closed.';

COMMIT;
