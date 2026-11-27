-- 1270 — two reads that scanned a whole table to find a handful of rows. Production, 2026-11-19: one owner holds
-- nearly all of `task` (115k rows, 3 owners) and `session_merge_receipt` (6.2k rows, 2 owners), so `owner_id` is
-- not selective and neither read had an index for what it actually asks.
--
--   * `session_merge_receipt_source_sha_idx`: a COMMIT citation's "is this commit recorded under another task of
--     mine" (`resolveCommit` in tasks/task-evidence-envelope.ts), `owner_id = $1 AND source_sha = $2 LIMIT 1`.
--     Every read of an evidence card runs it (`describeEvidenceCitations`) for each COMMIT citation that is not
--     this task's receipt. Production: 398,826 calls, about 453 buffers each and 0 rows ever, so each call read
--     the whole table. A commit sha is nearly unique, so the sha alone is the access path.
--
--   * `task_owner_updated_idx`: the wiki maintenance facts read's settled-task arm (`factsSql` in
--     wiki/wiki-maintenance.ts), `t.owner_id = $ AND t.status::text IN (…) AND t.updated_at >= $since`. The cast
--     keeps the status indexes out of reach, and nothing indexed `updated_at` without a project, so the arm read
--     every task of the owner on each of the trigger's hints: production, 40,069 calls at about 26.7k buffers.
--     With this index the arm reads the tasks changed since the space's cursor. A partial index on the terminal
--     statuses cannot be spelled: the read compares `status::text`, and an index predicate cannot cast an enum
--     (the cast is not immutable).
--
-- Not CONCURRENTLY, as with 1130, 1170 and 1240: Prisma runs the migration in a transaction. Each build is one pass
-- over its table and holds a SHARE lock that long. No row is written. Every statement can run twice.

CREATE INDEX IF NOT EXISTS "session_merge_receipt_source_sha_idx"
  ON "session_merge_receipt" ("source_sha");

CREATE INDEX IF NOT EXISTS "task_owner_updated_idx"
  ON "task" ("owner_id", "updated_at");
