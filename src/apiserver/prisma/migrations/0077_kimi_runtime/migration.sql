-- `kimi` used to be the slug of the Moonshot configured-provider preset. It is now the
-- first-class Kimi runtime wire id, so preserve existing provider rows under the first free
-- Moonshot-derived slug before the application starts treating `kimi` as built in.

BEGIN;

-- Serialize both provider creation and old-version Agent/Session writes for the duration of the
-- lookup, reference move, and rename. This also keeps a rolling deployment from inserting a new
-- `provider = 'kimi'` reference after the UPDATEs but before the slug becomes a built-in runtime.
LOCK TABLE "model_provider", "agent", "session" IN SHARE ROW EXCLUSIVE MODE;

-- New code marks first-class provider identities explicitly. The false default is a rolling-
-- deploy fence: an old API replica that still writes the former custom slug `kimi` cannot make
-- that row become a first-class runtime accidentally.
ALTER TABLE "agent" ADD COLUMN "provider_builtin" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "session" ADD COLUMN "provider_builtin" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "session" ADD COLUMN "inbox_lease_generation" UUID;
ALTER TABLE "session" ADD COLUMN "inbox_lease_owner" UUID;
UPDATE "agent" SET "provider_builtin" = true WHERE "provider" IN ('claude', 'codex');
UPDATE "session" SET "provider_builtin" = true WHERE "provider" IN ('claude', 'codex');

-- Fence per-engine inbox releases so an old ACP/CLI poll cannot re-lease a turn
-- after its replacement has already acquired a fresh generation.
ALTER TABLE "conversation_turn" ADD COLUMN "lease_generation" UUID;

-- Generation rows are durable tombstones: release may arrive before a delayed activate, and the
-- later request must still be unable to resurrect that engine. `lease_owner` identifies one
-- runner process so a timed-out/retried reclaim cannot retire engines started by its own retry.
CREATE TABLE "inbox_lease_generation" (
  "generation" UUID NOT NULL,
  "session_id" UUID NOT NULL,
  "lease_owner" UUID,
  "activated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "retired_at" TIMESTAMP(3),
  CONSTRAINT "inbox_lease_generation_pkey" PRIMARY KEY ("generation")
);
CREATE INDEX "inbox_lease_generation_session_id_idx"
  ON "inbox_lease_generation"("session_id");
ALTER TABLE "inbox_lease_generation"
  ADD CONSTRAINT "inbox_lease_generation_session_id_fkey"
  FOREIGN KEY ("session_id") REFERENCES "session"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- This marker cannot be produced by provider-slug normalization. If a manually-created legacy
-- row nevertheless used it, move that configured provider and all its references first.
DO $$
DECLARE
  reserved_slug TEXT := '__orbit_reserved_legacy_kimi_0077__';
  target_slug TEXT := 'legacy-kimi-orphaned';
  suffix INTEGER := 2;
BEGIN
  IF EXISTS (SELECT 1 FROM "model_provider" WHERE "slug" = reserved_slug) THEN
    WHILE EXISTS (SELECT 1 FROM "model_provider" WHERE "slug" = target_slug) LOOP
      target_slug := 'legacy-kimi-orphaned-' || suffix;
      suffix := suffix + 1;
    END LOOP;
    UPDATE "agent" SET "provider" = target_slug WHERE "provider" = reserved_slug;
    UPDATE "session" SET "provider" = target_slug WHERE "provider" = reserved_slug;
    UPDATE "model_provider" SET "slug" = target_slug WHERE "slug" = reserved_slug;
  END IF;
END $$;

-- The preset identity is independent of each row's unique deployment-wide slug.
UPDATE "model_provider"
SET "preset_slug" = 'moonshot'
WHERE "preset_slug" = 'kimi';

DO $$
DECLARE
  target_slug TEXT := 'moonshot';
  suffix INTEGER := 2;
BEGIN
  IF EXISTS (SELECT 1 FROM "model_provider" WHERE "slug" = 'kimi') THEN
    WHILE EXISTS (SELECT 1 FROM "model_provider" WHERE "slug" = target_slug) LOOP
      target_slug := 'moonshot-' || suffix;
      suffix := suffix + 1;
    END LOOP;

    -- Agent/Session.provider intentionally have no foreign key. Move every reference before
    -- renaming the provider row so persisted sessions keep dispatching through the same config.
    UPDATE "agent" SET "provider" = target_slug WHERE "provider" = 'kimi';
    UPDATE "session" SET "provider" = target_slug WHERE "provider" = 'kimi';
    UPDATE "model_provider" SET "slug" = target_slug WHERE "slug" = 'kimi';
  ELSE
    -- Provider deletion intentionally leaves Agent/Session references behind. Preserve those
    -- historical orphans as an unknown custom identity (which keeps the old Claude fallback)
    -- instead of silently reinterpreting them as the new first-class Kimi runtime.
    UPDATE "agent" SET "provider" = '__orbit_reserved_legacy_kimi_0077__' WHERE "provider" = 'kimi';
    UPDATE "session" SET "provider" = '__orbit_reserved_legacy_kimi_0077__' WHERE "provider" = 'kimi';
  END IF;
END $$;

-- Reserve both the built-in wire id and the orphan tombstone at the database boundary. This
-- makes a stale replica's attempt to recreate the old custom provider fail safely after commit.
ALTER TABLE "model_provider"
  ADD CONSTRAINT "model_provider_slug_not_reserved_kimi"
  CHECK ("slug" NOT IN ('kimi', '__orbit_reserved_legacy_kimi_0077__'));

COMMIT;
