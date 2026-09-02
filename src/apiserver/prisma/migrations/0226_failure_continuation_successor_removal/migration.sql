-- Failure continuation and successor handoff removal: 0210, 0211, 0212 and 0213 come out whole.
--
-- What those four migrations built was a machine that read a failed typed EXECUTABLE attempt and
-- decided, by itself, what should happen next: an append-only receipt per failure (0210), a
-- deterministic route reducer over that receipt (0211), an atomic successor-handoff commit that
-- rewrote task lineage and rebound downstream dependencies (0212), and a failure-site input that
-- made two consecutive failures distinguishable (0213).
--
-- The diagnosis and the routing were not the problem. They worked: a real failed task was
-- classified, routed to AUTOMATIC_REPAIR, given exactly one successor, and continued -- with the
-- predecessor's FAILED result and fingerprint left intact. The exit was the problem. One attempt
-- that failed on a hard-coded 240s timeout was classified owner-only, and the obligation that
-- produced had no channel that could answer it: the two options it offered
-- (`APPROVE_BOUND_REQUEST`, `REVISE_OR_DENY`) had zero callers anywhere in the repository and the
-- inbox that showed it was read-only. One project sat on that for a week.
--
-- The replacement is not a smaller router. There is none: an exception is reported to the
-- coordinating session, and a person or that session decides. So this migration adds no table, no
-- function and no trigger. It only subtracts.
--
-- Deliberately NOT touched:
--
--   * `task_executable_attempt` / `_admission` / `_continuation` and everything 0200 built on them.
--     After this removal they are the only completion-decision mechanism left. Only the two
--     columns 0213 appended to `task_executable_attempt` go, and the three 0200 functions that
--     0213 and 0212 rewrote in place are restored to the bodies 0200 gave them -- an object
--     belongs to the migration that created it, not to the one that replaced its body.
--   * `project_coordinator_wake`'s event vocabulary. `FAILURE_CONTINUATION_ACTIONABLE` stays
--     accepted for the same reason 0224 kept `HUMAN_SIGNOFF_*`: rows already written say it
--     because that is what happened, this table is an event log, and dropping the spelling would
--     make this migration fail to deploy against any database that holds one. No path writes it
--     any more; `RETIRED_COORDINATOR_WAKE_EVENTS` in `projects/coordinator-wake.ts` names it as
--     retired, which is what `coordinator-wake.spec.ts` checks. The narrower subject constraint
--     0210 added beside it does go: it only ever qualified that one event.
--   * Ordinary task supersession. `superseded_by_task_id`, `superseded_at` and `terminal_reason`
--     keep every guard that predates this project (0128's `task_supersede_guard` among them). The
--     only thing that stops is `failure_successor_task_binding_immutable`, which fired on every
--     `task` status/supersession UPDATE in the database to protect handoff rows that no longer
--     exist.
--
-- Data removed with the tables, recorded here because it is not recoverable: 45 rows across
-- `failure_continuation_*` (receipts, obligations, route decisions and the wakeup outbox,
-- including ten wakeups wedged mid-delivery and the one owner-only obligation that could not be
-- answered) and 12 rows across `failure_successor_*` (handoffs, current bindings and dependency
-- rebinds). The task-side facts those rows pointed at -- FAILED status, superseded links, attempt
-- rows and their fingerprints -- live in `task` and `task_executable_attempt` and are untouched.

BEGIN;

-- ---------------------------------------------------------------------------------------------
-- 1. The three triggers this project hung on tables it did not own.
--
-- Two of them turned an ordinary EXECUTABLE termination into a receipt and a wakeup. The third
-- fired on every `task` supersession write in the database.
-- ---------------------------------------------------------------------------------------------
DROP TRIGGER "task_executable_attempt_failure_continuation_receipt" ON "task_executable_attempt";
DROP TRIGGER "task_executable_continuation_failure_wakeup" ON "task_executable_continuation";
DROP TRIGGER failure_successor_task_binding_immutable ON task;

-- ---------------------------------------------------------------------------------------------
-- 2. The three 0200 functions 0212 and 0213 rewrote in place, restored to their 0200 bodies.
--
-- Each one reads something this migration is about to drop, so each has to stop reading it before
-- the drop -- and "stop reading it" here means exactly the text 0200 shipped, not a new variant.
-- ---------------------------------------------------------------------------------------------

-- 0200's body verbatim: the two site columns leave the termination allowlist with the columns.
CREATE OR REPLACE FUNCTION task_executable_attempt_termination_guard() RETURNS trigger AS $$
BEGIN
  IF OLD."legacy_termination" IS NOT NULL THEN
    RAISE EXCEPTION 'legacy executable attempt is immutable and may not receive a typed termination';
  END IF;
  IF OLD."terminated_at" IS NOT NULL OR OLD."termination_kind" IS NOT NULL THEN
    RAISE EXCEPTION 'task executable attempt termination is append-only';
  END IF;
  IF NEW."termination_kind" IS NULL OR NEW."terminated_at" IS NULL THEN
    RAISE EXCEPTION 'task executable attempt update must append one complete termination';
  END IF;
  IF to_jsonb(NEW) - ARRAY['terminated_at','termination_kind','actual_exit_code','signal',
       'raw_output','output_truncated','failure_fingerprint']
     <> to_jsonb(OLD) - ARRAY['terminated_at','termination_kind','actual_exit_code','signal',
       'raw_output','output_truncated','failure_fingerprint'] THEN
    RAISE EXCEPTION 'task executable attempt identity is immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- 0200's body verbatim: the dead-man sweep goes back to the four-input fingerprint it wrote before
-- 0213 gave it a fifth. The stale scan itself, its bounds and its continuation rules are unchanged.
CREATE OR REPLACE FUNCTION executable_acceptance_mark_stale_attempts(
  p_observed_at timestamptz,
  p_limit integer DEFAULT 64
) RETURNS integer LANGUAGE plpgsql AS $$
DECLARE candidate record; marked integer := 0; fingerprint char(64); repeated integer;
        continuation "executable_acceptance_continuation_kind"; reason text;
BEGIN
  IF p_limit < 1 OR p_limit > 1024 THEN
    RAISE EXCEPTION 'EXECUTABLE_STALE_SCAN_LIMIT_INVALID';
  END IF;
  FOR candidate IN
    SELECT a."id", a."task_id", a."attempt_number", a."evaluation_plan_digest"
      FROM "task_executable_attempt" a
      JOIN "task_executable_admission" admission ON admission."id" = a."admission_id"
     WHERE admission."decision" = 'ADMITTED'
       AND a."termination_kind" IS NULL
       AND a."terminated_at" IS NULL
       AND a."deadline_at" < p_observed_at
     ORDER BY a."deadline_at", a."id"
     FOR UPDATE OF a SKIP LOCKED
     LIMIT p_limit
  LOOP
    fingerprint := encode(digest(concat(
      'evaluationPlanDigest=', candidate."evaluation_plan_digest", E'\n',
      'terminationKind=INFRASTRUCTURE_LOST', E'\nactualExitCode=NULL\nsignal=NULL'
    ), 'sha256'), 'hex')::char(64);
    UPDATE "task_executable_attempt"
       SET "terminated_at" = p_observed_at,
           "termination_kind" = 'INFRASTRUCTURE_LOST',
           "actual_exit_code" = NULL,
           "failure_fingerprint" = fingerprint
     WHERE "id" = candidate."id";

    SELECT count(*) INTO repeated
      FROM "task_executable_attempt"
     WHERE "task_id" = candidate."task_id"
       AND "failure_fingerprint" = fingerprint;
    IF candidate."attempt_number" < 3 AND repeated <= 1 THEN
      continuation := 'RETRY';
      reason := 'ATTEMPT_INFRASTRUCTURE_LOST_RETRY_BUDGET_AVAILABLE';
    ELSIF candidate."attempt_number" < 3 THEN
      continuation := 'DIAGNOSIS';
      reason := 'ATTEMPT_INFRASTRUCTURE_LOST_FINGERPRINT_REPEATED';
    ELSE
      continuation := 'SUCCESSOR';
      reason := 'ATTEMPT_INFRASTRUCTURE_LOST_ATTEMPT_BUDGET_EXHAUSTED';
    END IF;
    INSERT INTO "task_executable_continuation"
      ("id", "task_id", "attempt_id", "kind", "reason_code", "goal_actionable")
    VALUES (gen_random_uuid(), candidate."task_id", candidate."id", continuation, reason, true)
    ON CONFLICT ("attempt_id") DO NOTHING;
    marked := marked + 1;
  END LOOP;
  RETURN marked;
END;
$$;

-- 0200's body verbatim: the supersession-chain walk that Ready, Run Now, both sweeps and the
-- deferred Session commit gate all share. 0212 appended a second predicate to it that failed the
-- whole chain closed unless the tail matched a `failure_successor_current_binding` row; with those
-- rows gone that predicate could only ever refuse work, so the walk returns to the chain itself.
CREATE OR REPLACE FUNCTION task_dependency_tail_id(p_task_id uuid)
RETURNS uuid LANGUAGE plpgsql STABLE AS $$
DECLARE cursor_id uuid := p_task_id; next_id uuid; root_owner uuid; current_owner uuid;
        current_status text; current_reason text;
        seen uuid[] := ARRAY[]::uuid[]; depth integer := 0;
BEGIN
  SELECT t."owner_id" INTO root_owner FROM "task" t WHERE t."id" = p_task_id;
  IF NOT FOUND THEN RETURN NULL; END IF;
  LOOP
    IF cursor_id = ANY(seen) OR depth > 256 THEN RETURN NULL; END IF;
    seen := array_append(seen, cursor_id);
    SELECT t."owner_id", t."superseded_by_task_id", t."status"::text, t."terminal_reason"
      INTO current_owner, next_id, current_status, current_reason
      FROM "task" t WHERE t."id" = cursor_id;
    IF NOT FOUND OR current_owner <> root_owner THEN RETURN NULL; END IF;
    IF next_id IS NULL THEN
      -- ON DELETE SET NULL preserves SUPERSEDED as honest history; it does not leave a tail whose
      -- status can satisfy new work. That broken chain is deliberately unresolved.
      IF current_reason = 'SUPERSEDED' THEN RETURN NULL; END IF;
      RETURN cursor_id;
    END IF;
    IF current_status NOT IN ('FAILED', 'CANCELLED') OR current_reason IS DISTINCT FROM 'SUPERSEDED'
      THEN RETURN NULL;
    END IF;
    cursor_id := next_id;
    depth := depth + 1;
  END LOOP;
END;
$$;

-- ---------------------------------------------------------------------------------------------
-- 3. The read surfaces, then the tables, then the reducers that were the only thing reading them.
--
-- The tables go before the functions because each table carries its own append-only or monotonic
-- trigger, and a trigger is a hard dependency on the function behind it.
-- ---------------------------------------------------------------------------------------------
DROP VIEW failure_continuation_owner_decision_inbox;
DROP VIEW failure_continuation_project_attention;
DROP VIEW failure_successor_current;

DROP TABLE failure_successor_dependency_rebind;
DROP TABLE failure_successor_current_binding;
DROP TABLE failure_successor_handoff;
DROP TABLE failure_continuation_route_decision;
DROP TABLE failure_continuation_wakeup_outbox;
DROP TABLE failure_continuation_obligation;
DROP TABLE failure_continuation_attempt_receipt;

DROP FUNCTION failure_successor_handoff_commit(uuid, text, uuid, text, uuid, uuid, uuid, timestamptz);
DROP FUNCTION failure_successor_handoff_read(uuid);
DROP FUNCTION failure_successor_task_binding_guard();
DROP FUNCTION failure_successor_current_binding_guard();

DROP FUNCTION failure_continuation_route_claim(uuid, uuid, uuid, bigint, timestamptz, text, text, text, jsonb);
DROP FUNCTION failure_continuation_route_read(uuid);
DROP FUNCTION failure_continuation_sweep(timestamptz, integer);
DROP FUNCTION failure_continuation_claim_wakeups(text, timestamptz, integer, integer);
DROP FUNCTION failure_continuation_ack_wakeup(uuid, uuid, bigint, uuid, uuid, timestamptz);
DROP FUNCTION failure_continuation_retry_wakeup(uuid, uuid, bigint, timestamptz, text);
DROP FUNCTION failure_continuation_cancel_wakeup(uuid, uuid, bigint, timestamptz, text);
DROP FUNCTION failure_continuation_materialize(uuid);
DROP FUNCTION failure_continuation_continuation_trigger();
DROP FUNCTION failure_continuation_record_attempt(uuid);
DROP FUNCTION failure_continuation_attempt_receipt_trigger();
DROP FUNCTION failure_continuation_idempotency_key(uuid, uuid, bigint, bigint, text);

-- ---------------------------------------------------------------------------------------------
-- 4. 0213's failure-site input: the two attempt columns, their shape check and the enum.
--
-- The fingerprint column itself is 0200's and stays. It goes back to the four-input composition
-- restored above, which is what `executableFailureFingerprint()` in
-- `tasks/executable-acceptance-runtime.ts` now writes.
-- ---------------------------------------------------------------------------------------------
ALTER TABLE "task_executable_attempt"
  DROP CONSTRAINT "task_executable_attempt_failure_site_digest_check",
  DROP COLUMN "failure_site_source",
  DROP COLUMN "failure_site_digest";

DROP FUNCTION executable_failure_fingerprint(text, text, integer, text, text);
DROP FUNCTION executable_failure_site_digest(text);
DROP FUNCTION executable_failure_site_source(text);
DROP FUNCTION executable_failure_site_identity(text);
DROP TYPE executable_failure_site_source;

-- ---------------------------------------------------------------------------------------------
-- 5. The one wake constraint that only ever qualified this project's event.
-- ---------------------------------------------------------------------------------------------
ALTER TABLE project_coordinator_wake
  DROP CONSTRAINT project_coordinator_wake_failure_continuation_subject_chk;

COMMIT;
