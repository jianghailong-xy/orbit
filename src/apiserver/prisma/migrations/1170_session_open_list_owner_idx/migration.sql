-- 1170 — the Open session list's own rows, indexed.
--
-- SessionsService.listRows' Open view asks for `owner_id = $owner AND COALESCE(completed_at, archived_at) IS NULL
-- AND deleted_at IS NULL`. `owner_id` is not selective on production (2026-11-19: one owner holds 10k of the 16k
-- sessions), so every list read was a sequential scan of the whole table, 4,231 pages, to find the ~1,300 open
-- rows. This index holds only those rows, and its predicate is the list's own spelling, COALESCE included, which is
-- what lets the planner prove it. Measured there inside a rolled-back transaction: the scan went from ~22 ms to 3 ms
-- and the statement from 110 ms to 85 ms, the same rows.
--
-- Not CONCURRENTLY, as with 1130: Prisma runs the migration in a transaction. One pass over a 33 MB table,
-- holding a SHARE lock that long. No row is written. Every statement can run twice.

CREATE INDEX IF NOT EXISTS "session_open_list_owner_idx"
  ON "session" ("owner_id")
  WHERE COALESCE("completed_at", "archived_at") IS NULL AND "deleted_at" IS NULL;
