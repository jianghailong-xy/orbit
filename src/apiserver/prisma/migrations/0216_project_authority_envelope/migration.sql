-- contractDigest used to bind two different kinds of thing at once: the owner's irreducible
-- judgement (goal, criteria, recipients, delegated authority) and the operating parameters the
-- agent moves while it works (concurrency, budgets, thresholds). Raising maxConcurrentTasks from 3
-- to 4 therefore advanced the digest, voided the ratification and asked the owner a question they
-- had already answered. That is an adjudicative interruption wearing an authorization's clothes.
--
-- The cut this migration makes is NOT "operational versus semantic". It is AUTHORITY MONOTONICITY:
-- can this field be used to widen the agent's own authority? Under that test the material splits
-- into a partial order of permissiveness, and the digest binds the LEAST UPPER BOUND of what the
-- owner last approved and what the project currently says:
--
--   * a larger limit is more permissive than a smaller one, and unbounded (JSON null) is the top;
--   * AUTO is more permissive than GUARDED_AUTO, which is more permissive than MANUAL;
--   * an enabled coordinator is more permissive than a disabled one.
--
-- Moving DOWN that order leaves the bound unchanged, so tightening is free and staying under an
-- approved ceiling is free. Moving UP raises the bound, which advances the digest and reaches the
-- owner exactly as before. Everything the owner cannot delegate — goal, criteria, criteriaVersions,
-- ownerId, recipients, unboundedAuthorizedBy, templateDigest/delegationDigest — is still bound
-- verbatim, and criteriaVersions still carries definitionId + semanticRevision so edit-then-revert,
-- delete/recreate and identity replacement cannot resurrect an old approval.
--
-- FAIL CLOSED is the rule everywhere the order runs out: a threshold map whose keys or value types
-- were rewritten, an automation policy this migration does not know, an approved value of the wrong
-- JSON type. None of those can be MECHANICALLY proven to be a tightening, so each one binds the
-- current value, advances the digest and asks. One extra question costs an owner a click; one
-- silently granted expansion costs them the guarantee.
--
-- The operating parameters keep their own digests. riskPolicyDigest / permissionDigest /
-- budgetDigest are still computed over the CURRENT values, so an in-flight ratified action still
-- goes RATIFIED_ACTION_BINDING_STALE the moment any of them moves, envelope or not. The owner is
-- not asked twice; the executor is still stopped.
--
-- The envelope rises only when an owner APPROVES the digest that raised it. An expansion nobody
-- answered records nothing, so withdrawing it leaves no widened ceiling behind — though it does not
-- revive the approval either, because 0196's contract_revision fence has already moved on and a
-- question that was asked has to be answered rather than withdrawn.
--
-- What this deliberately does NOT add: a way to lower a ceiling the owner has already granted.
-- Narrowing granted authority is an owner action with no surface here yet, and inventing one would
-- be this change awarding itself a second decision to make.

BEGIN;

-- The envelope the owner last approved. NULL until this project has ever been ratified, which
-- reads as "the current configuration is its own ceiling" — a project nobody has approved yet
-- cannot be inside an approval.
ALTER TABLE "project_completion_contract" ADD COLUMN "authority_envelope" JSONB;

COMMENT ON COLUMN "project_completion_contract"."authority_envelope" IS
  'The permissiveness ceiling bound by the most recent ratification of this project. Written by the ratification trigger, never by a refresh, and never lowered on the agent''s behalf.';

-- MANUAL < GUARDED_AUTO < AUTO. NULL for anything else, which callers read as "no mechanical
-- direction" and resolve by asking the owner.
CREATE FUNCTION project_authority_policy_rank(p_policy TEXT) RETURNS INT AS $$
  SELECT CASE p_policy
    WHEN 'MANUAL' THEN 0
    WHEN 'GUARDED_AUTO' THEN 1
    WHEN 'AUTO' THEN 2
    ELSE NULL END
$$ LANGUAGE sql IMMUTABLE;

-- Least upper bound of two maps of `max*` limits (convergenceThresholds, attemptBudget), where a
-- larger limit is more permissive and JSON null is unbounded. Returns the APPROVED map whenever
-- every current limit is at or under it — that is the tightening case, and it must produce a
-- byte-identical map so the digest does not move. Returns the CURRENT map whenever the two cannot
-- be compared: different key sets, a value that is not a number or null, or a shape that is not an
-- object. Those are structural rewrites, and a rewrite nobody can order is treated as an expansion.
CREATE FUNCTION project_authority_limit_ceiling(p_approved JSONB, p_current JSONB)
RETURNS JSONB AS $$
DECLARE
  merged JSONB := '{}'::jsonb;
  limit_key TEXT;
  approved_value JSONB;
  current_value JSONB;
BEGIN
  IF p_approved IS NULL OR p_current IS NULL THEN RETURN p_current; END IF;
  IF p_approved = p_current THEN RETURN p_approved; END IF;
  IF jsonb_typeof(p_approved) <> 'object' OR jsonb_typeof(p_current) <> 'object' THEN
    RETURN p_current;
  END IF;
  IF (SELECT array_agg(key ORDER BY key COLLATE "C") FROM jsonb_object_keys(p_approved) key)
     IS DISTINCT FROM
     (SELECT array_agg(key ORDER BY key COLLATE "C") FROM jsonb_object_keys(p_current) key) THEN
    RETURN p_current;
  END IF;
  FOR limit_key IN SELECT key FROM jsonb_object_keys(p_approved) key ORDER BY key COLLATE "C" LOOP
    approved_value := p_approved->limit_key;
    current_value := p_current->limit_key;
    IF jsonb_typeof(approved_value) = 'null' OR jsonb_typeof(current_value) = 'null' THEN
      merged := merged || jsonb_build_object(limit_key, NULL);
    ELSIF jsonb_typeof(approved_value) = 'number' AND jsonb_typeof(current_value) = 'number' THEN
      -- GREATEST returns one of its two argument datums unchanged, so a limit that was written as
      -- 60 comes back as 60 rather than 60.0. Canonical JSON is text, and a rescaled number would
      -- be a different digest for the same authority.
      merged := merged || jsonb_build_object(limit_key, GREATEST(
        (approved_value#>>'{}')::numeric, (current_value#>>'{}')::numeric));
    ELSE
      RETURN p_current;
    END IF;
  END LOOP;
  RETURN merged;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

-- The whole envelope, dimension by dimension. Every branch that cannot prove "at or under what the
-- owner approved" resolves to the current value, which is what makes the digest move.
CREATE FUNCTION project_authority_envelope_material(
  p_approved JSONB,
  p_coordinator_enabled BOOLEAN,
  p_automation_policy TEXT,
  p_max_concurrent_tasks INT,
  p_session_budget_per_day INT,
  p_attempt_budget JSONB,
  p_convergence_thresholds JSONB
) RETURNS JSONB AS $$
DECLARE
  approved JSONB := COALESCE(p_approved, '{}'::jsonb);
  current_sessions JSONB := COALESCE(to_jsonb(p_session_budget_per_day), 'null'::jsonb);
  approved_value JSONB;
  coordinator_ceiling JSONB;
  policy_ceiling JSONB;
  concurrency_ceiling JSONB;
  sessions_ceiling JSONB;
BEGIN
  -- `IS NULL` before every type test, and not as a stylistic nicety: a missing key makes
  -- jsonb_typeof() return SQL NULL, which is not TRUE and not FALSE, so a CASE that only compared
  -- types would fall through to an expression over NULL and publish a ceiling of JSON null. That
  -- reads as "unbounded", which is the one answer this function must never invent.
  approved_value := approved->'coordinatorEnabled';
  coordinator_ceiling := CASE
    WHEN approved_value IS NULL OR jsonb_typeof(approved_value) <> 'boolean'
      THEN to_jsonb(p_coordinator_enabled)
    ELSE to_jsonb(approved_value = 'true'::jsonb OR p_coordinator_enabled) END;

  approved_value := approved->'automationPolicy';
  policy_ceiling := CASE
    WHEN approved_value IS NULL
      OR project_authority_policy_rank(approved->>'automationPolicy') IS NULL
      OR project_authority_policy_rank(p_automation_policy) IS NULL
      THEN to_jsonb(p_automation_policy)
    WHEN project_authority_policy_rank(approved->>'automationPolicy')
         >= project_authority_policy_rank(p_automation_policy) THEN approved_value
    ELSE to_jsonb(p_automation_policy) END;

  approved_value := approved->'maxConcurrentTasks';
  concurrency_ceiling := CASE
    WHEN approved_value IS NULL OR jsonb_typeof(approved_value) <> 'number'
      THEN to_jsonb(p_max_concurrent_tasks)
    WHEN p_max_concurrent_tasks IS NULL THEN approved_value
    WHEN (approved_value#>>'{}')::numeric >= p_max_concurrent_tasks THEN approved_value
    ELSE to_jsonb(p_max_concurrent_tasks) END;

  -- NULL sessionBudgetPerDay is "no limit", so it is the TOP of this dimension, not a missing
  -- value: dropping the limit is the widest possible move and must reach the owner.
  approved_value := approved->'sessionBudgetPerDay';
  sessions_ceiling := CASE
    WHEN approved_value IS NULL THEN current_sessions
    WHEN jsonb_typeof(approved_value) = 'null' THEN approved_value
    WHEN jsonb_typeof(approved_value) <> 'number' THEN current_sessions
    WHEN p_session_budget_per_day IS NULL THEN current_sessions
    WHEN (approved_value#>>'{}')::numeric >= p_session_budget_per_day THEN approved_value
    ELSE current_sessions END;

  RETURN jsonb_build_object(
    'attemptBudget', project_authority_limit_ceiling(
      approved->'attemptBudget', COALESCE(p_attempt_budget, 'null'::jsonb)),
    'automationPolicy', policy_ceiling,
    'convergenceThresholds', project_authority_limit_ceiling(
      approved->'convergenceThresholds', COALESCE(p_convergence_thresholds, 'null'::jsonb)),
    'coordinatorEnabled', coordinator_ceiling,
    'maxConcurrentTasks', concurrency_ceiling,
    'sessionBudgetPerDay', sessions_ceiling
  );
END;
$$ LANGUAGE plpgsql IMMUTABLE;

-- One reader for the envelope, used by the snapshot that publishes it and by the trigger that
-- records it, so the value the owner approved and the value the digest bound cannot drift apart.
CREATE FUNCTION project_authority_envelope(p_project UUID) RETURNS JSONB AS $$
  SELECT project_authority_envelope_material(
           contract."authority_envelope",
           p."coordinator_enabled",
           p."automation_policy"::text,
           p."max_concurrent_tasks",
           p."session_budget_per_day",
           p."attempt_budget",
           p."convergence_thresholds")
    FROM "project" p
    LEFT JOIN "project_completion_contract" contract ON contract."project_id" = p."id"
   WHERE p."id" = p_project
$$ LANGUAGE sql STABLE;

-- An approval is what establishes the ceiling. Recording it here rather than in each of the owner,
-- atomic-create, template and delegation paths means no route to a ratification can forget to, and
-- the digest guard means a ratification of some other digest cannot widen the current envelope.
--
-- The recorded value is a fixed point: it was computed as the least upper bound of the previous
-- envelope and the current configuration, so it is already at or above every current value and
-- recomputing it returns the same object. Approving therefore never moves the digest it approved.
CREATE FUNCTION project_authority_envelope_ratified() RETURNS TRIGGER AS $$
BEGIN
  UPDATE "project_completion_contract"
     SET "authority_envelope" = project_authority_envelope(NEW."project_id")
   WHERE "project_id" = NEW."project_id"
     AND "contract_digest" = NEW."contract_digest";
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER project_authority_envelope_ratified
  AFTER INSERT ON "project_owner_ratification"
  FOR EACH ROW EXECUTE FUNCTION project_authority_envelope_ratified();

-- The snapshot itself. This is 0209's builder with one change of composition: semantic_material now
-- carries the ENVELOPE for the three authority-monotone groups instead of the live values, and no
-- longer re-imports permissionDigest/budgetDigest — those hash the live values, so leaving them in
-- would have smuggled every in-envelope move straight back into contractDigest. recipientDigest
-- stays: recipients are bound verbatim, so it moves only when the recipients themselves move.
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
      project_authority_envelope(base."id") AS envelope,
      -- The three operating materials stay exactly as they were: bound to the live values and to
      -- authorizationRevision, because a ratified action must still notice the moment any of them
      -- changes underneath it, in either direction.
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
      outcome_sha256_json(recipient_material) AS recipient_digest,
      jsonb_build_object(
        'automationPolicy', envelope->'automationPolicy',
        'convergenceThresholds', envelope->'convergenceThresholds',
        'unboundedAuthorizedBy', material."unbounded_authorized_by"
      ) AS risk_envelope,
      jsonb_build_object(
        'coordinatorEnabled', envelope->'coordinatorEnabled',
        'maxConcurrentTasks', envelope->'maxConcurrentTasks'
      ) AS permission_envelope,
      jsonb_build_object(
        'attemptBudget', envelope->'attemptBudget',
        'sessionBudgetPerDay', envelope->'sessionBudgetPerDay'
      ) AS budget_envelope
      FROM material
  ), assembled AS (
    SELECT digested.*,
      jsonb_build_object(
        'budget', budget_envelope,
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
        -- Unchanged and deliberately so: this is the ABA lane. definitionId + semanticRevision are
        -- what stop an edit-then-revert, a delete/recreate or an identity replacement from landing
        -- back on a digest an owner approved for different rows.
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
        'permissions', permission_envelope,
        'recipients', recipient_material,
        'recipientDigest', recipient_digest,
        'riskBoundary', risk_envelope,
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
    'authorityEnvelope', envelope,
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

-- Re-cutting what contractDigest is made of restates the question for every project that has one,
-- and a project whose owner had already answered the OLD question now has an unanswered new one.
-- That is the honest outcome and this function does not paper over it: it derives exactly one
-- owner decision request per affected project, through the ordinary
-- project_ensure_owner_decision_request path, and writes NO ratification of any kind. Carrying an
-- old approval across to the new digest would be forging a consent nobody gave.
--
-- What it does refuse to do is turn the change into an inbox flood. A project that was ALREADY
-- unratified is not being asked anything new here, so its superseded request's routing is carried
-- onto the replacement instead of being promoted from DEFERRED to ACTIONABLE by a migration.
CREATE FUNCTION project_authority_envelope_recut(p_projects UUID[] DEFAULT NULL)
RETURNS JSONB AS $$
DECLARE
  contract_row RECORD;
  prior RECORD;
  refreshed JSONB;
  ratified_before BOOLEAN;
  new_request UUID;
  changed INT := 0;
  requested INT := 0;
  carried INT := 0;
BEGIN
  FOR contract_row IN
    SELECT c."project_id", c."contract_digest"::text AS before_digest
      FROM "project_completion_contract" c
     WHERE p_projects IS NULL OR c."project_id" = ANY(p_projects)
     ORDER BY c."project_id"
  LOOP
    ratified_before := project_owner_ratification_effective(
      contract_row."project_id", contract_row.before_digest);
    SELECT "id", "routing_state", "routing_reason_code", "deferred_at" INTO prior
      FROM "project_owner_decision_request"
     WHERE "project_id" = contract_row."project_id" AND "status" = 'PENDING'
     ORDER BY "request_generation" DESC LIMIT 1;
    refreshed := project_refresh_completion_contract(
      contract_row."project_id", 'AUTHORITY_ENVELOPE_RECUT');
    IF refreshed->>'contractDigest' IS DISTINCT FROM contract_row.before_digest THEN
      changed := changed + 1;
    END IF;
    new_request := (refreshed->>'decisionRequestId')::uuid;
    IF new_request IS NOT NULL THEN
      IF ratified_before THEN
        requested := requested + 1;
      ELSIF prior."id" IS NOT NULL AND prior."id" <> new_request
            AND prior."routing_state" = 'DEFERRED' THEN
        UPDATE "project_owner_decision_request"
           SET "routing_state" = 'DEFERRED',
               "routing_reason_code" = prior."routing_reason_code",
               "deferred_at" = COALESCE(prior."deferred_at", CURRENT_TIMESTAMP)
         WHERE "id" = new_request;
        carried := carried + 1;
      END IF;
    END IF;
  END LOOP;
  RETURN jsonb_build_object(
    'contractsChanged', changed,
    'ownerDecisionsRequested', requested,
    'routingCarriedForward', carried
  );
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION project_authority_envelope_recut(UUID[]) IS
  'Republishes every completion contract under the authority-envelope composition and derives one owner decision request per project whose standing ratification the recut invalidated. Never writes a ratification.';

SELECT project_authority_envelope_recut();

COMMIT;
