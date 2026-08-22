-- `[K5]` §6: the only shape a verification Session may write, and the one consequence it produces.
--
-- §1 OW1/OW2 forbid the two verbs a verifying agent actually has — edit the subject, keep steering
-- the worker — and a prohibition with no legal alternative is one agents route around. `[K1]` froze
-- the table that says which of §3's six classes produces which of §3's six results; nothing has been
-- able to WRITE one. This migration is the row that carries it, and the two constraints that make
-- "one finding, one result" a property of the database rather than of whoever is holding the lease.
--
-- Three additions and no rewrites:
--
--   1. `task_verification_finding`: append-only, keyed on FD1's dedup key, linked to `[K2]`'s
--      decision and to whatever Task or blocker it produced.
--   2. One kind on `project_blocker_kind_chk`, for `[H0V2]`'s residue — the shape where a check is
--      DONE having concluded nothing, which no write, no gap and no condition covered.
--   3. `task_verification_verdict_atomic`: a check may not REACH `DONE` without a verdict.
--
-- DEPLOYMENT ORDER — this migration goes FIRST, on 0133's reasoning for its blocker kind and on the
-- OPPOSITE reasoning for the trigger. The kind is a value only new code writes, so an old replica
-- cannot be harmed by accepting it. The trigger REFUSES something an old replica can still do, and
-- that is deliberate: the thing it refuses is the defect, the old replica has no legal use for it,
-- and a rolling window in which one of the two processes can still write the broken shape is a
-- window in which this whole unit is advisory. What an old replica loses is the ability to finish a
-- check without saying what it found, which it should never have had.

-- ---------------------------------------------------------------------------------------------
-- 1. The finding.
-- ---------------------------------------------------------------------------------------------
-- Subordinate to Task, like `[K2]`'s ledger and `[K3]`'s attempt, and for RL4's reason: the business
-- layer stays Project and Task, and a finding is an internal fact about one of them.
--
-- `(task_id, scope_revision, scope_hash)` is the same composite foreign key the decision ledger
-- carries, and it is here for FD4's reason rather than for tidiness: a finding names the revision it
-- was measured against, hash included, so it can never be re-pointed at a scope that did not have
-- that content. A conclusion about a question nobody asked any more is the shape §0's incident kept
-- producing, and this is where it stops being storable.
CREATE TABLE "task_verification_finding" (
  "id"                     UUID PRIMARY KEY,
  "task_id"                UUID NOT NULL,
  "owner_id"               UUID NOT NULL,
  -- Denormalised from the task on purpose: FD1's key is scoped by project, and a finding has to
  -- keep answering for the project it was filed in after the task is re-filed elsewhere.
  "project_id"             UUID,
  "seq"                    BIGINT NOT NULL,

  "scope_revision"         INTEGER NOT NULL,
  "scope_hash"             CHAR(64) NOT NULL,

  -- FD1. `pc:v1:{projectId}:finding:{subjectTaskId}:{scopeRevision}:{failureFingerprint}` — four
  -- terms, and the UNIQUE below is the whole of "重复 finding 不重复建 Task". Deliberately absent
  -- from it: the reporter, the check, the session, the attempt generation and the clock. Any one of
  -- those would give the same defect found twice a second key and a second subtask.
  "dedup_key"              TEXT NOT NULL,

  -- §6's table, verbatim. Every column NOT NULL because every row of that table says 是.
  "severity"               TEXT NOT NULL,
  "violated_invariant"     TEXT NOT NULL,
  "minimal_repro"          TEXT NOT NULL,
  "failure_fingerprint"    CHAR(64) NOT NULL,
  "scope_classification"   TEXT NOT NULL,
  "evidence"               JSONB NOT NULL,
  "verdict"                TEXT NOT NULL,

  -- WHO is claiming it, and from where. §3's `谁能定` column is enforced by the service against
  -- `FINDING_REPORTERS`; what is stored is the claim itself, so an audit can ask who said this.
  -- No foreign keys on the two ids, on migration 0120's rule: deleting a session or a task must not
  -- rewrite who reported an earlier finding.
  "reporter"               TEXT NOT NULL,
  "reporter_task_id"       UUID,
  "reporter_session_id"    UUID,

  -- FD2's answer, and how it was reached. `effective_classification` differs from
  -- `scope_classification` only under CL2, and then `override_reason` says so — a rewrite that left
  -- no trace would make "it was called transient six times" unaskable.
  "effective_classification" TEXT NOT NULL,
  "outcome"                TEXT NOT NULL,
  "override_reason"        TEXT,
  "effect_kind"            TEXT NOT NULL,

  -- The permanent key of this finding's ONE effect, derived from `dedup_key` and never minted. It
  -- is what makes a crash between the row and its Task recoverable: the replay re-derives the same
  -- key, and the UNIQUE below decides which of the two attempts happened.
  "effect_idempotency_key" TEXT NOT NULL,
  -- What it produced. Exactly one is non-null, and the CHECK below says which for which outcome.
  "effect_task_id"         UUID REFERENCES "task"("id") ON DELETE SET NULL,
  "effect_blocker_kind"    TEXT,

  -- finding → decision (§8's audit, and the reason this is not a second ledger): the judgment that
  -- turned this finding into that effect, in `[K2]`'s ledger, with its counters and its input hash.
  "decision_id"            UUID REFERENCES "task_convergence_decision"("id") ON DELETE SET NULL,

  -- §11.1's three questions, per finding.
  "required_action"        TEXT NOT NULL,
  "owner"                  TEXT NOT NULL,
  "next_check_at"          TIMESTAMP(3),

  "created_at"             TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "task_verification_finding_task_fkey"
    FOREIGN KEY ("task_id", "owner_id") REFERENCES "task"("id", "owner_id") ON DELETE CASCADE,
  CONSTRAINT "task_verification_finding_scope_fkey"
    FOREIGN KEY ("task_id", "scope_revision", "scope_hash")
    REFERENCES "task_scope_revision"("task_id", "revision", "scope_hash") ON DELETE CASCADE
);

-- FD1, as the constraint the whole unit rests on. A redelivery, a restart mid-transaction, two
-- coordinators racing and the same defect reported by a second check all collide here.
CREATE UNIQUE INDEX "task_verification_finding_dedup_key"
  ON "task_verification_finding" ("dedup_key");

-- FD2's other half. The dedup key stops a second FINDING; this stops a second EFFECT for a finding
-- whose row was rolled back and re-inserted under a new id.
CREATE UNIQUE INDEX "task_verification_finding_effect_key"
  ON "task_verification_finding" ("effect_idempotency_key");

-- Replay ORDER that does not depend on `created_at`, which two writers can tie on. Allocated
-- MAX + 1 under the task row lock, exactly as the decision ledger's `seq` is.
CREATE UNIQUE INDEX "task_verification_finding_seq_key"
  ON "task_verification_finding" ("task_id", "seq");
CREATE INDEX "task_verification_finding_task_idx"
  ON "task_verification_finding" ("task_id", "seq" DESC);
CREATE INDEX "task_verification_finding_owner_idx"
  ON "task_verification_finding" ("owner_id", "created_at" DESC);
-- FD3': "has this revision already been repaired, and how bad was it then". One index scan rather
-- than a table scan, on the exact three columns the triage reads.
CREATE INDEX "task_verification_finding_repair_idx"
  ON "task_verification_finding" ("task_id", "scope_revision", "seq" DESC);
CREATE INDEX "task_verification_finding_effect_task_idx"
  ON "task_verification_finding" ("effect_task_id");

ALTER TABLE "task_verification_finding" ADD CONSTRAINT "task_verification_finding_shape_chk"
  CHECK (
    "severity" IN ('P0', 'P1', 'P2', 'P3')
    -- §6 has two values and not three. A check that PASSED has nothing to report, produces no work
    -- item and spends no budget, so a "finding" saying so would be a row with no consequence.
    AND "verdict" IN ('FAIL', 'INCONCLUSIVE')
    AND "scope_classification" IN (
      'TRANSIENT', 'IN_SCOPE_DEFECT', 'PREREQUISITE', 'SCOPE_EXPANSION', 'ENVIRONMENT',
      'HUMAN_REQUIRED')
    AND "effective_classification" IN (
      'TRANSIENT', 'IN_SCOPE_DEFECT', 'PREREQUISITE', 'SCOPE_EXPANSION', 'ENVIRONMENT',
      'HUMAN_REQUIRED')
    AND "outcome" IN (
      'RETRY_WITHIN_BUDGET', 'CREATE_DEFECT_SUBTASK', 'CREATE_PREREQUISITE_TASK',
      'FREEZE_AND_REQUEST_REPLAN', 'RAISE_SYSTEM_BLOCKER', 'RAISE_USER_BLOCKER')
    AND "effect_kind" IN (
      'DEFECT_SUBTASK', 'PREREQUISITE_TASK', 'REPLAN_TASK', 'SYSTEM_BLOCKER', 'USER_BLOCKER',
      'NONE')
    AND "reporter" IN ('USER', 'COORDINATOR', 'WORKER', 'VERIFIER')
    AND "owner" IN ('USER', 'COORDINATOR', 'SYSTEM')
    -- Parenthesised, and the reason is worth a line: `AND` binds tighter than `OR`, so the
    -- unbracketed spelling reads as "(everything above AND reason IS NULL) OR reason IN (...)" —
    -- which passes the WHOLE constraint for any row carrying one of the four values, whatever else
    -- it says. A shape check that a malformed row can satisfy by being malformed in one more place.
    AND ("override_reason" IS NULL OR "override_reason" IN (
      'TRANSIENT_BUDGET_EXHAUSTED', 'VERIFICATION_ROUNDS_EXHAUSTED',
      'REPAIR_WITHOUT_SEVERITY_DROP', 'CIRCUIT_TRIPPED'))
  );

-- §6's "非空" rows, as constraints rather than as hope. An unreproducible claim is not a finding.
ALTER TABLE "task_verification_finding" ADD CONSTRAINT "task_verification_finding_content_chk"
  CHECK (
    length(btrim("violated_invariant")) > 0
    AND length(btrim("minimal_repro")) > 0
    AND "failure_fingerprint" ~ '^[0-9a-f]{64}$'
    AND jsonb_typeof("evidence") = 'object'
    AND "evidence" <> '{}'::jsonb
  );

-- FD2 in one line: the effect a finding claims to have had must be the one its outcome allows, and
-- the artifact must exist for the three outcomes that HAVE one. Written as a single cross-column
-- CHECK rather than two triggers because it has to be true at every instant, including inside the
-- transaction that writes the row.
ALTER TABLE "task_verification_finding" ADD CONSTRAINT "task_verification_finding_effect_chk"
  CHECK (
    CASE "outcome"
      WHEN 'CREATE_DEFECT_SUBTASK' THEN
        "effect_kind" = 'DEFECT_SUBTASK'
        AND "effect_task_id" IS NOT NULL AND "effect_blocker_kind" IS NULL
      WHEN 'CREATE_PREREQUISITE_TASK' THEN
        "effect_kind" = 'PREREQUISITE_TASK'
        AND "effect_task_id" IS NOT NULL AND "effect_blocker_kind" IS NULL
      WHEN 'FREEZE_AND_REQUEST_REPLAN' THEN
        "effect_kind" = 'REPLAN_TASK'
        AND "effect_task_id" IS NOT NULL AND "effect_blocker_kind" IS NULL
      WHEN 'RAISE_SYSTEM_BLOCKER' THEN
        "effect_kind" = 'SYSTEM_BLOCKER'
        AND "effect_task_id" IS NULL AND "effect_blocker_kind" IS NOT NULL
      WHEN 'RAISE_USER_BLOCKER' THEN
        "effect_kind" = 'USER_BLOCKER'
        AND "effect_task_id" IS NULL AND "effect_blocker_kind" IS NOT NULL
      WHEN 'RETRY_WITHIN_BUDGET' THEN
        "effect_kind" = 'NONE'
        AND "effect_task_id" IS NULL AND "effect_blocker_kind" IS NULL
      ELSE FALSE
    END
  );

-- §11.1's third question, on the ledger's own rule: a wait that ends when a person decides has no
-- clock, so a USER-owned finding may not carry one.
ALTER TABLE "task_verification_finding" ADD CONSTRAINT "task_verification_finding_clock_chk"
  CHECK ("owner" <> 'USER' OR "next_check_at" IS NULL);

-- CL2's audit: `effective_classification` may differ from what was submitted ONLY by that rule, and
-- only in that direction. Anything else is the row rewriting the reporter's claim.
ALTER TABLE "task_verification_finding" ADD CONSTRAINT "task_verification_finding_reclass_chk"
  CHECK (
    "effective_classification" = "scope_classification"
    OR ("scope_classification" = 'TRANSIENT'
        AND "effective_classification" = 'IN_SCOPE_DEFECT'
        AND "override_reason" = 'TRANSIENT_BUDGET_EXHAUSTED')
  );

-- Append-only, on `[K2]`'s reasoning for its own ledger: a finding is what somebody concluded at a
-- moment, and editing it in place destroys the only evidence of what the effect was decided FROM.
CREATE OR REPLACE FUNCTION "task_verification_finding_immutable_guard"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION USING
    ERRCODE = '23514',
    MESSAGE = format('FINDING_IMMUTABLE: finding %s cannot be updated or deleted', OLD."id");
END;
$$;

CREATE TRIGGER "task_verification_finding_immutable_guard"
BEFORE UPDATE OR DELETE ON "task_verification_finding"
FOR EACH ROW EXECUTE FUNCTION "task_verification_finding_immutable_guard"();

-- FD4, as the fence the decision ledger already has: a finding may not name a revision the task has
-- moved past. The composite foreign key above proves the revision EXISTED; this proves it is the
-- one the task is on right now, which is a different claim and the one FD4 makes.
CREATE OR REPLACE FUNCTION "task_verification_finding_fence"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  current_revision INTEGER;
BEGIN
  SELECT t."scope_revision" INTO current_revision FROM "task" t WHERE t."id" = NEW."task_id";
  IF current_revision IS DISTINCT FROM NEW."scope_revision" THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = format(
        'STALE_SCOPE_REVISION: finding names revision %s of task %s, which is on revision %s',
        NEW."scope_revision", NEW."task_id", current_revision);
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "task_verification_finding_fence"
BEFORE INSERT ON "task_verification_finding"
FOR EACH ROW EXECUTE FUNCTION "task_verification_finding_fence"();

-- ---------------------------------------------------------------------------------------------
-- 2. `[H0V2]`'s residue, as a §11 row.
-- ---------------------------------------------------------------------------------------------
ALTER TABLE "project_blocker" DROP CONSTRAINT "project_blocker_kind_chk";

ALTER TABLE "project_blocker" ADD CONSTRAINT "project_blocker_kind_chk"
  CHECK ("kind" IN (
    'WHO_UNRESOLVED', 'WHO_NOT_IN_TEAM', 'WHO_DISABLED', 'PROVIDER_UNAVAILABLE',
    'RUNTIME_REQUIREMENT_UNMET', 'NO_PROJECT_WORKSPACE', 'NO_MATCHING_RUNNER',
    'MERGE_CONFLICT', 'TEST_FAILED', 'VERIFICATION_FAILED', 'BUDGET_EXHAUSTED',
    'AWAITING_USER_APPROVAL', 'AWAITING_USER_INPUT', 'POLICY_MANUAL_HOLD',
    'DEPENDENCY_CYCLE', 'COORDINATOR_UNAVAILABLE', 'COORDINATOR_NO_PROGRESS',
    'AGGREGATE_PARENT_UNSATISFIABLE', 'SUCCESSOR_OUTSIDE_SUBTREE', 'VERIFICATION_REQUIRED',
    'VERIFICATION_CANNOT_CONCLUDE', 'ENVIRONMENT_BROKEN', 'HUMAN_DECISION_REQUIRED',
    'UNKNOWN_FAILURE'
  ));

-- ---------------------------------------------------------------------------------------------
-- 3. A check may not REACH `DONE` without saying what it found.
-- ---------------------------------------------------------------------------------------------
-- §13.2 V1 already says a check's carrier is its own terminal state PLUS a structured result, and
-- until now only the first half was enforced anywhere. `[H0V2]` confirmed the gap by writing the
-- row by hand: `status=DONE, verdict=NULL, verdict_revision=0` is accepted, and `updateTask` has no
-- clause about it either. Everything downstream then behaves correctly and uselessly — the subject
-- cannot pass, the dependents stay blocked, and nothing says why.
--
-- `WHEN` is narrow on purpose, and each clause buys something:
--
--   - `OLD."status" IS DISTINCT FROM 'DONE'` restricts this to the TRANSITION. A row that already
--     carries the broken shape — written before this migration — can still be edited, renamed,
--     re-parented and cancelled. Refusing those too would turn existing bad data into rows nobody
--     can clean up, which is a worse wedge than the one being closed.
--   - `UPDATE OF "status", "verdict"` means an unrelated column write never even evaluates it.
--
-- The legal spellings both remain: write the verdict first and the status after, or write both in
-- one UPDATE. What stops being possible is finishing a check without concluding.
CREATE OR REPLACE FUNCTION "task_verification_verdict_atomic"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION USING
    ERRCODE = '23514',
    MESSAGE = format(
      'VERDICT_REQUIRED_WITH_DONE: task %s verifies %s and cannot be DONE without a verdict',
      NEW."id", NEW."verifies_task_id");
END;
$$;

CREATE TRIGGER "task_verification_verdict_atomic_insert"
BEFORE INSERT ON "task"
FOR EACH ROW
WHEN (NEW."verifies_task_id" IS NOT NULL AND NEW."status"::text = 'DONE'
      AND NEW."verdict" IS NULL)
EXECUTE FUNCTION "task_verification_verdict_atomic"();

CREATE TRIGGER "task_verification_verdict_atomic_update"
BEFORE UPDATE OF "status", "verdict" ON "task"
FOR EACH ROW
WHEN (NEW."verifies_task_id" IS NOT NULL AND NEW."status"::text = 'DONE'
      AND NEW."verdict" IS NULL AND OLD."status"::text IS DISTINCT FROM 'DONE')
EXECUTE FUNCTION "task_verification_verdict_atomic"();
