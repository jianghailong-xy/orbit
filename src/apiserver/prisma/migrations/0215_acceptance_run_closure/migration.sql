-- 0215 · An acceptance run that can close.
--
-- Until now exactly one thing could ever happen to a `project_acceptance_run`: the next evidence set
-- arrived and superseded it. No path wrote a conclusion, so a run was not a judgment cycle with an
-- opening and a closing move — it was a snapshot slot that kept being reopened. The judging was
-- really being done by the per-criterion verdict projection beside it, which left two parallel
-- "verdicts" with one of them permanently spinning.
--
-- This migration gives the run its closing move, and then spends most of its length making sure that
-- move cannot be confused with, or forged by, the one move it already had:
--
--   * `conclusion_basis` is an enum with a single label. There is no column, and no function
--     parameter, through which free text or a caller's opinion can become a run's conclusion.
--   * supersession is write-once, and the two transitions are mutually exclusive per row: a
--     superseded run can never afterwards acquire a conclusion, and no single statement may do both.
--     "The next evidence set replaced you" and "you concluded" stay two different facts.
--   * concluding writes nothing to `project`. A run that concludes PASS says the stated criteria all
--     passed; it does not say the project is DONE, and `project_canonical_done_gate` — which never
--     reads these tables — remains the only wall in front of that status.

BEGIN;

-- ---------------------------------------------------------------------------------------------
-- 1 · The vocabulary. Three states, one conclusion basis, one obligation kind.
-- ---------------------------------------------------------------------------------------------

CREATE TYPE "project_acceptance_run_state" AS ENUM ('EVALUATING', 'CONCLUDED', 'SUPERSEDED');

-- One label, deliberately. A run concludes by mechanical derivation from its criterion projection
-- and the canonical DONE gate, or it does not conclude. Adding a second label here is the review
-- surface for anyone who wants a second way to decide an acceptance.
CREATE TYPE "project_acceptance_run_conclusion_basis" AS ENUM
  ('CRITERION_PROJECTION_AND_DONE_GATE');

CREATE TYPE "project_acceptance_run_obligation_kind" AS ENUM ('ACCEPTANCE_RUN_STALLED');

-- ---------------------------------------------------------------------------------------------
-- 2 · The columns. Constant defaults only, so the eight historical rows are not rewritten.
-- ---------------------------------------------------------------------------------------------

ALTER TABLE "project_acceptance_run"
  ADD COLUMN "conclusion_basis" "project_acceptance_run_conclusion_basis",
  ADD COLUMN "conclusion_digest" CHAR(64),
  ADD COLUMN "conclusion_window_seconds" INTEGER NOT NULL DEFAULT 172800;

COMMENT ON COLUMN "project_acceptance_run"."conclusion_basis" IS
  'Non-null exactly when this run concluded. The one basis a conclusion may have; no free-text entry exists.';
COMMENT ON COLUMN "project_acceptance_run"."conclusion_window_seconds" IS
  'The declared window this run has to conclude in. Past it the run is stalled and owes a typed obligation.';

ALTER TABLE "project_acceptance_run"
  ADD CONSTRAINT "project_acceptance_run_conclusion_chk" CHECK (
    "conclusion_basis" IS NULL
    OR ("verdict" IS NOT NULL AND "completed_at" IS NOT NULL AND "conclusion_digest" IS NOT NULL)
  ),
  ADD CONSTRAINT "project_acceptance_run_window_chk" CHECK ("conclusion_window_seconds" > 0);

-- 0127's terminal shape said: a run is open, or it is terminal, and terminal means "concluded at a
-- moment, with a digest of what it concluded". That is still exactly the rule. The only change is
-- that a conclusion reached through section 5 records its digest in `conclusion_digest` rather than
-- in the pre-0179 `result_digest`, so the clause now names both spellings of the same requirement.
ALTER TABLE "project_acceptance_run" DROP CONSTRAINT "project_acceptance_run_terminal_chk";
ALTER TABLE "project_acceptance_run" ADD CONSTRAINT "project_acceptance_run_terminal_chk"
  CHECK (("verdict" IS NULL AND "completed_at" IS NULL
            AND "result_digest" IS NULL AND "conclusion_digest" IS NULL)
      OR ("verdict" IS NOT NULL AND "completed_at" IS NOT NULL
            AND ("result_digest" IS NOT NULL OR "conclusion_digest" IS NOT NULL)));

-- ---------------------------------------------------------------------------------------------
-- 3 · Supersession and conclusion may not impersonate each other.
-- ---------------------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION project_acceptance_run_closure_guard() RETURNS TRIGGER AS $$
BEGIN
  -- A conclusion is a terminal fact about a stated condition. `project_acceptance_run_immutable`
  -- already freezes the row once `verdict` is written; these two columns arrived after it.
  IF OLD."conclusion_basis" IS NOT NULL AND (
       NEW."conclusion_basis" IS DISTINCT FROM OLD."conclusion_basis"
    OR NEW."conclusion_digest" IS DISTINCT FROM OLD."conclusion_digest") THEN
    RAISE EXCEPTION
      'ACCEPTANCE_RUN_CONCLUSION_IMMUTABLE: run % concluded %; its conclusion may not be rewritten',
      OLD."id", OLD."verdict" USING ERRCODE = 'raise_exception';
  END IF;

  -- Which evidence set replaced this one, and when, is history. Write-once, never edited.
  IF OLD."superseded_at" IS NOT NULL AND (
       NEW."superseded_at" IS DISTINCT FROM OLD."superseded_at"
    OR NEW."superseded_reason" IS DISTINCT FROM OLD."superseded_reason") THEN
    RAISE EXCEPTION
      'ACCEPTANCE_RUN_SUPERSESSION_IMMUTABLE: run % was superseded at % (%); that record may not be rewritten',
      OLD."id", OLD."superseded_at", COALESCE(OLD."superseded_reason", 'no reason recorded')
      USING ERRCODE = 'raise_exception';
  END IF;

  -- Being replaced is not a verdict. A run that was superseded without concluding stays that way:
  -- it cannot be back-filled later into something that reads as though it had decided anything.
  IF OLD."superseded_at" IS NOT NULL AND (
       NEW."conclusion_basis" IS DISTINCT FROM OLD."conclusion_basis"
    OR NEW."verdict" IS DISTINCT FROM OLD."verdict"
    OR NEW."completed_at" IS DISTINCT FROM OLD."completed_at"
    OR NEW."conclusion_digest" IS DISTINCT FROM OLD."conclusion_digest") THEN
    RAISE EXCEPTION
      'ACCEPTANCE_RUN_SUPERSEDED_CANNOT_CONCLUDE: run % was superseded at % and cannot acquire a conclusion',
      OLD."id", OLD."superseded_at" USING ERRCODE = 'raise_exception';
  END IF;

  -- ...and no single statement may perform both transitions, which is what keeps them two states
  -- rather than two spellings of one.
  IF NEW."superseded_at" IS DISTINCT FROM OLD."superseded_at"
     AND (NEW."conclusion_basis" IS DISTINCT FROM OLD."conclusion_basis"
       OR NEW."verdict" IS DISTINCT FROM OLD."verdict"
       OR NEW."completed_at" IS DISTINCT FROM OLD."completed_at") THEN
    RAISE EXCEPTION
      'ACCEPTANCE_RUN_SUPERSESSION_IS_NOT_A_CONCLUSION: run % may be superseded or concluded, not both in one write',
      OLD."id" USING ERRCODE = 'raise_exception';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER project_acceptance_run_closure_guard
  BEFORE UPDATE ON "project_acceptance_run"
  FOR EACH ROW EXECUTE FUNCTION project_acceptance_run_closure_guard();

-- ---------------------------------------------------------------------------------------------
-- 4 · The derivation. Pure, one parameter, no opinion accepted.
-- ---------------------------------------------------------------------------------------------
--
-- The only input a caller supplies is which run. Everything else is read: the run's frozen criterion
-- snapshot, the append-only conclusion ledger projected onto that evidence version (the same rule
-- the service's read face uses), and the canonical DONE gate. Same database state in, same jsonb —
-- including the same `conclusionDigest` — out.

CREATE OR REPLACE FUNCTION project_acceptance_run_derive_conclusion(p_run uuid)
RETURNS jsonb AS $$
DECLARE
  run "project_acceptance_run"%ROWTYPE;
  criteria_value jsonb;
  undecided_value jsonb;
  total_count integer;
  undecided_count integer;
  pass_count integer;
  fail_count integer;
  derived_verdict text;
  gate_value jsonb;
  gate_view jsonb;
  body jsonb;
BEGIN
  SELECT * INTO run FROM "project_acceptance_run" WHERE "id" = p_run;
  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'schemaVersion', 1, 'runId', p_run::text, 'concludable', false, 'verdict', NULL,
      'basis', 'CRITERION_PROJECTION_AND_DONE_GATE',
      'reasonCode', 'ACCEPTANCE_RUN_NOT_FOUND'
    );
  END IF;

  WITH snapshot AS (
    SELECT c."ordinal", c."criterion_key", c."definition_id", c."definition_revision",
           CASE WHEN c."definition_id" IS NOT NULL AND c."definition_revision" IS NOT NULL
                THEN 'def:' || c."definition_id"::text || ':' || c."definition_revision"::text
                ELSE 'key:' || c."criterion_key" END AS match_key
      FROM "project_acceptance_criterion" c
     WHERE c."run_id" = run."id"
  ), ledger AS (
    SELECT DISTINCT ON (match_key) match_key, "verdict", "decided_at"
      FROM (
        SELECT CASE WHEN e."definition_id" IS NOT NULL AND e."definition_revision" IS NOT NULL
                    THEN 'def:' || e."definition_id"::text || ':' || e."definition_revision"::text
                    ELSE 'key:' || e."criterion_key" END AS match_key,
               e."verdict", e."decided_at", e."evidence_version", e."id"
          FROM "project_acceptance_conclusion" e
         WHERE e."project_id" = run."project_id" AND e."evidence_version" <= run."attempt"
      ) events
     ORDER BY match_key, "evidence_version" DESC, "decided_at" DESC, "id" DESC
  ), projected AS (
    SELECT s."ordinal", s."criterion_key", s."definition_id", s."definition_revision", l."verdict"
      FROM snapshot s LEFT JOIN ledger l ON l.match_key = s.match_key
  )
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
             'ordinal', p."ordinal",
             'criterionKey', p."criterion_key",
             'definitionId', p."definition_id"::text,
             'definitionRevision', p."definition_revision",
             'verdict', p."verdict"::text
           ) ORDER BY p."ordinal"), '[]'::jsonb),
         COALESCE(jsonb_agg(p."ordinal" ORDER BY p."ordinal")
                    FILTER (WHERE p."verdict" IS NULL), '[]'::jsonb),
         count(*)::integer,
         count(*) FILTER (WHERE p."verdict" IS NULL)::integer,
         count(*) FILTER (WHERE p."verdict" = 'PASS')::integer,
         count(*) FILTER (WHERE p."verdict" = 'FAIL')::integer
    INTO criteria_value, undecided_value, total_count, undecided_count, pass_count, fail_count
    FROM projected p;

  IF total_count = 0 THEN
    derived_verdict := NULL;
  ELSIF undecided_count > 0 THEN
    derived_verdict := NULL;
  ELSIF pass_count = total_count THEN
    derived_verdict := 'PASS';
  ELSIF fail_count > 0 THEN
    derived_verdict := 'FAIL';
  ELSE
    derived_verdict := 'INCONCLUSIVE';
  END IF;

  -- The canonical gate is read, never supplied. Only its stable decision fields are folded in, so
  -- repeating the derivation over an unchanged world reproduces the digest exactly.
  gate_value := project_canonical_done_gate(run."project_id", 'PROJECT', run."project_id"::text);
  gate_view := jsonb_build_object(
    'decision', gate_value->>'decision',
    'allowed', COALESCE((gate_value->>'allowed')::boolean, false),
    'staleness', gate_value->>'staleness',
    'reasonCode', gate_value#>>'{reason,code}',
    'proofDigest', gate_value#>>'{canonicalIdentity,proofDigest}'
  );

  body := jsonb_build_object(
    'schemaVersion', 1,
    'runId', run."id"::text,
    'projectId', run."project_id"::text,
    'attempt', run."attempt"::text,
    'acceptanceEpoch', run."acceptance_epoch"::text,
    'criteriaRevision', run."criteria_revision",
    'inputDigest', run."input_digest",
    'basis', 'CRITERION_PROJECTION_AND_DONE_GATE'::"project_acceptance_run_conclusion_basis"::text,
    'concludable', derived_verdict IS NOT NULL,
    'reasonCode', CASE
      WHEN total_count = 0 THEN 'ACCEPTANCE_RUN_STATES_NO_CRITERIA'
      WHEN undecided_count > 0 THEN 'ACCEPTANCE_RUN_CRITERIA_UNDECIDED'
      ELSE 'ACCEPTANCE_RUN_CRITERION_PROJECTION_COMPLETE' END,
    'verdict', derived_verdict,
    'criteria', criteria_value,
    'undecidedOrdinals', undecided_value,
    'doneGate', gate_view,
    -- Said in the payload as well as in the code: a run conclusion is not a project status write.
    'projectStatusEffect', 'NONE',
    'projectDoneChannel', 'ACCOUNT_OWNER'
  );
  RETURN body || jsonb_build_object('conclusionDigest', outcome_sha256_json(body));
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION project_acceptance_run_derive_conclusion(uuid) IS
  'Mechanically derives a run conclusion from its criterion projection plus project_canonical_done_gate. Its one parameter is the run id: no caller-supplied verdict, summary or free text can enter.';

-- ---------------------------------------------------------------------------------------------
-- 5 · The one conclusion writer.
-- ---------------------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION project_acceptance_run_conclude(p_run uuid)
RETURNS jsonb AS $$
DECLARE
  run "project_acceptance_run"%ROWTYPE;
  derivation jsonb;
  concluded_at timestamptz;
BEGIN
  SELECT * INTO run FROM "project_acceptance_run" WHERE "id" = p_run FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'schemaVersion', 1, 'runId', p_run::text, 'wrote', false, 'state', NULL,
      'rejectionCode', 'ACCEPTANCE_RUN_NOT_FOUND'
    );
  END IF;

  -- Being superseded is the other transition, and it is terminal in its own right.
  IF run."superseded_at" IS NOT NULL AND run."conclusion_basis" IS NULL THEN
    RETURN jsonb_build_object(
      'schemaVersion', 1, 'runId', p_run::text, 'wrote', false,
      'state', 'SUPERSEDED'::"project_acceptance_run_state"::text,
      'verdict', NULL, 'completedAt', NULL,
      'rejectionCode', 'ACCEPTANCE_RUN_SUPERSEDED_CANNOT_CONCLUDE',
      'supersededAt', to_jsonb(run."superseded_at"),
      'supersededReason', run."superseded_reason"
    );
  END IF;

  IF run."conclusion_basis" IS NOT NULL THEN
    RETURN jsonb_build_object(
      'schemaVersion', 1, 'runId', p_run::text, 'wrote', false,
      'state', 'CONCLUDED'::"project_acceptance_run_state"::text,
      'verdict', run."verdict"::text, 'completedAt', to_jsonb(run."completed_at"),
      'conclusionDigest', run."conclusion_digest",
      'rejectionCode', 'ACCEPTANCE_RUN_ALREADY_CONCLUDED',
      'projectStatusEffect', 'NONE'
    );
  END IF;

  derivation := project_acceptance_run_derive_conclusion(p_run);
  IF NOT COALESCE((derivation->>'concludable')::boolean, false) THEN
    RETURN jsonb_build_object(
      'schemaVersion', 1, 'runId', p_run::text, 'wrote', false,
      'state', 'EVALUATING'::"project_acceptance_run_state"::text,
      'verdict', NULL, 'completedAt', NULL,
      'rejectionCode', derivation->>'reasonCode',
      'derivation', derivation
    );
  END IF;

  concluded_at := now();
  UPDATE "project_acceptance_run"
     SET "verdict" = (derivation->>'verdict')::"project_acceptance_verdict",
         "completed_at" = concluded_at,
         "conclusion_basis" =
           'CRITERION_PROJECTION_AND_DONE_GATE'::"project_acceptance_run_conclusion_basis",
         "conclusion_digest" = derivation->>'conclusionDigest'
   WHERE "id" = p_run;

  -- 'run_finalized' is the existing closed-vocabulary name for "this run reached its conclusion",
  -- and that is what happened. The derivation in `detail` says which basis reached it.
  INSERT INTO "project_acceptance_audit" ("id", "project_id", "kind", "run_id", "reason", "detail")
  VALUES (gen_random_uuid(), run."project_id", 'run_finalized', run."id",
          derivation->>'verdict', derivation);

  RETURN jsonb_build_object(
    'schemaVersion', 1, 'runId', p_run::text, 'wrote', true,
    'state', 'CONCLUDED'::"project_acceptance_run_state"::text,
    'verdict', derivation->>'verdict',
    'completedAt', to_jsonb(concluded_at),
    'conclusionDigest', derivation->>'conclusionDigest',
    'rejectionCode', NULL,
    'derivation', derivation,
    'projectStatusEffect', 'NONE',
    'projectDoneChannel', 'ACCOUNT_OWNER'
  );
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION project_acceptance_run_conclude(uuid) IS
  'The only writer of a run conclusion. Writes verdict, completed_at, conclusion_basis and conclusion_digest on the run and nothing else; project status is not this function business.';

-- ---------------------------------------------------------------------------------------------
-- 6 · The read model. Three states that a reader can tell apart.
-- ---------------------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION project_acceptance_run_state_value(
  p_run uuid, p_now timestamptz DEFAULT now()
) RETURNS jsonb AS $$
DECLARE
  run "project_acceptance_run"%ROWTYPE;
  state_value text;
  open_seconds bigint;
BEGIN
  SELECT * INTO run FROM "project_acceptance_run" WHERE "id" = p_run;
  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'schemaVersion', 1, 'runId', p_run::text, 'state', NULL,
      'reasonCode', 'ACCEPTANCE_RUN_NOT_FOUND'
    );
  END IF;

  -- A conclusion outranks a later supersession: the run did decide something, and a reader has to
  -- be able to see that. A run that never concluded and was replaced reads SUPERSEDED and carries
  -- no verdict and no completion time, so "the next one pushed me out" can never be read as "I
  -- decided".
  state_value := CASE
    WHEN run."conclusion_basis" IS NOT NULL
      THEN 'CONCLUDED'::"project_acceptance_run_state"::text
    WHEN run."superseded_at" IS NOT NULL
      THEN 'SUPERSEDED'::"project_acceptance_run_state"::text
    ELSE 'EVALUATING'::"project_acceptance_run_state"::text END;
  open_seconds := GREATEST(
    0, floor(EXTRACT(EPOCH FROM (p_now - run."started_at")))::bigint
  );

  RETURN jsonb_build_object(
    'schemaVersion', 1,
    'runId', run."id"::text,
    'projectId', run."project_id"::text,
    'attempt', run."attempt"::text,
    'state', state_value,
    'concluded', run."conclusion_basis" IS NOT NULL,
    'superseded', run."superseded_at" IS NOT NULL,
    'evaluating', run."conclusion_basis" IS NULL AND run."superseded_at" IS NULL,
    'verdict', run."verdict"::text,
    'conclusionBasis', run."conclusion_basis"::text,
    'conclusionDigest', run."conclusion_digest",
    'completedAt', to_jsonb(run."completed_at"),
    'startedAt', to_jsonb(run."started_at"),
    'supersededAt', to_jsonb(run."superseded_at"),
    'supersededReason', run."superseded_reason",
    'windowSeconds', run."conclusion_window_seconds",
    'openForSeconds', open_seconds,
    'stalled', run."conclusion_basis" IS NULL AND run."superseded_at" IS NULL
               AND open_seconds > run."conclusion_window_seconds",
    'criteriaRevision', run."criteria_revision"
  );
END;
$$ LANGUAGE plpgsql STABLE;

CREATE OR REPLACE FUNCTION project_acceptance_run_states(
  p_project uuid, p_now timestamptz DEFAULT now()
) RETURNS jsonb AS $$
  SELECT COALESCE(jsonb_agg(project_acceptance_run_state_value(r."id", p_now)
                            ORDER BY r."attempt"), '[]'::jsonb)
    FROM "project_acceptance_run" r WHERE r."project_id" = p_project
$$ LANGUAGE sql STABLE;

-- ---------------------------------------------------------------------------------------------
-- 7 · A run that never closes owes something, out loud.
-- ---------------------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION project_acceptance_run_stalled_obligations(
  p_project uuid, p_now timestamptz DEFAULT now()
) RETURNS jsonb AS $$
  SELECT COALESCE(jsonb_agg(obligation ORDER BY attempt), '[]'::jsonb)
    FROM (
      SELECT r."attempt" AS attempt, jsonb_build_object(
               'schemaVersion', 1,
               'kind', 'ACCEPTANCE_RUN_STALLED'::"project_acceptance_run_obligation_kind"::text,
               'obligationId', r."id"::text,
               'runId', r."id"::text,
               'projectId', r."project_id"::text,
               'attempt', r."attempt"::text,
               'state', 'EVALUATING'::"project_acceptance_run_state"::text,
               'openedAt', to_jsonb(r."started_at"),
               'windowSeconds', r."conclusion_window_seconds",
               'openForSeconds', floor(EXTRACT(EPOCH FROM (p_now - r."started_at")))::bigint,
               'overdueBySeconds',
                 floor(EXTRACT(EPOCH FROM (p_now - r."started_at")))::bigint
                   - r."conclusion_window_seconds",
               'undecidedOrdinals',
                 project_acceptance_run_derive_conclusion(r."id")->'undecidedOrdinals',
               'owner', 'COORDINATOR',
               'actor', 'COORDINATOR',
               'nextAction', 'acceptance.run.conclude-or-supersede',
               'blocksGate', false
             ) AS obligation
        FROM "project_acceptance_run" r
       WHERE r."project_id" = p_project
         AND r."conclusion_basis" IS NULL
         AND r."superseded_at" IS NULL
         AND floor(EXTRACT(EPOCH FROM (p_now - r."started_at")))::bigint
             > r."conclusion_window_seconds"
    ) stalled
$$ LANGUAGE sql;

COMMENT ON FUNCTION project_acceptance_run_stalled_obligations(uuid, timestamptz) IS
  'Runs still evaluating past their declared window, as typed ACCEPTANCE_RUN_STALLED obligations. Silence is what this replaces.';

COMMIT;
