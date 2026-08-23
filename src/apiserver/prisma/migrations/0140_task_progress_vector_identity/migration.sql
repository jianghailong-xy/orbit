-- `[K4]`: the progress vector's evidence, the action's identity, and the two lines the incident
-- walked straight past.
--
-- Migration 0138 gave a decision seven counters and a place to keep them. Two shapes from §0 still
-- had no line to cross:
--
--   * **The same ACTION, over and over.** §8 bounds repeats of the same FAILURE, and the incident
--     never repeated one — every error text carried a fresh session id, so `sameFingerprintRepeats`
--     never reached two. What it did repeat was the action: re-run the suite, push a fix, re-run
--     the suite. `action_identity` is that action normalized the way §5 normalizes a failure, and
--     `sameActionRepeats` counts it within one no-progress window.
--   * **Repairs that repair nothing.** A task can spend verification round after verification round
--     closing one defect and opening another. Every round produced work, and the defect count never
--     moved. `repairsWithoutSeverityDrop` counts the rounds since `openP0 + openP1` last fell.
--
-- And one shape that was never even measured: WHERE the progress vector came from. §1 says the
-- vector is derived from evidence rather than written by hand, so a decision now records how old
-- the oldest piece of that evidence was (`evidence_as_of`) and whether the reading may be believed
-- (`evidence_freshness`). A vector derived from evidence older than the attempt it claims to
-- describe cannot show what that attempt did, and it may not refresh `last_progress_at`.
--
-- Order below is load-bearing: the counter backfill runs BEFORE the two counter functions are
-- replaced, because the monotonic trigger reads the key list out of its own body. Replacing it
-- first would make every backfill UPDATE look like two counters appearing from NULL, which is
-- exactly what it exists to refuse.

-- ---------------------------------------------------------------------------------------------
-- 1. The ledger's new columns.
-- ---------------------------------------------------------------------------------------------
ALTER TABLE "task_convergence_decision"
  ADD COLUMN "action_identity"     CHAR(64),
  ADD COLUMN "hypothesis_identity" CHAR(64),
  ADD COLUMN "evidence_freshness"  TEXT,
  ADD COLUMN "evidence_as_of"      TIMESTAMP(3);

ALTER TABLE "task_convergence_decision"
  ADD CONSTRAINT "task_convergence_decision_identity_chk" CHECK (
    ("action_identity" IS NULL OR "action_identity" ~ '^[0-9a-f]{64}$')
    AND ("hypothesis_identity" IS NULL OR "hypothesis_identity" ~ '^[0-9a-f]{64}$')
  ),
  -- PV6's three readings. `UNMEASURED` is spelled out rather than left as NULL because they say
  -- different things: NULL is "this writer took no reading", `UNMEASURED` is "the reading came
  -- back with nothing in it" — an empty snapshot, whose vector is all zeros and therefore looks
  -- like every defect was closed. Collapsing the two would hide a broken evidence pipeline behind
  -- an older writer.
  ADD CONSTRAINT "task_convergence_decision_freshness_chk" CHECK (
    "evidence_freshness" IS NULL
    OR "evidence_freshness" IN ('FRESH', 'STALE', 'UNMEASURED')
  ),
  -- A reading without its timestamp is not a reading: freshness is a claim ABOUT a time, and one
  -- that cannot be re-derived from the row is one nobody can check.
  ADD CONSTRAINT "task_convergence_decision_freshness_time_chk" CHECK (
    "evidence_freshness" IS NULL
    OR "evidence_freshness" = 'UNMEASURED'
    OR "evidence_as_of" IS NOT NULL
  );

-- §8's two new reasons, added to the enumeration a trip is allowed to name.
ALTER TABLE "task_convergence_decision"
  DROP CONSTRAINT "task_convergence_decision_reason_chk";
ALTER TABLE "task_convergence_decision"
  ADD CONSTRAINT "task_convergence_decision_reason_chk" CHECK (
    "non_convergence_reason" IS NULL OR "non_convergence_reason" IN (
      'SCOPE_EXPANSION_REQUIRED', 'SAME_FAILURE_REPEATED', 'SAME_ACTION_REPEATED',
      'SEVERITY_NOT_DECLINING', 'VERIFICATION_ROUNDS_EXHAUSTED',
      'TRANSIENT_RETRY_BUDGET_EXHAUSTED', 'ATTEMPT_BUDGET_EXHAUSTED', 'HARD_ATTEMPT_CAP_REACHED',
      'NO_PROGRESS'
    )
  );

-- The window query's index: "rows of this task and revision, with this action identity, after the
-- last one that progressed". Without it the count is a scan of the task's whole ledger on every
-- judgment, and the ledger is the one table that only ever grows.
CREATE INDEX "task_convergence_decision_action_identity_idx"
  ON "task_convergence_decision" ("task_id", "scope_revision", "action_identity")
  WHERE "action_identity" IS NOT NULL;

-- The other half of the same query: where the current no-progress window starts.
CREATE INDEX "task_convergence_decision_progressed_idx"
  ON "task_convergence_decision" ("task_id", "scope_revision", "seq" DESC)
  WHERE "progressed";

-- ---------------------------------------------------------------------------------------------
-- 2. Backfill, under the OLD counter guards.
-- ---------------------------------------------------------------------------------------------
-- Both new counters start at zero for every task already under management. Zero is the only
-- honest value: nothing in the committed history says an action was repeated, because until this
-- migration nothing recorded which action it was.
UPDATE "task"
   SET "convergence_counters" = "convergence_counters"
       || '{"sameActionRepeats": 0, "repairsWithoutSeverityDrop": 0}'::jsonb
 WHERE NOT ("convergence_counters" ? 'sameActionRepeats')
    OR NOT ("convergence_counters" ? 'repairsWithoutSeverityDrop');

-- The ledger's own copies, so `recoverConvergenceState` still agrees with the columns after a
-- crash. The immutable guard is off for exactly this statement — a migration adding a key that
-- did not exist when the row was written is not a rewrite of what the row concluded, and the
-- alternative is a recovery that reports every pre-0140 task as corrupt.
ALTER TABLE "task_convergence_decision" DISABLE TRIGGER "task_convergence_decision_immutable_guard";
UPDATE "task_convergence_decision"
   SET "counters" = "counters"
       || '{"sameActionRepeats": 0, "repairsWithoutSeverityDrop": 0}'::jsonb
 WHERE NOT ("counters" ? 'sameActionRepeats')
    OR NOT ("counters" ? 'repairsWithoutSeverityDrop');
ALTER TABLE "task_convergence_decision" ENABLE TRIGGER "task_convergence_decision_immutable_guard";

-- And the column default itself. A task created after this migration is inserted without naming
-- its counters, so a seven-key default would be a row that fails the nine-key CHECK on the spot.
ALTER TABLE "task" ALTER COLUMN "convergence_counters" SET DEFAULT
  '{"attemptsOnRevision":0,"attemptsWithoutProgress":0,"sameFingerprintRepeats":0,"sameActionRepeats":0,"repairsWithoutSeverityDrop":0,"decisionsWithoutProgress":0,"verificationRounds":0,"transientRetries":0,"scopeExpansionRequests":0}'::jsonb;

-- ---------------------------------------------------------------------------------------------
-- 3. The counter guards, now over nine names.
-- ---------------------------------------------------------------------------------------------
-- Same rule as 0138's: all of them present, numeric and non-negative. A missing key reads as NULL
-- through `->>` and as 0 through a careless cast, and a budget that silently reads 0 never trips.
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
      'sameActionRepeats', 'repairsWithoutSeverityDrop',
      'decisionsWithoutProgress', 'verificationRounds', 'transientRetries',
      'scopeExpansionRequests'
    ]) AS k;
$$;

-- RL3/TH4 over the same nine.
--
-- `repairsWithoutSeverityDrop` joins the resettable set, and its licence here is deliberately
-- WEAKER than the one the planner applies. The database can see that progress happened
-- (`last_progress_at` moved); it cannot see whether `openP0 + openP1` fell, because that lives in
-- the progress vector of a ledger row this trigger cannot read — the row is inserted after the
-- task update, by design (0138's `record` order). So the trigger enforces the property it can
-- check — a counter never walks down, and a reset is a reset to zero — and
-- `advanceCounters` enforces the narrower one: progress AND the defect load actually falling.
CREATE OR REPLACE FUNCTION "task_convergence_counters_monotonic"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  key           TEXT;
  old_value     NUMERIC;
  new_value     NUMERIC;
  progressed    BOOLEAN;
  resettable    CONSTANT TEXT[] := ARRAY[
    'attemptsWithoutProgress', 'sameFingerprintRepeats', 'sameActionRepeats',
    'repairsWithoutSeverityDrop', 'decisionsWithoutProgress', 'transientRetries'
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
    'sameActionRepeats', 'repairsWithoutSeverityDrop', 'decisionsWithoutProgress',
    'verificationRounds', 'transientRetries', 'scopeExpansionRequests'
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
