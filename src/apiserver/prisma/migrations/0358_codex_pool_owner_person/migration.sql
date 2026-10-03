-- 0358 — every Codex pool has its owner among its people (the 2026-10-02 direction, "scheme A":
-- docs/mocks/account-pool-access/02-who-can-use-it.png). A pool of one's own ChatGPT accounts (0323) may
-- now take people and organization/project API keys as well, and everybody it takes but its owner runs on
-- those keys alone.
--
-- WHAT IT WRITES
-- ==============
--   * One `provider_pool_person` row, role ADMIN, for the owner of every pool of one's own on Codex
--     (`engine = 'codex' AND NOT shared`) — every pool 0323 made, none of which has one, because nothing
--     wrote one for them. Dated the pool's own `created_at`: the owner has been in it since it was made,
--     and a pool's people are listed oldest first. ON CONFLICT DO NOTHING, so a row already there keeps
--     the role it has. A shared pool (0321) has had its creator's ADMIN row since it was made, and a
--     Claude pool (0265) takes no people at all, so neither is named. A pool made from here on gets the
--     row in the statement that makes it (ProvidersService.createPool).
--
-- WHY THAT ROW
-- ============
-- `provider_pool_person` is what lets a person into a pool: a key's contributor (`pool_api_key`'s
-- composite key), a session token of a person's (`pool_gateway_token`'s), and the doors of the pool page
-- (SharedPoolsService), which find their caller there and answer 404 to anybody they do not find. With the
-- owner's row in place, the owner adds people to their own pool by the email of their Orbit account, and
-- adds and removes API keys, through those same doors under the same rules — and `pool_api_key` and
-- `provider_pool_person` rows sit on a pool beside its `pool_codex_login` rows. Nothing in the schema ever
-- kept them apart (0321's keys reach `provider_pool` by its id alone, with no condition on the pool), so
-- no constraint is added, dropped or changed.
--
-- WHO CAN USE IT: DERIVED FROM THE PEOPLE, AND `shared` KEEPS ITS MEANING
-- ======================================================================
-- Of the two ways the decision could go — derive "Who can use it" from the pool's people, or rewrite what
-- `shared` means — this takes the first:
--   * Who can use a pool is its `provider_pool_person` rows. The owner's alone is "Just me"; any row
--     beside it is "Me and people I add". Taking every other person out is how a pool goes back to Just
--     me, and their keys and session tokens go in the same statement, by the cascades 0321 drew.
--   * `shared` is NOT rewritten, and keeps saying what it always said: the pool was made on the shared
--     pools page (0321) — API keys only, no ChatGPT account in it ever. It is false on every pool of one's
--     own whoever is in it, and an owner's sessions on such a pool run on its ChatGPT accounts first.
-- Why not the other way: a `shared` that tracked whether anybody else is in would store twice what the
-- people rows already say, and every add and every removal would have to keep the two in step; and every
-- reader of `shared` today — the sign-in (CodexLoginService), the owner's pool list and page
-- (ProvidersService), the claim (QueueService.accountPool) — reads `shared` as "no ChatGPT account here",
-- so adding one person would take the owner's own accounts away from their own sessions and their page.
-- Impact: no `provider_pool` row is rewritten, and nothing that reads `shared` reads anything different.
-- What is new is only who may reach a pool of one's own: its owner, as before, and the people its owner
-- added — on its API keys alone. The claim never puts their sessions on a ChatGPT account nor mints them a
-- `pool_login_token` (which names nobody but the owner anyway), and the gateway sends a request on a
-- ChatGPT account only for a session its owner owns.
--
-- WHAT IS NOT TOUCHED
-- ===================
-- The ChatGPT login stays the owner's alone: 0323's (pool_id, user_id) → provider_pool(id, owner_id) on
-- `pool_codex_login` and 0324's on `pool_login_token` stand exactly as they are, and so does every other
-- key, constraint, index, column and table. No function, trigger, type or enum is created, replaced or
-- dropped. The only write is the INSERT below, into `provider_pool_person` alone; no row of any table is
-- updated or deleted.

INSERT INTO "provider_pool_person" ("pool_id", "user_id", "role", "created_at")
SELECT p."id", p."owner_id", 'ADMIN', p."created_at"
  FROM "provider_pool" p
 WHERE p."engine" = 'codex'
   AND NOT p."shared"
ON CONFLICT ("pool_id", "user_id") DO NOTHING;
