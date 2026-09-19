-- A list's DONE task count, beside its total, kept as a number instead of being counted per read.
--
-- Migration 0280 gave `task_list` a maintained `task_count` and removed the UNFILTERED
-- `_count: { select: { tasks: true } }` from `GET /task-lists`. It did not remove the second
-- grouped read in the same method, because that one is filtered and the column it would need did
-- not exist:
--
--   SELECT COUNT(*) AS "_count$_all", "list_id" FROM "task"
--   WHERE "list_id" IN ($1..$17) AND "status" = 'DONE' GROUP BY "list_id"
--
-- On this deployment, over the 32h50m window beginning at
-- `pg_stat_statements_info.stats_reset` = 2026-09-17 17:07:39.336692+00, that statement was
-- queryid `-7100627870817913419`: 12,048 calls, mean_exec_time 8.38 ms, 10,823,975 buffers
-- (10,456,415 hit + 351,665 read), producing 110,086 group rows. The sidebar polls this index
-- every 15s — 5s while anything is running — on both clients, so it is ~370 calls an hour.
--
-- WHY THIS IS NOT THE 0280 PROBLEM, AND WHY IT STILL IS A PROBLEM
-- ==============================================================
-- The ticket this came from reads the statement as "groups 110,439 rows on every page turn". The
-- plan says otherwise, and the difference is the whole argument. `status = 'DONE'` is 1.3%
-- selective, `task_status_idx` exists, and the planner uses it — so the statement does NOT
-- traverse the rows the lists hold:
--
--   HashAggregate  (rows=12)
--     ->  Index Scan using task_status_idx on task  (rows=561)
--           Index Cond: (status = 'DONE')
--           Filter: (list_id = ANY (17 ids))      Rows Removed by Filter: 921
--           Buffers: shared hit=935               Execution Time: 16.5 ms
--
-- It visits the DONE rows this deployment HAS — 1,482 of them, of which 921 belong to no list at
-- all and are read only to be discarded. That is also why this statement is stable where 0280's
-- was not: 935 buffers, reproduced against an 898-buffer-per-call average over the whole window,
-- so the plan and the buffer count held for 32 hours. 0280's own comment describes the opposite —
-- a read that cost 230 ms or 23 ms depending on when autovacuum last ran.
--
-- The cost is therefore the number of tasks this deployment has ever FINISHED. That quantity is
-- monotone, and it moves in steps. In-list DONE rows are 561 today; the four FineWeb lists hold
-- 109,872 tasks between them that are still open, so driving one of those pipelines to completion
-- is a single event that takes this statement from 935 buffers to tens of thousands — past the
-- 20,535-buffer worst case 0283 was written for — on a read that runs ~370 times an hour.
--
-- By today's share alone this would not have been worth it, and that is recorded here rather than
-- left implied: the statement is 0.23% of this database's execution time and 0.52% of its buffer
-- traffic over the window above (44,214.8 s and 2,086,914,642 buffers in total; 101.1 s and
-- 10,823,975 buffers for this one). What it is worth is the coupling: this read's cost is a
-- function of how much work the deployment has completed, which is the property 0280 and 0282
-- removed from the two statements beside it, and it is on the index endpoint of both clients.
--
-- WHAT THIS DOES
-- ==============
-- `task_done_count` is `count(*) FROM task WHERE list_id = this AND status = 'DONE'` — the number
-- the group-by produced, exact rather than approximate. The index read gets it off the list row it
-- already fetches, so the statement above stops being issued at all: the poll path loses a query
-- rather than getting a cheaper one.
--
-- This EXTENDS the trigger 0280 created instead of adding triggers of its own. The same three
-- statement triggers already fire on every write to `task`, already read the transition tables,
-- and already take the counted list's row once per statement; a second number costs one more
-- aggregate over rows already in the tuplestore, and reaches nothing new.
--
-- The one behavioural change is in the UPDATE branch's `HAVING`. 0280 leans on "a statement that
-- wrote only `status` contributes +1 and -1 to the same list, `HAVING` drops the zero, and no
-- `task_list` row is written or even locked". That remains exactly true of the TOTAL, and stops
-- being true of the DONE count: a status write is now a write to this column, so the `HAVING` has
-- to keep a group whose done-delta is non-zero. The size of that change is measured, not assumed:
-- statements that change `task.status` at all are 160 calls in the window above — about five a
-- day — against 538,480 UPDATEs of `task` since 2026-08-24, and beside the 35,944 calls of
-- `UPDATE task SET model` (~26,300 a day) that still net to zero and still take nothing. The lock
-- is the same row, in the same statement, through the same rank-20 edge from a rank-50 write that
-- `docs/postgres-lock-order.md` §5 already carries for 0280; no new relation is reached and the
-- order does not change.
--
-- WHY NOT A PARTIAL INDEX
-- =======================
-- `CREATE INDEX ... ON task (list_id) WHERE status = 'DONE'` was the cheaper-looking option, and
-- it does buy a lot today: 561 entries, a group-by over a handful of index pages. It was rejected
-- because it does not change the shape of the curve, only its constant. The entries it holds ARE
-- the DONE rows with a list, so completing a large list grows it exactly as it grows
-- `task_status_idx`; and an index-only scan over it is available only while the visibility map is
-- fresh, which is precisely the regime-dependence that made 0280's cost swing 10x. A maintained
-- number is O(list rows) in every regime, including the one after somebody finishes 27,468 tasks
-- in one statement.

ALTER TABLE "task_list" ADD COLUMN "task_done_count" INTEGER NOT NULL DEFAULT 0;

-- The one read of the whole table this change is allowed: what every later read is now spared.
-- Same predicate as the statement it replaces, so the number it produces is the same one.
UPDATE "task_list" "tl"
SET "task_done_count" = "c"."n"
FROM (
  SELECT "list_id", count(*)::int AS "n"
  FROM "task"
  WHERE "list_id" IS NOT NULL AND "status" = 'DONE'::"task_status"
  GROUP BY "list_id"
) "c"
WHERE "tl"."id" = "c"."list_id";

-- Same function, same three triggers, one more number. The UPDATE branch nets inserted against
-- deleted per list rather than looking for rows whose `list_id` changed — it has to, because
-- PostgreSQL refuses `REFERENCING ... TABLE` on a trigger with a column list. Netting is also what
-- keeps the writes that are almost all of this table's traffic free: a statement that wrote only
-- `model`, `dispatch_hold` or progress contributes +1 and -1 to the same list for both numbers,
-- `HAVING` drops the zero, and no `task_list` row is written or even locked.
--
-- The two sums are taken in one pass over the same union, and both columns are written by the same
-- statement, so the second number adds no lock, no statement and no row to what 0280 already did.
-- `COALESCE` around the filtered sum is required rather than cosmetic: `FILTER` yields no rows —
-- and so NULL, not 0 — for a group with no DONE row on either side, and NULL + a column is NULL.
--
-- The target stays spelled `UPDATE "task_list" SET`, unaliased, in all three branches: that is the
-- shape scripts/sync-db-trigger-inventory.mjs reads to record what a trigger reaches for in
-- another relation, and an inventory that understates this one is exactly the silent gap
-- docs/postgres-lock-order.md §0 exists to prevent.
CREATE OR REPLACE FUNCTION "task_list_task_count_sync"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    UPDATE "task_list" SET
      "task_count" = "task_list"."task_count" + "d"."n",
      "task_done_count" = "task_list"."task_done_count" + "d"."n_done"
    FROM (
      SELECT "list_id",
             count(*)::int AS "n",
             count(*) FILTER (WHERE "status" = 'DONE'::"task_status")::int AS "n_done"
      FROM "inserted" WHERE "list_id" IS NOT NULL GROUP BY "list_id"
    ) "d"
    WHERE "task_list"."id" = "d"."list_id";
  ELSIF TG_OP = 'DELETE' THEN
    UPDATE "task_list" SET
      "task_count" = "task_list"."task_count" - "d"."n",
      "task_done_count" = "task_list"."task_done_count" - "d"."n_done"
    FROM (
      SELECT "list_id",
             count(*)::int AS "n",
             count(*) FILTER (WHERE "status" = 'DONE'::"task_status")::int AS "n_done"
      FROM "deleted" WHERE "list_id" IS NOT NULL GROUP BY "list_id"
    ) "d"
    WHERE "task_list"."id" = "d"."list_id";
  ELSE
    UPDATE "task_list" SET
      "task_count" = "task_list"."task_count" + "d"."n",
      "task_done_count" = "task_list"."task_done_count" + "d"."n_done"
    FROM (
      SELECT "list_id",
             sum("delta")::int AS "n",
             COALESCE(sum("delta") FILTER (WHERE "is_done"), 0)::int AS "n_done"
      FROM (
        SELECT "list_id", 1 AS "delta", ("status" = 'DONE'::"task_status") AS "is_done"
        FROM "inserted" WHERE "list_id" IS NOT NULL
        UNION ALL
        SELECT "list_id", -1 AS "delta", ("status" = 'DONE'::"task_status") AS "is_done"
        FROM "deleted" WHERE "list_id" IS NOT NULL
      ) "x"
      GROUP BY "list_id"
      HAVING sum("delta") <> 0 OR COALESCE(sum("delta") FILTER (WHERE "is_done"), 0) <> 0
    ) "d"
    WHERE "task_list"."id" = "d"."list_id";
  END IF;
  RETURN NULL;
END;
$$;

COMMENT ON COLUMN "task_list"."task_done_count" IS
  'Rows of "task" with this list_id AND status DONE, maintained by task_list_task_count_sync. Exact: it is what the Prisma groupBy used to recount on every read of GET /task-lists.';
