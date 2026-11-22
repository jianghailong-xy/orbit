-- ══════════════════════════════════════════════════════════════════════════════════════════════
-- 1424: the revive exemption of the three runner acquisition guards reads the release fact, not the status
-- (docs/session-three-state-plan.md §7 step 4.4, appendix A of docs/session-three-state-read-sites.md; project
-- 3508bDBDE5xPH43TYuiqP).
--
-- WHAT IT CHANGES
-- ---------------
-- Three functions, each replaced with its live body and one line changed, the exemption that lets a server
-- revive (a released session queued again, with a v5 handoff marker as its lease owner) through:
--
--   guard_session_engine_acquisition (0414; trigger session_acquisition_engine_guard)
--   guard_dsh_runner_acquisition     (0415; trigger session_dsh_runner_acquisition_guard)
--   guard_cursor_runner_acquisition  (0426; trigger session_cursor_runner_acquisition_guard)
--     was  AND NOT (OLD."status" IN ('SUCCEEDED', 'FAILED', 'CANCELLED') AND NEW."status" = 'PENDING' AND ...)
--     now  AND NOT (OLD."finished_at" IS NOT NULL AND NEW."status" = 'PENDING' AND ...)
--
-- What the guards gate, a PENDING to RUNNING claim and a lease write, is activity and stays on the status, as
-- the plan's rule for the claim requires ("the scheduler reads turns only"). guard_opencode_runner_claim and
-- guard_antigravity_runner_claim read only that claim and are not touched.
--
-- WHY EVERY STORED ROW GETS THE SAME ANSWER
-- -----------------------------------------
-- session_release_fact_chk (1401/1402): the status is SUCCEEDED, FAILED or CANCELLED exactly when finished_at
-- is set, so OLD."finished_at" IS NOT NULL is OLD."status" IN those three for every row.
--
-- WHY THE COLUMN LISTS DO NOT CHANGE
-- ----------------------------------
-- Each trigger is BEFORE UPDATE OF status, inbox_lease_owner, inbox_lease_generation, and stays so. The release
-- fact is read only from OLD, inside an exemption to a lease write; the guards decide about an acquisition, and
-- an acquisition always writes the status or the lease columns, which the list already names. A write of
-- finished_at alone acquires nothing, so firing on it could only reach the guards' final RETURN NEW.
--
-- LOCKS
-- -----
-- CREATE OR REPLACE FUNCTION only: no table lock, no row written.
-- How it is sent: the file holds no DO block and no CREATE PROCEDURE, so prisma migrate deploy (7.10) sends it
-- statement by statement; each CREATE OR REPLACE FUNCTION stands alone and commits by itself. Nothing in it
-- COMMITs. sessions/session-release.pg.spec.ts (12) applies it that way, with deployAgain, on a database holding
-- rows.
--
-- NUMBERING, RE-RUNNABILITY
-- -------------------------
-- 1424: after 1423 (rescanned 2026-11-21). Not a multiple of 10. Can run twice.
-- ══════════════════════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.guard_session_engine_acquisition()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
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
        -- A revive: OLD released (`finished_at` set, session_release_fact_chk 1401/1402), NEW queued again.
        AND NOT (OLD."finished_at" IS NOT NULL
                 AND NEW."status" = 'PENDING'
                 AND substring(NEW."inbox_lease_owner"::text, 15, 1) = '5'))
       OR (NEW."inbox_lease_generation" IS NOT NULL
           AND NEW."inbox_lease_generation" IS DISTINCT FROM OLD."inbox_lease_generation") THEN
        RAISE EXCEPTION 'session % runs on %, and this API version does not read session engines; retry against a current replica', NEW."id", NEW."engine"
          USING ERRCODE = 'object_not_in_prerequisite_state';
    END IF;
    RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.guard_dsh_runner_acquisition()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
    IF (
           (OLD."status" = 'PENDING' AND NEW."status" = 'RUNNING')
           OR (NEW."inbox_lease_owner" IS NOT NULL
               AND NEW."inbox_lease_owner" IS DISTINCT FROM OLD."inbox_lease_owner"
               -- A server terminal revive reserves a v5 handoff marker while queuing; it is
               -- not a runner process acquiring the runtime. The actual claim/takeover still
               -- passes every gate when it replaces this marker with the runner's v4 owner.
               -- A revive: OLD released (`finished_at` set, session_release_fact_chk 1401/1402), NEW queued again.
               AND NOT (OLD."finished_at" IS NOT NULL
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
$function$;

CREATE OR REPLACE FUNCTION public.guard_cursor_runner_acquisition()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
    IF (
           (OLD."status" = 'PENDING' AND NEW."status" = 'RUNNING')
           OR (NEW."inbox_lease_owner" IS NOT NULL
               AND NEW."inbox_lease_owner" IS DISTINCT FROM OLD."inbox_lease_owner"
               -- A revive: OLD released (`finished_at` set, session_release_fact_chk 1401/1402), NEW queued again.
               AND NOT (OLD."finished_at" IS NOT NULL
                        AND NEW."status" = 'PENDING'
                        AND substring(NEW."inbox_lease_owner"::text, 15, 1) = '5'))
           OR (NEW."inbox_lease_generation" IS NOT NULL
               AND NEW."inbox_lease_generation" IS DISTINCT FROM OLD."inbox_lease_generation")
       )
       AND COALESCE(NEW."engine", NEW."provider") = 'cursor' THEN
        IF COALESCE(current_setting('orbit.runner_supports_cursor', true), '0') <> '1' THEN
            RETURN NULL;
        END IF;
        -- Keep the heartbeat declaration true through acquisition commit. The Session row is already
        -- locked, so never wait in the reverse runner -> session deletion order: a heartbeat or delete
        -- holding the runner makes this attempt skip and the poll retry.
        BEGIN
            PERFORM 1 FROM "runner" r
            WHERE r."id" = NEW."assigned_runner_id"
              AND r."owner_id" = NEW."owner_id"
              AND r."capabilities_reported_at" IS NOT NULL
              AND 'provider:cursor' = ANY(r."capabilities")
            FOR SHARE NOWAIT;
            IF NOT FOUND THEN RETURN NULL; END IF;
        EXCEPTION WHEN lock_not_available THEN
            RETURN NULL;
        END;
    END IF;
    RETURN NEW;
END;
$function$;
