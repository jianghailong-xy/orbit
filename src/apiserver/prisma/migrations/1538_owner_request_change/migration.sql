-- 1538: an owner request kind CHANGE — an agent proposes one setting of one of the owner's runners, and the owner applies
-- it with one press (docs/design/owner-request-change.md §6, project 34x9XC3FVT1DO5WNDoO2u). v1 covers a runner's
-- Max Concurrent only.
--
--   owner_request.change_spec  CHANGE: `{ runnerId, field, requested, before }`, written by the server when the request is
--                              filed (`before` is the runner's value then, read by the server). NULL for every other kind.
--                              History: the runner is not a foreign key, and a runner deleted while the request waits
--                              leaves it for the owner to decline.
--
-- One pending change per runner setting: `owner_request_change_pending_key` holds an owner to one PENDING CHANGE per
-- (runner, field), so two filings that race cannot both stay pending — the second's INSERT waits for the first and is
-- refused on the key once it commits, and the filing door runs again and withdraws the first.
--
-- The kind check restates 1393's (BROWSER_SIGN_IN) with CHANGE added. A constraint swap, one nullable column, one CHECK
-- and one partial unique index on a column no row has yet: no row is written, no trigger or function is named. Every
-- statement can run twice.
ALTER TABLE "owner_request" ADD COLUMN IF NOT EXISTS "change_spec" JSONB;

ALTER TABLE "owner_request" DROP CONSTRAINT IF EXISTS "owner_request_kind_chk";
ALTER TABLE "owner_request" ADD CONSTRAINT "owner_request_kind_chk"
  CHECK ("kind" IN ('DECISION', 'SECRET', 'MANUAL_STEP', 'CONFIRM', 'WIKI_CREATE',
                    'SCHEDULE_FAILED', 'SCHEDULE_HELD', 'SCHEDULE_APPROVAL', 'SCHEDULE_WIDEN',
                    'CONDITION_UNKNOWN', 'CONDITION_STILL_WAITING', 'SETTINGS_CHANGE', 'BROWSER_SIGN_IN', 'CHANGE'));
ALTER TABLE "owner_request" DROP CONSTRAINT IF EXISTS "owner_request_change_spec_chk";
ALTER TABLE "owner_request" ADD CONSTRAINT "owner_request_change_spec_chk"
  CHECK (("kind" = 'CHANGE') = ("change_spec" IS NOT NULL));

CREATE UNIQUE INDEX IF NOT EXISTS "owner_request_change_pending_key"
  ON "owner_request" ("owner_id", ("change_spec"->>'runnerId'), ("change_spec"->>'field'))
  WHERE "state" = 'PENDING' AND "kind" = 'CHANGE';
