-- One committed fact wakes a project coordinator once — and a REFUSED wake gives the fact back.
--
-- WHY THIS TABLE EXISTS AND `project_action` COULD NOT BE IT
-- ==========================================================
-- `project_action` is the permanent idempotency ledger for orchestration side effects, and its key
-- is a PLAIN unique index. That is correct for what it records — a dispatch that happened, a
-- verdict that was applied — and it is exactly wrong for a wake, because of what a refusal does to
-- it: `project-reconcile.service.ts` used to state the consequence in as many words, "a turn key
-- spent on a refusal can never be claimed again". The coordinator rotation path was welded shut by
-- precisely this — REFUSED does not move `coordinator_generation`, so the next pass re-derives the
-- same key, `ON CONFLICT DO NOTHING` answers ALREADY_APPLIED, and the project never rotates again.
--
-- A wake must survive being refused. Widening `project_action`'s index to a partial one would have
-- changed the identity guarantee of every action type already stored in it, so the wake ledger is
-- its own table with its own index rule.
--
-- THE INDEX IS THE WHOLE DESIGN
-- =============================
--   UNIQUE ("idempotency_key") WHERE "status" <> 'REFUSED'
--
-- While a claim stands it is in the index, so a second delivery of the same fact loses its INSERT
-- and knows it lost. Once refused, the row leaves the index and STAYS IN THE TABLE — the key is
-- free for the same fact to be delivered again, and why it was refused is still readable. "It
-- silently did nothing" is not a state this table can be in.
--
-- The predicate is negative on purpose. A future status (unit T3's "this wake opened session X")
-- is inside the index by default and therefore keeps holding the key; a positive predicate
-- (`WHERE status = 'CLAIMED'`) would release the key the moment such a status were written, and
-- the fact would wake a second session. For an index whose job is to stop a second wake, failing
-- closed is the direction to fail in.
--
-- NO TRIGGERS, NO CLOCK
-- =====================
-- Nothing here fires on its own. Rows are written by `CoordinatorWakeService` when a producer
-- hands it a fact derived from rows that are already committed, which is the rule this whole unit
-- exists to enforce: a coordinator is woken by facts, never by a timer. The control loop that woke
-- on one is what migrations 0163-0165 removed.
--
-- ROLLING DEPLOY. Additive only: a new table, no trigger, no column on any existing relation, and
-- no writer outside the new service. A replica still running the previous build neither reads nor
-- writes it.

CREATE TABLE IF NOT EXISTS "project_coordinator_wake" (
  "id"               UUID PRIMARY KEY,
  "project_id"       UUID NOT NULL,
  -- The closed set from `coordinator-wake.ts`, frozen by a CHECK rather than by a Prisma enum —
  -- the same choice `project_blocker.kind` makes, and for the same reason: the values are already
  -- frozen in a TypeScript module, and a second enum spelling them is a second place to drift.
  "event"            TEXT NOT NULL,
  "subject_type"     TEXT NOT NULL,
  -- TEXT and not UUID: a `CRITERION` subject is a line of the project's acceptance criteria, named
  -- by `<project_id>:<criterion_key>` because a criterion has no row of its own until a run judges
  -- it. `project_blocker.subject_id` is TEXT for the same reason.
  "subject_id"       TEXT NOT NULL,
  -- Which occurrence of the fact this is: the attempt's session id for the two attempt events, a
  -- digest of the `(task_id, status)` pairs the fact is defined over for the two project-scoped
  -- ones. The argument for each is in `coordinator-wake.ts` §2.
  "subject_version"  TEXT NOT NULL,
  "idempotency_key"  TEXT NOT NULL,
  "status"           TEXT NOT NULL DEFAULT 'CLAIMED',
  "refusal_code"     TEXT,
  -- Display and diagnosis. Never an input to anything, and never part of the key.
  "detail"           JSONB NOT NULL DEFAULT '{}',
  "created_at"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "project_coordinator_wake_event_chk" CHECK ("event" IN (
    'ATTEMPT_ENDED_UNSETTLED', 'ATTEMPT_BUDGET_SPENT', 'PROJECT_TASKS_SETTLED', 'CRITERION_READY'
  )),
  CONSTRAINT "project_coordinator_wake_subject_chk" CHECK ("subject_type" IN (
    'TASK', 'PROJECT', 'CRITERION'
  )),
  CONSTRAINT "project_coordinator_wake_status_chk" CHECK ("status" IN ('CLAIMED', 'REFUSED')),
  -- A refusal without its reason is the row saying it stopped and not why, which is the one shape
  -- this table is here to make impossible; a reason without a refusal is a code nobody acted on.
  CONSTRAINT "project_coordinator_wake_refusal_chk"
    CHECK (("status" = 'REFUSED') = ("refusal_code" IS NOT NULL))
);

DO $$ BEGIN
  ALTER TABLE "project_coordinator_wake"
    ADD CONSTRAINT "project_coordinator_wake_project_id_fkey"
    FOREIGN KEY ("project_id") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- The key, and the release. Partial, so that a refused row is out of the way of the next delivery
-- of the same fact while still being on the record.
CREATE UNIQUE INDEX IF NOT EXISTS "project_coordinator_wake_live_key_idx"
  ON "project_coordinator_wake" ("idempotency_key")
  WHERE "status" <> 'REFUSED';

-- The audit read: what woke this project's coordinator, newest first. Also the index the FK's
-- cascade uses when a project is deleted.
CREATE INDEX IF NOT EXISTS "project_coordinator_wake_project_idx"
  ON "project_coordinator_wake" ("project_id", "created_at");
