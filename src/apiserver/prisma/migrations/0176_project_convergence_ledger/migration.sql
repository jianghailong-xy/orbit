-- The progress ledger of a project's coordinator wakes: what was measured, what it cost, and where
-- the waking stopped (unit T4).
--
-- WHY THE COUNTERS ARE A TABLE
-- ============================
-- Because the alternative is not a budget. `convergence-ledger.ts` names the half of the incident
-- this table answers in as many words: 「重启把计数清零，于是预算永远用不完」. A control loop that
-- holds "how many passes have produced nothing" in process memory re-initialises it on every deploy,
-- every crash and every takeover, so the line it is supposed to cross is never reached. Every number
-- a stop-loss decision reads is a committed row here, and the decision is a pure function of them —
-- which is also what makes it replayable after the fact rather than merely observed at the time.
--
-- ONE ROW PER FACT, NOT PER DELIVERY
-- ==================================
-- `idempotency_key` is `pcv:v1:<project>:<scope_hash>:<wake_key>`, and the wake key is T2's — the
-- identity of the committed fact itself (`cw:v1:<event>:<subjectType>:<subjectId>:<subjectVersion>`).
-- A fact redelivered ten times therefore charges the budget once and reads its own judgment back the
-- other nine, which is the difference between counting facts and counting deliveries. It is a PLAIN
-- unique index and not a partial one — unlike `project_coordinator_wake`, whose refusals have to give
-- the key back — because this row is not a claim on anything: it is the judgment, and a judgment that
-- could be re-made would be a budget that could be re-spent.
--
-- The scope digest is IN the key for the reason the task ledger puts the revision in its own: after a
-- person rewrites what the project is asking for, the same fact is a judgment about a different
-- question, and deduping it against the old scope's row would answer the new question with the old
-- answer. It is also, deliberately, the human reset — a new scope is a new budget (§4 PV4).
--
-- NO TRIGGER, NO CLOCK
-- ====================
-- Nothing here fires on its own. Rows are written only by `CoordinatorConvergenceService`, from a
-- wake T2 already committed. `outcome = 'STOP'` is what stops the waking, and it stops it by
-- REFUSING the next wake — not by scheduling anything.
--
-- ROLLING DEPLOY. Additive only: one new table, no trigger, no column on any existing relation. The
-- one write it makes to an existing relation is an INSERT into `project_blocker`, which needs no DDL
-- (`COORDINATOR_NO_PROGRESS` has been in that table's kind CHECK since 0125). A replica still running
-- the previous build neither reads nor writes this table.
--
-- NUMBERED 0176 AFTER THE INTEGRATED WAKE/JUDGMENT PAIR
-- ====================================================
-- The `project_coordinator_wake` table this one has a foreign key to is 0174 in the integrated
-- chain, followed by the judgment-session extension at 0175. Prisma applies migrations in NAME
-- order, so this ledger must sort after its parent table on a fresh database. Keeping the merged
-- T1–T7 sequence explicit is cheaper than a deploy that depends on branch merge order.

CREATE TABLE IF NOT EXISTS "project_convergence_decision" (
  "id"          UUID PRIMARY KEY,
  "project_id"  UUID NOT NULL,
  -- The wake this judgment was made on. A row here always has one: the ledger records judgments of
  -- FACTS, and a judgment with no fact behind it is the timer this whole unit exists to remove.
  "wake_id"     UUID NOT NULL,
  -- Monotone within a project, allocated MAX + 1 under the project row lock — a replay ORDER that
  -- does not depend on `created_at`, which two writers can tie on.
  "seq"         BIGINT NOT NULL,

  "idempotency_key" TEXT NOT NULL,
  "input_hash"      CHAR(64) NOT NULL,
  -- Everything the decision was a function of. A replay that recomputes a different `input_hash`
  -- from this is a ledger that has been written by something other than the planner.
  "input"           JSONB NOT NULL,

  "event"      TEXT NOT NULL,
  "scope_hash" CHAR(64) NOT NULL,

  -- §4's measurement, as a PAIR: what the vector was when the previous wake was judged, and what it
  -- is now. One row therefore carries the whole comparison the stop-loss is made of, so "did this
  -- wake move anything" is answerable from the row rather than from the row plus its predecessor.
  -- The previous half is NULL on a project's first decision, and after a scope change, because a
  -- measurement against a different target says nothing about this one (§4 PV3).
  "previous_progress_vector" JSONB,
  "progress_vector"          JSONB NOT NULL,
  "progress_vector_digest"   CHAR(64) NOT NULL,
  -- §4 PV2, as decided by `strictlyImproves` and by nothing else in this system.
  "progressed"               BOOLEAN NOT NULL,
  -- PV6: why a measurement did not count, when it did not. UNMEASURED is an empty snapshot, whose
  -- all-zero vector is indistinguishable from "every defect closed" to a comparison that only sees
  -- numbers.
  "evidence_freshness" TEXT NOT NULL,
  "evidence_as_of"     TIMESTAMP(3),

  -- §8 TH4's committed counters, after this judgment charged them.
  "counters"   JSONB NOT NULL,
  -- The RESOLVED thresholds that applied, not the project's override column: a person asking why a
  -- project stopped needs the limit that was in force, which may be the documented default because
  -- the override was null.
  "thresholds" JSONB NOT NULL,

  -- Which §8 line was crossed, and the two numbers that crossed it. NULL on every row that did not
  -- trip, which is the ordinary case.
  "non_convergence_reason" TEXT,
  "observed"               INTEGER,
  "crossed_limit"          INTEGER,

  -- Whether the coordinator may act on this wake. STOP is what T2's authorizer turns into a refusal.
  "outcome" TEXT NOT NULL,
  -- The blocker this decision raised, if it is the one that raised it. At most one row per episode
  -- carries a value: raising happens on the TRANSITION into a stop and never while one holds, which
  -- is the whole of what stops a person's resolution from being undone by the next pass.
  "blocker_id" UUID,

  "observed_at" TIMESTAMP(3) NOT NULL,
  "created_at"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "project_convergence_decision_outcome_chk"
    CHECK ("outcome" IN ('PROCEED', 'STOP')),
  CONSTRAINT "project_convergence_decision_freshness_chk"
    CHECK ("evidence_freshness" IN ('FRESH', 'STALE', 'UNMEASURED')),
  -- The reason and its two numbers are one fact in three columns, so none of them may be written
  -- without the others: a stop that does not say which line it crossed is the row that sends a
  -- person to look at the wrong thing.
  CONSTRAINT "project_convergence_decision_reason_chk"
    CHECK (("non_convergence_reason" IS NULL) = ("observed" IS NULL)
       AND ("non_convergence_reason" IS NULL) = ("crossed_limit" IS NULL)),
  -- A STOP is exactly a tripped breaker. Without this the outcome column could disagree with the
  -- reason column, and the refusal would be a decision nothing in the ledger accounts for.
  CONSTRAINT "project_convergence_decision_stop_chk"
    CHECK (("outcome" = 'STOP') = ("non_convergence_reason" IS NOT NULL)),
  -- A blocker is only ever raised BY a stop. The other direction is deliberately not constrained:
  -- a stop that follows a stop raises nothing, and that is the point.
  CONSTRAINT "project_convergence_decision_blocker_chk"
    CHECK ("blocker_id" IS NULL OR "outcome" = 'STOP'),
  CONSTRAINT "project_convergence_decision_seq_chk" CHECK ("seq" >= 1)
);

DO $$ BEGIN
  ALTER TABLE "project_convergence_decision"
    ADD CONSTRAINT "project_convergence_decision_project_id_fkey"
    FOREIGN KEY ("project_id") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "project_convergence_decision"
    ADD CONSTRAINT "project_convergence_decision_wake_id_fkey"
    FOREIGN KEY ("wake_id") REFERENCES "project_coordinator_wake"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- The blocker, if this decision raised one. `SET NULL` rather than CASCADE: deleting a blocker must
-- leave the decision saying it raised one that is now gone, not erase the decision that stopped the
-- project.
DO $$ BEGIN
  ALTER TABLE "project_convergence_decision"
    ADD CONSTRAINT "project_convergence_decision_blocker_id_fkey"
    FOREIGN KEY ("blocker_id") REFERENCES "project_blocker"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- One judgment per fact per scope.
CREATE UNIQUE INDEX IF NOT EXISTS "project_convergence_decision_key_idx"
  ON "project_convergence_decision" ("idempotency_key");

-- The state read: the last committed decision of a project, which is where the next one's counters,
-- previous vector and previous outcome come from. Also the seq allocation's own index.
CREATE UNIQUE INDEX IF NOT EXISTS "project_convergence_decision_seq_idx"
  ON "project_convergence_decision" ("project_id", "seq");

-- The FK's cascade index when a wake is deleted with its project.
CREATE INDEX IF NOT EXISTS "project_convergence_decision_wake_idx"
  ON "project_convergence_decision" ("wake_id");
