-- The two counters that split a list's pause DECISION from its consequence.
--
-- 2026-09-14: PATCHing `paused` on four 27,468-task lists ran `task.updateMany({ dispatch_hold })`
-- inside the request's transaction, which holds the owner graph mutex (lock-order.ts I1). Each
-- sweep took 5+ minutes (27 indexes on `task`, including a GIN) and every same-owner request
-- queued behind it — the pool exhausted by clients timing out and re-running the whole O(n) unit.
-- The request transaction now writes the list row alone, in O(1), and a background projector
-- converges `task.dispatch_hold` in id-keyset chunks with one commit per chunk.
--
-- `pause_epoch` is the DECISION: incremented only when a write actually changes `paused`, so a
-- same-value PATCH is a no-op with no projection work behind it. `pause_applied_epoch` is what the
-- projector has finished applying. `pause_applied_epoch < pause_epoch` IS the worklist — there is
-- no cursor, no lease and no queue row, so a projector that dies mid-sweep strands nothing: the
-- next pass re-claims the list from this comparison and re-runs the chunks (each chunk's guard is
-- `dispatch_hold <> target`, so re-running an already-applied chunk writes nothing).
--
-- Two counters rather than one flag because a sweep takes many transactions: a decision that
-- arrives mid-sweep must be distinguishable from the one being applied, or the sweep would stamp
-- "applied" over a value it never wrote. The comparison is also what the lag warning reads.
--
-- Nothing to backfill, and nothing to reconcile on the way in. A task's `dispatch_hold` was
-- already correct for every existing list — the projection used to be written in the same
-- transaction as the pause — so every list starts at applied = epoch = 0, which reads as "no
-- projection outstanding". The two ADD COLUMNs are catalog-only: a non-volatile default does not
-- rewrite the heap (PostgreSQL 11+). The index below is not — it reads every row of `task` once —
-- and is the only part of this migration whose cost scales with the table.

ALTER TABLE "task_list" ADD COLUMN "pause_epoch" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "task_list" ADD COLUMN "pause_applied_epoch" INTEGER NOT NULL DEFAULT 0;

-- The projector's keyset page, added because it was MEASURED rather than assumed.
--
-- One chunk is `SELECT id FROM task WHERE list_id = $1 AND id > $2 ORDER BY id LIMIT n`. With only
-- `task_list_id_idx` (0015) to work with, the planner's answer to that is an index scan of every
-- row in the list plus a top-N heapsort of them all: on a 27,468-row list, a 2,000-row page costs
-- 27,468 rows read and a 176kB sort, in EVERY chunk — O(list) per statement, which is the shape of
-- the outage in a smaller box. Measured on the spec's list, before this index and on the same
-- server: "Limit -> Sort (Sort Key: id, top-N heapsort 176kB) -> Index Scan using task_list_id_idx
-- (actual rows=27468)".
--
-- (list_id, id) makes the page a range scan that stops after n rows, which is what the chunk's cost
-- has to be bounded by. It also subsumes `task_list_id_idx`, since list_id is its leading column;
-- that index is left standing because dropping one is its own change with its own blast radius, and
-- nothing here needs it gone.
--
-- A plain CREATE INDEX, not CONCURRENTLY: prisma migrate deploy runs each migration in a
-- transaction, and CONCURRENTLY cannot run in one. On the deployment this is written for, `task`
-- holds ~55k rows.
CREATE INDEX "task_list_id_id_idx" ON "task"("list_id", "id");
