-- 0366 — a ChatGPT account of a Codex pool belongs to a PERSON of the pool, not only to its owner
-- (docs/codex-shared-pool-design.md D10, 2026-10-03): the pool owner asked that a person a pool is shared
-- with may sign in with their own ChatGPT account and add it, so its accounts stop being the owner's
-- alone. The 2026-10-02 rule this replaces — "a ChatGPT account runs its owner's sessions, and since D9
-- every member's" — kept the rows themselves owner-bound; now anyone in the pool may hold one.
--
-- WHAT IT CHANGES
-- ===============
--   * `pool_codex_login`'s composite fence moves from the pool's owner to a person of the pool:
--     (pool_id, user_id) → provider_pool_person(pool_id, user_id) ON DELETE CASCADE ON UPDATE NO ACTION,
--     the very fence `pool_api_key`'s contributor and `pool_gateway_token`'s person already use. A login
--     whose `user_id` is not in the pool cannot be inserted at all, and a person leaving the pool takes
--     the logins they signed in with them, in the same statement — as their keys and tokens go.
--   * `provider_pool` gains `members_can_add_accounts` (BOOLEAN NOT NULL DEFAULT true): a member may sign
--     a ChatGPT account of their own into the pool while it is set, an admin always may. It is the
--     account-side twin of 0321's `members_can_add`, which keeps governing keys alone; both default true,
--     and the constant default makes the new column catalog-only.
--
-- WHY IT IS SAFE ON THE ROWS THAT EXIST
-- =====================================
-- Every stored `pool_codex_login` row was written by the sign-in flow, which resolved the pool by
-- (id, ownerId) — so every one of them names its pool's owner. Since 0358 every Codex pool has its
-- owner's `provider_pool_person` row (that migration inserted one for each pool of one's own, and
-- SharedPoolsService.createPool/ProvidersService.createPool write it for the ones made since; a shared
-- pool has had its creator's row since 0321). So the new foreign key admits every stored row as it
-- stands, and no row is read, rewritten or backfilled.
--
-- WHAT IS NOT TOUCHED
-- ===================
-- 0324's (pool_id, user_id) → provider_pool(id, owner_id) on `pool_login_token` stands exactly as it is:
-- a login pool's session token is still minted for the pool's owner alone, and a member's session keeps
-- its person's token (`pool_gateway_token`) whichever account it runs on. Every other key, constraint,
-- index, column and table is left as it stands; no function, trigger, type or enum is created, replaced
-- or dropped; and no row of any table is inserted, updated or deleted — the fence is swapped and the
-- column added, both catalog-only.

BEGIN;

-- AlterTable: the login belongs to a person of the pool (the fence `pool_api_key` already uses), not to
-- its owner alone.
ALTER TABLE "pool_codex_login" DROP CONSTRAINT "pool_codex_login_pool_id_user_id_fkey";

ALTER TABLE "pool_codex_login" ADD CONSTRAINT "pool_codex_login_pool_id_user_id_fkey"
  FOREIGN KEY ("pool_id", "user_id") REFERENCES "provider_pool_person"("pool_id", "user_id")
  ON DELETE CASCADE ON UPDATE NO ACTION;

-- AlterTable: the rule that lets a member sign a ChatGPT account of their own in. Constant default, so
-- every stored pool reads true without a rewrite.
ALTER TABLE "provider_pool" ADD COLUMN "members_can_add_accounts" BOOLEAN NOT NULL DEFAULT true;

COMMIT;
