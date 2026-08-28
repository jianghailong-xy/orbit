-- Outcome Reconciler V2: complete binding invalidation and auditable zero-to-many successors.
--
-- A binding or fact-stream advance must make the prior proof unusable in the same transaction
-- that records why a fresh reduction is required.  The immutable proof and obligation revisions
-- remain available for audit; only disposable/current projections are removed.  A later
-- evaluation records zero or more semantic successors for every obsolete obligation, without a
-- one-to-one foreign key or uniqueness constraint.
BEGIN;

-- A digest alone is not an epoch.  Without the semantic revision, A -> B -> A would silently make
-- the first approval effective again.  Evaluation-plan-only edits do not advance this revision,
-- preserving the deliberate semantic/evaluation-plan split.
ALTER TABLE "project_owner_ratification"
  ADD COLUMN "contract_revision" BIGINT;

ALTER TABLE "project_owner_ratification"
  DISABLE TRIGGER project_owner_ratification_immutable;
UPDATE "project_owner_ratification" ratification
   SET "contract_revision" = COALESCE((
     SELECT contract_state."contract_revision"
       FROM "project_completion_contract" contract_state
      WHERE contract_state."project_id" = ratification."project_id"
        AND contract_state."contract_digest" = ratification."contract_digest"
   ), 0);

ALTER TABLE "project_owner_ratification"
  ALTER COLUMN "contract_revision" SET NOT NULL;
ALTER TABLE "project_owner_ratification"
  ENABLE TRIGGER project_owner_ratification_immutable;

ALTER TABLE "project_owner_decision_request"
  ADD COLUMN "contract_revision" BIGINT;

UPDATE "project_owner_decision_request" request
   SET "contract_revision" = COALESCE((
     SELECT contract_state."contract_revision"
       FROM "project_completion_contract" contract_state
      WHERE contract_state."project_id" = request."project_id"
        AND contract_state."contract_digest" = request."contract_digest"
   ), 0);

ALTER TABLE "project_owner_decision_request"
  ALTER COLUMN "contract_revision" SET NOT NULL;

-- Legacy projects may not have registered an Outcome binding yet.  Those intents retain NULL and
-- continue through the old six-field fence; once a stream has a binding every new intent must bind
-- the full digest and epoch and an unbound legacy intent is stale.
ALTER TABLE "project_ratified_action_intent"
  ADD COLUMN "contract_revision" BIGINT,
  ADD COLUMN "outcome_binding_digest" CHAR(64),
  ADD COLUMN "outcome_binding_epoch" BIGINT,
  ADD COLUMN "outcome_watermark_logical_time" BIGINT;

ALTER TABLE "project_ratified_action_intent"
  DISABLE TRIGGER project_ratified_action_intent_immutable;
UPDATE "project_ratified_action_intent" intent
   SET "contract_revision" = COALESCE((
     SELECT contract_state."contract_revision"
       FROM "project_completion_contract" contract_state
      WHERE contract_state."project_id" = intent."project_id"
        AND contract_state."contract_digest" = intent."contract_digest"
   ), 0);

ALTER TABLE "project_ratified_action_intent"
  ALTER COLUMN "contract_revision" SET NOT NULL;
ALTER TABLE "project_ratified_action_intent"
  ENABLE TRIGGER project_ratified_action_intent_immutable;

CREATE TABLE outcome_reconcile_request (
  request_id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  project_id uuid NOT NULL,
  request_generation bigint NOT NULL CHECK (request_generation > 0),
  binding_digest char(64) NOT NULL CHECK (outcome_valid_digest(binding_digest)),
  trigger_logical_time bigint NOT NULL CHECK (trigger_logical_time >= 0),
  reason_code text NOT NULL CHECK (reason_code <> ''),
  changed_fields text[] NOT NULL,
  invalidators text[] NOT NULL,
  status text NOT NULL CHECK (status IN ('PENDING', 'COMMITTED', 'SUPERSEDED')),
  evaluation_id uuid REFERENCES outcome_evaluator_result(evaluation_id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  concluded_at timestamptz,
  UNIQUE (tenant_id, project_id, request_generation),
  FOREIGN KEY (tenant_id, project_id, binding_digest)
    REFERENCES outcome_fact_binding(tenant_id, project_id, binding_digest),
  CHECK ((status = 'PENDING') = (concluded_at IS NULL)),
  CHECK (status <> 'COMMITTED' OR evaluation_id IS NOT NULL)
);

CREATE UNIQUE INDEX outcome_one_pending_reconcile_request_idx
  ON outcome_reconcile_request (tenant_id, project_id) WHERE status = 'PENDING';
CREATE INDEX outcome_reconcile_request_binding_idx
  ON outcome_reconcile_request (tenant_id, project_id, binding_digest, request_generation DESC);

CREATE TABLE outcome_binding_transition (
  transition_id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  project_id uuid NOT NULL,
  from_binding_digest char(64),
  to_binding_digest char(64) NOT NULL CHECK (outcome_valid_digest(to_binding_digest)),
  from_binding_epoch bigint,
  to_binding_epoch bigint NOT NULL CHECK (to_binding_epoch > 0),
  changed_fields text[] NOT NULL,
  invalidators text[] NOT NULL,
  request_id uuid NOT NULL UNIQUE REFERENCES outcome_reconcile_request(request_id),
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (tenant_id, project_id, to_binding_digest),
  FOREIGN KEY (tenant_id, project_id, to_binding_digest)
    REFERENCES outcome_fact_binding(tenant_id, project_id, binding_digest),
  CHECK (from_binding_digest IS NULL OR outcome_valid_digest(from_binding_digest)),
  CHECK ((from_binding_digest IS NULL) = (from_binding_epoch IS NULL))
);

CREATE TABLE outcome_proof_obsolescence (
  evaluation_id uuid PRIMARY KEY REFERENCES outcome_evaluator_result(evaluation_id),
  tenant_id uuid NOT NULL,
  project_id uuid NOT NULL,
  binding_digest char(64) NOT NULL CHECK (outcome_valid_digest(binding_digest)),
  request_id uuid NOT NULL REFERENCES outcome_reconcile_request(request_id),
  transition_id uuid REFERENCES outcome_binding_transition(transition_id),
  reason_code text NOT NULL CHECK (reason_code <> ''),
  obsolete_at_logical_time bigint NOT NULL CHECK (obsolete_at_logical_time >= 0),
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE outcome_proof_successor (
  tenant_id uuid NOT NULL,
  project_id uuid NOT NULL,
  predecessor_evaluation_id uuid NOT NULL REFERENCES outcome_evaluator_result(evaluation_id),
  successor_evaluation_id uuid NOT NULL REFERENCES outcome_evaluator_result(evaluation_id),
  request_id uuid NOT NULL REFERENCES outcome_reconcile_request(request_id),
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, project_id, predecessor_evaluation_id, successor_evaluation_id)
);

CREATE TABLE outcome_obsolete_obligation (
  tenant_id uuid NOT NULL,
  project_id uuid NOT NULL,
  predecessor_obligation_id char(64) NOT NULL CHECK (outcome_valid_digest(predecessor_obligation_id)),
  predecessor_obligation_revision char(64) NOT NULL
    CHECK (outcome_valid_digest(predecessor_obligation_revision)),
  binding_digest char(64) NOT NULL CHECK (outcome_valid_digest(binding_digest)),
  request_id uuid NOT NULL REFERENCES outcome_reconcile_request(request_id),
  transition_id uuid REFERENCES outcome_binding_transition(transition_id),
  obligation jsonb NOT NULL,
  obsolete_at_logical_time bigint NOT NULL CHECK (obsolete_at_logical_time >= 0),
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, project_id, predecessor_obligation_revision),
  FOREIGN KEY (tenant_id, project_id, predecessor_obligation_revision)
    REFERENCES outcome_obligation_revision(tenant_id, project_id, obligation_revision)
);

-- One row says the obsolete revision was considered by a new canonical reduction even when that
-- reduction emitted no successor.  This is how zero successors is distinguished from unfinished
-- reconciliation.
CREATE TABLE outcome_obligation_reduction (
  tenant_id uuid NOT NULL,
  project_id uuid NOT NULL,
  predecessor_obligation_revision char(64) NOT NULL,
  successor_evaluation_id uuid NOT NULL REFERENCES outcome_evaluator_result(evaluation_id),
  request_id uuid NOT NULL REFERENCES outcome_reconcile_request(request_id),
  reduced_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, project_id, predecessor_obligation_revision),
  FOREIGN KEY (tenant_id, project_id, predecessor_obligation_revision)
    REFERENCES outcome_obsolete_obligation(tenant_id, project_id, predecessor_obligation_revision)
);

-- Deliberately many-to-many.  There is no unique constraint on either predecessor or successor;
-- the new contract/evaluation may emit zero, one or several revisions that block the same semantic
-- closure dimension.
CREATE TABLE outcome_obligation_successor (
  tenant_id uuid NOT NULL,
  project_id uuid NOT NULL,
  predecessor_obligation_revision char(64) NOT NULL,
  successor_obligation_revision char(64) NOT NULL,
  successor_evaluation_id uuid NOT NULL REFERENCES outcome_evaluator_result(evaluation_id),
  request_id uuid NOT NULL REFERENCES outcome_reconcile_request(request_id),
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (
    tenant_id, project_id, predecessor_obligation_revision, successor_obligation_revision
  ),
  FOREIGN KEY (tenant_id, project_id, predecessor_obligation_revision)
    REFERENCES outcome_obsolete_obligation(tenant_id, project_id, predecessor_obligation_revision),
  FOREIGN KEY (tenant_id, project_id, successor_obligation_revision)
    REFERENCES outcome_obligation_revision(tenant_id, project_id, obligation_revision)
);

-- A ratification decision remains append-only and semantic-contract scoped.  Each Outcome binding
-- gets a derived link of its own, so evaluation-plan evolution can carry the same owner decision
-- forward while the old binding link itself can never satisfy the new proof.
CREATE TABLE outcome_binding_ratification (
  tenant_id uuid NOT NULL,
  project_id uuid NOT NULL,
  binding_digest char(64) NOT NULL CHECK (outcome_valid_digest(binding_digest)),
  contract_digest char(64) NOT NULL CHECK (outcome_valid_digest(contract_digest)),
  contract_revision bigint,
  ratification_id uuid REFERENCES "project_owner_ratification"("id"),
  carried_forward boolean NOT NULL DEFAULT false,
  bound_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, project_id, binding_digest),
  FOREIGN KEY (tenant_id, project_id, binding_digest)
    REFERENCES outcome_fact_binding(tenant_id, project_id, binding_digest)
);

CREATE OR REPLACE FUNCTION project_owner_ratification_bind_revision() RETURNS trigger AS $$
DECLARE
  current_revision bigint;
BEGIN
  SELECT "contract_revision" INTO current_revision
    FROM "project_completion_contract"
   WHERE "project_id" = NEW."project_id"
     AND "contract_digest" = NEW."contract_digest";
  IF current_revision IS NULL THEN
    RAISE EXCEPTION 'OWNER_RATIFICATION_BINDING_STALE'
      USING ERRCODE = '40001';
  END IF;
  NEW."contract_revision" := current_revision;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER project_owner_ratification_bind_revision
  BEFORE INSERT ON "project_owner_ratification"
  FOR EACH ROW EXECUTE FUNCTION project_owner_ratification_bind_revision();

CREATE OR REPLACE FUNCTION project_owner_decision_bind_revision() RETURNS trigger AS $$
DECLARE
  current_revision bigint;
BEGIN
  SELECT "contract_revision" INTO current_revision
    FROM "project_completion_contract"
   WHERE "project_id" = NEW."project_id"
     AND "contract_digest" = NEW."contract_digest";
  IF current_revision IS NULL THEN
    RAISE EXCEPTION 'OWNER_DECISION_BINDING_STALE'
      USING ERRCODE = '40001';
  END IF;
  NEW."contract_revision" := current_revision;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER project_owner_decision_bind_revision
  BEFORE INSERT ON "project_owner_decision_request"
  FOR EACH ROW EXECUTE FUNCTION project_owner_decision_bind_revision();

CREATE OR REPLACE FUNCTION project_action_intent_bind_full_revision() RETURNS trigger AS $$
DECLARE
  current_revision bigint;
  current_binding outcome_fact_binding%ROWTYPE;
  stream_head bigint;
BEGIN
  SELECT "contract_revision" INTO current_revision
    FROM "project_completion_contract"
   WHERE "project_id" = NEW."project_id"
     AND "contract_digest" = NEW."contract_digest";
  IF current_revision IS NULL THEN
    RAISE EXCEPTION 'RATIFIED_ACTION_BINDING_STALE'
      USING ERRCODE = '40001';
  END IF;
  NEW."contract_revision" := current_revision;

  -- Project owner is the canonical tenant for Project-originated actions.  A legacy project with
  -- no Outcome stream remains on the compatibility fence until it registers its first binding.
  PERFORM 1 FROM outcome_fact_stream
   WHERE tenant_id = NEW."owner_id" AND project_id = NEW."project_id"
   FOR UPDATE;
  IF FOUND THEN
    SELECT * INTO current_binding
      FROM outcome_fact_binding
     WHERE tenant_id = NEW."owner_id" AND project_id = NEW."project_id"
     ORDER BY binding_epoch DESC LIMIT 1;
    SELECT last_logical_time INTO stream_head FROM outcome_fact_stream
     WHERE tenant_id = NEW."owner_id" AND project_id = NEW."project_id";
    IF current_binding.binding_digest IS NULL
       OR NEW."action"->>'bindingDigest' IS DISTINCT FROM current_binding.binding_digest::text
       OR current_binding.binding->>'contractDigest' IS DISTINCT FROM NEW."contract_digest"::text
       OR current_binding.binding->>'evaluationPlanDigest' IS DISTINCT FROM NEW."evaluation_plan_digest"::text
       OR current_binding.binding->>'riskPolicyDigest' IS DISTINCT FROM NEW."risk_policy_digest"::text
       OR current_binding.binding->>'permissionDigest' IS DISTINCT FROM NEW."permission_digest"::text
       OR current_binding.binding->>'budgetDigest' IS DISTINCT FROM NEW."budget_digest"::text
       OR current_binding.binding->>'recipientDigest' IS DISTINCT FROM NEW."recipient_digest"::text THEN
      RAISE EXCEPTION 'RATIFIED_ACTION_BINDING_STALE'
        USING ERRCODE = '40001';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM outcome_fact_authority_grant authority
       WHERE authority.tenant_id = NEW."owner_id" AND authority.project_id = NEW."project_id"
         AND authority.grant_digest = current_binding.binding->>'authorityGrantDigest'
         AND authority.valid_from_logical_time <= stream_head
         AND (authority.valid_through_logical_time IS NULL
              OR authority.valid_through_logical_time >= stream_head)
         AND NOT EXISTS (
           SELECT 1 FROM outcome_fact_authority_revocation revocation
            WHERE revocation.tenant_id = authority.tenant_id
              AND revocation.project_id = authority.project_id
              AND revocation.grant_id = authority.grant_id
              AND revocation.revoked_at_logical_time <= stream_head
         )
    ) THEN
      RAISE EXCEPTION 'RATIFIED_ACTION_AUTHORITY_STALE'
        USING ERRCODE = '42501';
    END IF;
    NEW."outcome_binding_digest" := current_binding.binding_digest;
    NEW."outcome_binding_epoch" := current_binding.binding_epoch;
    NEW."outcome_watermark_logical_time" := stream_head;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER project_action_intent_bind_full_revision
  BEFORE INSERT ON "project_ratified_action_intent"
  FOR EACH ROW EXECUTE FUNCTION project_action_intent_bind_full_revision();

CREATE OR REPLACE FUNCTION project_owner_ratification_effective(p_project UUID, p_contract TEXT)
RETURNS BOOLEAN AS $$
  SELECT EXISTS (
    SELECT 1
      FROM "project_owner_ratification" r
      JOIN "project_completion_contract" current_contract
        ON current_contract."project_id" = r."project_id"
       AND current_contract."contract_digest" = r."contract_digest"
       AND current_contract."contract_revision" = r."contract_revision"
      LEFT JOIN "project_ratification_template" t
        ON r."source" = 'PREAPPROVED_TEMPLATE' AND t."id" = r."authority_id"
      LEFT JOIN "project_ratification_delegation" d
        ON r."source" = 'BOUND_DELEGATION' AND d."id" = r."authority_id"
     WHERE r."project_id" = p_project
       AND r."contract_digest" = p_contract
       AND (r."valid_through" IS NULL OR r."valid_through" > CURRENT_TIMESTAMP)
       AND (
         r."source" IN ('OWNER', 'OWNER_ATOMIC_CREATE')
         OR (r."source" = 'PREAPPROVED_TEMPLATE'
             AND t."revoked_at" IS NULL AND t."valid_from" <= CURRENT_TIMESTAMP
             AND t."valid_through" > CURRENT_TIMESTAMP
             AND t."template_digest" = r."authority_digest")
         OR (r."source" = 'BOUND_DELEGATION'
             AND d."revoked_at" IS NULL AND d."valid_from" <= CURRENT_TIMESTAMP
             AND d."valid_through" > CURRENT_TIMESTAMP
             AND d."delegation_digest" = r."authority_digest")
       )
  )
$$ LANGUAGE SQL STABLE;

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
  IF request_id IS NOT NULL THEN RETURN request_id; END IF;

  UPDATE "project_owner_decision_request"
     SET "status" = 'SUPERSEDED'
   WHERE "project_id" = p_project AND "status" = 'PENDING';
  SELECT COALESCE(max("request_generation"), 0) + 1 INTO next_generation
    FROM "project_owner_decision_request" WHERE "project_id" = p_project;
  request_id := gen_random_uuid();
  INSERT INTO "project_owner_decision_request" (
    "id", "project_id", "owner_id", "contract_digest", "contract_revision",
    "request_generation", "reason_code", "previous_contract_digest", "semantic_diff",
    "decision_payload", "cta_token", "expires_at"
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
    gen_random_uuid(), CURRENT_TIMESTAMP + INTERVAL '7 days'
  );
  RETURN request_id;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION outcome_binding_changed_fields(
  p_old_binding jsonb,
  p_new_binding jsonb
) RETURNS text[] AS $$
  SELECT COALESCE(array_agg(key ORDER BY key COLLATE "C"), ARRAY[]::text[])
    FROM (
      SELECT key FROM jsonb_object_keys(COALESCE(p_old_binding, '{}'::jsonb)) key
      UNION
      SELECT key FROM jsonb_object_keys(COALESCE(p_new_binding, '{}'::jsonb)) key
    ) keys
   WHERE p_old_binding->key IS DISTINCT FROM p_new_binding->key
$$ LANGUAGE sql IMMUTABLE;

CREATE OR REPLACE FUNCTION outcome_binding_invalidators(p_changed_fields text[])
RETURNS text[] AS $$
  SELECT COALESCE(array_agg(DISTINCT invalidator ORDER BY invalidator), ARRAY[]::text[])
    FROM unnest(p_changed_fields) changed(field)
    CROSS JOIN LATERAL (
      SELECT CASE changed.field
        WHEN 'contractDigest' THEN 'CONTRACT_CHANGED'
        WHEN 'evaluationPlanDigest' THEN 'CRITERIA_CHANGED'
        WHEN 'artifactDigest' THEN 'ARTIFACT_CHANGED'
        WHEN 'targetDigest' THEN 'TARGET_CHANGED'
        WHEN 'targetRef' THEN 'TARGET_CHANGED'
        WHEN 'riskPolicyDigest' THEN 'RISK_POLICY_CHANGED'
        WHEN 'policyDigest' THEN 'POLICY_CHANGED'
        WHEN 'permissionDigest' THEN 'PERMISSION_CHANGED'
        WHEN 'authorityGrantDigest' THEN 'AUTHORITY_CHANGED'
        WHEN 'budgetDigest' THEN 'BUDGET_CHANGED'
        WHEN 'capabilityRegistryDigest' THEN 'CAPABILITY_REGISTRY_CHANGED'
        WHEN 'recipientDigest' THEN 'RECIPIENT_CHANGED'
        WHEN 'evaluatorDigest' THEN 'EVALUATOR_CHANGED'
        WHEN 'factSchemaDigest' THEN 'FACT_SCHEMA_CHANGED'
        WHEN 'environmentDigest' THEN 'ENVIRONMENT_CHANGED'
        WHEN 'asOfLogicalTime' THEN 'AS_OF_ADVANCED'
        WHEN 'factCutDigest' THEN 'AS_OF_ADVANCED'
        WHEN 'goalRevision' THEN 'CONTRACT_CHANGED'
        WHEN 'goalId' THEN 'CONTRACT_CHANGED'
        WHEN 'subjectType' THEN 'CONTRACT_CHANGED'
        WHEN 'subjectId' THEN 'CONTRACT_CHANGED'
        ELSE 'BINDING_CHANGED'
      END AS invalidator
    ) mapped
$$ LANGUAGE sql IMMUTABLE;

CREATE OR REPLACE FUNCTION outcome_enqueue_reconcile_request(
  p_tenant_id uuid,
  p_project_id uuid,
  p_binding_digest text,
  p_trigger_logical_time bigint,
  p_reason_code text,
  p_changed_fields text[],
  p_invalidators text[]
) RETURNS uuid AS $$
DECLARE
  next_generation bigint;
  request_value uuid;
BEGIN
  IF NOT COALESCE(outcome_valid_digest(p_binding_digest), false)
     OR p_trigger_logical_time < 0 OR COALESCE(p_reason_code, '') = '' THEN
    RAISE EXCEPTION 'OUTCOME_RECONCILE_REQUEST_INVALID' USING ERRCODE = '22023';
  END IF;
  PERFORM 1 FROM outcome_fact_stream
   WHERE tenant_id = p_tenant_id AND project_id = p_project_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'OUTCOME_RECONCILE_STREAM_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;

  UPDATE outcome_reconcile_request
     SET status = 'SUPERSEDED', concluded_at = clock_timestamp()
   WHERE tenant_id = p_tenant_id AND project_id = p_project_id AND status = 'PENDING';
  SELECT COALESCE(max(request_generation), 0) + 1 INTO next_generation
    FROM outcome_reconcile_request
   WHERE tenant_id = p_tenant_id AND project_id = p_project_id;
  request_value := gen_random_uuid();
  INSERT INTO outcome_reconcile_request (
    request_id, tenant_id, project_id, request_generation, binding_digest,
    trigger_logical_time, reason_code, changed_fields, invalidators, status
  ) VALUES (
    request_value, p_tenant_id, p_project_id, next_generation, p_binding_digest,
    p_trigger_logical_time, p_reason_code, COALESCE(p_changed_fields, ARRAY[]::text[]),
    COALESCE(p_invalidators, ARRAY[]::text[]), 'PENDING'
  );
  RETURN request_value;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION outcome_obsolete_current_reduction(
  p_tenant_id uuid,
  p_project_id uuid,
  p_obsolete_binding_digest text,
  p_request_id uuid,
  p_transition_id uuid,
  p_reason_code text,
  p_trigger_logical_time bigint
) RETURNS void AS $$
DECLARE
  old_active outcome_active_obligation%ROWTYPE;
BEGIN
  IF p_obsolete_binding_digest IS NULL THEN RETURN; END IF;

  INSERT INTO outcome_proof_obsolescence (
    evaluation_id, tenant_id, project_id, binding_digest, request_id, transition_id,
    reason_code, obsolete_at_logical_time
  )
  SELECT result.evaluation_id, result.tenant_id, result.project_id, result.binding_digest,
         p_request_id, p_transition_id, p_reason_code, p_trigger_logical_time
    FROM outcome_evaluator_result result
   WHERE result.tenant_id = p_tenant_id AND result.project_id = p_project_id
     AND result.binding_digest = p_obsolete_binding_digest
  ON CONFLICT (evaluation_id) DO NOTHING;

  FOR old_active IN
    SELECT * FROM outcome_active_obligation
     WHERE tenant_id = p_tenant_id AND project_id = p_project_id
     FOR UPDATE
  LOOP
    INSERT INTO outcome_obsolete_obligation (
      tenant_id, project_id, predecessor_obligation_id,
      predecessor_obligation_revision, binding_digest, request_id, transition_id,
      obligation, obsolete_at_logical_time
    ) VALUES (
      old_active.tenant_id, old_active.project_id, old_active.obligation_id,
      old_active.obligation_revision, old_active.binding_digest, p_request_id,
      p_transition_id, old_active.obligation, p_trigger_logical_time
    ) ON CONFLICT (tenant_id, project_id, predecessor_obligation_revision) DO NOTHING;

    INSERT INTO outcome_obligation_event (
      tenant_id, project_id, obligation_id, obligation_revision, from_state, to_state,
      evaluation_id, evaluated_through_logical_time, reason_code
    ) VALUES (
      old_active.tenant_id, old_active.project_id, old_active.obligation_id,
      old_active.obligation_revision, 'ACTIVE', 'SUPERSEDED', old_active.evaluation_id,
      p_trigger_logical_time, p_reason_code
    );
  END LOOP;

  DELETE FROM outcome_active_obligation
   WHERE tenant_id = p_tenant_id AND project_id = p_project_id;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION outcome_binding_transition_record() RETURNS trigger AS $$
DECLARE
  predecessor outcome_fact_binding%ROWTYPE;
  changed text[];
  invalidators_value text[];
  request_value uuid;
  transition_value uuid := gen_random_uuid();
  ratification_value uuid;
  ratification_revision bigint;
  predecessor_ratification uuid;
BEGIN
  SELECT * INTO predecessor
    FROM outcome_fact_binding
   WHERE tenant_id = NEW.tenant_id AND project_id = NEW.project_id
     AND binding_epoch = NEW.binding_epoch - 1;

  IF predecessor.binding_digest IS NULL THEN
    changed := ARRAY(SELECT key FROM jsonb_object_keys(NEW.binding) key ORDER BY key COLLATE "C");
    invalidators_value := ARRAY['INITIAL_BINDING'];
  ELSE
    changed := outcome_binding_changed_fields(predecessor.binding, NEW.binding);
    invalidators_value := outcome_binding_invalidators(changed);
  END IF;

  request_value := outcome_enqueue_reconcile_request(
    NEW.tenant_id, NEW.project_id, NEW.binding_digest::text,
    (SELECT last_logical_time FROM outcome_fact_stream
      WHERE tenant_id = NEW.tenant_id AND project_id = NEW.project_id),
    CASE WHEN predecessor.binding_digest IS NULL THEN 'INITIAL_BINDING_REDUCTION'
         ELSE 'BINDING_REPLACED' END,
    changed, invalidators_value
  );
  INSERT INTO outcome_binding_transition (
    transition_id, tenant_id, project_id, from_binding_digest, to_binding_digest,
    from_binding_epoch, to_binding_epoch, changed_fields, invalidators, request_id
  ) VALUES (
    transition_value, NEW.tenant_id, NEW.project_id, predecessor.binding_digest,
    NEW.binding_digest, predecessor.binding_epoch, NEW.binding_epoch, changed,
    invalidators_value, request_value
  );

  PERFORM outcome_obsolete_current_reduction(
    NEW.tenant_id, NEW.project_id, predecessor.binding_digest::text, request_value,
    transition_value, 'BINDING_OBSOLETE',
    (SELECT last_logical_time FROM outcome_fact_stream
      WHERE tenant_id = NEW.tenant_id AND project_id = NEW.project_id)
  );

  SELECT ratification.id, ratification.contract_revision
    INTO ratification_value, ratification_revision
    FROM "project_owner_ratification" ratification
    JOIN "project_completion_contract" contract_state
      ON contract_state."project_id" = ratification."project_id"
     AND contract_state."contract_revision" = ratification."contract_revision"
     AND contract_state."contract_digest" = ratification."contract_digest"
   WHERE ratification."project_id" = NEW.project_id
     AND ratification."contract_digest" = NEW.binding->>'contractDigest'
     AND contract_state."risk_policy_digest" = NEW.binding->>'riskPolicyDigest'
     AND contract_state."permission_digest" = NEW.binding->>'permissionDigest'
     AND contract_state."budget_digest" = NEW.binding->>'budgetDigest'
     AND contract_state."recipient_digest" = NEW.binding->>'recipientDigest'
     AND project_owner_ratification_effective(NEW.project_id, NEW.binding->>'contractDigest')
   ORDER BY ratification."ratified_at" DESC, ratification."id" DESC LIMIT 1;
  IF predecessor.binding_digest IS NOT NULL THEN
    SELECT ratification_id INTO predecessor_ratification
      FROM outcome_binding_ratification
     WHERE tenant_id = NEW.tenant_id AND project_id = NEW.project_id
       AND binding_digest = predecessor.binding_digest;
  END IF;
  INSERT INTO outcome_binding_ratification (
    tenant_id, project_id, binding_digest, contract_digest, contract_revision,
    ratification_id, carried_forward
  ) VALUES (
    NEW.tenant_id, NEW.project_id, NEW.binding_digest, NEW.binding->>'contractDigest',
    ratification_revision, ratification_value,
    COALESCE(
      ratification_value IS NOT NULL AND predecessor_ratification = ratification_value,
      false
    )
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER outcome_binding_transition_record
  AFTER INSERT ON outcome_fact_binding
  FOR EACH ROW EXECUTE FUNCTION outcome_binding_transition_record();

CREATE OR REPLACE FUNCTION outcome_matching_fact_invalidates_reduction() RETURNS trigger AS $$
DECLARE
  request_value uuid;
  reason_value text;
BEGIN
  reason_value := CASE
    WHEN NEW.payload ? 'contradictsFactId' OR NEW.payload ? 'contradictsFactIds'
      THEN 'LATE_MATCHING_CONTRADICTION'
    ELSE 'MATCHING_FACT_APPENDED'
  END;
  request_value := outcome_enqueue_reconcile_request(
    NEW.tenant_id, NEW.project_id, NEW.binding_digest::text, NEW.logical_time,
    reason_value, ARRAY['factCutDigest', 'asOfLogicalTime'], ARRAY['AS_OF_ADVANCED']
  );
  PERFORM outcome_obsolete_current_reduction(
    NEW.tenant_id, NEW.project_id, NEW.binding_digest::text, request_value, NULL,
    reason_value, NEW.logical_time
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER outcome_matching_fact_invalidates_reduction
  AFTER INSERT ON outcome_canonical_fact
  FOR EACH ROW EXECUTE FUNCTION outcome_matching_fact_invalidates_reduction();

CREATE OR REPLACE FUNCTION outcome_authority_revocation_invalidates_reduction() RETURNS trigger AS $$
DECLARE
  binding_value outcome_fact_binding%ROWTYPE;
  request_value uuid;
BEGIN
  SELECT * INTO binding_value FROM outcome_fact_binding
   WHERE tenant_id = NEW.tenant_id AND project_id = NEW.project_id
   ORDER BY binding_epoch DESC LIMIT 1;
  IF binding_value.binding_digest IS NULL THEN RETURN NEW; END IF;
  request_value := outcome_enqueue_reconcile_request(
    NEW.tenant_id, NEW.project_id, binding_value.binding_digest::text,
    NEW.revoked_at_logical_time, 'AUTHORITY_REVOKED',
    ARRAY['authorityGrantDigest'], ARRAY['AUTHORITY_CHANGED']
  );
  PERFORM outcome_obsolete_current_reduction(
    NEW.tenant_id, NEW.project_id, binding_value.binding_digest::text,
    request_value, NULL, 'AUTHORITY_REVOKED', NEW.revoked_at_logical_time
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER outcome_authority_revocation_invalidates_reduction
  AFTER INSERT ON outcome_fact_authority_revocation
  FOR EACH ROW EXECUTE FUNCTION outcome_authority_revocation_invalidates_reduction();

ALTER FUNCTION outcome_commit_evaluation(
  uuid, uuid, text, text, uuid, text, bigint, text, text, jsonb
) RENAME TO outcome_commit_evaluation_v1;

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
  receipt jsonb;
  evaluation_value uuid;
  request_value uuid;
  successor_count integer;
BEGIN
  receipt := outcome_commit_evaluation_v1(
    p_authenticated_tenant, p_project_id, p_subject_type, p_subject_id, p_cut_id,
    p_expected_binding_digest, p_expected_watermark_logical_time, p_evaluator_version,
    p_evaluator_digest, p_evaluation
  );
  evaluation_value := (receipt->>'evaluationId')::uuid;

  SELECT request_id INTO request_value
    FROM outcome_reconcile_request
   WHERE tenant_id = p_authenticated_tenant AND project_id = p_project_id
     AND binding_digest = p_expected_binding_digest AND status = 'PENDING'
     AND trigger_logical_time <= p_expected_watermark_logical_time
   ORDER BY request_generation DESC LIMIT 1 FOR UPDATE;

  -- Immutable proof history may fan into a later reduction.  A result is never mutated into the
  -- new proof; the relation is a separate audit edge.
  INSERT INTO outcome_proof_successor (
    tenant_id, project_id, predecessor_evaluation_id, successor_evaluation_id, request_id
  )
  SELECT obsolete.tenant_id, obsolete.project_id, obsolete.evaluation_id,
         evaluation_value, obsolete.request_id
    FROM outcome_proof_obsolescence obsolete
   WHERE obsolete.tenant_id = p_authenticated_tenant
     AND obsolete.project_id = p_project_id
     AND obsolete.obsolete_at_logical_time <= p_expected_watermark_logical_time
     AND obsolete.evaluation_id <> evaluation_value
     AND NOT EXISTS (
       SELECT 1 FROM outcome_proof_successor existing
        WHERE existing.tenant_id = obsolete.tenant_id
          AND existing.project_id = obsolete.project_id
          AND existing.predecessor_evaluation_id = obsolete.evaluation_id
     )
  ON CONFLICT DO NOTHING;

  -- The reduction receipt is inserted even when the successor set is empty.  Successor edges are
  -- based on closure dimensions declared by the new evaluator output, so one predecessor may map
  -- to any number of new obligations and unrelated work is not conflated.
  INSERT INTO outcome_obligation_reduction (
    tenant_id, project_id, predecessor_obligation_revision, successor_evaluation_id, request_id
  )
  SELECT obsolete.tenant_id, obsolete.project_id,
         obsolete.predecessor_obligation_revision, evaluation_value, obsolete.request_id
    FROM outcome_obsolete_obligation obsolete
   WHERE obsolete.tenant_id = p_authenticated_tenant
     AND obsolete.project_id = p_project_id
     AND obsolete.obsolete_at_logical_time <= p_expected_watermark_logical_time
  ON CONFLICT (tenant_id, project_id, predecessor_obligation_revision) DO NOTHING;

  INSERT INTO outcome_obligation_successor (
    tenant_id, project_id, predecessor_obligation_revision,
    successor_obligation_revision, successor_evaluation_id, request_id
  )
  SELECT obsolete.tenant_id, obsolete.project_id,
         obsolete.predecessor_obligation_revision, active.obligation_revision,
         evaluation_value, obsolete.request_id
    FROM outcome_obsolete_obligation obsolete
    JOIN outcome_obligation_reduction reduction
      ON reduction.tenant_id = obsolete.tenant_id
     AND reduction.project_id = obsolete.project_id
     AND reduction.predecessor_obligation_revision = obsolete.predecessor_obligation_revision
     AND reduction.successor_evaluation_id = evaluation_value
    JOIN outcome_active_obligation active
      ON active.tenant_id = obsolete.tenant_id AND active.project_id = obsolete.project_id
     AND active.evaluation_id = evaluation_value
   WHERE obsolete.tenant_id = p_authenticated_tenant
     AND obsolete.project_id = p_project_id
     AND EXISTS (
       SELECT 1
         FROM jsonb_array_elements_text(
                COALESCE(obsolete.obligation->'blocksClosureOf', '[]'::jsonb)
              ) old_dimension(value)
         JOIN jsonb_array_elements_text(
                COALESCE(active.obligation->'blocksClosureOf', '[]'::jsonb)
              ) new_dimension(value)
           ON new_dimension.value = old_dimension.value
     )
  ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS successor_count = ROW_COUNT;

  IF request_value IS NOT NULL THEN
    UPDATE outcome_reconcile_request
       SET status = 'COMMITTED', evaluation_id = evaluation_value,
           concluded_at = clock_timestamp()
     WHERE request_id = request_value AND status = 'PENDING';
  END IF;

  RETURN receipt || jsonb_build_object(
    'reconcileRequestId', request_value,
    'successorEdges', successor_count
  );
END;
$$ LANGUAGE plpgsql;

ALTER FUNCTION project_owner_ratify_contract(
  uuid, uuid, text, text, text, uuid, uuid, text, text, boolean
) RENAME TO project_owner_ratify_contract_v1;

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
  existing "project_owner_ratification"%ROWTYPE;
BEGIN
  PERFORM 1 FROM "project" WHERE "id" = p_project AND "owner_id" = p_owner
    FOR NO KEY UPDATE;
  IF FOUND THEN
    PERFORM project_refresh_completion_contract(p_project, 'OWNER_RATIFICATION_VERSION_RECHECK');
    SELECT * INTO state FROM "project_completion_contract"
     WHERE "project_id" = p_project FOR UPDATE;
    SELECT * INTO existing FROM "project_owner_ratification"
     WHERE "owner_id" = p_owner AND "idempotency_key" = p_idempotency_key;
    IF FOUND AND existing."contract_revision" IS DISTINCT FROM state."contract_revision" THEN
      RETURN jsonb_build_object(
        'code', 'OWNER_DECISION_STALE', 'ok', false,
        'currentContractDigest', state."contract_digest"::text,
        'currentContractRevision', state."contract_revision"::text,
        'requiredAction', 'read the current owner decision request'
      );
    END IF;
    IF NOT p_atomic_create THEN
      SELECT * INTO request FROM "project_owner_decision_request"
       WHERE "id" = p_request_id AND "project_id" = p_project FOR UPDATE;
      IF request."id" IS NOT NULL
         AND request."contract_revision" IS DISTINCT FROM state."contract_revision" THEN
        RETURN jsonb_build_object(
          'code', 'OWNER_DECISION_STALE', 'ok', false,
          'currentContractDigest', state."contract_digest"::text,
          'currentContractRevision', state."contract_revision"::text,
          'requiredAction', 'read the current owner decision request'
        );
      END IF;
    END IF;
  END IF;
  RETURN project_owner_ratify_contract_v1(
    p_owner, p_project, p_actor_type, p_actor_id, p_expected_contract, p_request_id,
    p_cta_token, p_decision, p_idempotency_key, p_atomic_create
  );
END;
$$ LANGUAGE plpgsql;

ALTER FUNCTION project_preapproved_ratify_contract(
  uuid, uuid, text, text, text, uuid, text, text
) RENAME TO project_preapproved_ratify_contract_v1;

CREATE OR REPLACE FUNCTION project_preapproved_ratify_contract(
  p_owner UUID,
  p_project UUID,
  p_actor_type TEXT,
  p_actor_id TEXT,
  p_authority_kind TEXT,
  p_authority_id UUID,
  p_expected_contract TEXT,
  p_idempotency_key TEXT
) RETURNS JSONB AS $$
DECLARE
  result_value jsonb;
  ratification_revision bigint;
  current_revision bigint;
BEGIN
  result_value := project_preapproved_ratify_contract_v1(
    p_owner, p_project, p_actor_type, p_actor_id, p_authority_kind, p_authority_id,
    p_expected_contract, p_idempotency_key
  );
  IF result_value->>'duplicate' = 'true' AND result_value ? 'ratificationId' THEN
    SELECT "contract_revision" INTO ratification_revision
      FROM "project_owner_ratification" WHERE "id" = (result_value->>'ratificationId')::uuid;
    SELECT "contract_revision" INTO current_revision
      FROM "project_completion_contract" WHERE "project_id" = p_project;
    IF ratification_revision IS DISTINCT FROM current_revision THEN
      RETURN jsonb_build_object(
        'code', 'OWNER_DECISION_STALE', 'ok', false,
        'currentContractRevision', current_revision::text,
        'requiredAction', 're-evaluate the preapproval against the current semantic revision'
      );
    END IF;
  END IF;
  RETURN result_value;
END;
$$ LANGUAGE plpgsql;

ALTER FUNCTION project_submit_ratified_action(
  uuid, uuid, text, text, text, jsonb, text
) RENAME TO project_submit_ratified_action_v1;

CREATE OR REPLACE FUNCTION project_submit_ratified_action(
  p_owner UUID,
  p_project UUID,
  p_principal_type TEXT,
  p_principal_id TEXT,
  p_trigger_kind TEXT,
  p_action JSONB,
  p_idempotency_key TEXT
) RETURNS JSONB AS $$
DECLARE
  current_binding outcome_fact_binding%ROWTYPE;
  existing "project_ratified_action_intent"%ROWTYPE;
  stream_head bigint;
BEGIN
  PERFORM 1 FROM "project" WHERE "id" = p_project AND "owner_id" = p_owner
    FOR NO KEY UPDATE;
  IF FOUND THEN
    PERFORM 1 FROM outcome_fact_stream
     WHERE tenant_id = p_owner AND project_id = p_project FOR UPDATE;
    IF FOUND THEN
      SELECT * INTO current_binding FROM outcome_fact_binding
       WHERE tenant_id = p_owner AND project_id = p_project
       ORDER BY binding_epoch DESC LIMIT 1;
      SELECT last_logical_time INTO stream_head FROM outcome_fact_stream
       WHERE tenant_id = p_owner AND project_id = p_project;
      IF current_binding.binding_digest IS NULL
         OR p_action->>'bindingDigest' IS DISTINCT FROM current_binding.binding_digest::text THEN
        RETURN jsonb_build_object(
          'code', 'RATIFIED_ACTION_BINDING_STALE', 'ok', false,
          'currentBindingDigest', current_binding.binding_digest::text,
          'requiredAction', 'recompute the action under the current complete binding'
        );
      END IF;
      IF NOT EXISTS (
        SELECT 1 FROM outcome_fact_authority_grant authority
         WHERE authority.tenant_id = p_owner AND authority.project_id = p_project
           AND authority.grant_digest = current_binding.binding->>'authorityGrantDigest'
           AND authority.valid_from_logical_time <= stream_head
           AND (authority.valid_through_logical_time IS NULL
                OR authority.valid_through_logical_time >= stream_head)
           AND NOT EXISTS (
             SELECT 1 FROM outcome_fact_authority_revocation revocation
              WHERE revocation.tenant_id = authority.tenant_id
                AND revocation.project_id = authority.project_id
                AND revocation.grant_id = authority.grant_id
                AND revocation.revoked_at_logical_time <= stream_head
           )
      ) THEN
        RETURN jsonb_build_object(
          'code', 'RATIFIED_ACTION_AUTHORITY_STALE', 'ok', false,
          'requiredAction', 'obtain a current authority grant and recompute the binding'
        );
      END IF;
      SELECT * INTO existing FROM "project_ratified_action_intent"
       WHERE "owner_id" = p_owner AND "project_id" = p_project
         AND "idempotency_key" = p_idempotency_key;
      IF existing."id" IS NOT NULL
         AND (existing."outcome_binding_digest" IS DISTINCT FROM current_binding.binding_digest
              OR existing."outcome_binding_epoch" IS DISTINCT FROM current_binding.binding_epoch
              OR existing."outcome_watermark_logical_time" IS DISTINCT FROM stream_head) THEN
        RETURN jsonb_build_object(
          'code', 'RATIFIED_ACTION_BINDING_STALE', 'ok', false,
          'currentBindingDigest', current_binding.binding_digest::text,
          'requiredAction', 'use a new idempotency key for the recomputed binding'
        );
      END IF;
    END IF;
  END IF;
  RETURN project_submit_ratified_action_v1(
    p_owner, p_project, p_principal_type, p_principal_id, p_trigger_kind,
    p_action, p_idempotency_key
  );
END;
$$ LANGUAGE plpgsql;

ALTER FUNCTION project_commit_ratified_action(uuid, uuid, uuid, uuid)
  RENAME TO project_commit_ratified_action_v1;

CREATE OR REPLACE FUNCTION project_commit_ratified_action(
  p_owner UUID,
  p_project UUID,
  p_intent UUID,
  p_commit_token UUID
) RETURNS JSONB AS $$
DECLARE
  intent "project_ratified_action_intent"%ROWTYPE;
  existing "project_ratified_action_commit"%ROWTYPE;
  state "project_completion_contract"%ROWTYPE;
  current_binding outcome_fact_binding%ROWTYPE;
  stream_head bigint;
BEGIN
  SELECT * INTO intent FROM "project_ratified_action_intent"
   WHERE "id" = p_intent AND "project_id" = p_project AND "owner_id" = p_owner;
  IF NOT FOUND OR intent."commit_token" IS DISTINCT FROM p_commit_token THEN
    RETURN jsonb_build_object('code', 'RATIFIED_ACTION_TOKEN_INVALID', 'ok', false);
  END IF;
  SELECT * INTO existing FROM "project_ratified_action_commit" WHERE "intent_id" = p_intent;
  IF FOUND THEN
    RETURN jsonb_build_object('duplicate', true, 'intentId', p_intent, 'ok', true);
  END IF;

  PERFORM 1 FROM "project" WHERE "id" = p_project AND "owner_id" = p_owner
    FOR NO KEY UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('code', 'PROJECT_NOT_FOUND', 'ok', false); END IF;
  PERFORM project_refresh_completion_contract(p_project, 'ACTION_VERSION_COMMIT_RECHECK');
  SELECT * INTO state FROM "project_completion_contract"
   WHERE "project_id" = p_project FOR UPDATE;
  IF intent."contract_revision" IS DISTINCT FROM state."contract_revision" THEN
    RETURN jsonb_build_object('code', 'RATIFIED_ACTION_BINDING_STALE', 'ok', false,
      'requiredAction', 'recompute the action under the current semantic revision');
  END IF;

  PERFORM 1 FROM outcome_fact_stream
   WHERE tenant_id = p_owner AND project_id = p_project FOR UPDATE;
  IF FOUND THEN
    SELECT * INTO current_binding FROM outcome_fact_binding
     WHERE tenant_id = p_owner AND project_id = p_project
     ORDER BY binding_epoch DESC LIMIT 1;
    SELECT last_logical_time INTO stream_head FROM outcome_fact_stream
     WHERE tenant_id = p_owner AND project_id = p_project;
    IF current_binding.binding_digest IS NULL
       OR intent."outcome_binding_digest" IS DISTINCT FROM current_binding.binding_digest
       OR intent."outcome_binding_epoch" IS DISTINCT FROM current_binding.binding_epoch
       OR intent."outcome_watermark_logical_time" IS DISTINCT FROM stream_head THEN
      RETURN jsonb_build_object(
        'code', 'RATIFIED_ACTION_BINDING_STALE', 'ok', false,
        'currentBindingDigest', current_binding.binding_digest::text,
        'requiredAction', 'recompute the action under the current complete binding'
      );
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM outcome_fact_authority_grant authority
       WHERE authority.tenant_id = p_owner AND authority.project_id = p_project
         AND authority.grant_digest = current_binding.binding->>'authorityGrantDigest'
         AND authority.valid_from_logical_time <= stream_head
         AND (authority.valid_through_logical_time IS NULL
              OR authority.valid_through_logical_time >= stream_head)
         AND NOT EXISTS (
           SELECT 1 FROM outcome_fact_authority_revocation revocation
            WHERE revocation.tenant_id = authority.tenant_id
              AND revocation.project_id = authority.project_id
              AND revocation.grant_id = authority.grant_id
              AND revocation.revoked_at_logical_time <= stream_head
         )
    ) THEN
      RETURN jsonb_build_object(
        'code', 'RATIFIED_ACTION_AUTHORITY_STALE', 'ok', false,
        'requiredAction', 'obtain a current authority grant and recompute the binding'
      );
    END IF;
  END IF;
  RETURN project_commit_ratified_action_v1(p_owner, p_project, p_intent, p_commit_token);
END;
$$ LANGUAGE plpgsql;

INSERT INTO outcome_binding_ratification (
  tenant_id, project_id, binding_digest, contract_digest, contract_revision,
  ratification_id, carried_forward
)
SELECT binding.tenant_id, binding.project_id, binding.binding_digest,
       binding.binding->>'contractDigest', ratification.contract_revision,
       ratification.id, false
  FROM outcome_fact_binding binding
  LEFT JOIN LATERAL (
    SELECT candidate.id, candidate.contract_revision
      FROM "project_owner_ratification" candidate
     WHERE candidate."project_id" = binding.project_id
       AND candidate."contract_digest" = binding.binding->>'contractDigest'
       AND project_owner_ratification_effective(
             binding.project_id, binding.binding->>'contractDigest'
           )
     ORDER BY candidate."ratified_at" DESC, candidate."id" DESC LIMIT 1
  ) ratification ON true
ON CONFLICT DO NOTHING;

CREATE VIEW outcome_current_reconcile_request AS
SELECT latest.*,
       latest.binding_digest = current_binding.binding_digest AS binding_current,
       latest.trigger_logical_time = stream.last_logical_time AS watermark_current,
       (latest.status = 'PENDING'
        AND latest.binding_digest = current_binding.binding_digest
        AND latest.trigger_logical_time = stream.last_logical_time) AS requires_reconcile
  FROM (
    SELECT DISTINCT ON (tenant_id, project_id) *
      FROM outcome_reconcile_request
     ORDER BY tenant_id, project_id, request_generation DESC
  ) latest
  JOIN outcome_fact_stream stream
    ON stream.tenant_id = latest.tenant_id AND stream.project_id = latest.project_id
  JOIN LATERAL (
    SELECT binding_digest
      FROM outcome_fact_binding binding
     WHERE binding.tenant_id = latest.tenant_id AND binding.project_id = latest.project_id
     ORDER BY binding_epoch DESC LIMIT 1
  ) current_binding ON true;

CREATE VIEW outcome_current_binding_ratification AS
SELECT link.*,
       link.binding_digest = current_binding.binding_digest AS binding_current,
       (link.binding_digest = current_binding.binding_digest
        AND contract_state."contract_digest" = current_binding.binding->>'contractDigest'
        AND contract_state."risk_policy_digest" = current_binding.binding->>'riskPolicyDigest'
        AND contract_state."permission_digest" = current_binding.binding->>'permissionDigest'
        AND contract_state."budget_digest" = current_binding.binding->>'budgetDigest'
        AND contract_state."recipient_digest" = current_binding.binding->>'recipientDigest'
        AND project_owner_ratification_effective(link.project_id, link.contract_digest::text)
       ) AS effective
  FROM outcome_binding_ratification link
  JOIN LATERAL (
    SELECT binding_digest, binding
      FROM outcome_fact_binding binding
     WHERE binding.tenant_id = link.tenant_id AND binding.project_id = link.project_id
     ORDER BY binding_epoch DESC LIMIT 1
  ) current_binding ON true
  LEFT JOIN "project_completion_contract" contract_state
    ON contract_state."project_id" = link.project_id;

CREATE VIEW outcome_obligation_successor_set AS
SELECT obsolete.tenant_id, obsolete.project_id,
       obsolete.predecessor_obligation_id,
       obsolete.predecessor_obligation_revision,
       reduction.successor_evaluation_id,
       COALESCE(
         array_agg(successor.successor_obligation_revision::text
                   ORDER BY successor.successor_obligation_revision)
           FILTER (WHERE successor.successor_obligation_revision IS NOT NULL),
         ARRAY[]::text[]
       ) AS successor_obligation_revisions,
       count(successor.successor_obligation_revision)::integer AS successor_count
  FROM outcome_obsolete_obligation obsolete
  JOIN outcome_obligation_reduction reduction
    ON reduction.tenant_id = obsolete.tenant_id
   AND reduction.project_id = obsolete.project_id
   AND reduction.predecessor_obligation_revision = obsolete.predecessor_obligation_revision
  LEFT JOIN outcome_obligation_successor successor
    ON successor.tenant_id = obsolete.tenant_id
   AND successor.project_id = obsolete.project_id
   AND successor.predecessor_obligation_revision = obsolete.predecessor_obligation_revision
   AND successor.successor_evaluation_id = reduction.successor_evaluation_id
 GROUP BY obsolete.tenant_id, obsolete.project_id, obsolete.predecessor_obligation_id,
          obsolete.predecessor_obligation_revision, reduction.successor_evaluation_id;

CREATE TRIGGER outcome_binding_transition_append_only
  BEFORE UPDATE OR DELETE ON outcome_binding_transition
  FOR EACH ROW EXECUTE FUNCTION outcome_append_only_guard();
CREATE TRIGGER outcome_proof_obsolescence_append_only
  BEFORE UPDATE OR DELETE ON outcome_proof_obsolescence
  FOR EACH ROW EXECUTE FUNCTION outcome_append_only_guard();
CREATE TRIGGER outcome_proof_successor_append_only
  BEFORE UPDATE OR DELETE ON outcome_proof_successor
  FOR EACH ROW EXECUTE FUNCTION outcome_append_only_guard();
CREATE TRIGGER outcome_obsolete_obligation_append_only
  BEFORE UPDATE OR DELETE ON outcome_obsolete_obligation
  FOR EACH ROW EXECUTE FUNCTION outcome_append_only_guard();
CREATE TRIGGER outcome_obligation_reduction_append_only
  BEFORE UPDATE OR DELETE ON outcome_obligation_reduction
  FOR EACH ROW EXECUTE FUNCTION outcome_append_only_guard();
CREATE TRIGGER outcome_obligation_successor_append_only
  BEFORE UPDATE OR DELETE ON outcome_obligation_successor
  FOR EACH ROW EXECUTE FUNCTION outcome_append_only_guard();
CREATE TRIGGER outcome_binding_ratification_append_only
  BEFORE UPDATE OR DELETE ON outcome_binding_ratification
  FOR EACH ROW EXECUTE FUNCTION outcome_append_only_guard();

REVOKE INSERT, UPDATE, DELETE ON outcome_reconcile_request FROM PUBLIC;
REVOKE INSERT, UPDATE, DELETE ON outcome_binding_transition FROM PUBLIC;
REVOKE INSERT, UPDATE, DELETE ON outcome_proof_obsolescence FROM PUBLIC;
REVOKE INSERT, UPDATE, DELETE ON outcome_proof_successor FROM PUBLIC;
REVOKE INSERT, UPDATE, DELETE ON outcome_obsolete_obligation FROM PUBLIC;
REVOKE INSERT, UPDATE, DELETE ON outcome_obligation_reduction FROM PUBLIC;
REVOKE INSERT, UPDATE, DELETE ON outcome_obligation_successor FROM PUBLIC;
REVOKE INSERT, UPDATE, DELETE ON outcome_binding_ratification FROM PUBLIC;

COMMENT ON TABLE outcome_reconcile_request IS
  'One linearized request to reduce the exact current binding/watermark; newer stream facts supersede older pending requests.';
COMMENT ON TABLE outcome_proof_obsolescence IS
  'Append-only audit that a retained evaluator proof stopped being eligible for the current binding or watermark.';
COMMENT ON TABLE outcome_obligation_successor IS
  'Many-to-many audit edges from an obsolete obligation revision to zero or more revisions emitted by the new contract.';
COMMENT ON VIEW outcome_obligation_successor_set IS
  'One row per reduced obsolete obligation, including successor_count=0 as a decided empty successor set.';
COMMENT ON VIEW outcome_current_binding_ratification IS
  'Binding-specific ratification projection. Semantic-equivalent plan evolution may carry a decision; stale binding links never count.';

COMMIT;
