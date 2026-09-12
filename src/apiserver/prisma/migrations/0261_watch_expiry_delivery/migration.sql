-- 0261 — a row for delivering a Watch's expiry (docs/watch-contract.md §5, contract vector
-- `ttl-expiry-wakes-a-waiting-observer`).
--
-- Contract §5: a RESUME_SESSION watch that expires before its condition ever holds still owes its
-- observer one turn that says EXPIRED; otherwise a session waiting on it waits forever. 0259 gave the
-- delivery worker only one kind of row: `watch_delivery.match_id` is NOT NULL and references
-- `watch_match`. An expiry records no Match, so it had no row to be written, retried or
-- dead-lettered from.
--
-- WHAT CHANGES
-- ============
-- `watch_delivery` gains a `kind`. It is `MATCH` for every row so far, and that is the column default;
-- the other value is `EXPIRY`. An EXPIRY row names its watch in the new `watch_id` column instead of
-- naming a Match. It also stores, in `expiry_snapshot`, the snapshot the expiring evaluation took, so
-- every attempt builds the same turn from a row that never changes (the same guarantee
-- `per_target_snapshot` gives a Match's delivery). `match_id` becomes nullable, and
-- `watch_delivery_kind_shape_chk` fixes what each kind of row names:
--
--   MATCH   match_id is set; watch_id and expiry_snapshot are NULL
--   EXPIRY  watch_id is set, the snapshot is a JSON object, match_id is NULL, and the action is
--           RESUME_SESSION: §5 owes this turn to a waiting session, and a notification has no
--           session waiting on it
--
-- Both kinds use the same lease, retry and dead-letter columns, on purpose: the worker claims,
-- attempts, retries and dead-letters an expiry with exactly the statements it uses for a Match.
--
-- WHAT STAYS UNIQUE
-- =================
--   * `watch_delivery_match_action_key` (UNIQUE (match_id, action)) is untouched: a Match still gets
--     one delivery per action. EXPIRY rows have a NULL match_id, and NULLs never collide.
--   * `watch_delivery_expiry_watch_key` (UNIQUE (watch_id), partial on watch_id being set) allows one
--     expiry delivery per watch, since the shape CHECK lets only EXPIRY rows set watch_id. It is
--     partial for the reason 0259 gives for `watch_owner_idempotency_key`: most rows have no
--     watch_id, and a non-partial index would hold a NULL entry for each of them. The foreign key's
--     cascade from `watch` also uses this index, because `watch_id = $1` implies the predicate.
--
-- BACKWARD COMPATIBLE
-- ===================
-- Existing rows become MATCH rows without any write: `kind` is added with a constant default (a
-- catalog-only change since PostgreSQL 11, with no table rewrite), and the two new columns are
-- nullable, so the new CHECK accepts every row 0259's writers could have made. Those writers keep
-- working unchanged: an INSERT that names only (id, match_id, action, next_attempt_at) creates a
-- MATCH row. Every read that joins `watch_delivery` to `watch_match` sees what it saw before, because
-- an EXPIRY row has no Match to join. A build that predates this migration never writes an EXPIRY
-- row. If it finds one, it cannot deliver it, so its attempts end in a dead letter, never in a turn.
--
-- Atomic, for 0259's reason: a nullable match_id without the CHECK saying when it may be NULL would
-- allow a delivery that names nothing. The file has its own BEGIN/COMMIT, so an interrupted apply
-- leaves nothing behind and can simply be run again.

BEGIN;

ALTER TABLE "watch_delivery"
  ADD COLUMN "kind" text NOT NULL DEFAULT 'MATCH',
  ADD COLUMN "watch_id" uuid,
  ADD COLUMN "expiry_snapshot" jsonb,
  ALTER COLUMN "match_id" DROP NOT NULL;

ALTER TABLE "watch_delivery"
  -- Deleting a watch deletes its expiry delivery too, just as it deletes its Matches and their deliveries.
  ADD CONSTRAINT "watch_delivery_watch_fkey" FOREIGN KEY ("watch_id") REFERENCES "watch"("id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "watch_delivery_kind_chk" CHECK ("kind" IN ('MATCH', 'EXPIRY')),
  -- Every operand is NOT NULL or an IS test, so this expression is never NULL. That matters because a
  -- CHECK whose result is NULL passes, and `jsonb_typeof(NULL) = 'object'` on its own evaluates to NULL.
  ADD CONSTRAINT "watch_delivery_kind_shape_chk" CHECK (
    ("kind" = 'MATCH' AND "match_id" IS NOT NULL AND "watch_id" IS NULL AND "expiry_snapshot" IS NULL)
    OR ("kind" = 'EXPIRY' AND "match_id" IS NULL AND "watch_id" IS NOT NULL
        AND "action" = 'RESUME_SESSION'
        AND "expiry_snapshot" IS NOT NULL AND jsonb_typeof("expiry_snapshot") = 'object'));

CREATE UNIQUE INDEX "watch_delivery_expiry_watch_key"
  ON "watch_delivery"("watch_id") WHERE "watch_id" IS NOT NULL;

COMMIT;
