-- Failure Continuation Controller: deterministic diagnosis, routing and hard convergence.
--
-- A 0210 obligation is already the immutable, transactionally-triggered fact. This migration
-- consumes only a currently leased wake for that fact and appends one route decision. The route
-- reducer reads typed termination, the structural failure node, fingerprint history, current
-- binding/evaluation plans and the runner capability snapshot in one PostgreSQL statement.
--
-- There is deliberately no session_budget_per_day input. A missing daily budget neither grants
-- unbounded effects nor stalls diagnosis: this reducer creates a bounded plan, not an effect.

CREATE TABLE failure_continuation_route_decision (
  decision_id                    uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  obligation_id                  uuid        NOT NULL UNIQUE,
  continuation_id                uuid        NOT NULL UNIQUE,
  receipt_id                     uuid        NOT NULL UNIQUE,
  tenant_id                      uuid        NOT NULL,
  goal_id                        uuid        NOT NULL,
  task_id                        uuid        NOT NULL,
  lineage_digest                 char(64)    NOT NULL CHECK (outcome_valid_digest(lineage_digest)),
  binding_digest                 char(64)    NOT NULL CHECK (outcome_valid_digest(binding_digest)),
  route_generation               bigint      NOT NULL CHECK (route_generation > 0),
  contract_digest                char(64),
  attempt_evaluation_plan_digest char(64)    NOT NULL,
  task_evaluation_plan_digest    char(64),
  project_evaluation_plan_digest char(64),
  ratified_evaluation_plan_digest char(64),
  contract_ratification_state    text        NOT NULL CHECK (contract_ratification_state IN (
    'LEGACY_UNBOUND', 'CURRENT', 'MISSING', 'STALE'
  )),
  task_evaluation_plan_changed   boolean     NOT NULL,
  project_evaluation_plan_changed boolean    NOT NULL,
  failure_domain                 text        NOT NULL CHECK (failure_domain IN (
    'TRANSIENT_EXTERNAL', 'EVALUATION_HARNESS', 'PRODUCT_ARTIFACT',
    'CAPABILITY/ENVIRONMENT', 'OWNER_REQUIRED'
  )),
  failure_node                   text        NOT NULL CHECK (failure_node IN (
    'EXTERNAL_RATE_LIMIT', 'EXTERNAL_NETWORK', 'EXTERNAL_SERVICE',
    'EVALUATION_COMMAND', 'TEST_HARNESS', 'FIXTURE_SETUP', 'ACCEPTANCE_ASSERTION',
    'PRODUCT_SOURCE', 'BUILD_ARTIFACT', 'PRODUCT_BEHAVIOR',
    'RUNTIME_CAPABILITY', 'TOOLCHAIN', 'EXECUTION_ENVIRONMENT',
    'RUNNER_INFRASTRUCTURE', 'GOAL_BOUNDARY', 'RISK_BOUNDARY',
    'AUTHORIZATION_BOUNDARY', 'EXTERNAL_IDENTITY_BOUNDARY'
  )),
  owner_reason                   text CHECK (owner_reason IS NULL OR owner_reason IN (
    'GOAL_DECISION', 'RISK_ACCEPTANCE', 'NEW_AUTHORIZATION', 'EXTERNAL_IDENTITY'
  )),
  failure_fingerprint            char(64)    NOT NULL CHECK (outcome_valid_digest(failure_fingerprint)),
  fingerprint_occurrence         integer     NOT NULL CHECK (fingerprint_occurrence > 0),
  evidence_novel                 boolean     NOT NULL,
  unchanged_evidence_generations integer     NOT NULL CHECK (unchanged_evidence_generations > 0),
  diagnostic_path                text        NOT NULL CHECK (diagnostic_path IN (
    'PRIMARY_RECOVERY', 'ALTERNATE_DIAGNOSIS', 'PROJECT_ATTENTION', 'OWNER_DECISION'
  )),
  reason_code                    text        NOT NULL CHECK (btrim(reason_code) <> ''),
  canonical_reason               jsonb       NOT NULL CHECK (jsonb_typeof(canonical_reason) = 'object'),
  canonical_reason_digest        char(64)    NOT NULL CHECK (
    canonical_reason_digest = outcome_sha256_json(canonical_reason)
  ),
  evidence                       jsonb       NOT NULL CHECK (jsonb_typeof(evidence) = 'object'),
  evidence_digest                char(64)    NOT NULL CHECK (
    evidence_digest = outcome_sha256_json(evidence)
  ),
  evidence_sources               jsonb       NOT NULL CHECK (jsonb_typeof(evidence_sources) = 'array'),
  next_action                    jsonb       NOT NULL CHECK (jsonb_typeof(next_action) = 'object'),
  next_action_digest             char(64)    NOT NULL CHECK (
    next_action_digest = outcome_sha256_json(next_action)
  ),
  deadline_at                    timestamptz NOT NULL,
  project_attention              boolean     NOT NULL DEFAULT false,
  request_digest                 char(64)    NOT NULL CHECK (outcome_valid_digest(request_digest)),
  decision_digest                char(64)    NOT NULL UNIQUE CHECK (outcome_valid_digest(decision_digest)),
  idempotency_key                char(64)    NOT NULL UNIQUE CHECK (outcome_valid_digest(idempotency_key)),
  decided_at                     timestamptz NOT NULL,
  recorded_at                    timestamptz NOT NULL DEFAULT statement_timestamp(),
  CONSTRAINT failure_continuation_route_obligation_fkey
    FOREIGN KEY (obligation_id) REFERENCES failure_continuation_obligation(obligation_id)
      ON DELETE CASCADE,
  CONSTRAINT failure_continuation_route_continuation_fkey
    FOREIGN KEY (continuation_id) REFERENCES task_executable_continuation(id)
      ON DELETE CASCADE,
  CONSTRAINT failure_continuation_route_receipt_fkey
    FOREIGN KEY (receipt_id) REFERENCES failure_continuation_attempt_receipt(receipt_id)
      ON DELETE CASCADE,
  CONSTRAINT failure_continuation_route_goal_fkey
    FOREIGN KEY (goal_id) REFERENCES project(id) ON DELETE CASCADE,
  CONSTRAINT failure_continuation_route_task_fkey
    FOREIGN KEY (task_id) REFERENCES task(id) ON DELETE CASCADE,
  CONSTRAINT failure_continuation_route_owner_shape CHECK (
    (failure_domain = 'OWNER_REQUIRED') = (owner_reason IS NOT NULL)
  ),
  CONSTRAINT failure_continuation_route_attention_shape CHECK (
    project_attention = (diagnostic_path = 'PROJECT_ATTENTION')
    AND NOT (project_attention AND failure_domain = 'OWNER_REQUIRED')
  ),
  CONSTRAINT failure_continuation_route_reason_shape CHECK (
    canonical_reason->>'code' = reason_code
    AND canonical_reason->>'failureDomain' = failure_domain
    AND canonical_reason->>'failureNode' = failure_node
    AND canonical_reason->>'failureFingerprint' = failure_fingerprint::text
  ),
  CONSTRAINT failure_continuation_route_action_shape CHECK (
    next_action->>'diagnosticPath' = diagnostic_path
    AND (next_action->>'requiresOwnerDecision')::boolean = (failure_domain = 'OWNER_REQUIRED')
    AND (next_action->>'projectAttention')::boolean = project_attention
  ),
  CONSTRAINT failure_continuation_route_digest_shape CHECK (
    contract_digest IS NULL OR outcome_valid_digest(contract_digest)
  ),
  CONSTRAINT failure_continuation_route_plan_digest_shape CHECK (
    outcome_valid_digest(attempt_evaluation_plan_digest)
    AND (task_evaluation_plan_digest IS NULL
      OR outcome_valid_digest(task_evaluation_plan_digest))
    AND (project_evaluation_plan_digest IS NULL
      OR outcome_valid_digest(project_evaluation_plan_digest))
    AND (ratified_evaluation_plan_digest IS NULL
      OR outcome_valid_digest(ratified_evaluation_plan_digest))
  ),
  CONSTRAINT failure_continuation_route_deadline_shape CHECK (deadline_at > decided_at),
  UNIQUE (tenant_id, lineage_digest, route_generation),
  CHECK (fingerprint_occurrence = route_generation)
);

CREATE INDEX failure_continuation_route_goal_idx
  ON failure_continuation_route_decision (
    tenant_id, goal_id, recorded_at DESC, decision_id
  );
CREATE INDEX failure_continuation_route_fingerprint_idx
  ON failure_continuation_route_decision (
    tenant_id, lineage_digest, failure_fingerprint, route_generation DESC
  );
CREATE INDEX failure_continuation_route_attention_idx
  ON failure_continuation_route_decision (
    tenant_id, project_attention, deadline_at, recorded_at DESC
  );

CREATE TRIGGER failure_continuation_route_decision_append_only
  BEFORE UPDATE OR DELETE ON failure_continuation_route_decision
  FOR EACH ROW EXECUTE FUNCTION outcome_append_only_guard();

-- A single replay document. Every consumer gets the same reason/evidence/action/deadline instead
-- of re-deriving a display model from mutable Task state.
CREATE OR REPLACE FUNCTION failure_continuation_route_read(p_obligation_id uuid)
RETURNS jsonb LANGUAGE sql STABLE AS $$
  SELECT jsonb_build_object(
    'decisionId', decision.decision_id::text,
    'obligationId', decision.obligation_id::text,
    'continuationId', decision.continuation_id::text,
    'tenantId', decision.tenant_id::text,
    'goalId', decision.goal_id::text,
    'taskId', decision.task_id::text,
    'lineageDigest', decision.lineage_digest::text,
    'bindingDigest', decision.binding_digest::text,
    'routeGeneration', decision.route_generation::text,
    'contractDigest', decision.contract_digest::text,
    'attemptEvaluationPlanDigest', decision.attempt_evaluation_plan_digest::text,
    'taskEvaluationPlanDigest', decision.task_evaluation_plan_digest::text,
    'projectEvaluationPlanDigest', decision.project_evaluation_plan_digest::text,
    'ratifiedEvaluationPlanDigest', decision.ratified_evaluation_plan_digest::text,
    'contractRatificationState', decision.contract_ratification_state,
    'taskEvaluationPlanChanged', decision.task_evaluation_plan_changed,
    'projectEvaluationPlanChanged', decision.project_evaluation_plan_changed,
    'failureDomain', decision.failure_domain,
    'failureNode', decision.failure_node,
    'ownerReason', decision.owner_reason,
    'failureFingerprint', decision.failure_fingerprint::text,
    'fingerprintOccurrence', decision.fingerprint_occurrence,
    'evidenceNovel', decision.evidence_novel,
    'unchangedEvidenceGenerations', decision.unchanged_evidence_generations,
    'diagnosticPath', decision.diagnostic_path,
    'canonicalReason', decision.canonical_reason,
    'evidence', decision.evidence,
    'evidenceDigest', decision.evidence_digest::text,
    'evidenceSources', decision.evidence_sources,
    'nextAction', decision.next_action,
    'deadlineAt', to_jsonb(decision.deadline_at),
    'projectAttention', decision.project_attention,
    'decisionDigest', decision.decision_digest::text,
    'idempotencyKey', decision.idempotency_key::text,
    'decidedAt', to_jsonb(decision.decided_at)
  )
    FROM failure_continuation_route_decision decision
   WHERE decision.obligation_id = p_obligation_id
$$;

CREATE OR REPLACE FUNCTION failure_continuation_route_claim(
  p_outbox_id uuid,
  p_obligation_id uuid,
  p_lease_token uuid,
  p_lease_generation bigint,
  p_observed_at timestamptz,
  p_failure_node text DEFAULT NULL,
  p_owner_reason text DEFAULT NULL,
  p_required_capability text DEFAULT NULL,
  p_evidence_facts jsonb DEFAULT '{}'::jsonb
) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE
  v_context record;
  v_exact_ratification_id uuid;
  v_exact_ratification_contract_digest text;
  v_ratified_evaluation_plan_digest text;
  v_latest_ratification_id uuid;
  v_previous failure_continuation_route_decision%ROWTYPE;
  v_existing jsonb;
  v_available_capabilities text[];
  v_required_capability text;
  v_capability_available boolean;
  v_capability_digest text;
  v_failure_node text;
  v_owner_reason text;
  v_expected_owner_node text;
  v_contract_ratification_state text;
  v_task_plan_changed boolean;
  v_project_plan_changed boolean;
  v_evaluation_plan_changed boolean;
  v_failure_domain text;
  v_lineage_digest text;
  v_binding_digest text;
  v_request_digest text;
  v_evidence jsonb;
  v_evidence_digest text;
  v_evidence_sources jsonb;
  v_route_generation bigint;
  v_fingerprint_occurrence integer;
  v_evidence_novel boolean;
  v_unchanged_evidence_generations integer;
  v_diagnostic_path text;
  v_project_attention boolean;
  v_allows_unchanged_retry boolean;
  v_changes_path boolean;
  v_base_reason_code text;
  v_reason_code text;
  v_canonical_reason jsonb;
  v_steps jsonb;
  v_next_action jsonb;
  v_deadline_at timestamptz;
  v_idempotency_key text;
  v_decision_digest text;
  v_decision_id uuid;
  v_output text;
BEGIN
  IF p_observed_at IS NULL OR p_lease_generation < 1
     OR p_outbox_id IS NULL OR p_obligation_id IS NULL OR p_lease_token IS NULL THEN
    RAISE EXCEPTION 'FAILURE_CONTINUATION_ROUTE_CLAIM_INVALID'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF jsonb_typeof(p_evidence_facts) <> 'object' OR pg_column_size(p_evidence_facts) > 16384 THEN
    RAISE EXCEPTION 'FAILURE_CONTINUATION_EVIDENCE_FACTS_INVALID'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_failure_node IS NOT NULL AND p_failure_node NOT IN (
    'EXTERNAL_RATE_LIMIT', 'EXTERNAL_NETWORK', 'EXTERNAL_SERVICE',
    'EVALUATION_COMMAND', 'TEST_HARNESS', 'FIXTURE_SETUP', 'ACCEPTANCE_ASSERTION',
    'PRODUCT_SOURCE', 'BUILD_ARTIFACT', 'PRODUCT_BEHAVIOR',
    'RUNTIME_CAPABILITY', 'TOOLCHAIN', 'EXECUTION_ENVIRONMENT',
    'RUNNER_INFRASTRUCTURE', 'GOAL_BOUNDARY', 'RISK_BOUNDARY',
    'AUTHORIZATION_BOUNDARY', 'EXTERNAL_IDENTITY_BOUNDARY'
  ) THEN
    RAISE EXCEPTION 'FAILURE_CONTINUATION_NODE_INVALID'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_owner_reason IS NOT NULL AND p_owner_reason NOT IN (
    'GOAL_DECISION', 'RISK_ACCEPTANCE', 'NEW_AUTHORIZATION', 'EXTERNAL_IDENTITY'
  ) THEN
    RAISE EXCEPTION 'FAILURE_CONTINUATION_OWNER_REASON_FORBIDDEN'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_required_capability IS NOT NULL
     AND (btrim(p_required_capability) = '' OR length(p_required_capability) > 200) THEN
    RAISE EXCEPTION 'FAILURE_CONTINUATION_REQUIRED_CAPABILITY_INVALID'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- A committed decision wins over transport state. The same claim replayed after ACK, lease
  -- expiry or process takeover must still read the first immutable answer.
  SELECT failure_continuation_route_read(p_obligation_id) INTO v_existing;
  IF v_existing IS NOT NULL THEN
    RETURN v_existing || jsonb_build_object('replayed', true);
  END IF;

  SELECT wakeup.state AS wakeup_state,
         wakeup.lease_token, wakeup.lease_generation, wakeup.leased_until,
         obligation.obligation_id, obligation.continuation_id, obligation.receipt_id,
         obligation.tenant_id, obligation.goal_id, obligation.task_id,
         obligation.binding_revision, obligation.attempt_generation,
         obligation.failure_fingerprint::text, obligation.reason_code AS continuation_reason_code,
         continuation.kind::text AS continuation_kind,
         continuation.status AS continuation_status,
         continuation.goal_actionable,
         receipt.attempt_id, receipt.session_id, receipt.evaluation_plan_digest::text
           AS attempt_evaluation_plan_digest,
         receipt.termination_kind::text, receipt.expected_exit_code,
         receipt.actual_exit_code, receipt.signal, receipt.output_digest::text,
         receipt.receipt_digest::text, receipt.output_truncated,
         attempt.raw_output,
         current_task.scope_revision::bigint AS current_binding_revision,
         current_task.status::text AS task_status,
         current_task.superseded_by_task_id,
         current_task.acceptance_evaluation_plan_digest::text
           AS task_evaluation_plan_digest,
         COALESCE(current_task.required_capabilities, ARRAY[]::text[])
           AS task_required_capabilities,
         runner.id AS runner_id,
         COALESCE(runner.capabilities, ARRAY[]::text[]) AS runner_capabilities,
         contract.contract_digest::text,
         contract.evaluation_plan_digest::text AS project_evaluation_plan_digest
    INTO v_context
    FROM failure_continuation_wakeup_outbox wakeup
    JOIN failure_continuation_obligation obligation
      ON obligation.obligation_id = wakeup.obligation_id
    JOIN failure_continuation_attempt_receipt receipt
      ON receipt.receipt_id = obligation.receipt_id
    JOIN task_executable_continuation continuation
      ON continuation.id = obligation.continuation_id
    JOIN task_executable_attempt attempt ON attempt.id = receipt.attempt_id
    JOIN task current_task ON current_task.id = obligation.task_id
    LEFT JOIN session source_session ON source_session.id = receipt.session_id
    LEFT JOIN workspace source_workspace ON source_workspace.id = source_session.workspace_id
    LEFT JOIN runner ON runner.id = COALESCE(
      source_session.assigned_runner_id, source_workspace.runner_id
    )
    LEFT JOIN project_completion_contract contract ON contract.project_id = obligation.goal_id
   WHERE wakeup.outbox_id = p_outbox_id
     AND wakeup.obligation_id = p_obligation_id
   FOR UPDATE OF wakeup;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'FAILURE_CONTINUATION_ROUTE_SOURCE_NOT_FOUND'
      USING ERRCODE = 'no_data_found';
  END IF;
  IF v_context.wakeup_state <> 'LEASED'
     OR v_context.lease_token IS DISTINCT FROM p_lease_token
     OR v_context.lease_generation <> p_lease_generation
     OR v_context.leased_until <= p_observed_at THEN
    RAISE EXCEPTION 'FAILURE_CONTINUATION_ROUTE_LEASE_STALE'
      USING ERRCODE = 'serialization_failure';
  END IF;
  IF v_context.continuation_kind <> 'DIAGNOSIS'
     OR v_context.continuation_status <> 'ACTIVE'
     OR NOT v_context.goal_actionable
     OR v_context.current_binding_revision <> v_context.binding_revision
     OR v_context.task_status IN ('DONE', 'CANCELLED')
     OR v_context.superseded_by_task_id IS NOT NULL THEN
    RAISE EXCEPTION 'FAILURE_CONTINUATION_ROUTE_SOURCE_STALE'
      USING ERRCODE = 'serialization_failure';
  END IF;

  v_available_capabilities := ARRAY(
    SELECT distinct_capability.capability
      FROM (
        SELECT DISTINCT capability
          FROM unnest(v_context.runner_capabilities) AS capability
         WHERE btrim(capability) <> ''
      ) distinct_capability
     ORDER BY distinct_capability.capability COLLATE "C"
  );
  v_required_capability := NULLIF(btrim(p_required_capability), '');
  IF v_required_capability IS NULL THEN
    SELECT required INTO v_required_capability
      FROM unnest(v_context.task_required_capabilities) AS required
     WHERE NOT (required = ANY(v_available_capabilities))
     ORDER BY required COLLATE "C"
     LIMIT 1;
  END IF;
  v_capability_available := v_required_capability IS NULL
    OR v_required_capability = ANY(v_available_capabilities);
  v_capability_digest := outcome_sha256_json(jsonb_build_object(
    'runnerId', v_context.runner_id::text,
    'availableCapabilities', to_jsonb(v_available_capabilities),
    'requiredCapability', v_required_capability,
    'requiredCapabilityAvailable', v_capability_available
  ));

  SELECT ratification.id, ratification.contract_digest::text,
         ratification.evaluation_plan_digest_at_decision::text
    INTO v_exact_ratification_id, v_exact_ratification_contract_digest,
         v_ratified_evaluation_plan_digest
    FROM project_owner_ratification ratification
   WHERE ratification.project_id = v_context.goal_id
     AND ratification.contract_digest::text = v_context.contract_digest
     AND (ratification.valid_through IS NULL
       OR ratification.valid_through > p_observed_at)
   ORDER BY ratification.ratified_at DESC, ratification.id DESC
   LIMIT 1;
  IF v_context.contract_digest IS NULL THEN
    v_contract_ratification_state := 'LEGACY_UNBOUND';
  ELSIF v_exact_ratification_id IS NOT NULL THEN
    v_contract_ratification_state := 'CURRENT';
  ELSE
    SELECT ratification.id
      INTO v_latest_ratification_id
      FROM project_owner_ratification ratification
     WHERE ratification.project_id = v_context.goal_id
     ORDER BY ratification.ratified_at DESC, ratification.id DESC
     LIMIT 1;
    v_contract_ratification_state := CASE
      WHEN v_latest_ratification_id IS NOT NULL THEN 'STALE' ELSE 'MISSING' END;
  END IF;
  v_task_plan_changed := v_context.task_evaluation_plan_digest IS DISTINCT FROM
    v_context.attempt_evaluation_plan_digest;
  v_project_plan_changed := v_contract_ratification_state = 'CURRENT'
    AND v_ratified_evaluation_plan_digest IS DISTINCT FROM
      v_context.project_evaluation_plan_digest;
  v_evaluation_plan_changed := v_task_plan_changed OR v_project_plan_changed;

  v_failure_node := p_failure_node;
  v_owner_reason := p_owner_reason;
  IF v_owner_reason IS NOT NULL THEN
    v_expected_owner_node := CASE v_owner_reason
      WHEN 'GOAL_DECISION' THEN 'GOAL_BOUNDARY'
      WHEN 'RISK_ACCEPTANCE' THEN 'RISK_BOUNDARY'
      WHEN 'NEW_AUTHORIZATION' THEN 'AUTHORIZATION_BOUNDARY'
      WHEN 'EXTERNAL_IDENTITY' THEN 'EXTERNAL_IDENTITY_BOUNDARY'
    END;
    IF v_failure_node IS NULL THEN
      v_failure_node := v_expected_owner_node;
    ELSIF v_failure_node <> v_expected_owner_node THEN
      RAISE EXCEPTION 'FAILURE_CONTINUATION_OWNER_REASON_NODE_MISMATCH'
        USING ERRCODE = 'invalid_parameter_value';
    END IF;
  END IF;

  -- Text can select an engineering node only. It can never manufacture an owner decision.
  IF v_failure_node IS NULL THEN
    v_output := lower(COALESCE(v_context.raw_output, ''));
    IF NOT v_capability_available THEN
      v_failure_node := 'RUNTIME_CAPABILITY';
    ELSIF v_context.termination_kind IN ('START_FAILED', 'INFRASTRUCTURE_LOST') THEN
      v_failure_node := 'RUNNER_INFRASTRUCTURE';
    ELSIF v_output ~ '(\m429\M|rate.?limit|econnreset|econnrefused|enotfound|dns|service unavailable|\m503\M)' THEN
      v_failure_node := 'EXTERNAL_SERVICE';
    ELSIF v_output ~ '(prisma/config|cannot find module|fixture|test harness|test runner|tap version|configuration error)' THEN
      v_failure_node := 'FIXTURE_SETUP';
    ELSIF v_context.termination_kind = 'TIMED_OUT' THEN
      v_failure_node := 'TEST_HARNESS';
    ELSIF v_context.termination_kind IN ('CANCELLED', 'SIGNALED') THEN
      v_failure_node := 'EXECUTION_ENVIRONMENT';
    ELSE
      v_failure_node := 'PRODUCT_BEHAVIOR';
    END IF;
  END IF;

  IF v_failure_node IN (
    'GOAL_BOUNDARY', 'RISK_BOUNDARY', 'AUTHORIZATION_BOUNDARY',
    'EXTERNAL_IDENTITY_BOUNDARY'
  ) THEN
    v_owner_reason := COALESCE(v_owner_reason, CASE v_failure_node
      WHEN 'GOAL_BOUNDARY' THEN 'GOAL_DECISION'
      WHEN 'RISK_BOUNDARY' THEN 'RISK_ACCEPTANCE'
      WHEN 'AUTHORIZATION_BOUNDARY' THEN 'NEW_AUTHORIZATION'
      WHEN 'EXTERNAL_IDENTITY_BOUNDARY' THEN 'EXTERNAL_IDENTITY'
    END);
  ELSIF v_contract_ratification_state = 'STALE' THEN
    v_owner_reason := 'GOAL_DECISION';
    v_failure_node := 'GOAL_BOUNDARY';
  END IF;

  -- Fixed total order: every admitted context reaches exactly one domain.
  IF v_owner_reason IS NOT NULL THEN
    v_failure_domain := 'OWNER_REQUIRED';
  ELSIF NOT v_capability_available THEN
    v_failure_domain := 'CAPABILITY/ENVIRONMENT';
    v_failure_node := 'RUNTIME_CAPABILITY';
  ELSIF v_evaluation_plan_changed THEN
    v_failure_domain := 'EVALUATION_HARNESS';
  ELSIF v_context.termination_kind IN ('START_FAILED', 'INFRASTRUCTURE_LOST') THEN
    v_failure_domain := 'CAPABILITY/ENVIRONMENT';
  ELSIF v_failure_node IN ('EXTERNAL_RATE_LIMIT', 'EXTERNAL_NETWORK', 'EXTERNAL_SERVICE') THEN
    v_failure_domain := 'TRANSIENT_EXTERNAL';
  ELSIF v_failure_node IN (
    'EVALUATION_COMMAND', 'TEST_HARNESS', 'FIXTURE_SETUP', 'ACCEPTANCE_ASSERTION'
  ) THEN
    v_failure_domain := 'EVALUATION_HARNESS';
  ELSIF v_failure_node IN ('PRODUCT_SOURCE', 'BUILD_ARTIFACT', 'PRODUCT_BEHAVIOR') THEN
    v_failure_domain := 'PRODUCT_ARTIFACT';
  ELSIF v_failure_node IN (
    'RUNTIME_CAPABILITY', 'TOOLCHAIN', 'EXECUTION_ENVIRONMENT', 'RUNNER_INFRASTRUCTURE'
  ) THEN
    v_failure_domain := 'CAPABILITY/ENVIRONMENT';
  ELSE
    RAISE EXCEPTION 'FAILURE_CONTINUATION_DOMAIN_NOT_TOTAL'
      USING ERRCODE = 'check_violation';
  END IF;

  v_lineage_digest := outcome_sha256_json(jsonb_build_object(
    'namespace', 'orbit.failure-continuation-lineage.v1',
    'tenantId', v_context.tenant_id::text,
    'goalId', v_context.goal_id::text,
    'contractDigest', COALESCE(v_context.contract_digest, 'LEGACY_UNBOUND'),
    'failureFingerprint', v_context.failure_fingerprint
  ));
  v_binding_digest := outcome_sha256_json(jsonb_build_object(
    'namespace', 'orbit.failure-continuation-binding.v1',
    'goalId', v_context.goal_id::text,
    'taskId', v_context.task_id::text,
    'bindingRevision', v_context.binding_revision::text,
    'contractDigest', v_context.contract_digest,
    'attemptEvaluationPlanDigest', v_context.attempt_evaluation_plan_digest,
    'taskEvaluationPlanDigest', v_context.task_evaluation_plan_digest,
    'projectEvaluationPlanDigest', v_context.project_evaluation_plan_digest,
    'capabilityDigest', v_capability_digest
  ));
  v_request_digest := outcome_sha256_json(jsonb_build_object(
    'namespace', 'orbit.failure-continuation-route-request.v1',
    'obligationId', p_obligation_id::text,
    'failureNode', p_failure_node,
    'ownerReason', p_owner_reason,
    'requiredCapability', p_required_capability,
    'evidenceFacts', p_evidence_facts
  ));
  v_evidence := jsonb_build_object(
    'schemaVersion', 1,
    'terminationKind', v_context.termination_kind,
    'expectedExitCode', v_context.expected_exit_code,
    'actualExitCode', v_context.actual_exit_code,
    'signal', v_context.signal,
    'outputDigest', v_context.output_digest,
    'outputTruncated', v_context.output_truncated,
    'failureNode', v_failure_node,
    'continuationReasonCode', v_context.continuation_reason_code,
    'attemptEvaluationPlanDigest', v_context.attempt_evaluation_plan_digest,
    'taskEvaluationPlanDigest', v_context.task_evaluation_plan_digest,
    'projectEvaluationPlanDigest', v_context.project_evaluation_plan_digest,
    'ratifiedEvaluationPlanDigest', v_ratified_evaluation_plan_digest,
    'contractDigest', v_context.contract_digest,
    'contractRatificationState', v_contract_ratification_state,
    'requiredCapability', v_required_capability,
    'availableCapabilities', to_jsonb(v_available_capabilities),
    'capabilityAvailable', v_capability_available,
    'facts', p_evidence_facts
  );
  v_evidence_digest := outcome_sha256_json(v_evidence);
  v_evidence_sources := jsonb_build_array(
    jsonb_build_object(
      'kind', 'ATTEMPT_RECEIPT',
      'locator', 'failure_continuation_attempt_receipt:' || v_context.receipt_id::text,
      'digest', v_context.receipt_digest
    ),
    jsonb_build_object(
      'kind', 'EXECUTABLE_OUTPUT',
      'locator', 'task_executable_attempt:' || v_context.attempt_id::text || ':rawOutput',
      'digest', v_context.output_digest
    ),
    jsonb_build_object(
      'kind', 'TASK_BINDING',
      'locator', 'task:' || v_context.task_id::text || ':scope:'
        || v_context.binding_revision::text,
      'digest', v_binding_digest
    ),
    jsonb_build_object(
      'kind', 'RUNNER_CAPABILITY_SNAPSHOT',
      'locator', COALESCE('runner:' || v_context.runner_id::text, 'runner:unassigned'),
      'digest', v_capability_digest
    )
  ) || CASE WHEN v_context.contract_digest IS NULL THEN '[]'::jsonb ELSE jsonb_build_array(
    jsonb_build_object(
      'kind', 'PROJECT_CONTRACT',
      'locator', 'project_completion_contract:' || v_context.goal_id::text,
      'digest', v_context.contract_digest
    )
  ) END || CASE WHEN v_exact_ratification_id IS NULL THEN '[]'::jsonb ELSE jsonb_build_array(
    jsonb_build_object(
      'kind', 'OWNER_RATIFICATION',
      'locator', 'project_owner_ratification:' || v_exact_ratification_id::text,
      'digest', v_exact_ratification_contract_digest
    )
  ) END;

  -- Serialize independent successor tasks carrying the same fingerprint under one project-wide
  -- lineage. The lock is transaction-scoped and cannot leak after a process crash.
  PERFORM pg_advisory_xact_lock(hashtextextended(
    'failure-continuation-route:' || v_context.tenant_id::text || ':' || v_lineage_digest,
    0
  ));
  SELECT failure_continuation_route_read(p_obligation_id) INTO v_existing;
  IF v_existing IS NOT NULL THEN
    RETURN v_existing || jsonb_build_object('replayed', true);
  END IF;
  SELECT * INTO v_previous
    FROM failure_continuation_route_decision decision
   WHERE decision.tenant_id = v_context.tenant_id
     AND decision.lineage_digest = v_lineage_digest
   ORDER BY decision.route_generation DESC
   LIMIT 1;
  IF FOUND THEN
    v_route_generation := v_previous.route_generation + 1;
    v_evidence_novel := v_previous.evidence_digest::text <> v_evidence_digest;
    v_unchanged_evidence_generations := CASE WHEN v_evidence_novel THEN 1
      ELSE v_previous.unchanged_evidence_generations + 1 END;
  ELSE
    v_route_generation := 1;
    v_evidence_novel := true;
    v_unchanged_evidence_generations := 1;
  END IF;
  v_fingerprint_occurrence := v_route_generation::integer;

  v_project_attention := v_failure_domain <> 'OWNER_REQUIRED'
    AND v_unchanged_evidence_generations >= 3;
  IF v_failure_domain = 'OWNER_REQUIRED' THEN
    v_diagnostic_path := 'OWNER_DECISION';
  ELSIF v_project_attention THEN
    v_diagnostic_path := 'PROJECT_ATTENTION';
  ELSIF v_fingerprint_occurrence >= 2 THEN
    v_diagnostic_path := 'ALTERNATE_DIAGNOSIS';
  ELSE
    v_diagnostic_path := 'PRIMARY_RECOVERY';
  END IF;
  v_allows_unchanged_retry := v_failure_domain = 'TRANSIENT_EXTERNAL'
    AND v_fingerprint_occurrence = 1 AND NOT v_project_attention;
  v_changes_path := v_diagnostic_path <> 'PRIMARY_RECOVERY';

  v_base_reason_code := CASE
    WHEN v_failure_domain = 'OWNER_REQUIRED' THEN v_owner_reason || '_REQUIRED'
    WHEN NOT v_capability_available THEN 'REQUIRED_CAPABILITY_UNAVAILABLE'
    WHEN v_evaluation_plan_changed THEN 'EVALUATION_PLAN_CHANGED_REVALIDATION_REQUIRED'
    ELSE replace(v_failure_domain, '/', '_') || '_' || v_context.termination_kind
  END;
  v_reason_code := CASE WHEN v_project_attention
    THEN 'FAILURE_CONTINUATION_NO_NEW_EVIDENCE_THREE_GENERATIONS'
    ELSE v_base_reason_code END;

  IF v_failure_domain = 'OWNER_REQUIRED' THEN
    v_deadline_at := p_observed_at + interval '24 hours';
    v_steps := jsonb_build_array(jsonb_build_object(
      'kind', 'WAIT_FOR_EXACT_OWNER_DECISION',
      'reason', v_owner_reason
    ));
  ELSIF v_project_attention THEN
    v_deadline_at := p_observed_at + interval '1 hour';
    v_steps := jsonb_build_array(
      jsonb_build_object('kind', 'PUBLISH_PROJECT_ATTENTION',
        'reason', 'THREE_GENERATIONS_WITHOUT_NEW_EVIDENCE'),
      jsonb_build_object('kind', 'SELECT_DIFFERENT_DIAGNOSTIC_PATH'),
      jsonb_build_object('kind', 'PRESERVE_FAILED_ATTEMPTS_AND_EVIDENCE')
    );
  ELSIF v_failure_domain = 'TRANSIENT_EXTERNAL' AND v_allows_unchanged_retry THEN
    v_deadline_at := p_observed_at + interval '10 minutes';
    v_steps := jsonb_build_array(
      jsonb_build_object('kind', 'MONITOR_EXTERNAL_DEPENDENCY'),
      jsonb_build_object('kind', 'RETRY', 'mode', 'UNCHANGED_ONCE',
        'maximumUnchangedRetries', 1),
      jsonb_build_object('kind', 'REVALIDATE_RESULT')
    );
  ELSIF v_failure_domain = 'TRANSIENT_EXTERNAL' THEN
    v_deadline_at := p_observed_at + interval '20 minutes';
    v_steps := jsonb_build_array(
      jsonb_build_object('kind', 'COLLECT_DISTINCT_EXTERNAL_EVIDENCE'),
      jsonb_build_object('kind', 'CHANGE_RETRY_OR_PROVIDER_PATH'),
      jsonb_build_object('kind', 'REVALIDATE_RESULT')
    );
  ELSIF v_failure_domain = 'EVALUATION_HARNESS' THEN
    v_deadline_at := p_observed_at + interval '30 minutes';
    v_steps := jsonb_build_array(
      jsonb_build_object('kind', 'DIAGNOSE_EVALUATION_BOUNDARY'),
      jsonb_build_object('kind', CASE WHEN v_evaluation_plan_changed
        THEN 'REVALIDATE_CURRENT_EVALUATION_PLAN' ELSE 'REPAIR_EVALUATION_HARNESS' END),
      jsonb_build_object('kind', 'RUN_ISOLATED_REVALIDATION')
    );
  ELSIF v_failure_domain = 'PRODUCT_ARTIFACT' THEN
    v_deadline_at := p_observed_at + interval '1 hour';
    v_steps := jsonb_build_array(
      jsonb_build_object('kind', CASE WHEN v_diagnostic_path = 'ALTERNATE_DIAGNOSIS'
        THEN 'ISOLATE_PRODUCT_DEFECT_WITH_ALTERNATE_METHOD'
        ELSE 'DIAGNOSE_PRODUCT_ARTIFACT' END),
      jsonb_build_object('kind', 'CREATE_PRODUCT_REPAIR_PLAN'),
      jsonb_build_object('kind', 'REVALIDATE_REPAIRED_ARTIFACT')
    );
  ELSE
    v_deadline_at := p_observed_at + interval '30 minutes';
    v_steps := jsonb_build_array(
      jsonb_build_object('kind', CASE WHEN v_capability_available
        THEN 'DIAGNOSE_EXECUTION_ENVIRONMENT' ELSE 'PROVISION_OR_REBIND_CAPABILITY' END,
        'requiredCapability', v_required_capability),
      jsonb_build_object('kind', 'CHANGE_RUNTIME_OR_TOOLCHAIN_IF_NEEDED'),
      jsonb_build_object('kind', 'REVALIDATE_IN_BOUND_ENVIRONMENT')
    );
  END IF;

  v_canonical_reason := jsonb_build_object(
    'code', v_reason_code,
    'baseCode', v_base_reason_code,
    'failureDomain', v_failure_domain,
    'failureNode', v_failure_node,
    'failureFingerprint', v_context.failure_fingerprint,
    'terminationKind', v_context.termination_kind,
    'continuationReasonCode', v_context.continuation_reason_code,
    'ownerReason', v_owner_reason,
    'contractRatificationState', v_contract_ratification_state,
    'taskEvaluationPlanChanged', v_task_plan_changed,
    'projectEvaluationPlanChanged', v_project_plan_changed,
    'requiredCapability', v_required_capability,
    'capabilityAvailable', v_capability_available,
    'fingerprintOccurrence', v_fingerprint_occurrence,
    'evidenceNovel', v_evidence_novel,
    'unchangedEvidenceGenerations', v_unchanged_evidence_generations
  );
  v_idempotency_key := outcome_sha256_json(jsonb_build_object(
    'namespace', 'orbit.failure-continuation-route.v1',
    'obligationId', p_obligation_id::text
  ));
  v_next_action := jsonb_build_object(
    'kind', CASE
      WHEN v_failure_domain = 'OWNER_REQUIRED' THEN 'REQUEST_OWNER_DECISION'
      WHEN v_project_attention THEN 'PROJECT_ATTENTION'
      WHEN v_failure_domain = 'TRANSIENT_EXTERNAL' AND v_allows_unchanged_retry
        THEN 'RETRY_UNCHANGED_ONCE'
      WHEN v_failure_domain = 'TRANSIENT_EXTERNAL' THEN 'DIAGNOSE_EXTERNAL_DEPENDENCY'
      WHEN v_failure_domain = 'EVALUATION_HARNESS' AND v_evaluation_plan_changed
        THEN 'REVALIDATE_EVALUATION_PLAN'
      WHEN v_failure_domain = 'EVALUATION_HARNESS' THEN 'REPAIR_EVALUATION_HARNESS'
      WHEN v_failure_domain = 'PRODUCT_ARTIFACT' THEN 'REPAIR_PRODUCT_ARTIFACT'
      ELSE 'REPAIR_CAPABILITY_OR_ENVIRONMENT'
    END,
    'actor', CASE WHEN v_failure_domain = 'OWNER_REQUIRED' THEN 'OWNER'
      WHEN v_project_attention THEN 'PROJECT_COORDINATOR' ELSE 'AGENT' END,
    'diagnosticPath', v_diagnostic_path,
    'changesDiagnosticPath', v_changes_path,
    'allowsUnchangedRetry', v_allows_unchanged_retry,
    'requiresOwnerDecision', v_failure_domain = 'OWNER_REQUIRED',
    'projectAttention', v_project_attention,
    'deadlineAt', to_jsonb(v_deadline_at),
    'steps', v_steps,
    'ownerDecision', CASE WHEN v_failure_domain <> 'OWNER_REQUIRED' THEN NULL ELSE
      jsonb_build_object(
        'reason', v_owner_reason,
        'whyNotAgent', CASE v_owner_reason
          WHEN 'GOAL_DECISION' THEN 'Only the owner may choose or ratify a changed goal contract.'
          WHEN 'RISK_ACCEPTANCE' THEN 'Only the owner may accept risk outside the ratified boundary.'
          WHEN 'NEW_AUTHORIZATION' THEN 'The agent has no authority to grant itself a new permission.'
          WHEN 'EXTERNAL_IDENTITY' THEN 'The agent cannot choose or supply the owner external identity.'
        END,
        'options', jsonb_build_array(
          jsonb_build_object('id', 'APPROVE_BOUND_REQUEST', 'label', 'Approve bounded request'),
          jsonb_build_object('id', 'REVISE_OR_DENY', 'label', 'Revise or deny')
        ),
        'impacts', jsonb_build_array(jsonb_build_object(
          'failureFingerprint', v_context.failure_fingerprint,
          'blockedAction', v_steps
        )),
        'recommendation', 'Choose the narrowest option that preserves the current contract.',
        'noActionConsequence', 'The failed goal remains open and no unauthorized action runs.',
        'cost', jsonb_build_object('automationBudgetRequired', false),
        'deadline', to_jsonb(v_deadline_at),
        'resumeBehavior', 'The coordinator resumes the same obligation revision after the decision.',
        'idempotencyKey', v_idempotency_key
      ) END
  );
  v_decision_digest := outcome_sha256_json(jsonb_build_object(
    'namespace', 'orbit.failure-continuation-route-decision.v1',
    'obligationId', p_obligation_id::text,
    'lineageDigest', v_lineage_digest,
    'bindingDigest', v_binding_digest,
    'routeGeneration', v_route_generation::text,
    'failureDomain', v_failure_domain,
    'failureNode', v_failure_node,
    'ownerReason', v_owner_reason,
    'failureFingerprint', v_context.failure_fingerprint,
    'canonicalReason', v_canonical_reason,
    'evidenceDigest', v_evidence_digest,
    'evidenceSources', v_evidence_sources,
    'nextAction', v_next_action,
    'deadlineAt', to_jsonb(v_deadline_at),
    'projectAttention', v_project_attention
  ));

  INSERT INTO failure_continuation_route_decision (
    decision_id, obligation_id, continuation_id, receipt_id, tenant_id, goal_id, task_id,
    lineage_digest, binding_digest, route_generation, contract_digest,
    attempt_evaluation_plan_digest, task_evaluation_plan_digest,
    project_evaluation_plan_digest, ratified_evaluation_plan_digest,
    contract_ratification_state, task_evaluation_plan_changed,
    project_evaluation_plan_changed, failure_domain, failure_node, owner_reason,
    failure_fingerprint, fingerprint_occurrence, evidence_novel,
    unchanged_evidence_generations, diagnostic_path, reason_code, canonical_reason,
    canonical_reason_digest, evidence, evidence_digest, evidence_sources, next_action,
    next_action_digest, deadline_at, project_attention, request_digest, decision_digest,
    idempotency_key, decided_at
  ) VALUES (
    gen_random_uuid(), v_context.obligation_id, v_context.continuation_id,
    v_context.receipt_id, v_context.tenant_id, v_context.goal_id, v_context.task_id,
    v_lineage_digest, v_binding_digest, v_route_generation, v_context.contract_digest,
    v_context.attempt_evaluation_plan_digest, v_context.task_evaluation_plan_digest,
    v_context.project_evaluation_plan_digest,
    v_ratified_evaluation_plan_digest,
    v_contract_ratification_state, v_task_plan_changed, v_project_plan_changed,
    v_failure_domain, v_failure_node, v_owner_reason, v_context.failure_fingerprint,
    v_fingerprint_occurrence, v_evidence_novel, v_unchanged_evidence_generations,
    v_diagnostic_path, v_reason_code, v_canonical_reason,
    outcome_sha256_json(v_canonical_reason), v_evidence, v_evidence_digest,
    v_evidence_sources, v_next_action, outcome_sha256_json(v_next_action),
    v_deadline_at, v_project_attention, v_request_digest, v_decision_digest,
    v_idempotency_key, p_observed_at
  )
  RETURNING decision_id INTO v_decision_id;

  RETURN failure_continuation_route_read(p_obligation_id)
    || jsonb_build_object('replayed', false);
END;
$$;

-- Canonical read projections for the later UI integration. Ordinary engineering failures can
-- appear in neither projection merely because they failed; attention is a convergence/SLA fact,
-- and the decision inbox is a closed four-reason authority boundary.
CREATE VIEW failure_continuation_owner_decision_inbox AS
SELECT decision.decision_id, decision.tenant_id, decision.goal_id, decision.task_id,
       decision.obligation_id, decision.binding_digest, decision.failure_fingerprint,
       decision.owner_reason, decision.canonical_reason, decision.evidence_sources,
       decision.next_action, decision.deadline_at, decision.decision_digest,
       decision.recorded_at
  FROM failure_continuation_route_decision decision
  JOIN task_executable_continuation continuation
    ON continuation.id = decision.continuation_id
  JOIN task current_task ON current_task.id = decision.task_id
 WHERE decision.failure_domain = 'OWNER_REQUIRED'
   AND decision.owner_reason IN (
     'GOAL_DECISION', 'RISK_ACCEPTANCE', 'NEW_AUTHORIZATION', 'EXTERNAL_IDENTITY'
   )
   AND continuation.status = 'ACTIVE'
   AND current_task.status NOT IN ('DONE', 'CANCELLED')
   AND current_task.superseded_by_task_id IS NULL;

CREATE VIEW failure_continuation_project_attention AS
SELECT decision.decision_id, decision.tenant_id, decision.goal_id, decision.task_id,
       decision.obligation_id, decision.binding_digest, decision.failure_domain,
       decision.failure_node, decision.failure_fingerprint, decision.canonical_reason,
       decision.evidence_sources, decision.next_action, decision.deadline_at,
       decision.decision_digest, decision.recorded_at
  FROM failure_continuation_route_decision decision
  JOIN task_executable_continuation continuation
    ON continuation.id = decision.continuation_id
  JOIN task current_task ON current_task.id = decision.task_id
 WHERE decision.project_attention = true
   AND continuation.status = 'ACTIVE'
   AND current_task.status NOT IN ('DONE', 'CANCELLED')
   AND current_task.superseded_by_task_id IS NULL;

COMMENT ON TABLE failure_continuation_route_decision IS
  'Append-only deterministic route for one claimed canonical failure continuation, including reason, evidence, bounded next action and deadline.';
COMMENT ON FUNCTION failure_continuation_route_claim(
  uuid, uuid, uuid, bigint, timestamptz, text, text, text, jsonb
) IS
  'Lease-fenced atomic failure-domain reducer. One unchanged retry maximum; second same fingerprint changes path; third unchanged-evidence generation enters Project Attention.';
COMMENT ON VIEW failure_continuation_owner_decision_inbox IS
  'Only the four owner-only Failure Continuation reasons; ordinary engineering failures are structurally absent.';
COMMENT ON VIEW failure_continuation_project_attention IS
  'Failure Continuations that crossed the hard no-new-evidence convergence boundary; not an owner decision inbox.';
