-- The automatic doors' epoch advances in ONE canonical batch, because two batches cannot be ordered.
--
-- 0137 shipped `task_dispatch_epoch` as the ABA-safe name the automatic doors need, and advanced it
-- from `task` in TWO passes: first the rows this statement wrote, then the dependents of the rows
-- whose `status` moved. Each pass is internally ordered — `task_dispatch_epoch_advance` sorts, and
-- the LockRows node sits above the sort, so the `ORDER BY` IS the acquisition order — and that is
-- exactly as far as the argument goes. It orders the locks WITHIN a pass. Across two passes the
-- acquisition order is `sorted(own) ++ sorted(dependents)`, which is not sorted, and a lock order
-- that is not a total order is not one:
--
--   a < b < c, with `b` depending on `a` and `c` depending on `b` — an ordinary chain, no cycle.
--   T1 writes {a, c}:  own {a, c}, dependents {b}  ->  a, c, b
--   T2 writes {b}:     own {b},    dependents {c}  ->  b, c
--   T1 holds a and c and waits for b; T2 holds b and waits for c. 40P01, and the victim is a
--   `task` status write — a Task reaching DONE, a sweep clearing FAILED — not anything exotic.
--
-- The fix is the shape 0132 already uses for `task_dependency_revision` and the one §7.7 D5-b4
-- assumes: the statement decides its WHOLE affected set first — the rows it wrote UNION the
-- dependents of the rows whose status moved — and advances it ONCE. One `ANY(...) ORDER BY task_id
-- FOR NO KEY UPDATE` per statement is a total order over `task_dispatch_epoch`, so two overlapping
-- writers take the rows they share in the same direction and the cycle above cannot be drawn.
--
-- The counter's SEMANTICS are unchanged, deliberately: the same transitions advance the same Tasks
-- by the same +1 per statement (a Task in both halves was already collapsed by `advance`'s
-- `UPDATE … WHERE task_id = ANY(ids)`, which touches each row once). §7.7 D5-b4's transition table
-- is untouched. What changes is only the order the rows are taken in.
--
-- REPLACES A FUNCTION BODY AND NOTHING ELSE. The triggers, the table, the seed and
-- `task_dispatch_epoch_advance` are 0137's and stay 0137's; this file redefines
-- `task_dispatch_epoch_bump_update` alone, so there is no window in which a reader observes a
-- half-changed object and nothing to backfill. 0137 is deployed and is not edited.
BEGIN;

CREATE OR REPLACE FUNCTION "task_dispatch_epoch_bump_update"() RETURNS trigger AS $$
DECLARE
  moved UUID[];
BEGIN
  -- The transition table in one query, in the contract's order:
  --   1 + 2. `run_at` or `status` changed on the Task itself — a new appointment (or one consumed
  --          or cancelled), and this Task becoming runnable again after DONE or FAILED.
  --   3.     `status` changed on a PREREQUISITE, so each of its dependents may have just become
  --          READY for the second time under an unchanged edge set.
  -- UNION rather than two statements: the set is what has to be sorted, and a set assembled in two
  -- halves is sorted in two halves.
  SELECT array_agg(DISTINCT "id" ORDER BY "id") INTO moved FROM (
    SELECT n."id"
      FROM new_tasks n JOIN old_tasks o ON o."id" = n."id"
     WHERE n."run_at" IS DISTINCT FROM o."run_at"
        OR n."status" IS DISTINCT FROM o."status"
    UNION
    SELECT d."task_id" AS "id"
      FROM new_tasks n JOIN old_tasks o ON o."id" = n."id"
      JOIN "task_dependency" d ON d."depends_on_task_id" = n."id"
     WHERE n."status" IS DISTINCT FROM o."status"
  ) affected;
  PERFORM "task_dispatch_epoch_advance"(moved);
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

COMMIT;
