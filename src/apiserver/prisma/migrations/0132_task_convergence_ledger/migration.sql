-- `[K2]`: the durable half of the bounded-convergence contract
-- (`docs/project-coordinator-convergence-contract.md`, frozen by `[K1]`).
--
-- `[K1]` proved the breaker is decidable from committed facts. Nothing yet COMMITS those facts, so
-- every counter it reads still lives in whatever process happened to compute it — which is the
-- incident's second half (§0): "重启把计数清零，于是预算永远用不完". A budget held in memory is not a
-- budget. This migration is where the ledger those functions read becomes a table.
--
-- Three durable objects, and no new business entity (RL4 — the business layer is still Project and
-- Task):
--
--   1. `task_scope_revision`  — WHAT a task is asking for, frozen, one immutable row per version.
--   2. `task_convergence_decision` — the append-only judgment ledger: input snapshot and its hash,
--      attempt generation, failure fingerprint, progress vector, decision, action, idempotency key,
--      known-good checkpoint, and requiredAction/owner/nextCheckAt.
--   3. columns on `task` and `project` — the current pointer into 1 and 2, and the policy budget.
--
-- The properties this file is responsible for are the ones a service cannot hold on its own,
-- because the next writer, a takeover, a redelivered event or a raw statement is not running the
-- service's code:
--
--   * RL3/TH4 — a counter never goes DOWN except by strict progress or a new revision. A restart
--     that re-initialises from zero is refused by the database, not by a code path it skipped.
--   * §1 — a scope change is a row somebody signed, and under `GUARDED_AUTO` that somebody is a
--     USER (OW3/OW5).
--   * §6 FD4 — a stale attempt cannot write against a scope it is no longer working on.
--   * OW4 — an unbounded threshold without a USER's signature is not a weaker authorization; it is
--     not one, and the CHECK below is what makes that true of a stray UPDATE as well.

-- ---------------------------------------------------------------------------------------------
-- §8: the policy budget, per Project.
-- ---------------------------------------------------------------------------------------------
-- Overrides only. `NULL` means "the defaults in `convergence-contract.ts`", so this migration
-- changes no project's behaviour on the day it lands (project AC11) — an existing project keeps
-- `GUARDED_AUTO`'s finite defaults without anybody choosing them, which is the safe direction.
ALTER TABLE "project"
  ADD COLUMN "convergence_thresholds"  JSONB,
  ADD COLUMN "attempt_budget"          JSONB,
  ADD COLUMN "unbounded_authorized_by" JSONB;

-- OW4, at the only place every writer passes through. `resolveThresholds` already ignores an
-- unsigned `null`, but "the service ignores it" and "it cannot be stored" are different promises,
-- and the failure this refuses — a migration, a stray PATCH, or an agent writing its own
-- authorization and switching the breaker off for every project at once — arrives through the
-- writers that did not read the service.
ALTER TABLE "project" ADD CONSTRAINT "project_unbounded_authorized_by_chk" CHECK (
  "unbounded_authorized_by" IS NULL
  OR (
    jsonb_typeof("unbounded_authorized_by") = 'object'
    AND "unbounded_authorized_by"->>'actor' = 'USER'
    AND coalesce(btrim("unbounded_authorized_by"->>'principal'), '') <> ''
  )
);

ALTER TABLE "project" ADD CONSTRAINT "project_convergence_thresholds_chk" CHECK (
  "convergence_thresholds" IS NULL OR jsonb_typeof("convergence_thresholds") = 'object'
);

ALTER TABLE "project" ADD CONSTRAINT "project_attempt_budget_chk" CHECK (
  "attempt_budget" IS NULL OR jsonb_typeof("attempt_budget") = 'object'
);

-- ---------------------------------------------------------------------------------------------
-- §1/§2/§4: the current pointer, per Task.
-- ---------------------------------------------------------------------------------------------
-- Every default is the value an existing row already behaves as, so no task changes state here.
-- In particular `attempt_generation = 0` means no attempt has been recorded, which is what makes
-- the freeze below a no-op for every task that exists today.
ALTER TABLE "task"
  ADD COLUMN "scope_revision"       INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "attempt_generation"   BIGINT  NOT NULL DEFAULT 0,
  ADD COLUMN "progress_state"       TEXT    NOT NULL DEFAULT 'CONVERGING',
  ADD COLUMN "convergence_counters" JSONB   NOT NULL DEFAULT
    '{"attemptsOnRevision":0,"attemptsWithoutProgress":0,"sameFingerprintRepeats":0,"decisionsWithoutProgress":0,"verificationRounds":0,"transientRetries":0,"scopeExpansionRequests":0}'::jsonb,
  ADD COLUMN "last_progress_at"     TIMESTAMP(3),
  ADD COLUMN "known_good_sha"       TEXT;

ALTER TABLE "task" ADD CONSTRAINT "task_progress_state_chk" CHECK ("progress_state" IN (
  'CONVERGING', 'RETRYING_TRANSIENT', 'VERIFYING', 'NEEDS_REPLAN', 'BLOCKED',
  'AWAITING_HUMAN', 'SETTLED'
));

ALTER TABLE "task" ADD CONSTRAINT "task_scope_revision_chk" CHECK ("scope_revision" >= 1);
ALTER TABLE "task" ADD CONSTRAINT "task_attempt_generation_chk" CHECK ("attempt_generation" >= 0);

-- The seven counters of §8, present and non-negative. A missing key would read as NULL through
-- `->>` and as 0 through a careless cast, and a budget that silently reads 0 for a counter is a
-- budget that never trips — so "all seven are there" is checked, not assumed.
--
-- An IMMUTABLE helper rather than fourteen inline clauses: a CHECK may not contain a subquery, and
-- the alternative spelling would repeat the counter names once per column that stores a set of
-- them. The names live here, once.
CREATE OR REPLACE FUNCTION "task_convergence_counters_valid"(counters JSONB) RETURNS BOOLEAN
LANGUAGE sql IMMUTABLE AS $$
  SELECT jsonb_typeof(counters) = 'object'
     AND bool_and(
           counters ? k
           AND jsonb_typeof(counters->k) = 'number'
           AND (counters->>k)::numeric >= 0
         )
    FROM unnest(ARRAY[
      'attemptsOnRevision', 'attemptsWithoutProgress', 'sameFingerprintRepeats',
      'decisionsWithoutProgress', 'verificationRounds', 'transientRetries',
      'scopeExpansionRequests'
    ]) AS k;
$$;

ALTER TABLE "task" ADD CONSTRAINT "task_convergence_counters_chk"
  CHECK ("task_convergence_counters_valid"("convergence_counters"));

-- The tenancy fence the two ledger tables hang off. Task rows already carry `owner_id`; making
-- (id, owner_id) a key lets a child row name BOTH and be unable to disagree with its parent about
-- whose it is — the same device migration 0120 used for (decision, project).
CREATE UNIQUE INDEX "task_id_owner_id_key" ON "task" ("id", "owner_id");

-- ---------------------------------------------------------------------------------------------
-- §1: `task_scope_revision` — what the task is asking for, frozen.
-- ---------------------------------------------------------------------------------------------
-- One row per version, immutable, never deleted except with the task. The old rows ARE the audit
-- the contract asks for: after an expansion you can still read what the task USED to ask for, and
-- therefore whether the attempts charged to that revision were spent on the thing that was asked.
--
-- A task is "managed" exactly when it has a row here. That is the whole compatibility story:
-- nothing existing has one, so nothing existing is frozen, authorized, or fenced by this migration.
-- `[K2]`'s service writes the baseline row the first time a task is judged, and management starts
-- there.
CREATE TABLE "task_scope_revision" (
  "id"                      UUID     NOT NULL,
  "task_id"                 UUID     NOT NULL,
  "owner_id"                UUID     NOT NULL,
  "revision"                INTEGER  NOT NULL,

  -- The §1 digest. `scope_hash` is the identity a progress vector and a failure fingerprint are
  -- measured against (§4 PV3, §5 FP3); the three text columns are what it is a digest OF, kept
  -- verbatim so the audit can answer "what did it say" and not only "did it change".
  "scope_hash"              CHAR(64) NOT NULL,
  "title"                   TEXT     NOT NULL,
  "description"             TEXT,
  "acceptance_criteria"     TEXT,

  -- WHO signed for this version. NULL is legal only at revision 1, and means "as found" — the
  -- task's original statement of scope, which nobody revised into being.
  "authorized_by_actor"     TEXT,
  "authorized_by_principal" TEXT,
  -- The policy in force when it was signed. Recorded rather than looked up later, because
  -- `automation_policy` is mutable and an audit that re-reads today's value cannot answer whether
  -- a coordinator was allowed to do this at the time it did it.
  "automation_policy"       TEXT,
  "reason"                  TEXT     NOT NULL,
  "supersedes_revision"     INTEGER,
  "created_at"              TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "task_scope_revision_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "task_scope_revision_task_revision_key" UNIQUE ("task_id", "revision"),
  -- The composite key the ledger points at. Naming the hash as well as the revision is what stops
  -- a decision from claiming to be measured against a scope that never had that content.
  CONSTRAINT "task_scope_revision_identity_key" UNIQUE ("task_id", "revision", "scope_hash"),
  CONSTRAINT "task_scope_revision_revision_chk" CHECK ("revision" >= 1),
  CONSTRAINT "task_scope_revision_hash_chk" CHECK ("scope_hash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "task_scope_revision_actor_chk" CHECK (
    "authorized_by_actor" IS NULL
    OR "authorized_by_actor" IN ('USER', 'COORDINATOR', 'WORKER', 'VERIFIER')
  ),
  CONSTRAINT "task_scope_revision_policy_chk" CHECK (
    "automation_policy" IS NULL OR "automation_policy" IN ('MANUAL', 'GUARDED_AUTO', 'AUTO')
  ),
  -- A signature is an actor AND a principal; half of one is not a weaker signature (OW4's shape,
  -- applied to scope as well as to thresholds).
  CONSTRAINT "task_scope_revision_signature_chk" CHECK (
    ("authorized_by_actor" IS NULL) = ("authorized_by_principal" IS NULL)
    AND ("authorized_by_principal" IS NULL OR btrim("authorized_by_principal") <> '')
  ),
  -- Only revision 1 may be unsigned, and only revision 1 supersedes nothing. The chain is dense:
  -- every later revision names the one it replaced, so the audit is a list and not a set.
  CONSTRAINT "task_scope_revision_baseline_chk" CHECK (
    ("revision" = 1 AND "supersedes_revision" IS NULL)
    OR ("revision" > 1 AND "supersedes_revision" = "revision" - 1
        AND "authorized_by_actor" IS NOT NULL)
  )
);

ALTER TABLE "task_scope_revision" ADD CONSTRAINT "task_scope_revision_task_fkey"
  FOREIGN KEY ("task_id", "owner_id") REFERENCES "task"("id", "owner_id")
  ON DELETE CASCADE ON UPDATE CASCADE;

CREATE INDEX "task_scope_revision_owner_id_idx" ON "task_scope_revision" ("owner_id");

-- §1 OW3/OW5, as a table check rather than as prose in a prompt.
--
-- The coordinator's answer to "this needs to be a different task" is to stop and ask (`ALLOWED`
-- only for `REQUEST_SCOPE_EXPANSION`); AUTO is the user having signed for the re-planning in
-- advance, and it opens that one cell and no other. A WORKER or a VERIFIER never revises scope
-- under any policy — a verifier that can edit the acceptance criteria is grading its own exam.
--
-- The policy is read from the task's project at write time. A task with no project has no policy
-- that could have authorized an agent, so only a USER may revise it.
CREATE OR REPLACE FUNCTION "task_scope_revision_authority_guard"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  policy TEXT;
BEGIN
  IF NEW."revision" = 1 THEN RETURN NEW; END IF;
  IF NEW."authorized_by_actor" = 'USER' THEN RETURN NEW; END IF;

  SELECT p."automation_policy"::text INTO policy
    FROM "task" t LEFT JOIN "project" p ON p."id" = t."project_id"
   WHERE t."id" = NEW."task_id";

  IF NEW."authorized_by_actor" = 'COORDINATOR' AND policy = 'AUTO' THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION USING
    ERRCODE = '23514',
    MESSAGE = format(
      'SCOPE_CHANGE_REQUIRES_USER: %s may not revise task %s to revision %s under policy %s',
      NEW."authorized_by_actor", NEW."task_id", NEW."revision", coalesce(policy, 'NONE'));
END;
$$;

CREATE TRIGGER "task_scope_revision_authority_guard"
BEFORE INSERT ON "task_scope_revision"
FOR EACH ROW EXECUTE FUNCTION "task_scope_revision_authority_guard"();

-- CP1's shape, applied to scope: a revision is a version, and editing a version in place destroys
-- the only evidence that the earlier attempts were charged to a different question.
CREATE OR REPLACE FUNCTION "task_scope_revision_immutable_guard"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION USING
    ERRCODE = '23514',
    MESSAGE = format('SCOPE_REVISION_IMMUTABLE: revision %s of task %s cannot be updated',
                     OLD."revision", OLD."task_id");
END;
$$;

CREATE TRIGGER "task_scope_revision_immutable_guard"
BEFORE UPDATE ON "task_scope_revision"
FOR EACH ROW EXECUTE FUNCTION "task_scope_revision_immutable_guard"();

-- ---------------------------------------------------------------------------------------------
-- The ledger: `task_convergence_decision`.
-- ---------------------------------------------------------------------------------------------
-- One row per coordination judgment about one task. Append-only, and a pure function of the
-- snapshot named in `input` — `input_hash` is what makes "replay this decision" a comparison
-- rather than a story.
CREATE TABLE "task_convergence_decision" (
  "id"                     UUID     NOT NULL,
  "task_id"                UUID     NOT NULL,
  "owner_id"               UUID     NOT NULL,
  -- Monotonic within a task, allocated MAX + 1 under the task row lock. It is what gives the
  -- ledger a replay ORDER that does not depend on `created_at`, which two writers can tie on.
  "seq"                    BIGINT   NOT NULL,

  "scope_revision"         INTEGER  NOT NULL,
  "scope_hash"             CHAR(64) NOT NULL,
  "attempt_generation"     BIGINT   NOT NULL,

  -- §6.2's shape: the permanent name of this judgment. A redelivered or out-of-order event
  -- recomputes the same key from the same facts, conflicts, and is read instead of written.
  "idempotency_key"        TEXT     NOT NULL,
  "input_hash"             CHAR(64) NOT NULL,
  "input"                  JSONB    NOT NULL,

  "event"                  TEXT     NOT NULL,
  "from_state"             TEXT     NOT NULL,
  "to_state"               TEXT     NOT NULL,
  "classification"         TEXT,
  "decision"               TEXT     NOT NULL,

  -- What the decision actually DID, and under which key. Both or neither: an action without a key
  -- is an action a takeover cannot recognise as already done, which is how one decision becomes
  -- two dispatches.
  "action"                 TEXT,
  "action_idempotency_key" TEXT,

  "failure_fingerprint"    CHAR(64),
  "progress_vector"        JSONB    NOT NULL,
  "progress_vector_digest" CHAR(64) NOT NULL,
  "progressed"             BOOLEAN  NOT NULL,
  "counters"               JSONB    NOT NULL,
  "non_convergence_reason" TEXT,
  "known_good_sha"         TEXT,

  -- §11.1's three questions, asked here per task rather than per project: what has to happen, who
  -- can make it happen, and when this is worth looking at again.
  "required_action"        TEXT,
  "owner"                  TEXT,
  "next_check_at"          TIMESTAMP(3),

  -- Historical attribution, deliberately without foreign keys (migration 0120's rule): deleting or
  -- rotating a session must not rewrite which run made an earlier judgment.
  "decided_by"             TEXT     NOT NULL,
  "session_id"             UUID,
  "project_decision_id"    UUID,
  "created_at"             TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "task_convergence_decision_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "task_convergence_decision_idempotency_key" UNIQUE ("idempotency_key"),
  CONSTRAINT "task_convergence_decision_seq_key" UNIQUE ("task_id", "seq"),

  CONSTRAINT "task_convergence_decision_seq_chk" CHECK ("seq" >= 1),
  CONSTRAINT "task_convergence_decision_generation_chk" CHECK ("attempt_generation" >= 0),
  CONSTRAINT "task_convergence_decision_hash_chk" CHECK (
    "input_hash" ~ '^[0-9a-f]{64}$'
    AND "progress_vector_digest" ~ '^[0-9a-f]{64}$'
    AND ("failure_fingerprint" IS NULL OR "failure_fingerprint" ~ '^[0-9a-f]{64}$')
  ),
  CONSTRAINT "task_convergence_decision_event_chk" CHECK ("event" IN (
    'ATTEMPT_STARTED', 'ATTEMPT_DELIVERED', 'ATTEMPT_FAILED_TRANSIENT', 'ATTEMPT_FAILED_IN_SCOPE',
    'VERIFICATION_PASSED', 'VERIFICATION_FAILED_IN_SCOPE', 'PREREQUISITE_FOUND',
    'ENVIRONMENT_FAILURE', 'HUMAN_REQUIRED', 'SCOPE_EXPANSION_REQUESTED', 'CIRCUIT_TRIPPED',
    'BLOCKER_CLEARED', 'REPLAN_AUTHORIZED', 'BUDGET_EXTENDED', 'TASK_TERMINAL'
  )),
  CONSTRAINT "task_convergence_decision_state_chk" CHECK (
    "from_state" IN ('CONVERGING', 'RETRYING_TRANSIENT', 'VERIFYING', 'NEEDS_REPLAN', 'BLOCKED',
                     'AWAITING_HUMAN', 'SETTLED')
    AND "to_state" IN ('CONVERGING', 'RETRYING_TRANSIENT', 'VERIFYING', 'NEEDS_REPLAN', 'BLOCKED',
                       'AWAITING_HUMAN', 'SETTLED')
  ),
  -- SM1: `SETTLED` has no out-edges. A ledger row that leaves it is a task being reopened in
  -- place, which the contract answers with a new revision or a successor task instead.
  CONSTRAINT "task_convergence_decision_settled_terminal_chk" CHECK (
    "from_state" <> 'SETTLED' OR "to_state" = 'SETTLED'
  ),
  CONSTRAINT "task_convergence_decision_classification_chk" CHECK (
    "classification" IS NULL OR "classification" IN (
      'TRANSIENT', 'IN_SCOPE_DEFECT', 'PREREQUISITE', 'SCOPE_EXPANSION', 'ENVIRONMENT',
      'HUMAN_REQUIRED'
    )
  ),
  CONSTRAINT "task_convergence_decision_decision_chk" CHECK ("decision" IN (
    'RETRY_WITHIN_BUDGET', 'CREATE_DEFECT_SUBTASK', 'CREATE_PREREQUISITE_TASK',
    'FREEZE_AND_REQUEST_REPLAN', 'RAISE_SYSTEM_BLOCKER', 'RAISE_USER_BLOCKER',
    'CONTINUE', 'NO_TRANSITION', 'SETTLE'
  )),
  CONSTRAINT "task_convergence_decision_action_chk" CHECK (
    ("action" IS NULL) = ("action_idempotency_key" IS NULL)
  ),
  CONSTRAINT "task_convergence_decision_reason_chk" CHECK (
    "non_convergence_reason" IS NULL OR "non_convergence_reason" IN (
      'SCOPE_EXPANSION_REQUIRED', 'SAME_FAILURE_REPEATED', 'VERIFICATION_ROUNDS_EXHAUSTED',
      'TRANSIENT_RETRY_BUDGET_EXHAUSTED', 'ATTEMPT_BUDGET_EXHAUSTED', 'HARD_ATTEMPT_CAP_REACHED',
      'NO_PROGRESS'
    )
  ),
  -- SM3: the breaker tripping means `NEEDS_REPLAN`, and it never means anything else. Without
  -- this a writer could record a reason and leave the task dispatchable, which reads on the audit
  -- as "we noticed and carried on" — the incident's exact shape.
  CONSTRAINT "task_convergence_decision_trip_chk" CHECK (
    "non_convergence_reason" IS NULL OR "to_state" = 'NEEDS_REPLAN'
  ),
  -- §4 PV3: a vector is only comparable within one scope, so a row may not carry one measured
  -- against a different target than the row itself claims.
  CONSTRAINT "task_convergence_decision_vector_chk" CHECK (
    jsonb_typeof("progress_vector") = 'object'
    AND "progress_vector"->>'scopeHash' = "scope_hash"
  ),
  CONSTRAINT "task_convergence_decision_counters_chk" CHECK (
    "task_convergence_counters_valid"("counters")
  ),
  -- §11.1: an answer nobody owns is not an answer. Whoever reads "this is what has to happen next"
  -- has to be able to read who can do it.
  CONSTRAINT "task_convergence_decision_required_action_chk" CHECK (
    ("required_action" IS NULL) = ("owner" IS NULL)
    AND ("owner" IS NULL OR "owner" IN ('USER', 'COORDINATOR', 'SYSTEM'))
  ),
  CONSTRAINT "task_convergence_decision_decided_by_chk" CHECK (
    "decided_by" IN ('ORCHESTRATOR', 'COORDINATOR_AGENT', 'USER')
  )
);

ALTER TABLE "task_convergence_decision" ADD CONSTRAINT "task_convergence_decision_task_fkey"
  FOREIGN KEY ("task_id", "owner_id") REFERENCES "task"("id", "owner_id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- §6 FD4, as a key rather than as a check the writer might skip: a decision names the exact scope
-- content it was measured against, and only a version that really existed can be named.
ALTER TABLE "task_convergence_decision" ADD CONSTRAINT "task_convergence_decision_scope_fkey"
  FOREIGN KEY ("task_id", "scope_revision", "scope_hash")
  REFERENCES "task_scope_revision"("task_id", "revision", "scope_hash")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- One logical action per decision, across the whole ledger. This is the other half of AC1: the
-- decision is deduped by `idempotency_key`, the ACTION it produced is deduped by its own, so a
-- takeover that recomputes the same plan cannot dispatch a second time.
CREATE UNIQUE INDEX "task_convergence_decision_action_key_idx"
  ON "task_convergence_decision" ("action_idempotency_key")
  WHERE "action_idempotency_key" IS NOT NULL;

CREATE INDEX "task_convergence_decision_task_id_seq_idx"
  ON "task_convergence_decision" ("task_id", "seq" DESC);
CREATE INDEX "task_convergence_decision_owner_id_created_at_idx"
  ON "task_convergence_decision" ("owner_id", "created_at" DESC);
CREATE INDEX "task_convergence_decision_fingerprint_idx"
  ON "task_convergence_decision" ("task_id", "scope_revision", "failure_fingerprint");
CREATE INDEX "task_convergence_decision_next_check_at_idx"
  ON "task_convergence_decision" ("next_check_at")
  WHERE "next_check_at" IS NOT NULL;

CREATE OR REPLACE FUNCTION "task_convergence_decision_immutable_guard"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION USING
    ERRCODE = '23514',
    MESSAGE = format('CONVERGENCE_DECISION_IMMUTABLE: decision %s cannot be updated', OLD."id");
END;
$$;

CREATE TRIGGER "task_convergence_decision_immutable_guard"
BEFORE UPDATE ON "task_convergence_decision"
FOR EACH ROW EXECUTE FUNCTION "task_convergence_decision_immutable_guard"();

-- §6 FD4 + TH3: a judgment is written AS OF the task's current revision and current attempt.
--
-- A row whose revision is behind is a conclusion about a question that has since changed — the
-- contract calls it `STALE_SCOPE_REVISION` and refuses to build on it. A row whose generation is
-- behind is the superseded attempt still writing: it would charge counters for work that has
-- already been replaced, which is how a budget gets spent twice and how "we already did this"
-- turns into a second dispatch. Ahead of the task is an attempt that was never started.
--
-- Strict equality on both, so the answer does not depend on arrival ORDER. Whatever sequence two
-- redelivered events arrive in, at most the current one lands.
CREATE OR REPLACE FUNCTION "task_convergence_decision_fence"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  current_revision  INTEGER;
  current_generation BIGINT;
BEGIN
  SELECT t."scope_revision", t."attempt_generation"
    INTO current_revision, current_generation
    FROM "task" t WHERE t."id" = NEW."task_id";

  IF NEW."scope_revision" <> current_revision THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = format(
        'STALE_SCOPE_REVISION: decision names revision %s of task %s, which is on revision %s',
        NEW."scope_revision", NEW."task_id", current_revision);
  END IF;

  IF NEW."attempt_generation" <> current_generation THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = format(
        'STALE_ATTEMPT_GENERATION: decision names attempt %s of task %s, which is on attempt %s',
        NEW."attempt_generation", NEW."task_id", current_generation);
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER "task_convergence_decision_fence"
BEFORE INSERT ON "task_convergence_decision"
FOR EACH ROW EXECUTE FUNCTION "task_convergence_decision_fence"();

-- ---------------------------------------------------------------------------------------------
-- The two guards on `task` itself.
-- ---------------------------------------------------------------------------------------------
-- RL3/TH4: counters are committed facts, not process memory.
--
-- Every escape from this breaker has one shape — a counter going DOWN without strict progress. A
-- restart re-initialising from zero, a duplicate event processed as a fresh attempt, a second
-- coordinator taking over and starting its own count: all of them are the same UPDATE, and all of
-- them are refused here. `mergeCounters` intends the same rule in the service; this is what still
-- holds when the writer is a raw statement or a version that has not been deployed yet.
--
-- Exactly two licences to go down, both from §4 PV4:
--
--   * a NEW scope revision — a new question gets a new budget, and the old revision's spend stays
--     readable in `task_scope_revision` and in the ledger;
--   * strict progress, which zeroes the four "since last progress" counters and ONLY those four.
--     It has to be a zero rather than any smaller number: "it went down a bit" is not a thing
--     progress does, and allowing it would let a writer walk a counter down one step per pass.
CREATE OR REPLACE FUNCTION "task_convergence_counters_monotonic"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  key           TEXT;
  old_value     NUMERIC;
  new_value     NUMERIC;
  progressed    BOOLEAN;
  resettable    CONSTANT TEXT[] := ARRAY[
    'attemptsWithoutProgress', 'sameFingerprintRepeats', 'decisionsWithoutProgress',
    'transientRetries'
  ];
BEGIN
  IF NEW."scope_revision" < OLD."scope_revision" THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = format('SCOPE_REVISION_MONOTONIC: task %s cannot move from revision %s back to %s',
                       OLD."id", OLD."scope_revision", NEW."scope_revision");
  END IF;

  -- A new revision is a new budget; nothing below applies.
  IF NEW."scope_revision" > OLD."scope_revision" THEN RETURN NEW; END IF;

  IF NEW."attempt_generation" < OLD."attempt_generation" THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = format('ATTEMPT_GENERATION_MONOTONIC: task %s cannot move from attempt %s back to %s',
                       OLD."id", OLD."attempt_generation", NEW."attempt_generation");
  END IF;

  progressed := NEW."last_progress_at" IS NOT NULL
                AND (OLD."last_progress_at" IS NULL
                     OR NEW."last_progress_at" > OLD."last_progress_at");

  FOREACH key IN ARRAY ARRAY[
    'attemptsOnRevision', 'attemptsWithoutProgress', 'sameFingerprintRepeats',
    'decisionsWithoutProgress', 'verificationRounds', 'transientRetries', 'scopeExpansionRequests'
  ] LOOP
    old_value := (OLD."convergence_counters"->>key)::numeric;
    new_value := (NEW."convergence_counters"->>key)::numeric;
    CONTINUE WHEN new_value >= old_value;
    IF progressed AND key = ANY(resettable) AND new_value = 0 THEN CONTINUE; END IF;
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = format(
        'CONVERGENCE_COUNTER_REGRESSED: task %s counter %s cannot go from %s to %s',
        OLD."id", key, old_value, new_value);
  END LOOP;

  RETURN NEW;
END;
$$;

CREATE TRIGGER "task_convergence_counters_monotonic"
BEFORE UPDATE OF "convergence_counters", "scope_revision", "attempt_generation" ON "task"
FOR EACH ROW EXECUTE FUNCTION "task_convergence_counters_monotonic"();

-- §1: scope and acceptance freeze once the task is running against them.
--
-- The contract's reason is §4 PV3: a progress vector is only comparable within one `scopeHash`, so
-- editing the target mid-attempt does not merely change what is being asked — it silently makes
-- every measurement taken so far incomparable, and the attempts already charged to it unaccounted
-- for. The incident (§0) is exactly that: "修一个 bug" became "AutoRetry + 部署 + 锁序" without one
-- of those expansions ever being a decision, and every budget was measured against a target that
-- had moved.
--
-- The escape is not an exception, it is the intended path: insert the next `task_scope_revision`
-- row (which §1's authority guard makes somebody sign for), then bump `scope_revision` in the same
-- UPDATE that changes the text. Or file a successor task and leave this one's history alone.
--
-- Applies to MANAGED tasks only — one with no revision row is not under the control loop, and this
-- migration must not change how a single existing task behaves (project AC11).
CREATE OR REPLACE FUNCTION "task_scope_freeze_guard"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  frozen   BOOLEAN;
  recorded "task_scope_revision"%ROWTYPE;
BEGIN
  IF NEW."title" IS NOT DISTINCT FROM OLD."title"
     AND NEW."description" IS NOT DISTINCT FROM OLD."description"
     AND NEW."acceptance_criteria" IS NOT DISTINCT FROM OLD."acceptance_criteria" THEN
    -- Not a scope edit. A revision bump on its own still has to name a row that exists.
    IF NEW."scope_revision" > OLD."scope_revision" THEN
      SELECT * INTO recorded FROM "task_scope_revision" r
       WHERE r."task_id" = OLD."id" AND r."revision" = NEW."scope_revision";
      IF NOT FOUND THEN
        RAISE EXCEPTION USING
          ERRCODE = '23514',
          MESSAGE = format('SCOPE_REVISION_NOT_RECORDED: task %s has no revision %s to move to',
                           OLD."id", NEW."scope_revision");
      END IF;
    END IF;
    RETURN NEW;
  END IF;

  SELECT (EXISTS (SELECT 1 FROM "task_scope_revision" r WHERE r."task_id" = OLD."id"))
         AND (OLD."attempt_generation" > 0 OR OLD."status"::text = 'IN_PROGRESS')
    INTO frozen;

  IF NOT frozen THEN RETURN NEW; END IF;

  IF NEW."scope_revision" = OLD."scope_revision" THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = format(
        'SCOPE_FROZEN: task %s is running against scope revision %s; record a new revision or file a successor task',
        OLD."id", OLD."scope_revision");
  END IF;

  -- A bump was supplied. It must name a recorded revision whose content is exactly what the task
  -- is being changed to, or the audit would say the task asks one thing and the revision another.
  SELECT * INTO recorded FROM "task_scope_revision" r
   WHERE r."task_id" = OLD."id" AND r."revision" = NEW."scope_revision";
  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = format('SCOPE_REVISION_NOT_RECORDED: task %s has no revision %s to move to',
                       OLD."id", NEW."scope_revision");
  END IF;
  IF recorded."title" IS DISTINCT FROM NEW."title"
     OR recorded."description" IS DISTINCT FROM NEW."description"
     OR recorded."acceptance_criteria" IS DISTINCT FROM NEW."acceptance_criteria" THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = format('SCOPE_REVISION_CONTENT_MISMATCH: task %s revision %s does not record this scope',
                       OLD."id", NEW."scope_revision");
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER "task_scope_freeze_guard"
BEFORE UPDATE OF "title", "description", "acceptance_criteria", "scope_revision" ON "task"
FOR EACH ROW EXECUTE FUNCTION "task_scope_freeze_guard"();
