-- 0281 — integration jobs: one row per attempt the platform makes to put a source branch onto a
-- project's integration line, and everything a reader needs to check that the tree that landed is
-- the tree that was tested (docs/project-integration-line-contract.md §2.1).
--
-- WHAT IT ADDS
-- ============
--   * `project_integration_job`: a queued, claimed, and finished unit of git work the runner does on
--     the platform's behalf. It carries the three tips it froze (source, target, upstream), the commit
--     and tree the checks ran on, the commit and tree that landed, the checks themselves with their
--     exit codes and output tails, the conflicting paths when it stopped at a conflict, and the
--     receipts it wrote. It is not a session: nothing here starts an engine.
--   * The foreign key `project_open_item.integration_job_id` was waiting for (0278 declared the column
--     and said the table that creates the job would point it here).
--   * `project_integration_job_terminal_guard`: a job that reached a terminal state is never rewritten.
--
-- THE TWO CONSTRAINTS THAT ARE THE POINT
-- ======================================
--   * J1 (serial) — `project_integration_job_running_serial_key`, a partial unique index on
--     `serial_key` over RUNNING rows. `serial_key` is the canonical repository URL and the target
--     ref, so two projects integrating into the same branch of the same repository are serialised
--     against each other, not just two tasks of one project. Today's only serialisation is a mutex
--     inside one runner process, which two runners do not share; this one is in the database.
--   * J2 (the tree that landed is the tree that was tested) —
--     `project_integration_job_landed_tree_chk`. A LANDED row must name both trees and they must be
--     equal. A row that pushed something it never ran the checks on cannot be written down, so
--     "we verified before landing" is a schema property rather than a claim in a comment.
--
-- Also J3: `project_integration_job_task_inflight_key` keeps one task to a single QUEUED-or-RUNNING
-- LAND_TASK job, which is what makes "enqueue is idempotent" true of the queue and not only of the
-- idempotency key.
--
-- BACKWARD COMPATIBLE
-- ===================
-- One new table, one new foreign key on a column that exists and is NULL in every row (0278 created
-- it empty), one trigger on the new table. No existing column is dropped or rewritten, and the
-- migration carries no DML of any kind.
--
-- LOCK ORDER
-- ==========
-- Rank 60, a child row, taken after `task` and `project_codebase` (§1.3 L3 and
-- `src/apiserver/src/common/lock-order.ts`): enqueue runs in the transaction that wrote DONE, which
-- already holds the task, then locks the codebase row to start the line, then inserts here. The
-- claim path takes only this table's rows.

BEGIN;

CREATE TABLE "project_integration_job" (
  "id" uuid NOT NULL,
  "project_id" uuid NOT NULL,
  "owner_id" uuid NOT NULL,
  "codebase_id" uuid NOT NULL,
  "kind" text NOT NULL,
  -- Which attempt this is at the same piece of work. A conflict is never retried by the platform
  -- (J5); a new generation exists because somebody asked for one, or because the task branch moved.
  "generation" integer NOT NULL DEFAULT 1,
  "task_id" uuid,
  "session_id" uuid,
  "promotion_id" uuid,
  -- The repository and target ref this job must not share with another RUNNING job (J1).
  "serial_key" text NOT NULL,
  "target_ref" text NOT NULL,
  "upstream_ref" text NOT NULL,
  "source_ref" text NOT NULL,
  "state" text NOT NULL DEFAULT 'QUEUED',
  "phase" text,
  "runner_id" uuid,
  -- The lease, in the shape `codex_rate_limit_reset_operation` already uses: a claim is a CAS on
  -- `claim_generation`, and a result reported under a generation that has moved is refused.
  "claim_lease_owner" text,
  "claim_generation" bigint NOT NULL DEFAULT 0,
  "claimed_at" TIMESTAMPTZ(3),
  "heartbeat_at" TIMESTAMPTZ(3),
  "cancel_requested_at" TIMESTAMPTZ(3),
  "source_sha" char(40),
  "target_sha_before" char(40),
  "upstream_sha" char(40),
  "main_sync_sha" char(40),
  "tested_sha" char(40),
  "tested_tree_sha" char(40),
  "landed_sha" char(40),
  "landed_tree_sha" char(40),
  "ahead_of_upstream" integer,
  "checks" jsonb NOT NULL DEFAULT '[]',
  "conflicts" text[] NOT NULL DEFAULT '{}',
  "error_code" text,
  "error_detail" jsonb,
  "receipt_ids" uuid[] NOT NULL DEFAULT '{}',
  "idempotency_key" text NOT NULL,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "started_at" TIMESTAMPTZ(3),
  "finished_at" TIMESTAMPTZ(3),
  "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "project_integration_job_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "project_integration_job_project_fkey" FOREIGN KEY ("project_id", "owner_id")
    REFERENCES "project" ("id", "owner_id") ON DELETE CASCADE,
  CONSTRAINT "project_integration_job_codebase_fkey" FOREIGN KEY ("codebase_id")
    REFERENCES "project_codebase" ("id") ON DELETE CASCADE,
  -- A job outlives the task or session it was about: SET NULL rather than CASCADE, because the
  -- audit of what the platform pushed is not a detail of the row that asked for it.
  CONSTRAINT "project_integration_job_task_fkey" FOREIGN KEY ("task_id")
    REFERENCES "task" ("id") ON DELETE SET NULL,
  CONSTRAINT "project_integration_job_session_fkey" FOREIGN KEY ("session_id")
    REFERENCES "session" ("id") ON DELETE SET NULL,
  CONSTRAINT "project_integration_job_kind_chk" CHECK ("kind" IN (
    'LAND_TASK', 'CHECK_PROMOTION', 'LAND_PROMOTION')),
  CONSTRAINT "project_integration_job_state_chk" CHECK ("state" IN (
    'QUEUED', 'RUNNING', 'LANDED', 'ALREADY_LANDED', 'READY',
    'CONFLICT', 'CHECK_FAILED', 'ERROR', 'CANCELLED', 'SUPERSEDED')),
  CONSTRAINT "project_integration_job_phase_chk" CHECK ("phase" IS NULL OR "phase" IN (
    'FETCH', 'MAIN_SYNC', 'REBASE', 'MERGE', 'CHECK', 'VERIFY', 'PUSH')),
  CONSTRAINT "project_integration_job_generation_chk" CHECK ("generation" >= 1),
  -- J2: what landed is what was tested. Stated as a CHECK so a row that says otherwise cannot exist.
  CONSTRAINT "project_integration_job_landed_tree_chk" CHECK (
    "state" <> 'LANDED' OR (
      "landed_sha" IS NOT NULL AND "tested_tree_sha" IS NOT NULL
      AND "landed_tree_sha" = "tested_tree_sha")),
  -- A job that landed a task must say which task, so a receipt can be written from it.
  CONSTRAINT "project_integration_job_land_task_chk" CHECK (
    "kind" <> 'LAND_TASK' OR "task_id" IS NOT NULL),
  CONSTRAINT "project_integration_job_idempotency_key" UNIQUE ("idempotency_key")
);

-- J1: at most one RUNNING job per repository-and-target-ref, across runners and across projects.
CREATE UNIQUE INDEX "project_integration_job_running_serial_key"
  ON "project_integration_job" ("serial_key") WHERE "state" = 'RUNNING';
-- J3: one in-flight landing per task.
CREATE UNIQUE INDEX "project_integration_job_task_inflight_key"
  ON "project_integration_job" ("task_id")
  WHERE "kind" = 'LAND_TASK' AND "state" IN ('QUEUED', 'RUNNING');
-- What the claim scan reads: the oldest QUEUED job whose serial key is free.
CREATE INDEX "project_integration_job_queued_idx"
  ON "project_integration_job" ("state", "created_at", "id");
CREATE INDEX "project_integration_job_project_idx"
  ON "project_integration_job" ("project_id", "created_at");
CREATE INDEX "project_integration_job_task_idx"
  ON "project_integration_job" ("task_id", "generation") WHERE "task_id" IS NOT NULL;

ALTER TABLE "project_open_item"
  ADD CONSTRAINT "project_open_item_integration_job_fkey" FOREIGN KEY ("integration_job_id")
    REFERENCES "project_integration_job" ("id") ON DELETE SET NULL;

-- J4: a finished job is the audit of what happened. A late result from a runner that lost its lease
-- does not get to overwrite it.
CREATE OR REPLACE FUNCTION "project_integration_job_terminal_guard"() RETURNS trigger AS $$
BEGIN
  IF OLD."state" NOT IN ('QUEUED', 'RUNNING') THEN
    RAISE EXCEPTION 'PROJECT_INTEGRATION_JOB_TERMINAL'
      USING ERRCODE = 'P0001',
            DETAIL = 'a finished integration job is final; a retry is a new generation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "project_integration_job_terminal_guard"
  BEFORE UPDATE ON "project_integration_job"
  FOR EACH ROW EXECUTE FUNCTION "project_integration_job_terminal_guard"();

COMMIT;
