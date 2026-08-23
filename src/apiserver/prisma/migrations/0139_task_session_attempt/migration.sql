-- `[K3]`: a Session is ONE attempt, and an attempt is bounded.
--
-- Spec: `docs/project-coordinator-attempt-budget.md`, over the bounded-convergence contract
-- (`docs/project-coordinator-convergence-contract.md` §1/§8, TH2/TH3/TH5).
--
-- `[K1]` made the breaker decidable; `[K2]` made its counters durable. Neither would have stopped
-- the incident on its own, because those hundreds of rounds never crossed an attempt line — they
-- were not hundreds of attempts. They were ONE session steered hundreds of times, and a session
-- that never ends is the blind spot every budget shares: no new attempt, no new fingerprint, and a
-- liveness check that is green the whole way because the loop really is busy.
--
-- So this migration's first job is not a limit, it is an IDENTITY (§0 AT1):
--
--     one attempt  =  one Session  ×  one Task  ×  one scope revision
--
-- and its second is to make that attempt's ending a FACT SOMEBODY WROTE rather than a status
-- somebody overwrote. The properties below are held here rather than in the service for the reason
-- `[K2]` gives: the writer that breaks an invariant is by definition the one that skipped the
-- service.
--
--   * `CANCELLED` is not one of the four outcomes an attempt may end with (TH2), and the CHECK is
--     what makes that true of a raw UPDATE as well as of a well-behaved caller.
--   * A closed attempt's outcome is immutable. A result overwritten by a later result is the exact
--     shape of "coordinator called complete on a run it disliked".
--   * A budget-triggered stop must leave a checkpoint or say why there is none.
--   * The same hypothesis is not attempted twice on one scope revision, unless the previous try
--     ended `TRANSIENT` — and §3 CL2 already bounds how often that excuse works.
--   * The budget an attempt is judged by is FROZEN at open: editing the policy mid-flight can
--     neither end a running attempt nor revive one already asked to stop.

-- ---------------------------------------------------------------------------------------------
-- §1: the attempt.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE "task_attempt" (
  "id"                        UUID    PRIMARY KEY,
  "task_id"                   UUID    NOT NULL,
  "owner_id"                  UUID    NOT NULL,
  -- AT1: the session IS the attempt. NOT NULL because an attempt with nothing running is not a
  -- weaker attempt, it is not one. ON DELETE CASCADE below: purging a session destroys the run
  -- this row is a fact ABOUT, while the spend it was charged survives where the budget actually
  -- reads it — `[K2]`'s ledger, which keeps its own copy of the generation and the counters.
  "session_id"                UUID    NOT NULL,
  "scope_revision"            INTEGER NOT NULL,
  -- CHAR(64) to match `task_scope_revision.scope_hash` exactly: the composite foreign key below
  -- points at it, and a TEXT column would join through an implicit cast.
  "scope_hash"                CHAR(64) NOT NULL,
  "attempt_generation"        BIGINT  NOT NULL,
  -- GN1: the durable identity of THIS dispatch, supplied by the caller. A replay after a crash
  -- re-derives it and reads its own row back instead of opening a second generation.
  "attempt_key"               TEXT    NOT NULL,
  -- AT3: what this attempt is going to do DIFFERENTLY. Not decoration — the digest is a gate.
  "hypothesis"                TEXT    NOT NULL,
  "hypothesis_digest"         CHAR(64) NOT NULL,
  -- BD5: the six limits in force when this attempt opened, frozen.
  "budget"                    JSONB   NOT NULL,
  -- The last measured spend, for the read face. The BUDGET decision is taken against a fresh
  -- measurement; this is what `GET .../attempts` shows without re-measuring a closed attempt.
  "spend"                     JSONB,
  -- Kept as a column rather than inside `spend`, because it is the one dimension the control plane
  -- ITSELF writes (nobody reports it), and it has to be incrementable under concurrency.
  "coordinator_steers"        INTEGER NOT NULL DEFAULT 0,
  "status"                    TEXT    NOT NULL DEFAULT 'OPEN',
  "outcome"                   TEXT,
  "classification"            TEXT,
  "exhausted_dimension"       TEXT,
  "checkpoint_sha"            TEXT,
  "checkpoint_kind"           TEXT,
  "checkpoint_evidence_digest" TEXT,
  -- NC3: "if there is none, say there is none". A crash has none, and that is the honest answer;
  -- inventing a checkpoint here would make the next generation resume from a point that is not one.
  "no_checkpoint_reason"      TEXT,
  -- SD1: evidence carries across a generation, context does not.
  "inherited_known_good_sha"  TEXT,
  "wind_down_requested_at"    TIMESTAMP(3),
  "closed_at"                 TIMESTAMP(3),
  "created_at"                TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"                TIMESTAMP(3) NOT NULL
);

ALTER TABLE "task_attempt" ADD CONSTRAINT "task_attempt_status_chk"
  CHECK ("status" IN ('OPEN', 'WINDING_DOWN', 'CLOSED'));

-- TH2, spelled so that it cannot be written rather than merely discouraged. The four values are
-- the four real endings; `CANCELLED` is absent, so "cancel the run and call that its result" is a
-- statement this table has no way to store.
ALTER TABLE "task_attempt" ADD CONSTRAINT "task_attempt_outcome_chk"
  CHECK ("outcome" IS NULL OR "outcome" IN ('SUCCEEDED', 'FAILED', 'INTERRUPTED', 'BLOCKED'));

-- Closed exactly when there is an outcome. Neither half means anything without the other: an
-- outcome on an open attempt is a conclusion about something still happening, and a closed attempt
-- with no outcome is the "ended, no result" state this whole unit exists to remove.
ALTER TABLE "task_attempt" ADD CONSTRAINT "task_attempt_closed_outcome_chk"
  CHECK (("status" = 'CLOSED') = ("outcome" IS NOT NULL));

ALTER TABLE "task_attempt" ADD CONSTRAINT "task_attempt_closed_at_chk"
  CHECK (("status" = 'CLOSED') = ("closed_at" IS NOT NULL));

ALTER TABLE "task_attempt" ADD CONSTRAINT "task_attempt_classification_chk"
  CHECK ("classification" IS NULL OR "classification" IN (
    'TRANSIENT', 'IN_SCOPE_DEFECT', 'PREREQUISITE', 'SCOPE_EXPANSION', 'ENVIRONMENT',
    'HUMAN_REQUIRED'
  ));

ALTER TABLE "task_attempt" ADD CONSTRAINT "task_attempt_dimension_chk"
  CHECK ("exhausted_dimension" IS NULL OR "exhausted_dimension" IN (
    'CONTEXT', 'WALL_CLOCK', 'TURNS', 'TOOL_CALLS', 'COST', 'COORDINATOR_STEERS'
  ));

-- §7's two kinds, and both halves of a checkpoint or neither. A sha with no kind cannot be told
-- apart from a known-red experiment, which is precisely the distinction `[K6]`'s merge gate rests
-- on.
ALTER TABLE "task_attempt" ADD CONSTRAINT "task_attempt_checkpoint_kind_chk"
  CHECK ("checkpoint_kind" IS NULL OR "checkpoint_kind" IN ('ACCEPTED', 'WIP_RED'));
ALTER TABLE "task_attempt" ADD CONSTRAINT "task_attempt_checkpoint_pair_chk"
  CHECK (("checkpoint_sha" IS NULL) = ("checkpoint_kind" IS NULL));

ALTER TABLE "task_attempt" ADD CONSTRAINT "task_attempt_steers_chk"
  CHECK ("coordinator_steers" >= 0);
ALTER TABLE "task_attempt" ADD CONSTRAINT "task_attempt_generation_chk"
  CHECK ("attempt_generation" >= 1);
ALTER TABLE "task_attempt" ADD CONSTRAINT "task_attempt_scope_revision_chk"
  CHECK ("scope_revision" >= 1);
ALTER TABLE "task_attempt" ADD CONSTRAINT "task_attempt_hypothesis_chk"
  CHECK (btrim("hypothesis") <> '' AND btrim("hypothesis_digest") <> '');

-- The six budget dimensions, present, and each either a positive number or an explicit `null`
-- (unbounded — which `resolveAttemptBudget` only produces from a USER's signature, OW4). A missing
-- key would read as NULL through `->>` and as "unbounded" through a careless coalesce, and a
-- dimension that silently reads unbounded is a dimension that never trips.
CREATE OR REPLACE FUNCTION "task_attempt_budget_valid"(budget JSONB) RETURNS BOOLEAN
LANGUAGE sql IMMUTABLE AS $$
  SELECT jsonb_typeof(budget) = 'object'
     AND bool_and(
           budget ? k
           AND (
             jsonb_typeof(budget->k) = 'null'
             OR (jsonb_typeof(budget->k) = 'number' AND (budget->>k)::numeric > 0)
           )
         )
    FROM unnest(ARRAY[
      'maxTurns', 'maxWallClockMs', 'maxToolCalls', 'maxCostMicros',
      'maxContextPercent', 'maxCoordinatorSteers'
    ]) AS k;
$$;

ALTER TABLE "task_attempt" ADD CONSTRAINT "task_attempt_budget_chk"
  CHECK ("task_attempt_budget_valid"("budget"));

-- Tenancy through the same composite key `[K2]` hung its two tables off: the child names BOTH the
-- task and the owner, so it cannot disagree with its parent about whose it is.
ALTER TABLE "task_attempt" ADD CONSTRAINT "task_attempt_task_id_owner_id_fkey"
  FOREIGN KEY ("task_id", "owner_id") REFERENCES "task"("id", "owner_id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- §5 FP3, as a foreign key: an attempt names the scope revision it was spent on, and that revision
-- has to be a recorded one whose content digest matches. A superseded attempt cannot be re-pointed
-- at the new question after the fact.
ALTER TABLE "task_attempt" ADD CONSTRAINT "task_attempt_scope_revision_fkey"
  FOREIGN KEY ("task_id", "scope_revision", "scope_hash")
  REFERENCES "task_scope_revision"("task_id", "revision", "scope_hash")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "task_attempt" ADD CONSTRAINT "task_attempt_session_id_fkey"
  FOREIGN KEY ("session_id") REFERENCES "session"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- GN1: one attempt per dispatch identity. The crash-replay path reads this row instead of writing
-- a second one.
CREATE UNIQUE INDEX "task_attempt_attempt_key_key" ON "task_attempt" ("attempt_key");

-- AC4, in one line: the same (task, revision, generation) is never started twice. Two coordinators,
-- a redelivered event and a takeover all compute the same triple and only one of them lands.
CREATE UNIQUE INDEX "task_attempt_generation_key"
  ON "task_attempt" ("task_id", "scope_revision", "attempt_generation");

-- AT1 and AC3's mechanical half. One session is at most one attempt, so a "fresh generation" that
-- actually resumes the previous session — inheriting its unbounded context along with it — is a
-- row this index refuses. Evidence is inherited through `inherited_known_good_sha`; context is not
-- inherited at all.
CREATE UNIQUE INDEX "task_attempt_session_key" ON "task_attempt" ("session_id");

-- One live attempt per task. A second concurrent generation would spend two budgets on one
-- question and leave "which of them is the result" unanswerable.
CREATE UNIQUE INDEX "task_attempt_one_open_key"
  ON "task_attempt" ("task_id") WHERE "status" <> 'CLOSED';

CREATE INDEX "task_attempt_task_generation_idx"
  ON "task_attempt" ("task_id", "scope_revision", "attempt_generation" DESC);
CREATE INDEX "task_attempt_owner_created_idx"
  ON "task_attempt" ("owner_id", "created_at" DESC);

-- ---------------------------------------------------------------------------------------------
-- §4 GN: the gate on opening one.
-- ---------------------------------------------------------------------------------------------
-- The attempt is written AS OF the task's current revision and the generation `[K2]`'s ledger just
-- allocated. Equality on both, not "greater than": a row that runs ahead of the task is an attempt
-- nobody started, and a row that lags is a superseded attempt still writing — which is how one
-- budget gets spent twice.
--
-- This is also what forces `openAttempt` through `ConvergenceLedgerService.record()`. Advancing the
-- generation privately would leave the ledger and the columns telling two different stories about
-- how many attempts a revision has had, and `recover()`'s consistency check exists to notice it.
CREATE OR REPLACE FUNCTION "task_attempt_fence"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  current_revision   INTEGER;
  current_generation BIGINT;
  previous           "task_attempt"%ROWTYPE;
BEGIN
  SELECT t."scope_revision", t."attempt_generation"
    INTO current_revision, current_generation
    FROM "task" t WHERE t."id" = NEW."task_id";

  IF NEW."scope_revision" <> current_revision THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = format(
        'STALE_SCOPE_REVISION: attempt names revision %s of task %s, which is on revision %s',
        NEW."scope_revision", NEW."task_id", current_revision);
  END IF;

  IF NEW."attempt_generation" <> current_generation THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = format(
        'STALE_ATTEMPT_GENERATION: attempt names generation %s of task %s, which is on generation %s',
        NEW."attempt_generation", NEW."task_id", current_generation);
  END IF;

  -- AT3. The previous attempt on this revision, by generation.
  SELECT * INTO previous FROM "task_attempt" a
   WHERE a."task_id" = NEW."task_id" AND a."scope_revision" = NEW."scope_revision"
   ORDER BY a."attempt_generation" DESC LIMIT 1;
  IF FOUND AND previous."hypothesis_digest" = NEW."hypothesis_digest" THEN
    -- GN2: the one exemption. §3 gives `TRANSIENT` exactly one legal consequence — retry the same
    -- thing — and CL2 already forces a chronically transient failure to be re-classified after
    -- `maxTransientRetries`, so the exemption is itself bounded. Every other class must change the
    -- hypothesis, because re-running an unchanged one is the incident's loop with extra steps.
    IF previous."classification" IS DISTINCT FROM 'TRANSIENT' THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = format(
          'ATTEMPT_HYPOTHESIS_UNCHANGED: task %s already spent generation %s on this hypothesis',
          NEW."task_id", previous."attempt_generation");
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER "task_attempt_fence"
BEFORE INSERT ON "task_attempt"
FOR EACH ROW EXECUTE FUNCTION "task_attempt_fence"();

-- ---------------------------------------------------------------------------------------------
-- §2 NC3/NC4 + BD5: what may change after the row exists.
-- ---------------------------------------------------------------------------------------------
-- Three separate promises, one trigger, because they all answer "can this write overwrite a result
-- that already happened":
--
--   * a CLOSED attempt is history (NC4). Not a conclusion still open for discussion;
--   * the status only moves forward. `WINDING_DOWN → OPEN` would un-ask a wind-down, which is how
--     "we extended the budget, so it never hit the line" would be spelled if it were allowed
--     (GN3 says it is not — an extension authorizes the NEXT generation, not a rewrite of this one);
--   * the frozen budget stays frozen (BD5), and the steer counter never walks back (RL3's shape).
CREATE OR REPLACE FUNCTION "task_attempt_result_guard"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  rank_old INTEGER;
  rank_new INTEGER;
BEGIN
  IF OLD."status" = 'CLOSED' THEN
    IF NEW."status" IS DISTINCT FROM OLD."status"
       OR NEW."outcome" IS DISTINCT FROM OLD."outcome"
       OR NEW."classification" IS DISTINCT FROM OLD."classification"
       OR NEW."checkpoint_sha" IS DISTINCT FROM OLD."checkpoint_sha"
       OR NEW."checkpoint_kind" IS DISTINCT FROM OLD."checkpoint_kind"
       OR NEW."closed_at" IS DISTINCT FROM OLD."closed_at" THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = format('ATTEMPT_OUTCOME_IMMUTABLE: attempt %s already ended as %s',
                         OLD."id", OLD."outcome");
    END IF;
  END IF;

  rank_old := CASE OLD."status" WHEN 'OPEN' THEN 0 WHEN 'WINDING_DOWN' THEN 1 ELSE 2 END;
  rank_new := CASE NEW."status" WHEN 'OPEN' THEN 0 WHEN 'WINDING_DOWN' THEN 1 ELSE 2 END;
  IF rank_new < rank_old THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = format('ATTEMPT_STATUS_MONOTONIC: attempt %s cannot go from %s back to %s',
                       OLD."id", OLD."status", NEW."status");
  END IF;

  IF NEW."budget" IS DISTINCT FROM OLD."budget" THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = format('ATTEMPT_BUDGET_FROZEN: attempt %s was opened against a different budget',
                       OLD."id");
  END IF;

  IF NEW."coordinator_steers" < OLD."coordinator_steers" THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = format('ATTEMPT_STEERS_MONOTONIC: attempt %s cannot go from %s steers back to %s',
                       OLD."id", OLD."coordinator_steers", NEW."coordinator_steers");
  END IF;

  -- A wind-down, once asked for, stays asked for. Clearing it is the same rewrite as reopening the
  -- status, spelled in the column the reader actually looks at.
  IF OLD."wind_down_requested_at" IS NOT NULL AND NEW."wind_down_requested_at" IS NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = format('ATTEMPT_WIND_DOWN_IRREVOCABLE: attempt %s was already asked to wind down',
                       OLD."id");
  END IF;

  NEW."updated_at" := CURRENT_TIMESTAMP;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "task_attempt_result_guard"
BEFORE UPDATE ON "task_attempt"
FOR EACH ROW EXECUTE FUNCTION "task_attempt_result_guard"();

-- NC3: what a close owes.
--
-- Asymmetric on purpose. `SUCCEEDED` owes an `ACCEPTED` checkpoint unconditionally — a success
-- nobody can point at is the claim this unit was written after. An attempt that was ASKED to stop
-- owes either a checkpoint or a sentence saying why there is none, and "the runner crashed" is a
-- perfectly good sentence: demanding a checkpoint there would only teach the next writer to invent
-- one, and the next generation would resume from a known-good point that does not exist.
CREATE OR REPLACE FUNCTION "task_attempt_checkpoint_guard"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."status" <> 'CLOSED' THEN RETURN NEW; END IF;
  -- PostgreSQL fires BEFORE triggers in NAME order, and this one sorts ahead of
  -- `task_attempt_result_guard`. A rewrite of an already-closed attempt is that guard's question,
  -- not this one's, and answering it here first would report `ATTEMPT_CHECKPOINT_REQUIRED` for what
  -- is actually somebody overwriting a committed result — the refusal would be right and its reason
  -- misleading, which is the worse of the two failures.
  IF TG_OP = 'UPDATE' AND OLD."status" = 'CLOSED' THEN RETURN NEW; END IF;

  IF NEW."outcome" = 'SUCCEEDED' AND NEW."checkpoint_kind" IS DISTINCT FROM 'ACCEPTED' THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = format(
        'ATTEMPT_CHECKPOINT_REQUIRED: attempt %s claims SUCCEEDED without an ACCEPTED checkpoint',
        NEW."id");
  END IF;

  IF NEW."wind_down_requested_at" IS NOT NULL
     AND NEW."checkpoint_sha" IS NULL
     AND coalesce(btrim(NEW."no_checkpoint_reason"), '') = '' THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = format(
        'ATTEMPT_CHECKPOINT_REQUIRED: attempt %s was asked to wind down and recorded neither a checkpoint nor a reason',
        NEW."id");
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER "task_attempt_checkpoint_guard"
BEFORE INSERT OR UPDATE ON "task_attempt"
FOR EACH ROW EXECUTE FUNCTION "task_attempt_checkpoint_guard"();
