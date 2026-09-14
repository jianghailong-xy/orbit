-- 0265 — account pools: several of one owner's Claude subscription providers, dispatched under a slug
-- of the pool's own.
--
-- WHAT IT ADDS
-- ============
--   * `provider_pool` — one row per pool: its dispatch `slug`, a `label`, and its owner. Always
--     personal (`owner_id` NOT NULL), like every provider allowed into it.
--   * `provider_pool_member` — one row per (pool, provider). It carries `owner_id` and names it in
--     BOTH foreign keys, (pool_id, owner_id) → provider_pool(id, owner_id) and
--     (provider_id, owner_id) → model_provider(id, owner_id). So the database itself refuses a member
--     that belongs to another owner, and refuses a shared provider outright: a shared row's owner_id
--     is NULL, and no member row can carry a NULL owner. The second key needs the (id, owner_id)
--     unique index this adds to `model_provider`; `id` alone is already unique, so every existing row
--     satisfies it.
--   * `provider_dispatch_slug_guard`, fired by `model_provider_dispatch_slug_guard` and
--     `provider_pool_dispatch_slug_guard` (below).
--
-- A POOL ADDS AN IDENTITY AND REMOVES NONE
-- ========================================
-- No `model_provider` column changes: a member keeps its slug, stays listed, and can still be pinned
-- by itself. Deleting a provider deletes its memberships (CASCADE); deleting a pool deletes its
-- memberships and never a provider. The provider key's ON UPDATE CASCADE also means a pooled provider
-- cannot be made shared underneath its pool: the cascade would write NULL into member.owner_id.
--
-- ONE SLUG NAMESPACE ACROSS TWO TABLES
-- ===================================
-- A pool's slug is written into the same Agent/Session.provider a provider's slug is, so the two must
-- never collide: "dispatch-by-slug is never ambiguous" (schema.prisma, on ModelProvider.ownerId) has
-- to stay true with a second table in play. ProvidersService picks a slug free in both tables
-- (provider-slug.ts); each table's own unique index covers a collision inside it; the guard covers the
-- one across them, which no index can. BEFORE INSERT OR UPDATE OF "slug" on either table it takes a
-- transaction-scoped advisory lock on the slug, so two writers of one slug run one after the other
-- whichever table each writes, and then refuses a slug the other table holds. Under READ COMMITTED
-- every statement in the function reads a fresh snapshot, so the writer that waited sees the one that
-- committed. The refusal is a unique_violation (23505) naming `provider_dispatch_slug_key`, which
-- reaches Prisma as P2002 — the answer ProvidersService already re-picks a slug on when two providers
-- race for one.
--
-- The lock is keyed by the slug alone and each row writes one slug, so two transactions can only wait
-- on each other here if each writes two slugs in opposite orders, which no writer does. The guard
-- reads `model_provider` and `provider_pool` and locks no row of either.
--
-- NOT HERE
-- ========
-- Which member a pool dispatches on, and letting a session or task name a pool, belong to the claim
-- wiring: until it lands nothing resolves a pool slug. Admission (only a subscription token on
-- api.anthropic.com may join) needs the decrypted key, so it lives in ProvidersService, reusing
-- plan-usage.ts's test; the database never sees a key.
--
-- No backfill: both tables are new and start empty. BEGIN/COMMIT of its own, as 0259 and 0261 have:
-- the tables, the index and the guard mean nothing apart.

BEGIN;

-- CreateTable
CREATE TABLE "provider_pool" (
    "id" UUID NOT NULL,
    "slug" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "owner_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "provider_pool_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "provider_pool_member" (
    "pool_id" UUID NOT NULL,
    "provider_id" UUID NOT NULL,
    "owner_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "provider_pool_member_pkey" PRIMARY KEY ("pool_id","provider_id")
);

-- CreateIndex
CREATE UNIQUE INDEX "provider_pool_slug_key" ON "provider_pool"("slug");

-- CreateIndex
CREATE INDEX "provider_pool_owner_id_idx" ON "provider_pool"("owner_id");

-- CreateIndex
CREATE UNIQUE INDEX "provider_pool_id_owner_id_key" ON "provider_pool"("id", "owner_id");

-- CreateIndex
CREATE INDEX "provider_pool_member_provider_id_owner_id_idx" ON "provider_pool_member"("provider_id", "owner_id");

-- CreateIndex
CREATE UNIQUE INDEX "model_provider_id_owner_id_key" ON "model_provider"("id", "owner_id");

-- AddForeignKey
ALTER TABLE "provider_pool" ADD CONSTRAINT "provider_pool_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "provider_pool_member" ADD CONSTRAINT "provider_pool_member_pool_id_owner_id_fkey" FOREIGN KEY ("pool_id", "owner_id") REFERENCES "provider_pool"("id", "owner_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "provider_pool_member" ADD CONSTRAINT "provider_pool_member_provider_id_owner_id_fkey" FOREIGN KEY ("provider_id", "owner_id") REFERENCES "model_provider"("id", "owner_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- One slug namespace across `model_provider` and `provider_pool` (see the header).
CREATE FUNCTION "provider_dispatch_slug_guard"() RETURNS trigger AS $$
DECLARE
  holder text;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('provider-dispatch-slug:' || NEW."slug", 0));
  IF TG_TABLE_NAME = 'provider_pool' THEN
    IF EXISTS (SELECT 1 FROM "model_provider" WHERE "slug" = NEW."slug") THEN
      holder := 'a provider';
    END IF;
  ELSIF EXISTS (SELECT 1 FROM "provider_pool" WHERE "slug" = NEW."slug") THEN
    holder := 'an account pool';
  END IF;
  IF holder IS NOT NULL THEN
    RAISE EXCEPTION 'dispatch slug "%" is already taken by %', NEW."slug", holder
      USING ERRCODE = 'unique_violation', CONSTRAINT = 'provider_dispatch_slug_key';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "model_provider_dispatch_slug_guard"
  BEFORE INSERT OR UPDATE OF "slug" ON "model_provider"
  FOR EACH ROW EXECUTE FUNCTION "provider_dispatch_slug_guard"();

CREATE TRIGGER "provider_pool_dispatch_slug_guard"
  BEFORE INSERT OR UPDATE OF "slug" ON "provider_pool"
  FOR EACH ROW EXECUTE FUNCTION "provider_dispatch_slug_guard"();

COMMIT;
