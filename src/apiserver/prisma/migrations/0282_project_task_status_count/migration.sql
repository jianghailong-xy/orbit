-- A project's per-status task tally, kept as rows instead of being recounted on every read.
--
-- `GET /projects/:id` (and `GET /runner/projects/:id`, the door the `project_get` MCP tool and the
-- coordinator sessions use) asks for `tasksByStatus`, which Prisma compiles to:
--
--   SELECT COUNT(*) AS "_count$_all", status::text FROM task WHERE project_id = $1 GROUP BY status
--
-- The predicate is real and the index is the right one, and neither fact bounds the cost: what the
-- statement costs is the number of ROWS the project has, not how selective the filter is. On this
-- deployment one project holds 109,872 of the table's 111,738 rows (98.33%), so for that project
-- the read is a full traversal of a covering index whatever the plan says.
--
-- Measured on production 2026-09-18, against that project, custom plan (which is what production
-- gets: `pg_prepared_statements` is empty at every sampling, so PostgreSQL re-plans each execution
-- rather than settling on the generic plan):
--
--   Index Only Scan using task_project_rollup_covering_idx
--     Buffers: shared hit=194 read=3485      → 3,679 buffers, ~21% of a 128MB shared_buffers
--   Execution Time: 123.9 ms  (reproduced: 76.2 ms / 3,679 buffers on a second call)
--
-- `SET enable_indexonlyscan = off` — what a stale visibility map makes the planner prefer — turns
-- it into a Parallel Seq Scan over 20,501 buffers at 188.5 ms, and force_generic_plan turns it into
-- an Index Scan over 18,735 buffers at 234 ms; both are worse, and neither is the number to argue
-- from. The number to argue from is the one production actually pays, and 3,679 buffers is already
-- the cheapest plan available for an exact count of 109,872 rows.
--
-- No filter can make that cheap, and neither can a narrower index. This is the same finding as
-- 0280's, on the statement beside it: an exact count of rows that genuinely have to be counted
-- costs their number, so the only way down is to stop counting them per read.
--
-- WHY THIS IS NOT A `project` COLUMN
-- ==================================
-- It could have been — the detail read already fetches the project row, and a column there would
-- cost zero statements instead of one. `docs/postgres-lock-order.md` is why it is not. `project` is
-- rank 40 and `task` is rank 50, so a trigger on `task` maintaining a column of `project` would
-- take a rank-40 lock from inside a rank-50 write: a rank inversion, plus a genuine new wait edge
-- between every task write and the coordinator paths that hold the project row. A relation of its
-- own sits at rank 60 — child rows whose FK parents are already held — which is the rank this
-- trigger reaches from, in order, and whose only taker is this trigger.
--
-- WHY A TRIGGER RATHER THAN THE SERVICE
-- =====================================
-- The same reason 0280 gives, one column over. `task.project_id` is written by the service, by
-- `project_handoff`, by bulk `createMany` imports (this deployment's 109,872-row project was
-- created that way), by migrations and by psql. A counter the application maintains is exact only
-- for the paths somebody remembered; a trigger is exact for all of them, which is what lets this
-- stay an exact count rather than becoming an approximate one.
--
-- `task.project_id` is `ON DELETE RESTRICT`, NOT SetNull — the one place it differs from
-- `task.list_id`, and it removes the hazard 0280 had to design around: a project cannot be deleted
-- while it has tasks, so no referential action can empty a counted column behind the trigger's
-- back. The `ON DELETE CASCADE` below is for the counter rows and is reached only for a project
-- that has none, because a project that has tasks is refused deletion outright.
--
-- Statement-level with transition tables, not row-level, for 0280's reason: an import creates
-- thousands of tasks in one `createMany`, and this has to cost one UPSERT per (project, status)
-- rather than one per task. The UPDATE branch nets inserted against deleted by (project_id,
-- status) rather than looking for rows whose `project_id` changed — it has to, because PostgreSQL
-- refuses `REFERENCING ... TABLE` on a trigger with a column list, and most UPDATEs of `task` move
-- no task between projects. A statement that wrote only `status` contributes +1 and -1 to the
-- same (project_id, status), `HAVING` drops the zero, and no row is written or even locked. That
-- is also what keeps the 27,468-task re-list and pause paths — the shapes that wedged this
-- deployment on 2026-09-14 — from touching this table at all.
--
-- The target is spelled `INSERT INTO "project_task_status_count"` and unaliased, in all three
-- branches, because that is the shape `scripts/sync-db-trigger-inventory.mjs` reads to record what
-- a trigger reaches for in another relation; behind an alias it records `takes: []`, and an
-- inventory that understates this one is the silent gap `docs/postgres-lock-order.md` §0 exists to
-- prevent. The rows are taken sorted by (project_id, status) in one statement, per that document's
-- rule for a relation needing several rows: two concurrent bulk statements over overlapping
-- projects must not take the same pair in opposite orders.
--
-- `count = 0` rows are left in place rather than deleted. The read filters them, so the shape is
-- unchanged, and a branch that deleted them would take a second lock on a row the statement is
-- already holding.

CREATE TABLE "project_task_status_count" (
  "project_id" UUID NOT NULL,
  "status" "task_status" NOT NULL,
  "count" INTEGER NOT NULL,
  CONSTRAINT "project_task_status_count_pkey" PRIMARY KEY ("project_id", "status")
);

ALTER TABLE "project_task_status_count"
  ADD CONSTRAINT "project_task_status_count_project_id_fkey"
  FOREIGN KEY ("project_id") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- The one read of the whole table this change is allowed: what every later read is now spared.
-- Same predicate as the statement it replaces, so the number it produces is the same one.
INSERT INTO "project_task_status_count" ("project_id", "status", "count")
SELECT "project_id", "status", count(*)::int
FROM "task"
WHERE "project_id" IS NOT NULL
GROUP BY "project_id", "status";

CREATE FUNCTION "project_task_status_count_sync"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO "project_task_status_count" ("project_id", "status", "count")
    SELECT "project_id", "status", count(*)::int
    FROM "inserted" WHERE "project_id" IS NOT NULL
    GROUP BY "project_id", "status"
    ORDER BY "project_id", "status"
    ON CONFLICT ("project_id", "status")
    DO UPDATE SET "count" = "project_task_status_count"."count" + EXCLUDED."count";
  ELSIF TG_OP = 'DELETE' THEN
    INSERT INTO "project_task_status_count" ("project_id", "status", "count")
    SELECT "project_id", "status", (-count(*))::int
    FROM "deleted" WHERE "project_id" IS NOT NULL
    GROUP BY "project_id", "status"
    ORDER BY "project_id", "status"
    ON CONFLICT ("project_id", "status")
    DO UPDATE SET "count" = "project_task_status_count"."count" + EXCLUDED."count";
  ELSE
    INSERT INTO "project_task_status_count" ("project_id", "status", "count")
    SELECT "project_id", "status", sum("delta")::int
    FROM (
      SELECT "project_id", "status", 1 AS "delta" FROM "inserted" WHERE "project_id" IS NOT NULL
      UNION ALL
      SELECT "project_id", "status", -1 AS "delta" FROM "deleted" WHERE "project_id" IS NOT NULL
    ) "x"
    GROUP BY "project_id", "status"
    HAVING sum("delta") <> 0
    ORDER BY "project_id", "status"
    ON CONFLICT ("project_id", "status")
    DO UPDATE SET "count" = "project_task_status_count"."count" + EXCLUDED."count";
  END IF;
  RETURN NULL;
END;
$$;

CREATE TRIGGER "project_task_status_count_insert"
  AFTER INSERT ON "task" REFERENCING NEW TABLE AS "inserted"
  FOR EACH STATEMENT EXECUTE FUNCTION "project_task_status_count_sync"();

CREATE TRIGGER "project_task_status_count_delete"
  AFTER DELETE ON "task" REFERENCING OLD TABLE AS "deleted"
  FOR EACH STATEMENT EXECUTE FUNCTION "project_task_status_count_sync"();

CREATE TRIGGER "project_task_status_count_move"
  AFTER UPDATE ON "task"
  REFERENCING OLD TABLE AS "deleted" NEW TABLE AS "inserted"
  FOR EACH STATEMENT EXECUTE FUNCTION "project_task_status_count_sync"();

COMMENT ON TABLE "project_task_status_count" IS
  'Rows of "task" per project and status, maintained by project_task_status_count_sync. Exact: it is what the Prisma groupBy used to recount on every read of GET /projects/:id.';
