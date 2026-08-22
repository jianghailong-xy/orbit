-- §8.6 LO1's acquisition order, made true for the writers the service cannot reach.
--
-- 0127 put the acceptance projection in AFTER triggers on `task`: seven columns, and a write to any
-- of them calls `project_acceptance_reopen`, which takes that task's PROJECT row `FOR NO KEY
-- UPDATE`. PostgreSQL has already locked the TASK row by then — it locks the row being written
-- before any trigger of ours runs — so every one of those writes is inherently task → project,
-- which is the reverse of the order every Coordinator path takes (project lease, then the task).
--
-- 0130 saw this for three of the seven columns and fixed those three the only way a trigger can:
-- `task_supersession_project_lock_order` pre-takes the project in a BEFORE trigger, NOWAIT, and
-- refuses by name rather than waiting. Waiting is what makes a cycle; refusing immediately cannot.
--
-- The other four were left, and each of them is reachable from an ordinary request. Reproduced on
-- PostgreSQL 16, each a native `40P01` that reached an HTTP caller as an untyped 500:
--
--   * a pure `{status: 'DONE'}` PATCH against a Coordinator pass holding the project;
--   * deleting a SUBJECT task against the authorization gate — the CASCADE takes the verifier rows
--     with it, and each one reaches for ITS project from an AFTER DELETE;
--   * a whole-`dependsOn` replacement against a Coordinator holding the project and one
--     prerequisite (the shape that reached production twice, rolled back whole both times);
--   * that same replacement against a status PATCH on one of its prerequisites — a mutual wait that
--     only `statement_timeout` broke.
--
-- This migration finishes the job on both tables, with no new mechanism: the same BEFORE trigger,
-- the same NOWAIT, the same typed marker, extended to the whole closed set.
--
--   1. `task_acceptance_fact_lock_order` covers ALL SEVEN acceptance-fact columns plus INSERT and
--      DELETE, so no write can reach `project_acceptance_reopen` without the project already held.
--   2. `task_dependency_project_lock_order` pre-takes both endpoints of an edge, projects first and
--      then the task rows in id order — the order the FK's own `FOR KEY SHARE` and the AFTER
--      `task_dependency_dispatch_touch` UPDATE would otherwise take in whatever order the planner
--      picked, which is what turned two ordinary edge writes into a mutual wait.
--   3. A drift assertion, run at migration time: the guard's column list and the AFTER trigger's
--      column list are compared as sets and this migration refuses to install if they differ. A
--      column added to one and not the other is a write path that reaches a project from an AFTER
--      trigger with the task already held, and nothing about the added column would say so.
--
-- DEPLOYMENT ORDER: this migration is safe before or after the binaries that pair with it. It only
-- ever ACQUIRES EARLIER a lock the same transaction was going to take anyway, and the new refusals
-- carry `lock_not_available`, which `taskFenceConflictMessage` already routes to a 409 for the four
-- markers 0130 and 0132 raise. A binary that predates the two new markers surfaces them as a 500 on
-- a genuinely contended write instead of a `40P01` on one — strictly the better of the two, and the
-- window is one deploy long.
--
-- No explicit BEGIN/COMMIT. The schema engine already wraps a migration file in one transaction,
-- and an explicit COMMIT at the end is a statement that RUNS AFTER the drift assertion below —
-- so when the assertion fires, the failure the operator is shown is that COMMIT's "current
-- transaction is aborted", and `ACCEPTANCE_FACT_COLUMN_DRIFT` never reaches them. A guard whose
-- message is swallowed is a guard that stops the deploy without saying why.

-- ---------------------------------------------------------------------------------------------
-- 1. The task side: the project before the task, for every column that reaches the projection.
-- ---------------------------------------------------------------------------------------------
--
-- BOTH projects on an UPDATE, not just the new one, for the reason 0130 wrote down at length: one
-- statement can move a task and change a fact at once, and `project_acceptance_task_fact` then
-- reopens the OLD project as well as the NEW one. In id order (§8.6 LO2) so a concurrent A→B and
-- B→A cannot make a cycle out of each other, and NOWAIT on each so neither ever waits and no
-- acquisition order can close a loop even against a writer following no rule at all.
--
-- The early return matches the AFTER trigger's own gate: `project_acceptance_task_fact` computes a
-- `fact` with `IS DISTINCT FROM` and reopens nothing when every column is unchanged. A statement
-- that names an acceptance-fact column in its SET list but writes the value it already had reaches
-- no project, so it needs no project — and refusing it would make a no-op write fail under
-- contention, which is a worse contract than the one this replaces.
CREATE OR REPLACE FUNCTION "task_acceptance_fact_lock_order"() RETURNS trigger AS $$
DECLARE
  target UUID;
BEGIN
  IF TG_OP = 'UPDATE'
     AND OLD."status" IS NOT DISTINCT FROM NEW."status"
     AND OLD."completion_policy" IS NOT DISTINCT FROM NEW."completion_policy"
     AND OLD."project_id" IS NOT DISTINCT FROM NEW."project_id"
     AND OLD."verdict" IS NOT DISTINCT FROM NEW."verdict"
     AND OLD."verifies_task_id" IS NOT DISTINCT FROM NEW."verifies_task_id"
     AND OLD."terminal_reason" IS NOT DISTINCT FROM NEW."terminal_reason"
     AND OLD."superseded_by_task_id" IS NOT DISTINCT FROM NEW."superseded_by_task_id" THEN
    RETURN NEW;
  END IF;

  FOR target IN
    SELECT DISTINCT candidate.id FROM (
      VALUES
        (CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE OLD."project_id" END),
        (CASE WHEN TG_OP = 'DELETE' THEN NULL ELSE NEW."project_id" END)
    ) AS candidate(id)
     WHERE candidate.id IS NOT NULL
     ORDER BY candidate.id
  LOOP
    IF TG_OP = 'INSERT' THEN
      -- WAITING is safe here, and only here — 0132's split, for 0132's reason. On INSERT this
      -- transaction holds no task row when a BEFORE ROW trigger runs: the row does not exist yet
      -- and the foreign-key checks are on the AFTER side. So taking the project first makes this
      -- path project → task like every other writer, and a waiter that holds nothing below the
      -- project cannot be part of a cycle.
      --
      -- It is also what a filed task DESERVES. Refusing here costs a precise answer: a child whose
      -- arrival would activate an aggregate parent has `TASK_AGGREGATE_PARENT_ACTIVATION` waiting
      -- for it one trigger later, and a NOWAIT refusal in front of that replaces it with "the
      -- project is busy, retry" — the caller has to come back to learn the real reason, and the
      -- real reason will not change. A short wait behind a reconcile is the better trade.
      PERFORM 1 FROM "project" p WHERE p."id" = target FOR NO KEY UPDATE;
    ELSE
      -- On UPDATE and DELETE, PostgreSQL locked the task row BEFORE this trigger ran, so this
      -- transaction is already task → project and waiting here is exactly the edge that closes the
      -- cycle against a Coordinator holding the project and reaching for the task. NOWAIT converts
      -- it into a typed refusal with nothing written — retryable, and never a `40P01` victim
      -- chosen at random.
      BEGIN
        PERFORM 1 FROM "project" p WHERE p."id" = target FOR NO KEY UPDATE NOWAIT;
      EXCEPTION WHEN lock_not_available THEN
        RAISE EXCEPTION
          'TASK_FACT_PROJECT_BUSY: project % is being written right now, so this task fact cannot be recorded in this transaction — nothing was written; retry',
          target
          USING ERRCODE = 'lock_not_available';
      END;
    END IF;
  END LOOP;

  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Named to sort BEFORE every other BEFORE trigger on this table. PostgreSQL fires BEFORE ROW
-- triggers in trigger-name order, and `task_acceptance_fact_lock_order` precedes
-- `task_aggregate_*`, `task_dispatch_*`, `task_supersession_*`, `task_verdict_*` and
-- `task_verification_*` alphabetically — so the project acquisition is the first thing that
-- happens on any acceptance-fact write, which is what LO1 asks for and what makes every later
-- acquisition in this transaction a re-acquisition rather than a wait.
DROP TRIGGER IF EXISTS "task_acceptance_fact_lock_order_insert_delete" ON "task";
CREATE TRIGGER "task_acceptance_fact_lock_order_insert_delete"
  BEFORE INSERT OR DELETE ON "task"
  FOR EACH ROW EXECUTE FUNCTION "task_acceptance_fact_lock_order"();

DROP TRIGGER IF EXISTS "task_acceptance_fact_lock_order_update" ON "task";
CREATE TRIGGER "task_acceptance_fact_lock_order_update"
  BEFORE UPDATE OF "status", "completion_policy", "project_id", "verdict", "verifies_task_id",
                   "terminal_reason", "superseded_by_task_id"
  ON "task"
  FOR EACH ROW EXECUTE FUNCTION "task_acceptance_fact_lock_order"();

-- ---------------------------------------------------------------------------------------------
-- 2. The dependency side: one sorted acquisition instead of two the planner ordered.
-- ---------------------------------------------------------------------------------------------
--
-- An edge write touches two task rows without ever naming them in a lock clause:
--
--   * the FK on `depends_on_task_id` takes `FOR KEY SHARE` on the prerequisite, from an AFTER
--     trigger, after the row is in;
--   * `task_dependency_dispatch_touch` (0122) UPDATEs the dependent's `updated_at`, which takes
--     `FOR NO KEY UPDATE` on it;
--   * and the service's own `tx.task.update` may already hold the dependent.
--
-- Two of those in opposite orders is repro 3 and repro 4. Neither is written in any SQL a reader
-- can see, which is why fixing it at the call site alone was never going to hold: `createMany` over
-- several edges hands PostgreSQL a set, and the order within the set is the planner's.
--
-- So both endpoints are taken HERE, before the row exists — a BEFORE trigger runs ahead of the FK
-- check, which is an AFTER trigger — projects first and then the tasks, both in id order, both
-- NOWAIT. `FOR NO KEY UPDATE` on the task rows and not `FOR UPDATE`: it is the exact mode the touch
-- UPDATE takes and a superset of the FK's `FOR KEY SHARE`, so it covers both acquisitions this
-- statement is going to make without blocking a concurrent reader that only needs the key.
CREATE OR REPLACE FUNCTION "task_dependency_project_lock_order"() RETURNS trigger AS $$
DECLARE
  endpoints UUID[];
  target    UUID;
BEGIN
  endpoints := ARRAY(
    SELECT DISTINCT candidate.id FROM (
      VALUES
        (CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE OLD."task_id" END),
        (CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE OLD."depends_on_task_id" END),
        (CASE WHEN TG_OP = 'DELETE' THEN NULL ELSE NEW."task_id" END),
        (CASE WHEN TG_OP = 'DELETE' THEN NULL ELSE NEW."depends_on_task_id" END)
    ) AS candidate(id)
     WHERE candidate.id IS NOT NULL
     ORDER BY candidate.id
  );

  -- The projects are read from an UNLOCKED snapshot, which is a guess — and a guess is all that is
  -- needed here, because §2's own confirmation is not this trigger's job. If a task moves between
  -- this read and the edge write, the acceptance-fact guard above runs on the row that moves and
  -- takes the project it moved to. What this loop removes is the common case: the edge's own
  -- project already held, so the AFTER `project_task_dependency_event_source` insert finds its FK's
  -- project row in hand rather than reaching for it behind a task lock.
  FOR target IN
    SELECT DISTINCT t."project_id" FROM "task" t
     WHERE t."id" = ANY (endpoints) AND t."project_id" IS NOT NULL
     ORDER BY t."project_id"
  LOOP
    BEGIN
      PERFORM 1 FROM "project" p WHERE p."id" = target FOR NO KEY UPDATE NOWAIT;
    EXCEPTION WHEN lock_not_available THEN
      RAISE EXCEPTION
        'TASK_DEPENDENCY_PROJECT_BUSY: project % is being written right now, so this dependency edge cannot be recorded in this transaction — nothing was written; retry',
        target
        USING ERRCODE = 'lock_not_available';
    END;
  END LOOP;

  -- One statement, `ORDER BY id`: the LockRows node sits above the sort, so the rows come out — and
  -- are locked — in id order. Two of these over overlapping endpoint sets therefore take the shared
  -- rows in the same order and cannot invert against each other.
  BEGIN
    PERFORM 1 FROM "task" t WHERE t."id" = ANY (endpoints)
     ORDER BY t."id" FOR NO KEY UPDATE NOWAIT;
  EXCEPTION WHEN lock_not_available THEN
    RAISE EXCEPTION
      'TASK_DEPENDENCY_TASK_BUSY: a task this dependency edge names is being written right now — nothing was written; retry'
      USING ERRCODE = 'lock_not_available';
  END;

  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "task_dependency_project_lock_order" ON "task_dependency";
CREATE TRIGGER "task_dependency_project_lock_order"
  BEFORE INSERT OR UPDATE OR DELETE ON "task_dependency"
  FOR EACH ROW EXECUTE FUNCTION "task_dependency_project_lock_order"();

-- ---------------------------------------------------------------------------------------------
-- 3. The two column lists are one list. Checked here, so drift cannot ship.
-- ---------------------------------------------------------------------------------------------
--
-- `project_acceptance_task_fact_update` decides which writes REACH a project from an AFTER trigger.
-- `task_acceptance_fact_lock_order_update` decides which writes take that project FIRST. A column
-- in the first and not the second is precisely the inversion this migration exists to remove, and
-- it would be invisible: nothing about a new column's name says it reopens a project.
--
-- Compared as sets off `pg_trigger.tgattr`, so the check is on what the database will actually do
-- rather than on two lists of words that were meant to match. `src/tasks/task-lock-order.ts` holds
-- the same list a third time, as `ACCEPTANCE_FACT_TASK_COLUMNS`, and `task-lock-order.spec.ts`
-- checks THAT against this file's text — so all three move together or the build stops.
DO $$
DECLARE
  fact_columns  TEXT[];
  guard_columns TEXT[];
BEGIN
  SELECT array_agg(a.attname::text ORDER BY a.attname) INTO fact_columns
    FROM pg_trigger tg
    JOIN pg_class c ON c.oid = tg.tgrelid
    JOIN unnest(tg.tgattr) AS col(attnum) ON TRUE
    JOIN pg_attribute a ON a.attrelid = tg.tgrelid AND a.attnum = col.attnum
   WHERE c.relname = 'task' AND tg.tgname = 'project_acceptance_task_fact_update';

  SELECT array_agg(a.attname::text ORDER BY a.attname) INTO guard_columns
    FROM pg_trigger tg
    JOIN pg_class c ON c.oid = tg.tgrelid
    JOIN unnest(tg.tgattr) AS col(attnum) ON TRUE
    JOIN pg_attribute a ON a.attrelid = tg.tgrelid AND a.attnum = col.attnum
   WHERE c.relname = 'task' AND tg.tgname = 'task_acceptance_fact_lock_order_update';

  IF fact_columns IS DISTINCT FROM guard_columns THEN
    RAISE EXCEPTION
      'ACCEPTANCE_FACT_COLUMN_DRIFT: project_acceptance_task_fact_update fires on %, task_acceptance_fact_lock_order_update pre-locks for % — every column that reaches project_acceptance_reopen must take its project first, so these two lists are one list. This migration changed nothing and has rolled back',
      fact_columns, guard_columns;
  END IF;
END $$;
