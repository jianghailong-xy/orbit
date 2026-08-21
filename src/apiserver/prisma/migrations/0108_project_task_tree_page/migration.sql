-- Reading one level of a project's task tree.
--
-- Additive and index-only: no column, constraint or row is touched here, and 0107 is left exactly
-- as it shipped. A deployment that applies this and then runs the previous build behaves as it did
-- before — an index nothing queries costs writes, not correctness.
--
-- `GET /projects/:id/tasks/page` makes exactly two reads, and they differ in one clause:
--
--   WHERE owner_id = $1 AND project_id = $2 AND parent_task_id IS NULL   -- the top level
--   WHERE owner_id = $1 AND project_id = $2 AND parent_task_id = $3      -- one node's children
--   ORDER BY created_at DESC, id DESC LIMIT $n                           -- both, plus the cursor
--
-- Two indexes rather than the one that column list suggests, and the reason is `IS NULL`.
-- PostgreSQL will happily SEEK on it — `parent_task_id IS NULL` shows up as an Index Cond on the
-- three-column form — but it does not treat that scan key as an equality for ordering purposes,
-- so the columns after it stop providing sorted output. Measured on a 100k-row task table with a
-- 40k-task project, the shared index gives the top-level page an `Index Scan -> Sort` (or worse:
-- the planner preferred `task_owner_created_id_idx` and discarded 60,652 rows to find 101, 25.5ms
-- / 1494 buffers). Splitting the `IS NULL` half into its own index, where the predicate moves out
-- of the key and into the WHERE clause, leaves `(owner_id, project_id)` as plain equalities in
-- front of the sort keys: 0.14ms / 7 buffers, no sort node, on the same page.
--
-- The sort direction is written out rather than left implicit. A backwards scan of an ASC index
-- costs nothing here, but the cursor predicate is `(created_at, id) < ($1, $2)`, and matching the
-- declared order to the query's is what keeps that a range boundary rather than a filter.
--
-- `status` is in neither index, on purpose. It is a refinement of a level, not a way into one:
-- with the parent fixed, the rows it filters are one node's siblings, cheap to re-check while
-- walking them in order (measured: the filtered pages stay on these indexes, no sort). Placed
-- between the parent and the sort keys it would help only the filtered tabs, and would take the
-- ordered read away from the unfiltered tree — which is the tree's ordinary state, and the one
-- request every client makes to open a project.
--
-- Both are PARTIAL on `project_id IS NOT NULL`, which is a fact about this deployment rather than
-- a micro-optimization: all 110k existing tasks are in no project, and the project id these
-- queries supply always comes from a row that was found, so `project_id = $2` proves the predicate
-- and the planner uses the index anyway (verified). Without it the pair would index six figures of
-- rows that neither read can ever return — 10MB and 5.8MB of b-tree, maintained on every task
-- write, to answer nothing.
--
-- Prisma's schema language cannot express a WHERE on an index, so schema.prisma declares both
-- without their predicates and `migrate diff` reports them as drift. That is the same trade
-- `session_quota_retry_at_idx` has carried since 0081 (`WHERE quota_retry_at IS NOT NULL`, a plain
-- `@@index([retryAt])` in the schema), and here the predicate is not optional: it is what makes
-- the root index able to order at all.

-- The top level of a project: the tasks that are not part of another task.
CREATE INDEX "task_owner_project_root_created_id_idx"
    ON "task"("owner_id", "project_id", "created_at" DESC, "id" DESC)
    WHERE "project_id" IS NOT NULL AND "parent_task_id" IS NULL;

-- One task's direct children. `parent_task_id` is an equality here, so it stays a key column and
-- the ordering carries past it.
CREATE INDEX "task_owner_project_child_created_id_idx"
    ON "task"("owner_id", "project_id", "parent_task_id", "created_at" DESC, "id" DESC)
    WHERE "project_id" IS NOT NULL;
