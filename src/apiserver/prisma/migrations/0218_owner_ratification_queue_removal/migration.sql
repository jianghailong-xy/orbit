-- Remove the owner-ratification APPROVAL QUEUE.  Keep the write protection on acceptance criteria.
--
-- These were one mechanism and they should not have been.  The queue made every project wait for a
-- signature on a whole-contract digest that moved whenever a budget, a member or a risk field
-- moved; the write protection exists for one narrow reason that has nothing to do with signatures:
-- an agent must not be able to silently rewrite the standard it is measured against, because the
-- one who moves the ruler can make any conclusion true and no downstream step re-asks that
-- question.  This migration deletes the first and keeps the second.
--
-- Deleted here
--   * project_owner_decision_request, project_owner_ratification, outcome_binding_ratification,
--     project_ratification_template, project_ratification_delegation, and every function, trigger,
--     view and column that existed only to serve them.
--   * The automatic-dispatch gate.  session_owner_ratification_guard raised
--     OWNER_RATIFICATION_REQUIRED on every non-USER session insert whose project had no effective
--     ratification, which is what AUTO_DISPATCH_BLOCKED reported.  Automatic dispatch no longer
--     waits for an approval, so the trigger and the obligations it produced go together.
--   * The DONE gate's ratification clause.  Binding/evaluation drift still blocks the gate -- that
--     is a staleness fact -- but "nobody signed this contract" is no longer a reason to refuse.
--   * The 0211 fallback branch that rewrote ANY unrouted failure into GOAL_DECISION /
--     GOAL_BOUNDARY whenever the project's ratification happened to be STALE.  It overwrote the
--     real failure_node of ordinary engineering failures and produced owner obligations nobody
--     could discharge.  Real boundary failures still route to the owner: that is the branch above
--     it, and it is untouched.
--
-- Kept here, decoupled
--   project_criteria_proposal.  Its four invariants are unchanged -- no web editing entry point,
--   no automatic apply path, the proposal does not move the ruler while it stands, and no machine
--   principal may decide one.  What changes is what it is bound to.  It used to carry the whole
--   completion-contract digest, so a proposal about acceptance criteria was invalidated by a
--   budget edit or a new project member.  It now carries the digest of the CRITERIA SET it was
--   drafted against and nothing else.
--
--   The ABA protection is carried over exactly, because the set it hashes still names, per
--   criterion, `definitionId` + `semanticHash` + `semanticRevision` -- the same three fields the
--   old contract digest used for this: semanticRevision only ever increases, so an edit and its
--   revert do not land back on the drafting digest; definitionId is per row, so deleting and
--   recreating a criterion, or swapping the row behind identical wording, does not either.
BEGIN;

-- ---------------------------------------------------------------------------------------------
-- 1. The criteria set, and its digest.  One spelling, used by the card, by the proposal and by
--    the decision recheck, so "the ruler this was drafted against" cannot drift between them.
-- ---------------------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION project_acceptance_criteria_set_digest(p_project UUID)
RETURNS TEXT AS $$
  SELECT outcome_sha256_json(project_criteria_proposal_effective_criteria(p_project))
$$ LANGUAGE SQL STABLE;

COMMENT ON FUNCTION project_acceptance_criteria_set_digest(UUID) IS
  'Identity of a project''s acceptance criteria set and nothing else. Budget, recipients, risk '
  'boundary, permissions and goal are deliberately outside it: they cannot invalidate a pending '
  'proposal about the criteria. Carries the ABA lane (definitionId + semanticHash + '
  'semanticRevision) that the completion-contract digest used to carry.';

-- ---------------------------------------------------------------------------------------------
-- 2. Re-bind project_criteria_proposal onto that digest and cut its tie to the ratification row.
--    The owner's confirmation is now terminal in itself rather than an appendix to a signature.
-- ---------------------------------------------------------------------------------------------

ALTER TABLE "project_criteria_proposal"
  DROP CONSTRAINT "project_criteria_proposal_applied_shape_check";
ALTER TABLE "project_criteria_proposal"
  DROP COLUMN "ratification_id",
  DROP COLUMN "base_contract_revision";
ALTER TABLE "project_criteria_proposal"
  RENAME COLUMN "base_contract_digest" TO "base_criteria_digest";
ALTER TABLE "project_criteria_proposal"
  RENAME COLUMN "applied_contract_digest" TO "applied_criteria_digest";
ALTER TABLE "project_criteria_proposal"
  RENAME CONSTRAINT "project_criteria_proposal_base_contract_digest_check"
  TO "project_criteria_proposal_base_criteria_digest_check";
ALTER TABLE "project_criteria_proposal"
  ADD CONSTRAINT "project_criteria_proposal_applied_shape_check"
    CHECK (("status" = 'APPLIED') = ("applied_criteria_digest" IS NOT NULL));

-- Existing rows recorded the exact set they were drafted against in `base_criteria`, in the same
-- shape the digest is taken over, so the re-binding is a recomputation and not a guess.
UPDATE "project_criteria_proposal"
   SET "base_criteria_digest" = outcome_sha256_json("base_criteria"),
       "applied_criteria_digest" = CASE WHEN "status" = 'APPLIED'
         THEN outcome_sha256_json(project_criteria_proposal_effective_criteria("project_id"))
         END;

COMMENT ON COLUMN "project_criteria_proposal"."base_criteria_digest" IS
  'The acceptance criteria set this proposal was drafted against. A decision is refused when it '
  'has moved; nothing else about the project can invalidate the proposal.';
COMMENT ON COLUMN "project_criteria_proposal"."card_digest" IS
  'Approve-what-you-see identity over the proposed set, diff, card and base criteria digest.';

-- The card text stops describing a signature that no longer exists.  Everything the owner is
-- being told still has to be true: approving writes the criteria and nothing else, denying
-- changes nothing, and lapsing applies nothing.
CREATE OR REPLACE FUNCTION project_criteria_proposal_card(
  p_diff JSONB,
  p_overrides JSONB,
  p_expires TIMESTAMPTZ
) RETURNS JSONB AS $$
DECLARE
  counts JSONB := p_diff->'counts';
  headline TEXT;
BEGIN
  headline := format(
    '%s of this project''s acceptance criteria change: %s added, %s removed, %s reworded or '
    'retyped, %s untouched.',
    (counts->>'added')::int + (counts->>'removed')::int + (counts->>'modified')::int,
    counts->>'added', counts->>'removed', counts->>'modified', counts->>'unchanged');
  RETURN jsonb_build_object(
    'cost', COALESCE(NULLIF(btrim(COALESCE(p_overrides->>'cost', '')), ''), format(
      'Approving replaces the acceptance criteria in force: %s criteria stand afterwards, and '
      'evidence already gathered is re-read against them. Denying costs the proposing agent one '
      'round trip.',
      counts->>'after')),
    'deadline', COALESCE(NULLIF(btrim(COALESCE(p_overrides->>'deadline', '')), ''), format(
      'This card is shown until %s. Nothing is applied when it lapses: an unanswered proposal '
      'stays pending and the criteria in force do not move.',
      to_char(p_expires AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'))),
    'headline', headline,
    'impacts', jsonb_build_object(
      'APPROVE', format(
        'Applies exactly the %s criteria shown, and nothing else about the project. %s',
        counts->>'after',
        CASE WHEN (p_diff->>'completionCriterionChanged')::boolean
          THEN 'At least one criterion changes how completion is PROVED, so evidence gathered '
               'under the old completionCriterion no longer settles it.'
          ELSE 'No criterion changes how completion is proved.' END),
      'DENY', 'Changes nothing. The criteria in force stay exactly as they are, the proposal is '
              'recorded as denied rather than dropped, and the agent can read why.'),
    'noActionConsequence',
      'Nothing is applied. The acceptance criteria in force remain the ones already standing, '
      'the proposal stays pending and visible, and no timeout, retry or resubmission can apply '
      'it without this decision.',
    'options', jsonb_build_array(
      jsonb_build_object('value', 'APPROVE',
        'label', 'Apply this criteria set'),
      jsonb_build_object('value', 'DENY',
        'label', 'Keep the criteria that are in force and record the refusal')),
    'reason', 'GOAL_DECISION',
    'recommendation', COALESCE(
      NULLIF(btrim(COALESCE(p_overrides->>'recommendation', '')), ''),
      'Read each changed criterion below, then approve only if this is still the standard you '
      'want this project measured against.'),
    'resumeBehavior',
      'Work is not waiting on this card. Automatic execution continues under the criteria in '
      'force either way; approving changes which criteria that is, and denying does not.',
    'title', 'Change this project''s acceptance criteria?',
    'whyNotAgent', COALESCE(NULLIF(btrim(COALESCE(p_overrides->>'whyNotAgent', '')), ''),
      'An agent cannot move the standard it is measured against. Rewriting acceptance criteria '
      'is a goal decision, so the proposal is inert until the account owner approves it.')
  );
END;
$$ LANGUAGE plpgsql STABLE;

-- Record a proposal.  It writes ONE row and touches no acceptance definition: after this returns
-- the effective criteria are byte-identical to what they were before it was called.
CREATE OR REPLACE FUNCTION project_propose_acceptance_criteria(
  p_owner UUID,
  p_project UUID,
  p_actor_type TEXT,
  p_actor_id TEXT,
  p_proposal JSONB,
  p_idempotency_key TEXT
) RETURNS JSONB AS $$
DECLARE
  existing "project_criteria_proposal"%ROWTYPE;
  superseded "project_criteria_proposal"%ROWTYPE;
  proposal_id UUID;
  next_generation BIGINT;
  before_items JSONB;
  after_items JSONB;
  base_digest TEXT;
  diff JSONB;
  card JSONB;
  expires TIMESTAMPTZ;
  input_digest_value TEXT;
  card_digest_value TEXT;
  supersede_reason TEXT;
BEGIN
  IF p_actor_type NOT IN ('AGENT', 'RUNNER', 'USER', 'SERVICE') THEN
    RAISE EXCEPTION 'PROJECT_CRITERIA_PROPOSAL_ACTOR_INVALID: unknown principal %', p_actor_type
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_idempotency_key IS NULL OR btrim(p_idempotency_key) = '' THEN
    RAISE EXCEPTION 'PROJECT_CRITERIA_PROPOSAL_IDEMPOTENCY_REQUIRED'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  -- The project row is the serialization point: two proposals on one project cannot both read an
  -- empty pending slot, which is what keeps the partial unique index a rule rather than a race.
  PERFORM 1 FROM "project" WHERE "id" = p_project AND "owner_id" = p_owner FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'PROJECT_NOT_FOUND: project % is not owned by %', p_project, p_owner
      USING ERRCODE = 'raise_exception';
  END IF;

  input_digest_value := outcome_sha256_json(jsonb_build_object(
    'projectId', p_project::text, 'proposal', p_proposal));
  SELECT * INTO existing FROM "project_criteria_proposal"
   WHERE "owner_id" = p_owner AND "proposal_idempotency_key" = p_idempotency_key FOR UPDATE;
  IF FOUND THEN
    IF existing."project_id" <> p_project
       OR existing."input_digest"::text IS DISTINCT FROM input_digest_value THEN
      RETURN jsonb_build_object(
        'code', 'CRITERIA_PROPOSAL_IDEMPOTENCY_COLLISION', 'ok', false,
        'requiredAction', 'read the current criteria proposal, or use a new idempotency key'
      );
    END IF;
    RETURN jsonb_build_object(
      'applied', false, 'cardDigest', existing."card_digest"::text,
      'duplicate', true, 'ok', true, 'proposalId', existing."id",
      'status', existing."status"
    );
  END IF;

  before_items := project_criteria_proposal_effective_criteria(p_project);
  base_digest := outcome_sha256_json(before_items);
  after_items := project_criteria_proposal_normalize(p_project, p_proposal->'criteria');
  diff := project_criteria_proposal_diff(before_items, after_items);
  IF NOT (diff->>'hasChange')::boolean THEN
    RETURN jsonb_build_object(
      'code', 'CRITERIA_PROPOSAL_NO_CHANGE', 'ok', false,
      'requiredAction', 'propose a set that differs from the criteria in force'
    );
  END IF;

  expires := CURRENT_TIMESTAMP + INTERVAL '7 days';
  card := project_criteria_proposal_card(diff, p_proposal, expires);
  proposal_id := gen_random_uuid();
  card_digest_value := outcome_sha256_json(jsonb_build_object(
    'baseCriteriaDigest', base_digest,
    'card', card,
    'proposalId', proposal_id::text,
    'proposedCriteria', after_items,
    'semanticDiff', diff
  ));

  -- Design answer A.  One pending proposal per project: the previous one is retired explicitly,
  -- with the reason that replaced it, so nothing vanishes on the owner.  Retiring it FIRST is
  -- what lets the partial unique index below stay a hard rule rather than a deferred hope; the
  -- successor's id is written onto it once that successor exists.
  SELECT * INTO superseded FROM "project_criteria_proposal"
   WHERE "project_id" = p_project AND "status" = 'PENDING' FOR UPDATE;
  IF FOUND THEN
    supersede_reason := format(
      'Replaced by a newer proposal from %s %s at %s; a project has at most one acceptance-'
      'criteria proposal awaiting its owner, so this one was retired unanswered.',
      p_actor_type, p_actor_id,
      to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'));
    UPDATE "project_criteria_proposal"
       SET "status" = 'SUPERSEDED', "superseded_reason" = supersede_reason,
           "superseded_at" = CURRENT_TIMESTAMP, "updated_at" = CURRENT_TIMESTAMP
     WHERE "id" = superseded."id";
  END IF;

  SELECT COALESCE(max("proposal_generation"), 0) + 1 INTO next_generation
    FROM "project_criteria_proposal" WHERE "project_id" = p_project;
  INSERT INTO "project_criteria_proposal" (
    "id", "project_id", "owner_id", "proposal_generation", "base_criteria_digest",
    "base_criteria", "proposed_criteria", "semantic_diff", "card",
    "card_digest", "input_digest", "proposed_by_type", "proposed_by_id",
    "proposal_idempotency_key", "expires_at"
  ) VALUES (
    proposal_id, p_project, p_owner, next_generation, base_digest,
    before_items, after_items, diff, card,
    card_digest_value, input_digest_value, p_actor_type, p_actor_id,
    p_idempotency_key, expires
  );
  IF superseded."id" IS NOT NULL THEN
    UPDATE "project_criteria_proposal" SET "superseded_by_id" = proposal_id
     WHERE "id" = superseded."id";
  END IF;
  RETURN jsonb_build_object(
    'applied', false,
    'baseCriteriaDigest', base_digest,
    'cardDigest', card_digest_value,
    'duplicate', false,
    'effectiveCriteriaUnchanged', true,
    'ok', true,
    'proposalId', proposal_id,
    'reasonCode', 'GOAL_DECISION',
    'status', 'PENDING',
    'supersededProposalId', superseded."id"
  );
END;
$$ LANGUAGE plpgsql;

-- The owner's decision on a proposal.  Everything that makes this safe is in the first forty
-- lines: only OWNER, only against the digest of what was actually rendered, only while the
-- criteria set it was drafted against has not moved underneath it.
CREATE OR REPLACE FUNCTION project_owner_decide_criteria_proposal(
  p_owner UUID,
  p_project UUID,
  p_actor_type TEXT,
  p_actor_id TEXT,
  p_proposal_id UUID,
  p_expected_card_digest TEXT,
  p_decision TEXT,
  p_idempotency_key TEXT
) RETURNS JSONB AS $$
DECLARE
  proposal "project_criteria_proposal"%ROWTYPE;
  receipt "project_criteria_proposal"%ROWTYPE;
  current_digest TEXT;
  applied_digest TEXT;
BEGIN
  -- An agent or runner holding a credential is not the owner, and no proposal path may become a
  -- way around that.  This is the whole reason the proposal channel exists.
  IF p_actor_type <> 'OWNER' OR p_actor_id IS DISTINCT FROM p_owner::text THEN
    RAISE EXCEPTION
      'PROJECT_CRITERIA_DECISION_ACTOR_FORBIDDEN: agents and runners cannot decide their own '
      'acceptance criteria'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_decision NOT IN ('APPROVE', 'DENY') THEN
    RAISE EXCEPTION 'PROJECT_CRITERIA_DECISION_INVALID: decision must be APPROVE or DENY'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_idempotency_key IS NULL OR btrim(p_idempotency_key) = '' THEN
    RAISE EXCEPTION 'PROJECT_CRITERIA_DECISION_IDEMPOTENCY_REQUIRED'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  PERFORM 1 FROM "project" WHERE "id" = p_project AND "owner_id" = p_owner FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'PROJECT_NOT_FOUND: project % is not owned by %', p_project, p_owner
      USING ERRCODE = 'raise_exception';
  END IF;

  SELECT * INTO receipt FROM "project_criteria_proposal"
   WHERE "owner_id" = p_owner AND "decision_idempotency_key" = p_idempotency_key FOR UPDATE;
  IF FOUND THEN
    IF receipt."project_id" <> p_project OR receipt."id" IS DISTINCT FROM p_proposal_id
       OR receipt."decision" IS DISTINCT FROM p_decision THEN
      RETURN jsonb_build_object(
        'code', 'CRITERIA_PROPOSAL_IDEMPOTENCY_COLLISION', 'ok', false,
        'requiredAction', 'read the recorded decision on this criteria proposal'
      );
    END IF;
    RETURN jsonb_build_object(
      'appliedCriteriaDigest', receipt."applied_criteria_digest"::text,
      'cardDigest', receipt."card_digest"::text, 'decision', receipt."decision",
      'duplicate', true, 'ok', true, 'proposalId', receipt."id",
      'status', receipt."status"
    );
  END IF;

  SELECT * INTO proposal FROM "project_criteria_proposal"
   WHERE "id" = p_proposal_id AND "project_id" = p_project AND "owner_id" = p_owner FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'code', 'CRITERIA_PROPOSAL_NOT_FOUND', 'ok', false,
      'requiredAction', 'read the current criteria proposal for this project'
    );
  END IF;
  IF proposal."status" <> 'PENDING' THEN
    RETURN jsonb_strip_nulls(jsonb_build_object(
      'code', 'CRITERIA_PROPOSAL_ALREADY_SETTLED', 'ok', false,
      'proposalId', proposal."id", 'recordedDecision', proposal."decision",
      'status', proposal."status", 'supersededById', proposal."superseded_by_id",
      'supersededReason', proposal."superseded_reason",
      'requiredAction', 'read the current criteria proposal for this project'
    ));
  END IF;
  -- Approve what you SAW.  A proposal that changed between rendering and answering is not the one
  -- this decision was taken on, so the decision is refused and the caller re-renders.
  IF p_expected_card_digest IS DISTINCT FROM proposal."card_digest"::text THEN
    RETURN jsonb_build_object(
      'code', 'CRITERIA_PROPOSAL_CARD_STALE', 'currentCardDigest', proposal."card_digest"::text,
      'ok', false, 'proposalId', proposal."id",
      'requiredAction', 're-read the criteria proposal card and decide on what it now shows'
    );
  END IF;

  -- The ABA lane.  Only the criteria set is compared, so a budget, member, risk or permission
  -- edit cannot invalidate this decision -- and an edit-then-revert, a delete-and-recreate or an
  -- identity swap inside the criteria still can, because definitionId and semanticRevision are
  -- part of what is hashed.
  current_digest := project_acceptance_criteria_set_digest(p_project);
  IF proposal."base_criteria_digest"::text IS DISTINCT FROM current_digest THEN
    RETURN jsonb_build_object(
      'code', 'CRITERIA_PROPOSAL_BASE_MOVED',
      'currentCriteriaDigest', current_digest, 'ok', false,
      'proposalId', proposal."id",
      'requiredAction', 'the acceptance criteria this proposal was drafted against have changed; '
                        'ask for a proposal against the current ones'
    );
  END IF;

  IF p_decision = 'DENY' THEN
    UPDATE "project_criteria_proposal"
       SET "status" = 'DENIED', "decision" = 'DENY',
           "decision_idempotency_key" = p_idempotency_key,
           "decided_at" = CURRENT_TIMESTAMP, "decided_by_type" = 'OWNER',
           "decided_by_id" = p_owner::text, "updated_at" = CURRENT_TIMESTAMP
     WHERE "id" = proposal."id";
    RETURN jsonb_build_object(
      'cardDigest', proposal."card_digest"::text, 'decision', 'DENY',
      'duplicate', false, 'effectiveCriteriaUnchanged', true, 'ok', true,
      'proposalId', proposal."id", 'status', 'DENIED'
    );
  END IF;

  PERFORM project_apply_criteria_proposal(p_project, proposal."proposed_criteria");
  PERFORM project_refresh_completion_contract(p_project, 'OWNER_CRITERIA_PROPOSAL_APPLIED');
  applied_digest := project_acceptance_criteria_set_digest(p_project);
  UPDATE "project_criteria_proposal"
     SET "status" = 'APPLIED', "decision" = 'APPROVE',
         "decision_idempotency_key" = p_idempotency_key,
         "decided_at" = CURRENT_TIMESTAMP, "decided_by_type" = 'OWNER',
         "decided_by_id" = p_owner::text,
         "applied_criteria_digest" = applied_digest, "updated_at" = CURRENT_TIMESTAMP
   WHERE "id" = proposal."id";

  RETURN jsonb_build_object(
    'appliedCriteriaDigest', applied_digest,
    'atomic', true,
    'cardDigest', proposal."card_digest"::text,
    'decision', 'APPROVE',
    'duplicate', false,
    'ok', true,
    'previousCriteriaDigest', proposal."base_criteria_digest"::text,
    'proposalId', proposal."id",
    'status', 'APPLIED'
  );
END;
$$ LANGUAGE plpgsql;

-- The owner-facing card, plus enough of the surrounding truth to prove the proposal has not moved
-- anything: what is in force right now, and what a decision would replace it with.
CREATE OR REPLACE FUNCTION project_criteria_proposal_state_json(p_owner UUID, p_project UUID)
RETURNS JSONB AS $$
DECLARE
  proposal "project_criteria_proposal"%ROWTYPE;
  effective JSONB;
  current_digest TEXT;
  history JSONB;
BEGIN
  PERFORM 1 FROM "project" WHERE "id" = p_project AND "owner_id" = p_owner;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'PROJECT_NOT_FOUND' USING ERRCODE = 'raise_exception';
  END IF;
  effective := project_criteria_proposal_effective_criteria(p_project);
  current_digest := outcome_sha256_json(effective);
  SELECT * INTO proposal FROM "project_criteria_proposal"
   WHERE "project_id" = p_project AND "status" = 'PENDING';
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'cardDigest', past."card_digest"::text,
           'createdAt', past."created_at",
           'decidedAt', past."decided_at",
           'decision', past."decision",
           'id', past."id",
           'proposalGeneration', past."proposal_generation"::text,
           'proposedByType', past."proposed_by_type",
           'status', past."status",
           'supersededById', past."superseded_by_id",
           'supersededReason', past."superseded_reason"
         ) ORDER BY past."proposal_generation" DESC), '[]'::jsonb) INTO history
    FROM "project_criteria_proposal" past WHERE past."project_id" = p_project;
  RETURN jsonb_build_object(
    'currentCriteriaDigest', current_digest,
    'effectiveCriteria', effective,
    'history', history,
    'owner', 'OWNER',
    'projectId', p_project::text,
    'proposal', CASE WHEN proposal."id" IS NULL THEN NULL ELSE jsonb_build_object(
      'baseCriteriaDigest', proposal."base_criteria_digest"::text,
      'baseMatchesCurrentCriteria', proposal."base_criteria_digest"::text = current_digest,
      'card', proposal."card",
      'cardDigest', proposal."card_digest"::text,
      'createdAt', proposal."created_at",
      'expiresAt', proposal."expires_at",
      'id', proposal."id",
      'kind', proposal."kind",
      'proposalGeneration', proposal."proposal_generation"::text,
      'proposedByType', proposal."proposed_by_type",
      'proposedCriteria', proposal."proposed_criteria",
      'reasonCode', proposal."reason_code",
      'semanticDiff', proposal."semantic_diff",
      'status', proposal."status"
    ) END
  );
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION project_owner_decide_criteria_proposal(
  UUID, UUID, TEXT, TEXT, UUID, TEXT, TEXT, TEXT
) IS
  'The only path that applies a criteria proposal: OWNER principal, exact rendered-card digest, '
  'and an unmoved acceptance-criteria set.';

-- ---------------------------------------------------------------------------------------------
-- 3. The completion contract stops carrying delegated ratification authority, and refreshing it
--    stops filing owner work.  It remains what it was for everything else: the identity a bound
--    action, a binding and an evaluation are checked against.
-- ---------------------------------------------------------------------------------------------

ALTER TABLE "project_completion_contract"
  DROP COLUMN "template_id",
  DROP COLUMN "delegation_id";

CREATE OR REPLACE FUNCTION project_completion_contract_snapshot(p_project UUID)
RETURNS JSONB AS $$
DECLARE
  result JSONB;
BEGIN
  WITH base AS (
    SELECT p.* FROM "project" p WHERE p."id" = p_project
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
      ) AS recipient_material
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
        'permissions', permission_envelope,
        'recipients', recipient_material,
        'recipientDigest', recipient_digest,
        'riskBoundary', risk_envelope
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

CREATE OR REPLACE FUNCTION project_refresh_completion_contract(
  p_project UUID,
  p_reason TEXT DEFAULT 'PROJECT_CONTRACT_REFRESHED'
) RETURNS JSONB AS $$
DECLARE
  project_owner UUID;
  snapshot JSONB;
  prior "project_completion_contract"%ROWTYPE;
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
  ELSE
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
  END IF;
  RETURN (SELECT jsonb_build_object(
    'contractDigest', state."contract_digest"::text,
    'contractRevision', state."contract_revision"::text,
    'evaluationPlanDigest', state."evaluation_plan_digest"::text,
    'evaluationPlanRevision', state."evaluation_plan_revision"::text
  ) FROM "project_completion_contract" state WHERE state."project_id" = p_project);
END;
$$ LANGUAGE plpgsql;

-- Re-cutting the envelope now only re-cuts digests.  It used to also decide whose standing
-- approval had to be asked again, and there is nobody left to ask.
CREATE OR REPLACE FUNCTION project_authority_envelope_recut(p_projects UUID[] DEFAULT NULL)
RETURNS JSONB AS $$
DECLARE
  contract_row RECORD;
  refreshed JSONB;
  changed INT := 0;
BEGIN
  FOR contract_row IN
    SELECT c."project_id", c."contract_digest"::text AS before_digest
      FROM "project_completion_contract" c
     WHERE p_projects IS NULL OR c."project_id" = ANY(p_projects)
     ORDER BY c."project_id"
  LOOP
    refreshed := project_refresh_completion_contract(
      contract_row."project_id", 'AUTHORITY_ENVELOPE_RECUT');
    IF refreshed->>'contractDigest' IS DISTINCT FROM contract_row.before_digest THEN
      changed := changed + 1;
    END IF;
  END LOOP;
  RETURN jsonb_build_object('contractsChanged', changed);
END;
$$ LANGUAGE plpgsql;

-- ---------------------------------------------------------------------------------------------
-- 4. Automatic dispatch stops waiting for an approval.
--
--    session_owner_ratification_guard refused every non-USER session insert whose project had no
--    effective ratification.  That refusal was what the AUTO_DISPATCH_BLOCKED obligation reported
--    as OWNER_RATIFICATION_REQUIRED, and it is the gate this task removes.  The obligations it
--    already produced are resolved here rather than left standing: they name a decision that can
--    no longer be taken.
-- ---------------------------------------------------------------------------------------------

DROP TRIGGER IF EXISTS "session_owner_ratification_guard" ON "session";
DROP FUNCTION IF EXISTS session_owner_ratification_guard();

UPDATE "task_auto_dispatch_state" dispatch_state
   SET "state" = 'RESOLVED', "latest_observed_at" = clock_timestamp()
  FROM "task_auto_dispatch_obligation_revision" revision
 WHERE revision."tenant_id" = dispatch_state."tenant_id"
   AND revision."task_id" = dispatch_state."task_id"
   AND revision."obligation_revision" = dispatch_state."obligation_revision"
   AND revision."reason_code" = 'OWNER_RATIFICATION_REQUIRED'
   AND dispatch_state."state" = 'ACTIVE';

-- The work these obligations were holding is released rather than merely unblocked: a pending
-- wakeup that is already due is how the dispatcher re-reads a task without a manual start.
UPDATE "task_auto_dispatch_wakeup" wake
   SET "due_at" = LEAST(wake."due_at", clock_timestamp()), "updated_at" = clock_timestamp()
  FROM "task_auto_dispatch_obligation_revision" revision
 WHERE revision."tenant_id" = wake."tenant_id"
   AND revision."task_id" = wake."task_id"
   AND revision."obligation_revision" = wake."obligation_revision"
   AND revision."reason_code" = 'OWNER_RATIFICATION_REQUIRED'
   AND wake."state" = 'PENDING';

-- ---------------------------------------------------------------------------------------------
-- 5. Bound side-effecting actions still bind to the exact contract they were submitted against.
--    They no longer additionally require a signature on it.
-- ---------------------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION project_submit_ratified_action_v1(
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

CREATE OR REPLACE FUNCTION project_commit_ratified_action_v1(
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

-- ---------------------------------------------------------------------------------------------
-- 6. The DONE gate keeps its staleness clause and loses its authority clause.
-- ---------------------------------------------------------------------------------------------

-- The projection's own gate goes first: it is what `project_canonical_done_gate` returns as its
-- base value, so leaving the clause here would have kept the refusal under a different call.
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
        WHEN 'CONTRACT_RATIFICATION' THEN 'outcome.dimension.resolve'
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

CREATE OR REPLACE FUNCTION project_canonical_done_gate_projection_integrity_body(
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
  expected_gate jsonb;
  surface_payload jsonb;
  identity_value jsonb;
  drift_reason jsonb;
  reasons_value jsonb;
  blocking_reasons_value jsonb;
  gate_value jsonb;
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
  -- The contract clause that survives is the STALENESS one: this gate is only allowed to speak
  -- for the cut it actually read.  "Nobody signed this contract" is no longer one of its inputs.
  IF contract_digest_value IS DISTINCT FROM binding_row.binding->>'contractDigest'
     OR evaluation_plan_digest_value IS DISTINCT FROM binding_row.binding->>'evaluationPlanDigest'
     OR evaluation_row.result#>>'{proof,contractDigest}' IS DISTINCT FROM contract_digest_value THEN
    drift_reason := jsonb_build_object(
      'code', 'COMPLETION_CONTRACT_DRIFTED', 'category', 'STALENESS',
      'message', 'The completion contract or evaluation plan changed after this '
                 'binding/evaluation cut.',
      'owner', 'SYSTEM', 'actor', 'SYSTEM',
      'nextAction', 'reconciler.rebind', 'blocksGate', true,
      'contractDigest', contract_digest_value,
      'boundContractDigest', binding_row.binding->>'contractDigest',
      'evidenceFactIds', '[]'::jsonb, 'attemptedActions', '[]'::jsonb
    );
    reasons_value := jsonb_build_array(drift_reason)
      || COALESCE(gate_value->'reasons', '[]'::jsonb);
    blocking_reasons_value := jsonb_build_array(drift_reason)
      || COALESCE(gate_value->'blockingReasons', '[]'::jsonb);
    gate_value := gate_value || jsonb_build_object(
      'allowed', false, 'decision', 'DENY',
      'reason', drift_reason,
      'reasons', reasons_value,
      'blockingReasons', blocking_reasons_value,
      'owner', 'SYSTEM', 'actor', 'SYSTEM',
      'nextAction', 'reconciler.rebind'
    );
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

COMMENT ON FUNCTION project_canonical_done_gate(uuid, text, text) IS
  'Structured fail-closed DONE gate over the exact current binding/evaluation cut, canonical '
  'obligations, proof, delivery dimensions, and checked projection.';

-- ---------------------------------------------------------------------------------------------
-- 7. A new outcome binding no longer records which signature stood behind it.
-- ---------------------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION outcome_binding_transition_record() RETURNS TRIGGER AS $$
DECLARE
  predecessor outcome_fact_binding%ROWTYPE;
  changed text[];
  invalidators_value text[];
  request_value uuid;
  transition_value uuid := gen_random_uuid();
BEGIN
  SELECT * INTO predecessor
    FROM outcome_fact_binding
   WHERE tenant_id = NEW.tenant_id AND project_id = NEW.project_id
     AND binding_epoch = NEW.binding_epoch - 1;

  IF predecessor.binding_digest IS NULL THEN
    changed := ARRAY(SELECT key FROM jsonb_object_keys(NEW.binding) key ORDER BY key COLLATE "C");
    invalidators_value := ARRAY['INITIAL_BINDING'];
  ELSE
    changed := ARRAY(
      SELECT key FROM jsonb_object_keys(NEW.binding) key
       WHERE NEW.binding->key IS DISTINCT FROM predecessor.binding->key
       ORDER BY key COLLATE "C");
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
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ---------------------------------------------------------------------------------------------
-- 8. Failure routing keeps every real boundary and loses the fallback that manufactured one.
--
--    A stale signature is not a goal decision.  The branch removed below rewrote any unrouted
--    failure into GOAL_DECISION / GOAL_BOUNDARY whenever the project's ratification happened to be
--    STALE, which overwrote the real failure_node of ordinary engineering failures -- a hard-coded
--    timeout, a leaked container -- and filed them as owner obligations that had no discharging
--    action.  The four real boundaries above it are untouched.
-- ---------------------------------------------------------------------------------------------

ALTER TABLE "failure_continuation_route_decision"
  DROP CONSTRAINT "failure_continuation_route_plan_digest_shape";
ALTER TABLE "failure_continuation_route_decision"
  DROP COLUMN "ratified_evaluation_plan_digest",
  DROP COLUMN "contract_ratification_state",
  DROP COLUMN "project_evaluation_plan_changed";
ALTER TABLE "failure_continuation_route_decision"
  ADD CONSTRAINT "failure_continuation_route_plan_digest_shape" CHECK (
    outcome_valid_digest(attempt_evaluation_plan_digest)
    AND (task_evaluation_plan_digest IS NULL
      OR outcome_valid_digest(task_evaluation_plan_digest))
    AND (project_evaluation_plan_digest IS NULL
      OR outcome_valid_digest(project_evaluation_plan_digest)));

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
    'taskEvaluationPlanChanged', decision.task_evaluation_plan_changed,
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
  v_previous failure_continuation_route_decision%ROWTYPE;
  v_existing jsonb;
  v_available_capabilities text[];
  v_required_capability text;
  v_capability_available boolean;
  v_capability_digest text;
  v_failure_node text;
  v_owner_reason text;
  v_expected_owner_node text;
  v_task_plan_changed boolean;
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

  v_task_plan_changed := v_context.task_evaluation_plan_digest IS DISTINCT FROM
    v_context.attempt_evaluation_plan_digest;
  v_evaluation_plan_changed := v_task_plan_changed;

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
    'contractDigest', v_context.contract_digest,
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
    'taskEvaluationPlanChanged', v_task_plan_changed,
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
          WHEN 'RISK_ACCEPTANCE' THEN 'Only the owner may accept risk outside the approved boundary.'
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
    project_evaluation_plan_digest, task_evaluation_plan_changed,
    failure_domain, failure_node, owner_reason,
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
    v_task_plan_changed,
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

-- ---------------------------------------------------------------------------------------------
-- 9. The queue itself.
--
--    Everything above exists so that these five tables can go without leaving a caller behind.
--    105 rows of approval history (96 requests, 4 ratifications, 5 binding links) go with them;
--    that is a decision the account owner took knowingly, and inventing an archive table to soften
--    it would only re-create the thing being removed under another name.
-- ---------------------------------------------------------------------------------------------

DROP VIEW IF EXISTS "outcome_current_binding_ratification";

DROP FUNCTION IF EXISTS project_owner_ratify_contract(
  UUID, UUID, TEXT, TEXT, TEXT, UUID, UUID, TEXT, TEXT, BOOLEAN);
DROP FUNCTION IF EXISTS project_owner_ratify_contract_unrouted(
  UUID, UUID, TEXT, TEXT, TEXT, UUID, UUID, TEXT, TEXT, BOOLEAN);
DROP FUNCTION IF EXISTS project_owner_ratify_contract_v1(
  UUID, UUID, TEXT, TEXT, TEXT, UUID, UUID, TEXT, TEXT, BOOLEAN);
DROP FUNCTION IF EXISTS project_preapproved_ratify_contract(
  UUID, UUID, TEXT, TEXT, TEXT, UUID, TEXT, TEXT);
DROP FUNCTION IF EXISTS project_preapproved_ratify_contract_v1(
  UUID, UUID, TEXT, TEXT, TEXT, UUID, TEXT, TEXT);
DROP FUNCTION IF EXISTS project_create_ratification_template(UUID, JSONB);
DROP FUNCTION IF EXISTS project_create_ratification_delegation(UUID, JSONB);
DROP FUNCTION IF EXISTS project_owner_ratification_state_json(UUID, UUID);
DROP FUNCTION IF EXISTS project_owner_ratification_eligibility(UUID, UUID, UUID);
DROP FUNCTION IF EXISTS project_owner_ratification_blockers(UUID, UUID, TEXT);
DROP FUNCTION IF EXISTS project_ensure_owner_decision_request(UUID, TEXT, TEXT, JSONB);
DROP FUNCTION IF EXISTS project_owner_ratification_effective(UUID, TEXT);
DROP TABLE IF EXISTS "outcome_binding_ratification";
DROP TABLE IF EXISTS "project_ratification_delegation";
DROP TABLE IF EXISTS "project_ratification_template";
DROP TABLE IF EXISTS "project_owner_ratification";
DROP TABLE IF EXISTS "project_owner_decision_request";

-- The trigger bodies go last: until the tables are gone the triggers still depend on them.
DROP FUNCTION IF EXISTS project_ratification_authority_changed();
DROP FUNCTION IF EXISTS project_ratification_template_guard();
DROP FUNCTION IF EXISTS project_ratification_delegation_guard();
DROP FUNCTION IF EXISTS project_ratification_event_immutable();
DROP FUNCTION IF EXISTS project_owner_ratification_bind_revision();
DROP FUNCTION IF EXISTS project_owner_decision_bind_revision();
DROP FUNCTION IF EXISTS project_authority_envelope_ratified();

COMMIT;
