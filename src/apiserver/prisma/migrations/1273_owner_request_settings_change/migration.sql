-- 1273: a sixth filed owner request kind, SETTINGS_CHANGE — an agent proposing a change to the owner's own Settings,
-- which the server writes only when the owner approves the card (docs/settings-from-conversation-design.md §5.1).
--
--   owner_request.payload  SETTINGS_CHANGE: `{ changes: [{ key, from, to, tier }] }`, the value in force when it was
--                          filed and the proposed one, per key. Written by the server, never the agent. NULL for every
--                          other kind.
--   owner_request_settings_change_pending_key  at most one PENDING SETTINGS_CHANGE per asking session: a new filing
--                          withdraws the session's previous card in the transaction that files the new one.
--
-- A kind check widened, one nullable column with no default, a CHECK every stored row passes (none is a
-- SETTINGS_CHANGE, and every other row's payload is NULL) and one partial unique index over no rows: no row is written,
-- no trigger or function is named. Every statement can run twice.
ALTER TABLE "owner_request" ADD COLUMN IF NOT EXISTS "payload" JSONB;

ALTER TABLE "owner_request" DROP CONSTRAINT IF EXISTS "owner_request_kind_chk";
ALTER TABLE "owner_request" ADD CONSTRAINT "owner_request_kind_chk"
  CHECK ("kind" IN ('DECISION', 'SECRET', 'MANUAL_STEP', 'CONFIRM', 'WIKI_CREATE',
                    'SCHEDULE_FAILED', 'SCHEDULE_HELD', 'SCHEDULE_APPROVAL', 'SCHEDULE_WIDEN',
                    'CONDITION_UNKNOWN', 'CONDITION_STILL_WAITING', 'SETTINGS_CHANGE'));
ALTER TABLE "owner_request" DROP CONSTRAINT IF EXISTS "owner_request_settings_change_chk";
ALTER TABLE "owner_request" ADD CONSTRAINT "owner_request_settings_change_chk"
  CHECK (("kind" = 'SETTINGS_CHANGE') = ("payload" IS NOT NULL));

CREATE UNIQUE INDEX IF NOT EXISTS "owner_request_settings_change_pending_key"
  ON "owner_request" ("asked_by_session_id") WHERE "kind" = 'SETTINGS_CHANGE' AND "state" = 'PENDING';
