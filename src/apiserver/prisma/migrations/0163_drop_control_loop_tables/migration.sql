-- `project_decision` was the control loop's per-pass audit: one row per reconcile, holding the
-- whole world snapshot the pass decided on. The loop is gone and nothing reads the table.
--
-- `project_event` is deliberately NOT dropped here. It still has writers — eleven triggers across
-- task, session, approval, runner, workspace, model_provider and project keep enqueueing signals
-- into it — and dropping it means removing those first. That is a separate change.
--
-- `project_action` stays too: it records what was DISPATCHED, which is history about the work
-- rather than about the loop that scheduled it, and `tasks/verification-dependency.ts` reads it.

-- 1. The guard that exists only to freeze the decision link. It goes with the column.
DROP TRIGGER IF EXISTS "project_action_decision_link_guard" ON "project_action";
DROP FUNCTION IF EXISTS "project_action_decision_link_guard"();

-- 2. The dispatch-immutability guard names `decision_id` among the columns it freezes, so the
--    column cannot be dropped while this body references it. Replayed from the CURRENT definition
--    with that one clause removed — every other column it freezes stays frozen.
CREATE OR REPLACE FUNCTION public.project_action_dispatch_immutable()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF OLD."type" NOT IN ('DISPATCH_TASK', 'ROTATE_COORDINATOR_SESSION') THEN RETURN NEW; END IF;
  IF OLD."status" <> 'CLAIMED' AND (
       NEW."project_id" IS DISTINCT FROM OLD."project_id"
    OR NEW."idempotency_key" IS DISTINCT FROM OLD."idempotency_key"
    OR NEW."type" IS DISTINCT FROM OLD."type"
    OR NEW."status" IS DISTINCT FROM OLD."status"
    OR NEW."subject_type" IS DISTINCT FROM OLD."subject_type"
    OR NEW."subject_id" IS DISTINCT FROM OLD."subject_id"
    OR NEW."fencing_token" IS DISTINCT FROM OLD."fencing_token"
    OR NEW."result_session_id" IS DISTINCT FROM OLD."result_session_id"
    OR NEW."refusal_code" IS DISTINCT FROM OLD."refusal_code"
    OR NEW."execution_context" IS DISTINCT FROM OLD."execution_context"
    OR NEW."execution_context_digest" IS DISTINCT FROM OLD."execution_context_digest"
    OR NEW."execution_result_digest" IS DISTINCT FROM OLD."execution_result_digest"
    OR NEW."reason_code" IS DISTINCT FROM OLD."reason_code"
  ) THEN
    RAISE EXCEPTION 'ACTION_APPLIED_IMMUTABLE: dispatch action % is terminal', OLD."id";
  END IF;
  IF OLD."status" = 'CLAIMED' AND NEW."status" NOT IN
       ('CLAIMED', 'APPLIED', 'REFUSED', 'SUPERSEDED') THEN
    RAISE EXCEPTION 'ACTION_TRANSITION_ILLEGAL: dispatch action %', OLD."id";
  END IF;
  RETURN NEW;
END;
$function$;

-- 3. The two columns that pointed at the audit. Neither is read: no client sends a `decisionId`,
--    and the only reader of `project_action` selects project_id / type / status / subject_id /
--    idempotency_key.
ALTER TABLE "project_action"
  DROP CONSTRAINT IF EXISTS "project_action_decision_project_fkey";
ALTER TABLE "project_action" DROP COLUMN IF EXISTS "decision_id";

ALTER TABLE "project_acceptance_run"
  DROP CONSTRAINT IF EXISTS "project_acceptance_run_decision_fkey";
ALTER TABLE "project_acceptance_run" DROP COLUMN IF EXISTS "decision_id";

DROP TABLE IF EXISTS "project_decision";
