-- 0453 — the data layer of landing observation and delivery mode (docs/project-integration-line-contract.md
-- §10.4, revision 29). Columns, closed sets and one index; nothing here decides anything yet.
--
-- WHAT IT ADDS
-- ============
-- 1. `task` (rank 50) — the delivery identity frozen when a code task is written DONE (O1, O-L4). Five
--    nullable columns with no default and no constraint:
--      * `delivered_sha` CHAR(40) — the work commit;
--      * `delivered_base_sha` CHAR(40) — the commit it forked from;
--      * `delivered_branch` TEXT — the short name of the branch the work ended on (a receipt's
--        `source_branch`);
--      * `delivered_session_id` UUID — the session the identity was read from. A history reference with
--        no foreign key, for 0424's reason: what a task delivered outlives the session it came from;
--      * `delivered_at` TIMESTAMPTZ(3) — when it was frozen. NULL is "not frozen".
-- 2. `project_codebase` (rank 55) — how a project's finished work reaches its upstream (O4, O-L1):
--      * `delivery_mode` TEXT NOT NULL DEFAULT 'PLATFORM', closed by `project_codebase_delivery_mode_chk`:
--        PLATFORM (Orbit lands the work; the agent does not touch the target branch) or AGENT_PUSH (the
--        agent pushes its commits to the upstream itself);
--      * `project_codebase_delivery_mode_line_chk`: `delivery_mode = 'PLATFORM' OR integration_ref =
--        upstream_ref` — AGENT_PUSH only on a MAIN line. A PROJECT_BRANCH binding cannot be set to it,
--        and an AGENT_PUSH binding cannot be moved onto a project branch while it stays AGENT_PUSH;
--      * `delivery_mode_chosen_at` TIMESTAMPTZ(3) NULL — when the account owner wrote `deliveryMode`.
--        NULL is "never chosen".
--    Neither column is named by 0270's `project_codebase_integration_lock` or by 0231's
--    `project_codebase_config_guard`. Each compares a fixed list of columns and neither function has
--    been replaced since, so writing the delivery mode moves no ref, is not refused once the line has
--    started (L4 does not lock it, O-L1), and moves no `config_revision`.
-- 3. `project_integration_job` (rank 60) — the observation job (§10.6):
--      * `project_integration_job_kind_chk` admits OBSERVE_LANDING (0281's list plus the new value);
--      * `project_integration_job_state_chk` admits OBSERVED (0300's list plus the new value);
--      * `project_integration_job_phase_chk` admits OBSERVE (0281's list plus the new value);
--      * `observations` JSONB NULL — one entry per task an OBSERVE_LANDING job observed;
--      * `project_integration_job_observe_queued_key`, a partial unique index on `serial_key` over the
--        QUEUED OBSERVE_LANDING rows: at most one queued observation per project, so that a later
--        trigger's `INSERT … ON CONFLICT DO NOTHING` folds into the one already queued.
--    J4's terminal guard is left as it is: it refuses every update of a row whose state is neither
--    QUEUED nor RUNNING, which makes OBSERVED final without naming it. J1's running-serial index covers
--    the `#observe:` keys as it covers every other key.
-- 4. `project_open_item` (rank 60) — the two items of §10.7:
--      * `project_open_item_kind_chk` admits LANDING_UNOBSERVED and LANDED_WITHOUT_CONFIRMATION (0439's
--        list plus the two values);
--      * `project_open_item_resolution_chk` admits ACCEPTED and CODELESS (0439's list plus the two);
--      * `project_open_item_owner_only_chk` lists LANDED_WITHOUT_CONFIRMATION among the owner-only kinds
--        (0439's list plus the value): it is the owner's from birth and is never delivered to a
--        coordinator (§10.7). LANDING_UNOBSERVED is not owner-only: it goes to the coordinator first;
--      * `project_open_item_handling_kind_chk` admits LANDING_UNOBSERVED beside the three integration
--        failures (0368's list plus the value): a renewed observation records itself on the open item
--        the way a rerun does (§10.8, §4.7 H1) — the job it queued, who asked and why.
--
-- `error_code` has no CHECK, so J12's new WORK_COMMIT_MISSING is a change to `INTEGRATION_ERROR_CODES` in
-- the API server and to nothing here.
--
-- WHY THE CLOSED SETS ARE RESTATED IN FULL
-- ========================================
-- 0300's reason: each of these columns is a closed set held by its CHECK and by a list in the API server
-- together (`projects/project-integration-job.ts`, `projects/project-open-item.ts`), and the two have to
-- move as one. Writing the whole list out keeps them checkable against each other.
--
-- WHAT IT DOES NOT DO
-- ===================
-- No row is inserted, updated or deleted, and nothing is backfilled or invented — no receipt, no item, no
-- job (§10.9). The new `task` columns and `observations` are nullable with no default, and
-- `delivery_mode_chosen_at` too; `delivery_mode`'s default is a constant, so on PostgreSQL 11 and later
-- every ADD COLUMN is catalog-only and every existing binding reads PLATFORM. The widened sets refuse
-- nothing already stored, and the two new CHECKs hold on every existing binding because it reads PLATFORM.
-- No function, trigger or type is created, replaced or dropped.
--
-- LOCK AND RE-RUN
-- ===============
-- One transaction. Each table is taken ACCESS EXCLUSIVE by its first ALTER, in rank order — `task`, then
-- `project_codebase`, then the two rank-60 tables — the order every application transaction takes them
-- in (`common/lock-order.ts`). Under those locks, the CHECKs and the partial index read
-- `project_codebase`, `project_integration_job` and `project_open_item` once each. Every statement can
-- run twice: ADD COLUMN IF NOT EXISTS, DROP CONSTRAINT IF EXISTS before each ADD CONSTRAINT, CREATE INDEX
-- IF NOT EXISTS.

BEGIN;

ALTER TABLE "task"
  ADD COLUMN IF NOT EXISTS "delivered_sha" CHAR(40),
  ADD COLUMN IF NOT EXISTS "delivered_base_sha" CHAR(40),
  ADD COLUMN IF NOT EXISTS "delivered_branch" TEXT,
  ADD COLUMN IF NOT EXISTS "delivered_session_id" UUID,
  ADD COLUMN IF NOT EXISTS "delivered_at" TIMESTAMPTZ(3);

ALTER TABLE "project_codebase"
  ADD COLUMN IF NOT EXISTS "delivery_mode" TEXT NOT NULL DEFAULT 'PLATFORM',
  ADD COLUMN IF NOT EXISTS "delivery_mode_chosen_at" TIMESTAMPTZ(3);

ALTER TABLE "project_codebase"
  DROP CONSTRAINT IF EXISTS "project_codebase_delivery_mode_chk",
  ADD CONSTRAINT "project_codebase_delivery_mode_chk"
    CHECK ("delivery_mode" IN ('PLATFORM', 'AGENT_PUSH')),
  DROP CONSTRAINT IF EXISTS "project_codebase_delivery_mode_line_chk",
  ADD CONSTRAINT "project_codebase_delivery_mode_line_chk"
    CHECK ("delivery_mode" = 'PLATFORM' OR "integration_ref" = "upstream_ref");

ALTER TABLE "project_integration_job"
  ADD COLUMN IF NOT EXISTS "observations" JSONB;

ALTER TABLE "project_integration_job"
  DROP CONSTRAINT IF EXISTS "project_integration_job_kind_chk",
  ADD CONSTRAINT "project_integration_job_kind_chk" CHECK ("kind" IN (
    'LAND_TASK', 'CHECK_PROMOTION', 'LAND_PROMOTION', 'OBSERVE_LANDING')),
  DROP CONSTRAINT IF EXISTS "project_integration_job_state_chk",
  ADD CONSTRAINT "project_integration_job_state_chk" CHECK ("state" IN (
    'QUEUED', 'RUNNING', 'LANDED', 'ALREADY_LANDED', 'NOTHING_TO_LAND', 'READY',
    'CONFLICT', 'CHECK_FAILED', 'ERROR', 'CANCELLED', 'SUPERSEDED', 'OBSERVED')),
  DROP CONSTRAINT IF EXISTS "project_integration_job_phase_chk",
  ADD CONSTRAINT "project_integration_job_phase_chk" CHECK ("phase" IS NULL OR "phase" IN (
    'FETCH', 'MAIN_SYNC', 'REBASE', 'MERGE', 'CHECK', 'VERIFY', 'PUSH', 'OBSERVE'));

-- At most one queued observation per project (§10.6): its serial key is
-- `canonical_repo_url || '#observe:' || project_id`.
CREATE UNIQUE INDEX IF NOT EXISTS "project_integration_job_observe_queued_key"
  ON "project_integration_job" ("serial_key")
  WHERE "kind" = 'OBSERVE_LANDING' AND "state" = 'QUEUED';

ALTER TABLE "project_open_item"
  DROP CONSTRAINT IF EXISTS "project_open_item_kind_chk",
  ADD CONSTRAINT "project_open_item_kind_chk" CHECK ("kind" IN (
    'INTEGRATION_CONFLICT', 'INTEGRATION_CHECK_FAILED', 'INTEGRATION_ERROR', 'TASK_FAILED',
    'PROMOTION_APPROVAL', 'COORDINATOR_QUESTION', 'FUSE_PAUSED', 'START_REQUEST', 'DONE_REQUEST',
    'DELIVERY_REVIEW', 'LANDING_LEASE_EXPIRED', 'LANDING_UNOBSERVED', 'LANDED_WITHOUT_CONFIRMATION')),
  DROP CONSTRAINT IF EXISTS "project_open_item_resolution_chk",
  ADD CONSTRAINT "project_open_item_resolution_chk" CHECK ("resolution" IS NULL OR "resolution" IN (
    'LANDED', 'RETRIED', 'TASK_DONE', 'TASK_CLOSED', 'SUCCESSOR_FILED', 'PROMOTION_MOVED_ON',
    'HANDLED', 'APPROVED', 'DECLINED', 'ANSWERED', 'WITHDRAWN', 'RESUMED', 'JOB_MOVED_ON',
    'ACCEPTED', 'CODELESS')),
  DROP CONSTRAINT IF EXISTS "project_open_item_owner_only_chk",
  ADD CONSTRAINT "project_open_item_owner_only_chk" CHECK (
    "kind" NOT IN ('PROMOTION_APPROVAL', 'COORDINATOR_QUESTION', 'FUSE_PAUSED', 'START_REQUEST',
                   'DONE_REQUEST', 'LANDING_LEASE_EXPIRED', 'LANDED_WITHOUT_CONFIRMATION')
    OR "assignee" = 'OWNER'),
  DROP CONSTRAINT IF EXISTS "project_open_item_handling_kind_chk",
  ADD CONSTRAINT "project_open_item_handling_kind_chk" CHECK (
    "handling_job_id" IS NULL
    OR "kind" IN ('INTEGRATION_CONFLICT', 'INTEGRATION_CHECK_FAILED', 'INTEGRATION_ERROR',
                  'LANDING_UNOBSERVED'));

COMMIT;
