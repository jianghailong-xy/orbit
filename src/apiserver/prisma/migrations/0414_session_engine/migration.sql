-- Provider/engine split, step one (docs/provider-engine-contract.md §1.1, §1.2, §5, §7.1).
--
-- Until now a session's engine — the CLI on the runner that produced its runtimeSessionId — was
-- never stored: every door derived it from the provider slug, the configured key's `runtime` column
-- and the account pool's engine. So editing a key's runtime moved its open sessions onto another CLI,
-- and disabling or deleting a key made every door that asked read them as Claude. This migration
-- records the engine on the session (and the engine pin on the task), fills both in for every row
-- that exists, and makes the database refuse to let any write change a recorded engine.
--
-- It also makes an older API replica — which reads no engine and derives one from the slug — unable
-- to claim or take over a session whose engine is recorded: such a replica could run a DeepSeek
-- Harness session on a DeepSeek key as Claude. New code declares, inside every claim and lease
-- transaction, that it reads the session's engine (`orbit.claim_reads_session_engine`); a
-- transaction that does not is refused (§5.2). The three runtime claim guards (0080, 0372/0377) now
-- gate on the recorded engine too, and keep their old predicates for a row that has none (§5.5).
--
-- Forward only: an apiserver image older than this one never makes that declaration, so rolling back
-- the image leaves every session unclaimable. down.sql beside this file is what to run first.
BEGIN;

-- ---------------------------------------------------------------------------------------------
-- 1. The columns (§1.1, §1.2). TEXT like every provider/engine column here, held to the six engines.
-- ---------------------------------------------------------------------------------------------
ALTER TABLE "session" ADD COLUMN "engine" TEXT;
ALTER TABLE "session" ADD CONSTRAINT "session_engine_check"
  CHECK ("engine" IS NULL OR "engine" IN ('claude', 'codex', 'kimi', 'antigravity', 'opencode', 'dsh'));

ALTER TABLE "task" ADD COLUMN "engine" TEXT;
ALTER TABLE "task" ADD CONSTRAINT "task_engine_check"
  CHECK ("engine" IS NULL OR "engine" IN ('claude', 'codex', 'kimi', 'antigravity', 'opencode', 'dsh'));

-- A session's engine never changes once recorded; changing engine is a new session. Writing a value
-- into NULL is allowed: this backfill, and a new replica recording what it derived for a row an older
-- one wrote (QueueService.trySessionClaim).
CREATE OR REPLACE FUNCTION session_engine_immutable()
RETURNS trigger AS $$
BEGIN
  IF OLD."engine" IS NOT NULL AND NEW."engine" IS DISTINCT FROM OLD."engine" THEN
    RAISE EXCEPTION 'session % runs on %, and a session''s engine never changes', OLD."id", OLD."engine"
      USING ERRCODE = 'check_violation', CONSTRAINT = 'session_engine_immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER session_engine_immutable
BEFORE UPDATE OF "engine" ON "session"
FOR EACH ROW EXECUTE FUNCTION session_engine_immutable();

-- ---------------------------------------------------------------------------------------------
-- 2. Backfill Session.engine (§7.1): the engine that actually produced the runtimeSessionId.
-- ---------------------------------------------------------------------------------------------
-- Built-in slugs name their engine. `kimi` and `dsh` do only when the row says it is the built-in one
-- (0077 and 0377 kept configured identities of those names); an empty provider is the column default.
UPDATE "session"
SET "engine" = CASE WHEN "provider" = '' THEN 'claude' ELSE "provider" END
WHERE "engine" IS NULL
  AND (
    "provider" IN ('claude', 'codex', 'opencode', 'antigravity', '')
    OR ("provider" IN ('kimi', 'dsh') AND "provider_builtin")
  );

-- Everything else names a key, an account pool, or something that is gone.
--   * A key of the session's owner, or a shared one — disabled or not, reachable by the owner or not:
--     its row's runtime. A key's runtime could be edited between claude, codex, kimi and antigravity,
--     so for a session that already ran, the runtime's own init event wins over the row: it is the
--     engine that minted the id.
--   * An account pool: the engine it was made on.
--   * Nothing (the key was deleted): the init event, as above.
-- The init event is the latest `system` event whose subtype is `init` or `resumed` and whose
-- sessionId is the session's runtime id. Every engine but Claude Code names itself in it; Claude
-- Code's carries no provider (runner-go claude.go), so an event without one is Claude. Whatever is
-- still unknown stays NULL: a session nobody can place is not guessed at (§7.1 UNRESOLVED).
WITH "derived" AS (
  SELECT s."id",
    CASE
      WHEN "key"."runtime" IS NOT NULL THEN COALESCE("init"."engine",
        CASE WHEN "key"."runtime" IN ('claude', 'codex', 'kimi', 'antigravity', 'dsh') THEN "key"."runtime" END)
      WHEN "pool"."engine" IS NOT NULL THEN "pool"."engine"
      ELSE "init"."engine"
    END AS "engine"
  FROM "session" s
  LEFT JOIN LATERAL (
    SELECT mp."runtime" FROM "model_provider" mp
    WHERE mp."slug" = s."provider" AND (mp."owner_id" = s."owner_id" OR mp."owner_id" IS NULL)
    LIMIT 1
  ) "key" ON true
  LEFT JOIN LATERAL (
    SELECT CASE WHEN pp."engine" = 'codex' THEN 'codex' ELSE 'claude' END AS "engine"
    FROM "provider_pool" pp WHERE pp."slug" = s."provider"
    LIMIT 1
  ) "pool" ON true
  LEFT JOIN LATERAL (
    SELECT CASE
      WHEN COALESCE(e."payload"->>'provider', 'claude') IN ('claude', 'codex', 'kimi', 'antigravity', 'opencode', 'dsh')
        THEN COALESCE(e."payload"->>'provider', 'claude')
    END AS "engine"
    FROM "run_event" e
    WHERE e."session_id" = s."id"
      AND e."type" = 'system'
      AND e."payload"->>'subtype' IN ('init', 'resumed')
      AND e."payload"->>'sessionId' = s."runtime_session_id"
    ORDER BY e."seq" DESC
    LIMIT 1
  ) "init" ON s."runtime_session_id" IS NOT NULL
  WHERE s."engine" IS NULL
)
UPDATE "session" s
SET "engine" = d."engine"
FROM "derived" d
WHERE s."id" = d."id" AND d."engine" IS NOT NULL;

-- ---------------------------------------------------------------------------------------------
-- 3. Backfill Task.engine (§7.1): the engine the task's provider pin dispatches on today, so a pinned
-- task means exactly what it meant before. Only pinned tasks: an unpinned one follows its workspace.
-- ---------------------------------------------------------------------------------------------
-- The slug is classified the way a session is created from it (SessionsService.create): a named
-- built-in engine is itself, `kimi` without looking for a configured row, while `dsh` is a configured
-- key or a pool of that name before it is the built-in engine (0377 kept both).
WITH "derived" AS (
  SELECT t."id",
    CASE
      WHEN t."provider" IN ('claude', 'codex', 'opencode', 'antigravity', 'kimi') THEN t."provider"
      WHEN "key"."runtime" IS NOT NULL THEN
        CASE WHEN "key"."runtime" IN ('claude', 'codex', 'kimi', 'antigravity', 'dsh') THEN "key"."runtime" END
      WHEN "pool"."engine" IS NOT NULL THEN "pool"."engine"
      WHEN t."provider" = 'dsh' THEN 'dsh'
    END AS "engine"
  FROM "task" t
  LEFT JOIN LATERAL (
    SELECT mp."runtime" FROM "model_provider" mp
    WHERE mp."slug" = t."provider" AND (mp."owner_id" = t."owner_id" OR mp."owner_id" IS NULL)
    LIMIT 1
  ) "key" ON true
  LEFT JOIN LATERAL (
    SELECT CASE WHEN pp."engine" = 'codex' THEN 'codex' ELSE 'claude' END AS "engine"
    FROM "provider_pool" pp WHERE pp."slug" = t."provider"
    LIMIT 1
  ) "pool" ON true
  WHERE t."engine" IS NULL AND t."provider" IS NOT NULL
)
UPDATE "task" t
SET "engine" = d."engine"
FROM "derived" d
WHERE t."id" = d."id" AND d."engine" IS NOT NULL;

-- ---------------------------------------------------------------------------------------------
-- 4. The runtime claim guards read the recorded engine (§5.5). Each keeps its predicate for a row
-- with no engine — written by an older replica — which IS the old rule, and its trigger and `UPDATE
-- OF` columns are unchanged.
-- ---------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION guard_opencode_runner_claim()
RETURNS trigger AS $$
BEGIN
    IF OLD."status" = 'PENDING'
       AND NEW."status" = 'RUNNING'
       AND (NEW."engine" = 'opencode' OR (NEW."engine" IS NULL AND NEW."provider" = 'opencode'))
       AND COALESCE(current_setting('orbit.runner_supports_opencode', true), '0') <> '1' THEN
        RETURN NULL;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION guard_antigravity_runner_claim()
RETURNS trigger AS $$
BEGIN
    IF OLD."status" = 'PENDING'
       AND NEW."status" = 'RUNNING'
       AND COALESCE(current_setting('orbit.runner_supports_antigravity', true), '0') <> '1'
       AND (
           NEW."engine" = 'antigravity'
           OR (NEW."engine" IS NULL AND (
               NEW."provider" = 'antigravity'
               OR (NOT (NEW."provider" = 'dsh' AND NEW."provider_builtin") AND EXISTS (
                   SELECT 1 FROM "model_provider" mp
                   WHERE mp."slug" = NEW."provider"
                     AND mp."runtime" = 'antigravity'
                     AND mp."enabled"
                     AND (mp."owner_id" IS NULL OR mp."owner_id" = NEW."owner_id")
               ))
           ))
       ) THEN
        RETURN NULL;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- A DeepSeek Harness session — by its recorded engine, whatever key it spends, or by 0377's rule for
-- a row with none — is acquired only by a transaction that declares the runner can run Harness, on a
-- runner whose persisted heartbeat says so. Its credential has to be one Harness can spend: the
-- built-in `dsh` (whose key is the workspace's own), or an enabled key of the owner's or a shared one.
-- Which keys are DeepSeek keys is the application's to judge (the claim holds the rest, §4.1).
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

-- ---------------------------------------------------------------------------------------------
-- 5. An API replica that does not read the session's engine may not claim or take over a session
-- whose engine is recorded (§5.2).
-- ---------------------------------------------------------------------------------------------
-- INVARIANT: PENDING -> RUNNING, and taking an inbox lease (a new owner or a new generation), on a
-- session with a recorded engine is legal only inside a transaction that ran
--   SELECT set_config('orbit.claim_reads_session_engine', '1', true)
-- which only code that dispatches by Session.engine does (QueueService.trySessionClaim, the runner
-- lease routes; common/session-scheduling.ts lists them). An older replica's claim of such a row is
-- skipped, as 0080 and 0377 skip theirs: its UPDATE ... RETURNING yields nothing, so it sees nothing
-- to claim. A lease write is refused outright: skipping it would let that replica commit the rest of
-- its transaction — retire the generation, expire the in-flight turn, take the approvals — around a
-- row still naming the previous owner, and the runner would let go of a session nobody then holds.
-- The error rolls the whole transaction back; the runner retries until it reaches a current replica.
-- A server terminal revive's v5 marker is not an acquisition, as in 0377. A row without an engine —
-- one an older replica created — stays its to claim: it runs by the rule that wrote it.
CREATE OR REPLACE FUNCTION guard_session_engine_acquisition()
RETURNS trigger AS $$
BEGIN
    IF NEW."engine" IS NULL
       OR COALESCE(current_setting('orbit.claim_reads_session_engine', true), '0') = '1' THEN
        RETURN NEW;
    END IF;
    IF OLD."status" = 'PENDING' AND NEW."status" = 'RUNNING' THEN
        RETURN NULL;
    END IF;
    IF (NEW."inbox_lease_owner" IS NOT NULL
        AND NEW."inbox_lease_owner" IS DISTINCT FROM OLD."inbox_lease_owner"
        AND NOT (OLD."status" IN ('SUCCEEDED', 'FAILED', 'CANCELLED')
                 AND NEW."status" = 'PENDING'
                 AND substring(NEW."inbox_lease_owner"::text, 15, 1) = '5'))
       OR (NEW."inbox_lease_generation" IS NOT NULL
           AND NEW."inbox_lease_generation" IS DISTINCT FROM OLD."inbox_lease_generation") THEN
        RAISE EXCEPTION 'session % runs on %, and this API version does not read session engines; retry against a current replica', NEW."id", NEW."engine"
          USING ERRCODE = 'object_not_in_prerequisite_state';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Named to sort first. A table's BEFORE triggers fire in name order and the first to return NULL
-- ends the row's update, and the dsh guard returns NULL for a lease write it refuses: were it to
-- speak first, an older replica's takeover of a Harness session recorded on a DeepSeek key — which
-- that replica reads as Claude, so it never declares dsh — would be dropped in silence rather than
-- refused here.
CREATE TRIGGER session_acquisition_engine_guard
BEFORE UPDATE OF "status", "inbox_lease_owner", "inbox_lease_generation" ON "session"
FOR EACH ROW EXECUTE FUNCTION guard_session_engine_acquisition();

-- ---------------------------------------------------------------------------------------------
-- 6. A run an older replica creates for a task with an engine pin runs on the pinned engine (§5.7).
-- ---------------------------------------------------------------------------------------------
-- That replica writes no engine and picks the credential by the task's provider pin. When it picked
-- exactly the pinned credential — validated against the pinned engine when the pin was written — the
-- run takes the pinned engine, which also keeps the replica itself from claiming it (§5.2): a current
-- replica runs it on the engine the task asked for. Only a run doing the task's work: a conversation
-- opened from the task's page is the person's, not the pin's.
CREATE OR REPLACE FUNCTION session_engine_from_task_pin()
RETURNS trigger AS $$
DECLARE
    pinned TEXT;
BEGIN
    IF NEW."engine" IS NULL AND NEW."task_id" IS NOT NULL AND NEW."starts_task_work" THEN
        SELECT t."engine" INTO pinned
        FROM "task" t
        WHERE t."id" = NEW."task_id"
          AND t."engine" IS NOT NULL
          AND t."provider" = NEW."provider";
        IF pinned IS NOT NULL THEN
            NEW."engine" := pinned;
        END IF;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER session_engine_from_task_pin
BEFORE INSERT ON "session"
FOR EACH ROW EXECUTE FUNCTION session_engine_from_task_pin();

COMMIT;
