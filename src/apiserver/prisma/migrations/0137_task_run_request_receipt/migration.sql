-- A LEGACY run request is a COMMAND with a receipt, and the receipt is what a repeat of it reads.
--
-- WHY A RECEIPT AND NOT A SET OF STABLE IDS.
-- -----------------------------------------
-- Deriving each artifact from the caller's token — the Session, the resume turn, the batch id, the
-- Project signal — makes each one stable, and it still does not make the REQUEST idempotent. The
-- door re-runs before it reaches any of them: prerequisites, `dispatch_hold`, the assignee and its
-- runner, the aggregate-parent and retirement gates, the Project the task is filed under. Every one
-- of those is mutable, so a delivery that arrives after the world moved answers a different thing
-- from the delivery it repeats:
--
--   * the task was paused, or a prerequisite was added -> 400 where the first attempt returned a
--     running Session;
--   * the run it started ended, or a second run was opened on the task -> the repeat starts a NEW
--     Session, or refuses as "somebody else is running", because a resume's durable result lives on
--     a Session id the token does not name;
--   * the task moved Project -> a second durable USER trigger, on a Project the press never asked
--     about.
--
-- So the answer is recorded at the DOOR. One row per (owner, action, token), holding what the
-- request WAS and what it AUTHORITATIVELY produced; a repeat carrying the same token and the same
-- payload is answered from it before a single mutable check runs. A repeat carrying the same token
-- and a DIFFERENT payload is refused: one name cannot mean two requests.
--
-- The derived artifact ids do not go away — they are what makes a receipt left `IN_FLIGHT` by a
-- crash recoverable, since the row the interrupted attempt would have written is nameable without
-- its response.

-- ATOMIC, EXPLICITLY. This file creates three tables, backfills one of them from `task`, and
-- installs six triggers and three foreign keys — and every one of those objects is meaningless
-- without the others: a `task_dispatch_epoch` table with no seed trigger silently stops naming new
-- tasks, and a receipt table with no `task_run_manual_trigger` beside it makes the effect marker's
-- guarantee vanish. A partial application is therefore not a degraded state, it is a wrong one.
--
-- Written out rather than relied upon: the deployer's per-file transaction is not a promise this
-- file can read, and the neighbouring multi-object migrations (0130, 0131, 0134) all say so in the
-- same way. On any failure below, nothing here exists and re-running the migration starts from a
-- database that never saw it — which is what makes `migrate resolve --rolled-back` followed by a
-- re-run safe, rather than a collision with half of these objects.
--
-- No table lock is taken. Unlike 0130 this file REPLACES nothing: the three tables are new, and the
-- triggers it adds fire on `task` and `task_dependency` without redefining anything already there,
-- so there is no window in which an existing reader could observe a half-changed object.
BEGIN;

CREATE TABLE "task_run_request" (
    "owner_id" UUID NOT NULL,
    -- Which door. `TASK_EXECUTE` is Run Now / task_start / a sweep pass; `TASK_BATCH_EXECUTE` is
    -- one press of the bulk Run. Separate kinds so one token used at both doors is two requests.
    "action_kind" TEXT NOT NULL,
    -- The caller's `triggerId`, or the durable fact an automatic door acted on. Text, not UUID: a
    -- sweep's token is a sentence about a committed row ("sched:2026-08-23T09:00:00.000Z").
    "request_token" TEXT NOT NULL,
    -- The canonical request payload. A token is a NAME for a request, so the same name with a
    -- different payload is a client bug, and answering it from this row would hand back a result
    -- for work nobody asked for.
    "fingerprint" TEXT NOT NULL,
    -- OPEN -> BOUND -> COMPLETED. Not a cache with two states: a receipt is the request's own
    -- state machine, and BOUND is the one that makes a crash recoverable.
    --
    -- OPEN means the door has not decided yet, so a takeover re-decides. BOUND means it HAS —
    -- the plan below names every row this request will write — so a takeover performs exactly
    -- that plan and never re-reads the mutable world that produced it. COMPLETED means the
    -- answer is frozen.
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    -- The immutable plan, written by a compare-and-set BEFORE any effect: which Session this
    -- request creates or adopts, which turn it delivers and under what key, which batch and which
    -- item goes where, and the Project its durable signal belongs to.
    --
    -- This is what a set of derived ids could not do on its own. A request that RESUMES a paused
    -- run puts its turn on somebody else's Session, so its effect is named by a row the token does
    -- not derive; without the target recorded, a crash between that turn committing and the answer
    -- being written leaves nothing to look for — and by the time the repeat arrives, the run it
    -- woke may have finished and a second one may have been opened. Scanning for "the latest" is
    -- exactly the guess this whole unit exists to remove.
    "target" JSONB,
    "bound_at" TIMESTAMP(3),
    -- What the door answered, verbatim, so a repeat returns the same bytes: `{sessionId}` for a
    -- single run, `{batchId, dispatched, results, skipped, failed, ...}` for a bulk one.
    "result" JSONB,
    -- ONE EVALUATOR AT A TIME, and the reason is not efficiency.
    --
    -- Two deliveries of one token allowed to evaluate in parallel do not merely race to write the
    -- answer — they each read the world and each apply what they read. One arriving while a foreign
    -- run holds the task classifies it as skipped; the other, arriving after that run ended, starts
    -- a Session. Whichever wins the compare-and-set freezes ITS answer, and the other's effect has
    -- already happened: the receipt says "skipped" about a request that started work.
    --
    -- So evaluation is leased. The holder is the only delivery that reads mutable state or writes
    -- an effect; every other one reads the answer or is told the request is in progress. The lease
    -- EXPIRES, so a holder that dies does not wedge the request, and `attempt` fences the write it
    -- was in the middle of: a resumed holder cannot complete a request whose lease has since been
    -- taken over.
    "lease_holder" TEXT,
    "lease_expires_at" TIMESTAMP(3),
    "attempt" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "task_run_request_pkey" PRIMARY KEY ("owner_id", "action_kind", "request_token"),
    CONSTRAINT "task_run_request_status_check"
      CHECK ("status" IN ('OPEN', 'BOUND', 'COMPLETED')),
    -- A plan and the state that means "there is a plan" are one fact, so they cannot disagree.
    CONSTRAINT "task_run_request_target_check"
      CHECK (("status" = 'OPEN') = ("target" IS NULL)),
    -- A completed request has an answer. Without this the "read the receipt" branch could return
    -- null and look like a request that never ran.
    CONSTRAINT "task_run_request_result_check"
      CHECK ("status" <> 'COMPLETED' OR "result" IS NOT NULL)
);

ALTER TABLE "task_run_request"
  ADD CONSTRAINT "task_run_request_owner_id_fkey"
  FOREIGN KEY ("owner_id") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- "what has this owner asked for lately", which is what a support question about a duplicated run
-- asks, and the only read besides the primary key.
CREATE INDEX "task_run_request_owner_created_idx"
  ON "task_run_request" ("owner_id", "created_at" DESC);

-- ---------------------------------------------------------------------------------------------
-- The Project signal's effect marker.
-- ---------------------------------------------------------------------------------------------
--
-- The receipt above answers a repeat that reaches the door. This is the second half: the durable
-- USER signal a run records for its Project is an EFFECT, and 0117 deduplicates it on
-- `project_event_open_dedupe_idx` — `(project_id, dedupe_key)` UNIQUE **WHERE consumed_at IS
-- NULL**. That is a coalescing rule for an unanswered signal, not an idempotency key for a request:
-- once the Coordinator has answered the first one, the same key inserts a second event.
--
-- One row per (Project, request), written in the SAME transaction as the enqueue, so the effect can
-- be recognised as already applied for the whole life of the request — after consumption, after the
-- event is pruned, after a restart, and between two deliveries landing together.
CREATE TABLE "task_run_manual_trigger" (
    "project_id" UUID NOT NULL,
    -- `taskRunManualTriggerId(token, projectId)`: a function of the press and this Project, and the
    -- same value handed to `project_event_manual_trigger` as its request id.
    "request_id" UUID NOT NULL,
    "owner_id" UUID NOT NULL,
    -- Which task's run recorded it. Audit only, and SetNull on delete: removing a task must not be
    -- able to resurrect a press.
    "task_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "task_run_manual_trigger_pkey" PRIMARY KEY ("project_id", "request_id")
);

ALTER TABLE "task_run_manual_trigger"
  ADD CONSTRAINT "task_run_manual_trigger_project_id_fkey"
  FOREIGN KEY ("project_id") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "task_run_manual_trigger"
  ADD CONSTRAINT "task_run_manual_trigger_owner_id_fkey"
  FOREIGN KEY ("owner_id") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "task_run_manual_trigger"
  ADD CONSTRAINT "task_run_manual_trigger_task_id_fkey"
  FOREIGN KEY ("task_id") REFERENCES "task"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "task_run_manual_trigger_owner_created_idx"
  ON "task_run_manual_trigger" ("owner_id", "created_at" DESC);

-- ---------------------------------------------------------------------------------------------
-- The automatic doors' request identity: a monotone per-Task DISPATCH EPOCH.
-- ---------------------------------------------------------------------------------------------
--
-- WHY A COUNTER AND NOT THE VALUE ITSELF (contract §7.7 D5-b4).
--
-- A manual door's request is named by the caller (`triggerId`, one per press). An automatic door
-- has no press, so its name has to come from the durable fact it acted on — and naming it with the
-- fact's CURRENT VALUE is wrong, because those values come back:
--
--   * `run_at` 09:00 -> 10:00 -> 09:00. The second 09:00 is a LEGITIMATE second appointment and it
--     re-derives the first one's name. If the first was frozen as `rescheduled`, the second never
--     runs; if the first ran and was frozen, the replay hands back the FIRST run's Session and the
--     second appointment never runs either. Both are silent.
--   * `dep:<task>:<edge_revision>`. The edge set is unchanged while a prerequisite goes
--     DONE -> reopened -> DONE, so the second legitimate READY transition re-derives the first
--     one's name and is answered with the first one's Session. Same for the task's own
--     DONE -> reopened.
--
-- So the name carries a counter that only ever goes up, advanced once per moment at which an
-- automatic door may legitimately start this task's work. `<kind>:<task>:<epoch>` then has all
-- three properties the receipt needs: two deliveries of one moment agree, two moments differ, and
-- a moment that has passed can never be re-entered.
--
-- SHAPE, and why it is 0132's shape rather than a column on `task`: writing the Task row changes
-- its `xmin`, which makes PostgreSQL re-check every one of its foreign keys — including
-- `task_creator_session_id_fkey`, whose `FOR KEY SHARE` on that Session is one edge of the
-- 2026-08-21 three-party cycle — re-runs every FOR EACH ROW trigger on `task` for a write that
-- changed nothing anybody wanted, and moves `updated_at`, which is a clock users can see. A side
-- table with one row per Task has none of that, is lockable when the Task has no edges and no
-- appointment, and sits at the same rank (70) as `task_dependency_revision`.
CREATE TABLE "task_dispatch_epoch" (
  "task_id" UUID PRIMARY KEY REFERENCES "task"("id") ON DELETE CASCADE,
  "epoch" BIGINT NOT NULL DEFAULT 0
);

-- Every Task has a row, including the ones that exist now and the ones an apiserver that predates
-- this table will create.
INSERT INTO "task_dispatch_epoch" ("task_id") SELECT "id" FROM "task"
ON CONFLICT ("task_id") DO NOTHING;

CREATE OR REPLACE FUNCTION "task_dispatch_epoch_seed"() RETURNS trigger AS $$
BEGIN
  INSERT INTO "task_dispatch_epoch" ("task_id")
  SELECT "id" FROM new_tasks
  ON CONFLICT ("task_id") DO NOTHING;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "task_dispatch_epoch_seed"
  AFTER INSERT ON "task" REFERENCING NEW TABLE AS new_tasks
  FOR EACH STATEMENT EXECUTE FUNCTION "task_dispatch_epoch_seed"();

-- The one place an epoch moves. Ordered and once-per-Task for the reasons `task_dependency_revision_advance`
-- states: `WHERE task_id = ANY(...)` locks in whatever order the plan emits, the LockRows node sits
-- above the sort, so the explicit `ORDER BY` IS the acquisition order — and two overlapping batches
-- taking the same Tasks in opposite orders is a cycle.
CREATE OR REPLACE FUNCTION "task_dispatch_epoch_advance"(ids UUID[]) RETURNS void AS $$
BEGIN
  IF ids IS NULL OR cardinality(ids) = 0 THEN RETURN; END IF;
  PERFORM 1 FROM "task_dispatch_epoch" e
   WHERE e."task_id" = ANY(ids) ORDER BY e."task_id" FOR NO KEY UPDATE;
  UPDATE "task_dispatch_epoch" e SET "epoch" = e."epoch" + 1
   WHERE e."task_id" = ANY(ids);
END;
$$ LANGUAGE plpgsql;

-- TRANSITION TABLE, in the contract's order.
--
-- 1 + 2. `run_at` or `status` changed on the Task itself. The first is a new appointment (or one
--        consumed/cancelled); the second is this Task becoming runnable again after DONE or FAILED.
-- 3.     `status` changed on a PREREQUISITE. Its dependents' readiness can have changed with it,
--        and "the second time this task became READY" is exactly the moment the edge revision
--        cannot see. Fan-out is bounded by the dependents of the tasks this statement touched, and
--        it writes only this side table — never the dependent Task rows, which is the cost 0132
--        removed.
CREATE OR REPLACE FUNCTION "task_dispatch_epoch_bump_update"() RETURNS trigger AS $$
DECLARE
  moved UUID[];
BEGIN
  SELECT array_agg(DISTINCT n."id" ORDER BY n."id") INTO moved
    FROM new_tasks n JOIN old_tasks o ON o."id" = n."id"
   WHERE n."run_at" IS DISTINCT FROM o."run_at"
      OR n."status" IS DISTINCT FROM o."status";
  PERFORM "task_dispatch_epoch_advance"(moved);

  SELECT array_agg(DISTINCT d."task_id" ORDER BY d."task_id") INTO moved
    FROM new_tasks n JOIN old_tasks o ON o."id" = n."id"
    JOIN "task_dependency" d ON d."depends_on_task_id" = n."id"
   WHERE n."status" IS DISTINCT FROM o."status";
  PERFORM "task_dispatch_epoch_advance"(moved);
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "task_dispatch_epoch_update"
  AFTER UPDATE ON "task"
  REFERENCING OLD TABLE AS old_tasks NEW TABLE AS new_tasks
  FOR EACH STATEMENT EXECUTE FUNCTION "task_dispatch_epoch_bump_update"();

-- 4. The waiting set changed — the same trigger surface 0132's revision has, folded into this
--    counter so the token needs one number rather than two. 0132's table is untouched: it is the
--    dispatch decision's LOCK, not a name.
CREATE OR REPLACE FUNCTION "task_dispatch_epoch_bump_edges_insert"() RETURNS trigger AS $$
BEGIN
  PERFORM "task_dispatch_epoch_advance"(
    (SELECT array_agg(DISTINCT "task_id" ORDER BY "task_id") FROM new_edges));
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION "task_dispatch_epoch_bump_edges_update"() RETURNS trigger AS $$
BEGIN
  PERFORM "task_dispatch_epoch_advance"((
    SELECT array_agg(DISTINCT "task_id" ORDER BY "task_id") FROM (
      SELECT "task_id" FROM old_edges UNION SELECT "task_id" FROM new_edges) moved));
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION "task_dispatch_epoch_bump_edges_delete"() RETURNS trigger AS $$
BEGIN
  PERFORM "task_dispatch_epoch_advance"(
    (SELECT array_agg(DISTINCT "task_id" ORDER BY "task_id") FROM old_edges));
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "task_dispatch_epoch_edges_insert"
  AFTER INSERT ON "task_dependency" REFERENCING NEW TABLE AS new_edges
  FOR EACH STATEMENT EXECUTE FUNCTION "task_dispatch_epoch_bump_edges_insert"();

CREATE TRIGGER "task_dispatch_epoch_edges_update"
  AFTER UPDATE ON "task_dependency"
  REFERENCING OLD TABLE AS old_edges NEW TABLE AS new_edges
  FOR EACH STATEMENT EXECUTE FUNCTION "task_dispatch_epoch_bump_edges_update"();

CREATE TRIGGER "task_dispatch_epoch_edges_delete"
  AFTER DELETE ON "task_dependency" REFERENCING OLD TABLE AS old_edges
  FOR EACH STATEMENT EXECUTE FUNCTION "task_dispatch_epoch_bump_edges_delete"();

COMMIT;
