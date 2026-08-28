-- Outcome Reconciler V2: the DONE gate is a structured view of the current canonical
-- obligation/proof cut.
--
-- There is deliberately no read of project_blocker, project_judgment_blocker,
-- task_verification_failure, or any other independently writable boolean/string summary in this
-- migration.  Those tables remain compatibility/audit read models.  The only closure authority is
-- the immutable evaluator result for the exact current binding and canonical stream watermark;
-- the disposable projection must reproduce it byte-for-byte before the gate can allow DONE.
BEGIN;

CREATE OR REPLACE FUNCTION outcome_projection.obligation_blocks_project(
  p_obligation jsonb,
  p_project_id text
) RETURNS boolean AS $$
BEGIN
  IF COALESCE(jsonb_typeof(p_obligation#>'{ownership,blockingProjectIds}'), 'null') <> 'array' THEN
    RETURN false;
  END IF;
  RETURN EXISTS (
    SELECT 1
      FROM jsonb_array_elements_text(p_obligation#>'{ownership,blockingProjectIds}') project_id(value)
     WHERE project_id.value = p_project_id
  );
EXCEPTION WHEN OTHERS THEN
  RETURN false;
END;
$$ LANGUAGE plpgsql IMMUTABLE STRICT PARALLEL SAFE;

CREATE OR REPLACE FUNCTION outcome_projection.cross_project_attribution_valid(
  p_obligation jsonb,
  p_project_id text
) RETURNS boolean AS $$
DECLARE
  ownership jsonb := p_obligation->'ownership';
BEGIN
  IF COALESCE(jsonb_typeof(ownership), 'null') <> 'object'
     OR COALESCE(ownership->>'homeProjectId', '') = ''
     OR COALESCE(jsonb_typeof(p_obligation->'servesCriterionIds'), 'null') <> 'array'
     OR COALESCE(jsonb_typeof(p_obligation->'blocksClosureOf'), 'null') <> 'array'
     OR COALESCE(jsonb_typeof(ownership->'blockingProjectIds'), 'null') <> 'array' THEN
    RETURN false;
  END IF;
  IF ownership->>'homeProjectId' = p_project_id THEN
    RETURN outcome_projection.obligation_blocks_project(p_obligation, p_project_id)
       AND ownership->>'handoffStatus' = 'NOT_REQUIRED'
       AND ownership->'crossingId' = 'null'::jsonb
       AND ownership->'handoffId' = 'null'::jsonb;
  END IF;
  -- A foreign obligation may block this project only through an explicit, accepted crossing.
  -- Merely serving one of this project's criteria is intentionally not a closure edge.
  RETURN outcome_projection.obligation_blocks_project(p_obligation, p_project_id)
     AND jsonb_array_length(p_obligation->'blocksClosureOf') > 0
     AND COALESCE(ownership->>'crossingId', '') <> ''
     AND COALESCE(ownership->>'handoffId', '') <> ''
     AND ownership->>'handoffStatus' = 'ACCEPTED'
     AND COALESCE(ownership->>'attributionDecisionFactId', '') <> '';
EXCEPTION WHEN OTHERS THEN
  RETURN false;
END;
$$ LANGUAGE plpgsql IMMUTABLE STRICT PARALLEL SAFE;

-- Same signature as 0196: reduce_evaluation and shadow_compare therefore pick up the richer gate
-- without acquiring a second writer or duplicating the projection reducer.
CREATE OR REPLACE FUNCTION outcome_projection.done_gate_value(
  p_result jsonb,
  p_proof_digest text,
  p_closed boolean,
  p_binding_digest text,
  p_watermark bigint,
  p_projection_revision bigint
) RETURNS jsonb AS $$
DECLARE
  required_dimensions constant text[] := ARRAY[
    'GOAL_DISPOSITION', 'CONTRACT_RATIFICATION', 'CRITERIA_EVALUATION',
    'FACT_CUT_INTEGRITY', 'EVIDENCE_TRUST', 'BINDING_FRESHNESS',
    'AUTHORITY_VALIDITY', 'POLICY_COMPLIANCE', 'BUDGET_COMPLIANCE',
    'ARTIFACT_INTEGRATION', 'TARGET_PRESENCE', 'POST_MERGE_VERIFICATION',
    'EXTERNAL_CLOSURE_DEPENDENCIES', 'ACTION_REMEDIATION', 'MODEL_COVERAGE'
  ];
  required_clauses constant text[] := ARRAY[
    'CONTRACT_RATIFIED_FOR_EXACT_CONTRACT_DIGEST',
    'EVALUATION_PLAN_MATCHES_EXACT_EVALUATION_PLAN_DIGEST',
    'FACT_CUT_IS_COMPLETE_LINEARIZABLE_AND_TRUSTED',
    'EVALUATOR_VERSION_AND_DIGEST_MATCH_BINDING',
    'EVERY_MANDATORY_DIMENSION_IS_SATISFIED_OR_PROVEN_NOT_APPLICABLE',
    'NO_UNKNOWN_DIMENSION', 'NO_UNSATISFIED_DIMENSION', 'NO_CONFLICT_DIMENSION',
    'NO_MODEL_GAP', 'GOAL_DISPOSITION_IS_ACHIEVED',
    'NO_ACTIVE_MANDATORY_OBLIGATION', 'NO_STALE_OR_REVOKED_BINDING',
    'NO_UNREMEDIATED_SIDE_EFFECT', 'ALL_EXTERNAL_CLOSURE_DEPENDENCIES_SETTLED'
  ];
  known_obligation_kinds constant text[] := ARRAY[
    'ESTABLISH_GOAL_DISPOSITION', 'SATISFY_COMPLETION_DIMENSION', 'REPAIR_FACT_CUT',
    'REFRESH_STALE_BINDING', 'PROVE_ARTIFACT_INTEGRATION', 'PROVE_TARGET_PRESENCE',
    'RUN_BOUND_VERIFICATION', 'DIAGNOSE_MODEL_GAP', 'START_SUCCESSOR_ATTEMPT',
    'MONITOR_EXTERNAL_WAIT', 'REQUEST_GOAL_DECISION', 'REQUEST_RISK_ACCEPTANCE',
    'REQUEST_NEW_AUTHORIZATION', 'REQUEST_EXTERNAL_IDENTITY', 'REMEDIATE_SIDE_EFFECT',
    'RECOVER_RECONCILER'
  ];
  proof_value jsonb;
  graph_value jsonb;
  dimensions_value jsonb;
  clauses_value jsonb;
  obligations_value jsonb;
  blocking_obligations jsonb := '[]'::jsonb;
  non_blocking_obligations jsonb := '[]'::jsonb;
  reasons jsonb := '[]'::jsonb;
  blocking_reasons jsonb;
  diagnostics jsonb;
  dimension_value jsonb;
  obligation_value jsonb;
  matching_obligation jsonb;
  primary_reason jsonb;
  primary_obligation jsonb;
  dimension_id text;
  dimension_state text;
  dimension_count integer;
  owner_value text;
  action_value text;
  current_project_id text := '';
  home_project_id text;
  obligation_known boolean;
  claims_current_project boolean;
  attribution_valid boolean;
  clause_name text;
  clause_value jsonb;
  gap_value jsonb;
  artifact_state text;
  target_state text;
  post_merge_state text;
  delivery_mode text := 'UNKNOWN';
  delivery_required text[] := ARRAY[]::text[];
  delivery_missing text[] := ARRAY[]::text[];
  ratification_valid boolean := false;
  allowed_value boolean := false;
  closure_conflict boolean := false;
  message_value text;
BEGIN
  IF COALESCE(jsonb_typeof(p_result), 'null') <> 'object'
     OR COALESCE(jsonb_typeof(p_result->'proof'), 'null') <> 'object'
     OR COALESCE(jsonb_typeof(p_result->'proofGraph'), 'null') <> 'object'
     OR COALESCE(jsonb_typeof(p_result->'activeMandatoryObligations'), 'null') <> 'array' THEN
    primary_reason := jsonb_build_object(
      'code', 'EVALUATOR_RESULT_UNKNOWN_TYPE',
      'category', 'MODEL_GAP',
      'message', 'The evaluator result is not a recognized canonical result object.',
      'owner', 'SYSTEM', 'actor', 'SYSTEM',
      'nextAction', 'outcome.evaluator.repair',
      'blocksGate', true,
      'evidenceFactIds', '[]'::jsonb,
      'attemptedActions', '[]'::jsonb
    );
    RETURN jsonb_build_object(
      'schemaVersion', 2, 'allowed', false, 'decision', 'DENY',
      'staleness', 'CURRENT',
      'canonicalIdentity', jsonb_build_object(
        'bindingDigest', p_binding_digest,
        'evaluatedThroughLogicalTime', p_watermark::text,
        'projectionRevision', p_projection_revision::text,
        'proofDigest', p_proof_digest
      ),
      'proof', p_result->'proof', 'proofGraph', p_result->'proofGraph',
      'reasons', jsonb_build_array(primary_reason),
      'blockingReasons', jsonb_build_array(primary_reason),
      'diagnostics', '[]'::jsonb,
      'reason', primary_reason,
      'obligations', '[]'::jsonb,
      'blockingObligations', '[]'::jsonb,
      'nonBlockingObligations', '[]'::jsonb,
      'owner', 'SYSTEM', 'actor', 'SYSTEM',
      'nextAction', 'outcome.evaluator.repair',
      'ratification', jsonb_build_object(
        'validOnEvaluationCut', false, 'effectiveNow', false,
        'owner', 'OWNER', 'nextAction', 'owner.ratification.review'
      ),
      'deliveryPolicy', jsonb_build_object(
        'mode', 'UNKNOWN', 'nextAction', 'outcome.evaluator.repair'
      ),
      'crossProject', jsonb_build_object(
        'servesCriterionDoesNotImplyBlocksClosure', true, 'implicitAdoption', false
      ),
      'compatibility', jsonb_build_object(
        'legacyBlockerSignalInputs', false,
        'projectionIsAuthority', false
      )
    );
  END IF;

  proof_value := p_result->'proof';
  graph_value := p_result->'proofGraph';
  dimensions_value := proof_value->'dimensions';
  clauses_value := proof_value->'closedClauseResults';
  obligations_value := p_result->'activeMandatoryObligations';
  IF COALESCE(jsonb_typeof(dimensions_value), 'null') <> 'array'
     OR COALESCE(jsonb_typeof(proof_value->'modelGaps'), 'null') <> 'array'
     OR COALESCE(jsonb_typeof(clauses_value), 'null') <> 'object' THEN
    primary_reason := jsonb_build_object(
      'code', 'EVALUATOR_PROOF_UNKNOWN_TYPE', 'category', 'MODEL_GAP',
      'message', 'The evaluator proof contains an unknown dimensions, model-gaps, or clause type.',
      'owner', 'SYSTEM', 'actor', 'SYSTEM',
      'nextAction', 'outcome.evaluator.repair', 'blocksGate', true,
      'evidenceFactIds', '[]'::jsonb, 'attemptedActions', '[]'::jsonb
    );
    RETURN jsonb_build_object(
      'schemaVersion', 2, 'allowed', false, 'decision', 'DENY',
      'staleness', 'CURRENT',
      'canonicalIdentity', jsonb_build_object(
        'bindingDigest', p_binding_digest,
        'evaluatedThroughLogicalTime', p_watermark::text,
        'projectionRevision', p_projection_revision::text,
        'proofDigest', p_proof_digest
      ),
      'proof', proof_value, 'proofGraph', graph_value,
      'reasons', jsonb_build_array(primary_reason),
      'blockingReasons', jsonb_build_array(primary_reason),
      'diagnostics', '[]'::jsonb, 'reason', primary_reason,
      'obligations', obligations_value,
      'blockingObligations', obligations_value,
      'nonBlockingObligations', '[]'::jsonb,
      'owner', 'SYSTEM', 'actor', 'SYSTEM',
      'nextAction', 'outcome.evaluator.repair',
      'ratification', jsonb_build_object(
        'validOnEvaluationCut', false, 'effectiveNow', false,
        'owner', 'OWNER', 'nextAction', 'owner.ratification.review'
      ),
      'deliveryPolicy', jsonb_build_object(
        'mode', 'UNKNOWN', 'nextAction', 'outcome.evaluator.repair'
      ),
      'crossProject', jsonb_build_object(
        'servesCriterionDoesNotImplyBlocksClosure', true, 'implicitAdoption', false
      ),
      'compatibility', jsonb_build_object(
        'legacyBlockerSignalInputs', false,
        'projectionIsAuthority', false
      )
    );
  END IF;

  SELECT value#>>'{binding,projectId}' INTO current_project_id
    FROM jsonb_array_elements(obligations_value) item(value)
   WHERE COALESCE(value#>>'{binding,projectId}', '') <> ''
   ORDER BY value->>'obligationId'
   LIMIT 1;
  current_project_id := COALESCE(current_project_id, '');

  -- Classify active obligations before dimension reasons.  servesCriterionIds is never consulted
  -- for blocking; only an explicit blocksClosureOf plus ownership.blockingProjectIds edge can make
  -- foreign work hold this project's closure.
  FOR obligation_value IN
    SELECT value FROM jsonb_array_elements(obligations_value) item(value)
     ORDER BY value->>'obligationId'
  LOOP
    IF current_project_id = '' THEN
      current_project_id := COALESCE(obligation_value#>>'{binding,projectId}', '');
    END IF;
    home_project_id := COALESCE(obligation_value#>>'{ownership,homeProjectId}', '');
    obligation_known := COALESCE(jsonb_typeof(obligation_value) = 'object'
      AND obligation_value->>'kind' = ANY(known_obligation_kinds)
      AND obligation_value->>'state' = 'ACTIVE'
      AND obligation_value->>'mandatory' = 'true'
      AND obligation_value->>'owner' IN ('SYSTEM', 'AGENT', 'OWNER', 'EXTERNAL')
      AND COALESCE(obligation_value->>'capability', '') <> ''
      AND COALESCE(outcome_valid_digest(obligation_value->>'obligationId'), false)
      AND COALESCE(outcome_valid_digest(obligation_value->>'obligationRevision'), false)
      AND obligation_value->>'bindingDigest' = p_binding_digest
      AND jsonb_typeof(obligation_value->'binding') = 'object'
      AND outcome_sha256_json(obligation_value->'binding') = p_binding_digest
      AND jsonb_typeof(obligation_value->'reason') = 'object'
      AND COALESCE(obligation_value#>>'{reason,nextAction}', '') <> ''
      AND jsonb_typeof(obligation_value->'servesCriterionIds') = 'array'
      AND jsonb_typeof(obligation_value->'blocksClosureOf') = 'array'
      AND jsonb_typeof(obligation_value->'ownership') = 'object'
      AND jsonb_typeof(obligation_value#>'{ownership,blockingProjectIds}') = 'array', false);
    IF NOT obligation_known THEN
      blocking_obligations := blocking_obligations || jsonb_build_array(obligation_value);
      reasons := reasons || jsonb_build_array(jsonb_build_object(
        'code', 'UNKNOWN_OBLIGATION_TYPE', 'category', 'MODEL_GAP',
        'message', 'An active mandatory obligation has an unknown kind or malformed protocol/ownership shape.',
        'owner', 'SYSTEM', 'actor', 'SYSTEM',
        'nextAction', 'outcome.obligation-model.repair', 'blocksGate', true,
        'obligationId', obligation_value->>'obligationId',
        'obligationRevision', obligation_value->>'obligationRevision',
        'servesCriterionIds', COALESCE(obligation_value->'servesCriterionIds', '[]'::jsonb),
        'blocksClosureOf', COALESCE(obligation_value->'blocksClosureOf', '[]'::jsonb),
        'ownership', obligation_value->'ownership',
        'evidenceFactIds', COALESCE(obligation_value#>'{reason,evidenceFactIds}', '[]'::jsonb),
        'attemptedActions', COALESCE(obligation_value#>'{reason,attemptedActions}', '[]'::jsonb)
      ));
      CONTINUE;
    END IF;

    claims_current_project := outcome_projection.obligation_blocks_project(
      obligation_value, current_project_id
    );
    attribution_valid := outcome_projection.cross_project_attribution_valid(
      obligation_value, current_project_id
    );
    IF home_project_id = current_project_id THEN
      -- A malformed missing home edge cannot make the obligation disappear from its own project.
      blocking_obligations := blocking_obligations || jsonb_build_array(obligation_value);
      IF NOT attribution_valid THEN
        reasons := reasons || jsonb_build_array(jsonb_build_object(
          'code', 'HOME_OBLIGATION_ATTRIBUTION_INVALID', 'category', 'ATTRIBUTION',
          'message', 'A home-project obligation is missing its explicit closure edge.',
          'owner', 'SYSTEM', 'actor', 'SYSTEM',
          'nextAction', 'cross-project.attribution.repair', 'blocksGate', true,
          'obligationId', obligation_value->>'obligationId',
          'obligationRevision', obligation_value->>'obligationRevision',
          'servesCriterionIds', obligation_value->'servesCriterionIds',
          'blocksClosureOf', obligation_value->'blocksClosureOf',
          'ownership', obligation_value->'ownership',
          'evidenceFactIds', COALESCE(obligation_value#>'{reason,evidenceFactIds}', '[]'::jsonb),
          'attemptedActions', COALESCE(obligation_value#>'{reason,attemptedActions}', '[]'::jsonb)
        ));
      END IF;
    ELSIF claims_current_project AND attribution_valid THEN
      blocking_obligations := blocking_obligations || jsonb_build_array(obligation_value);
    ELSE
      non_blocking_obligations := non_blocking_obligations || jsonb_build_array(obligation_value);
      IF claims_current_project AND NOT attribution_valid THEN
        reasons := reasons || jsonb_build_array(jsonb_build_object(
          'code', 'CROSS_PROJECT_ATTRIBUTION_REJECTED', 'category', 'ATTRIBUTION',
          'message', 'A foreign obligation claimed this project without an accepted explicit closure crossing; it was diagnosed but did not block this project.',
          'owner', 'SYSTEM', 'actor', 'SYSTEM',
          'nextAction', 'cross-project.attribution.repair', 'blocksGate', false,
          'obligationId', obligation_value->>'obligationId',
          'obligationRevision', obligation_value->>'obligationRevision',
          'servesCriterionIds', obligation_value->'servesCriterionIds',
          'blocksClosureOf', obligation_value->'blocksClosureOf',
          'ownership', obligation_value->'ownership',
          'evidenceFactIds', COALESCE(obligation_value#>'{reason,evidenceFactIds}', '[]'::jsonb),
          'attemptedActions', COALESCE(obligation_value#>'{reason,attemptedActions}', '[]'::jsonb)
        ));
      END IF;
    END IF;

    IF (home_project_id = current_project_id) OR (claims_current_project AND attribution_valid) THEN
      reasons := reasons || jsonb_build_array(jsonb_build_object(
        'code', 'ACTIVE_MANDATORY_OBLIGATION', 'category', 'OBLIGATION',
        'detailCode', obligation_value#>>'{reason,code}',
        'message', COALESCE(
          obligation_value#>>'{reason,message}',
          format('%s remains active.', obligation_value->>'kind')
        ),
        'owner', obligation_value->>'owner', 'actor', obligation_value->>'owner',
        'nextAction', obligation_value#>>'{reason,nextAction}', 'blocksGate', true,
        'obligationId', obligation_value->>'obligationId',
        'obligationRevision', obligation_value->>'obligationRevision',
        'servesCriterionIds', obligation_value->'servesCriterionIds',
        'blocksClosureOf', obligation_value->'blocksClosureOf',
        'ownership', obligation_value->'ownership',
        'evidenceFactIds', COALESCE(obligation_value#>'{reason,evidenceFactIds}', '[]'::jsonb),
        'attemptedActions', COALESCE(obligation_value#>'{reason,attemptedActions}', '[]'::jsonb)
      ));
    END IF;
  END LOOP;

  FOREACH dimension_id IN ARRAY required_dimensions LOOP
    SELECT count(*)::integer INTO dimension_count
      FROM jsonb_array_elements(dimensions_value) item(value)
     WHERE value->>'dimensionId' = dimension_id;
    SELECT value INTO dimension_value
      FROM jsonb_array_elements(dimensions_value) item(value)
     WHERE value->>'dimensionId' = dimension_id
     LIMIT 1;
    IF dimension_count <> 1 THEN
      reasons := reasons || jsonb_build_array(jsonb_build_object(
        'code', 'REQUIRED_DIMENSION_CARDINALITY_INVALID', 'category', 'MODEL_GAP',
        'dimensionId', dimension_id,
        'message', format('Required dimension %s occurs %s times in the proof.', dimension_id, dimension_count),
        'owner', 'SYSTEM', 'actor', 'SYSTEM',
        'nextAction', 'outcome.evaluator.repair', 'blocksGate', true,
        'evidenceFactIds', '[]'::jsonb, 'attemptedActions', '[]'::jsonb
      ));
      CONTINUE;
    END IF;
    dimension_state := dimension_value->>'state';
    SELECT value INTO matching_obligation
      FROM jsonb_array_elements(blocking_obligations) item(value)
     WHERE COALESCE(value->'blocksClosureOf', '[]'::jsonb) ? dimension_id
     ORDER BY value->>'obligationId'
     LIMIT 1;
    owner_value := CASE dimension_id
      WHEN 'CONTRACT_RATIFICATION' THEN 'OWNER'
      WHEN 'AUTHORITY_VALIDITY' THEN 'OWNER'
      WHEN 'POLICY_COMPLIANCE' THEN 'OWNER'
      WHEN 'BUDGET_COMPLIANCE' THEN 'OWNER'
      WHEN 'FACT_CUT_INTEGRITY' THEN 'SYSTEM'
      WHEN 'EVIDENCE_TRUST' THEN 'SYSTEM'
      WHEN 'BINDING_FRESHNESS' THEN 'SYSTEM'
      WHEN 'TARGET_PRESENCE' THEN 'SYSTEM'
      ELSE 'AGENT'
    END;
    action_value := COALESCE(
      matching_obligation#>>'{reason,nextAction}',
      CASE dimension_id
        WHEN 'CONTRACT_RATIFICATION' THEN 'owner.ratification.review'
        WHEN 'ARTIFACT_INTEGRATION' THEN 'delivery.integration.attest'
        WHEN 'TARGET_PRESENCE' THEN 'delivery.target.verify'
        WHEN 'POST_MERGE_VERIFICATION' THEN 'delivery.post-merge.verify'
        ELSE 'outcome.dimension.resolve'
      END
    );
    IF dimension_state NOT IN ('SATISFIED', 'UNSATISFIED', 'UNKNOWN', 'CONFLICT', 'NOT_APPLICABLE') THEN
      reasons := reasons || jsonb_build_array(jsonb_build_object(
        'code', 'UNKNOWN_DIMENSION_STATE', 'category', 'MODEL_GAP',
        'dimensionId', dimension_id, 'state', dimension_state,
        'message', format('Dimension %s has an unknown completion state.', dimension_id),
        'owner', 'SYSTEM', 'actor', 'SYSTEM',
        'nextAction', 'outcome.evaluator.upgrade-or-rollback', 'blocksGate', true,
        'evidenceFactIds', COALESCE(dimension_value->'evidenceFactIds', '[]'::jsonb),
        'attemptedActions', '[]'::jsonb
      ));
    ELSIF dimension_state IN ('UNSATISFIED', 'UNKNOWN', 'CONFLICT') THEN
      reasons := reasons || jsonb_build_array(jsonb_build_object(
        'code', 'DIMENSION_' || dimension_state, 'category', 'DIMENSION',
        'detailCode', dimension_value->>'reasonCode',
        'dimensionId', dimension_id, 'state', dimension_state,
        'message', format('Required dimension %s is %s on the current evaluation cut.', dimension_id, dimension_state),
        'owner', COALESCE(matching_obligation->>'owner', owner_value),
        'actor', COALESCE(matching_obligation->>'owner', owner_value),
        'nextAction', action_value, 'blocksGate', true,
        'obligationId', matching_obligation->>'obligationId',
        'obligationRevision', matching_obligation->>'obligationRevision',
        'servesCriterionIds', COALESCE(matching_obligation->'servesCriterionIds', '[]'::jsonb),
        'blocksClosureOf', COALESCE(matching_obligation->'blocksClosureOf', jsonb_build_array(dimension_id)),
        'ownership', matching_obligation->'ownership',
        'evidenceFactIds', COALESCE(dimension_value->'evidenceFactIds', '[]'::jsonb),
        'attemptedActions', COALESCE(matching_obligation#>'{reason,attemptedActions}', '[]'::jsonb)
      ));
    ELSIF jsonb_array_length(CASE
        WHEN jsonb_typeof(dimension_value->'evidenceFactIds') = 'array'
        THEN dimension_value->'evidenceFactIds'
        ELSE '[]'::jsonb
      END) = 0 THEN
      reasons := reasons || jsonb_build_array(jsonb_build_object(
        'code', 'DIMENSION_PROOF_MISSING', 'category', 'PROOF',
        'dimensionId', dimension_id, 'state', dimension_state,
        'message', format('Dimension %s has no authoritative proof leaf on the current cut.', dimension_id),
        'owner', owner_value, 'actor', owner_value,
        'nextAction', 'outcome.proof.refresh', 'blocksGate', true,
        'evidenceFactIds', '[]'::jsonb, 'attemptedActions', '[]'::jsonb
      ));
    ELSIF dimension_state = 'NOT_APPLICABLE'
       AND NOT COALESCE(outcome_valid_digest(dimension_value->>'applicabilityProofDigest'), false) THEN
      reasons := reasons || jsonb_build_array(jsonb_build_object(
        'code', 'NOT_APPLICABLE_PROOF_MISSING', 'category', 'PROOF',
        'dimensionId', dimension_id, 'state', dimension_state,
        'message', format('Dimension %s claims NOT_APPLICABLE without a bound applicability proof.', dimension_id),
        'owner', owner_value, 'actor', owner_value,
        'nextAction', 'outcome.applicability.attest', 'blocksGate', true,
        'evidenceFactIds', dimension_value->'evidenceFactIds', 'attemptedActions', '[]'::jsonb
      ));
    END IF;
  END LOOP;

  FOR dimension_value IN
    SELECT value FROM jsonb_array_elements(dimensions_value) item(value)
     WHERE NOT (value->>'dimensionId' = ANY(required_dimensions))
     ORDER BY value->>'dimensionId'
  LOOP
    reasons := reasons || jsonb_build_array(jsonb_build_object(
      'code', 'UNKNOWN_DIMENSION_TYPE', 'category', 'MODEL_GAP',
      'dimensionId', dimension_value->>'dimensionId',
      'message', 'The proof contains a completion dimension unknown to this gate.',
      'owner', 'SYSTEM', 'actor', 'SYSTEM',
      'nextAction', 'outcome.evaluator.upgrade-or-rollback', 'blocksGate', true,
      'evidenceFactIds', COALESCE(dimension_value->'evidenceFactIds', '[]'::jsonb),
      'attemptedActions', '[]'::jsonb
    ));
  END LOOP;

  FOR gap_value IN SELECT value FROM jsonb_array_elements(proof_value->'modelGaps') item(value) LOOP
    IF jsonb_typeof(gap_value) <> 'string' OR COALESCE(gap_value#>>'{}', '') = '' THEN
      message_value := 'The evaluator emitted an unknown model-gap value.';
    ELSE
      message_value := format('The evaluator reported model gap %s.', gap_value#>>'{}');
    END IF;
    reasons := reasons || jsonb_build_array(jsonb_build_object(
      'code', 'MODEL_GAP', 'category', 'MODEL_GAP',
      'modelGapCode', CASE WHEN jsonb_typeof(gap_value) = 'string' THEN gap_value#>>'{}' ELSE NULL END,
      'message', message_value,
      'owner', 'AGENT', 'actor', 'AGENT',
      'nextAction', 'model-gap.diagnose', 'blocksGate', true,
      'evidenceFactIds', '[]'::jsonb, 'attemptedActions', '[]'::jsonb
    ));
  END LOOP;

  SELECT value->>'state' INTO artifact_state FROM jsonb_array_elements(dimensions_value) item(value)
   WHERE value->>'dimensionId' = 'ARTIFACT_INTEGRATION' LIMIT 1;
  SELECT value->>'state' INTO target_state FROM jsonb_array_elements(dimensions_value) item(value)
   WHERE value->>'dimensionId' = 'TARGET_PRESENCE' LIMIT 1;
  SELECT value->>'state' INTO post_merge_state FROM jsonb_array_elements(dimensions_value) item(value)
   WHERE value->>'dimensionId' = 'POST_MERGE_VERIFICATION' LIMIT 1;
  IF artifact_state <> 'NOT_APPLICABLE' THEN delivery_required := array_append(delivery_required, 'ARTIFACT_INTEGRATION'); END IF;
  IF target_state <> 'NOT_APPLICABLE' THEN delivery_required := array_append(delivery_required, 'TARGET_PRESENCE'); END IF;
  IF post_merge_state <> 'NOT_APPLICABLE' THEN delivery_required := array_append(delivery_required, 'POST_MERGE_VERIFICATION'); END IF;
  IF artifact_state NOT IN ('SATISFIED', 'NOT_APPLICABLE') THEN delivery_missing := array_append(delivery_missing, 'ARTIFACT_INTEGRATION'); END IF;
  IF target_state NOT IN ('SATISFIED', 'NOT_APPLICABLE') THEN delivery_missing := array_append(delivery_missing, 'TARGET_PRESENCE'); END IF;
  IF post_merge_state NOT IN ('SATISFIED', 'NOT_APPLICABLE') THEN delivery_missing := array_append(delivery_missing, 'POST_MERGE_VERIFICATION'); END IF;
  IF artifact_state = 'NOT_APPLICABLE' AND target_state = 'NOT_APPLICABLE' AND post_merge_state = 'NOT_APPLICABLE' THEN
    delivery_mode := 'NOT_REQUIRED';
  ELSIF artifact_state = 'SATISFIED' AND target_state = 'NOT_APPLICABLE' AND post_merge_state = 'NOT_APPLICABLE' THEN
    delivery_mode := 'INTEGRATION_ATTESTED';
  ELSIF artifact_state = 'SATISFIED' AND target_state = 'SATISFIED' AND post_merge_state = 'NOT_APPLICABLE' THEN
    delivery_mode := 'CURRENT_TARGET_PRESENT';
  ELSIF artifact_state = 'SATISFIED' AND target_state = 'SATISFIED' AND post_merge_state = 'SATISFIED' THEN
    delivery_mode := 'POST_MERGE_VERIFIED';
  END IF;
  IF cardinality(delivery_missing) > 0 THEN
    reasons := reasons || jsonb_build_array(jsonb_build_object(
      'code', 'DELIVERY_ATTESTATION_MISSING', 'category', 'DELIVERY',
      'message', 'The bound delivery policy is missing one or more current authoritative attestations.',
      'owner', 'AGENT', 'actor', 'AGENT',
      'nextAction', 'delivery.attestation.record', 'blocksGate', true,
      'missingDimensions', to_jsonb(delivery_missing),
      'evidenceFactIds', '[]'::jsonb, 'attemptedActions', '[]'::jsonb
    ));
  ELSIF delivery_mode = 'UNKNOWN' THEN
    reasons := reasons || jsonb_build_array(jsonb_build_object(
      'code', 'DELIVERY_POLICY_CONFLICT', 'category', 'DELIVERY',
      'message', 'Delivery dimension applicability does not form a recognized delivery policy.',
      'owner', 'SYSTEM', 'actor', 'SYSTEM',
      'nextAction', 'delivery.policy.rebind', 'blocksGate', true,
      'evidenceFactIds', '[]'::jsonb, 'attemptedActions', '[]'::jsonb
    ));
  END IF;

  SELECT value->>'state' = 'SATISFIED' INTO ratification_valid
    FROM jsonb_array_elements(dimensions_value) item(value)
   WHERE value->>'dimensionId' = 'CONTRACT_RATIFICATION' LIMIT 1;
  ratification_valid := COALESCE(ratification_valid, false)
    AND clauses_value->'CONTRACT_RATIFIED_FOR_EXACT_CONTRACT_DIGEST' = 'true'::jsonb;
  IF NOT ratification_valid THEN
    reasons := reasons || jsonb_build_array(jsonb_build_object(
      'code', 'OWNER_RATIFICATION_INVALID', 'category', 'AUTHORITY',
      'message', 'The evaluation cut does not prove ratification of the exact contract digest.',
      'owner', 'OWNER', 'actor', 'OWNER',
      'nextAction', 'owner.ratification.review', 'blocksGate', true,
      'contractDigest', proof_value->>'contractDigest',
      'evidenceFactIds', '[]'::jsonb, 'attemptedActions', '[]'::jsonb
    ));
  END IF;

  FOREACH clause_name IN ARRAY required_clauses LOOP
    clause_value := clauses_value->clause_name;
    IF COALESCE(jsonb_typeof(clause_value), 'null') <> 'boolean' THEN
      reasons := reasons || jsonb_build_array(jsonb_build_object(
        'code', 'UNKNOWN_CLOSED_CLAUSE_TYPE', 'category', 'MODEL_GAP',
        'clause', clause_name,
        'message', 'A required closed-clause result is absent or is not boolean.',
        'owner', 'SYSTEM', 'actor', 'SYSTEM',
        'nextAction', 'outcome.evaluator.upgrade-or-rollback', 'blocksGate', true,
        'evidenceFactIds', '[]'::jsonb, 'attemptedActions', '[]'::jsonb
      ));
    ELSIF clause_value = 'false'::jsonb AND clause_name = ANY(ARRAY[
      'EVALUATION_PLAN_MATCHES_EXACT_EVALUATION_PLAN_DIGEST',
      'FACT_CUT_IS_COMPLETE_LINEARIZABLE_AND_TRUSTED',
      'EVALUATOR_VERSION_AND_DIGEST_MATCH_BINDING',
      'GOAL_DISPOSITION_IS_ACHIEVED',
      'NO_STALE_OR_REVOKED_BINDING'
    ]) THEN
      reasons := reasons || jsonb_build_array(jsonb_build_object(
        'code', 'CLOSED_CLAUSE_UNSATISFIED', 'category', 'PROOF',
        'clause', clause_name,
        'message', format('Required closure clause %s is false on the current cut.', clause_name),
        'owner', 'SYSTEM', 'actor', 'SYSTEM',
        'nextAction', CASE clause_name
          WHEN 'NO_STALE_OR_REVOKED_BINDING' THEN 'binding.refresh'
          WHEN 'FACT_CUT_IS_COMPLETE_LINEARIZABLE_AND_TRUSTED' THEN 'fact-cut.repair'
          ELSE 'outcome.proof.refresh'
        END,
        'blocksGate', true,
        'evidenceFactIds', '[]'::jsonb, 'attemptedActions', '[]'::jsonb
      ));
    END IF;
  END LOOP;
  FOR clause_name, clause_value IN SELECT key, value FROM jsonb_each(clauses_value) LOOP
    IF NOT (clause_name = ANY(required_clauses)) THEN
      reasons := reasons || jsonb_build_array(jsonb_build_object(
        'code', 'UNKNOWN_CLOSED_CLAUSE', 'category', 'MODEL_GAP',
        'clause', clause_name,
        'message', 'The proof contains a closed-clause type unknown to this gate.',
        'owner', 'SYSTEM', 'actor', 'SYSTEM',
        'nextAction', 'outcome.evaluator.upgrade-or-rollback', 'blocksGate', true,
        'evidenceFactIds', '[]'::jsonb, 'attemptedActions', '[]'::jsonb
      ));
    END IF;
  END LOOP;
  IF COALESCE(jsonb_typeof(p_result->'closed'), 'null') <> 'boolean'
     OR COALESCE(jsonb_typeof(proof_value->'closed'), 'null') <> 'boolean' THEN
    closure_conflict := true;
  ELSE
    closure_conflict := (p_result->>'closed')::boolean
      IS DISTINCT FROM (proof_value->>'closed')::boolean
      OR p_closed IS DISTINCT FROM (p_result->>'closed')::boolean;
  END IF;
  IF closure_conflict THEN
    reasons := reasons || jsonb_build_array(jsonb_build_object(
      'code', 'EVALUATOR_CLOSURE_CONFLICT', 'category', 'MODEL_GAP',
      'message', 'Evaluator, proof, and persisted closure decisions disagree.',
      'owner', 'SYSTEM', 'actor', 'SYSTEM',
      'nextAction', 'outcome.evaluator.repair', 'blocksGate', true,
      'evidenceFactIds', '[]'::jsonb, 'attemptedActions', '[]'::jsonb
    ));
  END IF;

  SELECT COALESCE(jsonb_agg(value ORDER BY ordinal), '[]'::jsonb)
    INTO blocking_reasons
    FROM jsonb_array_elements(reasons) WITH ORDINALITY item(value, ordinal)
   WHERE value->'blocksGate' = 'true'::jsonb;
  SELECT COALESCE(jsonb_agg(value ORDER BY ordinal), '[]'::jsonb)
    INTO diagnostics
    FROM jsonb_array_elements(reasons) WITH ORDINALITY item(value, ordinal)
   WHERE value->'blocksGate' = 'false'::jsonb;
  allowed_value := jsonb_array_length(blocking_reasons) = 0;
  SELECT value INTO primary_reason
    FROM jsonb_array_elements(blocking_reasons) WITH ORDINALITY item(value, ordinal)
   ORDER BY ordinal LIMIT 1;
  SELECT value INTO primary_obligation
    FROM jsonb_array_elements(blocking_obligations) item(value)
   ORDER BY value->>'obligationId' LIMIT 1;
  IF primary_reason IS NULL THEN
    primary_reason := jsonb_build_object(
      'code', CASE WHEN jsonb_array_length(diagnostics) > 0
        THEN 'OUTCOME_CLOSED_WITH_NON_BLOCKING_DIAGNOSTICS' ELSE 'OUTCOME_CLOSED' END,
      'category', 'OUTCOME',
      'message', CASE WHEN jsonb_array_length(diagnostics) > 0
        THEN 'Every bound closure condition is satisfied; foreign attribution diagnostics did not create an implicit closure edge.'
        ELSE 'Every bound completion dimension is closed by the current canonical proof.' END,
      'owner', 'SYSTEM', 'actor', 'SYSTEM',
      'nextAction', 'NONE', 'blocksGate', false,
      'evidenceFactIds', '[]'::jsonb, 'attemptedActions', '[]'::jsonb
    );
  END IF;

  RETURN jsonb_build_object(
    'schemaVersion', 2,
    'allowed', allowed_value,
    'decision', CASE WHEN allowed_value THEN 'ALLOW' ELSE 'DENY' END,
    'staleness', 'CURRENT',
    'canonicalIdentity', jsonb_build_object(
      'bindingDigest', p_binding_digest,
      'contractDigest', proof_value->>'contractDigest',
      'criteriaDigest', proof_value->>'evaluationPlanDigest',
      'evaluatedThroughLogicalTime', p_watermark::text,
      'projectionRevision', p_projection_revision::text,
      'proofDigest', p_proof_digest
    ),
    'proof', proof_value,
    'proofGraph', graph_value,
    'reasons', reasons,
    'blockingReasons', blocking_reasons,
    'diagnostics', diagnostics,
    'reason', primary_reason,
    'obligations', obligations_value,
    'blockingObligations', blocking_obligations,
    'nonBlockingObligations', non_blocking_obligations,
    'obligationId', primary_obligation->>'obligationId',
    'obligationRevision', primary_obligation->>'obligationRevision',
    'owner', primary_reason->>'owner',
    'actor', primary_reason->>'actor',
    'nextAction', primary_reason->>'nextAction',
    'ratification', jsonb_build_object(
      'validOnEvaluationCut', ratification_valid,
      'contractDigest', proof_value->>'contractDigest',
      'owner', 'OWNER', 'nextAction', 'owner.ratification.review'
    ),
    'deliveryPolicy', jsonb_build_object(
      'mode', delivery_mode,
      'requiredDimensions', to_jsonb(delivery_required),
      'missingDimensions', to_jsonb(delivery_missing),
      'artifactIntegration', artifact_state,
      'targetPresence', target_state,
      'postMergeVerification', post_merge_state,
      'nextAction', CASE WHEN cardinality(delivery_missing) > 0
        THEN 'delivery.attestation.record' ELSE 'NONE' END
    ),
    'crossProject', jsonb_build_object(
      'servesCriterionDoesNotImplyBlocksClosure', true,
      'implicitAdoption', false,
      'diagnosticCount', jsonb_array_length(diagnostics)
    ),
    'compatibility', jsonb_build_object(
      'legacyBlockerSignalInputs', false,
      'projectionIsAuthority', false
    )
  );
END;
$$ LANGUAGE plpgsql IMMUTABLE STRICT;

CREATE OR REPLACE FUNCTION outcome_projection.fail_closed_gate(
  p_code text,
  p_message text,
  p_next_action text,
  p_staleness text DEFAULT 'CURRENT',
  p_identity jsonb DEFAULT '{}'::jsonb,
  p_proof jsonb DEFAULT NULL,
  p_obligations jsonb DEFAULT '[]'::jsonb,
  p_detail jsonb DEFAULT '{}'::jsonb
) RETURNS jsonb AS $$
DECLARE
  reason_value jsonb;
BEGIN
  reason_value := jsonb_build_object(
    'code', p_code, 'category', CASE
      WHEN p_code = 'RECONCILER_STALE' THEN 'FRESHNESS'
      WHEN p_code = 'GATE_READ_FAILED' THEN 'READ_FAILURE'
      ELSE 'MODEL_GAP' END,
    'message', p_message,
    'owner', 'SYSTEM', 'actor', 'SYSTEM',
    'nextAction', p_next_action,
    'blocksGate', true,
    'evidenceFactIds', '[]'::jsonb,
    'attemptedActions', '[]'::jsonb,
    'detail', COALESCE(p_detail, '{}'::jsonb)
  );
  RETURN jsonb_build_object(
    'schemaVersion', 2, 'allowed', false, 'decision', 'DENY',
    'staleness', p_staleness,
    'canonicalIdentity', COALESCE(p_identity, '{}'::jsonb),
    'proof', p_proof, 'proofGraph', NULL,
    'reasons', jsonb_build_array(reason_value),
    'blockingReasons', jsonb_build_array(reason_value),
    'diagnostics', '[]'::jsonb, 'reason', reason_value,
    'obligations', COALESCE(p_obligations, '[]'::jsonb),
    'blockingObligations', COALESCE(p_obligations, '[]'::jsonb),
    'nonBlockingObligations', '[]'::jsonb,
    'owner', 'SYSTEM', 'actor', 'SYSTEM', 'nextAction', p_next_action,
    'ratification', jsonb_build_object('validOnEvaluationCut', false, 'effectiveNow', false),
    'deliveryPolicy', jsonb_build_object('mode', 'UNKNOWN', 'nextAction', p_next_action),
    'crossProject', jsonb_build_object(
      'servesCriterionDoesNotImplyBlocksClosure', true, 'implicitAdoption', false
    ),
    'compatibility', jsonb_build_object(
      'legacyBlockerSignalInputs', false, 'projectionIsAuthority', false
    )
  );
END;
$$ LANGUAGE plpgsql IMMUTABLE;

-- The one live gate read.  It pins the stream while it selects the current binding/evaluation,
-- recomputes the projection gate from the immutable result, and overlays the current effective
-- Owner Ratification.  A missing row, checksum mismatch, stale watermark, or read exception is a
-- structured DENY; no caller has to infer safety from an empty result or a thrown string.
CREATE OR REPLACE FUNCTION project_canonical_done_gate(
  p_project uuid,
  p_subject_type text DEFAULT 'PROJECT',
  p_subject_id text DEFAULT NULL
) RETURNS jsonb AS $$
DECLARE
  owner_value uuid;
  subject_value text := COALESCE(NULLIF(p_subject_id, ''), p_project::text);
  stream_row outcome_fact_stream%ROWTYPE;
  binding_row outcome_fact_binding%ROWTYPE;
  evaluation_row outcome_evaluator_result%ROWTYPE;
  state_row outcome_projection.reconciler_state%ROWTYPE;
  proof_row outcome_projection.proof%ROWTYPE;
  gate_row outcome_projection.done_gate%ROWTYPE;
  contract_digest_value text;
  evaluation_plan_digest_value text;
  decision_request_id uuid;
  expected_gate jsonb;
  surface_payload jsonb;
  identity_value jsonb;
  ratification_value jsonb;
  ratification_reason jsonb;
  reasons_value jsonb;
  blocking_reasons_value jsonb;
  gate_value jsonb;
  effective_ratification boolean := false;
BEGIN
  SELECT owner_id INTO owner_value FROM project WHERE id = p_project;
  IF owner_value IS NULL THEN
    RETURN outcome_projection.fail_closed_gate(
      'GATE_READ_FAILED', 'The project row could not be read.', 'project.reload', 'READ_FAILED',
      jsonb_build_object('projectId', p_project::text), NULL, '[]'::jsonb,
      jsonb_build_object('cause', 'PROJECT_NOT_FOUND')
    );
  END IF;
  IF COALESCE(p_subject_type, '') <> 'PROJECT' THEN
    RETURN outcome_projection.fail_closed_gate(
      'UNKNOWN_SUBJECT_TYPE', 'The project gate subject type is empty or unknown.',
      'outcome.evaluator.upgrade-or-rollback', 'CURRENT',
      jsonb_build_object('projectId', p_project::text), NULL, '[]'::jsonb,
      jsonb_build_object('subjectType', p_subject_type)
    );
  END IF;
  IF subject_value <> p_project::text THEN
    RETURN outcome_projection.fail_closed_gate(
      'SUBJECT_PROJECT_MISMATCH',
      'A project DONE gate cannot be evaluated against a different subject identity.',
      'binding.register-current', 'CURRENT',
      jsonb_build_object('projectId', p_project::text, 'subjectId', subject_value),
      NULL, '[]'::jsonb
    );
  END IF;

  SELECT * INTO stream_row FROM outcome_fact_stream
   WHERE tenant_id = owner_value AND project_id = p_project
   FOR SHARE;
  IF NOT FOUND THEN
    RETURN outcome_projection.fail_closed_gate(
      'CANONICAL_FACT_STREAM_MISSING',
      'No canonical fact stream exists for this project, so closure cannot be proved.',
      'outcome.fact-stream.initialize', 'CURRENT',
      jsonb_build_object('projectId', p_project::text), NULL, '[]'::jsonb,
      jsonb_build_object('tenantId', owner_value::text)
    );
  END IF;
  SELECT * INTO binding_row FROM outcome_fact_binding
   WHERE tenant_id = owner_value AND project_id = p_project
   ORDER BY binding_epoch DESC LIMIT 1;
  IF NOT FOUND THEN
    RETURN outcome_projection.fail_closed_gate(
      'CURRENT_BINDING_MISSING', 'The canonical stream has no current semantic binding.',
      'binding.register-current', 'CURRENT',
      jsonb_build_object(
        'projectId', p_project::text,
        'canonicalWatermarkLogicalTime', stream_row.last_logical_time::text
      ), NULL, '[]'::jsonb
    );
  END IF;
  identity_value := jsonb_build_object(
    'projectId', p_project::text,
    'subjectType', p_subject_type,
    'subjectId', subject_value,
    'bindingDigest', binding_row.binding_digest::text,
    'contractDigest', binding_row.binding->>'contractDigest',
    'criteriaDigest', binding_row.binding->>'evaluationPlanDigest',
    'artifactDigest', binding_row.binding->>'artifactDigest',
    'targetDigest', binding_row.binding->>'targetDigest',
    'policyDigest', binding_row.binding->>'policyDigest',
    'registryDigest', binding_row.binding->>'capabilityRegistryDigest',
    'evaluatorDigest', binding_row.binding->>'evaluatorDigest',
    'factSchemaDigest', binding_row.binding->>'factSchemaDigest',
    'environmentDigest', binding_row.binding->>'environmentDigest',
    'asOfLogicalTime', binding_row.binding->>'asOfLogicalTime',
    'canonicalWatermarkLogicalTime', stream_row.last_logical_time::text
  );
  SELECT * INTO evaluation_row FROM outcome_evaluator_result
   WHERE tenant_id = owner_value AND project_id = p_project
     AND subject_type = p_subject_type AND subject_id = subject_value
     AND binding_digest = binding_row.binding_digest
   ORDER BY watermark_logical_time DESC, evaluator_digest DESC, committed_at DESC, evaluation_id DESC
   LIMIT 1;
  IF NOT FOUND THEN
    RETURN outcome_projection.fail_closed_gate(
      'OUTCOME_EVALUATION_MISSING',
      'The current binding has no immutable evaluator result for this subject.',
      'outcome.evaluate-current-cut', 'RECONCILER_STALE', identity_value, NULL, '[]'::jsonb
    );
  END IF;
  identity_value := identity_value || jsonb_build_object(
    'evaluationId', evaluation_row.evaluation_id::text,
    'cutId', evaluation_row.cut_id::text,
    'evaluatedThroughLogicalTime', evaluation_row.watermark_logical_time::text,
    'proofDigest', evaluation_row.proof_digest::text
  );
  IF evaluation_row.watermark_logical_time <> stream_row.last_logical_time
     OR evaluation_row.evaluator_digest::text <> binding_row.binding->>'evaluatorDigest' THEN
    RETURN outcome_projection.fail_closed_gate(
      'RECONCILER_STALE',
      'The newest evaluator result is behind the canonical stream or current evaluator binding.',
      'outcome.evaluate-current-cut', 'RECONCILER_STALE', identity_value,
      evaluation_row.result->'proof', evaluation_row.result->'activeMandatoryObligations',
      jsonb_build_object(
        'canonicalWatermarkLogicalTime', stream_row.last_logical_time::text,
        'evaluatedThroughLogicalTime', evaluation_row.watermark_logical_time::text,
        'currentEvaluatorDigest', binding_row.binding->>'evaluatorDigest',
        'evaluatedByDigest', evaluation_row.evaluator_digest::text
      )
    );
  END IF;
  IF outcome_sha256_json(binding_row.binding) <> binding_row.binding_digest::text
     OR outcome_sha256_json(evaluation_row.result) <> evaluation_row.result_digest::text
     OR outcome_sha256_json(evaluation_row.result - 'evaluationDigest')
          <> evaluation_row.evaluation_digest::text
     OR outcome_sha256_json((evaluation_row.result->'proof') - 'proofDigest')
          <> evaluation_row.proof_digest::text THEN
    RETURN outcome_projection.fail_closed_gate(
      'EVALUATOR_RESULT_INTEGRITY_FAILED',
      'The current binding or immutable evaluator result failed its canonical digest check.',
      'outcome.evaluator.repair', 'CURRENT', identity_value,
      evaluation_row.result->'proof', evaluation_row.result->'activeMandatoryObligations'
    );
  END IF;

  SELECT * INTO state_row FROM outcome_projection.reconciler_state
   WHERE tenant_id = owner_value AND project_id = p_project
     AND subject_type = p_subject_type AND subject_id = subject_value;
  SELECT * INTO proof_row FROM outcome_projection.proof
   WHERE tenant_id = owner_value AND project_id = p_project
     AND subject_type = p_subject_type AND subject_id = subject_value;
  SELECT * INTO gate_row FROM outcome_projection.done_gate
   WHERE tenant_id = owner_value AND project_id = p_project
     AND subject_type = p_subject_type AND subject_id = subject_value;
  IF state_row.tenant_id IS NULL OR proof_row.tenant_id IS NULL OR gate_row.tenant_id IS NULL THEN
    RETURN outcome_projection.fail_closed_gate(
      'RECONCILER_STALE', 'The canonical evaluation has not been fully projected.',
      'reconciler.recover', 'RECONCILER_STALE', identity_value,
      evaluation_row.result->'proof', evaluation_row.result->'activeMandatoryObligations',
      jsonb_build_object('cause', 'PROJECTION_ROW_MISSING')
    );
  END IF;
  expected_gate := outcome_projection.done_gate_value(
    evaluation_row.result, evaluation_row.proof_digest::text, evaluation_row.is_closed,
    evaluation_row.binding_digest::text, evaluation_row.watermark_logical_time,
    state_row.projection_revision
  );
  surface_payload := outcome_projection.read_surface(
    owner_value, p_project, p_subject_type, subject_value, 'DONE_GATE'
  );
  IF surface_payload->>'staleness' = 'RECONCILER_STALE'
     OR state_row.source_evaluation_id <> evaluation_row.evaluation_id
     OR state_row.binding_digest <> binding_row.binding_digest
     OR state_row.evaluated_through_logical_time <> stream_row.last_logical_time
     OR proof_row.proof_digest <> evaluation_row.proof_digest
     OR outcome_sha256_json(jsonb_build_object(
          'proof', proof_row.proof, 'proofGraph', proof_row.proof_graph
        )) <> state_row.proof_checksum::text
     OR gate_row.gate IS DISTINCT FROM expected_gate
     OR gate_row.gate_checksum::text <> outcome_sha256_json(expected_gate)
     OR surface_payload->'doneGate' IS DISTINCT FROM expected_gate THEN
    RETURN outcome_projection.fail_closed_gate(
      'RECONCILER_STALE',
      'Projection identity, watermark, proof, or checksum does not match the immutable current evaluation.',
      'reconciler.recover', 'RECONCILER_STALE', identity_value,
      COALESCE(proof_row.proof, evaluation_row.result->'proof'),
      evaluation_row.result->'activeMandatoryObligations',
      jsonb_build_object(
        'cause', 'PROJECTION_MISMATCH',
        'sourceEvaluationId', state_row.source_evaluation_id::text,
        'expectedEvaluationId', evaluation_row.evaluation_id::text,
        'projectedWatermarkLogicalTime', state_row.evaluated_through_logical_time::text,
        'canonicalWatermarkLogicalTime', stream_row.last_logical_time::text
      )
    );
  END IF;

  identity_value := COALESCE(surface_payload->'canonicalIdentity', identity_value)
    || jsonb_build_object(
      'projectId', p_project::text,
      'subjectType', p_subject_type,
      'subjectId', subject_value,
      'evaluationId', evaluation_row.evaluation_id::text,
      'cutId', evaluation_row.cut_id::text,
      'canonicalWatermarkLogicalTime', stream_row.last_logical_time::text
    );
  gate_value := expected_gate || jsonb_build_object(
    'canonicalIdentity', identity_value,
    'sourceEvaluationId', evaluation_row.evaluation_id::text,
    'cutId', evaluation_row.cut_id::text,
    'staleness', 'CURRENT'
  );

  SELECT contract_digest::text, evaluation_plan_digest::text
    INTO contract_digest_value, evaluation_plan_digest_value
    FROM project_completion_contract WHERE project_id = p_project;
  SELECT id INTO decision_request_id FROM project_owner_decision_request
   WHERE project_id = p_project AND status = 'PENDING'
   ORDER BY request_generation DESC LIMIT 1;
  effective_ratification := contract_digest_value IS NOT NULL
    AND project_owner_ratification_effective(p_project, contract_digest_value);
  ratification_value := jsonb_build_object(
    'effectiveNow', effective_ratification,
    'currentContractDigest', contract_digest_value,
    'currentEvaluationPlanDigest', evaluation_plan_digest_value,
    'boundContractDigest', binding_row.binding->>'contractDigest',
    'boundEvaluationPlanDigest', binding_row.binding->>'evaluationPlanDigest',
    'decisionRequestId', decision_request_id::text,
    'owner', 'OWNER',
    'nextAction', CASE WHEN effective_ratification THEN 'NONE' ELSE 'owner.ratification.review' END
  );
  IF contract_digest_value IS DISTINCT FROM binding_row.binding->>'contractDigest'
     OR evaluation_plan_digest_value IS DISTINCT FROM binding_row.binding->>'evaluationPlanDigest'
     OR evaluation_row.result#>>'{proof,contractDigest}' IS DISTINCT FROM contract_digest_value
     OR NOT effective_ratification THEN
    ratification_reason := jsonb_build_object(
      'code', 'OWNER_RATIFICATION_INVALID', 'category', 'AUTHORITY',
      'message', CASE
        WHEN contract_digest_value IS DISTINCT FROM binding_row.binding->>'contractDigest'
          OR evaluation_plan_digest_value IS DISTINCT FROM binding_row.binding->>'evaluationPlanDigest'
        THEN 'The owner contract or evaluation plan changed after this binding/evaluation cut.'
        ELSE 'No effective Owner Ratification exists for the exact current completion contract.'
      END,
      'owner', 'OWNER', 'actor', 'OWNER',
      'nextAction', 'owner.ratification.review', 'blocksGate', true,
      'contractDigest', contract_digest_value,
      'boundContractDigest', binding_row.binding->>'contractDigest',
      'decisionRequestId', decision_request_id::text,
      'evidenceFactIds', '[]'::jsonb, 'attemptedActions', '[]'::jsonb
    );
    reasons_value := jsonb_build_array(ratification_reason)
      || COALESCE(gate_value->'reasons', '[]'::jsonb);
    blocking_reasons_value := jsonb_build_array(ratification_reason)
      || COALESCE(gate_value->'blockingReasons', '[]'::jsonb);
    gate_value := gate_value || jsonb_build_object(
      'allowed', false, 'decision', 'DENY',
      'reason', ratification_reason,
      'reasons', reasons_value,
      'blockingReasons', blocking_reasons_value,
      'owner', 'OWNER', 'actor', 'OWNER',
      'nextAction', 'owner.ratification.review',
      'ratification', ratification_value
    );
  ELSE
    gate_value := gate_value || jsonb_build_object('ratification', ratification_value);
  END IF;
  RETURN gate_value;
EXCEPTION WHEN OTHERS THEN
  RETURN outcome_projection.fail_closed_gate(
    'GATE_READ_FAILED',
    'The canonical DONE gate could not read or validate its authoritative inputs.',
    'reconciler.recover', 'READ_FAILED',
    COALESCE(identity_value, jsonb_build_object('projectId', p_project::text)),
    CASE WHEN evaluation_row.evaluation_id IS NULL THEN NULL ELSE evaluation_row.result->'proof' END,
    CASE WHEN evaluation_row.evaluation_id IS NULL THEN '[]'::jsonb
      ELSE evaluation_row.result->'activeMandatoryObligations' END,
    jsonb_build_object('sqlState', SQLSTATE, 'databaseMessage', SQLERRM)
  );
END;
$$ LANGUAGE plpgsql VOLATILE SECURITY DEFINER
   SET search_path = pg_catalog, public, outcome_projection;

-- The database wall and the API read now call exactly the same gate function.  The exception's
-- DETAIL is the complete structured refusal for direct writers; the message contains only its
-- stable code so no independently maintained prose becomes a second decision input.
CREATE OR REPLACE FUNCTION project_acceptance_done_gate() RETURNS TRIGGER AS $$
DECLARE
  gate_value jsonb;
  reason_code text;
BEGIN
  IF NEW.status <> 'DONE' OR (TG_OP = 'UPDATE' AND OLD.status = 'DONE') THEN RETURN NEW; END IF;
  gate_value := project_canonical_done_gate(NEW.id, 'PROJECT', NEW.id::text);
  IF gate_value->>'allowed' IS DISTINCT FROM 'true' THEN
    reason_code := COALESCE(gate_value#>>'{reason,code}', 'CANONICAL_DONE_GATE_BLOCKED');
    RAISE EXCEPTION 'CANONICAL_DONE_GATE_BLOCKED:%', reason_code
      USING ERRCODE = 'raise_exception', DETAIL = gate_value::text;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- accepted_run_id and legacy_accepted_at are historical links after this cutover. Requiring either
-- one for DONE would preserve the legacy acceptance summary as a second closure writer. The
-- transition trigger above is the cross-table canonical-proof invariant, and a separate INSERT
-- trigger closes the one path the historical UPDATE-only trigger did not cover.
ALTER TABLE project DROP CONSTRAINT IF EXISTS project_done_evidence_chk;
DROP TRIGGER IF EXISTS project_acceptance_done_insert_gate ON project;
CREATE TRIGGER project_acceptance_done_insert_gate
  BEFORE INSERT ON project
  FOR EACH ROW EXECUTE FUNCTION project_acceptance_done_gate();

CREATE OR REPLACE FUNCTION outcome_projection.evaluator_result_reducer_trigger()
RETURNS trigger AS $$
BEGIN
  PERFORM outcome_projection.reduce_evaluation(
    NEW.evaluation_id, 2, 'outcome-projection-reducer-v2', 'INCREMENTAL', NULL
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER
   SET search_path = pg_catalog, public, outcome_projection;

-- Upgrade every disposable row through the sole reducer.  Canonical facts and immutable
-- evaluator results are untouched, and an empty installation is a valid zero-row rebuild.
SELECT outcome_projection.full_rebuild(2, 'outcome-projection-reducer-v2');

COMMENT ON FUNCTION project_canonical_done_gate(uuid, text, text) IS
  'Structured fail-closed DONE gate over the exact current binding/evaluation cut, canonical obligations, proof, effective Owner Ratification, delivery dimensions, and checked projection.';
COMMENT ON FUNCTION project_acceptance_done_gate() IS
  'Final DONE wall backed only by project_canonical_done_gate; legacy blocker/signal summaries are not closure writers.';

COMMIT;
