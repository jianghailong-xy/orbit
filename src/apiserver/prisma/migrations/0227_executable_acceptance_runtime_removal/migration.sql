-- EXECUTABLE acceptance runtime removal: 0200, 0209 and 0215 come out, and the FineWeb executable
-- backfill ledger 0187 left behind goes with them.
--
-- What 0200 built was a negotiation and a typed termination in front of one exit-code comparison:
-- an admission decided before the process started (schema/capability revisions, an owner ceiling,
-- a policy ceiling, an evaluation-plan digest), a typed attempt whose termination said EXITED /
-- TIMED_OUT / CANCELLED / SIGNALED / START_FAILED / INFRASTRUCTURE_LOST, and a continuation that
-- read a non-EXITED termination and kept the goal actionable instead of failing the task. 0209
-- bound that attempt into a project criterion as a collector, and 0215 gave the acceptance run a
-- closing move derived from it. The account owner has decided to redo this layer, so it is
-- removed whole rather than reduced.
--
-- What still decides an EXECUTABLE task after this migration is unchanged and older than this
-- project: `task.acceptance_command` / `task.acceptance_expected_exit_code` (0177), the standing
-- request and its recorded shell result in `task_judgment_request` /
-- `task_executable_judgment_result` (0181), and the exit-code comparison in
-- `tasks/task-completion-criterion.ts`. A DECIDED PASS request is one of the canonical facts
-- `task_done_canonical_writer_fence` accepts, and that lane is untouched here.
--
-- The capability that is deliberately lost: a timeout, a cancellation, a signal and a start
-- failure are no longer distinguishable from a command that ran and returned the wrong code. All
-- of them become FAILED. The raw exit code and complete shell output of the failing run stay
-- readable in `task_executable_judgment_result`; the coordinating session diagnoses from there.
-- Nothing in this migration replaces the distinction, and nothing may.
--
-- Scope rule used throughout: an object belongs to the migration that CREATED it, and this
-- migration removes the ones that implement the EXECUTABLE acceptance runtime. Three groups 0200
-- also installed are not that runtime and stay, each with its own callers and its own later
-- owner:
--
--   * `task_dependency_tail_id`, `task_dependency_tail_satisfied` and
--     `task_all_dependency_tails_satisfied`, plus the `session_dispatch_dependency_check`
--     constraint trigger they feed. This is ordinary task
--     dependency resolution across supersession chains -- 0132's subject, rewritten by 0200 and
--     restored to 0200's bodies by 0226 -- and it gates every task-work Session dispatch in the
--     database. Dropping it would change when ordinary sessions may start, which is not what this
--     removal is about.
--   * `executable_runtime_heartbeat`, `executable_dead_man_event`, the `executable_runtime_liveness`
--     view and `executable_runtime_overlay_read_surface`. 0202 built its expectation ledger on top
--     of these and 0206 rewrote them; 0221 restored them to their pre-0206 definitions and named
--     the ledger "a different subsystem's audit history" that it was not removing. They are the
--     watchdog liveness channel, not the acceptance runtime, and `outcome_projection.read_surface`
--     still calls the overlay. They come out with 0202, not here.
--   * `outcome_projection.read_surface` / `read_surface_projection_only`. 0200 renamed 0196's
--     function and wrapped it; 0201, 0218, 0220 and 0221 have rewritten both sides since. The
--     wrapper's subject is the liveness overlay above, so it stays with it.
--
-- Data removed with the tables, recorded here because it is not recoverable (2026-09-02,
-- production): 110,077 rows. 109,872 of them are `task_executable_backfill_item` and one is its
-- `task_executable_backfill_batch` parent -- a single prepared, never-executed FineWeb x Common
-- Crawl backfill batch. The runtime's own history is 84 `task_executable_attempt`, 83
-- `task_executable_admission`, 20 `task_executable_continuation` and 17
-- `task_executable_diagnosis` rows. 94 `task` rows carry a negotiated timeout plan and 3 `runner`
-- rows an advertised acceptance-runtime capability; those columns go, the tasks and runners stay.
-- No archive table is created.
--
-- Explicitly NOT touched: 0177's two columns and its `task_executable_acceptance_pair` CHECK;
-- 0181's `task_judgment_request` and `task_executable_judgment_result` and their rows; the
-- `task_completion_criterion` enum, all three labels of which still have a live implementation;
-- 0141's and 0192's verification triggers; 0127's and 0150's `project_acceptance_run` table,
-- immutability guard, epoch guard and DONE gate; `project_acceptance_criterion_definition` /
-- `_criterion` / `_conclusion`.

-- ---------------------------------------------------------------------------------------------
-- 1. 0215 · the acceptance run's closing move.
--
-- 0127 gave the run one terminal shape and 0215 added a second spelling of the digest beside it.
-- The one production row that concluded through 0215 carries its digest in `conclusion_digest`
-- and nothing in `result_digest`, so the digest is moved back to the pre-0179 column it belongs
-- in before the 0215 column is dropped -- the run keeps saying exactly what it concluded, in the
-- one place 0127's constraint reads. `project_acceptance_run_immutable_guard` refuses ordinary
-- updates to a written run by design; it is disabled for that single statement and immediately
-- re-enabled, and no other column is touched.
--
-- The project DONE gate does not read `project_acceptance_run.verdict`: 0150's
-- `project_acceptance_done_gate` requires a live run in the current epoch whose criterion
-- standings are all PASS. Removing the closing move therefore returns acceptance runs to the
-- pre-0215 shape without touching what makes a project DONE.
-- ---------------------------------------------------------------------------------------------

DROP TRIGGER "project_acceptance_run_closure_guard" ON "project_acceptance_run";
DROP FUNCTION project_acceptance_run_closure_guard();
DROP FUNCTION project_acceptance_run_stalled_obligations(uuid, timestamptz);
DROP FUNCTION project_acceptance_run_states(uuid, timestamptz);
DROP FUNCTION project_acceptance_run_state_value(uuid, timestamptz);
DROP FUNCTION project_acceptance_run_conclude(uuid);
DROP FUNCTION project_acceptance_run_derive_conclusion(uuid);

ALTER TABLE "project_acceptance_run" DISABLE TRIGGER "project_acceptance_run_immutable_guard";
UPDATE "project_acceptance_run"
   SET "result_digest" = "conclusion_digest"
 WHERE "conclusion_digest" IS NOT NULL AND "result_digest" IS NULL;
ALTER TABLE "project_acceptance_run" ENABLE TRIGGER "project_acceptance_run_immutable_guard";

-- Named explicitly rather than left to the column drop's cascade: 0215's terminal clause reads
-- `conclusion_digest`, so dropping that column would take the constraint with it silently and the
-- ADD below would be restoring something nobody could see had been removed.
ALTER TABLE "project_acceptance_run"
  DROP CONSTRAINT "project_acceptance_run_conclusion_chk",
  DROP CONSTRAINT "project_acceptance_run_window_chk",
  DROP CONSTRAINT "project_acceptance_run_terminal_chk",
  DROP COLUMN "conclusion_basis",
  DROP COLUMN "conclusion_digest",
  DROP COLUMN "conclusion_window_seconds";

-- 0127's terminal shape, restored verbatim.
ALTER TABLE "project_acceptance_run" ADD CONSTRAINT "project_acceptance_run_terminal_chk"
  CHECK (("verdict" IS NULL AND "completed_at" IS NULL AND "result_digest" IS NULL)
      OR ("verdict" IS NOT NULL AND "completed_at" IS NOT NULL AND "result_digest" IS NOT NULL));

DROP TYPE "project_acceptance_run_obligation_kind";
DROP TYPE "project_acceptance_run_conclusion_basis";
DROP TYPE "project_acceptance_run_state";

-- ---------------------------------------------------------------------------------------------
-- 2. 0209 · the project criterion's executable-attempt collector.
--
-- 0209 changed one key of the evaluation plan material: a project whose EXECUTABLE criterion was
-- wired to an evidence task published `collectorVersions:
-- ['project-acceptance-executable-attempt-v1']` instead of 0195's `[]`. With the attempt table
-- gone there is no such collector, so the key returns to `[]`. Everything else in this function
-- is 0219's body, byte for byte -- 0216, 0218 and 0219 have each rewritten it since 0209, and
-- taking any older text would silently undo their work.
-- ---------------------------------------------------------------------------------------------

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

-- ---------------------------------------------------------------------------------------------
-- 3. 0200 · the DONE fence stops reading the typed attempt.
--
-- The fence is 0193's and stays. Only the branch 0200 added to it goes: an ADMITTED, digest-bound
-- EXITED attempt whose actual exit matched. Its other lanes -- a verifier's own verdict, a DECIDED
-- PASS `task_judgment_request` (the lane an EXECUTABLE task now takes), ALL_CHILDREN_DONE and
-- VERIFICATION_PASSED -- are the 0200 text unchanged. This has to happen before the tables it
-- reads are dropped.
-- ---------------------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION "task_done_canonical_writer_fence"() RETURNS trigger AS $$
DECLARE
  canonical boolean := false;
BEGIN
  IF NEW."completion_fence_revision" < OLD."completion_fence_revision" THEN
    RAISE EXCEPTION 'TASK_COMPLETION_FENCE_REVISION_DOWNGRADE'
      USING ERRCODE = 'P0001',
            DETAIL = 'a fenced task cannot be returned to a legacy writer cohort';
  END IF;
  IF NEW."completion_fence_revision" < 1
     OR NEW."status" <> 'DONE'::"task_status"
     OR OLD."status" = 'DONE'::"task_status" THEN
    RETURN NEW;
  END IF;

  IF NEW."verifies_task_id" IS NOT NULL AND NEW."verdict" IS NOT NULL THEN
    canonical := true;
  END IF;

  IF NOT canonical AND EXISTS (
    SELECT 1
      FROM "task_judgment_request" request
     WHERE request."task_id" = NEW."id"
       AND request."owner_id" = NEW."owner_id"
       AND request."kind" = NEW."completion_criterion"
       AND request."status" = 'DECIDED'::"task_judgment_request_status"
       AND request."decision" = 'PASS'::"task_judgment_decision"
  ) THEN
    canonical := true;
  END IF;

  IF NOT canonical AND NEW."completion_policy" = 'ALL_CHILDREN_DONE'::"task_completion_policy"
     AND EXISTS (
       SELECT 1 FROM "task" child
        WHERE child."parent_task_id" = NEW."id" AND child."status" = 'DONE'::"task_status"
     )
     AND NOT EXISTS (
       SELECT 1 FROM "task" child
        WHERE child."parent_task_id" = NEW."id"
          AND child."status" NOT IN ('DONE'::"task_status", 'CANCELLED'::"task_status")
     ) THEN
    canonical := true;
  END IF;

  IF NOT canonical AND NEW."completion_policy" = 'VERIFICATION_PASSED'::"task_completion_policy"
     AND EXISTS (
       SELECT 1 FROM "task" verifier
        WHERE verifier."verifies_task_id" = NEW."id"
          AND verifier."verdict" = 'PASS'::"task_verdict"
          AND verifier."terminal_reason" IS NULL
          AND verifier."superseded_by_task_id" IS NULL
     ) THEN
    canonical := true;
  END IF;

  IF NOT canonical THEN
    RAISE EXCEPTION 'TASK_DONE_CANONICAL_FACT_REQUIRED'
      USING ERRCODE = 'P0001',
            DETAIL = 'status=DONE is a projection of the declared completion fact, not a writer input',
            HINT = 'record the executable result, verification verdict, or human signoff event';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
-- ---------------------------------------------------------------------------------------------
-- 4. 0200 · admission, attempt, continuation and diagnosis.
--
-- `task_executable_plan_bind` is the trigger that minted the two digests on every `task` write;
-- with the negotiation columns gone it has nothing to compute. The stale-attempt sweep and the
-- one-off bootstrap import both write the attempt/continuation/diagnosis tables and go with them.
-- ---------------------------------------------------------------------------------------------

DROP TRIGGER "task_executable_plan_bind" ON "task";
DROP FUNCTION task_executable_plan_bind();
DROP FUNCTION executable_acceptance_mark_stale_attempts(timestamptz, integer);
DROP FUNCTION executable_acceptance_import_bootstrap_legacy_timeout();

DROP TABLE "task_executable_continuation";
DROP TABLE "task_executable_diagnosis";
DROP TABLE "task_executable_attempt";
DROP TABLE "task_executable_admission";

DROP FUNCTION task_executable_attempt_start_guard();
DROP FUNCTION task_executable_attempt_termination_guard();
DROP FUNCTION task_executable_admission_immutable_guard();
DROP FUNCTION executable_acceptance_plan_digest(integer, integer, text, integer, integer, integer, integer);

-- ---------------------------------------------------------------------------------------------
-- 5. 0200 · the negotiation columns on `task` and `runner`.
--
-- `acceptance_command` and `acceptance_expected_exit_code` are 0177's and are NOT in this list:
-- they are the inputs the surviving exit-code comparison reads. What goes is the requested budget,
-- the two ceilings, the revision pair, the two digests derived from them, and the attempt counter
-- the start guard incremented.
-- ---------------------------------------------------------------------------------------------

ALTER TABLE "task"
  DROP CONSTRAINT "task_executable_runtime_shape_check",
  DROP CONSTRAINT "task_execution_attempt_count_check",
  DROP COLUMN "acceptance_timeout_seconds",
  DROP COLUMN "acceptance_owner_timeout_ceiling_seconds",
  DROP COLUMN "acceptance_policy_timeout_ceiling_seconds",
  DROP COLUMN "acceptance_schema_revision",
  DROP COLUMN "acceptance_capability_revision",
  DROP COLUMN "acceptance_command_digest",
  DROP COLUMN "acceptance_evaluation_plan_digest",
  DROP COLUMN "execution_attempt_count";

ALTER TABLE "runner"
  DROP CONSTRAINT "runner_acceptance_runtime_shape_check",
  DROP COLUMN "acceptance_runtime_schema_revision",
  DROP COLUMN "acceptance_runtime_capability_revision",
  DROP COLUMN "acceptance_runtime_hard_max_seconds",
  DROP COLUMN "acceptance_runtime_reported_at";

DROP TYPE "executable_acceptance_continuation_kind";
DROP TYPE "executable_acceptance_legacy_termination";
DROP TYPE "executable_acceptance_termination_kind";
DROP TYPE "executable_acceptance_admission_decision";

-- ---------------------------------------------------------------------------------------------
-- 6. 0187 · the FineWeb executable backfill ledger.
--
-- 0187 predates this project and is listed here because its two tables hold 109,873 of the
-- 110,077 rows this removal drops, and because they are the rest of the `task_executable_*`
-- family. It was a declaration-only tool: a classifier plus a bounded forward/rollback door that
-- would have rewritten `task.completion_criterion` for one project's tasks. One batch was
-- prepared and 109,872 items enumerated; neither door was ever called, and no `task` row was ever
-- written by it. Its migration text stays in the ledger, unchanged, and the frozen-text spec over
-- it stays with it.
-- ---------------------------------------------------------------------------------------------

DROP FUNCTION "n19_fineweb_executable_rollback_step"(uuid);
DROP FUNCTION "n19_fineweb_executable_backfill_step"(uuid);
DROP FUNCTION "n19_fineweb_executable_prepare"(uuid, text, integer);
DROP FUNCTION "n19_fineweb_executable_classify"(text, text, text);
DROP FUNCTION "n19_fineweb_executable_inventory"(uuid);
DROP TABLE "task_executable_backfill_item";
DROP TABLE "task_executable_backfill_batch";
