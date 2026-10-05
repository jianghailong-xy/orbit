-- P1a preserves configured providers and pools already named `dsh`: provider_builtin distinguishes
-- them from the native runtime. Unlike 0080/0367, reserving that slug with a compatibility provider
-- would change those identities. Keep the existing transaction-capability claim barrier instead,
-- and include lease acquisition so an older control plane cannot re-activate a reclaimed session.
BEGIN;

-- 0372 resolves a borrowed Antigravity runtime by slug. A configured `dsh` row can keep that
-- runtime while a native dsh session uses the same keyword: its explicit discriminator wins.
CREATE OR REPLACE FUNCTION guard_antigravity_runner_claim()
RETURNS trigger AS $$
BEGIN
    IF OLD."status" = 'PENDING'
       AND NEW."status" = 'RUNNING'
       AND COALESCE(current_setting('orbit.runner_supports_antigravity', true), '0') <> '1'
       AND (
           NEW."provider" = 'antigravity'
           OR (NOT (NEW."provider" = 'dsh' AND NEW."provider_builtin") AND EXISTS (
               SELECT 1 FROM "model_provider" mp
               WHERE mp."slug" = NEW."provider"
                 AND mp."runtime" = 'antigravity'
                 AND mp."enabled"
                 AND (mp."owner_id" IS NULL OR mp."owner_id" = NEW."owner_id")
           ))
       ) THEN
        RETURN NULL;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- INVARIANT: a PENDING -> RUNNING claim or an inbox lease acquisition on DeepSeek Harness work
-- requires BOTH the current request's transaction-local declaration and the assigned runner's
-- positive heartbeat snapshot. Missing/withdrawn heartbeats cannot be replaced by a stale poll's
-- header. Returning NULL makes legacy UPDATE ... RETURNING yield no claim; clearing a lease is
-- deliberately unaffected so cancellation, release and maintenance still work.
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
           (NEW."provider" = 'dsh' AND NEW."provider_builtin")
           OR (NOT NEW."provider_builtin" AND EXISTS (
               SELECT 1 FROM "model_provider" mp
               WHERE mp."slug" = NEW."provider"
                 AND mp."runtime" = 'dsh'
                 AND (mp."owner_id" IS NULL OR mp."owner_id" = NEW."owner_id")
           ))
       ) THEN
        IF COALESCE(current_setting('orbit.runner_supports_dsh', true), '0') <> '1'
           OR (NOT NEW."provider_builtin" AND NOT EXISTS (
               SELECT 1 FROM "model_provider" mp
               WHERE mp."slug" = NEW."provider" AND mp."runtime" = 'dsh' AND mp."enabled"
                 AND (mp."owner_id" IS NULL OR mp."owner_id" = NEW."owner_id")
           )) THEN
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

CREATE TRIGGER session_dsh_runner_acquisition_guard
BEFORE UPDATE OF "status", "inbox_lease_owner", "inbox_lease_generation" ON "session"
FOR EACH ROW EXECUTE FUNCTION guard_dsh_runner_acquisition();

COMMIT;
