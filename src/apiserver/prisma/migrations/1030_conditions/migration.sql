-- 1030 — conditions: work that starts when something outside Orbit becomes true (docs/condition-triggers-design.md
-- §3, §4.2, §5; C1 of §11).
--
-- WHAT IT ADDS
-- ============
--   * `condition`: one probe (the exact command the owner approved, its timeout), the comparison its readings are
--     held to, the hold and the re-arm, and the state the server moves from runner samples (conditions/). Attached to
--     exactly one task or one schedule (`condition_one_attach_chk`), at most one per task and per schedule (the two
--     unique indexes). `workspace_id` names the workspace whose runner runs the probe: a history reference, no FK,
--     like `schedule.workspace_id`.
--   * `condition_sample`: what the runner read, one row per (condition, at), so a replayed heartbeat stores a sample
--     once. Kept 30 days and the latest 1000 per condition (conditions.service.ts prunes).
--   * `condition_event`: what the history shows (FIRED, READY_AGAIN, CANT_READ, READ_AGAIN, ASKED_STILL_WAITING).
--   * `owner_request.condition_id` and the kind CONDITION_UNKNOWN: the can't-read card in Waiting on you (§5.3).
--     `owner_request_kind_chk` (0840) is widened again, never narrowed.
--
-- The limit of 20 conditions that are not ENDED per account is held where a condition is created
-- (conditions.service.ts createCondition, under the owner's advisory lock); the bounds below are CHECKs.
--
-- BACKWARD COMPATIBLE
-- ===================
-- New types and tables nothing older reads; one nullable column with no default; a kind check widened, so every
-- stored row passes it. No stored row is rewritten.
--
-- 1030: the highest number in use on origin/main, every origin/project/* and origin/orbit/* was 1000 on 2026-11-17.

-- CreateEnum
CREATE TYPE "condition_state" AS ENUM ('WAITING', 'HOLDING', 'FIRED', 'UNKNOWN', 'ENDED');

-- CreateEnum
CREATE TYPE "condition_compare_op" AS ENUM ('GT', 'GTE', 'LT', 'LTE', 'EQ', 'EXIT_ZERO');

-- CreateEnum
CREATE TYPE "condition_sample_outcome" AS ENUM ('VALUE', 'EXIT', 'TIMEOUT', 'ERROR');

-- CreateEnum
CREATE TYPE "condition_event_kind" AS ENUM ('FIRED', 'READY_AGAIN', 'CANT_READ', 'READ_AGAIN', 'ASKED_STILL_WAITING');

-- AlterTable
ALTER TABLE "owner_request" ADD COLUMN     "condition_id" UUID;

-- CreateTable
CREATE TABLE "condition" (
    "id" UUID NOT NULL,
    "owner_id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "probe_command" TEXT NOT NULL,
    "probe_timeout_seconds" INTEGER NOT NULL DEFAULT 20,
    "compare_op" "condition_compare_op" NOT NULL,
    "compare_value" DOUBLE PRECISION,
    "hold_seconds" INTEGER NOT NULL DEFAULT 0,
    "rearm_op" "condition_compare_op",
    "rearm_value" DOUBLE PRECISION,
    "interval_seconds" INTEGER NOT NULL DEFAULT 300,
    "text" TEXT NOT NULL,
    "unit" TEXT,
    "state" "condition_state" NOT NULL DEFAULT 'WAITING',
    "armed" BOOLEAN NOT NULL DEFAULT true,
    "last_sample_at" TIMESTAMPTZ(3),
    "last_value" DOUBLE PRECISION,
    "last_outcome" "condition_sample_outcome",
    "last_read_at" TIMESTAMPTZ(3),
    "true_since" TIMESTAMPTZ(3),
    "unknown_since" TIMESTAMPTZ(3),
    "unknown_reason" TEXT,
    "failed_checks" INTEGER NOT NULL DEFAULT 0,
    "fired_at" TIMESTAMPTZ(3),
    "approved_command_hash" TEXT NOT NULL,
    "approved_at" TIMESTAMPTZ(3) NOT NULL,
    "task_id" UUID,
    "schedule_id" UUID,
    "created_from_session_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ended_at" TIMESTAMPTZ(3),

    CONSTRAINT "condition_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "condition_sample" (
    "id" UUID NOT NULL,
    "condition_id" UUID NOT NULL,
    "at" TIMESTAMPTZ(3) NOT NULL,
    "outcome" "condition_sample_outcome" NOT NULL,
    "value" DOUBLE PRECISION,
    "exit_code" INTEGER,
    "stderr_tail" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "condition_sample_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "condition_event" (
    "id" UUID NOT NULL,
    "condition_id" UUID NOT NULL,
    "at" TIMESTAMPTZ(3) NOT NULL,
    "kind" "condition_event_kind" NOT NULL,
    "value" DOUBLE PRECISION,
    "run_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "condition_event_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "condition_owner_state_idx" ON "condition"("owner_id", "state");

-- CreateIndex
CREATE INDEX "condition_workspace_idx" ON "condition"("workspace_id");

-- CreateIndex
CREATE UNIQUE INDEX "condition_task_key" ON "condition"("task_id");

-- CreateIndex
CREATE UNIQUE INDEX "condition_schedule_key" ON "condition"("schedule_id");

-- CreateIndex
CREATE UNIQUE INDEX "condition_sample_condition_at_key" ON "condition_sample"("condition_id", "at");

-- CreateIndex
CREATE INDEX "condition_event_condition_at_idx" ON "condition_event"("condition_id", "at" DESC);

-- AddForeignKey
ALTER TABLE "condition" ADD CONSTRAINT "condition_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "condition" ADD CONSTRAINT "condition_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "task"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "condition" ADD CONSTRAINT "condition_schedule_id_fkey" FOREIGN KEY ("schedule_id") REFERENCES "schedule"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "condition_sample" ADD CONSTRAINT "condition_sample_condition_id_fkey" FOREIGN KEY ("condition_id") REFERENCES "condition"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "condition_event" ADD CONSTRAINT "condition_event_condition_id_fkey" FOREIGN KEY ("condition_id") REFERENCES "condition"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- The bounds of §3 and §4.1, and what the evaluation reads as given.
ALTER TABLE "condition"
  ADD CONSTRAINT "condition_one_attach_chk" CHECK (("task_id" IS NULL) <> ("schedule_id" IS NULL)),
  ADD CONSTRAINT "condition_timeout_chk" CHECK ("probe_timeout_seconds" BETWEEN 1 AND 60),
  ADD CONSTRAINT "condition_interval_chk" CHECK ("interval_seconds" >= 60),
  ADD CONSTRAINT "condition_hold_chk" CHECK ("hold_seconds" >= 0),
  ADD CONSTRAINT "condition_compare_value_chk" CHECK (("compare_op" = 'EXIT_ZERO') = ("compare_value" IS NULL)),
  ADD CONSTRAINT "condition_rearm_chk" CHECK (
    ("rearm_op" IS NULL AND "rearm_value" IS NULL)
    OR ("rearm_op" IS NOT NULL AND ("rearm_op" = 'EXIT_ZERO') = ("rearm_value" IS NULL))
  ),
  ADD CONSTRAINT "condition_unknown_reason_chk" CHECK (
    "unknown_reason" IS NULL OR "unknown_reason" IN ('TIMEOUT', 'ERROR', 'RUNNER_OFFLINE', 'RUNNER_ASLEEP')
  );

ALTER TABLE "condition_sample"
  ADD CONSTRAINT "condition_sample_stderr_tail_chk" CHECK ("stderr_tail" IS NULL OR length("stderr_tail") <= 2000);

-- What the silence sweep reads: the conditions still evaluated.
CREATE INDEX "condition_live_idx" ON "condition" ("last_sample_at") WHERE "state" <> 'ENDED';

-- What the 30-day prune reads.
CREATE INDEX "condition_sample_at_idx" ON "condition_sample" ("at");

-- What closes a can't-read card: the PENDING items of one condition.
CREATE INDEX "owner_request_condition_pending_idx"
  ON "owner_request" ("condition_id")
  WHERE "state" = 'PENDING' AND "condition_id" IS NOT NULL;

ALTER TABLE "owner_request" DROP CONSTRAINT IF EXISTS "owner_request_kind_chk";
ALTER TABLE "owner_request" ADD CONSTRAINT "owner_request_kind_chk"
  CHECK ("kind" IN ('DECISION', 'SECRET', 'MANUAL_STEP', 'CONFIRM', 'WIKI_CREATE',
                    'SCHEDULE_FAILED', 'SCHEDULE_HELD', 'SCHEDULE_APPROVAL', 'SCHEDULE_WIDEN',
                    'CONDITION_UNKNOWN'));
