-- Obligation algebra, canonical DONE gate and delivery attestation removal
-- (0194, 0195-evaluator, 0196 x2, 0197, 0198-delivery, 0199-actor-surfaces).
--
-- Seven migrations totalling 6,019 lines of SQL built a canonical fact ingress with an authority
-- matrix, an evaluator that reduced those facts to obligations, a shadow projection reconciler in
-- its own schema, a binding-version invalidation ledger, a canonical obligation DONE gate that
-- REPLACED the project acceptance gate, and a delivery attestation store that fed it:
--
--   0194_outcome_canonical_fact_ingress            1,112 lines   9 tables, 1 view, 14 functions
--   0195_outcome_evaluator_obligation_reduction      577 lines   4 tables, 1 view, 1 function
--   0196_obligation_projection_shadow_reconciler   1,223 lines   schema outcome_projection
--   0196_outcome_binding_version_invalidation      1,194 lines   7 surviving tables, 3 views
--   0197_canonical_obligation_done_gate            1,074 lines   the gate, and its INSERT trigger
--   0198_outcome_delivery_attestation                661 lines   3 tables, 4 functions
--   0199_outcome_actor_surfaces                      178 lines   already gone with 0198's table
--
-- The three are removed in one migration because they are one chain: delivery attestation feeds
-- the canonical DONE gate (0197's DELIVERY_ATTESTATION_MISSING), the gate reads the projection,
-- the projection reduces the evaluator's obligations, and the evaluator reduces the canonical
-- facts. Removing any one of them alone leaves a dangling half.
--
-- WHAT STILL DECIDES A PROJECT'S DONE. `project_acceptance_done_gate` — the trigger 0150 created
-- and 0197 hollowed out with `CREATE OR REPLACE` — is restored here to the acceptance-only body it
-- had before 0197, so a project still needs a PASS acceptance run that belongs to it, is not
-- superseded, and was concluded in the project's current acceptance epoch. Section 1 below is that
-- restoration; the trigger's NAME and FIRING ORDER are untouched, because
-- `project_acceptance_advance_epoch` sorting before `project_acceptance_done_gate` is what stops
-- `UPDATE project SET status='DONE', acceptance_epoch=0` from gating against a zero the advance
-- trigger is about to overwrite. `project_acceptance_epoch_audit` (0150) and
-- `project_acceptance_criteria_fact` (0172) are not touched at all.
--
-- Five 0194 helpers are DELIBERATELY KEPT, because subsystems that this task must not break
-- adopted them after 0194 shipped and they are the only definition of those helpers in the schema:
--
--   outcome_append_only_guard()  12 triggers on task_executable_attempt, task_executable_diagnosis,
--                                failure_continuation_*, failure_successor_*, executable_runtime_*
--                                and executable_dead_man_event use it as their append-only guard.
--   outcome_sha256_json(jsonb)   14 kept functions and 2 kept CHECK constraints
--                                (executable_runtime_expectation, failure_continuation_route_decision)
--   outcome_canonical_json(jsonb), outcome_canonical_number(jsonb)
--                                the two helpers outcome_sha256_json is defined in terms of
--   outcome_valid_digest(text)   CHECK constraints on executable_dead_man_event,
--                                executable_runtime_expectation(_event), project_completion_contract,
--                                project_criteria_proposal, task_auto_dispatch_obligation_revision
--
-- Dropping them would take down `task_executable_*` and `failure_continuation_*`, which this task
-- is explicitly forbidden to touch. They are generic, zero-line-of-business helpers; re-homing them
-- under new names would rewrite twelve triggers and seven CHECK constraints on protected tables to
-- gain nothing. `outcome_jsonb_exact_keys` had no reader outside this removal set and IS dropped.
--
-- Deliberately NOT removed: every `project_acceptance_*` relation (306 criterion definitions, 313
-- criteria, 152 conclusions, runs and verdicts); the four project triggers named above;
-- `task_executable_attempt` / `task_executable_admission`; `failure_continuation_*` /
-- `failure_successor_*`; `task_done_canonical_writer_fence` (0193); the 0200/0202 EXECUTABLE
-- acceptance runtime; `project_ratified_action_intent` and its `contract_revision` column, which
-- 0218's surviving `_v1` action bodies read.
--
-- Rows this deletes, counted on the deployment on 2026-09-02: outcome_canonical_fact 60,
-- outcome_obligation_revision 79, outcome_evaluator_result 65, outcome_fact_authority_grant 29,
-- outcome_reconcile_request 65, outcome_delivery_attestation 12. Nothing is archived: the decision
-- is to delete the machinery, and a copy of an obligation ledger with no evaluator is not evidence.
BEGIN;

-- ---------------------------------------------------------------------------------------------
-- 1 · The project acceptance DONE gate goes back to deciding on acceptance evidence.
--
--     0197 replaced 0150's body with a two-line delegation to `project_canonical_done_gate` and
--     added a second trigger so INSERT hit it too. Both go. The body below is 0195's — the last
--     one before 0197 — with two differences, each of which restores something 0195/0189 had
--     merged away rather than inventing anything:
--
--       * the owner-ratification clause is not carried over: 0218 removed
--         `project_owner_ratification_effective` along with the whole approval queue.
--       * a superseded run and a stale epoch raise ACCEPTANCE_EVIDENCE_STALE rather than being
--         folded into ACCEPTANCE_MISSING, which is 0182's distinction and the one
--         `project-provenance-epoch.spec.ts` has asserted 0150's text for all along: "your
--         evidence is about a world that is no longer this one" already has a code.
--
--     What "the run did not PASS" means is the criterion projection, not the run's `verdict`
--     summary column, and that is 0185's decision rather than a new one. A concluded run is
--     immutable and conclusions are append-only events, so a run whose summary says FAIL can have a
--     current projection in which every criterion is PASS — a later event refuted the failure. 0182
--     read the summary because it predated those events; reading it again here would make a project
--     that fixed what it failed permanently unclosable behind a row nothing is allowed to rewrite.
-- ---------------------------------------------------------------------------------------------

DROP TRIGGER "project_acceptance_done_insert_gate" ON "project";

CREATE OR REPLACE FUNCTION project_acceptance_done_gate() RETURNS TRIGGER AS $$
DECLARE
  run             "project_acceptance_run"%ROWTYPE;
  criterion_count INTEGER;
  unmet_criteria  TEXT;
  open_blocker    INTEGER;
  open_defect     INTEGER;
BEGIN
  IF NEW."status" <> 'DONE' OR OLD."status" = 'DONE' THEN RETURN NEW; END IF;

  IF NEW."accepted_run_id" IS NULL THEN
    IF NEW."legacy_accepted_at" IS NOT NULL THEN
      IF NEW."acceptance_epoch" > 0 THEN
        RAISE EXCEPTION
          'ACCEPTANCE_EVIDENCE_STALE: project % was reopened after its legacy DONE (epoch %); its next DONE needs a real acceptance run',
          NEW."id", NEW."acceptance_epoch" USING ERRCODE = 'raise_exception';
      END IF;
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'ACCEPTANCE_MISSING: project % has no current evidence version', NEW."id"
      USING ERRCODE = 'raise_exception';
  END IF;

  SELECT * INTO run FROM "project_acceptance_run" WHERE "id" = NEW."accepted_run_id";
  IF NOT FOUND OR run."project_id" <> NEW."id" THEN
    RAISE EXCEPTION 'ACCEPTANCE_MISSING: evidence version % does not belong to project %',
      NEW."accepted_run_id", NEW."id" USING ERRCODE = 'raise_exception';
  END IF;
  IF run."superseded_at" IS NOT NULL THEN
    RAISE EXCEPTION 'ACCEPTANCE_EVIDENCE_STALE: acceptance run % was superseded at %',
      run."id", run."superseded_at" USING ERRCODE = 'raise_exception';
  END IF;
  -- Read AFTER `project_acceptance_advance_epoch` has already pinned NEW."acceptance_epoch" for
  -- this statement: alphabetical order among BEFORE ROW triggers is what makes this comparison
  -- about the epoch the transition implies rather than the one the statement happened to name.
  IF run."acceptance_epoch" IS DISTINCT FROM NEW."acceptance_epoch" THEN
    RAISE EXCEPTION
      'ACCEPTANCE_EVIDENCE_STALE: acceptance run % passed in epoch %, and this project is now in epoch % — it was reopened after that run',
      run."id", run."acceptance_epoch", NEW."acceptance_epoch" USING ERRCODE = 'raise_exception';
  END IF;
  SELECT count(*) INTO criterion_count FROM "project_acceptance_criterion_definition"
   WHERE "project_id" = NEW."id";
  IF criterion_count = 0 THEN
    RAISE EXCEPTION 'ACCEPTANCE_MISSING: project % states no acceptance criteria', NEW."id"
      USING ERRCODE = 'raise_exception';
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
  'The 0150 project acceptance DONE gate. A DONE needs an acceptance run that belongs to this project, is not superseded, passed in the project''s current acceptance epoch, concluded PASS, and leaves no non-PASS criterion, open blocker or unresolved verification failure.';

-- ---------------------------------------------------------------------------------------------
-- 2 · Kept readers of the canonical gate are rewired before anything is dropped.
-- ---------------------------------------------------------------------------------------------

-- 0215's run conclusion folded the canonical gate's decision fields into its body and therefore
-- into `conclusionDigest`. With the gate gone the derivation is exactly its criterion projection.
-- The `conclusion_basis` enum keeps its single CRITERION_PROJECTION_AND_DONE_GATE label: it is
-- written into stored `project_acceptance_run` rows, and renaming an enum label rewrites neither
-- those rows' meaning nor the plpgsql bodies that spell it.
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
    -- Said in the payload as well as in the code: a run conclusion is not a project status write.
    'projectStatusEffect', 'NONE',
    'projectDoneChannel', 'ACCOUNT_OWNER'
  );
  RETURN body || jsonb_build_object('conclusionDigest', outcome_sha256_json(body));
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION project_acceptance_run_derive_conclusion(uuid) IS
  'Mechanically derives a run conclusion from its criterion projection. Its one parameter is the run id: no caller-supplied verdict, summary or free text can enter. Whether the PROJECT may go DONE is the 0150 acceptance trigger''s answer, taken inside the write that asks.';

-- 0196 wrapped 0195's two ratified-action entry points with a binding/authority fence over the
-- fact stream and delegated the rest to the bodies 0218 kept under `_v1`. With the stream gone the
-- fence has nothing to read — every clause of it was already inside `IF FOUND` on that table — so
-- each wrapper becomes the delegation it always ended with.
CREATE OR REPLACE FUNCTION project_submit_ratified_action(
  p_owner UUID,
  p_project UUID,
  p_principal_type TEXT,
  p_principal_id TEXT,
  p_trigger_kind TEXT,
  p_action JSONB,
  p_idempotency_key TEXT
) RETURNS JSONB AS $$
BEGIN
  RETURN project_submit_ratified_action_v1(
    p_owner, p_project, p_principal_type, p_principal_id, p_trigger_kind,
    p_action, p_idempotency_key
  );
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION project_commit_ratified_action(
  p_owner UUID,
  p_project UUID,
  p_intent UUID,
  p_commit_token UUID
) RETURNS JSONB AS $$
BEGIN
  RETURN project_commit_ratified_action_v1(p_owner, p_project, p_intent, p_commit_token);
END;
$$ LANGUAGE plpgsql;

-- The BEFORE INSERT trigger 0196 put on the intent table did two things: it pinned
-- `contract_revision`, which 0218's `_v1` bodies still compare, and it bound the outcome binding
-- digest/epoch/watermark. Only the second half is 0196's to remove, so the trigger keeps its name
-- and its subject and loses the fact-stream lock it used to take.
CREATE OR REPLACE FUNCTION project_action_intent_bind_full_revision() RETURNS trigger AS $$
DECLARE
  current_revision bigint;
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
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

ALTER TABLE "project_ratified_action_intent"
  DROP COLUMN "outcome_binding_digest",
  DROP COLUMN "outcome_binding_epoch",
  DROP COLUMN "outcome_watermark_logical_time";

-- ---------------------------------------------------------------------------------------------
-- 3 · The canonical DONE gate itself (0197), and the operational surface that only it reached.
-- ---------------------------------------------------------------------------------------------

DROP FUNCTION project_canonical_done_gate(uuid, text, text);
DROP FUNCTION project_canonical_done_gate_projection_integrity_body(uuid, text, text);
DROP FUNCTION outcome_operational_read_surface(uuid, uuid, text, text, text);

-- ---------------------------------------------------------------------------------------------
-- 4 · The shadow projection reconciler (0196). Its seven tables, two triggers and eighteen
--     functions live in one schema of their own, so the schema is the unit.
-- ---------------------------------------------------------------------------------------------

DROP SCHEMA outcome_projection CASCADE;

-- ---------------------------------------------------------------------------------------------
-- 5 · Views first, then relations child-before-parent. PostgreSQL drops each table's triggers,
--     indexes, CHECK constraints and foreign keys with it.
-- ---------------------------------------------------------------------------------------------

DROP VIEW outcome_current_evaluation_projection;
DROP VIEW outcome_current_evaluator_result;
DROP VIEW outcome_current_reconcile_request;
DROP VIEW outcome_obligation_successor_set;

DROP TABLE outcome_delivery_verification;
DROP TABLE outcome_delivery_attestation;
DROP TABLE outcome_delivery_binding;

DROP TABLE outcome_obligation_successor;
DROP TABLE outcome_obligation_reduction;
DROP TABLE outcome_obsolete_obligation;
DROP TABLE outcome_proof_successor;
DROP TABLE outcome_proof_obsolescence;
DROP TABLE outcome_binding_transition;
DROP TABLE outcome_reconcile_request;

DROP TABLE outcome_active_obligation;
DROP TABLE outcome_obligation_event;
DROP TABLE outcome_obligation_revision;
DROP TABLE outcome_evaluator_result;

DROP TABLE outcome_evaluation_projection;
DROP TABLE outcome_evaluation_cut_fact;
DROP TABLE outcome_evaluation_cut;
DROP TABLE outcome_canonical_fact;
DROP TABLE outcome_fact_authority_revocation;
DROP TABLE outcome_fact_authority_grant;
DROP TABLE outcome_fact_authority_matrix;
DROP TABLE outcome_fact_binding;
DROP TABLE outcome_fact_stream;

-- ---------------------------------------------------------------------------------------------
-- 6 · The stored functions those relations were the whole subject of.
-- ---------------------------------------------------------------------------------------------

DROP FUNCTION outcome_record_delivery_verification(uuid, uuid, text, jsonb);
DROP FUNCTION outcome_record_delivery_attestation(uuid, uuid, text, jsonb);
DROP FUNCTION outcome_register_delivery_binding(uuid, uuid, jsonb);
DROP FUNCTION outcome_read_delivery_evidence(uuid, uuid, text);

DROP FUNCTION outcome_authority_revocation_invalidates_reduction();
DROP FUNCTION outcome_matching_fact_invalidates_reduction();
DROP FUNCTION outcome_binding_transition_record();
DROP FUNCTION outcome_obsolete_current_reduction(uuid, uuid, text, uuid, uuid, text, bigint);
DROP FUNCTION outcome_enqueue_reconcile_request(uuid, uuid, text, bigint, text, text[], text[]);
DROP FUNCTION outcome_binding_invalidators(text[]);
DROP FUNCTION outcome_binding_changed_fields(jsonb, jsonb);

DROP FUNCTION outcome_commit_evaluation(uuid, uuid, text, text, uuid, text, bigint, text, text, jsonb);
DROP FUNCTION outcome_commit_evaluation_v1(uuid, uuid, text, text, uuid, text, bigint, text, text, jsonb);

DROP FUNCTION outcome_publish_evaluation_projection(uuid, uuid, text, text, uuid, jsonb, boolean);
DROP FUNCTION outcome_read_evaluation_cut(uuid, uuid, boolean);
DROP FUNCTION outcome_replay_fact_set_digest(uuid, uuid);
DROP FUNCTION outcome_seal_evaluation_cut(uuid, uuid, text, text, text);
DROP FUNCTION outcome_ingest_canonical_fact(uuid, text, text, jsonb);
DROP FUNCTION outcome_revoke_authority_grant(uuid, uuid, uuid, text);
DROP FUNCTION outcome_register_authority_grant(uuid, uuid, uuid, text, text, text, text, text, text, text, text, bigint, bigint, text);
DROP FUNCTION outcome_register_fact_binding(uuid, uuid, jsonb);
DROP FUNCTION outcome_jsonb_exact_keys(jsonb, text[]);

COMMIT;
