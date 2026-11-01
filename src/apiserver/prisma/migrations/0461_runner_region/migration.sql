-- 0461 — which country a runner's Claude connection to Anthropic comes out in (docs/claude-region-check-contract.md).
--
--   runner.region                     JSONB. The last result of GET /runner/region-check (§3, §4), @orbit/shared
--                                     RunnerRegion: { verdict, country, regionCode, name, viaProxy, decidedAt,
--                                     checkedAt, blockedChecks }. That route is its only writer: a decided result
--                                     (allowed or blocked) replaces the first six, a result that could not decide
--                                     moves checkedAt alone, and blockedChecks counts consecutive blocked results.
--                                     It never holds an address. NULL: no check has decided yet, which gates
--                                     nothing (§5).
--   runner.region_check_requested_at  TIMESTAMP(3). The owner's Check again (POST /runners/:id/region-check, §7):
--                                     the heartbeat hands { requestedAt } to a runner that declares claude-region/v1
--                                     until a check at or after it reaches the route, which clears it. It is not
--                                     part of runner.region, which holds the eight fields above and nothing else.
--                                     NULL: nobody asked.
--
-- Two nullable columns with no default, so both ADDs are catalog-only: no table is rewritten and no row is read,
-- written or backfilled. Every runner reads no region and no request, which gates nothing. No index (the only
-- readers go by primary key), trigger, function or constraint is created, replaced or dropped.
--
-- 0461: the next number free on main and on every ref of this repository (2026-11-01; 0458 is held by another
-- project's branch, 0459 and 0460 are on main). Every statement can run twice.

ALTER TABLE "runner" ADD COLUMN IF NOT EXISTS "region" JSONB;
ALTER TABLE "runner" ADD COLUMN IF NOT EXISTS "region_check_requested_at" TIMESTAMP(3);
