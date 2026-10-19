-- Provider/engine split, step two: retired provider names (docs/provider-engine-contract.md §1.5, §5.5).
--
-- A `deepseek-harness` row is a DeepSeek key that ran on one engine. The split folds each one into a
-- DeepSeek key — merged into the owner's identical key, or converted where it stands under a slug of
-- its own (T4's application-layer migration writes the rows) — and the slug it had stays a name for
-- that key on DeepSeek Harness, so a caller that still names it (an older client, the CLI, a frozen
-- run receipt) gets exactly what it got before. This table holds those names. Nothing lists them:
-- whatever stores a provider stores the key's own slug, and an alias only exists to be resolved.
--
--   * `provider_id` — the key the name now resolves to. Deleting the key deletes its names
--     (ON DELETE CASCADE), which frees each slug as deleting any key frees its own.
--   * `engine`      — the engine the old slug ran on, which a caller naming only the slug gets. Only
--     DeepSeek Harness rows are retired here, so only `dsh`; a later retirement can widen the CHECK.
--   * `reason`      — MERGED (the row was merged into another key and deleted) or RENAMED (it became
--     a DeepSeek key in place and took another slug).
--
-- A retired name is still a name in the one dispatch namespace 0265 keeps across `model_provider` and
-- `provider_pool`: a key or a pool created under it would make the slug resolve to two things. So the
-- guard 0265 installed reads three tables now, and fires on this one too. Its advisory lock is keyed by
-- the slug alone, as before, so writers of one slug in any two of the three tables still run one after
-- the other; the refusal is still the unique_violation naming `provider_dispatch_slug_key` that reaches
-- Prisma as P2002, which ProvidersService already re-picks a slug on.
--
-- The DeepSeek Harness acquisition guard (0414) accepts a session recorded on `dsh` whose credential is
-- an enabled key; a session can also name that key by a retired name (one written in the moment between
-- a rewrite and its alias, or by an older replica), so the guard follows an alias to its key too.
--
-- 0415: the highest number on main, every project/* and pushed orbit/* branch and every session
-- worktree was 0414 (0414_session_engine) when this was written (2026-10-09).
BEGIN;

CREATE TABLE "provider_slug_alias" (
  "slug"        TEXT NOT NULL,
  "provider_id" UUID NOT NULL,
  "engine"      TEXT NOT NULL,
  "reason"      TEXT NOT NULL,
  "created_at"  TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "provider_slug_alias_pkey" PRIMARY KEY ("slug"),
  CONSTRAINT "provider_slug_alias_engine_check" CHECK ("engine" = 'dsh'),
  CONSTRAINT "provider_slug_alias_reason_check" CHECK ("reason" IN ('MERGED', 'RENAMED'))
);

CREATE INDEX "provider_slug_alias_provider_id_idx" ON "provider_slug_alias" ("provider_id");

ALTER TABLE "provider_slug_alias" ADD CONSTRAINT "provider_slug_alias_provider_id_fkey"
  FOREIGN KEY ("provider_id") REFERENCES "model_provider"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- One slug namespace across `model_provider`, `provider_pool` and `provider_slug_alias` (see the header
-- and 0265's). Each table's own unique key covers a collision inside it; this covers the ones across.
CREATE OR REPLACE FUNCTION "provider_dispatch_slug_guard"() RETURNS trigger AS $$
DECLARE
  holder text;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('provider-dispatch-slug:' || NEW."slug", 0));
  IF TG_TABLE_NAME <> 'model_provider' AND EXISTS (SELECT 1 FROM "model_provider" WHERE "slug" = NEW."slug") THEN
    holder := 'a provider';
  ELSIF TG_TABLE_NAME <> 'provider_pool' AND EXISTS (SELECT 1 FROM "provider_pool" WHERE "slug" = NEW."slug") THEN
    holder := 'an account pool';
  ELSIF TG_TABLE_NAME <> 'provider_slug_alias' AND EXISTS (SELECT 1 FROM "provider_slug_alias" WHERE "slug" = NEW."slug") THEN
    holder := 'a retired provider name';
  END IF;
  IF holder IS NOT NULL THEN
    RAISE EXCEPTION 'dispatch slug "%" is already taken by %', NEW."slug", holder
      USING ERRCODE = 'unique_violation', CONSTRAINT = 'provider_dispatch_slug_key';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "provider_slug_alias_dispatch_slug_guard"
  BEFORE INSERT OR UPDATE OF "slug" ON "provider_slug_alias"
  FOR EACH ROW EXECUTE FUNCTION "provider_dispatch_slug_guard"();

-- 0414's guard, unchanged but for one clause: a session recorded on `dsh` may also be acquired on an
-- enabled key it names by a retired name.
CREATE OR REPLACE FUNCTION guard_dsh_runner_acquisition()
RETURNS trigger AS $$
BEGIN
    IF (
           (OLD."status" = 'PENDING' AND NEW."status" = 'RUNNING')
           OR (NEW."inbox_lease_owner" IS NOT NULL
               AND NEW."inbox_lease_owner" IS DISTINCT FROM OLD."inbox_lease_owner"
               -- A server terminal revive reserves a v5 handoff marker while queuing; it is
               -- not a runner process acquiring the runtime. The actual claim/takeover still
               -- passes every gate when it replaces this marker with the runner's v4 owner.
               AND NOT (OLD."status" IN ('SUCCEEDED', 'FAILED', 'CANCELLED')
                        AND NEW."status" = 'PENDING'
                        AND substring(NEW."inbox_lease_owner"::text, 15, 1) = '5'))
           OR (NEW."inbox_lease_generation" IS NOT NULL
               AND NEW."inbox_lease_generation" IS DISTINCT FROM OLD."inbox_lease_generation")
       )
       AND (
           NEW."engine" = 'dsh'
           OR (NEW."engine" IS NULL AND (
               (NEW."provider" = 'dsh' AND NEW."provider_builtin")
               OR (NOT NEW."provider_builtin" AND EXISTS (
                   SELECT 1 FROM "model_provider" mp
                   WHERE mp."slug" = NEW."provider"
                     AND mp."runtime" = 'dsh'
                     AND (mp."owner_id" IS NULL OR mp."owner_id" = NEW."owner_id")
               ))
           ))
       ) THEN
        IF COALESCE(current_setting('orbit.runner_supports_dsh', true), '0') <> '1' THEN
            RETURN NULL;
        END IF;
        IF NEW."engine" IS NULL THEN
            IF NOT NEW."provider_builtin" AND NOT EXISTS (
                SELECT 1 FROM "model_provider" mp
                WHERE mp."slug" = NEW."provider" AND mp."runtime" = 'dsh' AND mp."enabled"
                  AND (mp."owner_id" IS NULL OR mp."owner_id" = NEW."owner_id")
            ) THEN
                RETURN NULL;
            END IF;
        ELSIF NOT (NEW."provider" = 'dsh' AND NEW."provider_builtin") AND NOT EXISTS (
            SELECT 1 FROM "model_provider" mp
            WHERE mp."slug" = NEW."provider" AND mp."enabled"
              AND (mp."owner_id" IS NULL OR mp."owner_id" = NEW."owner_id")
        ) AND NOT EXISTS (
            SELECT 1 FROM "provider_slug_alias" a
            JOIN "model_provider" mp ON mp."id" = a."provider_id"
            WHERE a."slug" = NEW."provider" AND mp."enabled"
              AND (mp."owner_id" IS NULL OR mp."owner_id" = NEW."owner_id")
        ) THEN
            RETURN NULL;
        END IF;
        -- Keep the heartbeat declaration true through acquisition commit. The Session row is
        -- already locked, so never wait in the reverse runner -> session deletion order: a
        -- heartbeat/delete holding the runner makes this attempt skip and the poll retry.
        BEGIN
            PERFORM 1 FROM "runner" r
            WHERE r."id" = NEW."assigned_runner_id"
              AND r."owner_id" = NEW."owner_id"
              AND r."capabilities_reported_at" IS NOT NULL
              AND 'provider:dsh' = ANY(r."capabilities")
            FOR SHARE NOWAIT;
            IF NOT FOUND THEN RETURN NULL; END IF;
        EXCEPTION WHEN lock_not_available THEN
            RETURN NULL;
        END;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

COMMIT;
