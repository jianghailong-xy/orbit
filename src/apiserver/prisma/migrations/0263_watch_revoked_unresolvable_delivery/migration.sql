-- 0263 — a delivery row for a Watch that ends REVOKED or UNRESOLVABLE (docs/watch-contract.md §3, §7,
-- contract vectors `revoked-wakes-a-waiting-observer-with-no-target-state`,
-- `unresolvable-wakes-a-waiting-observer` and `cancelled-watch-wakes-nobody`).
--
-- Contract §3 names REVOKED and UNRESOLVABLE as separate states because a watch that cannot go on has
-- to say so. 0261 gave a RESUME_SESSION watch's EXPIRED end a delivery row, so the session waiting on it
-- is told. The other two ends the evaluator reaches had no row: the watch moved to REVOKED or
-- UNRESOLVABLE, nothing reached its observer, and that session waited forever. CANCELLED still gets no
-- row. Cancelling is something the owner or the observer does, so whoever cancelled already knows.
--
-- WHAT CHANGES
-- ============
-- `watch_delivery_kind_chk` and `watch_delivery_kind_shape_chk` each gain two kinds, named after the
-- state the watch ends in. PostgreSQL cannot add a member to a CHECK, so both are rewritten whole. Each
-- new definition is 0261's with the new kinds added and nothing removed:
--
--   MATCH                  unchanged: match_id is set; watch_id and expiry_snapshot are NULL
--   EXPIRY                 unchanged: watch_id is set, the snapshot is a JSON object, match_id is NULL,
--                          and the action is RESUME_SESSION
--   REVOKED, UNRESOLVABLE  watch_id is set, match_id is NULL, the action is RESUME_SESSION, and
--                          expiry_snapshot is NULL
--
-- Neither kind carries a snapshot, on purpose. Contract §7: a watch whose permission recheck failed
-- delivers nothing about what it watched. A REVOKED row therefore has no column that could hold target
-- state, and its turn is built from the watch id and the kind alone. An UNRESOLVABLE watch's targets
-- are all GONE, so it has nothing to report either, and the same shape serves it. Neither input ever
-- changes, so every attempt builds the same turn, which is the guarantee `expiry_snapshot` gives an
-- expiry.
--
-- WHAT STAYS UNIQUE
-- =================
-- No index is added. `watch_delivery_expiry_watch_key` (UNIQUE (watch_id), partial on watch_id being
-- set) already covers every row the shape CHECK lets set watch_id. Those are now the EXPIRY, REVOKED
-- and UNRESOLVABLE rows, so a watch has at most one end delivery, whichever way it ended. That is the
-- right bound: a watch reaches exactly one terminal state, and the index is what stops a re-landed or
-- raced end from queuing a second turn.
--
-- BACKWARD COMPATIBLE
-- ===================
-- Every row that 0261's writers can make satisfies the new CHECKs, so the re-validation that
-- ADD CONSTRAINT runs rejects nothing, and those writers keep working unchanged. No column, index or row
-- is written. A build from before this migration never writes a REVOKED or UNRESOLVABLE row. A 0261
-- build that finds one treats every row without a Match as an expiry, so it would tell the observer the
-- watch EXPIRED. Run this migration only with the build that ships it.
--
-- Atomic, for 0261's reason: dropping a CHECK before its successor exists would, for that moment, allow
-- a delivery that names nothing. The file has its own BEGIN/COMMIT, so an interrupted apply leaves
-- nothing behind and can simply be run again.

BEGIN;

ALTER TABLE "watch_delivery"
  DROP CONSTRAINT "watch_delivery_kind_chk",
  DROP CONSTRAINT "watch_delivery_kind_shape_chk",
  ADD CONSTRAINT "watch_delivery_kind_chk" CHECK ("kind" IN ('MATCH', 'EXPIRY', 'REVOKED', 'UNRESOLVABLE')),
  -- As in 0261, every operand is NOT NULL or an IS test, so this expression is never NULL: a CHECK
  -- whose result is NULL passes.
  ADD CONSTRAINT "watch_delivery_kind_shape_chk" CHECK (
    ("kind" = 'MATCH' AND "match_id" IS NOT NULL AND "watch_id" IS NULL AND "expiry_snapshot" IS NULL)
    OR ("kind" = 'EXPIRY' AND "match_id" IS NULL AND "watch_id" IS NOT NULL
        AND "action" = 'RESUME_SESSION'
        AND "expiry_snapshot" IS NOT NULL AND jsonb_typeof("expiry_snapshot") = 'object')
    OR ("kind" IN ('REVOKED', 'UNRESOLVABLE') AND "match_id" IS NULL AND "watch_id" IS NOT NULL
        AND "action" = 'RESUME_SESSION' AND "expiry_snapshot" IS NULL));

COMMIT;
