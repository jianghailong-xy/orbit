-- Acceptance criteria become a PROPOSAL the owner ratifies, not a write that lands.
--
-- Before this migration an agent that sent `acceptanceCriteriaItems` rewrote
-- "project_acceptance_criterion_definition" immediately.  The contract digest advanced, the
-- standing ratification stopped being effective, and automatic execution was refused -- but the
-- project's stated acceptance criteria were, from that instant until the owner answered, a set
-- nobody had approved.  Every read model, every doneGate evaluation and every person looking at
-- the project saw the unapproved ruler.
--
-- The window is closed by separating the two facts.  A proposal is a durable record of what an
-- agent WOULD change, bound to the exact contract digest it was drafted against; its own status
-- moves as it is answered or replaced, and the effective definitions are untouched while it
-- stands.  Only `project_owner_decide_criteria_proposal`, which
-- refuses every non-OWNER principal with the same OWNER_RATIFICATION_ACTOR_FORBIDDEN this schema
-- already raises, applies one -- and it applies the criteria, advances the contract and appends
-- the owner's ratification in ONE transaction, so the unapproved-ruler window never exists at all.
--
-- Two design answers are encoded here rather than left to callers:
--
--   A. ONE pending proposal per project.  `project_criteria_proposal_one_pending_idx` is a partial
--      unique index, so a second proposal cannot merely coexist: the propose function must mark
--      the earlier one SUPERSEDED and record WHY, and the CHECK below refuses a SUPERSEDED row
--      with no reason.  A proposal never disappears silently.
--
--   B. There is no automatic application path, and none is added.  No default answer, no deadline
--      that approves, no agent self-approval.  `deadline` in the card is information the owner
--      reads; nothing in this schema acts on it.  Expiry is not a decision -- an expired proposal
--      stays PENDING and stays un-applied.
BEGIN;

CREATE TABLE "project_criteria_proposal" (
  "id" UUID PRIMARY KEY,
  "project_id" UUID NOT NULL REFERENCES "project"("id") ON DELETE CASCADE,
  "owner_id" UUID NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
  "proposal_generation" BIGINT NOT NULL CHECK ("proposal_generation" > 0),
  -- The owner-decision protocol reason this card is raised under.  Changing what a project counts
  -- as done is a goal decision; it is deliberately not one of the other three reasons.
  "reason_code" TEXT NOT NULL DEFAULT 'GOAL_DECISION' CHECK ("reason_code" = 'GOAL_DECISION'),
  "kind" TEXT NOT NULL DEFAULT 'PROJECT_CRITERIA_PROPOSAL'
    CHECK ("kind" = 'PROJECT_CRITERIA_PROPOSAL'),
  "status" TEXT NOT NULL DEFAULT 'PENDING' CHECK (
    "status" IN ('PENDING', 'APPLIED', 'DENIED', 'SUPERSEDED')
  ),
  -- The exact ruler this proposal was drafted against.  A proposal whose base has moved is not
  -- applied: the owner is shown a card derived from the contract that actually exists now.
  "base_contract_digest" CHAR(64) NOT NULL CHECK (outcome_valid_digest("base_contract_digest")),
  "base_contract_revision" BIGINT NOT NULL,
  "base_criteria" JSONB NOT NULL CHECK (jsonb_typeof("base_criteria") = 'array'),
  "proposed_criteria" JSONB NOT NULL CHECK (jsonb_typeof("proposed_criteria") = 'array'),
  "semantic_diff" JSONB NOT NULL CHECK (jsonb_typeof("semantic_diff") = 'object'),
  "card" JSONB NOT NULL CHECK (jsonb_typeof("card") = 'object'),
  -- What "approve what you see" is checked against.  It covers the proposed set, the rendered
  -- diff, the card and the base digest, so any change to what was shown invalidates a decision
  -- taken against the old rendering.
  "card_digest" CHAR(64) NOT NULL CHECK (outcome_valid_digest("card_digest")),
  "input_digest" CHAR(64) NOT NULL CHECK (outcome_valid_digest("input_digest")),
  "proposed_by_type" TEXT NOT NULL CHECK (
    "proposed_by_type" IN ('AGENT', 'RUNNER', 'USER', 'SERVICE')
  ),
  "proposed_by_id" TEXT NOT NULL CHECK (btrim("proposed_by_id") <> ''),
  "proposal_idempotency_key" TEXT NOT NULL CHECK (btrim("proposal_idempotency_key") <> ''),
  "expires_at" TIMESTAMPTZ NOT NULL,
  "superseded_by_id" UUID REFERENCES "project_criteria_proposal"("id") ON DELETE SET NULL,
  "superseded_reason" TEXT,
  "superseded_at" TIMESTAMPTZ,
  "decision" TEXT CHECK ("decision" IS NULL OR "decision" IN ('APPROVE', 'DENY')),
  "decision_idempotency_key" TEXT,
  "decided_at" TIMESTAMPTZ,
  "decided_by_type" TEXT CHECK ("decided_by_type" IS NULL OR "decided_by_type" = 'OWNER'),
  "decided_by_id" TEXT,
  "applied_contract_digest" CHAR(64),
  "ratification_id" UUID REFERENCES "project_owner_ratification"("id") ON DELETE SET NULL,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE ("project_id", "proposal_generation"),
  -- A superseded proposal always says what replaced it and why.  Design answer A is a constraint
  -- rather than a convention: "the new one won" cannot be recorded as an absence.
  CONSTRAINT "project_criteria_proposal_supersede_shape_check"
    CHECK (("status" = 'SUPERSEDED') = ("superseded_reason" IS NOT NULL)
           AND ("status" = 'SUPERSEDED') = ("superseded_at" IS NOT NULL)),
  CONSTRAINT "project_criteria_proposal_decision_shape_check"
    CHECK (("status" IN ('APPLIED', 'DENIED')) = ("decision" IS NOT NULL)
           AND ("decision" IS NULL) = ("decided_at" IS NULL)
           AND ("decision" IS NULL) = ("decided_by_type" IS NULL)),
  CONSTRAINT "project_criteria_proposal_applied_shape_check"
    CHECK (("status" = 'APPLIED') = ("applied_contract_digest" IS NOT NULL)
           AND ("status" = 'APPLIED') = ("ratification_id" IS NOT NULL)),
  CONSTRAINT "project_criteria_proposal_decision_receipt_shape_check"
    CHECK ("decision_idempotency_key" IS NULL OR "decision" IS NOT NULL)
);

-- Design answer A, enforced: at most one proposal may be awaiting the owner on a project.
CREATE UNIQUE INDEX "project_criteria_proposal_one_pending_idx"
  ON "project_criteria_proposal" ("project_id") WHERE "status" = 'PENDING';
CREATE UNIQUE INDEX "project_criteria_proposal_idempotency_idx"
  ON "project_criteria_proposal" ("owner_id", "proposal_idempotency_key");
CREATE UNIQUE INDEX "project_criteria_proposal_decision_idempotency_idx"
  ON "project_criteria_proposal" ("owner_id", "decision_idempotency_key");
CREATE INDEX "project_criteria_proposal_inbox_idx"
  ON "project_criteria_proposal" ("owner_id", "status", "created_at" DESC);

COMMENT ON TABLE "project_criteria_proposal" IS
  'An agent-authored proposal to change a project''s acceptance criteria. Holding a row here '
  'changes nothing about the effective criteria: only project_owner_decide_criteria_proposal, '
  'under OWNER credentials, applies one.';
COMMENT ON COLUMN "project_criteria_proposal"."card_digest" IS
  'Approve-what-you-see identity over the proposed set, diff, card and base digest.';

-- The effective ruler, in the shape a proposal is written in.  Read by the diff, by the card and
-- by the owner surface, so "what is in force" has exactly one spelling.
CREATE OR REPLACE FUNCTION project_criteria_proposal_effective_criteria(p_project UUID)
RETURNS JSONB AS $$
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'acceptanceCommand', d."acceptance_command",
           'acceptanceExpectedExitCode', d."acceptance_expected_exit_code",
           'completionCriterion', d."completion_criterion"::text,
           'completionCriterionOverrideReason', d."completion_criterion_override_reason",
           'definitionId', d."id"::text,
           'evidenceTaskId', d."evidence_task_id"::text,
           'ordinal', d."ordinal",
           'semanticHash', d."semantic_hash"::text,
           'semanticRevision', d."semantic_revision",
           'text', d."text",
           'verificationMethod', d."verification_method"
         ) ORDER BY d."ordinal", d."id"), '[]'::jsonb)
    FROM "project_acceptance_criterion_definition" d
   WHERE d."project_id" = p_project
$$ LANGUAGE SQL STABLE;

-- Structural validation and id resolution for a proposed set.  It mirrors the rules
-- `ProjectsService.normalizeAcceptanceItems` applies at the HTTP door, so a proposal that reaches
-- the database directly cannot describe a set the applying UPDATE would then refuse.  A retained
-- `definitionId` must belong to this project; a new criterion is given its id HERE, so the card
-- the owner approves names the exact rows the apply will write.
CREATE OR REPLACE FUNCTION project_criteria_proposal_normalize(p_project UUID, p_items JSONB)
RETURNS JSONB AS $$
DECLARE
  item JSONB;
  ordinal_value INT := 0;
  text_value TEXT;
  method_value TEXT;
  criterion_value TEXT;
  command_value TEXT;
  exit_code INTEGER;
  evidence_value UUID;
  override_value TEXT;
  definition_value UUID;
  seen UUID[] := ARRAY[]::UUID[];
  result JSONB := '[]'::jsonb;
BEGIN
  IF jsonb_typeof(p_items) <> 'array' OR jsonb_array_length(p_items) = 0 THEN
    RAISE EXCEPTION
      'PROJECT_CRITERIA_PROPOSAL_ITEMS_INVALID: criteria must be a non-empty array'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF jsonb_array_length(p_items) > 50 THEN
    RAISE EXCEPTION
      'PROJECT_CRITERIA_PROPOSAL_ITEMS_INVALID: at most 50 acceptance criteria'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  FOR item IN SELECT value FROM jsonb_array_elements(p_items) LOOP
    ordinal_value := ordinal_value + 1;
    text_value := btrim(COALESCE(item->>'text', ''));
    method_value := btrim(COALESCE(item->>'verificationMethod', ''));
    criterion_value := COALESCE(item->>'completionCriterion', '');
    command_value := NULLIF(btrim(COALESCE(item->>'acceptanceCommand', '')), '');
    exit_code := CASE WHEN jsonb_typeof(item->'acceptanceExpectedExitCode') = 'number'
      THEN (item->>'acceptanceExpectedExitCode')::integer END;
    override_value := NULLIF(btrim(COALESCE(item->>'completionCriterionOverrideReason', '')), '');
    IF text_value = '' OR text_value ~ '[\r\n]' THEN
      RAISE EXCEPTION
        'PROJECT_CRITERIA_PROPOSAL_ITEMS_INVALID: criterion % needs one line of non-blank text',
        ordinal_value USING ERRCODE = 'invalid_parameter_value';
    END IF;
    IF method_value = '' THEN
      RAISE EXCEPTION
        'PROJECT_CRITERIA_PROPOSAL_ITEMS_INVALID: criterion % needs a verificationMethod',
        ordinal_value USING ERRCODE = 'invalid_parameter_value';
    END IF;
    IF criterion_value NOT IN ('EXECUTABLE', 'VERIFICATION', 'HUMAN_SIGNOFF') THEN
      RAISE EXCEPTION
        'PROJECT_CRITERIA_PROPOSAL_ITEMS_INVALID: criterion % needs a completionCriterion',
        ordinal_value USING ERRCODE = 'invalid_parameter_value';
    END IF;
    evidence_value := CASE WHEN NULLIF(COALESCE(item->>'evidenceTaskId', ''), '') IS NULL
      THEN NULL ELSE (item->>'evidenceTaskId')::uuid END;
    IF criterion_value = 'EXECUTABLE'
       AND (command_value IS NULL OR exit_code IS NULL OR evidence_value IS NULL) THEN
      RAISE EXCEPTION
        'PROJECT_CRITERIA_PROPOSAL_ITEMS_INVALID: criterion % EXECUTABLE needs a command, an '
        'expected exit code and an evidenceTaskId', ordinal_value
        USING ERRCODE = 'invalid_parameter_value';
    END IF;
    IF criterion_value = 'VERIFICATION'
       AND (command_value IS NOT NULL OR exit_code IS NOT NULL OR evidence_value IS NULL) THEN
      RAISE EXCEPTION
        'PROJECT_CRITERIA_PROPOSAL_ITEMS_INVALID: criterion % VERIFICATION needs an '
        'evidenceTaskId and no command', ordinal_value USING ERRCODE = 'invalid_parameter_value';
    END IF;
    IF criterion_value = 'HUMAN_SIGNOFF'
       AND (command_value IS NOT NULL OR exit_code IS NOT NULL OR evidence_value IS NOT NULL) THEN
      RAISE EXCEPTION
        'PROJECT_CRITERIA_PROPOSAL_ITEMS_INVALID: criterion % HUMAN_SIGNOFF declares no command '
        'and no evidenceTaskId', ordinal_value USING ERRCODE = 'invalid_parameter_value';
    END IF;
    IF evidence_value IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM "task" WHERE "id" = evidence_value AND "project_id" = p_project
    ) THEN
      RAISE EXCEPTION
        'PROJECT_CRITERIA_PROPOSAL_ITEMS_INVALID: criterion % evidenceTaskId must name a task in '
        'this project', ordinal_value USING ERRCODE = 'invalid_parameter_value';
    END IF;
    IF NULLIF(COALESCE(item->>'definitionId', ''), '') IS NULL THEN
      definition_value := gen_random_uuid();
    ELSE
      definition_value := (item->>'definitionId')::uuid;
      IF NOT EXISTS (
        SELECT 1 FROM "project_acceptance_criterion_definition"
         WHERE "id" = definition_value AND "project_id" = p_project
      ) THEN
        RAISE EXCEPTION
          'PROJECT_CRITERIA_PROPOSAL_ITEMS_INVALID: criterion % names a definitionId that does '
          'not belong to this project', ordinal_value USING ERRCODE = 'invalid_parameter_value';
      END IF;
    END IF;
    IF definition_value = ANY (seen) THEN
      RAISE EXCEPTION
        'PROJECT_CRITERIA_PROPOSAL_ITEMS_INVALID: definitionId % is repeated', definition_value
        USING ERRCODE = 'invalid_parameter_value';
    END IF;
    seen := seen || definition_value;
    result := result || jsonb_build_array(jsonb_build_object(
      'acceptanceCommand', command_value,
      'acceptanceExpectedExitCode', exit_code,
      'completionCriterion', criterion_value,
      'completionCriterionOverrideReason', override_value,
      'definitionId', definition_value::text,
      'evidenceTaskId', evidence_value::text,
      'ordinal', ordinal_value,
      'text', text_value,
      'verificationMethod', method_value
    ));
  END LOOP;
  RETURN result;
END;
$$ LANGUAGE plpgsql VOLATILE;

-- The semantic diff the card renders.  Per changed criterion it names WHICH one, HOW it changes,
-- and separately whether its completionCriterion and its verificationMethod moved -- the two
-- fields that decide, respectively, what kind of evidence settles it and who may produce that
-- evidence.  A one-button "confirm?" is exactly what this exists to prevent.
CREATE OR REPLACE FUNCTION project_criteria_proposal_diff(p_before JSONB, p_after JSONB)
RETURNS JSONB AS $$
DECLARE
  after_item JSONB;
  before_item JSONB;
  match JSONB;
  entry JSONB;
  changed JSONB := '[]'::jsonb;
  added INT := 0;
  removed INT := 0;
  modified INT := 0;
  unchanged INT := 0;
  text_changed BOOLEAN;
  trust_changed BOOLEAN;
  method_changed BOOLEAN;
  wiring_changed BOOLEAN;
  any_text BOOLEAN := false;
  any_trust BOOLEAN := false;
  any_method BOOLEAN := false;
  any_wiring BOOLEAN := false;
BEGIN
  FOR after_item IN SELECT value FROM jsonb_array_elements(p_after) LOOP
    SELECT value INTO match FROM jsonb_array_elements(p_before) value
     WHERE value->>'definitionId' = after_item->>'definitionId';
    IF match IS NULL THEN
      added := added + 1;
      any_text := true;
      any_trust := true;
      any_method := true;
      any_wiring := true;
      changed := changed || jsonb_build_array(jsonb_build_object(
        'changeKind', 'ADDED',
        'definitionId', after_item->>'definitionId',
        'completionCriterion', jsonb_build_object(
          'after', after_item->'completionCriterion', 'before', NULL),
        'completionCriterionChanged', true,
        'ordinal', jsonb_build_object('after', after_item->'ordinal', 'before', NULL),
        'summary', format('ADDED criterion %s (%s, verified by: %s)',
          after_item->>'text', after_item->>'completionCriterion',
          after_item->>'verificationMethod'),
        'text', jsonb_build_object('after', after_item->'text', 'before', NULL),
        'textChanged', true,
        'verificationMethod', jsonb_build_object(
          'after', after_item->'verificationMethod', 'before', NULL),
        'verificationMethodChanged', true
      ));
      CONTINUE;
    END IF;
    text_changed := (match->>'text') IS DISTINCT FROM (after_item->>'text');
    trust_changed := (match->>'completionCriterion')
      IS DISTINCT FROM (after_item->>'completionCriterion');
    method_changed := (match->>'verificationMethod')
      IS DISTINCT FROM (after_item->>'verificationMethod');
    wiring_changed := (match->>'acceptanceCommand')
        IS DISTINCT FROM (after_item->>'acceptanceCommand')
      OR (match->>'acceptanceExpectedExitCode')
        IS DISTINCT FROM (after_item->>'acceptanceExpectedExitCode')
      OR (match->>'evidenceTaskId') IS DISTINCT FROM (after_item->>'evidenceTaskId');
    IF NOT (text_changed OR trust_changed OR method_changed OR wiring_changed) THEN
      unchanged := unchanged + 1;
      CONTINUE;
    END IF;
    modified := modified + 1;
    any_text := any_text OR text_changed;
    any_trust := any_trust OR trust_changed;
    any_method := any_method OR method_changed;
    any_wiring := any_wiring OR wiring_changed;
    entry := jsonb_build_object(
      'changeKind', 'MODIFIED',
      'definitionId', after_item->>'definitionId',
      'completionCriterion', jsonb_build_object(
        'after', after_item->'completionCriterion', 'before', match->'completionCriterion'),
      'completionCriterionChanged', trust_changed,
      'evaluationWiringChanged', wiring_changed,
      'ordinal', jsonb_build_object('after', after_item->'ordinal', 'before', match->'ordinal'),
      'summary', concat_ws('; ',
        format('MODIFIED criterion %s', match->>'text'),
        CASE WHEN text_changed
          THEN format('text: %s -> %s', match->>'text', after_item->>'text') END,
        CASE WHEN trust_changed THEN format('completionCriterion: %s -> %s',
          match->>'completionCriterion', after_item->>'completionCriterion') END,
        CASE WHEN method_changed THEN format('verificationMethod: %s -> %s',
          match->>'verificationMethod', after_item->>'verificationMethod') END,
        CASE WHEN wiring_changed THEN 'evaluation wiring changed' END),
      'text', jsonb_build_object('after', after_item->'text', 'before', match->'text'),
      'textChanged', text_changed,
      'verificationMethod', jsonb_build_object(
        'after', after_item->'verificationMethod', 'before', match->'verificationMethod'),
      'verificationMethodChanged', method_changed
    );
    changed := changed || jsonb_build_array(entry);
  END LOOP;
  FOR before_item IN SELECT value FROM jsonb_array_elements(p_before) LOOP
    IF EXISTS (
      SELECT 1 FROM jsonb_array_elements(p_after) value
       WHERE value->>'definitionId' = before_item->>'definitionId'
    ) THEN CONTINUE; END IF;
    removed := removed + 1;
    any_text := true;
    any_trust := true;
    any_method := true;
    any_wiring := true;
    changed := changed || jsonb_build_array(jsonb_build_object(
      'changeKind', 'REMOVED',
      'definitionId', before_item->>'definitionId',
      'completionCriterion', jsonb_build_object(
        'after', NULL, 'before', before_item->'completionCriterion'),
      'completionCriterionChanged', true,
      'ordinal', jsonb_build_object('after', NULL, 'before', before_item->'ordinal'),
      'summary', format('REMOVED criterion %s (was %s, verified by: %s)',
        before_item->>'text', before_item->>'completionCriterion',
        before_item->>'verificationMethod'),
      'text', jsonb_build_object('after', NULL, 'before', before_item->'text'),
      'textChanged', true,
      'verificationMethod', jsonb_build_object(
        'after', NULL, 'before', before_item->'verificationMethod'),
      'verificationMethodChanged', true
    ));
  END LOOP;
  RETURN jsonb_build_object(
    'schemaVersion', 1,
    'after', p_after,
    'before', p_before,
    'changedCriteria', changed,
    'changedCriterionIds', COALESCE((
      SELECT jsonb_agg(value->>'definitionId' ORDER BY value->>'definitionId')
        FROM jsonb_array_elements(changed) value), '[]'::jsonb),
    'completionCriterionChanged', any_trust,
    'counts', jsonb_build_object(
      'added', added, 'after', jsonb_array_length(p_after),
      'before', jsonb_array_length(p_before), 'modified', modified,
      'removed', removed, 'unchanged', unchanged),
    'evaluationWiringChanged', any_wiring,
    'hasChange', (added + removed + modified) > 0,
    'semanticChange', any_text OR any_trust,
    'textChanged', any_text,
    'verificationMethodChanged', any_method
  );
END;
$$ LANGUAGE plpgsql IMMUTABLE;

-- The eight-item owner-decision protocol, built from the diff so no field can be a placeholder.
-- Callers may sharpen `whyNotAgent`, `recommendation`, `cost` and `deadline`; they may not empty
-- them, and they cannot supply `options`, `impacts` or `noActionConsequence` at all -- those state
-- what this system will and will not do, which is not the proposing agent's to describe.
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
      'Approving advances the completion contract digest, so the current Owner Ratification is '
      'replaced by the one this decision appends in the same transaction; %s acceptance '
      'criteria stand afterwards. Denying costs the proposing agent one round trip.',
      counts->>'after')),
    'deadline', COALESCE(NULLIF(btrim(COALESCE(p_overrides->>'deadline', '')), ''), format(
      'This card is shown until %s. Nothing is applied when it lapses: an unanswered proposal '
      'stays pending and the criteria in force do not move.',
      to_char(p_expires AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'))),
    'headline', headline,
    'impacts', jsonb_build_object(
      'APPROVE', format(
        'Applies exactly the %s criteria shown, in one transaction that also records your '
        'ratification of the resulting contract. %s',
        counts->>'after',
        CASE WHEN (p_diff->>'completionCriterionChanged')::boolean
          THEN 'At least one criterion changes how completion is PROVED, so evidence gathered '
               'under the old completionCriterion no longer settles it.'
          ELSE 'No criterion changes how completion is proved.' END),
      'DENY', 'Changes nothing. The criteria in force stay exactly as they are, the proposal is '
              'recorded as denied rather than dropped, and the agent can read why.'),
    'noActionConsequence',
      'Nothing is applied. The acceptance criteria in force remain the ones you already ratified, '
      'the proposal stays pending and visible, and no timeout, retry or resubmission can apply '
      'it without this decision.',
    'options', jsonb_build_array(
      jsonb_build_object('value', 'APPROVE',
        'label', 'Apply this criteria set and ratify the resulting contract'),
      jsonb_build_object('value', 'DENY',
        'label', 'Keep the criteria that are in force and record the refusal')),
    'reason', 'GOAL_DECISION',
    'recommendation', COALESCE(
      NULLIF(btrim(COALESCE(p_overrides->>'recommendation', '')), ''),
      'Read each changed criterion below, then approve only if this is still the standard you '
      'want this project measured against.'),
    'resumeBehavior',
      'On APPROVE, work paused on OWNER_RATIFICATION_REQUIRED re-enters guarded automatic '
      'admission under the newly ratified contract without a second click. On DENY, automatic '
      'side-effecting execution continues under the contract already in force.',
    'title', 'Change this project''s acceptance criteria?',
    'whyNotAgent', COALESCE(NULLIF(btrim(COALESCE(p_overrides->>'whyNotAgent', '')), ''),
      'An agent cannot move the standard it is measured against. Rewriting acceptance criteria '
      'is a goal decision, so the proposal is inert until the account owner approves it.')
  );
END;
$$ LANGUAGE plpgsql STABLE;

-- Record a proposal.  It writes ONE row and touches no acceptance definition: after this returns
-- the effective criteria, the contract digest and the standing ratification are byte-identical to
-- what they were before it was called.
CREATE OR REPLACE FUNCTION project_propose_acceptance_criteria(
  p_owner UUID,
  p_project UUID,
  p_actor_type TEXT,
  p_actor_id TEXT,
  p_proposal JSONB,
  p_idempotency_key TEXT
) RETURNS JSONB AS $$
DECLARE
  state "project_completion_contract"%ROWTYPE;
  existing "project_criteria_proposal"%ROWTYPE;
  superseded "project_criteria_proposal"%ROWTYPE;
  proposal_id UUID;
  next_generation BIGINT;
  before_items JSONB;
  after_items JSONB;
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
  PERFORM 1 FROM "project" WHERE "id" = p_project AND "owner_id" = p_owner FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'PROJECT_NOT_FOUND: project % is not owned by %', p_project, p_owner
      USING ERRCODE = 'raise_exception';
  END IF;
  PERFORM project_refresh_completion_contract(p_project, 'CRITERIA_PROPOSAL_READ');
  SELECT * INTO state FROM "project_completion_contract"
   WHERE "project_id" = p_project FOR UPDATE;

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
    'baseContractDigest', state."contract_digest"::text,
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
    "id", "project_id", "owner_id", "proposal_generation", "base_contract_digest",
    "base_contract_revision", "base_criteria", "proposed_criteria", "semantic_diff", "card",
    "card_digest", "input_digest", "proposed_by_type", "proposed_by_id",
    "proposal_idempotency_key", "expires_at"
  ) VALUES (
    proposal_id, p_project, p_owner, next_generation, state."contract_digest",
    state."contract_revision", before_items, after_items, diff, card,
    card_digest_value, input_digest_value, p_actor_type, p_actor_id,
    p_idempotency_key, expires
  );
  IF superseded."id" IS NOT NULL THEN
    UPDATE "project_criteria_proposal" SET "superseded_by_id" = proposal_id
     WHERE "id" = superseded."id";
  END IF;
  RETURN jsonb_build_object(
    'applied', false,
    'baseContractDigest', state."contract_digest"::text,
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

-- Write the approved set.  Private by construction: it takes no principal, so it can only ever be
-- correct when its ONE caller below has already established that an owner approved this exact
-- rendering.  Existing ordinals move out of the way first, exactly as the HTTP door does, so
-- swapping two criteria never transiently violates the unique (project, ordinal) index.
CREATE OR REPLACE FUNCTION project_apply_criteria_proposal(p_project UUID, p_items JSONB)
RETURNS VOID AS $$
DECLARE
  item JSONB;
  keep UUID[];
BEGIN
  SELECT COALESCE(array_agg((value->>'definitionId')::uuid), ARRAY[]::UUID[]) INTO keep
    FROM jsonb_array_elements(p_items) value;
  UPDATE "project_acceptance_criterion_definition"
     SET "ordinal" = "ordinal" + 1000000000 WHERE "project_id" = p_project;
  DELETE FROM "project_acceptance_criterion_definition"
   WHERE "project_id" = p_project AND NOT ("id" = ANY (keep));
  FOR item IN SELECT value FROM jsonb_array_elements(p_items) LOOP
    UPDATE "project_acceptance_criterion_definition"
       SET "ordinal" = (item->>'ordinal')::integer,
           "text" = item->>'text',
           "verification_method" = item->>'verificationMethod',
           "completion_criterion" = (item->>'completionCriterion')::"task_completion_criterion",
           "acceptance_command" = item->>'acceptanceCommand',
           "acceptance_expected_exit_code" = CASE
             WHEN jsonb_typeof(item->'acceptanceExpectedExitCode') = 'number'
             THEN (item->>'acceptanceExpectedExitCode')::integer END,
           "evidence_task_id" = CASE WHEN NULLIF(COALESCE(item->>'evidenceTaskId', ''), '') IS NULL
             THEN NULL ELSE (item->>'evidenceTaskId')::uuid END,
           "completion_criterion_override_reason" = item->>'completionCriterionOverrideReason'
     WHERE "id" = (item->>'definitionId')::uuid AND "project_id" = p_project;
    IF NOT FOUND THEN
      INSERT INTO "project_acceptance_criterion_definition" (
        "id", "project_id", "ordinal", "text", "verification_method", "completion_criterion",
        "acceptance_command", "acceptance_expected_exit_code", "evidence_task_id",
        "completion_criterion_override_reason", "content_hash"
      ) VALUES (
        (item->>'definitionId')::uuid, p_project, (item->>'ordinal')::integer, item->>'text',
        item->>'verificationMethod',
        (item->>'completionCriterion')::"task_completion_criterion",
        item->>'acceptanceCommand',
        CASE WHEN jsonb_typeof(item->'acceptanceExpectedExitCode') = 'number'
          THEN (item->>'acceptanceExpectedExitCode')::integer END,
        CASE WHEN NULLIF(COALESCE(item->>'evidenceTaskId', ''), '') IS NULL
          THEN NULL ELSE (item->>'evidenceTaskId')::uuid END,
        item->>'completionCriterionOverrideReason',
        repeat('0', 64)
      );
    END IF;
  END LOOP;
END;
$$ LANGUAGE plpgsql;

-- The owner's decision on a proposal.  Everything that makes this safe is in the first forty
-- lines: only OWNER, only against the digest of what was actually rendered, only while the base
-- contract has not moved underneath it.  APPROVE then does all three writes -- criteria, contract
-- refresh, ratification -- inside this one function call, so there is no instant in which the
-- project's criteria are a set nobody ratified.
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
  state "project_completion_contract"%ROWTYPE;
  request "project_owner_decision_request"%ROWTYPE;
  new_ratification_id UUID;
  request_id UUID;
  rearmed INT := 0;
BEGIN
  -- Unchanged and deliberately identical to the ratification door: an agent or runner holding a
  -- credential is not the owner, and no proposal path may become a way around that.
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
      'appliedContractDigest', receipt."applied_contract_digest"::text,
      'cardDigest', receipt."card_digest"::text, 'decision', receipt."decision",
      'duplicate', true, 'ok', true, 'proposalId', receipt."id",
      'ratificationId', receipt."ratification_id", 'status', receipt."status"
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

  PERFORM project_refresh_completion_contract(p_project, 'CRITERIA_PROPOSAL_DECISION_RECHECK');
  SELECT * INTO state FROM "project_completion_contract"
   WHERE "project_id" = p_project FOR UPDATE;
  IF proposal."base_contract_digest"::text IS DISTINCT FROM state."contract_digest"::text THEN
    RETURN jsonb_build_object(
      'code', 'CRITERIA_PROPOSAL_BASE_MOVED',
      'currentContractDigest', state."contract_digest"::text, 'ok', false,
      'proposalId', proposal."id",
      'requiredAction', 'the contract this proposal was drafted against has changed; ask for a '
                        'proposal against the current one'
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
  SELECT * INTO state FROM "project_completion_contract"
   WHERE "project_id" = p_project FOR UPDATE;
  SELECT * INTO request FROM "project_owner_decision_request"
   WHERE "project_id" = p_project AND "status" = 'PENDING'
     AND "contract_digest" = state."contract_digest" FOR UPDATE;
  IF NOT FOUND THEN
    request_id := project_ensure_owner_decision_request(
      p_project, 'CONTRACT_CHANGED', proposal."base_contract_digest", proposal."semantic_diff");
    SELECT * INTO request FROM "project_owner_decision_request" WHERE "id" = request_id FOR UPDATE;
  END IF;

  new_ratification_id := gen_random_uuid();
  INSERT INTO "project_owner_ratification" (
    "id", "project_id", "owner_id", "contract_digest", "evaluation_plan_digest_at_decision",
    "source", "ratified_by_type", "ratified_by_id", "decision_request_id", "idempotency_key"
  ) VALUES (
    new_ratification_id, p_project, p_owner, state."contract_digest",
    state."evaluation_plan_digest",
    'OWNER', 'OWNER', p_owner::text, request."id",
    'criteria-proposal:' || proposal."id"::text
  );
  UPDATE "project_owner_decision_request"
     SET "status" = 'APPROVED', "decision" = 'APPROVE',
         "decision_idempotency_key" = 'criteria-proposal:' || proposal."id"::text,
         "decided_at" = CURRENT_TIMESTAMP, "decided_by_type" = 'OWNER',
         "decided_by_id" = p_owner::text
   WHERE "id" = request."id";
  UPDATE "project_criteria_proposal"
     SET "status" = 'APPLIED', "decision" = 'APPROVE',
         "decision_idempotency_key" = p_idempotency_key,
         "decided_at" = CURRENT_TIMESTAMP, "decided_by_type" = 'OWNER',
         "decided_by_id" = p_owner::text,
         "applied_contract_digest" = state."contract_digest",
         "ratification_id" = new_ratification_id, "updated_at" = CURRENT_TIMESTAMP
   WHERE "id" = proposal."id";

  -- The same committed resume the ordinary approval performs, so "work continues" is a fact
  -- rather than a sentence on the card.
  WITH rearm AS (
    UPDATE "task_auto_dispatch_wakeup" wake
       SET "due_at" = LEAST(wake."due_at", clock_timestamp()), "updated_at" = clock_timestamp()
      FROM "task_auto_dispatch_state" dispatch_state,
           "task_auto_dispatch_obligation_revision" revision
     WHERE wake."tenant_id" = p_owner AND wake."project_id" = p_project
       AND wake."state" = 'PENDING'
       AND dispatch_state."tenant_id" = wake."tenant_id"
       AND dispatch_state."task_id" = wake."task_id"
       AND dispatch_state."watermark" = wake."watermark"
       AND dispatch_state."obligation_revision" = wake."obligation_revision"
       AND dispatch_state."state" = 'ACTIVE'
       AND revision."tenant_id" = dispatch_state."tenant_id"
       AND revision."task_id" = dispatch_state."task_id"
       AND revision."obligation_revision" = dispatch_state."obligation_revision"
       AND revision."reason_code" = 'OWNER_RATIFICATION_REQUIRED'
     RETURNING 1
  ) SELECT count(*)::int INTO rearmed FROM rearm;

  RETURN jsonb_build_object(
    'appliedContractDigest', state."contract_digest"::text,
    'atomic', true,
    'cardDigest', proposal."card_digest"::text,
    'decision', 'APPROVE',
    'decisionRequestId', request."id",
    'duplicate', false,
    'ok', true,
    'previousContractDigest', proposal."base_contract_digest"::text,
    'proposalId', proposal."id",
    'ratificationId', new_ratification_id,
    'ratified', project_owner_ratification_effective(p_project, state."contract_digest"),
    'rearmedWakeups', rearmed,
    'status', 'APPLIED'
  );
END;
$$ LANGUAGE plpgsql;

-- The owner-facing card, plus enough of the surrounding truth to prove the proposal has not moved
-- anything: what is in force right now, and what a decision would replace it with.
CREATE OR REPLACE FUNCTION project_criteria_proposal_state_json(p_owner UUID, p_project UUID)
RETURNS JSONB AS $$
DECLARE
  state "project_completion_contract"%ROWTYPE;
  proposal "project_criteria_proposal"%ROWTYPE;
  history JSONB;
BEGIN
  PERFORM 1 FROM "project" WHERE "id" = p_project AND "owner_id" = p_owner;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'PROJECT_NOT_FOUND' USING ERRCODE = 'raise_exception';
  END IF;
  PERFORM project_refresh_completion_contract(p_project, 'CRITERIA_PROPOSAL_STATE_READ');
  SELECT * INTO state FROM "project_completion_contract" WHERE "project_id" = p_project;
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
    'currentContractDigest', state."contract_digest"::text,
    'effectiveCriteria', project_criteria_proposal_effective_criteria(p_project),
    'history', history,
    'owner', 'OWNER',
    'projectId', p_project::text,
    'proposal', CASE WHEN proposal."id" IS NULL THEN NULL ELSE jsonb_build_object(
      'baseContractDigest', proposal."base_contract_digest"::text,
      'baseContractRevision', proposal."base_contract_revision"::text,
      'baseMatchesCurrentContract',
        proposal."base_contract_digest" = state."contract_digest",
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
    ) END,
    'ratified', project_owner_ratification_effective(p_project, state."contract_digest")
  );
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION project_owner_decide_criteria_proposal(
  UUID, UUID, TEXT, TEXT, UUID, TEXT, TEXT, TEXT
) IS
  'The only path that applies a criteria proposal: OWNER principal, exact rendered-card digest, '
  'unmoved base contract, and criteria + contract refresh + ratification in one transaction.';

COMMIT;
