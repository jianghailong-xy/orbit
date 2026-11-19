-- 0504 — an owner request's resolution is a delivery the Watch worker performs (project 34uP1vOyTgWZRZimQ0NU2,
-- task "apiserver: resolving an owner request starts a turn in the asking session").
--
-- WHY
-- ===
-- 0503 gave an owner request its four endings (DONE, DECLINED, EXPIRED, WITHDRAWN), but nothing told the session that
-- asked: it had to poll. The Watch delivery worker already turns a recorded fact into exactly one turn on a session,
-- with a lease, retries, dead letters and a turn key `createTurn` replays instead of duplicating, and the turn waits
-- on the session's queue like any sent message, so it reaches a session whose engine was recycled. An ending gets a
-- `watch_delivery` row of its own kind, written in the transaction that writes the ending, and that worker delivers it.
--
-- WHAT CHANGES
-- ============
--   * `owner_request_id` UUID, NULL on every row before this one, with a foreign key to `owner_request`
--     ON DELETE CASCADE: an account's purge takes the delivery with the request.
--   * `watch_delivery_kind_chk` gains OWNER_REQUEST. PostgreSQL cannot add a member to a CHECK, so it is rewritten
--     whole: 0263's list with OWNER_REQUEST added and nothing removed.
--   * `watch_delivery_kind_shape_chk` is rewritten whole the same way, 0263's three clauses unchanged and one added:
--       OWNER_REQUEST  match_id, watch_id and expiry_snapshot are NULL, and the action is RESUME_SESSION
--   * `watch_delivery_owner_request_chk`: owner_request_id is set exactly on an OWNER_REQUEST row.
--   * `watch_delivery_owner_request_key`: UNIQUE (owner_request_id), partial on it being set. A request ends once,
--     so it has at most one delivery; the index is what stops a raced or repeated ending from queuing a second turn.
--
-- BACKWARD COMPATIBLE
-- ===================
-- Every existing row has owner_request_id NULL and a kind 0263 allows, so the re-validation ADD CONSTRAINT runs rejects
-- nothing, and every existing writer keeps working unchanged. A build from before this migration that claims an
-- OWNER_REQUEST row finds neither a Match nor a watch on it and fails that attempt; run this migration with the build
-- that ships it.
--
-- No function, trigger or type is created, replaced or dropped. No INSERT, UPDATE or DELETE. Atomic, for 0261's
-- reason: dropping a CHECK before its successor exists would, for that moment, allow a delivery that names nothing.
-- The file has its own BEGIN/COMMIT, so an interrupted apply leaves nothing behind and can simply be run again.

BEGIN;

ALTER TABLE "watch_delivery"
  ADD COLUMN "owner_request_id" UUID,
  ADD CONSTRAINT "watch_delivery_owner_request_fkey" FOREIGN KEY ("owner_request_id") REFERENCES "owner_request"("id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  DROP CONSTRAINT "watch_delivery_kind_chk",
  DROP CONSTRAINT "watch_delivery_kind_shape_chk",
  ADD CONSTRAINT "watch_delivery_kind_chk" CHECK ("kind" IN ('MATCH', 'EXPIRY', 'REVOKED', 'UNRESOLVABLE', 'OWNER_REQUEST')),
  -- As in 0261, every operand is NOT NULL or an IS test, so this expression is never NULL: a CHECK whose result is NULL
  -- passes.
  ADD CONSTRAINT "watch_delivery_kind_shape_chk" CHECK (
    ("kind" = 'MATCH' AND "match_id" IS NOT NULL AND "watch_id" IS NULL AND "expiry_snapshot" IS NULL)
    OR ("kind" = 'EXPIRY' AND "match_id" IS NULL AND "watch_id" IS NOT NULL
        AND "action" = 'RESUME_SESSION'
        AND "expiry_snapshot" IS NOT NULL AND jsonb_typeof("expiry_snapshot") = 'object')
    OR ("kind" IN ('REVOKED', 'UNRESOLVABLE') AND "match_id" IS NULL AND "watch_id" IS NOT NULL
        AND "action" = 'RESUME_SESSION' AND "expiry_snapshot" IS NULL)
    OR ("kind" = 'OWNER_REQUEST' AND "match_id" IS NULL AND "watch_id" IS NULL
        AND "action" = 'RESUME_SESSION' AND "expiry_snapshot" IS NULL)),
  ADD CONSTRAINT "watch_delivery_owner_request_chk" CHECK (("kind" = 'OWNER_REQUEST') = ("owner_request_id" IS NOT NULL));

CREATE UNIQUE INDEX "watch_delivery_owner_request_key"
  ON "watch_delivery" ("owner_request_id") WHERE "owner_request_id" IS NOT NULL;

COMMIT;
