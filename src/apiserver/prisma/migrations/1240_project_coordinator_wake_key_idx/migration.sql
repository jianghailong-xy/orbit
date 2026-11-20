-- 1240 — every coordinator wake attempt of a key, found by its key.
--
-- The evidence queue (coordinator-evidence-queue.ts) reads all attempts made under a set of idempotency keys,
-- refused ones included, to tell a delivery that was read from one taken off the queue unread. The only index on
-- the key is 0174's `project_coordinator_wake_live_key_idx`, which is partial (status <> 'REFUSED') because it is
-- the uniqueness of a live attempt; a read that must also see refused attempts cannot use it, so each one was a
-- sequential scan of the whole table: production, 2026-11-19, ~600 scans per 5 minutes of a 7.6 MB table, 958
-- buffers and 6.2 ms a read. Measured there inside a rolled-back transaction with this index: 108 buffers, 0.5 ms,
-- the same 125 rows.
--
-- Not unique: refused attempts share their key with the live one. Not CONCURRENTLY, as with 1130 and 1170: Prisma
-- runs the migration in a transaction; one pass over ~9,600 rows. No row is written. Every statement can run twice.

CREATE INDEX IF NOT EXISTS "project_coordinator_wake_key_idx"
  ON "project_coordinator_wake" ("idempotency_key");
