-- Owner Ratification is the value/authority decision that precedes project execution.  It is
-- deliberately separate from acceptance conclusions: the owner approves the goal, semantic
-- completion contract, risk envelope, permissions, budget and recipient; evaluators still prove
-- the individual criteria.  Ratifications bind the semantic contract digest.  Commands,
-- verifiers and evidence wiring have their own evaluation-plan digest and may evolve without
-- manufacturing a new owner decision.

BEGIN;

-- Split the old all-in-one criterion revision into semantic and evaluation-plan lanes.  Keep the
-- legacy columns exactly as they are for acceptance-run compatibility: existing evidence still
-- advances on either kind of edit, while owner ratification advances only on semantic edits.
ALTER TABLE "project_acceptance_criterion_definition"
  ADD COLUMN "semantic_revision" INTEGER,
  ADD COLUMN "semantic_hash" CHAR(64),
  ADD COLUMN "evaluation_plan_revision" INTEGER,
  ADD COLUMN "evaluation_plan_hash" CHAR(64);

CREATE OR REPLACE FUNCTION project_acceptance_definition_semantic_hash(
  p_text TEXT,
  p_completion_criterion "task_completion_criterion"
) RETURNS CHAR(64) AS $$
  SELECT encode(digest(jsonb_build_object(
    'criteriaTrust', p_completion_criterion::text,
    'text', btrim(p_text)
  )::text, 'sha256'), 'hex')::CHAR(64)
$$ LANGUAGE SQL IMMUTABLE;

CREATE OR REPLACE FUNCTION project_acceptance_definition_evaluation_plan_hash(
  p_verification_method TEXT,
  p_acceptance_command TEXT,
  p_expected_exit_code INTEGER,
  p_evidence_task_id UUID
) RETURNS CHAR(64) AS $$
  SELECT encode(digest(jsonb_build_object(
    'acceptanceCommand', CASE WHEN p_acceptance_command IS NULL THEN NULL
                              ELSE btrim(p_acceptance_command) END,
    'evidenceTaskId', p_evidence_task_id::text,
    'expectedExitCode', p_expected_exit_code,
    'verificationMethod', btrim(p_verification_method)
  )::text, 'sha256'), 'hex')::CHAR(64)
$$ LANGUAGE SQL IMMUTABLE;

DROP TRIGGER project_acceptance_definition_normalize
  ON "project_acceptance_criterion_definition";

UPDATE "project_acceptance_criterion_definition"
   SET "semantic_revision" = "revision",
       "semantic_hash" = project_acceptance_definition_semantic_hash(
         "text", "completion_criterion"
       ),
       "evaluation_plan_revision" = "revision",
       "evaluation_plan_hash" = project_acceptance_definition_evaluation_plan_hash(
         "verification_method", "acceptance_command", "acceptance_expected_exit_code",
         "evidence_task_id"
       );

ALTER TABLE "project_acceptance_criterion_definition"
  ALTER COLUMN "semantic_revision" SET NOT NULL,
  ALTER COLUMN "semantic_revision" SET DEFAULT 1,
  ALTER COLUMN "semantic_hash" SET NOT NULL,
  ALTER COLUMN "evaluation_plan_revision" SET NOT NULL,
  ALTER COLUMN "evaluation_plan_revision" SET DEFAULT 1,
  ALTER COLUMN "evaluation_plan_hash" SET NOT NULL;

CREATE OR REPLACE FUNCTION project_acceptance_definition_normalize() RETURNS TRIGGER AS $$
DECLARE
  semantic_changed BOOLEAN;
  plan_changed BOOLEAN;
BEGIN
  NEW."text" := btrim(NEW."text");
  NEW."verification_method" := btrim(NEW."verification_method");
  NEW."acceptance_command" := CASE
    WHEN NEW."acceptance_command" IS NULL THEN NULL ELSE btrim(NEW."acceptance_command") END;
  NEW."completion_criterion_override_reason" := CASE
    WHEN NEW."completion_criterion_override_reason" IS NULL THEN NULL
    ELSE btrim(NEW."completion_criterion_override_reason") END;

  IF TG_OP = 'INSERT' THEN
    NEW."revision" := 1;
    NEW."semantic_revision" := 1;
    NEW."evaluation_plan_revision" := 1;
  ELSE
    semantic_changed := NEW."text" IS DISTINCT FROM OLD."text"
      OR NEW."completion_criterion" IS DISTINCT FROM OLD."completion_criterion";
    plan_changed := NEW."verification_method" IS DISTINCT FROM OLD."verification_method"
      OR NEW."acceptance_command" IS DISTINCT FROM OLD."acceptance_command"
      OR NEW."acceptance_expected_exit_code" IS DISTINCT FROM OLD."acceptance_expected_exit_code"
      OR NEW."evidence_task_id" IS DISTINCT FROM OLD."evidence_task_id";
    NEW."revision" := CASE WHEN semantic_changed OR plan_changed
      THEN OLD."revision" + 1 ELSE OLD."revision" END;
    NEW."semantic_revision" := CASE WHEN semantic_changed
      THEN OLD."semantic_revision" + 1 ELSE OLD."semantic_revision" END;
    NEW."evaluation_plan_revision" := CASE WHEN plan_changed
      THEN OLD."evaluation_plan_revision" + 1 ELSE OLD."evaluation_plan_revision" END;
    NEW."updated_at" := CURRENT_TIMESTAMP;
  END IF;

  NEW."content_hash" := project_acceptance_definition_content_hash(
    NEW."text", NEW."verification_method", NEW."completion_criterion",
    NEW."acceptance_command", NEW."acceptance_expected_exit_code", NEW."evidence_task_id"
  );
  NEW."semantic_hash" := project_acceptance_definition_semantic_hash(
    NEW."text", NEW."completion_criterion"
  );
  NEW."evaluation_plan_hash" := project_acceptance_definition_evaluation_plan_hash(
    NEW."verification_method", NEW."acceptance_command",
    NEW."acceptance_expected_exit_code", NEW."evidence_task_id"
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER project_acceptance_definition_normalize
  BEFORE INSERT OR UPDATE OF
    "text", "verification_method", "completion_criterion", "acceptance_command",
    "acceptance_expected_exit_code", "evidence_task_id",
    "completion_criterion_override_reason", "revision", "content_hash",
    "semantic_revision", "semantic_hash", "evaluation_plan_revision", "evaluation_plan_hash"
  ON "project_acceptance_criterion_definition"
  FOR EACH ROW EXECUTE FUNCTION project_acceptance_definition_normalize();

-- Owner-created, bounded authorities.  Their specification is immutable; only use_count and the
-- append-like revoked_at transition may change.  Empty digest allowlists are forbidden, so a
-- purported template/delegation can never mean "anything this agent chooses".
CREATE TABLE "project_ratification_template" (
  "id" UUID PRIMARY KEY,
  "owner_id" UUID NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
  "name" TEXT NOT NULL CHECK (btrim("name") <> ''),
  "contract_constraint" JSONB NOT NULL CHECK (
    jsonb_typeof("contract_constraint") = 'object' AND "contract_constraint" <> '{}'::jsonb
  ),
  "risk_policy_digests" CHAR(64)[] NOT NULL CHECK (cardinality("risk_policy_digests") > 0),
  "permission_digests" CHAR(64)[] NOT NULL CHECK (cardinality("permission_digests") > 0),
  "budget_digests" CHAR(64)[] NOT NULL CHECK (cardinality("budget_digests") > 0),
  "recipient_digests" CHAR(64)[] NOT NULL CHECK (cardinality("recipient_digests") > 0),
  "max_session_budget_per_day" INTEGER NOT NULL CHECK ("max_session_budget_per_day" > 0),
  "max_uses" INTEGER NOT NULL CHECK ("max_uses" > 0),
  "use_count" INTEGER NOT NULL DEFAULT 0 CHECK ("use_count" >= 0),
  "valid_from" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "valid_through" TIMESTAMPTZ NOT NULL CHECK ("valid_through" > "valid_from"),
  "template_digest" CHAR(64) NOT NULL CHECK (outcome_valid_digest("template_digest")),
  "revoked_at" TIMESTAMPTZ,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE ("owner_id", "template_digest")
);

CREATE TABLE "project_ratification_delegation" (
  "id" UUID PRIMARY KEY,
  "owner_id" UUID NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
  "delegate_type" TEXT NOT NULL CHECK ("delegate_type" IN ('AGENT', 'RUNNER', 'SERVICE')),
  "delegate_id" TEXT NOT NULL CHECK (btrim("delegate_id") <> ''),
  "project_id" UUID REFERENCES "project"("id") ON DELETE CASCADE,
  "contract_constraint" JSONB NOT NULL CHECK (
    jsonb_typeof("contract_constraint") = 'object' AND "contract_constraint" <> '{}'::jsonb
  ),
  "risk_policy_digests" CHAR(64)[] NOT NULL CHECK (cardinality("risk_policy_digests") > 0),
  "permission_digests" CHAR(64)[] NOT NULL CHECK (cardinality("permission_digests") > 0),
  "budget_digests" CHAR(64)[] NOT NULL CHECK (cardinality("budget_digests") > 0),
  "recipient_digests" CHAR(64)[] NOT NULL CHECK (cardinality("recipient_digests") > 0),
  "max_session_budget_per_day" INTEGER NOT NULL CHECK ("max_session_budget_per_day" > 0),
  "max_uses" INTEGER NOT NULL CHECK ("max_uses" > 0),
  "use_count" INTEGER NOT NULL DEFAULT 0 CHECK ("use_count" >= 0),
  "valid_from" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "valid_through" TIMESTAMPTZ NOT NULL CHECK ("valid_through" > "valid_from"),
  "delegation_digest" CHAR(64) NOT NULL CHECK (outcome_valid_digest("delegation_digest")),
  "revoked_at" TIMESTAMPTZ,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE ("owner_id", "delegation_digest")
);

-- The current contract is mutable/rebuildable state.  Ratifications and decisions below are the
-- append-only facts.  The selected template/delegation is part of semantic material, so replacing
-- or revoking it advances contract_digest instead of merely changing an authorization lookup.
CREATE TABLE "project_completion_contract" (
  "project_id" UUID PRIMARY KEY REFERENCES "project"("id") ON DELETE CASCADE,
  "owner_id" UUID NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
  "contract_revision" BIGINT NOT NULL DEFAULT 1 CHECK ("contract_revision" > 0),
  "evaluation_plan_revision" BIGINT NOT NULL DEFAULT 1 CHECK ("evaluation_plan_revision" > 0),
  "contract_digest" CHAR(64) NOT NULL CHECK (outcome_valid_digest("contract_digest")),
  "evaluation_plan_digest" CHAR(64) NOT NULL CHECK (outcome_valid_digest("evaluation_plan_digest")),
  "risk_policy_digest" CHAR(64) NOT NULL CHECK (outcome_valid_digest("risk_policy_digest")),
  "permission_digest" CHAR(64) NOT NULL CHECK (outcome_valid_digest("permission_digest")),
  "budget_digest" CHAR(64) NOT NULL CHECK (outcome_valid_digest("budget_digest")),
  "recipient_digest" CHAR(64) NOT NULL CHECK (outcome_valid_digest("recipient_digest")),
  "semantic_material" JSONB NOT NULL CHECK (jsonb_typeof("semantic_material") = 'object'),
  "evaluation_plan_material" JSONB NOT NULL CHECK (jsonb_typeof("evaluation_plan_material") = 'object'),
  "template_id" UUID REFERENCES "project_ratification_template"("id") ON DELETE RESTRICT,
  "delegation_id" UUID REFERENCES "project_ratification_delegation"("id") ON DELETE RESTRICT,
  "last_change_reason" TEXT NOT NULL,
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (NOT ("template_id" IS NOT NULL AND "delegation_id" IS NOT NULL))
);

CREATE INDEX "project_completion_contract_owner_idx"
  ON "project_completion_contract" ("owner_id", "updated_at" DESC);

CREATE TABLE "project_owner_decision_request" (
  "id" UUID PRIMARY KEY,
  "project_id" UUID NOT NULL REFERENCES "project"("id") ON DELETE CASCADE,
  "owner_id" UUID NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
  "contract_digest" CHAR(64) NOT NULL CHECK (outcome_valid_digest("contract_digest")),
  "request_generation" BIGINT NOT NULL CHECK ("request_generation" > 0),
  "kind" TEXT NOT NULL DEFAULT 'OWNER_RATIFICATION' CHECK ("kind" = 'OWNER_RATIFICATION'),
  "status" TEXT NOT NULL DEFAULT 'PENDING' CHECK (
    "status" IN ('PENDING', 'APPROVED', 'DENIED', 'SUPERSEDED', 'EXPIRED')
  ),
  "reason_code" TEXT NOT NULL,
  "previous_contract_digest" CHAR(64),
  "semantic_diff" JSONB NOT NULL DEFAULT '{}'::jsonb,
  "decision_payload" JSONB NOT NULL,
  "cta_token" UUID NOT NULL UNIQUE,
  "expires_at" TIMESTAMPTZ NOT NULL,
  "decided_at" TIMESTAMPTZ,
  "decided_by_type" TEXT,
  "decided_by_id" TEXT,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE ("project_id", "request_generation")
);

CREATE UNIQUE INDEX "project_owner_decision_one_pending_idx"
  ON "project_owner_decision_request" ("project_id") WHERE "status" = 'PENDING';
CREATE INDEX "project_owner_decision_inbox_idx"
  ON "project_owner_decision_request" ("owner_id", "status", "created_at" DESC);

CREATE TABLE "project_owner_ratification" (
  "id" UUID PRIMARY KEY,
  "project_id" UUID NOT NULL REFERENCES "project"("id") ON DELETE CASCADE,
  "owner_id" UUID NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
  "contract_digest" CHAR(64) NOT NULL CHECK (outcome_valid_digest("contract_digest")),
  "evaluation_plan_digest_at_decision" CHAR(64) NOT NULL
    CHECK (outcome_valid_digest("evaluation_plan_digest_at_decision")),
  "source" TEXT NOT NULL CHECK (
    "source" IN ('OWNER', 'OWNER_ATOMIC_CREATE', 'PREAPPROVED_TEMPLATE', 'BOUND_DELEGATION')
  ),
  "ratified_by_type" TEXT NOT NULL CHECK (
    "ratified_by_type" IN ('OWNER', 'AGENT', 'RUNNER', 'SERVICE')
  ),
  "ratified_by_id" TEXT NOT NULL,
  "authority_id" UUID,
  "authority_digest" CHAR(64),
  "decision_request_id" UUID UNIQUE
    REFERENCES "project_owner_decision_request"("id") ON DELETE CASCADE,
  "idempotency_key" TEXT NOT NULL,
  "valid_through" TIMESTAMPTZ,
  "ratified_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (
    ("source" IN ('OWNER', 'OWNER_ATOMIC_CREATE')
      AND "ratified_by_type" = 'OWNER' AND "authority_id" IS NULL
      AND "authority_digest" IS NULL)
    OR ("source" = 'PREAPPROVED_TEMPLATE'
      AND "authority_id" IS NOT NULL AND "authority_digest" IS NOT NULL)
    OR ("source" = 'BOUND_DELEGATION'
      AND "authority_id" IS NOT NULL AND "authority_digest" IS NOT NULL)
  ),
  UNIQUE ("owner_id", "idempotency_key")
);

CREATE INDEX "project_owner_ratification_digest_idx"
  ON "project_owner_ratification" ("project_id", "contract_digest", "ratified_at" DESC);

-- Two-phase action admission.  Preparing an intent grants no effect.  The commit fact is appended
-- only after the exact contract/risk/permission/budget/recipient digests and effective
-- ratification have been rechecked under the Project row lock.
CREATE TABLE "project_ratified_action_intent" (
  "id" UUID PRIMARY KEY,
  "project_id" UUID NOT NULL REFERENCES "project"("id") ON DELETE CASCADE,
  "owner_id" UUID NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
  "principal_type" TEXT NOT NULL CHECK ("principal_type" IN ('SYSTEM','AGENT','RUNNER','OWNER','SERVICE')),
  "principal_id" TEXT NOT NULL,
  "trigger_kind" TEXT NOT NULL CHECK ("trigger_kind" IN ('AUTO','MANUAL')),
  "effect_class" TEXT NOT NULL,
  "contract_digest" CHAR(64) NOT NULL,
  "evaluation_plan_digest" CHAR(64) NOT NULL,
  "risk_policy_digest" CHAR(64) NOT NULL,
  "permission_digest" CHAR(64) NOT NULL,
  "budget_digest" CHAR(64) NOT NULL,
  "recipient_digest" CHAR(64) NOT NULL,
  "budget_charge" INTEGER NOT NULL CHECK ("budget_charge" >= 0),
  "action" JSONB NOT NULL,
  "action_digest" CHAR(64) NOT NULL,
  "idempotency_key" TEXT NOT NULL,
  "commit_token" UUID NOT NULL UNIQUE,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE ("owner_id", "project_id", "idempotency_key")
);

CREATE TABLE "project_ratified_action_commit" (
  "intent_id" UUID PRIMARY KEY REFERENCES "project_ratified_action_intent"("id") ON DELETE CASCADE,
  "project_id" UUID NOT NULL REFERENCES "project"("id") ON DELETE CASCADE,
  "owner_id" UUID NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
  "contract_digest" CHAR(64) NOT NULL,
  "budget_charge" INTEGER NOT NULL CHECK ("budget_charge" >= 0),
  "committed_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX "project_ratified_action_budget_idx"
  ON "project_ratified_action_commit" ("project_id", "contract_digest", "committed_at" DESC);

CREATE OR REPLACE FUNCTION project_ratification_event_immutable() RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'DELETE'
     AND NOT EXISTS (SELECT 1 FROM "project" WHERE "id" = OLD."project_id") THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'OWNER_RATIFICATION_IMMUTABLE: % row % is an event and cannot be rewritten',
    TG_TABLE_NAME, OLD."id" USING ERRCODE = 'raise_exception';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER project_owner_ratification_immutable
  BEFORE UPDATE OR DELETE ON "project_owner_ratification"
  FOR EACH ROW EXECUTE FUNCTION project_ratification_event_immutable();

CREATE OR REPLACE FUNCTION project_action_intent_immutable() RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'DELETE'
     AND NOT EXISTS (SELECT 1 FROM "project" WHERE "id" = OLD."project_id") THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'RATIFIED_ACTION_INTENT_IMMUTABLE: intent % cannot be rewritten', OLD."id"
    USING ERRCODE = 'raise_exception';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER project_ratified_action_intent_immutable
  BEFORE UPDATE OR DELETE ON "project_ratified_action_intent"
  FOR EACH ROW EXECUTE FUNCTION project_action_intent_immutable();

CREATE OR REPLACE FUNCTION project_action_commit_immutable() RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'DELETE'
     AND NOT EXISTS (SELECT 1 FROM "project" WHERE "id" = OLD."project_id") THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'RATIFIED_ACTION_COMMIT_IMMUTABLE: commit % cannot be rewritten', OLD."intent_id"
    USING ERRCODE = 'raise_exception';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER project_ratified_action_commit_immutable
  BEFORE UPDATE OR DELETE ON "project_ratified_action_commit"
  FOR EACH ROW EXECUTE FUNCTION project_action_commit_immutable();

-- An authority's display name may be corrected and its counters may advance, but the envelope the
-- owner signed is immutable. Revocation is one-way. Without this wall, changing an allowlist while
-- retaining template_digest/delegation_digest would silently widen both future and extant grants.
CREATE OR REPLACE FUNCTION project_ratification_template_guard() RETURNS TRIGGER AS $$
BEGIN
  IF NEW."owner_id" IS DISTINCT FROM OLD."owner_id"
     OR NEW."contract_constraint" IS DISTINCT FROM OLD."contract_constraint"
     OR NEW."risk_policy_digests" IS DISTINCT FROM OLD."risk_policy_digests"
     OR NEW."permission_digests" IS DISTINCT FROM OLD."permission_digests"
     OR NEW."budget_digests" IS DISTINCT FROM OLD."budget_digests"
     OR NEW."recipient_digests" IS DISTINCT FROM OLD."recipient_digests"
     OR NEW."max_session_budget_per_day" IS DISTINCT FROM OLD."max_session_budget_per_day"
     OR NEW."max_uses" IS DISTINCT FROM OLD."max_uses"
     OR NEW."valid_from" IS DISTINCT FROM OLD."valid_from"
     OR NEW."valid_through" IS DISTINCT FROM OLD."valid_through"
     OR NEW."template_digest" IS DISTINCT FROM OLD."template_digest"
     OR NEW."use_count" < OLD."use_count"
     OR (OLD."revoked_at" IS NOT NULL AND NEW."revoked_at" IS DISTINCT FROM OLD."revoked_at") THEN
    RAISE EXCEPTION 'RATIFICATION_TEMPLATE_IMMUTABLE: signed authority fields cannot be rewritten'
      USING ERRCODE = 'raise_exception';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER project_ratification_template_guard
  BEFORE UPDATE ON "project_ratification_template"
  FOR EACH ROW EXECUTE FUNCTION project_ratification_template_guard();

CREATE OR REPLACE FUNCTION project_ratification_delegation_guard() RETURNS TRIGGER AS $$
BEGIN
  IF NEW."owner_id" IS DISTINCT FROM OLD."owner_id"
     OR NEW."delegate_type" IS DISTINCT FROM OLD."delegate_type"
     OR NEW."delegate_id" IS DISTINCT FROM OLD."delegate_id"
     OR NEW."project_id" IS DISTINCT FROM OLD."project_id"
     OR NEW."contract_constraint" IS DISTINCT FROM OLD."contract_constraint"
     OR NEW."risk_policy_digests" IS DISTINCT FROM OLD."risk_policy_digests"
     OR NEW."permission_digests" IS DISTINCT FROM OLD."permission_digests"
     OR NEW."budget_digests" IS DISTINCT FROM OLD."budget_digests"
     OR NEW."recipient_digests" IS DISTINCT FROM OLD."recipient_digests"
     OR NEW."max_session_budget_per_day" IS DISTINCT FROM OLD."max_session_budget_per_day"
     OR NEW."max_uses" IS DISTINCT FROM OLD."max_uses"
     OR NEW."valid_from" IS DISTINCT FROM OLD."valid_from"
     OR NEW."valid_through" IS DISTINCT FROM OLD."valid_through"
     OR NEW."delegation_digest" IS DISTINCT FROM OLD."delegation_digest"
     OR NEW."use_count" < OLD."use_count"
     OR (OLD."revoked_at" IS NOT NULL AND NEW."revoked_at" IS DISTINCT FROM OLD."revoked_at") THEN
    RAISE EXCEPTION 'RATIFICATION_DELEGATION_IMMUTABLE: signed authority fields cannot be rewritten'
      USING ERRCODE = 'raise_exception';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER project_ratification_delegation_guard
  BEFORE UPDATE ON "project_ratification_delegation"
  FOR EACH ROW EXECUTE FUNCTION project_ratification_delegation_guard();

-- One canonical snapshot builder.  Semantic criteria are sorted by stable id, so presentation
-- reordering is cosmetic.  semantic_revision prevents edit-then-revert from resurrecting an old
-- approval.  Evaluation-plan fields have their own revision/hash and never enter contractDigest.
CREATE OR REPLACE FUNCTION project_completion_contract_snapshot(p_project UUID)
RETURNS JSONB AS $$
DECLARE
  result JSONB;
BEGIN
  WITH base AS (
    SELECT p.*,
           state."template_id", state."delegation_id",
           template."template_digest",
           template."revoked_at" AS template_revoked_at,
           template."valid_through" AS template_valid_through,
           delegation."delegation_digest",
           delegation."revoked_at" AS delegation_revoked_at,
           delegation."valid_through" AS delegation_valid_through
      FROM "project" p
      LEFT JOIN "project_completion_contract" state ON state."project_id" = p."id"
      LEFT JOIN "project_ratification_template" template ON template."id" = state."template_id"
      LEFT JOIN "project_ratification_delegation" delegation
        ON delegation."id" = state."delegation_id"
     WHERE p."id" = p_project
  ), material AS (
    SELECT base.*,
      jsonb_build_object(
        'automationPolicy', base."automation_policy"::text,
        'authorizationRevision', base."config_revision"::text,
        'convergenceThresholds', base."convergence_thresholds",
        'unboundedAuthorizedBy', base."unbounded_authorized_by"
      ) AS risk_material,
      jsonb_build_object(
        'authorizationRevision', base."config_revision"::text,
        'coordinatorEnabled', base."coordinator_enabled",
        'maxConcurrentTasks', base."max_concurrent_tasks"
      ) AS permission_material,
      jsonb_build_object(
        'attemptBudget', base."attempt_budget",
        'authorizationRevision', base."config_revision"::text,
        'sessionBudgetPerDay', base."session_budget_per_day"
      ) AS budget_material,
      jsonb_build_object(
        'coordinatorAgentIds', COALESCE((
          SELECT jsonb_agg(m."agent_id"::text ORDER BY m."agent_id")
            FROM "project_member" m
           WHERE m."project_id" = base."id" AND m."role" = 'COORDINATOR'::"project_role"
        ), '[]'::jsonb),
        'members', COALESCE((
          SELECT jsonb_agg(jsonb_build_object(
            'agentId', m."agent_id"::text,
            'role', m."role"::text
          ) ORDER BY m."agent_id", m."role")
            FROM "project_member" m
           WHERE m."project_id" = base."id"
        ), '[]'::jsonb),
        'ownerId', base."owner_id"::text
      ) AS recipient_material,
      CASE WHEN base."template_id" IS NULL THEN NULL ELSE outcome_sha256_json(jsonb_build_object(
        'authorityDigest', base."template_digest"::text,
        'authorityId', base."template_id"::text,
        'revokedAt', base.template_revoked_at,
        'validThrough', base.template_valid_through
      )) END AS template_state_digest,
      CASE WHEN base."delegation_id" IS NULL THEN NULL ELSE outcome_sha256_json(jsonb_build_object(
        'authorityDigest', base."delegation_digest"::text,
        'authorityId', base."delegation_id"::text,
        'revokedAt', base.delegation_revoked_at,
        'validThrough', base.delegation_valid_through
      )) END AS delegation_state_digest
      FROM base
  ), digested AS (
    SELECT material.*,
      outcome_sha256_json(risk_material) AS risk_digest,
      outcome_sha256_json(permission_material) AS permission_digest,
      outcome_sha256_json(budget_material) AS budget_digest,
      outcome_sha256_json(recipient_material) AS recipient_digest
      FROM material
  ), assembled AS (
    SELECT digested.*,
      jsonb_build_object(
        'budget', budget_material,
        'budgetDigest', budget_digest,
        'criteria', COALESCE((
          SELECT jsonb_agg(jsonb_build_object(
            'semanticHash', d."semantic_hash"::text,
            'text', d."text"
          ) ORDER BY d."semantic_hash", d."text", d."id")
            FROM "project_acceptance_criterion_definition" d
           WHERE d."project_id" = digested."id"
        ), '[]'::jsonb),
        'criteriaTrust', COALESCE((
          SELECT jsonb_agg(jsonb_build_object(
            'completionCriterion', d."completion_criterion"::text,
            'semanticHash', d."semantic_hash"::text
          ) ORDER BY d."semantic_hash", d."completion_criterion", d."id")
            FROM "project_acceptance_criterion_definition" d
           WHERE d."project_id" = digested."id"
        ), '[]'::jsonb),
        -- The reusable template surface above is semantic and contains no per-Project ids. This
        -- separate lane is still part of contractDigest so edit-then-revert, delete/recreate and
        -- identity replacement cannot resurrect an old approval (ABA).
        'criteriaVersions', COALESCE((
          SELECT jsonb_agg(jsonb_build_object(
            'definitionId', d."id"::text,
            'semanticHash', d."semantic_hash"::text,
            'semanticRevision', d."semantic_revision"
          ) ORDER BY d."id")
            FROM "project_acceptance_criterion_definition" d
           WHERE d."project_id" = digested."id"
        ), '[]'::jsonb),
        'delegationDigest', delegation_state_digest,
        'goal', digested."goal",
        'outcomes', COALESCE((
          SELECT jsonb_agg(d."text" ORDER BY d."text", d."completion_criterion", d."id")
            FROM "project_acceptance_criterion_definition" d
           WHERE d."project_id" = digested."id"
        ), '[]'::jsonb),
        'ownerId', digested."owner_id"::text,
        'permissions', permission_material,
        'permissionDigest', permission_digest,
        'recipients', recipient_material,
        'recipientDigest', recipient_digest,
        'riskBoundary', risk_material,
        'templateDigest', template_state_digest
      ) AS semantic_material,
      jsonb_build_object(
        'collectorVersions', '[]'::jsonb,
        'commands', COALESCE((
          SELECT jsonb_agg(jsonb_build_object(
            'acceptanceCommand', d."acceptance_command",
            'definitionId', d."id"::text,
            'expectedExitCode', d."acceptance_expected_exit_code"
          ) ORDER BY d."id")
            FROM "project_acceptance_criterion_definition" d
           WHERE d."project_id" = digested."id"
        ), '[]'::jsonb),
        'environment', jsonb_build_object('instructions', digested."instructions"),
        'evidenceWiring', COALESCE((
          SELECT jsonb_agg(jsonb_build_object(
            'definitionId', d."id"::text,
            'evidenceTaskId', d."evidence_task_id"::text,
            'evaluationPlanHash', d."evaluation_plan_hash"::text,
            'evaluationPlanRevision', d."evaluation_plan_revision"
          ) ORDER BY d."id")
            FROM "project_acceptance_criterion_definition" d
           WHERE d."project_id" = digested."id"
        ), '[]'::jsonb),
        'verifiers', COALESCE((
          SELECT jsonb_agg(jsonb_build_object(
            'completionCriterion', d."completion_criterion"::text,
            'definitionId', d."id"::text,
            'verificationMethod', d."verification_method"
          ) ORDER BY d."id")
            FROM "project_acceptance_criterion_definition" d
           WHERE d."project_id" = digested."id"
        ), '[]'::jsonb)
      ) AS evaluation_plan_material
      FROM digested
  )
  SELECT jsonb_build_object(
    'budgetDigest', budget_digest,
    'contractDigest', outcome_sha256_json(semantic_material),
    'evaluationPlanDigest', outcome_sha256_json(evaluation_plan_material),
    'evaluationPlanMaterial', evaluation_plan_material,
    'permissionDigest', permission_digest,
    'recipientDigest', recipient_digest,
    'riskPolicyDigest', risk_digest,
    'semanticMaterial', semantic_material
  ) INTO result FROM assembled;
  IF result IS NULL THEN
    RAISE EXCEPTION 'PROJECT_NOT_FOUND: project % has no completion contract', p_project
      USING ERRCODE = 'raise_exception';
  END IF;
  RETURN result;
END;
$$ LANGUAGE plpgsql STABLE;

CREATE OR REPLACE FUNCTION project_owner_ratification_effective(p_project UUID, p_contract TEXT)
RETURNS BOOLEAN AS $$
  SELECT EXISTS (
    SELECT 1
      FROM "project_owner_ratification" r
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
   LIMIT 1;
  IF request_id IS NOT NULL THEN RETURN request_id; END IF;

  UPDATE "project_owner_decision_request"
     SET "status" = 'SUPERSEDED'
   WHERE "project_id" = p_project AND "status" = 'PENDING';
  SELECT COALESCE(max("request_generation"), 0) + 1 INTO next_generation
    FROM "project_owner_decision_request" WHERE "project_id" = p_project;
  request_id := gen_random_uuid();
  INSERT INTO "project_owner_decision_request" (
    "id", "project_id", "owner_id", "contract_digest", "request_generation",
    "reason_code", "previous_contract_digest", "semantic_diff", "decision_payload",
    "cta_token", "expires_at"
  ) VALUES (
    request_id, p_project, state."owner_id", state."contract_digest", next_generation,
    p_reason, p_previous_contract, COALESCE(p_semantic_diff, '{}'::jsonb),
    jsonb_build_object(
      'consequenceOfNoAction', 'automatic side-effecting execution remains disabled',
      'contract', state."semantic_material",
      'contractDigest', state."contract_digest"::text,
      'costAndDeadline', jsonb_build_object(
        'budget', state."semantic_material"->'budget',
        'budgetDigest', state."budget_digest"::text,
        'expiresAt', CURRENT_TIMESTAMP + INTERVAL '7 days'
      ),
      'evaluationPlanDigest', state."evaluation_plan_digest"::text,
      'impact', 'approves the goal, risk, permissions, budget, recipient and completion contract',
      'options', jsonb_build_array('APPROVE', 'DENY'),
      'recommended', 'review the semantic diff and approve only this exact contract digest',
      'resumeAfterDecision', 'the reconciler may resume automatically under the ratified envelope',
      'whyNotAgent', 'an agent or runner cannot approve its own goal, authority, risk or budget'
    ),
    gen_random_uuid(), CURRENT_TIMESTAMP + INTERVAL '7 days'
  );
  RETURN request_id;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION project_refresh_completion_contract(
  p_project UUID,
  p_reason TEXT DEFAULT 'PROJECT_CONTRACT_REFRESHED'
) RETURNS JSONB AS $$
DECLARE
  project_owner UUID;
  snapshot JSONB;
  prior "project_completion_contract"%ROWTYPE;
  old_contract TEXT;
  changed_fields JSONB := '[]'::jsonb;
  request_id UUID;
BEGIN
  SELECT "owner_id" INTO project_owner FROM "project"
   WHERE "id" = p_project FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'PROJECT_NOT_FOUND: project % has no completion contract', p_project
      USING ERRCODE = 'raise_exception';
  END IF;

  SELECT * INTO prior FROM "project_completion_contract"
   WHERE "project_id" = p_project FOR UPDATE;
  snapshot := project_completion_contract_snapshot(p_project);
  IF prior."project_id" IS NULL THEN
    INSERT INTO "project_completion_contract" (
      "project_id", "owner_id", "contract_digest", "evaluation_plan_digest",
      "risk_policy_digest", "permission_digest", "budget_digest", "recipient_digest",
      "semantic_material", "evaluation_plan_material", "last_change_reason"
    ) VALUES (
      p_project, project_owner, snapshot->>'contractDigest', snapshot->>'evaluationPlanDigest',
      snapshot->>'riskPolicyDigest', snapshot->>'permissionDigest', snapshot->>'budgetDigest',
      snapshot->>'recipientDigest', snapshot->'semanticMaterial',
      snapshot->'evaluationPlanMaterial', p_reason
    );
    request_id := project_ensure_owner_decision_request(
      p_project, 'OWNER_RATIFICATION_REQUIRED', NULL, jsonb_build_object('initial', true)
    );
  ELSE
    old_contract := prior."contract_digest";
    IF prior."semantic_material" IS DISTINCT FROM snapshot->'semanticMaterial' THEN
      SELECT COALESCE(jsonb_agg(key ORDER BY key), '[]'::jsonb) INTO changed_fields
        FROM jsonb_object_keys(snapshot->'semanticMaterial') key
       WHERE prior."semantic_material"->key IS DISTINCT FROM snapshot->'semanticMaterial'->key;
    END IF;
    UPDATE "project_completion_contract"
       SET "contract_revision" = "contract_revision" + CASE
             WHEN "contract_digest" IS DISTINCT FROM snapshot->>'contractDigest' THEN 1 ELSE 0 END,
           "evaluation_plan_revision" = "evaluation_plan_revision" + CASE
             WHEN "evaluation_plan_digest" IS DISTINCT FROM snapshot->>'evaluationPlanDigest'
             THEN 1 ELSE 0 END,
           "contract_digest" = snapshot->>'contractDigest',
           "evaluation_plan_digest" = snapshot->>'evaluationPlanDigest',
           "risk_policy_digest" = snapshot->>'riskPolicyDigest',
           "permission_digest" = snapshot->>'permissionDigest',
           "budget_digest" = snapshot->>'budgetDigest',
           "recipient_digest" = snapshot->>'recipientDigest',
           "semantic_material" = snapshot->'semanticMaterial',
           "evaluation_plan_material" = snapshot->'evaluationPlanMaterial',
           "last_change_reason" = p_reason,
           "updated_at" = CURRENT_TIMESTAMP
     WHERE "project_id" = p_project;
    IF old_contract IS DISTINCT FROM snapshot->>'contractDigest' THEN
      request_id := project_ensure_owner_decision_request(
        p_project, 'CONTRACT_CHANGED', old_contract,
        jsonb_build_object('changedFields', changed_fields, 'reason', p_reason)
      );
    END IF;
  END IF;
  RETURN (SELECT jsonb_build_object(
    'contractDigest', state."contract_digest"::text,
    'contractRevision', state."contract_revision"::text,
    'decisionRequestId', request_id,
    'evaluationPlanDigest', state."evaluation_plan_digest"::text,
    'evaluationPlanRevision', state."evaluation_plan_revision"::text,
    'ratified', project_owner_ratification_effective(state."project_id", state."contract_digest")
  ) FROM "project_completion_contract" state WHERE state."project_id" = p_project);
END;
$$ LANGUAGE plpgsql;

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
  ratification_id UUID;
  replacement UUID;
BEGIN
  IF p_actor_type <> 'OWNER' OR p_actor_id IS DISTINCT FROM p_owner::text THEN
    RAISE EXCEPTION 'OWNER_RATIFICATION_ACTOR_FORBIDDEN: agents and runners cannot ratify their own contract'
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

  SELECT * INTO existing FROM "project_owner_ratification"
   WHERE "owner_id" = p_owner AND "idempotency_key" = p_idempotency_key;
  IF FOUND THEN
    IF existing."project_id" <> p_project
       OR existing."contract_digest" <> state."contract_digest" THEN
      RAISE EXCEPTION 'OWNER_RATIFICATION_IDEMPOTENCY_COLLISION'
        USING ERRCODE = 'unique_violation';
    END IF;
    RETURN jsonb_build_object(
      'contractDigest', existing."contract_digest"::text,
      'duplicate', true, 'ok', true, 'ratificationId', existing."id"
    );
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
  IF FOUND THEN
    RETURN jsonb_build_object(
      'contractDigest', existing."contract_digest"::text,
      'duplicate', true, 'ok', true, 'ratificationId', existing."id"
    );
  END IF;
  IF request."status" <> 'PENDING' THEN
    RETURN jsonb_build_object('code', 'OWNER_DECISION_ALREADY_SPENT', 'ok', false);
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
    UPDATE "project_owner_decision_request"
       SET "status" = 'DENIED', "decided_at" = CURRENT_TIMESTAMP,
           "decided_by_type" = 'OWNER', "decided_by_id" = p_owner::text
     WHERE "id" = request."id";
    RETURN jsonb_build_object('decision', 'DENY', 'ok', true, 'ratified', false);
  END IF;

  ratification_id := gen_random_uuid();
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
     SET "status" = 'APPROVED', "decided_at" = CURRENT_TIMESTAMP,
         "decided_by_type" = 'OWNER', "decided_by_id" = p_owner::text
   WHERE "id" = request."id";
  RETURN jsonb_build_object(
    'contractDigest', state."contract_digest"::text,
    'duplicate', false, 'evaluationPlanDigest', state."evaluation_plan_digest"::text,
    'ok', true, 'ratificationId', ratification_id,
    'source', CASE WHEN p_atomic_create THEN 'OWNER_ATOMIC_CREATE' ELSE 'OWNER' END
  );
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION project_create_ratification_template(
  p_owner UUID,
  p_spec JSONB
) RETURNS JSONB AS $$
DECLARE
  new_id UUID := gen_random_uuid();
  digest_value TEXT;
BEGIN
  IF jsonb_typeof(p_spec->'contractConstraint') <> 'object'
     OR NOT (p_spec->'contractConstraint' ?& ARRAY[
       'goal', 'outcomes', 'criteria', 'criteriaTrust', 'riskBoundary', 'ownerId'
     ])
     OR jsonb_typeof(p_spec#>'{contractConstraint,goal}') <> 'string'
     OR jsonb_typeof(p_spec#>'{contractConstraint,outcomes}') <> 'array'
     OR jsonb_array_length(p_spec#>'{contractConstraint,outcomes}') = 0
     OR jsonb_typeof(p_spec#>'{contractConstraint,criteria}') <> 'array'
     OR jsonb_array_length(p_spec#>'{contractConstraint,criteria}') = 0
     OR jsonb_typeof(p_spec#>'{contractConstraint,criteriaTrust}') <> 'array'
     OR jsonb_array_length(p_spec#>'{contractConstraint,criteriaTrust}') = 0
     OR jsonb_typeof(p_spec#>'{contractConstraint,riskBoundary}') <> 'object'
     OR jsonb_typeof(p_spec#>'{contractConstraint,ownerId}') <> 'string'
     OR jsonb_array_length(COALESCE(p_spec->'riskPolicyDigests', '[]'::jsonb)) = 0
     OR jsonb_array_length(COALESCE(p_spec->'permissionDigests', '[]'::jsonb)) = 0
     OR jsonb_array_length(COALESCE(p_spec->'budgetDigests', '[]'::jsonb)) = 0
     OR jsonb_array_length(COALESCE(p_spec->'recipientDigests', '[]'::jsonb)) = 0 THEN
    RAISE EXCEPTION 'RATIFICATION_TEMPLATE_UNBOUNDED: semantic and digest bounds are required'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  digest_value := outcome_sha256_json(p_spec - 'name');
  INSERT INTO "project_ratification_template" (
    "id", "owner_id", "name", "contract_constraint", "risk_policy_digests",
    "permission_digests", "budget_digests", "recipient_digests",
    "max_session_budget_per_day", "max_uses", "valid_through", "template_digest"
  ) VALUES (
    new_id, p_owner, p_spec->>'name', p_spec->'contractConstraint',
    ARRAY(SELECT jsonb_array_elements_text(p_spec->'riskPolicyDigests')),
    ARRAY(SELECT jsonb_array_elements_text(p_spec->'permissionDigests')),
    ARRAY(SELECT jsonb_array_elements_text(p_spec->'budgetDigests')),
    ARRAY(SELECT jsonb_array_elements_text(p_spec->'recipientDigests')),
    (p_spec->>'maxSessionBudgetPerDay')::integer, (p_spec->>'maxUses')::integer,
    (p_spec->>'validThrough')::timestamptz, digest_value
  );
  RETURN jsonb_build_object('id', new_id, 'templateDigest', digest_value);
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION project_create_ratification_delegation(
  p_owner UUID,
  p_spec JSONB
) RETURNS JSONB AS $$
DECLARE
  new_id UUID := gen_random_uuid();
  digest_value TEXT;
BEGIN
  IF p_spec->>'delegateType' NOT IN ('AGENT','RUNNER','SERVICE')
     OR NULLIF(btrim(p_spec->>'delegateId'), '') IS NULL
     OR jsonb_typeof(p_spec->'contractConstraint') <> 'object'
     OR NOT (p_spec->'contractConstraint' ?& ARRAY[
       'goal', 'outcomes', 'criteria', 'criteriaTrust', 'riskBoundary', 'ownerId'
     ])
     OR jsonb_typeof(p_spec#>'{contractConstraint,goal}') <> 'string'
     OR jsonb_typeof(p_spec#>'{contractConstraint,outcomes}') <> 'array'
     OR jsonb_array_length(p_spec#>'{contractConstraint,outcomes}') = 0
     OR jsonb_typeof(p_spec#>'{contractConstraint,criteria}') <> 'array'
     OR jsonb_array_length(p_spec#>'{contractConstraint,criteria}') = 0
     OR jsonb_typeof(p_spec#>'{contractConstraint,criteriaTrust}') <> 'array'
     OR jsonb_array_length(p_spec#>'{contractConstraint,criteriaTrust}') = 0
     OR jsonb_typeof(p_spec#>'{contractConstraint,riskBoundary}') <> 'object'
     OR jsonb_typeof(p_spec#>'{contractConstraint,ownerId}') <> 'string'
     OR jsonb_array_length(COALESCE(p_spec->'riskPolicyDigests', '[]'::jsonb)) = 0
     OR jsonb_array_length(COALESCE(p_spec->'permissionDigests', '[]'::jsonb)) = 0
     OR jsonb_array_length(COALESCE(p_spec->'budgetDigests', '[]'::jsonb)) = 0
     OR jsonb_array_length(COALESCE(p_spec->'recipientDigests', '[]'::jsonb)) = 0 THEN
    RAISE EXCEPTION 'RATIFICATION_DELEGATION_UNBOUNDED: principal, semantic and digest bounds are required'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  digest_value := outcome_sha256_json(p_spec - 'name');
  INSERT INTO "project_ratification_delegation" (
    "id", "owner_id", "delegate_type", "delegate_id", "project_id",
    "contract_constraint", "risk_policy_digests", "permission_digests",
    "budget_digests", "recipient_digests", "max_session_budget_per_day", "max_uses",
    "valid_through", "delegation_digest"
  ) VALUES (
    new_id, p_owner, p_spec->>'delegateType', p_spec->>'delegateId',
    NULLIF(p_spec->>'projectId', '')::uuid, p_spec->'contractConstraint',
    ARRAY(SELECT jsonb_array_elements_text(p_spec->'riskPolicyDigests')),
    ARRAY(SELECT jsonb_array_elements_text(p_spec->'permissionDigests')),
    ARRAY(SELECT jsonb_array_elements_text(p_spec->'budgetDigests')),
    ARRAY(SELECT jsonb_array_elements_text(p_spec->'recipientDigests')),
    (p_spec->>'maxSessionBudgetPerDay')::integer, (p_spec->>'maxUses')::integer,
    (p_spec->>'validThrough')::timestamptz, digest_value
  );
  RETURN jsonb_build_object('delegationDigest', digest_value, 'id', new_id);
END;
$$ LANGUAGE plpgsql;

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
  state "project_completion_contract"%ROWTYPE;
  old_contract TEXT;
  template "project_ratification_template"%ROWTYPE;
  delegation "project_ratification_delegation"%ROWTYPE;
  authority_digest TEXT;
  source_value TEXT;
  valid_through_value TIMESTAMPTZ;
  request_id UUID;
  ratification_id UUID;
  existing "project_owner_ratification"%ROWTYPE;
  current_budget INTEGER;
BEGIN
  IF p_actor_type NOT IN ('AGENT','RUNNER','SERVICE') THEN
    RAISE EXCEPTION 'PREAPPROVAL_ACTOR_INVALID' USING ERRCODE = 'insufficient_privilege';
  END IF;
  PERFORM 1 FROM "project" WHERE "id" = p_project AND "owner_id" = p_owner
    FOR NO KEY UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'PROJECT_NOT_FOUND' USING ERRCODE = 'raise_exception'; END IF;
  PERFORM project_refresh_completion_contract(p_project, 'PREAPPROVAL_RECHECK');
  SELECT * INTO state FROM "project_completion_contract"
   WHERE "project_id" = p_project FOR UPDATE;
  old_contract := state."contract_digest";
  IF p_expected_contract IS NOT NULL AND p_expected_contract <> old_contract THEN
    RETURN jsonb_build_object('code', 'OWNER_DECISION_STALE', 'ok', false,
      'currentContractDigest', old_contract);
  END IF;
  SELECT "session_budget_per_day" INTO current_budget FROM "project" WHERE "id" = p_project;

  IF p_authority_kind = 'PREAPPROVED_TEMPLATE' THEN
    SELECT * INTO template FROM "project_ratification_template"
     WHERE "id" = p_authority_id AND "owner_id" = p_owner FOR UPDATE;
    IF template."id" IS NULL OR template."revoked_at" IS NOT NULL
       OR CURRENT_TIMESTAMP NOT BETWEEN template."valid_from" AND template."valid_through"
       OR template."use_count" >= template."max_uses" THEN
      RETURN jsonb_build_object('code', 'RATIFICATION_TEMPLATE_UNAVAILABLE', 'ok', false);
    END IF;
    IF NOT state."semantic_material" @> template."contract_constraint"
       OR state."semantic_material"->'goal' IS DISTINCT FROM template."contract_constraint"->'goal'
       OR state."semantic_material"->'outcomes' IS DISTINCT FROM template."contract_constraint"->'outcomes'
       OR state."semantic_material"->'criteria' IS DISTINCT FROM template."contract_constraint"->'criteria'
       OR state."semantic_material"->'criteriaTrust' IS DISTINCT FROM template."contract_constraint"->'criteriaTrust'
       OR state."semantic_material"->'riskBoundary' IS DISTINCT FROM template."contract_constraint"->'riskBoundary'
       OR state."semantic_material"->'ownerId' IS DISTINCT FROM template."contract_constraint"->'ownerId'
       OR NOT state."risk_policy_digest" = ANY(template."risk_policy_digests")
       OR NOT state."permission_digest" = ANY(template."permission_digests")
       OR NOT state."budget_digest" = ANY(template."budget_digests")
       OR NOT state."recipient_digest" = ANY(template."recipient_digests")
       OR current_budget IS NULL OR current_budget > template."max_session_budget_per_day" THEN
      RETURN jsonb_build_object('code', 'RATIFICATION_TEMPLATE_OUT_OF_BOUNDS', 'ok', false);
    END IF;
    UPDATE "project_completion_contract" SET "template_id" = template."id", "delegation_id" = NULL
     WHERE "project_id" = p_project;
    authority_digest := template."template_digest";
    valid_through_value := template."valid_through";
    source_value := 'PREAPPROVED_TEMPLATE';
  ELSIF p_authority_kind = 'BOUND_DELEGATION' THEN
    SELECT * INTO delegation FROM "project_ratification_delegation"
     WHERE "id" = p_authority_id AND "owner_id" = p_owner FOR UPDATE;
    IF delegation."id" IS NULL OR delegation."revoked_at" IS NOT NULL
       OR CURRENT_TIMESTAMP NOT BETWEEN delegation."valid_from" AND delegation."valid_through"
       OR delegation."use_count" >= delegation."max_uses"
       OR delegation."delegate_type" <> p_actor_type
       OR delegation."delegate_id" <> p_actor_id
       OR (delegation."project_id" IS NOT NULL AND delegation."project_id" <> p_project) THEN
      RETURN jsonb_build_object('code', 'RATIFICATION_DELEGATION_UNAVAILABLE', 'ok', false);
    END IF;
    IF NOT state."semantic_material" @> delegation."contract_constraint"
       OR state."semantic_material"->'goal' IS DISTINCT FROM delegation."contract_constraint"->'goal'
       OR state."semantic_material"->'outcomes' IS DISTINCT FROM delegation."contract_constraint"->'outcomes'
       OR state."semantic_material"->'criteria' IS DISTINCT FROM delegation."contract_constraint"->'criteria'
       OR state."semantic_material"->'criteriaTrust' IS DISTINCT FROM delegation."contract_constraint"->'criteriaTrust'
       OR state."semantic_material"->'riskBoundary' IS DISTINCT FROM delegation."contract_constraint"->'riskBoundary'
       OR state."semantic_material"->'ownerId' IS DISTINCT FROM delegation."contract_constraint"->'ownerId'
       OR NOT state."risk_policy_digest" = ANY(delegation."risk_policy_digests")
       OR NOT state."permission_digest" = ANY(delegation."permission_digests")
       OR NOT state."budget_digest" = ANY(delegation."budget_digests")
       OR NOT state."recipient_digest" = ANY(delegation."recipient_digests")
       OR current_budget IS NULL OR current_budget > delegation."max_session_budget_per_day" THEN
      RETURN jsonb_build_object('code', 'RATIFICATION_DELEGATION_OUT_OF_BOUNDS', 'ok', false);
    END IF;
    UPDATE "project_completion_contract" SET "delegation_id" = delegation."id", "template_id" = NULL
     WHERE "project_id" = p_project;
    authority_digest := delegation."delegation_digest";
    valid_through_value := delegation."valid_through";
    source_value := 'BOUND_DELEGATION';
  ELSE
    RAISE EXCEPTION 'PREAPPROVAL_KIND_INVALID' USING ERRCODE = 'invalid_parameter_value';
  END IF;

  PERFORM project_refresh_completion_contract(p_project, source_value || '_SELECTED');
  SELECT * INTO state FROM "project_completion_contract"
   WHERE "project_id" = p_project FOR UPDATE;
  SELECT * INTO existing FROM "project_owner_ratification"
   WHERE "owner_id" = p_owner AND "idempotency_key" = p_idempotency_key;
  IF FOUND THEN
    IF existing."project_id" <> p_project OR existing."contract_digest" <> state."contract_digest" THEN
      RAISE EXCEPTION 'OWNER_RATIFICATION_IDEMPOTENCY_COLLISION' USING ERRCODE = 'unique_violation';
    END IF;
    RETURN jsonb_build_object('contractDigest', existing."contract_digest"::text,
      'duplicate', true, 'ok', true, 'ratificationId', existing."id");
  END IF;
  request_id := project_ensure_owner_decision_request(
    p_project, source_value || '_AVAILABLE', old_contract,
    jsonb_build_object('authorityId', p_authority_id)
  );
  ratification_id := gen_random_uuid();
  INSERT INTO "project_owner_ratification" (
    "id", "project_id", "owner_id", "contract_digest",
    "evaluation_plan_digest_at_decision", "source", "ratified_by_type",
    "ratified_by_id", "authority_id", "authority_digest", "decision_request_id",
    "idempotency_key", "valid_through"
  ) VALUES (
    ratification_id, p_project, p_owner, state."contract_digest",
    state."evaluation_plan_digest", source_value, p_actor_type, p_actor_id,
    p_authority_id, authority_digest, request_id, p_idempotency_key, valid_through_value
  );
  IF request_id IS NOT NULL THEN
    UPDATE "project_owner_decision_request"
       SET "status" = 'APPROVED', "decided_at" = CURRENT_TIMESTAMP,
           "decided_by_type" = source_value, "decided_by_id" = p_actor_id
     WHERE "id" = request_id;
  END IF;
  IF source_value = 'PREAPPROVED_TEMPLATE' THEN
    UPDATE "project_ratification_template" SET "use_count" = "use_count" + 1
     WHERE "id" = p_authority_id;
  ELSE
    UPDATE "project_ratification_delegation" SET "use_count" = "use_count" + 1
     WHERE "id" = p_authority_id;
  END IF;
  RETURN jsonb_build_object(
    'authorityDigest', authority_digest, 'contractDigest', state."contract_digest"::text,
    'duplicate', false, 'ok', true, 'ratificationId', ratification_id, 'source', source_value
  );
END;
$$ LANGUAGE plpgsql;

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
  state "project_completion_contract"%ROWTYPE;
  existing "project_ratified_action_intent"%ROWTYPE;
  action_digest_value TEXT := outcome_sha256_json(p_action);
  effect_value TEXT := p_action->>'effectClass';
  charge_value INTEGER;
  intent_id UUID;
  token_value UUID;
  ratified BOOLEAN;
  request_id UUID;
BEGIN
  IF p_trigger_kind NOT IN ('AUTO','MANUAL') OR p_principal_type NOT IN
    ('SYSTEM','AGENT','RUNNER','OWNER','SERVICE') THEN
    RAISE EXCEPTION 'RATIFIED_ACTION_CONTEXT_INVALID' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF effect_value IS NULL OR jsonb_typeof(p_action->'budgetCharge') <> 'number' THEN
    RAISE EXCEPTION 'RATIFIED_ACTION_ENVELOPE_INCOMPLETE' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  charge_value := (p_action->>'budgetCharge')::integer;
  IF charge_value < 0 THEN RAISE EXCEPTION 'RATIFIED_ACTION_BUDGET_INVALID'; END IF;

  PERFORM 1 FROM "project" WHERE "id" = p_project AND "owner_id" = p_owner
    FOR NO KEY UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'PROJECT_NOT_FOUND' USING ERRCODE = 'raise_exception'; END IF;
  PERFORM project_refresh_completion_contract(p_project, 'ACTION_INTENT_RECHECK');
  SELECT * INTO state FROM "project_completion_contract"
   WHERE "project_id" = p_project FOR UPDATE;

  SELECT * INTO existing FROM "project_ratified_action_intent"
   WHERE "owner_id" = p_owner AND "project_id" = p_project
     AND "idempotency_key" = p_idempotency_key;
  IF FOUND THEN
    IF existing."action_digest" <> action_digest_value THEN
      RAISE EXCEPTION 'RATIFIED_ACTION_IDEMPOTENCY_COLLISION' USING ERRCODE = 'unique_violation';
    END IF;
    RETURN jsonb_build_object('commitToken', existing."commit_token", 'duplicate', true,
      'intentId', existing."id", 'ok', true);
  END IF;

  IF p_action->>'contractDigest' IS DISTINCT FROM state."contract_digest"::text
     OR p_action->>'evaluationPlanDigest' IS DISTINCT FROM state."evaluation_plan_digest"::text
     OR p_action->>'riskPolicyDigest' IS DISTINCT FROM state."risk_policy_digest"::text
     OR p_action->>'permissionDigest' IS DISTINCT FROM state."permission_digest"::text
     OR p_action->>'budgetDigest' IS DISTINCT FROM state."budget_digest"::text
     OR p_action->>'recipientDigest' IS DISTINCT FROM state."recipient_digest"::text THEN
    RETURN jsonb_build_object('code', 'RATIFIED_ACTION_BINDING_STALE', 'ok', false);
  END IF;
  ratified := project_owner_ratification_effective(p_project, state."contract_digest");
  IF (p_trigger_kind = 'AUTO' OR effect_value NOT IN
      ('READ_ONLY_ANALYSIS','PLANNING','DISCARDABLE_EXPLORATION')) AND NOT ratified THEN
    request_id := project_ensure_owner_decision_request(
      p_project, 'OWNER_RATIFICATION_REQUIRED', state."contract_digest", '{}'::jsonb
    );
    RETURN jsonb_build_object(
      'code', 'OWNER_RATIFICATION_REQUIRED', 'decisionRequestId', request_id, 'ok', false,
      'requiredAction', 'obtain owner ratification for the exact current contract digest'
    );
  END IF;

  intent_id := gen_random_uuid();
  token_value := gen_random_uuid();
  INSERT INTO "project_ratified_action_intent" (
    "id", "project_id", "owner_id", "principal_type", "principal_id", "trigger_kind",
    "effect_class", "contract_digest", "evaluation_plan_digest", "risk_policy_digest",
    "permission_digest", "budget_digest", "recipient_digest", "budget_charge", "action",
    "action_digest", "idempotency_key", "commit_token"
  ) VALUES (
    intent_id, p_project, p_owner, p_principal_type, p_principal_id, p_trigger_kind,
    effect_value, state."contract_digest", state."evaluation_plan_digest",
    state."risk_policy_digest", state."permission_digest", state."budget_digest",
    state."recipient_digest", charge_value, p_action, action_digest_value,
    p_idempotency_key, token_value
  );
  RETURN jsonb_build_object('commitToken', token_value, 'duplicate', false,
    'intentId', intent_id, 'ok', true);
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION project_commit_ratified_action(
  p_owner UUID,
  p_project UUID,
  p_intent UUID,
  p_commit_token UUID
) RETURNS JSONB AS $$
DECLARE
  intent "project_ratified_action_intent"%ROWTYPE;
  state "project_completion_contract"%ROWTYPE;
  existing "project_ratified_action_commit"%ROWTYPE;
  budget_limit INTEGER;
  spent BIGINT;
  ratified BOOLEAN;
BEGIN
  SELECT * INTO intent FROM "project_ratified_action_intent"
   WHERE "id" = p_intent AND "project_id" = p_project AND "owner_id" = p_owner;
  IF NOT FOUND OR intent."commit_token" IS DISTINCT FROM p_commit_token THEN
    RETURN jsonb_build_object('code', 'RATIFIED_ACTION_TOKEN_INVALID', 'ok', false);
  END IF;
  SELECT * INTO existing FROM "project_ratified_action_commit" WHERE "intent_id" = p_intent;
  IF FOUND THEN RETURN jsonb_build_object('duplicate', true, 'intentId', p_intent, 'ok', true); END IF;

  SELECT "session_budget_per_day" INTO budget_limit FROM "project"
   WHERE "id" = p_project AND "owner_id" = p_owner FOR NO KEY UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('code', 'PROJECT_NOT_FOUND', 'ok', false); END IF;
  PERFORM project_refresh_completion_contract(p_project, 'ACTION_COMMIT_RECHECK');
  SELECT * INTO state FROM "project_completion_contract"
   WHERE "project_id" = p_project FOR UPDATE;
  IF intent."contract_digest" <> state."contract_digest"
     OR intent."evaluation_plan_digest" <> state."evaluation_plan_digest"
     OR intent."risk_policy_digest" <> state."risk_policy_digest"
     OR intent."permission_digest" <> state."permission_digest"
     OR intent."budget_digest" <> state."budget_digest"
     OR intent."recipient_digest" <> state."recipient_digest" THEN
    RETURN jsonb_build_object('code', 'RATIFIED_ACTION_BINDING_STALE', 'ok', false);
  END IF;
  ratified := project_owner_ratification_effective(p_project, state."contract_digest");
  IF (intent."trigger_kind" = 'AUTO' OR intent."effect_class" NOT IN
      ('READ_ONLY_ANALYSIS','PLANNING','DISCARDABLE_EXPLORATION')) AND NOT ratified THEN
    RETURN jsonb_build_object('code', 'OWNER_RATIFICATION_REQUIRED', 'ok', false);
  END IF;
  SELECT COALESCE(sum(c."budget_charge"), 0) INTO spent
    FROM "project_ratified_action_commit" c
   WHERE c."project_id" = p_project AND c."contract_digest" = state."contract_digest"
     AND c."committed_at" > CURRENT_TIMESTAMP - INTERVAL '24 hours';
  IF budget_limit IS NOT NULL AND spent + intent."budget_charge" > budget_limit THEN
    RETURN jsonb_build_object('code', 'RATIFIED_ACTION_BUDGET_EXHAUSTED', 'ok', false);
  END IF;
  INSERT INTO "project_ratified_action_commit" (
    "intent_id", "project_id", "owner_id", "contract_digest", "budget_charge"
  ) VALUES (p_intent, p_project, p_owner, state."contract_digest", intent."budget_charge");
  RETURN jsonb_build_object('contractDigest', state."contract_digest"::text,
    'duplicate', false, 'intentId', p_intent, 'ok', true);
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION project_owner_ratification_state_json(p_owner UUID, p_project UUID)
RETURNS JSONB AS $$
DECLARE
  state "project_completion_contract"%ROWTYPE;
  request "project_owner_decision_request"%ROWTYPE;
  ratification "project_owner_ratification"%ROWTYPE;
  effective BOOLEAN;
BEGIN
  PERFORM 1 FROM "project" WHERE "id" = p_project AND "owner_id" = p_owner;
  IF NOT FOUND THEN RAISE EXCEPTION 'PROJECT_NOT_FOUND' USING ERRCODE = 'raise_exception'; END IF;
  PERFORM project_refresh_completion_contract(p_project, 'RATIFICATION_STATE_READ');
  SELECT * INTO state FROM "project_completion_contract" WHERE "project_id" = p_project;
  effective := project_owner_ratification_effective(p_project, state."contract_digest");
  IF NOT effective THEN
    PERFORM project_ensure_owner_decision_request(
      p_project, 'OWNER_RATIFICATION_REQUIRED', state."contract_digest", '{}'::jsonb
    );
  END IF;
  SELECT * INTO request FROM "project_owner_decision_request"
   WHERE "project_id" = p_project AND "status" = 'PENDING'
   ORDER BY "request_generation" DESC LIMIT 1;
  SELECT * INTO ratification FROM "project_owner_ratification"
   WHERE "project_id" = p_project AND "contract_digest" = state."contract_digest"
   ORDER BY "ratified_at" DESC LIMIT 1;
  RETURN jsonb_build_object(
    'budgetDigest', state."budget_digest"::text,
    'contractDigest', state."contract_digest"::text,
    'contractRevision', state."contract_revision"::text,
    'decisionRequest', CASE WHEN request."id" IS NULL THEN NULL ELSE jsonb_build_object(
      'contractDigest', request."contract_digest"::text,
      'ctaToken', request."cta_token",
      'expiresAt', request."expires_at",
      'id', request."id",
      'payload', request."decision_payload",
      'reasonCode', request."reason_code",
      'requestGeneration', request."request_generation"::text,
      'semanticDiff', request."semantic_diff",
      'status', request."status"
    ) END,
    'evaluationPlanDigest', state."evaluation_plan_digest"::text,
    'evaluationPlanRevision', state."evaluation_plan_revision"::text,
    'evaluationPlan', state."evaluation_plan_material",
    'permissionDigest', state."permission_digest"::text,
    'ratification', CASE WHEN ratification."id" IS NULL THEN NULL ELSE jsonb_build_object(
      'contractDigest', ratification."contract_digest"::text,
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

-- Project and criterion changes refresh under the same Project row lock.  The acceptance trigger
-- sorts before this one and has already synchronized legacy criteria by the time this trigger
-- reads them.  Definition triggers are deferred so a whole-collection replacement produces one
-- final contract, not a visible sequence of half-replaced contracts.
CREATE OR REPLACE FUNCTION project_completion_contract_project_trigger() RETURNS TRIGGER AS $$
BEGIN
  PERFORM project_refresh_completion_contract(NEW."id", 'PROJECT_FIELDS_CHANGED');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER zz_project_completion_contract_project
  AFTER INSERT OR UPDATE OF
    "goal", "instructions", "coordinator_enabled", "automation_policy", "max_concurrent_tasks",
    "session_budget_per_day", "config_revision", "convergence_thresholds", "attempt_budget",
    "unbounded_authorized_by"
  ON "project" FOR EACH ROW EXECUTE FUNCTION project_completion_contract_project_trigger();

CREATE OR REPLACE FUNCTION project_completion_contract_definition_trigger() RETURNS TRIGGER AS $$
DECLARE
  project_value UUID := CASE WHEN TG_OP = 'DELETE' THEN OLD."project_id" ELSE NEW."project_id" END;
BEGIN
  -- A Project delete cascades its definitions and contract together. The deferred child trigger
  -- runs after the parent is gone; that is lifecycle cleanup, not a semantic edit to refresh.
  IF NOT EXISTS (SELECT 1 FROM "project" WHERE "id" = project_value) THEN RETURN NULL; END IF;
  PERFORM project_refresh_completion_contract(
    project_value,
    'ACCEPTANCE_DEFINITION_CHANGED'
  );
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER zz_project_completion_contract_definition
  AFTER INSERT OR UPDATE OR DELETE ON "project_acceptance_criterion_definition"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  EXECUTE FUNCTION project_completion_contract_definition_trigger();

-- Recipient changes serialize Project -> membership and refresh at commit.  That is the same lock
-- order action commit takes, so reassignment versus commit is one ordering or the other, never a
-- stale interleaving.
CREATE OR REPLACE FUNCTION project_member_ratification_project_lock() RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND OLD."project_id" IS DISTINCT FROM NEW."project_id" THEN
    PERFORM 1 FROM "project"
     WHERE "id" = ANY(ARRAY[OLD."project_id", NEW."project_id"])
     ORDER BY "id" FOR NO KEY UPDATE;
  ELSE
    PERFORM 1 FROM "project" WHERE "id" = CASE WHEN TG_OP = 'DELETE'
      THEN OLD."project_id" ELSE NEW."project_id" END FOR NO KEY UPDATE;
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER project_member_ratification_project_lock
  BEFORE INSERT OR UPDATE OR DELETE ON "project_member"
  FOR EACH ROW EXECUTE FUNCTION project_member_ratification_project_lock();

CREATE OR REPLACE FUNCTION project_completion_contract_member_trigger() RETURNS TRIGGER AS $$
DECLARE
  project_value UUID := CASE WHEN TG_OP = 'DELETE' THEN OLD."project_id" ELSE NEW."project_id" END;
BEGIN
  IF TG_OP = 'UPDATE' AND OLD."project_id" IS DISTINCT FROM NEW."project_id" THEN
    FOR project_value IN
      SELECT value FROM unnest(ARRAY[OLD."project_id", NEW."project_id"]) value ORDER BY value
    LOOP
      IF EXISTS (SELECT 1 FROM "project" WHERE "id" = project_value) THEN
        PERFORM project_refresh_completion_contract(project_value, 'RECIPIENT_CHANGED');
      END IF;
    END LOOP;
    RETURN NULL;
  END IF;
  -- As with definition cleanup above, a cascading Project delete has no new contract to publish.
  IF NOT EXISTS (SELECT 1 FROM "project" WHERE "id" = project_value) THEN RETURN NULL; END IF;
  PERFORM project_refresh_completion_contract(
    project_value,
    'RECIPIENT_CHANGED'
  );
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER zz_project_completion_contract_member
  AFTER INSERT OR UPDATE OR DELETE ON "project_member"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  EXECUTE FUNCTION project_completion_contract_member_trigger();

CREATE OR REPLACE FUNCTION project_ratification_authority_changed() RETURNS TRIGGER AS $$
DECLARE
  project_row RECORD;
BEGIN
  IF NEW."revoked_at" IS NOT DISTINCT FROM OLD."revoked_at" THEN RETURN NEW; END IF;
  IF TG_TABLE_NAME = 'project_ratification_template' THEN
    FOR project_row IN SELECT "project_id" FROM "project_completion_contract"
      WHERE "template_id" = NEW."id" ORDER BY "project_id"
    LOOP PERFORM project_refresh_completion_contract(project_row."project_id", 'TEMPLATE_AUTHORITY_CHANGED'); END LOOP;
  ELSE
    FOR project_row IN SELECT "project_id" FROM "project_completion_contract"
      WHERE "delegation_id" = NEW."id" ORDER BY "project_id"
    LOOP PERFORM project_refresh_completion_contract(project_row."project_id", 'DELEGATION_AUTHORITY_CHANGED'); END LOOP;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER project_ratification_template_changed
  AFTER UPDATE OF "revoked_at" ON "project_ratification_template"
  FOR EACH ROW EXECUTE FUNCTION project_ratification_authority_changed();
CREATE TRIGGER project_ratification_delegation_changed
  AFTER UPDATE OF "revoked_at" ON "project_ratification_delegation"
  FOR EACH ROW EXECUTE FUNCTION project_ratification_authority_changed();

-- Backfill every project as an UNRATIFIED contract.  Old criteria confirmations are retained as
-- historical audit but are intentionally not promoted: runner-attributed confirmation was never
-- owner approval of risk, permission, budget and recipient.
SELECT project_refresh_completion_contract("id", 'OWNER_RATIFICATION_MIGRATION') FROM "project"
 ORDER BY "id";

-- The database's final DONE wall now asks for owner ratification, not a standard-set checklist.
CREATE OR REPLACE FUNCTION project_acceptance_done_gate() RETURNS TRIGGER AS $$
DECLARE
  run             "project_acceptance_run"%ROWTYPE;
  criterion_count INTEGER;
  unmet_criteria  TEXT;
  open_blocker    INTEGER;
  open_defect     INTEGER;
  contract_digest_value TEXT;
BEGIN
  IF NEW."status" <> 'DONE' OR OLD."status" = 'DONE' THEN RETURN NEW; END IF;
  IF NEW."accepted_run_id" IS NULL THEN
    IF NEW."legacy_accepted_at" IS NOT NULL AND NEW."acceptance_epoch" = 0 THEN RETURN NEW; END IF;
    RAISE EXCEPTION 'ACCEPTANCE_MISSING: project % has no current evidence version', NEW."id"
      USING ERRCODE = 'raise_exception';
  END IF;
  SELECT * INTO run FROM "project_acceptance_run" WHERE "id" = NEW."accepted_run_id";
  IF NOT FOUND OR run."project_id" <> NEW."id" OR run."superseded_at" IS NOT NULL THEN
    RAISE EXCEPTION 'ACCEPTANCE_MISSING: evidence version is not current for project %', NEW."id"
      USING ERRCODE = 'raise_exception';
  END IF;
  SELECT count(*) INTO criterion_count FROM "project_acceptance_criterion_definition"
   WHERE "project_id" = NEW."id";
  IF criterion_count = 0 THEN
    RAISE EXCEPTION 'ACCEPTANCE_MISSING: project % states no acceptance criteria', NEW."id"
      USING ERRCODE = 'raise_exception';
  END IF;
  SELECT "contract_digest" INTO contract_digest_value FROM "project_completion_contract"
   WHERE "project_id" = NEW."id";
  IF contract_digest_value IS NULL
     OR NOT project_owner_ratification_effective(NEW."id", contract_digest_value) THEN
    RAISE EXCEPTION 'OWNER_RATIFICATION_REQUIRED: project % contract digest % is not ratified',
      NEW."id", contract_digest_value USING ERRCODE = 'raise_exception';
  END IF;
  SELECT string_agg(format('#%s %L (%s)', s.ordinal, s.criterion_text,
           COALESCE(s.verdict::text, 'UNDECIDED')), '; ' ORDER BY s.ordinal)
    INTO unmet_criteria FROM project_acceptance_standing(NEW."id", run."attempt") s
   WHERE s.verdict IS DISTINCT FROM 'PASS'::"project_acceptance_verdict";
  IF unmet_criteria IS NOT NULL THEN
    RAISE EXCEPTION 'ACCEPTANCE_MISSING: current acceptance criteria are non-PASS: %', unmet_criteria
      USING ERRCODE = 'raise_exception';
  END IF;
  SELECT count(*) INTO open_blocker FROM "project_blocker"
   WHERE "project_id" = NEW."id" AND "resolved_at" IS NULL;
  IF open_blocker > 0 THEN
    RAISE EXCEPTION 'ACCEPTANCE_BLOCKED: project % has % open blocker(s)', NEW."id", open_blocker
      USING ERRCODE = 'raise_exception';
  END IF;
  SELECT count(*) INTO open_defect
    FROM "task_verification_failure" f
    JOIN "task" verifier ON verifier."id" = f."verifier_task_id"
    JOIN "task" subject ON subject."id" = f."subject_task_id"
   WHERE f."project_id" = NEW."id" AND f."resolved_at" IS NULL
     AND verifier."terminal_reason" IS NULL AND verifier."superseded_by_task_id" IS NULL
     AND subject."terminal_reason" IS NULL AND subject."superseded_by_task_id" IS NULL;
  IF open_defect > 0 THEN
    RAISE EXCEPTION 'ACCEPTANCE_BLOCKED: project % has % unresolved verification failure(s)',
      NEW."id", open_defect USING ERRCODE = 'raise_exception';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION project_acceptance_done_gate() IS
  'Allows automatic DONE only for the exact current owner-ratified completion contract and PASS evidence.';

-- No automatic task execution may become the first side-effecting link of an unratified project.
-- Manual USER runs remain explicit action requests; every automatic origin fails at the durable
-- Session insert even if a stale scheduler forgot to prefilter it.
CREATE OR REPLACE FUNCTION session_owner_ratification_guard() RETURNS TRIGGER AS $$
DECLARE
  project_value UUID;
  contract_value TEXT;
BEGIN
  IF NEW."task_id" IS NULL OR NEW."dispatch_origin" = 'USER'::"session_dispatch_origin" THEN
    RETURN NEW;
  END IF;
  -- Serialize the effect boundary with Project policy writes. A plain snapshot read here permits
  -- an uncommitted revoke and an automatic Session to both commit from the old digest. Taking the
  -- same row lock as refresh/action-commit yields exactly two safe orders: action-before-revoke,
  -- or revoke-before-action with this insert refused.
  SELECT p."id" INTO project_value
    FROM "task" t
    JOIN "project" p ON p."id" = t."project_id"
   WHERE t."id" = NEW."task_id"
   FOR NO KEY UPDATE OF p;
  IF project_value IS NULL THEN RETURN NEW; END IF;
  SELECT c."contract_digest" INTO contract_value FROM "project_completion_contract" c
   WHERE c."project_id" = project_value;
  IF contract_value IS NULL
     OR NOT project_owner_ratification_effective(project_value, contract_value) THEN
    RAISE EXCEPTION
      'OWNER_RATIFICATION_REQUIRED: automatic execution for project % has no effective ratification',
      project_value USING ERRCODE = 'raise_exception';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER session_owner_ratification_guard
  BEFORE INSERT ON "session" FOR EACH ROW EXECUTE FUNCTION session_owner_ratification_guard();

COMMIT;
