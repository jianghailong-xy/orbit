-- A dependency edge has no version of its own, and an empty edge set has no row to lock at all.
-- 0122 solved both by touching the dependent Task (`UPDATE "task" SET "updated_at"`), which works
-- but pays for it three times over: the write re-checks `task_creator_session_id_fkey` and takes
-- FOR KEY SHARE on that Task's creator Session, it re-fires every FOR EACH ROW trigger on `task`,
-- and it moves a user-visible clock for a change that is not a change to the Task.
--
-- This migration gives the edge set a version of its own. `task_dependency_revision` holds one row
-- per Task; every dependency change advances it, and the dispatch decision holds it FOR SHARE
-- while it reads the edges. The row exists for EVERY Task (seeded by trigger, backfilled below),
-- which is what closes the empty-set phantom the touch was closing: there is always something to
-- lock, whether or not the Task has prerequisites.

CREATE TABLE "task_dependency_revision" (
  "task_id" UUID PRIMARY KEY REFERENCES "task"("id") ON DELETE CASCADE,
  "revision" BIGINT NOT NULL DEFAULT 0
);

COMMENT ON TABLE "task_dependency_revision" IS
  'Dispatch version boundary for one Task''s prerequisite set. One row per Task, always present.';

-- Backfill before the maintainers are installed, so the projection is true the moment it can be
-- read. The starting value is arbitrary: a revision is only ever compared with itself.
INSERT INTO "task_dependency_revision" ("task_id") SELECT "id" FROM "task";

-- Every Task gets its row at birth. A statement-level trigger rather than FOR EACH ROW so a
-- batch create pays one INSERT, and so an old apiserver replica — which knows nothing about this
-- table — still produces lockable Tasks.
CREATE OR REPLACE FUNCTION "task_dependency_revision_seed"() RETURNS trigger AS $$
BEGIN
  -- ON CONFLICT so re-applying this migration over a database that already has some of these
  -- rows is a no-op rather than a failure; there is no contention to order here, because every
  -- row it inserts is a child of a Task nobody else can see yet.
  INSERT INTO "task_dependency_revision" ("task_id")
  SELECT "id" FROM new_tasks
  ON CONFLICT ("task_id") DO NOTHING;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "task_dependency_revision_seed"
  AFTER INSERT ON "task" REFERENCING NEW TABLE AS new_tasks
  FOR EACH STATEMENT EXECUTE FUNCTION "task_dependency_revision_seed"();

-- The one place a revision moves.
--
-- Sorted, and once per Task: the rows are locked by an explicit ordered statement before the
-- UPDATE, because `WHERE task_id = ANY(...)` on its own locks in whatever order the plan emits
-- and two overlapping batches taking the same Tasks in opposite orders is a cycle. The LockRows
-- node sits above the sort, so `ORDER BY "task_id"` IS the acquisition order whatever plan the
-- planner picks. The UPDATE then advances each row exactly once however many of that Task's edges
-- the statement changed — a restructure of ten edges on one Task is one revision, not ten.
CREATE OR REPLACE FUNCTION "task_dependency_revision_advance"(ids UUID[]) RETURNS void AS $$
BEGIN
  IF ids IS NULL OR cardinality(ids) = 0 THEN RETURN; END IF;
  PERFORM 1 FROM "task_dependency_revision" r
   WHERE r."task_id" = ANY(ids) ORDER BY r."task_id" FOR NO KEY UPDATE;
  UPDATE "task_dependency_revision" r
     SET "revision" = r."revision" + 1
   WHERE r."task_id" = ANY(ids);
END;
$$ LANGUAGE plpgsql;

-- Three triggers rather than one: PostgreSQL allows a transition table only on a single-event
-- trigger, and the whole point of these is to see the batch rather than the row.
CREATE OR REPLACE FUNCTION "task_dependency_revision_bump_insert"() RETURNS trigger AS $$
BEGIN
  PERFORM "task_dependency_revision_advance"(
    (SELECT array_agg(DISTINCT "task_id" ORDER BY "task_id") FROM new_edges));
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION "task_dependency_revision_bump_update"() RETURNS trigger AS $$
BEGIN
  -- Both sides: nothing in the application moves an edge between dependents, but if anything ever
  -- does, both the Task that lost the prerequisite and the Task that gained it changed.
  PERFORM "task_dependency_revision_advance"((
    SELECT array_agg(DISTINCT "task_id" ORDER BY "task_id") FROM (
      SELECT "task_id" FROM old_edges UNION SELECT "task_id" FROM new_edges) moved));
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION "task_dependency_revision_bump_delete"() RETURNS trigger AS $$
BEGIN
  -- Includes the cascade: deleting a PREREQUISITE Task deletes the edges pointing at it, and the
  -- dependents those edges belonged to have a different prerequisite set as a result. When the
  -- Task being deleted is the DEPENDENT, its own revision row is cascading away in this same
  -- transaction, so whether this advances it first or finds it already gone is immaterial.
  PERFORM "task_dependency_revision_advance"(
    (SELECT array_agg(DISTINCT "task_id" ORDER BY "task_id") FROM old_edges));
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "task_dependency_revision_insert"
  AFTER INSERT ON "task_dependency" REFERENCING NEW TABLE AS new_edges
  FOR EACH STATEMENT EXECUTE FUNCTION "task_dependency_revision_bump_insert"();

CREATE TRIGGER "task_dependency_revision_update"
  AFTER UPDATE ON "task_dependency"
  REFERENCING OLD TABLE AS old_edges NEW TABLE AS new_edges
  FOR EACH STATEMENT EXECUTE FUNCTION "task_dependency_revision_bump_update"();

CREATE TRIGGER "task_dependency_revision_delete"
  AFTER DELETE ON "task_dependency" REFERENCING OLD TABLE AS old_edges
  FOR EACH STATEMENT EXECUTE FUNCTION "task_dependency_revision_bump_delete"();

-- The commit-boundary half, and the reason removing the touch is safe while an old apiserver
-- replica is still serving.
--
-- The revision row makes a dependency change and a dispatch decision take each other's order
-- inside a NEW binary's fencing transaction. An OLD binary does not know to take it, so its
-- decision can still read an edge set that changes underneath it. This trigger is what neither
-- version can skip: at COMMIT, a Coordinator dispatch whose Task has an unmet prerequisite is
-- refused, and the whole dispatch — action, Session, task status write — rolls back for the
-- reconciler to retry against the state that actually exists.
--
-- Deferred, and re-reading rather than trusting NEW: a DEFERRABLE INITIALLY DEFERRED trigger runs
-- at COMMIT but is handed the row as it was at the event, so the row is read again here.
--
-- Coordinator dispatch only. A person starting a task from the UI may deliberately run it ahead
-- of its prerequisites; `dependenciesReady` is a Coordinator admission fact, not a data rule.
CREATE OR REPLACE FUNCTION "session_dispatch_dependency_check"() RETURNS trigger AS $$
DECLARE s "session"%ROWTYPE; blocker UUID;
BEGIN
  SELECT * INTO s FROM "session" WHERE "id" = NEW."id";
  IF NOT FOUND OR s."dispatch_origin" <> 'PROJECT_COORDINATOR' OR s."task_id" IS NULL THEN
    RETURN NULL;
  END IF;
  -- The same predicate the authorization adapter counts, spelled the same way: same owner scope,
  -- and DONE is the only status that satisfies a prerequisite.
  SELECT prerequisite."id" INTO blocker
    FROM "task_dependency" d
    JOIN "task" prerequisite ON prerequisite."id" = d."depends_on_task_id"
   WHERE d."task_id" = s."task_id"
     AND prerequisite."owner_id" = s."owner_id"
     AND prerequisite."status" <> 'DONE'
   LIMIT 1;
  IF blocker IS NOT NULL THEN
    RAISE EXCEPTION 'DISPATCH_DEPENDENCY_CHANGED: task % has unmet prerequisite % at commit',
      s."task_id", blocker;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER "session_dispatch_dependency_check"
  AFTER INSERT ON "session" DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "session_dispatch_dependency_check"();

-- Replaced. Nothing reads `task.updated_at` as a dispatch version — the boundary was always the
-- row lock the touch's UPDATE took, and `task_dependency_revision` takes that lock on a row that
-- belongs to the edge set instead of on the Task.
DROP TRIGGER "task_dependency_dispatch_touch" ON "task_dependency";
DROP FUNCTION "task_dependency_dispatch_touch"();
