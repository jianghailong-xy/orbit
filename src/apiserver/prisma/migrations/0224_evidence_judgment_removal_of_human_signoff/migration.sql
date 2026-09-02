-- N26: delete the human step, keep the ruler.
--
-- Two human gates existed. This migration removes both, and removes nothing else.
--
--   1. `task_completion_criterion.HUMAN_SIGNOFF` — a task settled by the account owner deciding a
--      judgment request, with the decision itself living in a second table (`task_human_signoff`)
--      that only a person could write.
--   2. `project_acceptance_conclusion` PASS — refused to a judgment session by
--      `CONCLUDE_VERDICT_PASS: HUMAN_ONLY`, so an agent could refute a criterion but never confirm
--      one.
--
-- WHAT THIS IS NOT
-- ================
-- It is not a weakening of evidence. `task_judgment_request` already carries a composite foreign
-- key to the exact immutable `task_completion_evidence` row and digest it asks about, and
-- `project_acceptance_run` still freezes the criteria a conclusion is made against. Both survive
-- untouched. What used to be a second, human-only row on top of that binding becomes the request
-- row's own `decision_note`, which this migration makes mandatory for every EVIDENCE_JUDGMENT
-- verdict — where before only INCONCLUSIVE had to state a reason.
--
-- It is not a change to any project's acceptance criteria. `text` and `verification_method` on
-- `project_acceptance_criterion_definition` are the ruler and are not read, written or reordered
-- here. Only the mechanism that decides a criterion changes.
--
-- WHY RENAME RATHER THAN REMAP THE ROWS
-- =====================================
-- 1,123 tasks and 306 criterion definitions carry this value today, 278 of the definitions in the
-- removed one. Remapping them was considered and rejected on the facts:
--
--   * EXECUTABLE requires `acceptance_command`/`acceptance_expected_exit_code`. None of these rows
--     has one, and inventing a command would invent a standard nobody stated.
--   * VERIFICATION requires `evidence_task_id` — `project_acceptance_definition_declaration_chk`
--     enforces exactly that — and would additionally force every remapped task onto
--     `completion_policy = 'VERIFICATION_PASSED'`. There is no verifier task for these 278
--     criteria, so 43 projects would have lost any reachable completion path, and 859 already-DONE
--     tasks would have been re-evaluated under a policy they were never completed under.
--
-- So the criterion survives as a criterion and only its NAME and its DECIDER change. `ALTER TYPE
-- … RENAME VALUE` rewrites no heap tuple, so every existing row keeps its identity, its status and
-- its position in history; PostgreSQL re-renders every CHECK constraint that mentions the label,
-- and this migration replaces by hand the twelve plpgsql bodies that hold it as text.
--
-- HISTORY IS MOVED, NOT DROPPED
-- =============================
-- Every `task_human_signoff` row is copied into the `task_judgment_request` row it decided before
-- the table is dropped: the reviewer's prose becomes `decision_note`, and the signer, the decision
-- and the decision time are already on that row (0181 wrote them in the same transaction, and
-- `task_human_signoff_request_id_key` made the relationship one-to-one). `signed_at` is preserved
-- only insofar as it already equals `decided_at`; the assertion below fails the migration if any
-- row disagrees, rather than silently losing a timestamp.

-- ---------------------------------------------------------------------------------------------
-- 1. The criterion keeps every row and loses the word "human".
-- ---------------------------------------------------------------------------------------------
ALTER TYPE "task_completion_criterion" RENAME VALUE 'HUMAN_SIGNOFF' TO 'EVIDENCE_JUDGMENT';

-- ---------------------------------------------------------------------------------------------
-- 2. Fold the signoff event into the request it decided, then drop the table.
-- ---------------------------------------------------------------------------------------------
DO $$
DECLARE
  v_unpaired integer;
  v_disagreeing integer;
BEGIN
  SELECT count(*) INTO v_unpaired
    FROM "task_human_signoff" s
    LEFT JOIN "task_judgment_request" r ON r."id" = s."request_id"
   WHERE r."id" IS NULL;
  IF v_unpaired > 0 THEN
    RAISE EXCEPTION 'EVIDENCE_JUDGMENT_MIGRATION_UNPAIRED_SIGNOFF: % row(s)', v_unpaired;
  END IF;
  SELECT count(*) INTO v_disagreeing
    FROM "task_human_signoff" s
    JOIN "task_judgment_request" r ON r."id" = s."request_id"
   WHERE r."decision" IS DISTINCT FROM 'PASS'::"task_judgment_decision"
      OR r."decided_by_id" IS DISTINCT FROM s."signed_by_id"::text
      OR r."decided_at" IS DISTINCT FROM s."signed_at";
  IF v_disagreeing > 0 THEN
    RAISE EXCEPTION 'EVIDENCE_JUDGMENT_MIGRATION_SIGNOFF_DISAGREES_WITH_REQUEST: % row(s)',
      v_disagreeing;
  END IF;
END $$;

-- The note is the only field the request row did not already hold. Existing non-null notes are
-- left alone: an INCONCLUSIVE request that was later replaced by a PASS keeps what it said.
--
-- Every row this touches is DECIDED -- the assertion above refuses to proceed unless it is -- and
-- `task_judgment_request_transition_guard` is a BEFORE UPDATE trigger that raises
-- TASK_JUDGMENT_REQUEST_TERMINAL_IMMUTABLE on any update to a row that is no longer OPEN. That
-- rule is right for the runtime and wrong for this one statement, which is carrying a fact that
-- already happened onto the row that recorded it rather than deciding anything. So the guard is
-- lifted for exactly this statement and put back immediately, and the DO block below fails the
-- migration if it is not back. Suppressing it is visible here rather than by a session-wide
-- `session_replication_role`, which would also have silenced every foreign key and every other
-- trigger on the table.
--
-- Only this one trigger fires: `task_judgment_delivery_file` and
-- `task_judgment_request_verifier_role_guard` are INSERT-only, and `task_judgment_delivery_stop`
-- and `task_open_verification_request_guard` are UPDATE OF "status", which this does not write.
ALTER TABLE "task_judgment_request" DISABLE TRIGGER "task_judgment_request_transition_guard";

UPDATE "task_judgment_request" r
   SET "decision_note" = s."evidence"
  FROM "task_human_signoff" s
 WHERE s."request_id" = r."id"
   AND r."decision_note" IS NULL;

ALTER TABLE "task_judgment_request" ENABLE TRIGGER "task_judgment_request_transition_guard";

DO $$
DECLARE enabled "char";
BEGIN
  SELECT t.tgenabled INTO enabled
    FROM "pg_trigger" t
    JOIN "pg_class" c ON c.oid = t.tgrelid
   WHERE c.relname = 'task_judgment_request'
     AND t.tgname = 'task_judgment_request_transition_guard';
  IF enabled IS DISTINCT FROM 'O' THEN
    RAISE EXCEPTION
      'EVIDENCE_JUDGMENT_MIGRATION_GUARD_LEFT_DISABLED: tgenabled=%', COALESCE(enabled::text, 'MISSING');
  END IF;
END $$;

DROP TRIGGER IF EXISTS "task_human_signoff_current_request_guard" ON "task_human_signoff";
DROP FUNCTION IF EXISTS "task_human_signoff_current_request_guard"();
DROP TABLE "task_human_signoff";

-- ---------------------------------------------------------------------------------------------
-- 3. Who may decide an EVIDENCE_JUDGMENT, and what they must say.
--
-- Before: only 'USER', only when that user was the recipient, and only PASS or a noted
-- INCONCLUSIVE. After: any credentialed principal Orbit already attributes a judgment to, and
-- every verdict must state its finding. The evidence binding is unchanged and is not restated
-- here — it is `task_judgment_request_evidence_fact_fkey`, four columns wide, still RESTRICT.
-- ---------------------------------------------------------------------------------------------
ALTER TABLE "task_judgment_request"
  DROP CONSTRAINT "task_judgment_request_decider_matches_kind",
  ADD CONSTRAINT "task_judgment_request_decider_matches_kind" CHECK (
    "status" <> 'DECIDED' OR
    ("kind" = 'EXECUTABLE' AND "decided_by_type" = 'SYSTEM'
      AND "decision" IN ('PASS', 'FAIL')) OR
    ("kind" = 'VERIFICATION' AND "decided_by_type" IN ('USER', 'AGENT')) OR
    ("kind" = 'EVIDENCE_JUDGMENT' AND "decided_by_type" IN ('USER', 'AGENT')
      AND length(btrim("decision_note")) > 0)
  );

-- ---------------------------------------------------------------------------------------------
-- 4. The coordinator wake vocabulary gains the new spelling and keeps the old one.
--
-- Rows already written say HUMAN_SIGNOFF_* because that is what happened when they were written.
-- They are an event log, so they are not rewritten; the constraint simply accepts both, and no
-- code path emits the old three any more.
-- ---------------------------------------------------------------------------------------------
ALTER TABLE "project_coordinator_wake"
  DROP CONSTRAINT "project_coordinator_wake_event_chk",
  ADD CONSTRAINT "project_coordinator_wake_event_chk" CHECK ("event" IN (
    'ATTEMPT_ENDED_UNSETTLED',
    'ATTEMPT_BUDGET_SPENT',
    'PROJECT_TASKS_SETTLED',
    'CRITERION_READY',
    'COMPLETION_EVIDENCE_REVISED',
    'EXECUTABLE_RESULT_RECORDED',
    'VERIFICATION_VERDICT_RECORDED',
    'EVIDENCE_JUDGMENT_REQUESTED',
    'EVIDENCE_JUDGMENT_DECIDED',
    'EVIDENCE_JUDGMENT_REQUEST_SUPERSEDED',
    'HUMAN_SIGNOFF_REQUESTED',
    'HUMAN_SIGNOFF_DECIDED',
    'HUMAN_SIGNOFF_REQUEST_SUPERSEDED',
    'COMPLETION_ACK_STALE',
    'FAILURE_CONTINUATION_ACTIONABLE'
  ));

-- ---------------------------------------------------------------------------------------------
-- 5. A machine conclusion may now confirm a project criterion, not only refute one.
--
-- The DONE gate is unchanged: it still requires a PASS standing for every stated criterion against
-- the current evidence version. All that changes is that `decided_by = 'COORDINATOR_AGENT'` is no
-- longer excluded from producing one. Attribution is still mandatory and still recorded per event.
-- ---------------------------------------------------------------------------------------------
ALTER TABLE "project_acceptance_conclusion"
  DROP CONSTRAINT "project_acceptance_conclusion_pass_authority_chk",
  ADD CONSTRAINT "project_acceptance_conclusion_pass_authority_chk"
    CHECK ("decided_by" IN ('USER', 'SYSTEM', 'COORDINATOR_AGENT'));

-- ---------------------------------------------------------------------------------------------
-- 6. The plpgsql bodies that hold the criterion name as text.
--
-- `ALTER TYPE … RENAME VALUE` updates catalogued expressions — every CHECK constraint that names
-- the label re-renders itself — but a plpgsql body is stored as source and keeps whatever string
-- it was written with. Twelve installed functions hold `'HUMAN_SIGNOFF'`, and after the rename
-- every one of them would fail at run time on `invalid input value for enum`.
--
-- They are rewritten from their OWN installed definitions rather than from copies pasted into this
-- file. A pasted copy is a second source of truth that can silently be older than what is deployed
-- — `CREATE OR REPLACE` with a stale body reverts a later migration without saying so — and there
-- is nothing about eleven of these twelve that this migration is entitled to change except the
-- name of one enum label. So: read the definition, substitute the label, execute it back, and then
-- FAIL if any function still holds the old spelling.
--
-- `task_judgment_request_transition_guard` is the exception, and the only behavioural edit here:
-- its PASS branch required a row in the table this migration drops. It is written out in full
-- below, after the loop, so the loop cannot be read as having quietly changed a rule.
-- ---------------------------------------------------------------------------------------------
DO $$
DECLARE
  fn record;
  rewritten integer := 0;
  residual text;
BEGIN
  FOR fn IN
    SELECT p.oid, p.proname, pg_get_functiondef(p.oid) AS definition
      FROM "pg_proc" p
      JOIN "pg_namespace" n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.prosrc LIKE '%HUMAN_SIGNOFF%'
     ORDER BY p.proname, p.oid
  LOOP
    EXECUTE replace(fn.definition, 'HUMAN_SIGNOFF', 'EVIDENCE_JUDGMENT');
    rewritten := rewritten + 1;
  END LOOP;

  SELECT string_agg(p.proname, ', ' ORDER BY p.proname) INTO residual
    FROM "pg_proc" p
    JOIN "pg_namespace" n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.prosrc LIKE '%HUMAN_SIGNOFF%';
  IF residual IS NOT NULL THEN
    RAISE EXCEPTION 'EVIDENCE_JUDGMENT_MIGRATION_FUNCTION_RESIDUE: %', residual;
  END IF;
  RAISE NOTICE 'evidence-judgment rename rewrote % function bodies', rewritten;
END $$;

-- task_judgment_request_transition_guard: the one rule that changes.
CREATE OR REPLACE FUNCTION public.task_judgment_request_transition_guard()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE successor "task_judgment_request"%ROWTYPE;
BEGIN
  IF ROW(NEW."task_id", NEW."owner_id", NEW."evidence_id", NEW."criterion_revision",
         NEW."evidence_digest", NEW."kind", NEW."recipient_type", NEW."recipient_id",
         NEW."created_at") IS DISTINCT FROM
     ROW(OLD."task_id", OLD."owner_id", OLD."evidence_id", OLD."criterion_revision",
         OLD."evidence_digest", OLD."kind", OLD."recipient_type", OLD."recipient_id",
         OLD."created_at") THEN
    RAISE EXCEPTION 'TASK_JUDGMENT_REQUEST_IDENTITY_IMMUTABLE';
  END IF;
  IF OLD."status" <> 'OPEN' THEN
    RAISE EXCEPTION 'TASK_JUDGMENT_REQUEST_TERMINAL_IMMUTABLE';
  END IF;
  IF NEW."status" = 'OPEN' THEN
    RAISE EXCEPTION 'TASK_JUDGMENT_REQUEST_OPEN_UPDATE_REFUSED';
  ELSIF NEW."status" = 'SUPERSEDED' THEN
    IF NEW."supersession_rule" IS NULL OR NEW."supersession_rule" = 'EVIDENCE_REVISED' THEN
      SELECT * INTO successor FROM "task_judgment_request"
       WHERE "id" = NEW."superseded_by_id";
      IF NOT FOUND OR successor."task_id" <> NEW."task_id"
         OR successor."status" <> 'OPEN' OR successor."created_at" < OLD."created_at" THEN
        RAISE EXCEPTION 'TASK_JUDGMENT_REQUEST_INVALID_SUCCESSOR';
      END IF;
    ELSIF NEW."supersession_rule" = 'TASK_ALREADY_DONE' THEN
      IF NEW."superseded_by_id" IS NOT NULL OR NOT EXISTS (
        SELECT 1 FROM "task" task
         WHERE task."id" = NEW."task_id" AND task."owner_id" = NEW."owner_id"
           AND task."status" = 'DONE'
      ) THEN
        RAISE EXCEPTION 'TASK_JUDGMENT_REQUEST_DONE_RULE_REQUIRES_DONE_TASK';
      END IF;
    ELSIF NEW."supersession_rule" = 'VERIFIER_ROLE' THEN
      IF NEW."superseded_by_id" IS NOT NULL OR NOT EXISTS (
        SELECT 1 FROM "task" task
         WHERE task."id" = NEW."task_id" AND task."owner_id" = NEW."owner_id"
           AND task."verifies_task_id" IS NOT NULL
           AND task."completion_criterion" = 'VERIFICATION'
           AND task."completion_policy" = 'MANUAL'
      ) THEN
        RAISE EXCEPTION 'TASK_JUDGMENT_REQUEST_VERIFIER_RULE_REQUIRES_VERIFIER_TASK';
      END IF;
    END IF;

    IF NEW."supersession_rule" IS NOT NULL
       AND NEW."supersession_rule" <> 'VERIFIER_ROLE'
       AND NEW."superseded_actor_type" = 'USER'
       AND NEW."superseded_actor_id" <> NEW."owner_id" THEN
      RAISE EXCEPTION 'TASK_JUDGMENT_REQUEST_SUPERSESSION_ACTOR_REQUIRED';
    END IF;
  ELSIF NEW."kind" = 'EXECUTABLE' THEN
    IF NOT EXISTS (
      SELECT 1 FROM "task_executable_judgment_result" result
       WHERE result."request_id" = NEW."id"
         AND CASE WHEN result."actual_exit_code" = result."expected_exit_code"
                  THEN 'PASS'::"task_judgment_decision"
                  ELSE 'FAIL'::"task_judgment_decision" END = NEW."decision"
    ) THEN
      RAISE EXCEPTION 'TASK_EXECUTABLE_JUDGMENT_RESULT_REQUIRED';
    END IF;
  ELSIF NEW."kind" = 'VERIFICATION' THEN
    IF NOT EXISTS (
      SELECT 1 FROM "task" verifier
       WHERE verifier."id" = NEW."recipient_id"::uuid
         AND verifier."verifies_task_id" = NEW."task_id"
         AND verifier."verdict"::text = NEW."decision"::text
    ) THEN
      RAISE EXCEPTION 'TASK_VERIFIER_VERDICT_REQUIRED';
    END IF;
  ELSIF NEW."kind" = 'EVIDENCE_JUDGMENT' THEN
    -- The decided fact used to be a second row in a table only the recipient could write, and
    -- that table is gone. The request row is already bound to the exact evidence version and
    -- digest by `task_judgment_request_evidence_fact_fkey`, so what a conclusion still owes is an
    -- attributable principal and the finding it reached. Both PASS and INCONCLUSIVE owe it;
    -- neither may be recorded as a bare verdict.
    IF NEW."decided_by_type" NOT IN ('USER', 'AGENT')
       OR length(btrim(COALESCE(NEW."decided_by_id", ''))) = 0
       OR length(btrim(COALESCE(NEW."decision_note", ''))) = 0 THEN
      RAISE EXCEPTION 'TASK_EVIDENCE_JUDGMENT_FINDING_REQUIRED';
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;
