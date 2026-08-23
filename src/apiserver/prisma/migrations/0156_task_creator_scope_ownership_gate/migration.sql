-- Unit L6: the run-time ownership gate, and the column it asks its question of.
--
-- THE INCIDENT, RESTATED AT THE MOMENT IT MATTERS
-- ----------------------------------------------
-- L3 put a gate at creation time: a coordinator holding scope A may no longer file work into
-- project B without declaring the crossing, and L4 gave the declaration an answer a person writes.
-- Neither of them can do anything about the rows that were already written. Those tasks are in B,
-- they look exactly like work B's coordinator filed for itself, and B's dispatcher will run them —
-- because the only question anything asks before a run is "is this task in my project", and the
-- answer is yes. The mis-filing is invisible precisely because it succeeded.
--
-- The gate this migration serves asks a second question — WHO put it there, and what were they
-- coordinating when they did — and refuses the run when the two answers disagree. For that it
-- needs the first answer to be a column, because by run time it is no longer derivable: the scope
-- derivation reads `project.coordinator_session_id`, and a coordinator that has since rotated is
-- no longer named by it. The evidence of the mis-filing evaporates with the rotation, which is why
-- v1 could only be an audit script somebody ran by hand.
--
-- WHY NOT `discovered_from_project_id` (migration 0150)
-- ----------------------------------------------------
-- Because 0150 says, in the schema and in the contract (§3 SC7), that no gate may read it: it
-- records where work was NOTICED, and the day a gate decides anything from it, "I found this" has
-- become "I may write here". The value happens to be computed the same way today. The MEANING is
-- the opposite one, and the two are kept apart here exactly as `TasksService.deriveProjectScope`
-- is kept apart from `resolveOwnedSession` — evidence and authority never share a value, so that
-- neither can be quietly widened into the other.
--
-- So: one more column pair, written once, at creation, from the scope the write was ADMITTED
-- under. Not from the request — nothing a client sends can reach it.
ALTER TABLE "task"
  ADD COLUMN IF NOT EXISTS "creator_coordinator_project_id" UUID,
  ADD COLUMN IF NOT EXISTS "creator_coordinator_generation" BIGINT;

-- No foreign key, deliberately, and it is the same choice `project_decision.coordinator_session_id`
-- makes: this is a historical marker, not a live reference. An `ON DELETE SET NULL` would mean that
-- deleting project A — which nothing stops, since A does not OWN the mis-filed task; B does —
-- erases the claim, and the gate silently opens on the very row it exists for. Deleting the project
-- somebody filed FROM is not evidence that they were entitled to file into B.
COMMENT ON COLUMN "task"."creator_coordinator_project_id" IS
  'Unit L6: the coordination scope this row was admitted under, server-derived at creation. Authority, not provenance — compare it with project_id; never read it as permission to write.';
COMMENT ON COLUMN "task"."creator_coordinator_generation" IS
  'Unit L6: project_runtime.coordinator_generation as it stood when the row was admitted. Evidence for the blocker detail; NOT a refusal input — a rotation is lawful and moves no work.';

-- ---------------------------------------------------------------------------------------------
-- 1 · The backfill, and the two things it refuses to guess
-- ---------------------------------------------------------------------------------------------
--
-- Only unambiguous, STABLE attributions are written. Everything else is left NULL, and NULL means
-- "no claim recorded" — the gate never fires on it. That direction is chosen on purpose: this
-- migration must not stop work that nobody mis-filed, and a claim invented from a guess would do
-- exactly that, at scale, on history nobody can go back and check.
--
--   (a) the creating session IS the coordinator of a project today. A session coordinates at most
--       one project (the unique index behind `project.coordinator_session_id` says so), and that
--       binding never moves to another project — it is released, not transferred.
--
--   (b) failing that, the creating session AUTHORED coordinator decisions, and every one of them
--       is for the same project. `project_decision` is append-only, so this survives the rotation
--       that erases (a). More than one distinct project means the row cannot say which scope the
--       write was under, so it says nothing.
--
-- What is deliberately NOT backfilled: the worker case — the project of the task the creating
-- session was executing. Going forward that IS the derived scope and the column records it, but a
-- task's project can MOVE (L4's approved handoff), so reading it back today would attribute a write
-- to wherever the executing task ended up rather than to where it was, and refuse runs on rows
-- whose only sin is that something else was legitimately handed over.
--
-- The generation is left NULL for every backfilled row, and that is a distinct fact from zero: 0 is
-- a real generation (a project that has never rotated), while NULL here means "nobody recorded one
-- at the time". Nothing refuses on it either way; it only ever appears in the blocker's detail.
WITH decided AS (
  SELECT d."coordinator_session_id" AS session_id,
         MIN(d."project_id"::text) AS project_id,
         COUNT(DISTINCT d."project_id") AS projects
    FROM "project_decision" d
   WHERE d."coordinator_session_id" IS NOT NULL
   GROUP BY d."coordinator_session_id"
), scope AS (
  SELECT t."id" AS task_id,
         COALESCE(p."id", CASE WHEN dc.projects = 1 THEN dc.project_id::uuid END) AS project_id
    FROM "task" t
    LEFT JOIN "project" p ON p."coordinator_session_id" = t."creator_session_id"
    LEFT JOIN decided dc ON dc.session_id = t."creator_session_id"
   WHERE t."creator_session_id" IS NOT NULL
)
UPDATE "task" t
   SET "creator_coordinator_project_id" = s.project_id
  FROM scope s
 WHERE s.task_id = t."id"
   AND s.project_id IS NOT NULL;

-- ---------------------------------------------------------------------------------------------
-- 2 · Written once, and frozen — for 0150's reason, one step further along
-- ---------------------------------------------------------------------------------------------
--
-- 0150 freezes provenance because evidence that can be edited is testimony. This column is stronger
-- than evidence: a gate reads it. A writer that could set it after the fact could authorise its own
-- mis-filing by pointing the column at wherever the row happens to live, and one that could clear
-- it could do the same by pointing it at nothing.
--
-- Absolute, with no lawful emptying, exactly like `trigger_event` and for the same structural
-- reason: there is no foreign key, so nothing can be deleted that would empty it, and therefore no
-- referential action to make room for. `ON DELETE SET NULL` was not chosen; this is what that costs
-- and what it buys.
CREATE OR REPLACE FUNCTION task_creator_scope_immutable() RETURNS TRIGGER AS $$
BEGIN
  IF NEW."creator_coordinator_project_id" IS DISTINCT FROM OLD."creator_coordinator_project_id" THEN
    RAISE EXCEPTION
      'TASK_CREATOR_SCOPE_IMMUTABLE: task % records the coordination scope it was filed under; a gate reads it, so it is written once at creation and never afterwards',
      OLD."id" USING ERRCODE = 'raise_exception';
  END IF;
  IF NEW."creator_coordinator_generation" IS DISTINCT FROM OLD."creator_coordinator_generation" THEN
    RAISE EXCEPTION
      'TASK_CREATOR_SCOPE_IMMUTABLE: task % records the coordinator generation it was filed under; that is written once at creation and never afterwards',
      OLD."id" USING ERRCODE = 'raise_exception';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "task_creator_scope_immutable_guard" ON "task";
CREATE TRIGGER "task_creator_scope_immutable_guard"
  BEFORE UPDATE OF "creator_coordinator_project_id", "creator_coordinator_generation" ON "task"
  FOR EACH ROW EXECUTE FUNCTION task_creator_scope_immutable();

-- ...and the one thing that DOES change it, which is not a writer at all.
--
-- The column says which scope this row's CURRENT placement was admitted under. The moment the
-- placement changes, it no longer describes anything: whoever moved the task decided which goal the
-- work counts towards, and they had the authority to — an agent's move is refused at admission
-- unless L4's ledger holds an answer for it, and the owner is outside the contract entirely (§4 R1).
-- Leaving the old scope behind would make the gate refuse the very repair its own required action
-- recommends, for ever, on a placement somebody chose deliberately.
--
-- So a move RETIRES the claim. It cannot re-point it: the only value this writes is NULL, and NULL
-- is "no claim recorded", which the gate never refuses on. A statement that tries to move the task
-- and name a new scope in the same breath still meets the guard above and is refused — which is the
-- distinction that matters, because "this placement is no longer the one I described" and "this
-- placement was always fine, look" are different sentences and only one of them is true.
--
-- In the DATABASE rather than in the service, and that is the whole point: every mover gets it —
-- `TasksService.update`, L4's apply, a repair script, a future migration's raw UPDATE, a binary
-- that has never heard of this column. A service-side clear would be a rule that holds for the
-- callers somebody remembered.
--
-- Nothing is lost from the audit. L2's four provenance columns still record where the work was
-- noticed, they are still frozen against every change, and no gate may read them. What retires here
-- is only the authority half — the claim, not the history.
--
-- The NAME sorts AFTER `task_creator_scope_immutable_guard`, and PostgreSQL fires BEFORE ROW
-- triggers in alphabetical order, so the guard has already had its say on any statement that named
-- these columns by the time this runs.
CREATE OR REPLACE FUNCTION task_creator_scope_retire_on_move() RETURNS TRIGGER AS $$
BEGIN
  IF NEW."project_id" IS DISTINCT FROM OLD."project_id" THEN
    NEW."creator_coordinator_project_id" := NULL;
    NEW."creator_coordinator_generation" := NULL;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "task_creator_scope_retire_on_move" ON "task";
CREATE TRIGGER "task_creator_scope_retire_on_move"
  BEFORE UPDATE OF "project_id" ON "task"
  FOR EACH ROW EXECUTE FUNCTION task_creator_scope_retire_on_move();

-- The offender index, and it is deliberately a partial one over the DISAGREEMENT rather than over
-- either column: the recovery scan's question is "which rows in this database are mis-filed", the
-- answer on a healthy deployment is none, and an index of the answer costs nothing to keep and one
-- page to read. A plain index on `creator_coordinator_project_id` would be an index of every task
-- an agent ever filed.
CREATE INDEX IF NOT EXISTS "task_creator_scope_mismatch_idx"
  ON "task" ("creator_coordinator_project_id", "project_id")
  WHERE "creator_coordinator_project_id" IS NOT NULL
    AND "creator_coordinator_project_id" IS DISTINCT FROM "project_id";

-- ---------------------------------------------------------------------------------------------
-- 3 · The row a person acts on
-- ---------------------------------------------------------------------------------------------
--
-- One more §11.2 kind. Deliberately not one of the ones already there: `POLICY_MANUAL_HOLD` is a
-- choice somebody made, `AWAITING_USER_INPUT` is a conversation, and `UNKNOWN_FAILURE` is the
-- absence of a diagnosis — this is a diagnosis, it names two projects, and what it asks for (say
-- which project owns this work) is answerable by nobody but a person.
--
-- DEPLOYMENT ORDER — this migration goes FIRST, on 0142's reasoning: the value is one only new code
-- writes, so an older replica cannot be harmed by the constraint accepting it. An older replica
-- that READS one falls to BL2's `UNKNOWN_FAILURE`, which is fail-closed and still puts the project
-- in front of a person.
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
    'VERDICT_APPLY_EXHAUSTED',
    'PROJECT_OWNERSHIP_MISMATCH',
    'UNKNOWN_FAILURE'
  ));

-- ---------------------------------------------------------------------------------------------
-- 4 · One replacement per mis-filed task, decided by the database
-- ---------------------------------------------------------------------------------------------
--
-- The supported repair files a REPLACEMENT task in the project that should have owned the work, and
-- `source_task_id` + `trigger_event` are what tie it back to the original. It cannot be a
-- `superseded_by_task_id` link: 0128's supersession guard requires the successor to be in the SAME
-- project, and the whole point of the replacement is that it is not. That is not an obstacle to
-- route around — it is the guard saying, correctly, that this is a different claim.
--
-- So the mapping is provenance, and the uniqueness of it is this index. Idempotence for the repair
-- then costs no lock, no advisory key and no read-modify-write: a second attempt to refile the same
-- task loses on the index and reads back the replacement the first one wrote. Two apiservers doing
-- it at once do the same single thing.
--
-- Partial on the trigger, so it constrains only refilings: `source_task_id` is otherwise a perfectly
-- ordinary many-to-one, and one task may legitimately notice a hundred others.
CREATE UNIQUE INDEX IF NOT EXISTS "task_ownership_refile_source_uq"
  ON "task" ("source_task_id")
  WHERE "trigger_event" = 'project.ownership_refiled' AND "source_task_id" IS NOT NULL;
