-- 0790 — scheduled tasks: the schedule, its revisions, its runs, its findings, and the changes waiting on the owner
-- (docs/scheduled-tasks-design.md §3, §4, §8).
--
-- WHAT IT ADDS
-- ============
--   * `schedule`: a goal (the person's `intent`, verbatim), a rhythm (`rule` + IANA `timezone`) and an envelope —
--     the four `envelope_*` columns, what a person agreed to on a card (§4). Nothing but an owner-channel decision
--     widens them (schedules/schedules.service.ts).
--   * `schedule_revision`: one row per change, with who made it (USER | SESSION | RUN) and its before/after, which
--     is what Undo reads.
--   * `schedule_run`: one firing. The partial unique indexes are §3's constraints: one run per slot for SCHEDULED
--     and CATCH_UP runs (MANUAL runs are left out), at most one RUNNING | AWAITING_APPROVAL and at most one QUEUED
--     run per schedule.
--   * `schedule_finding`: what a run reported as new, unique per (schedule, key). A creation baseline is written as
--     one with `notified_at` already set.
--   * `schedule_change_request`: a create, or a change that grows the envelope, waiting for the owner's press.
--   * `session_run_source` gains SCHEDULE, and `session` gains `schedule_run_id`, the run a session serves.
--
-- The 50-schedules-per-account limit (SCHEDULE_LIMIT) is counted by the service under a per-account advisory lock,
-- not by a constraint: it is a count, not a row property.
--
-- BACKWARD COMPATIBLE
-- ===================
-- New types and tables, one enum value no statement here uses (so ADD VALUE is safe inside the migration's
-- transaction), and one nullable column on `session` with no default: no stored row is read, written or
-- backfilled (the new foreign key validates against a column that is NULL on every row).
--
-- 0790: renumbered from 0750 when it was rebased onto project/34xKCJAxMQFF3BdZ41KFt, then from 0770 when main took
-- 0770 for 0770_main_checkout_discard; the highest number in use on main, project/*, every pushed orbit/* branch and
-- the local branches was 0780 (2026-11-15).

ALTER TYPE "session_run_source" ADD VALUE IF NOT EXISTS 'SCHEDULE';

CREATE TYPE "schedule_access_level" AS ENUM ('CHECK_ONLY', 'OPEN_PR');
CREATE TYPE "schedule_state" AS ENUM ('ACTIVE', 'PAUSED', 'HELD', 'ENDED');
CREATE TYPE "schedule_ended_reason" AS ENUM ('DELETED', 'END_REACHED', 'GOAL_REACHED');
CREATE TYPE "schedule_changed_by" AS ENUM ('USER', 'SESSION', 'RUN');
CREATE TYPE "schedule_run_trigger" AS ENUM ('SCHEDULED', 'CATCH_UP', 'MANUAL');
CREATE TYPE "schedule_run_state" AS ENUM (
  'QUEUED', 'RUNNING', 'AWAITING_APPROVAL',
  'NO_CHANGE', 'CHANGED', 'FAILED',
  'SKIPPED', 'MISSED', 'HELD', 'CANCELLED'
);
CREATE TYPE "schedule_change_request_kind" AS ENUM ('CREATE', 'UPDATE');
CREATE TYPE "schedule_change_request_state" AS ENUM ('PENDING', 'ALLOWED', 'DECLINED', 'SUPERSEDED');

CREATE TABLE "schedule" (
  "id"                           UUID NOT NULL,
  "owner_id"                     UUID NOT NULL,
  -- History references, not foreign keys: a deleted workspace or agent is something the start checks (§6.1) find
  -- and hold the schedule for, not something that erases it.
  "workspace_id"                 UUID NOT NULL,
  "agent_id"                     UUID,
  "intent"                       TEXT NOT NULL,
  "title"                        TEXT NOT NULL,
  "prompt"                       TEXT NOT NULL,
  "rule"                         JSONB NOT NULL,
  "timezone"                     TEXT NOT NULL,
  "start_at"                     TIMESTAMPTZ(3) NOT NULL,
  "end_at"                       TIMESTAMPTZ(3),
  "access_level"                 "schedule_access_level" NOT NULL,
  "run_limit_minutes"            INTEGER NOT NULL DEFAULT 30,
  "envelope_workspace_id"        UUID NOT NULL,
  "envelope_access_level"        "schedule_access_level" NOT NULL,
  "envelope_runs_per_week"       INTEGER NOT NULL,
  "envelope_run_limit_minutes"   INTEGER NOT NULL,
  "state"                        "schedule_state" NOT NULL DEFAULT 'ACTIVE',
  "held_reason"                  TEXT,
  "ended_reason"                 "schedule_ended_reason",
  "note"                         TEXT,
  "revision"                     INTEGER NOT NULL DEFAULT 1,
  "next_due_at"                  TIMESTAMPTZ(3),
  "consecutive_failures"         INTEGER NOT NULL DEFAULT 0,
  "created_from_session_id"      UUID,
  "created_at"                   TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"                   TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "ended_at"                     TIMESTAMPTZ(3),
  CONSTRAINT "schedule_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "schedule_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "schedule_run_limit_check" CHECK ("run_limit_minutes" BETWEEN 1 AND 120),
  CONSTRAINT "schedule_envelope_run_limit_check" CHECK ("envelope_run_limit_minutes" BETWEEN 1 AND 120),
  CONSTRAINT "schedule_envelope_runs_per_week_check" CHECK ("envelope_runs_per_week" >= 1),
  CONSTRAINT "schedule_note_length_check" CHECK ("note" IS NULL OR char_length("note") <= 2000),
  CONSTRAINT "schedule_next_due_only_active_check" CHECK ("next_due_at" IS NULL OR "state" = 'ACTIVE'),
  CONSTRAINT "schedule_ended_reason_check" CHECK (("state" = 'ENDED') = ("ended_reason" IS NOT NULL))
);
CREATE INDEX "schedule_owner_state_idx" ON "schedule" ("owner_id", "state");
CREATE INDEX "schedule_due_idx" ON "schedule" ("next_due_at") WHERE "state" = 'ACTIVE';

CREATE TABLE "schedule_revision" (
  "id"                UUID NOT NULL,
  "schedule_id"       UUID NOT NULL,
  "revision"          INTEGER NOT NULL,
  "changed_by"        "schedule_changed_by" NOT NULL,
  "session_id"        UUID,
  -- `{ before, after }`, each holding only the fields the change touched (`envelope` among them when it moved).
  "fields"            JSONB NOT NULL,
  "undo_of_revision"  INTEGER,
  "created_at"        TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "schedule_revision_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "schedule_revision_schedule_id_fkey" FOREIGN KEY ("schedule_id") REFERENCES "schedule"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "schedule_revision_schedule_revision_key" ON "schedule_revision" ("schedule_id", "revision");

CREATE TABLE "schedule_run" (
  "id"                 UUID NOT NULL,
  "schedule_id"        UUID NOT NULL,
  "schedule_revision"  INTEGER NOT NULL,
  "planned_at"         TIMESTAMPTZ(3) NOT NULL,
  "trigger"            "schedule_run_trigger" NOT NULL,
  "state"              "schedule_run_state" NOT NULL DEFAULT 'QUEUED',
  "attempt"            INTEGER NOT NULL DEFAULT 1,
  "started_at"         TIMESTAMPTZ(3),
  "ended_at"           TIMESTAMPTZ(3),
  -- A history reference: archiving or deleting the run's session keeps the run (§7.4).
  "session_id"         UUID,
  "key"                TEXT,
  "summary"            TEXT,
  "links"              JSONB NOT NULL DEFAULT '[]',
  "failure_reason"     TEXT,
  "created_at"         TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "schedule_run_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "schedule_run_schedule_id_fkey" FOREIGN KEY ("schedule_id") REFERENCES "schedule"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "schedule_run_schedule_planned_idx" ON "schedule_run" ("schedule_id", "planned_at" DESC);
-- §3: two workers, or one after a restart, write one run for a slot.
CREATE UNIQUE INDEX "schedule_run_slot_key" ON "schedule_run" ("schedule_id", "planned_at")
  WHERE "trigger" IN ('SCHEDULED', 'CATCH_UP');
-- §3: at most one run in progress and at most one waiting, per schedule.
CREATE UNIQUE INDEX "schedule_run_one_in_progress_key" ON "schedule_run" ("schedule_id")
  WHERE "state" IN ('RUNNING', 'AWAITING_APPROVAL');
CREATE UNIQUE INDEX "schedule_run_one_queued_key" ON "schedule_run" ("schedule_id")
  WHERE "state" = 'QUEUED';

CREATE TABLE "schedule_finding" (
  "id"                UUID NOT NULL,
  "schedule_id"       UUID NOT NULL,
  "key"               TEXT NOT NULL,
  "summary"           TEXT,
  "first_run_id"      UUID,
  "last_seen_run_id"  UUID,
  "notified_at"       TIMESTAMPTZ(3),
  "links"             JSONB NOT NULL DEFAULT '[]',
  "created_at"        TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "schedule_finding_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "schedule_finding_schedule_id_fkey" FOREIGN KEY ("schedule_id") REFERENCES "schedule"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "schedule_finding_schedule_key_key" ON "schedule_finding" ("schedule_id", "key");

CREATE TABLE "schedule_change_request" (
  "id"                   UUID NOT NULL,
  "owner_id"             UUID NOT NULL,
  -- NULL for a CREATE until it is allowed.
  "schedule_id"          UUID,
  "kind"                 "schedule_change_request_kind" NOT NULL,
  "state"                "schedule_change_request_state" NOT NULL DEFAULT 'PENDING',
  "asked_by"             "schedule_changed_by" NOT NULL,
  "asked_by_session_id"  UUID,
  "base_revision"        INTEGER,
  -- CREATE: the whole input. UPDATE: the patch.
  "proposed"             JSONB NOT NULL,
  -- The envelope now (NULL for a CREATE) and the one the change needs; `widens` names the parts that grow.
  "envelope_before"      JSONB,
  "envelope_asked"       JSONB NOT NULL,
  "widens"               TEXT[] NOT NULL DEFAULT '{}',
  "decided_at"           TIMESTAMPTZ(3),
  "decided_by_user_id"   UUID,
  "result_revision"      INTEGER,
  "created_at"           TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "schedule_change_request_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "schedule_change_request_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "schedule_change_request_schedule_id_fkey" FOREIGN KEY ("schedule_id") REFERENCES "schedule"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "schedule_change_request_update_names_schedule_check" CHECK ("kind" = 'CREATE' OR "schedule_id" IS NOT NULL)
);
CREATE INDEX "schedule_change_request_owner_state_idx" ON "schedule_change_request" ("owner_id", "state", "created_at");
CREATE INDEX "schedule_change_request_schedule_idx" ON "schedule_change_request" ("schedule_id") WHERE "schedule_id" IS NOT NULL;

ALTER TABLE "session" ADD COLUMN "schedule_run_id" UUID;
ALTER TABLE "session" ADD CONSTRAINT "session_schedule_run_id_fkey"
  FOREIGN KEY ("schedule_run_id") REFERENCES "schedule_run"("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "session_schedule_run_idx" ON "session" ("schedule_run_id") WHERE "schedule_run_id" IS NOT NULL;
