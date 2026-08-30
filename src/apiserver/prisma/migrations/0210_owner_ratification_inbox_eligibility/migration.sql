-- Owner Ratification requests are append-only audit facts.  A PENDING audit fact is not by
-- itself an instruction to interrupt the owner: active routing additionally requires an OPEN
-- project and a current contract whose execution is waiting at a ratification boundary.

BEGIN;

ALTER TABLE "project_owner_decision_request"
  ADD COLUMN "routing_state" TEXT NOT NULL DEFAULT 'ACTIONABLE',
  ADD COLUMN "routing_reason_code" TEXT NOT NULL DEFAULT 'OWNER_RATIFICATION_EXPLICIT_CONTRACT_CHANGE',
  ADD COLUMN "deferred_at" TIMESTAMPTZ;

ALTER TABLE "project_owner_decision_request"
  ADD CONSTRAINT "project_owner_decision_routing_state_check"
    CHECK ("routing_state" IN ('ACTIONABLE', 'DEFERRED')),
  ADD CONSTRAINT "project_owner_decision_deferred_shape_check"
    CHECK (("routing_state" = 'DEFERRED') = ("deferred_at" IS NOT NULL));

-- 0195 created one generation=1/revision=1/initial request for every then-existing Project in one
-- migration batch.  These rows remain PENDING audit history, but they do not become owner work
-- until a current obligation or guarded action actually reaches the ratification boundary.
UPDATE "project_owner_decision_request"
   SET "routing_state" = 'DEFERRED',
       "routing_reason_code" = 'OWNER_RATIFICATION_LEGACY_INITIAL_BACKFILL',
       "deferred_at" = "created_at"
 WHERE "status" = 'PENDING'
   AND "request_generation" = 1
   AND "contract_revision" = 1
   AND "semantic_diff" @> '{"initial":true}'::jsonb;

COMMENT ON COLUMN "project_owner_decision_request"."routing_state" IS
  'Audit disposition, not the live inbox decision. DEFERRED legacy initial rows become live only while the shared eligibility projection observes a current blocking obligation/action.';
COMMENT ON COLUMN "project_owner_decision_request"."routing_reason_code" IS
  'Why the request was derived or deferred. Live reason/eligibility is computed from current Project, binding and obligation state.';
COMMENT ON COLUMN "project_owner_decision_request"."deferred_at" IS
  'Non-null only for a request deliberately retained as deferred audit history.';

-- Every active consumer uses these exact obligation identities.  The task dispatcher is the
-- ordinary guarded-execution boundary; the Outcome evaluator is the canonical closure boundary;
-- and an authorized-but-not-yet-committed ratified action is a concrete side-effect boundary.
CREATE FUNCTION project_owner_ratification_blockers(
  p_owner UUID,
  p_project UUID,
  p_contract TEXT
) RETURNS JSONB AS $$
DECLARE
  items JSONB;
BEGIN
  SELECT COALESCE(jsonb_agg(candidate.item ORDER BY candidate.source_rank,
                            candidate.observed_at, candidate.identity), '[]'::jsonb)
    INTO items
    FROM (
      SELECT 10 AS source_rank, state."first_observed_at" AS observed_at,
             revision."obligation_id"::text AS identity,
             jsonb_build_object(
               'obligationSource', 'AUTO_DISPATCH',
               'obligationId', revision."obligation_id"::text,
               'obligationRevision', revision."obligation_revision"::text,
               'bindingDigest', revision."binding_digest"::text,
               'evaluatedThroughWatermark', state."watermark"::text,
               'taskId', state."task_id"::text,
               'reasonCode', 'OWNER_RATIFICATION_REQUIRED',
               'sourceReasonCode', revision."reason_code",
               'reason', revision."reason"
             ) AS item
        FROM "task_auto_dispatch_state" state
        JOIN "task_auto_dispatch_obligation_revision" revision
          ON revision."tenant_id" = state."tenant_id"
         AND revision."task_id" = state."task_id"
         AND revision."obligation_revision" = state."obligation_revision"
       WHERE state."tenant_id" = p_owner
         AND state."project_id" = p_project
         AND state."state" = 'ACTIVE'
         AND revision."reason_code" = 'OWNER_RATIFICATION_REQUIRED'
         AND revision."binding"->>'contractDigest' = p_contract

      UNION ALL

      SELECT 20, revision."created_at", active."obligation_id"::text,
             jsonb_build_object(
               'obligationSource', 'CANONICAL_OUTCOME',
               'obligationId', active."obligation_id"::text,
               'obligationRevision', active."obligation_revision"::text,
               'bindingDigest', active."binding_digest"::text,
               'evaluatedThroughWatermark', active."evaluated_through_logical_time"::text,
               'reasonCode', 'OWNER_RATIFICATION_REQUIRED',
               'sourceReasonCode', active."obligation"#>>'{reason,code}',
               'reason', active."obligation"->'reason'
             )
        FROM "outcome_active_obligation" active
        JOIN "outcome_obligation_revision" revision
          ON revision."tenant_id" = active."tenant_id"
         AND revision."project_id" = active."project_id"
         AND revision."obligation_revision" = active."obligation_revision"
        JOIN "outcome_fact_binding" binding
          ON binding."tenant_id" = active."tenant_id"
         AND binding."project_id" = active."project_id"
         AND binding."binding_digest" = active."binding_digest"
       WHERE active."tenant_id" = p_owner
         AND active."project_id" = p_project
         AND active."obligation"->'blocksClosureOf' ? 'CONTRACT_RATIFICATION'
         AND binding."binding"->>'contractDigest' = p_contract

      UNION ALL

      SELECT 30, intent."created_at",
             encode(digest('project-ratified-action:' || intent."id"::text, 'sha256'), 'hex'),
             jsonb_build_object(
               'obligationSource', 'CONSTRAINED_ACTION',
               'obligationId', encode(digest(
                 'project-ratified-action:' || intent."id"::text, 'sha256'), 'hex'),
               'obligationRevision', encode(digest(
                 'project-ratified-action:' || intent."id"::text || ':' ||
                 intent."contract_revision"::text || ':' || intent."contract_digest"::text,
                 'sha256'), 'hex'),
               'bindingDigest', COALESCE(intent."outcome_binding_digest"::text,
                                         intent."contract_digest"::text),
               'evaluatedThroughWatermark', COALESCE(
                 intent."outcome_watermark_logical_time"::text,
                 intent."contract_revision"::text),
               'actionIntentId', intent."id"::text,
               'reasonCode', 'OWNER_RATIFICATION_REQUIRED',
               'sourceReasonCode', 'RATIFIED_ACTION_COMMIT_WAITING',
               'reason', jsonb_build_object(
                 'code', 'OWNER_RATIFICATION_REQUIRED',
                 'message', 'A bound side-effect action is waiting for the exact current contract ratification.',
                 'nextAction', 'owner.ratification.review'
               )
             )
        FROM "project_ratified_action_intent" intent
        LEFT JOIN "project_ratified_action_commit" committed
          ON committed."intent_id" = intent."id"
       WHERE intent."owner_id" = p_owner
         AND intent."project_id" = p_project
         AND intent."contract_digest"::text = p_contract
         AND committed."intent_id" IS NULL
         AND (intent."trigger_kind" = 'AUTO' OR intent."effect_class" NOT IN
              ('READ_ONLY_ANALYSIS', 'PLANNING', 'DISCARDABLE_EXPLORATION'))
    ) candidate;
  RETURN items;
END;
$$ LANGUAGE plpgsql STABLE;

-- One explainable eligibility projection for API, canonical reference, inbox, Project Attention
-- and detail. `requiresOwnerNow` survives an expired/missing CTA so the detail read can rotate it;
-- `eligible` means the exact request is safe to expose as an active decision right now.
CREATE FUNCTION project_owner_ratification_eligibility(
  p_owner UUID,
  p_project UUID,
  p_request UUID DEFAULT NULL
) RETURNS JSONB AS $$
DECLARE
  project_row "project"%ROWTYPE;
  contract_row "project_completion_contract"%ROWTYPE;
  request_row "project_owner_decision_request"%ROWTYPE;
  blockers JSONB := '[]'::jsonb;
  effective BOOLEAN := false;
  request_current BOOLEAN := false;
  activation_present BOOLEAN := false;
  requires_owner BOOLEAN := false;
  eligible_value BOOLEAN := false;
  binding_status TEXT := 'MISSING';
  reason_code TEXT;
  reason_value TEXT;
  activation_source TEXT;
BEGIN
  SELECT * INTO project_row FROM "project"
   WHERE "id" = p_project AND "owner_id" = p_owner;
  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'schemaVersion', 1, 'eligible', false, 'requiresOwnerNow', false,
      'state', 'INELIGIBLE', 'reasonCode', 'OWNER_RATIFICATION_PROJECT_NOT_FOUND',
      'reason', 'The Project is not visible to this owner.',
      'projectStatus', NULL, 'bindingStatus', 'MISSING',
      'activationSource', NULL, 'linkedObligations', '[]'::jsonb
    );
  END IF;

  SELECT * INTO contract_row FROM "project_completion_contract"
   WHERE "project_id" = p_project;
  IF p_request IS NULL THEN
    SELECT * INTO request_row FROM "project_owner_decision_request"
     WHERE "project_id" = p_project AND "owner_id" = p_owner AND "status" = 'PENDING'
     ORDER BY "request_generation" DESC LIMIT 1;
  ELSE
    SELECT * INTO request_row FROM "project_owner_decision_request"
     WHERE "id" = p_request AND "project_id" = p_project AND "owner_id" = p_owner;
  END IF;

  IF contract_row."project_id" IS NOT NULL THEN
    effective := project_owner_ratification_effective(
      p_project, contract_row."contract_digest"::text
    );
    blockers := project_owner_ratification_blockers(
      p_owner, p_project, contract_row."contract_digest"::text
    );
    IF effective THEN
      binding_status := 'EFFECTIVE';
    ELSIF EXISTS (
      SELECT 1 FROM "project_owner_ratification" historical
       WHERE historical."project_id" = p_project
    ) THEN
      binding_status := 'STALE';
    END IF;
  END IF;

  request_current := request_row."id" IS NOT NULL
    AND request_row."status" = 'PENDING'
    AND contract_row."project_id" IS NOT NULL
    AND request_row."contract_digest" = contract_row."contract_digest"
    AND request_row."contract_revision" = contract_row."contract_revision";
  activation_present := COALESCE(jsonb_array_length(blockers), 0) > 0
    OR (request_current AND request_row."routing_state" = 'ACTIONABLE');
  requires_owner := project_row."status"::text = 'OPEN'
    AND contract_row."project_id" IS NOT NULL
    AND NOT effective
    AND activation_present;
  eligible_value := requires_owner
    AND request_current
    AND request_row."expires_at" > CURRENT_TIMESTAMP;
  activation_source := COALESCE(
    blockers#>>'{0,obligationSource}',
    CASE WHEN request_row."routing_state" = 'ACTIONABLE'
      THEN request_row."routing_reason_code" ELSE NULL END
  );

  IF project_row."status"::text <> 'OPEN' THEN
    reason_code := 'OWNER_RATIFICATION_PROJECT_NOT_OPEN';
    reason_value := format(
      'Project status is %s; retained Owner Ratification requests are audit-only.',
      project_row."status"::text
    );
  ELSIF contract_row."project_id" IS NULL THEN
    reason_code := 'OWNER_RATIFICATION_CONTRACT_MISSING';
    reason_value := 'No current completion contract is available for an owner decision.';
  ELSIF effective THEN
    reason_code := 'OWNER_RATIFICATION_CURRENT_BINDING_EFFECTIVE';
    reason_value := 'The exact current contract binding already has an effective ratification.';
  ELSIF NOT activation_present THEN
    reason_code := 'OWNER_RATIFICATION_DEFERRED_NO_BLOCKING_ACTION';
    reason_value := 'The unratified legacy request is retained for audit, but no current canonical obligation or guarded action is blocked by it.';
  ELSIF request_row."id" IS NULL THEN
    reason_code := 'OWNER_RATIFICATION_REQUEST_DERIVATION_REQUIRED';
    reason_value := 'A current obligation is blocked and an exact decision request must be derived.';
  ELSIF NOT request_current THEN
    reason_code := 'OWNER_RATIFICATION_REQUEST_STALE';
    reason_value := 'This audit request is not bound to the exact current contract revision.';
  ELSIF request_row."expires_at" <= CURRENT_TIMESTAMP THEN
    reason_code := 'OWNER_RATIFICATION_REQUEST_EXPIRED';
    reason_value := 'The owner is required now, but this request capability must be rotated first.';
  ELSE
    reason_code := 'OWNER_RATIFICATION_REQUIRED';
    reason_value := CASE blockers#>>'{0,obligationSource}'
      WHEN 'AUTO_DISPATCH' THEN
        'An OPEN Project has a canonical automatic action blocked on ratification of the exact current contract.'
      WHEN 'CANONICAL_OUTCOME' THEN
        'An OPEN Project has a canonical completion obligation blocked on ratification of the exact current contract.'
      WHEN 'CONSTRAINED_ACTION' THEN
        'An OPEN Project has a bound side-effect action blocked on ratification of the exact current contract.'
      ELSE
        'An OPEN Project has an explicit current contract change awaiting the owner decision that guards execution.'
    END;
  END IF;

  RETURN jsonb_build_object(
    'schemaVersion', 1,
    'eligible', eligible_value,
    'requiresOwnerNow', requires_owner,
    'state', CASE WHEN eligible_value THEN 'ACTIVE'
                  WHEN reason_code = 'OWNER_RATIFICATION_DEFERRED_NO_BLOCKING_ACTION'
                    THEN 'DEFERRED'
                  ELSE 'INELIGIBLE' END,
    'reasonCode', reason_code,
    'reason', reason_value,
    'projectStatus', project_row."status"::text,
    'bindingStatus', binding_status,
    'currentContractDigest', contract_row."contract_digest"::text,
    'currentContractRevision', contract_row."contract_revision"::text,
    'decisionRequestId', request_row."id"::text,
    'requestGeneration', request_row."request_generation"::text,
    'requestRoutingState', request_row."routing_state",
    'requestRoutingReasonCode', request_row."routing_reason_code",
    'activationSource', activation_source,
    'linkedObligations', blockers
  );
END;
$$ LANGUAGE plpgsql STABLE;

-- Exact re-evaluation remains idempotent.  A deferred migration row is promoted in place only
-- after a real blocker/guarded-action observation; a semantic contract change still supersedes it
-- and derives a new digest-bound generation as before.
CREATE OR REPLACE FUNCTION project_ensure_owner_decision_request(
  p_project UUID,
  p_reason TEXT,
  p_previous_contract TEXT,
  p_semantic_diff JSONB DEFAULT '{}'::jsonb
) RETURNS UUID AS $$
DECLARE
  state "project_completion_contract"%ROWTYPE;
  request_id UUID;
  next_generation BIGINT;
  blockers JSONB;
BEGIN
  SELECT * INTO state FROM "project_completion_contract"
   WHERE "project_id" = p_project FOR UPDATE;
  IF NOT FOUND THEN RETURN NULL; END IF;
  IF project_owner_ratification_effective(p_project, state."contract_digest") THEN RETURN NULL; END IF;

  UPDATE "project_owner_decision_request"
     SET "status" = 'EXPIRED'
   WHERE "project_id" = p_project AND "status" = 'PENDING'
     AND "expires_at" <= CURRENT_TIMESTAMP;
  SELECT "id" INTO request_id FROM "project_owner_decision_request"
   WHERE "project_id" = p_project AND "status" = 'PENDING'
     AND "contract_digest" = state."contract_digest"
     AND "contract_revision" = state."contract_revision"
   LIMIT 1;
  IF request_id IS NOT NULL THEN
    blockers := project_owner_ratification_blockers(
      state."owner_id", p_project, state."contract_digest"::text
    );
    IF COALESCE(jsonb_array_length(blockers), 0) > 0
       OR state."last_change_reason" IN (
         'ACTION_INTENT_RECHECK', 'ACTION_COMMIT_RECHECK',
         'CONTRACT_CHANGED', 'OWNER_DECISION_EXPIRED'
       ) THEN
      UPDATE "project_owner_decision_request"
         SET "routing_state" = 'ACTIONABLE',
             "routing_reason_code" = CASE
               WHEN COALESCE(jsonb_array_length(blockers), 0) > 0
                 THEN 'OWNER_RATIFICATION_BLOCKING_ACTION_OBSERVED'
               ELSE p_reason END,
             "deferred_at" = NULL
       WHERE "id" = request_id AND "routing_state" = 'DEFERRED';
    END IF;
    RETURN request_id;
  END IF;

  UPDATE "project_owner_decision_request"
     SET "status" = 'SUPERSEDED'
   WHERE "project_id" = p_project AND "status" = 'PENDING';
  SELECT COALESCE(max("request_generation"), 0) + 1 INTO next_generation
    FROM "project_owner_decision_request" WHERE "project_id" = p_project;
  request_id := gen_random_uuid();
  INSERT INTO "project_owner_decision_request" (
    "id", "project_id", "owner_id", "contract_digest", "contract_revision",
    "request_generation", "reason_code", "previous_contract_digest", "semantic_diff",
    "decision_payload", "cta_token", "expires_at", "routing_state",
    "routing_reason_code", "deferred_at"
  ) VALUES (
    request_id, p_project, state."owner_id", state."contract_digest",
    state."contract_revision", next_generation, p_reason, p_previous_contract,
    COALESCE(p_semantic_diff, '{}'::jsonb),
    jsonb_build_object(
      'consequenceOfNoAction', 'automatic side-effecting execution remains disabled',
      'contract', state."semantic_material",
      'contractDigest', state."contract_digest"::text,
      'contractRevision', state."contract_revision"::text,
      'costAndDeadline', jsonb_build_object(
        'budget', state."semantic_material"->'budget',
        'budgetDigest', state."budget_digest"::text,
        'expiresAt', CURRENT_TIMESTAMP + INTERVAL '7 days'
      ),
      'evaluationPlanDigest', state."evaluation_plan_digest"::text,
      'impact', 'approves the goal, risk, permissions, budget, recipient and completion contract',
      'options', jsonb_build_array('APPROVE', 'DENY'),
      'recommended', 'review the semantic diff and approve only this exact contract revision',
      'resumeAfterDecision', 'the reconciler may resume automatically under the ratified envelope',
      'whyNotAgent', 'an agent or runner cannot approve its own goal, authority, risk or budget'
    ),
    gen_random_uuid(), CURRENT_TIMESTAMP + INTERVAL '7 days',
    CASE WHEN state."last_change_reason" = 'OWNER_RATIFICATION_MIGRATION'
              AND COALESCE(p_semantic_diff->>'initial', 'false') = 'true'
         THEN 'DEFERRED' ELSE 'ACTIONABLE' END,
    CASE WHEN state."last_change_reason" = 'OWNER_RATIFICATION_MIGRATION'
              AND COALESCE(p_semantic_diff->>'initial', 'false') = 'true'
         THEN 'OWNER_RATIFICATION_LEGACY_INITIAL_BACKFILL' ELSE p_reason END,
    CASE WHEN state."last_change_reason" = 'OWNER_RATIFICATION_MIGRATION'
              AND COALESCE(p_semantic_diff->>'initial', 'false') = 'true'
         THEN CURRENT_TIMESTAMP ELSE NULL END
  );
  RETURN request_id;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION project_owner_ratification_state_json(p_owner UUID, p_project UUID)
RETURNS JSONB AS $$
DECLARE
  state "project_completion_contract"%ROWTYPE;
  request "project_owner_decision_request"%ROWTYPE;
  ratification "project_owner_ratification"%ROWTYPE;
  effective BOOLEAN;
  eligibility JSONB;
  audit_requests JSONB;
BEGIN
  PERFORM 1 FROM "project" WHERE "id" = p_project AND "owner_id" = p_owner;
  IF NOT FOUND THEN RAISE EXCEPTION 'PROJECT_NOT_FOUND' USING ERRCODE = 'raise_exception'; END IF;
  PERFORM project_refresh_completion_contract(p_project, 'RATIFICATION_STATE_READ');
  SELECT * INTO state FROM "project_completion_contract" WHERE "project_id" = p_project;
  effective := project_owner_ratification_effective(p_project, state."contract_digest");
  eligibility := project_owner_ratification_eligibility(p_owner, p_project, NULL);
  IF NOT effective AND COALESCE((eligibility->>'requiresOwnerNow')::boolean, false) THEN
    PERFORM project_ensure_owner_decision_request(
      p_project, 'OWNER_RATIFICATION_REQUIRED', state."contract_digest", '{}'::jsonb
    );
    eligibility := project_owner_ratification_eligibility(p_owner, p_project, NULL);
  END IF;
  IF COALESCE((eligibility->>'eligible')::boolean, false) THEN
    SELECT * INTO request FROM "project_owner_decision_request"
     WHERE "id" = (eligibility->>'decisionRequestId')::uuid
       AND "project_id" = p_project AND "status" = 'PENDING';
  END IF;
  SELECT * INTO ratification FROM "project_owner_ratification"
   WHERE "project_id" = p_project AND "contract_digest" = state."contract_digest"
   ORDER BY "ratified_at" DESC LIMIT 1;
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'id', historical."id",
           'kind', historical."kind",
           'status', historical."status",
           'contractDigest', historical."contract_digest"::text,
           'contractRevision', historical."contract_revision"::text,
           'requestGeneration', historical."request_generation"::text,
           'reasonCode', historical."reason_code",
           'previousContractDigest', historical."previous_contract_digest"::text,
           'semanticDiff', historical."semantic_diff",
           'decisionPayload', historical."decision_payload",
           'routingState', historical."routing_state",
           'routingReasonCode', historical."routing_reason_code",
           'deferredAt', historical."deferred_at",
           'createdAt', historical."created_at",
           'expiresAt', historical."expires_at",
           'decision', historical."decision",
           'decidedAt', historical."decided_at",
           'eligibility', project_owner_ratification_eligibility(
             p_owner, p_project, historical."id"
           )
         ) ORDER BY historical."request_generation" DESC), '[]'::jsonb)
    INTO audit_requests
    FROM "project_owner_decision_request" historical
   WHERE historical."project_id" = p_project AND historical."owner_id" = p_owner;
  RETURN jsonb_build_object(
    'budgetDigest', state."budget_digest"::text,
    'contractDigest', state."contract_digest"::text,
    'contractRevision', state."contract_revision"::text,
    'decisionRequest', CASE WHEN request."id" IS NULL THEN NULL ELSE jsonb_build_object(
      'contractDigest', request."contract_digest"::text,
      'contractRevision', request."contract_revision"::text,
      'ctaToken', request."cta_token",
      'expiresAt', request."expires_at",
      'id', request."id",
      'payload', request."decision_payload",
      -- Preserve the immutable derivation reason (for example CONTRACT_CHANGED) on the audit
      -- request. The live, owner-facing "why now" remains eligibility.reasonCode/reason and is
      -- the value projected by every inbox/Attention reference.
      'reasonCode', request."reason_code",
      'requestGeneration', request."request_generation"::text,
      'routingState', request."routing_state",
      'semanticDiff', request."semantic_diff",
      'status', request."status",
      'eligibility', eligibility
    ) END,
    'auditRequests', audit_requests,
    'eligibility', eligibility,
    'evaluationPlanDigest', state."evaluation_plan_digest"::text,
    'evaluationPlanRevision', state."evaluation_plan_revision"::text,
    'evaluationPlan', state."evaluation_plan_material",
    'permissionDigest', state."permission_digest"::text,
    'ratification', CASE WHEN ratification."id" IS NULL THEN NULL ELSE jsonb_build_object(
      'contractDigest', ratification."contract_digest"::text,
      'contractRevision', ratification."contract_revision"::text,
      'id', ratification."id", 'ratifiedAt', ratification."ratified_at",
      'ratifiedByType', ratification."ratified_by_type", 'source', ratification."source"
    ) END,
    'ratified', effective,
    'recipientDigest', state."recipient_digest"::text,
    'riskPolicyDigest', state."risk_policy_digest"::text,
    'semanticContract', state."semantic_material"
  );
END;
$$ LANGUAGE plpgsql;

-- Preserve the exact 0206 decision/idempotency protocol behind a routing fence.  Completed
-- Projects and dormant legacy audit rows cannot be approved through an old cached CTA; committed
-- replies still replay through the original function even if the Project settled afterwards.
ALTER FUNCTION project_owner_ratify_contract(
  UUID, UUID, TEXT, TEXT, TEXT, UUID, UUID, TEXT, TEXT, BOOLEAN
) RENAME TO project_owner_ratify_contract_unrouted;

CREATE FUNCTION project_owner_ratify_contract(
  p_owner UUID,
  p_project UUID,
  p_actor_type TEXT,
  p_actor_id TEXT,
  p_expected_contract TEXT,
  p_request_id UUID,
  p_cta_token UUID,
  p_decision TEXT,
  p_idempotency_key TEXT,
  p_atomic_create BOOLEAN DEFAULT FALSE
) RETURNS JSONB AS $$
DECLARE
  project_status TEXT;
  request_row "project_owner_decision_request"%ROWTYPE;
  eligibility JSONB;
BEGIN
  SELECT "status"::text INTO project_status FROM "project"
   WHERE "id" = p_project AND "owner_id" = p_owner FOR NO KEY UPDATE;
  IF project_status IS NULL THEN
    RETURN project_owner_ratify_contract_unrouted(
      p_owner, p_project, p_actor_type, p_actor_id, p_expected_contract,
      p_request_id, p_cta_token, p_decision, p_idempotency_key, p_atomic_create
    );
  END IF;
  IF p_atomic_create THEN
    SELECT * INTO request_row FROM "project_owner_decision_request"
     WHERE "project_id" = p_project AND "status" = 'PENDING'
     ORDER BY "request_generation" DESC LIMIT 1;
  ELSE
    SELECT * INTO request_row FROM "project_owner_decision_request"
     WHERE "id" = p_request_id AND "project_id" = p_project;
  END IF;
  IF request_row."status" IN ('APPROVED', 'DENIED') THEN
    RETURN project_owner_ratify_contract_unrouted(
      p_owner, p_project, p_actor_type, p_actor_id, p_expected_contract,
      p_request_id, p_cta_token, p_decision, p_idempotency_key, p_atomic_create
    );
  END IF;
  eligibility := project_owner_ratification_eligibility(
    p_owner, p_project, request_row."id"
  );
  IF project_status <> 'OPEN'
     OR (request_row."routing_state" = 'DEFERRED'
         AND NOT COALESCE((eligibility->>'requiresOwnerNow')::boolean, false)) THEN
    RETURN jsonb_build_object(
      'code', 'OWNER_RATIFICATION_NOT_ACTIONABLE',
      'ok', false,
      'eligibility', eligibility,
      'requiredAction', 'retain this request as audit history until a current guarded action requires it'
    );
  END IF;
  RETURN project_owner_ratify_contract_unrouted(
    p_owner, p_project, p_actor_type, p_actor_id, p_expected_contract,
    p_request_id, p_cta_token, p_decision, p_idempotency_key, p_atomic_create
  );
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION project_owner_ratification_eligibility(UUID, UUID, UUID) IS
  'The sole live-routing decision for Owner Ratification: OPEN project, missing/stale current ratification binding, and a canonical obligation, guarded action or explicit current contract activation.';
COMMENT ON FUNCTION project_owner_ratification_blockers(UUID, UUID, TEXT) IS
  'Exact canonical obligation/action identities currently blocked by Owner Ratification for one contract digest.';
COMMENT ON FUNCTION project_owner_ratify_contract(UUID, UUID, TEXT, TEXT, TEXT, UUID, UUID, TEXT, TEXT, BOOLEAN) IS
  '0206 exact owner decision protocol fenced by the shared active/deferred Owner Ratification eligibility.';

COMMIT;
