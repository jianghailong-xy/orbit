-- Remove the authority envelope.  0216 built it, nothing ever called it, and 0218 already took the
-- one thing that could write it.
--
-- The envelope was a permissiveness CEILING: the least upper bound of what an owner last approved
-- and what the project currently says, so that moving under an approved limit left `contractDigest`
-- where it was and only widening advanced it.  That is a coherent idea, and it needed exactly one
-- thing to mean anything -- an approval that raises the ceiling.  0218 deleted the approval queue,
-- so `project_authority_envelope_ratified` (the only writer of `authority_envelope`) went with it.
-- What is left is a ceiling nobody can ever raise again, recomputed on every snapshot, always
-- resolving to the live values.  Six functions and a column to say "the current value".
--
-- Removed here
--   * project_authority_policy_rank, project_authority_limit_ceiling,
--     project_authority_envelope_material, project_authority_envelope,
--     project_authority_envelope_recut.
--   * project_completion_contract.authority_envelope, and the `authorityEnvelope` key the snapshot
--     published beside its digests.  No caller reads either: this repository reaches PostgreSQL
--     through `$queryRaw`, so that is a string search over the tree and not a compile check.
--   * project_authority_envelope_ratified was already dropped by 0218 with the table its trigger
--     hung on, which is why it is not named again below.
--
-- THE ONE HARD CONSTRAINT: contractDigest does not move
--
-- `project_completion_contract_snapshot` is the only producer of `contractDigest`, and that digest
-- is an input to the criteria-proposal channel and to the DONE gate.  Restoring the pre-0216 body
-- verbatim would NOT be neutral -- 0209's `semantic_material` bound `risk_material`,
-- `permission_material` and `budget_material` whole, and each of those carries
-- `authorizationRevision`, a counter 0216 deliberately left out of the semantic side.  Rolling back
-- to it would advance every project's digest, which is the same mistake 0216 made, in reverse.
--
-- So the composition is KEPT exactly as 0218 left it and only its SOURCE changes: `riskBoundary`,
-- `permissions` and `budget` bind the same six fields under the same six names, read from the live
-- project row instead of from `project_authority_envelope()`.  That is byte-identical whenever the
-- envelope resolves to the live values, which is what it does for every project that has no
-- recorded approval -- and after 0218 no project can ever acquire one.
--
-- "Whenever" is not "always", so this migration does not assume it.  It computes every project's
-- whole snapshot before the redefinition, recomputes it after, and refuses to commit unless the two
-- are identical byte for byte apart from the `authorityEnvelope` key being gone.  A project whose
-- recorded ceiling still sits ABOVE its live configuration -- possible only by tightening that
-- project between 0216 and this migration -- would move its digest, and that is a fact an operator
-- has to see rather than one a migration gets to publish quietly.
--
-- Nothing is refreshed and no row is rewritten.  `project_refresh_completion_contract` is not
-- called, so no `contract_revision` advances, no owner decision is filed and no criteria proposal
-- is invalidated: the stored contracts are already carrying the digest this composition produces.
--
-- No explicit BEGIN/COMMIT, unlike 0216 and 0218, and for a reason this migration cares about: the
-- runner sends the file as one multi-statement query, which PostgreSQL already runs as a single
-- implicit transaction, and an explicit COMMIT would end it before the gate below can veto it.
-- Left implicit, the refusal rolls the whole file back AND is the error the runner prints.

-- What the snapshot says right now, for every project, whole.  Dropped when this file commits.
CREATE TEMPORARY TABLE "authority_envelope_removal_before" ON COMMIT DROP AS
SELECT p."id" AS "project_id",
       (snapshot.value - 'authorityEnvelope') AS "snapshot_without_envelope",
       snapshot.value->>'contractDigest' AS "contract_digest"
  FROM "project" p,
       LATERAL project_completion_contract_snapshot(p."id") AS snapshot(value);

-- 0218's builder with one change: the three authority-monotone groups read the live project row
-- rather than the envelope.  Every key, every name and every ordering is the one that was there.
CREATE OR REPLACE FUNCTION project_completion_contract_snapshot(p_project UUID)
RETURNS JSONB AS $$
DECLARE
  result JSONB;
BEGIN
  WITH base AS (
    SELECT p.* FROM "project" p WHERE p."id" = p_project
  ), material AS (
    SELECT base.*,
      -- The three operating materials stay exactly as they were: bound to the live values and to
      -- authorizationRevision, because a bound action must still notice the moment any of them
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
      ) AS recipient_material
      FROM base
  ), digested AS (
    SELECT material.*,
      outcome_sha256_json(risk_material) AS risk_digest,
      outcome_sha256_json(permission_material) AS permission_digest,
      outcome_sha256_json(budget_material) AS budget_digest,
      outcome_sha256_json(recipient_material) AS recipient_digest,
      -- The semantic side of the same six values, without authorizationRevision: a revision counter
      -- is how an operating digest notices movement, not part of what the project IS.
      jsonb_build_object(
        'automationPolicy', material."automation_policy"::text,
        'convergenceThresholds', material."convergence_thresholds",
        'unboundedAuthorizedBy', material."unbounded_authorized_by"
      ) AS risk_boundary,
      jsonb_build_object(
        'coordinatorEnabled', material."coordinator_enabled",
        'maxConcurrentTasks', material."max_concurrent_tasks"
      ) AS permission_boundary,
      jsonb_build_object(
        'attemptBudget', material."attempt_budget",
        'sessionBudgetPerDay', material."session_budget_per_day"
      ) AS budget_boundary
      FROM material
  ), assembled AS (
    SELECT digested.*,
      jsonb_build_object(
        'budget', budget_boundary,
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
        -- back on a digest that was cut for different rows.
        'criteriaVersions', COALESCE((
          SELECT jsonb_agg(jsonb_build_object(
            'definitionId', d."id"::text,
            'semanticHash', d."semantic_hash"::text,
            'semanticRevision', d."semantic_revision"
          ) ORDER BY d."id")
            FROM "project_acceptance_criterion_definition" d
           WHERE d."project_id" = digested."id"
        ), '[]'::jsonb),
        'goal', digested."goal",
        'outcomes', COALESCE((
          SELECT jsonb_agg(d."text" ORDER BY d."text", d."completion_criterion", d."id")
            FROM "project_acceptance_criterion_definition" d
           WHERE d."project_id" = digested."id"
        ), '[]'::jsonb),
        'ownerId', digested."owner_id"::text,
        'permissions', permission_boundary,
        'recipients', recipient_material,
        'recipientDigest', recipient_digest,
        'riskBoundary', risk_boundary
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

DROP FUNCTION project_authority_envelope_recut(UUID[]);
DROP FUNCTION project_authority_envelope(UUID);
DROP FUNCTION project_authority_envelope_material(JSONB, BOOLEAN, TEXT, INT, INT, JSONB, JSONB);
DROP FUNCTION project_authority_limit_ceiling(JSONB, JSONB);
DROP FUNCTION project_authority_policy_rank(TEXT);

ALTER TABLE "project_completion_contract" DROP COLUMN "authority_envelope";

-- The gate, and it is deliberately the LAST statement: everything above is in this transaction, so
-- a refusal here rolls all of it back, and being last is what makes the refusal the error the
-- migration runner actually prints instead of a downstream "transaction is aborted".
--
-- Per project, the WHOLE snapshot, compared as text: not just contractDigest but every digest and
-- both materials, with only the `authorityEnvelope` key allowed to have gone.
DO $$
DECLARE
  moved TEXT;
  checked INT;
BEGIN
  SELECT count(*) INTO checked FROM "authority_envelope_removal_before";
  SELECT string_agg(format('%s (%s -> %s)', before."project_id",
                           before."contract_digest", after.value->>'contractDigest'), ', '
                    ORDER BY before."project_id")
    INTO moved
    FROM "authority_envelope_removal_before" before,
         LATERAL project_completion_contract_snapshot(before."project_id") AS after(value)
   WHERE after.value::text IS DISTINCT FROM before."snapshot_without_envelope"::text;
  IF moved IS NOT NULL THEN
    RAISE EXCEPTION
      'AUTHORITY_ENVELOPE_REMOVAL_MOVED_CONTRACT_DIGEST: %', moved
      USING ERRCODE = 'raise_exception',
            HINT = 'A recorded authority envelope still sits above the live configuration of these '
                   'projects, so dropping it would advance their contractDigest. Removing the '
                   'envelope is only a no-op while every ceiling equals the value it bounds.';
  END IF;
  RAISE NOTICE 'authority envelope removal: % projects, contractDigest unmoved', checked;
END $$;

