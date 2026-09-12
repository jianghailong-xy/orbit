-- 0260 — the index the Watch delivery worker's lease-expiry sweep reads, and nothing else.
--
-- 0259 indexed the worker's CLAIM: `watch_delivery_due_idx`, partial on PENDING, so rows already in
-- flight, delivered or dead-lettered are not in the index the claim scans. Delivered and
-- dead-lettered rows are never deleted — they are the record of what each Match caused — so an
-- index over every row would grow with every delivery ever made.
--
-- The worker has a second read 0259 did not index: the deliveries whose lease ran out. A worker
-- that died holding one will never release it, so another worker has to find it:
--
--     SELECT "id" FROM "watch_delivery" WHERE "state" = 'IN_FLIGHT' AND "lease_deadline_at" <= now()
--
-- Unindexed, that is a sequential scan over the whole delivery history on every sweep, to find the
-- few rows (at most one claim batch per replica) that are in flight. Partial on IN_FLIGHT for 0259's
-- reason: `watch_delivery_lease_shape_chk` makes a lease deadline exist exactly while a row is
-- IN_FLIGHT, so this index holds only the rows some worker is holding right now.
--
-- BACKWARD COMPATIBLE BY CONSTRUCTION: one CREATE INDEX on a table 0259 created. No row is read or
-- written and no relation changes shape, so a build that knows nothing about the sweep runs
-- unchanged against it. `IF NOT EXISTS`, so an interrupted apply can simply be re-run.

CREATE INDEX IF NOT EXISTS "watch_delivery_lease_expiry_idx"
  ON "watch_delivery"("lease_deadline_at") WHERE "state" = 'IN_FLIGHT';
