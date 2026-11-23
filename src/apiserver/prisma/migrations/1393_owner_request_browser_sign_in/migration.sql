-- 1393: an owner request kind BROWSER_SIGN_IN — an agent on the account's Orbit Cloud runner asking the owner to sign in
-- to a site in that runner's shared browser (browser_request_sign_in; docs/mocks/runner-browser/03-agent-tools.html ①,
-- project 350APJYncG4Ssfwaeehyt).
--
--   owner_request.browser_site       BROWSER_SIGN_IN: the site the agent named, as it named it (a host). Nothing else of
--                                    the browser is stored: no page, no cookie, no login state. NULL for every other kind.
--   owner_request.browser_runner_id  BROWSER_SIGN_IN: the Orbit Cloud runner whose browser the owner signs in on, which
--                                    the card's Open browser opens (/runners/:id/browser). History, no foreign key.
--
-- The kind check restates 1273's (SETTINGS_CHANGE) with BROWSER_SIGN_IN added. A constraint swap, two nullable
-- columns and one CHECK: no row is written, no trigger or function is named. Every statement can run twice.
ALTER TABLE "owner_request" ADD COLUMN IF NOT EXISTS "browser_site" TEXT;
ALTER TABLE "owner_request" ADD COLUMN IF NOT EXISTS "browser_runner_id" UUID;

ALTER TABLE "owner_request" DROP CONSTRAINT IF EXISTS "owner_request_kind_chk";
ALTER TABLE "owner_request" ADD CONSTRAINT "owner_request_kind_chk"
  CHECK ("kind" IN ('DECISION', 'SECRET', 'MANUAL_STEP', 'CONFIRM', 'WIKI_CREATE',
                    'SCHEDULE_FAILED', 'SCHEDULE_HELD', 'SCHEDULE_APPROVAL', 'SCHEDULE_WIDEN',
                    'CONDITION_UNKNOWN', 'CONDITION_STILL_WAITING', 'SETTINGS_CHANGE', 'BROWSER_SIGN_IN'));
ALTER TABLE "owner_request" DROP CONSTRAINT IF EXISTS "owner_request_browser_sign_in_chk";
ALTER TABLE "owner_request" ADD CONSTRAINT "owner_request_browser_sign_in_chk"
  CHECK (("kind" = 'BROWSER_SIGN_IN') = ("browser_site" IS NOT NULL AND "browser_runner_id" IS NOT NULL));
