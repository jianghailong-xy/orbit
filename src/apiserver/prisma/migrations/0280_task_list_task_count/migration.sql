-- A list's task count, kept as a number instead of being recounted on every read.
--
-- `GET /task-lists` asked Prisma for `_count: { select: { tasks: true } }`, which compiles to a
-- LEFT JOIN onto an UNFILTERED aggregate of the whole `task` table — Prisma emits `WHERE $4=$5`,
-- an always-true placeholder, so the subquery has no predicate at all:
--
--   LEFT JOIN (SELECT list_id, COUNT(*) FROM task WHERE $4=$5 GROUP BY list_id) ...
--
-- On 2026-09-17 that one statement was 22.1% of this database's entire execution time: 1,606 calls
-- in 6h37m at mean 230.98 ms, because the sidebar polls this index every 15s (5s while anything is
-- running) on both clients. Measured plan, 111,717 rows read to produce 13 group rows that join to
-- 17 list rows: `Seq Scan on task ... Buffers: shared hit=10574 read=12910` — 23,484 buffers, or
-- ~183MB, against a 128MB shared_buffers. The read is not merely slow; four times a minute it
-- evicts the whole buffer pool out from under everything else, which is where its 45% hit rate
-- comes from.
--
-- WHY NOT JUST FILTER THE SUBQUERY
-- ================================
-- The obvious reading of `WHERE $4=$5` is that the aggregate wants a predicate and would then use
-- `task_list_id_idx`. Measured on this deployment, it does not help: 110,439 of the 111,719 task
-- rows already belong to the 17 lists of the one owner doing the polling (four of those lists hold
-- 27,468 each), so scoping the aggregate to that owner removes 1.1% of the rows. Both shapes were
-- run against production with `EXPLAIN (ANALYZE, BUFFERS)`: unfiltered 48.2 ms / 268 buffers,
-- scoped to the owner's lists 45.1 ms / 306 buffers — and with `enable_indexonlyscan = off`, which
-- is what a stale visibility map does to the planner, 164.3 ms / 20,493 buffers versus 128.3 ms /
-- 20,520. A filter cannot make an exact count of 110,439 rows cheap, because those rows are
-- genuinely being counted.
--
-- That is also why the numbers above swing so widely. The aggregate is affordable only while an
-- index-only scan is viable, and whether it is depends on the visibility map: the 230 ms baseline
-- was the regime after a bulk write left the map stale, and an autovacuum at 2026-09-17 23:51:35Z
-- put it back to a 23 ms one. Nothing in the query decides which regime it is in, so the read's
-- cost was a property of when autovacuum last ran.
--
-- WHAT THIS DOES INSTEAD
-- ======================
-- The count stops being recomputed per read and becomes a number maintained per write. It is the
-- same number: `task_count` is every row of `task` whose `list_id` is this list, which is exactly
-- what the relation aggregate counted — no filter on either side, so no status, no soft delete and
-- no ownership enters into it. Callers keep the `_count: { tasks }` shape they already decode.
--
-- The trade this makes is cheap in the direction it matters. `task` takes ~52 writes a day on this
-- deployment against ~5,800 reads of this index; and of those writes, only the ones that INSERT,
-- DELETE or re-list a task change the number at all. A status, progress or `dispatch_hold` write
-- nets to zero for every list, which the `HAVING` below drops before any `task_list` row is
-- written or locked — so the writes that are almost all of this table's traffic reach the trigger
-- and leave again having taken nothing.
--
-- WHY A TRIGGER RATHER THAN THE SERVICE
-- =====================================
-- Because one of the writers is not the service. `Task.listId` is `onDelete: SetNull`, so deleting
-- a list clears its tasks' `list_id` through a referential action inside the database, and every
-- backfill, migration and psql session is a writer too. A counter the application maintains is
-- exact only for the paths someone remembered; a trigger is exact for all of them, which is the
-- property that lets this stay an exact count rather than becoming an approximate one.
--
-- Statement-level with transition tables, not row-level: creating a 27,468-task list is one
-- `createMany`, and this has to cost one UPDATE of one `task_list` row for that statement rather
-- than 27,468 of them. The row lock it takes is the list's own, held for the length of the
-- statement that is already writing that list's tasks.

ALTER TABLE "task_list" ADD COLUMN "task_count" INTEGER NOT NULL DEFAULT 0;

-- The one read of the whole table this change is allowed: what every later read is now spared.
UPDATE "task_list" "tl"
SET "task_count" = "c"."n"
FROM (
  SELECT "list_id", count(*)::int AS "n"
  FROM "task"
  WHERE "list_id" IS NOT NULL
  GROUP BY "list_id"
) "c"
WHERE "tl"."id" = "c"."list_id";

-- One function behind three triggers. The transition table a branch names exists only for the
-- operation that branch runs under, which is safe because plpgsql plans a statement when it first
-- executes it and never executes the branches belonging to the other two triggers.
--
-- The UPDATE branch nets the two tables per list rather than looking for rows whose `list_id`
-- changed. It has to: PostgreSQL refuses `REFERENCING ... TABLE` on a trigger with a column list
-- ("transition tables cannot be specified for triggers with column lists"), so this fires on every
-- UPDATE of `task` and most of them re-list nothing. Netting is what makes that free — a statement
-- that wrote only `status` contributes +1 and -1 to the same list, `HAVING` drops the zero, and no
-- `task_list` row is written or even locked. It is also the correct answer for the statements that
-- DO re-list: one that moves some of its rows and leaves others, or writes a list back over itself,
-- nets to exactly the rows that moved.
-- The target is spelled `UPDATE "task_list" SET`, unaliased, in all three branches. That is the
-- shape scripts/sync-db-trigger-inventory.mjs reads to record what a trigger reaches for in
-- another relation; behind an alias it records `takes: []`, and an inventory that understates this
-- one is exactly the silent gap docs/postgres-lock-order.md §0 exists to prevent.
CREATE FUNCTION "task_list_task_count_sync"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    UPDATE "task_list" SET "task_count" = "task_list"."task_count" + "d"."n"
    FROM (
      SELECT "list_id", count(*)::int AS "n"
      FROM "inserted" WHERE "list_id" IS NOT NULL GROUP BY "list_id"
    ) "d"
    WHERE "task_list"."id" = "d"."list_id";
  ELSIF TG_OP = 'DELETE' THEN
    UPDATE "task_list" SET "task_count" = "task_list"."task_count" - "d"."n"
    FROM (
      SELECT "list_id", count(*)::int AS "n"
      FROM "deleted" WHERE "list_id" IS NOT NULL GROUP BY "list_id"
    ) "d"
    WHERE "task_list"."id" = "d"."list_id";
  ELSE
    UPDATE "task_list" SET "task_count" = "task_list"."task_count" + "d"."n"
    FROM (
      SELECT "list_id", sum("delta")::int AS "n"
      FROM (
        SELECT "list_id", 1 AS "delta" FROM "inserted" WHERE "list_id" IS NOT NULL
        UNION ALL
        SELECT "list_id", -1 AS "delta" FROM "deleted" WHERE "list_id" IS NOT NULL
      ) "x"
      GROUP BY "list_id"
      HAVING sum("delta") <> 0
    ) "d"
    WHERE "task_list"."id" = "d"."list_id";
  END IF;
  RETURN NULL;
END;
$$;

CREATE TRIGGER "task_list_task_count_insert"
  AFTER INSERT ON "task" REFERENCING NEW TABLE AS "inserted"
  FOR EACH STATEMENT EXECUTE FUNCTION "task_list_task_count_sync"();

CREATE TRIGGER "task_list_task_count_delete"
  AFTER DELETE ON "task" REFERENCING OLD TABLE AS "deleted"
  FOR EACH STATEMENT EXECUTE FUNCTION "task_list_task_count_sync"();

CREATE TRIGGER "task_list_task_count_relist"
  AFTER UPDATE ON "task"
  REFERENCING OLD TABLE AS "deleted" NEW TABLE AS "inserted"
  FOR EACH STATEMENT EXECUTE FUNCTION "task_list_task_count_sync"();

COMMENT ON COLUMN "task_list"."task_count" IS
  'Rows of "task" with this list_id, maintained by task_list_task_count_sync. Exact: it is what the Prisma relation _count used to recount on every read of GET /task-lists.';
