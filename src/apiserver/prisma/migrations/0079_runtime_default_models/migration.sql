BEGIN;

-- Freeze old-replica Agent/Session writes while the inheritance snapshot and nullability change
-- are applied. Once the lock is acquired, every pre-migration write is visible to the backfill;
-- writes released after COMMIT are covered by the resolver's rolling-compatibility fallback.
LOCK TABLE "agent", "session" IN SHARE ROW EXCLUSIVE MODE;

-- Old replicas omit this column and therefore retain false. New code writes true explicitly when
-- it creates a Session, giving the resolver a durable two-generation fence for post-COMMIT writes.
ALTER TABLE "session"
  ADD COLUMN "uses_runtime_default_model" BOOLEAN NOT NULL DEFAULT false;

-- Preserve the model that every existing session inherited from its agent before new defaults
-- come from Runtime heartbeat data. Once materialized, reclaiming that session cannot drift when
-- the Runtime reports a different default later.
UPDATE "session" AS s
SET "model" = btrim(a."model")
FROM "agent" AS a
WHERE s."agent_id" = a."id"
  AND (s."model" IS NULL OR btrim(s."model") = '')
  AND a."model" IS NOT NULL
  AND btrim(a."model") <> '';

-- A legacy session without an Agent (or with a degenerate blank Agent.model) previously fell
-- through to the server's built-in static default. Materialize that behavior too, so reclaiming
-- it after a Runtime heartbeat arrives cannot silently move an existing conversation. Unknown
-- configured-provider slugs stay null: their ModelProvider row remains the authoritative fallback.
UPDATE "session" AS s
SET "model" = CASE
  WHEN s."provider" = 'codex' THEN 'gpt-5.6-sol'
  WHEN s."provider" = 'kimi' AND s."provider_builtin" = true
    THEN 'kimi-code/kimi-for-coding'
  ELSE 'claude-opus-5'
END
WHERE (s."model" IS NULL OR btrim(s."model") = '')
  AND (
    s."provider" IN ('claude', 'codex')
    OR (s."provider" = 'kimi' AND s."provider_builtin" = true)
  );

-- Cache the effective defaults reported by local runtimes separately from their model catalogs.
-- NULL is retained at rest for rolling compatibility with runners that do not report defaults.
ALTER TABLE "runner" ADD COLUMN "runtime_default_models" JSONB;

-- Agent.model is a rolling-deploy compatibility field after this migration. New code never writes
-- it, but the resolver can bridge a model-less Session from an old replica and claim then snapshots
-- that value onto Session.model. Older rows remain until every old replica has been retired.
ALTER TABLE "agent" ALTER COLUMN "model" DROP DEFAULT;
ALTER TABLE "agent" ALTER COLUMN "model" DROP NOT NULL;

COMMIT;
