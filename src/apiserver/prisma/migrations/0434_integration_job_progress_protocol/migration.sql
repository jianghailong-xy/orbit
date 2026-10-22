-- 0434 — the v2 progress protocol's facts on an integration job (docs/project-integration-line-contract.md
-- §2.1 revision 12's column list, §2.2 J-T4 "the progress and cancel protocol", §7.2 V6, J12).
--
-- WHAT IT ADDS
-- ============
-- Seven nullable columns on `project_integration_job`, all of them written by the progress route
-- (`runner-api/integration-job-relay.ts#receiveIntegrationJobProgress`) except where noted:
--
--   * `progress_protocol` — the protocol the CURRENT claim was made under; `'v2'` for a runner that
--     declared `integration-progress/v2`, NULL for a legacy claim (and for every row claimed before
--     this migration). The claim statement writes it (§2.2 J-T2/J-T3); the timeout rule, J12's error
--     code and the push boundary read it instead of asking what a runner is now.
--   * `push_reported_generation` — the `claim_generation` under which the server accepted a
--     synchronous `phase = PUSH` report. That makes the push boundary a row fact (§2.1): a v2 claim
--     is past it when this equals its `claim_generation`. Never cleared; a takeover of a LEGACY claim
--     with this NULL writes the generation it took over, because that runner's push may have happened
--     and a legacy PUSH report cannot prove otherwise.
--   * `round`, `step`, `step_started_at`, `output_moved_at`, `current_check` — what the job is doing
--     inside its current claim: the round from 1, the named sub-step (WAITING_LOCAL_LOCK inside
--     FETCH, PREPARE inside CHECK), when that sub-step began (written only when it changes), when the
--     current step's output last moved (received-at minus the report's `outputIdleMs`), and the check
--     in flight `{ name, index, count, budgetSeconds, startedAt }`. The last one is where §2.1's open
--     choice for "J-T4's current check" is settled (errata E8): a JSON column rather than four
--     scalar columns, because the object is read and written whole and never queried by field.
--     `checks` keeps holding FINISHED results; it is a different shape and is not reused.
--
-- NOT ADDED: revision 9's `check_name` / `check_index` / `check_count` / `check_budget_seconds` —
-- the JSON column above replaced them. `upstream_moved_commits` (contract §2.1) and `landing_id`
-- belong to other tasks and are not written here.
--
-- CONSTRAINTS
-- ===========
-- `step` and `progress_protocol` are closed sets the way `phase` already is (0281), and `round`
-- starts at 1. Every stored row has NULL in all seven columns, so every constraint is satisfied by
-- every stored row and is added NOT VALID then VALIDATEd, matching 0433.
--
-- LOCK
-- ====
-- Seven `ADD COLUMN`s with no default (catalog-only) and three `VALIDATE`s that read the table once
-- under SHARE UPDATE EXCLUSIVE. The table is one row per landing attempt, so all of it is small.

ALTER TABLE "project_integration_job"
  ADD COLUMN IF NOT EXISTS "progress_protocol" text,
  ADD COLUMN IF NOT EXISTS "push_reported_generation" bigint,
  ADD COLUMN IF NOT EXISTS "round" integer,
  ADD COLUMN IF NOT EXISTS "step" text,
  ADD COLUMN IF NOT EXISTS "step_started_at" TIMESTAMPTZ(3),
  ADD COLUMN IF NOT EXISTS "output_moved_at" TIMESTAMPTZ(3),
  ADD COLUMN IF NOT EXISTS "current_check" jsonb;

DO $$ BEGIN
  ALTER TABLE "project_integration_job"
    ADD CONSTRAINT "project_integration_job_progress_protocol_chk"
    CHECK ("progress_protocol" IS NULL OR "progress_protocol" IN ('v2')) NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "project_integration_job"
    ADD CONSTRAINT "project_integration_job_step_chk"
    CHECK ("step" IS NULL OR "step" IN ('WAITING_LOCAL_LOCK', 'PREPARE')) NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "project_integration_job"
    ADD CONSTRAINT "project_integration_job_round_chk"
    CHECK ("round" IS NULL OR "round" >= 1) NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE "project_integration_job"
  VALIDATE CONSTRAINT "project_integration_job_progress_protocol_chk";

ALTER TABLE "project_integration_job"
  VALIDATE CONSTRAINT "project_integration_job_step_chk";

ALTER TABLE "project_integration_job"
  VALIDATE CONSTRAINT "project_integration_job_round_chk";
