-- A typed, current-plan executable attempt is now collected directly for a wired Project
-- criterion. Bind that collector implementation into the evaluation plan instead of continuing
-- to publish collectorVersions=[] for a plan that does have a mechanical collector.
--
-- Existing project_completion_contract rows are deliberately not rewritten here. Deployment must
-- refresh the scoped affected contracts and replay acceptance reconciliation from their immutable
-- attempts; doing that as an unbounded migration would hide rollout scope and invalidate owner
-- decisions without an operator-visible backfill receipt.

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
        'collectorVersions', CASE WHEN EXISTS (
          SELECT 1
            FROM "project_acceptance_criterion_definition" d
           WHERE d."project_id" = digested."id"
             AND d."completion_criterion" = 'EXECUTABLE'::"task_completion_criterion"
             AND d."acceptance_command" IS NOT NULL
             AND d."acceptance_expected_exit_code" IS NOT NULL
             AND d."evidence_task_id" IS NOT NULL
        ) THEN jsonb_build_array('project-acceptance-executable-attempt-v1')
          ELSE '[]'::jsonb END,
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
