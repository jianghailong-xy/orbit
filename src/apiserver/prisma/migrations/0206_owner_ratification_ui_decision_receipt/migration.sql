-- The owner UI is a capability-bearing decision surface. APPROVE already had an append-only
-- ratification/idempotency receipt, but DENY only changed request.status: an ambiguous network
-- result could not be recovered with the same key, and two mixed clients could not learn which
-- answer had won without guessing. Bind both terminal answers to the exact request, CTA, digest
-- and owner-scoped idempotency key.

BEGIN;

ALTER TABLE "project_owner_decision_request"
  ADD COLUMN "decision" TEXT,
  ADD COLUMN "decision_idempotency_key" TEXT;

ALTER TABLE "project_owner_decision_request"
  ADD CONSTRAINT "project_owner_decision_value_check"
  CHECK ("decision" IS NULL OR "decision" IN ('APPROVE', 'DENY')),
  ADD CONSTRAINT "project_owner_decision_receipt_shape_check"
  CHECK ("decision_idempotency_key" IS NULL OR "decision" IS NOT NULL);

-- Existing owner approvals already have the durable receipt in the ratification row. Copy its
-- identity onto the question so one lookup recovers either terminal answer. Legacy DENY rows have
-- no key to invent; they still gain an explicit recorded decision.
UPDATE "project_owner_decision_request" request
   SET "decision" = 'APPROVE',
       "decision_idempotency_key" = ratification."idempotency_key"
  FROM "project_owner_ratification" ratification
 WHERE request."id" = ratification."decision_request_id"
   AND request."status" = 'APPROVED';

UPDATE "project_owner_decision_request"
   SET "decision" = 'DENY'
 WHERE "status" = 'DENIED' AND "decision" IS NULL;

CREATE UNIQUE INDEX "project_owner_decision_idempotency_key"
  ON "project_owner_decision_request" ("owner_id", "decision_idempotency_key");

CREATE OR REPLACE FUNCTION project_owner_ratify_contract(
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
  state "project_completion_contract"%ROWTYPE;
  request "project_owner_decision_request"%ROWTYPE;
  receipt "project_owner_decision_request"%ROWTYPE;
  existing "project_owner_ratification"%ROWTYPE;
  ratification_id UUID;
  replacement UUID;
  recorded_decision TEXT;
BEGIN
  IF p_actor_type <> 'OWNER' OR p_actor_id IS DISTINCT FROM p_owner::text THEN
    RAISE EXCEPTION
      'OWNER_RATIFICATION_ACTOR_FORBIDDEN: agents and runners cannot ratify their own contract'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_decision NOT IN ('APPROVE', 'DENY') THEN
    RAISE EXCEPTION 'OWNER_RATIFICATION_DECISION_INVALID: decision must be APPROVE or DENY'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_idempotency_key IS NULL OR btrim(p_idempotency_key) = '' THEN
    RAISE EXCEPTION 'OWNER_RATIFICATION_IDEMPOTENCY_REQUIRED'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  PERFORM 1 FROM "project" WHERE "id" = p_project AND "owner_id" = p_owner
    FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'PROJECT_NOT_FOUND: project % is not owned by %', p_project, p_owner
      USING ERRCODE = 'raise_exception';
  END IF;
  PERFORM project_refresh_completion_contract(p_project, 'OWNER_RATIFICATION_RECHECK');
  SELECT * INTO state FROM "project_completion_contract"
   WHERE "project_id" = p_project FOR UPDATE;

  -- A transport retry is answered from the committed receipt even if the Project subsequently
  -- moved to a newer digest. It confirms only the old exact answer and reports whether that old
  -- approval is effective now; it never authorizes the newer contract.
  SELECT * INTO receipt FROM "project_owner_decision_request"
   WHERE "owner_id" = p_owner AND "decision_idempotency_key" = p_idempotency_key
   FOR UPDATE;
  IF FOUND THEN
    IF p_atomic_create
       OR receipt."project_id" <> p_project
       OR receipt."id" IS DISTINCT FROM p_request_id
       OR receipt."contract_digest"::text IS DISTINCT FROM p_expected_contract
       OR receipt."cta_token" IS DISTINCT FROM p_cta_token
       OR receipt."decision" IS DISTINCT FROM p_decision THEN
      RETURN jsonb_build_object(
        'code', 'OWNER_DECISION_IDEMPOTENCY_COLLISION', 'ok', false,
        'requiredAction', 'read the exact current owner decision request'
      );
    END IF;
    SELECT * INTO existing FROM "project_owner_ratification"
     WHERE "decision_request_id" = receipt."id"
     ORDER BY "ratified_at" DESC LIMIT 1;
    RETURN jsonb_strip_nulls(jsonb_build_object(
      'contractDigest', receipt."contract_digest"::text,
      'currentContractDigest', state."contract_digest"::text,
      'decision', receipt."decision",
      'decisionRequestId', receipt."id",
      'duplicate', true,
      'effectiveNow', CASE WHEN receipt."decision" = 'APPROVE'
        THEN project_owner_ratification_effective(p_project, receipt."contract_digest"::text)
        ELSE false END,
      'ok', true,
      'ratificationId', existing."id",
      'ratified', receipt."decision" = 'APPROVE'
    ));
  END IF;

  IF p_expected_contract IS NOT NULL
     AND p_expected_contract IS DISTINCT FROM state."contract_digest"::text THEN
    RETURN jsonb_build_object(
      'code', 'OWNER_DECISION_STALE', 'currentContractDigest', state."contract_digest"::text,
      'ok', false, 'requiredAction', 'read the new owner decision request'
    );
  END IF;
  IF NULLIF(btrim(COALESCE(state."semantic_material"->>'goal', '')), '') IS NULL
     OR jsonb_array_length(state."semantic_material"->'criteria') = 0 THEN
    RETURN jsonb_build_object(
      'code', 'OWNER_RATIFICATION_CONTRACT_INCOMPLETE', 'ok', false,
      'requiredAction', 'state a goal and at least one completion criterion before ratifying'
    );
  END IF;

  IF p_atomic_create THEN
    SELECT * INTO request FROM "project_owner_decision_request"
     WHERE "project_id" = p_project AND "status" = 'PENDING'
       AND "contract_digest" = state."contract_digest"
     ORDER BY "request_generation" DESC LIMIT 1 FOR UPDATE;
  ELSE
    SELECT * INTO request FROM "project_owner_decision_request"
     WHERE "id" = p_request_id AND "project_id" = p_project FOR UPDATE;
  END IF;
  IF request."id" IS NULL OR request."contract_digest" <> state."contract_digest" THEN
    RETURN jsonb_build_object(
      'code', 'OWNER_DECISION_STALE', 'currentContractDigest', state."contract_digest"::text,
      'ok', false, 'requiredAction', 'read the current owner decision request'
    );
  END IF;
  IF NOT p_atomic_create AND request."cta_token" IS DISTINCT FROM p_cta_token THEN
    RETURN jsonb_build_object('code', 'OWNER_DECISION_CTA_MISMATCH', 'ok', false);
  END IF;

  SELECT * INTO existing FROM "project_owner_ratification"
   WHERE "decision_request_id" = request."id" ORDER BY "ratified_at" DESC LIMIT 1;
  recorded_decision := COALESCE(
    request."decision",
    CASE request."status" WHEN 'APPROVED' THEN 'APPROVE' WHEN 'DENIED' THEN 'DENY' END
  );
  IF FOUND THEN
    IF p_decision = 'APPROVE' THEN
      RETURN jsonb_build_object(
        'contractDigest', existing."contract_digest"::text,
        'decision', 'APPROVE', 'decisionRequestId', request."id",
        'duplicate', true, 'effectiveNow',
          project_owner_ratification_effective(p_project, existing."contract_digest"::text),
        'ok', true, 'ratificationId', existing."id", 'ratified', true
      );
    END IF;
    RETURN jsonb_build_object(
      'code', 'OWNER_DECISION_ALREADY_SPENT', 'ok', false,
      'recordedDecision', 'APPROVE', 'decisionRequestId', request."id",
      'requiredAction', 'read the recorded owner decision'
    );
  END IF;
  IF request."status" <> 'PENDING' THEN
    IF recorded_decision = p_decision AND recorded_decision IN ('APPROVE', 'DENY') THEN
      RETURN jsonb_build_object(
        'contractDigest', request."contract_digest"::text,
        'decision', recorded_decision, 'decisionRequestId', request."id",
        'duplicate', true, 'effectiveNow', false, 'ok', true,
        'ratified', recorded_decision = 'APPROVE'
      );
    END IF;
    RETURN jsonb_strip_nulls(jsonb_build_object(
      'code', 'OWNER_DECISION_ALREADY_SPENT', 'ok', false,
      'recordedDecision', recorded_decision, 'decisionRequestId', request."id",
      'requiredAction', 'read the recorded owner decision or current request'
    ));
  END IF;
  IF request."expires_at" <= CURRENT_TIMESTAMP THEN
    UPDATE "project_owner_decision_request" SET "status" = 'EXPIRED'
     WHERE "id" = request."id";
    replacement := project_ensure_owner_decision_request(
      p_project, 'OWNER_DECISION_EXPIRED', state."contract_digest", '{}'::jsonb
    );
    RETURN jsonb_build_object(
      'code', 'OWNER_DECISION_CTA_EXPIRED', 'newDecisionRequestId', replacement,
      'ok', false, 'requiredAction', 'use the newly issued owner decision request'
    );
  END IF;

  IF p_decision = 'DENY' THEN
    BEGIN
      UPDATE "project_owner_decision_request"
         SET "status" = 'DENIED', "decision" = 'DENY',
             "decision_idempotency_key" = p_idempotency_key,
             "decided_at" = CURRENT_TIMESTAMP,
             "decided_by_type" = 'OWNER', "decided_by_id" = p_owner::text
       WHERE "id" = request."id";
    EXCEPTION WHEN unique_violation THEN
      RETURN jsonb_build_object(
        'code', 'OWNER_DECISION_IDEMPOTENCY_COLLISION', 'ok', false,
        'requiredAction', 'read the exact current owner decision request'
      );
    END;
    RETURN jsonb_build_object(
      'contractDigest', state."contract_digest"::text,
      'decision', 'DENY', 'decisionRequestId', request."id",
      'duplicate', false, 'effectiveNow', false, 'ok', true, 'ratified', false
    );
  END IF;

  ratification_id := gen_random_uuid();
  BEGIN
    INSERT INTO "project_owner_ratification" (
      "id", "project_id", "owner_id", "contract_digest",
      "evaluation_plan_digest_at_decision", "source", "ratified_by_type",
      "ratified_by_id", "decision_request_id", "idempotency_key"
    ) VALUES (
      ratification_id, p_project, p_owner, state."contract_digest",
      state."evaluation_plan_digest",
      CASE WHEN p_atomic_create THEN 'OWNER_ATOMIC_CREATE' ELSE 'OWNER' END,
      'OWNER', p_owner::text, request."id", p_idempotency_key
    );
    UPDATE "project_owner_decision_request"
       SET "status" = 'APPROVED', "decision" = 'APPROVE',
           "decision_idempotency_key" = p_idempotency_key,
           "decided_at" = CURRENT_TIMESTAMP,
           "decided_by_type" = 'OWNER', "decided_by_id" = p_owner::text
     WHERE "id" = request."id";
  EXCEPTION WHEN unique_violation THEN
    RETURN jsonb_build_object(
      'code', 'OWNER_DECISION_IDEMPOTENCY_COLLISION', 'ok', false,
      'requiredAction', 'read the exact current owner decision request'
    );
  END;
  RETURN jsonb_build_object(
    'contractDigest', state."contract_digest"::text,
    'decision', 'APPROVE', 'decisionRequestId', request."id",
    'duplicate', false, 'effectiveNow', true,
    'evaluationPlanDigest', state."evaluation_plan_digest"::text,
    'ok', true, 'ratificationId', ratification_id, 'ratified', true,
    'source', CASE WHEN p_atomic_create THEN 'OWNER_ATOMIC_CREATE' ELSE 'OWNER' END
  );
END;
$$ LANGUAGE plpgsql;

COMMENT ON COLUMN "project_owner_decision_request"."decision_idempotency_key" IS
  'Owner-scoped replay identity for the exact request/digest/CTA/decision receipt; never a URL capability.';
COMMENT ON FUNCTION project_owner_ratify_contract(UUID, UUID, TEXT, TEXT, TEXT, UUID, UUID, TEXT, TEXT, BOOLEAN) IS
  'Owner-only exact decision protocol with recoverable APPROVE/DENY receipts, CTA binding and fail-closed replay.';

COMMIT;
