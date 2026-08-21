-- Durable Project reconciliation: one renewable/fenced lease, one recovery clock and one
-- permanent idempotency ledger. The event outbox remains a dirty signal; this migration adds the
-- state that makes consuming that signal safe across retries, takeovers and process restarts.

CREATE TYPE "project_run_state" AS ENUM (
  'PLANNING', 'EXECUTING', 'AWAITING_VERIFICATION', 'BLOCKED',
  'AWAITING_HUMAN', 'ACCEPTANCE', 'SETTLED'
);

CREATE TYPE "project_action_status" AS ENUM (
  'CLAIMED', 'APPLIED', 'REFUSED', 'SUPERSEDED'
);

CREATE TYPE "project_action_type" AS ENUM (
  'DISPATCH_TASK', 'OPEN_COORDINATOR_TURN', 'ROTATE_COORDINATOR_SESSION',
  'RAISE_BLOCKER', 'CLEAR_BLOCKER', 'APPLY_VERIFICATION_VERDICT',
  'REQUEST_APPROVAL', 'RUN_PROJECT_ACCEPTANCE'
);

ALTER TABLE "project_runtime"
  ADD COLUMN "run_state" "project_run_state" NOT NULL DEFAULT 'PLANNING',
  ADD COLUMN "next_wake_at" TIMESTAMP(3),
  ADD COLUMN "next_wake_reason" TEXT,
  ADD COLUMN "lease_holder" UUID,
  ADD COLUMN "lease_expires_at" TIMESTAMP(3),
  ADD COLUMN "lease_heartbeat_at" TIMESTAMP(3),
  ADD COLUMN "fencing_token" BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN "acceptance_attempt" BIGINT NOT NULL DEFAULT 0;

-- Existing projects stay inert unless their owner already enabled coordination. An enabled OPEN
-- project is due immediately, which is the migration-safe bootstrap for the recovery loop: no
-- synthetic business event is invented, but the project cannot silently sit in PLANNING either.
UPDATE "project_runtime" r
   SET "run_state" = CASE WHEN p."status" IN ('DONE', 'CANCELLED')
                          THEN 'SETTLED'::"project_run_state"
                          ELSE 'PLANNING'::"project_run_state" END,
       "next_wake_at" = CASE WHEN p."status" = 'OPEN' AND p."coordinator_enabled"
                             THEN CURRENT_TIMESTAMP ELSE NULL END,
       "next_wake_reason" = CASE WHEN p."status" = 'OPEN' AND p."coordinator_enabled"
                                 THEN 'reconcile migration bootstrap' ELSE NULL END,
       "updated_at" = CURRENT_TIMESTAMP
  FROM "project" p
 WHERE p."id" = r."project_id";

ALTER TABLE "project_runtime" ADD CONSTRAINT "project_runtime_lease_shape_chk" CHECK (
  ("lease_holder" IS NULL AND "lease_expires_at" IS NULL AND "lease_heartbeat_at" IS NULL)
  OR
  ("lease_holder" IS NOT NULL AND "lease_expires_at" IS NOT NULL
    AND "lease_heartbeat_at" IS NOT NULL AND "lease_expires_at" >= "lease_heartbeat_at")
);
ALTER TABLE "project_runtime" ADD CONSTRAINT "project_runtime_counters_chk" CHECK (
  "fencing_token" >= 0 AND "acceptance_attempt" >= 0
);

-- One index serves scheduled wakes and the stale-wake backstop. Disabled/settled projects are
-- filtered by the joining Project row in the service because those facts live on another table.
CREATE INDEX "project_runtime_due_idx" ON "project_runtime"("next_wake_at")
  WHERE "next_wake_at" IS NOT NULL;

CREATE TABLE "project_action" (
  "id" UUID NOT NULL,
  "project_id" UUID NOT NULL,
  "idempotency_key" TEXT NOT NULL,
  "type" "project_action_type" NOT NULL,
  "status" "project_action_status" NOT NULL DEFAULT 'CLAIMED',
  "subject_type" TEXT NOT NULL,
  "subject_id" UUID,
  "fencing_token" BIGINT NOT NULL,
  "decision_id" UUID,
  "result_session_id" UUID,
  "refusal_code" TEXT,
  "detail" JSONB NOT NULL DEFAULT '{}',
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "project_action_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "project_action_fencing_token_chk" CHECK ("fencing_token" > 0)
);

-- The global key contains the Project UUID, so partitioning the uniqueness by project would only
-- weaken the invariant. ON CONFLICT against this exact index is the ledger's claim operation.
CREATE UNIQUE INDEX "project_action_idempotency_key_key"
  ON "project_action"("idempotency_key");
CREATE INDEX "project_action_project_id_created_at_idx"
  ON "project_action"("project_id", "created_at");
CREATE INDEX "project_action_project_id_type_status_idx"
  ON "project_action"("project_id", "type", "status");

ALTER TABLE "project_action" ADD CONSTRAINT "project_action_project_id_fkey"
  FOREIGN KEY ("project_id") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
