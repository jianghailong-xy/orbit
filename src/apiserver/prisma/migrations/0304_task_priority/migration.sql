-- ══════════════════════════════════════════════════════════════════════════════════════════════
-- A task gains a priority: which of a list's ready tasks takes the list's next free slot.
--
-- WHY THIS HAD TO EXIST
-- ---------------------
-- A list with a concurrency cap is a queue, and until now nothing could say what goes to the front
-- of it. The one way to run a chosen task first was to pause the whole list, move that task into
-- another one, and move it back afterwards — one task at a time, with every other task of the list
-- stopped meanwhile. On 2026-09-25 a campaign needed 82 tasks dispatched ahead of the 27k others in
-- their list, which that recipe makes 82 moves and a paused list.
--
-- WHAT IT MEANS
-- -------------
--   priority   INTEGER NOT NULL DEFAULT 0. Higher is dispatched first. An ORDER, never a
--              permission: it starts nothing, bypasses no gate and is read only by the automatic
--              doors, among the candidates each of them already had (TasksService). Equal
--              priorities keep the order the door read them in, so a task nobody raised is
--              dispatched exactly as it was.
--
-- Every existing row reads 0 and is not touched: ADD COLUMN with a constant default only writes the
-- catalog (`pg_attribute.attmissingval`) on PostgreSQL 11+, so the heap is not rewritten and no row
-- is locked or read — and an older server's INSERT, which does not name the column, lands on 0 too.
--
-- THE INDEX
-- ---------
-- The completion edge starts a task the moment its last prerequisite finishes, which makes it the one
-- door that could hand a list's free slot to a task while a higher-priority one waits. So before it
-- starts one it asks the list one question — `list_id = $1 AND priority > $2 AND priority > 0 AND
-- status = 'OPEN'` — and this index is that question's only way in. PARTIAL on the last two
-- clauses: it holds the open tasks somebody raised and nothing else, so on a list where nobody did
-- the answer is an empty range, and a task that finishes leaves it. `task_list_id_id_idx` would
-- answer it by fetching every task of the list (27k on the list that motivated this).
--
-- The predicate cannot be spelled in schema.prisma, which declares the index without it — the trade
-- `task_run_at_idx` (0110) and the two task-tree indexes (0108) already carry.
--
-- Deliberately not CONCURRENTLY because Prisma runs the migration in a transaction; the build is one
-- pass over `task` that finds no row to index, and task writes wait for it (reads do not). A
-- deployment that wants no such wait may run both statements by hand first — the column, then the
-- index CONCURRENTLY — while the previous build is still serving: nothing it runs reads or writes the
-- column. Both statements here are IF NOT EXISTS for exactly that, so this file is then a no-op.
--
-- Nothing else moves: no function, trigger, type or constraint is created, altered or dropped, and
-- there is no INSERT, UPDATE or DELETE.

ALTER TABLE "task" ADD COLUMN IF NOT EXISTS "priority" INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS "task_list_priority_idx"
  ON "task" ("list_id", "priority")
  WHERE "priority" > 0 AND "status" = 'OPEN';
