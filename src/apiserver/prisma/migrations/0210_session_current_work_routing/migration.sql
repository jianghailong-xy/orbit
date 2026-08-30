-- Explicit CURRENT_WORK is either appended to the not-yet-leased opening turn or aimed at one
-- exact live message turn. Explicit NEXT_TURN is independently executable; legacy NULL retains
-- the pre-v1 server-side auto-steer/queue decision during mixed-version rollout.
-- Deployment/rollback order is mandatory; see docs/session-current-work-routing-rollout.md.
ALTER TABLE "conversation_turn"
  ADD COLUMN "request_fingerprint" CHAR(64),
  ADD COLUMN "send_intent" TEXT,
  ADD COLUMN "target_turn_id" UUID,
  ADD COLUMN "delivery_status" TEXT,
  ADD COLUMN "delivery_failure_code" TEXT,
  ADD COLUMN "delivery_failure_reason" TEXT,
  ADD COLUMN "delivery_terminal_at" TIMESTAMP(3),
  ADD COLUMN "delivery_acknowledged_at" TIMESTAMP(3);

-- PostgreSQL needs a matching unique key for the composite target FK below. `id` is already the
-- primary key; carrying session_id in this redundant identity is what lets the FK make cross-
-- session target corruption impossible rather than merely unlikely in application code.
CREATE UNIQUE INDEX "conversation_turn_session_id_id_key"
  ON "conversation_turn"("session_id", "id");

CREATE INDEX "conversation_turn_target_turn_id_idx"
  ON "conversation_turn"("target_turn_id");

-- All additions are nullable/additive for N-1 readers, but new writers are constrained to the
-- protocol shapes. NOT VALID avoids an ACCESS EXCLUSIVE table scan while the column is added;
-- VALIDATE takes the lower-impact validation lock and checks the existing (all-NULL) rows.
ALTER TABLE "conversation_turn"
  ADD CONSTRAINT "conversation_turn_request_fingerprint_check"
  CHECK (
    "request_fingerprint" IS NULL
    OR "request_fingerprint" ~ '^[0-9a-f]{64}$'
  ) NOT VALID;
ALTER TABLE "conversation_turn"
  VALIDATE CONSTRAINT "conversation_turn_request_fingerprint_check";

ALTER TABLE "conversation_turn"
  ADD CONSTRAINT "conversation_turn_send_intent_check"
  CHECK ("send_intent" IS NULL OR "send_intent" IN ('CURRENT_WORK', 'NEXT_TURN')) NOT VALID;
ALTER TABLE "conversation_turn"
  VALIDATE CONSTRAINT "conversation_turn_send_intent_check";

ALTER TABLE "conversation_turn"
  ADD CONSTRAINT "conversation_turn_send_intent_shape_check"
  CHECK (
    ("send_intent" IS NULL AND "target_turn_id" IS NULL)
    OR (
      "send_intent" = 'CURRENT_WORK'
      AND "kind" = 'steer'
      AND "target_turn_id" IS NOT NULL
      AND "target_turn_id" <> "id"
    )
    OR (
      "send_intent" = 'NEXT_TURN'
      AND "kind" IN ('message', 'shell')
      AND "target_turn_id" IS NULL
    )
  ) NOT VALID;
ALTER TABLE "conversation_turn"
  VALIDATE CONSTRAINT "conversation_turn_send_intent_shape_check";

ALTER TABLE "conversation_turn"
  ADD CONSTRAINT "conversation_turn_delivery_terminal_check"
  CHECK (
    (
      "delivery_status" IS NULL
      AND "delivery_failure_code" IS NULL
      AND "delivery_failure_reason" IS NULL
      AND "delivery_terminal_at" IS NULL
      AND "delivery_acknowledged_at" IS NULL
    )
    OR (
      "delivery_status" = 'ACKNOWLEDGED'
      AND "send_intent" = 'CURRENT_WORK'
      AND "kind" = 'steer'
      AND "delivery_failure_code" IS NULL
      AND "delivery_failure_reason" IS NULL
      AND "delivery_terminal_at" IS NULL
      AND "delivery_acknowledged_at" IS NOT NULL
    )
    OR (
      "delivery_status" = 'FAILED'
      AND "send_intent" = 'CURRENT_WORK'
      AND "kind" = 'steer'
      AND "status" = 'ANSWERED'
      AND "delivery_failure_code" IS NOT NULL
      AND "delivery_failure_reason" IS NOT NULL
      AND "delivery_terminal_at" IS NOT NULL
      AND "delivery_acknowledged_at" IS NULL
    )
    OR (
      "delivery_status" = 'UNCONFIRMED'
      AND "send_intent" = 'CURRENT_WORK'
      AND "kind" = 'steer'
      AND "status" = 'ANSWERED'
      AND "delivery_failure_code" IS NOT NULL
      AND "delivery_failure_reason" IS NOT NULL
      AND "delivery_terminal_at" IS NOT NULL
      AND "delivery_acknowledged_at" IS NULL
    )
  ) NOT VALID;
ALTER TABLE "conversation_turn"
  VALIDATE CONSTRAINT "conversation_turn_delivery_terminal_check";

ALTER TABLE "conversation_turn"
  ADD CONSTRAINT "conversation_turn_target_turn_id_fkey"
  FOREIGN KEY ("session_id", "target_turn_id")
  REFERENCES "conversation_turn"("session_id", "id")
  ON DELETE NO ACTION ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED NOT VALID;
ALTER TABLE "conversation_turn"
  VALIDATE CONSTRAINT "conversation_turn_target_turn_id_fkey";

CREATE TABLE "conversation_turn_startup_fragment" (
  "id" UUID NOT NULL,
  "session_id" UUID NOT NULL,
  "target_turn_id" UUID NOT NULL,
  "client_turn_id" TEXT NOT NULL,
  "content" TEXT NOT NULL,
  "delivered_at" TIMESTAMP(3),
  "delivery_status" TEXT,
  "acknowledged_at" TIMESTAMP(3),
  "failed_at" TIMESTAMP(3),
  "failure_code" TEXT,
  "failure_reason" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "conversation_turn_startup_fragment_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "conversation_turn_startup_fragment_session_id_fkey"
    FOREIGN KEY ("session_id") REFERENCES "session"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "conversation_turn_startup_fragment_target_turn_id_fkey"
    FOREIGN KEY ("session_id", "target_turn_id")
    REFERENCES "conversation_turn"("session_id", "id")
    ON DELETE NO ACTION ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED
);

ALTER TABLE "conversation_turn_startup_fragment"
  ADD CONSTRAINT "conversation_turn_startup_fragment_terminal_check"
  CHECK (
    (
      "delivery_status" IS NULL
      AND "acknowledged_at" IS NULL
      AND "failed_at" IS NULL
      AND "failure_code" IS NULL
      AND "failure_reason" IS NULL
    )
    OR
    (
      "delivery_status" = 'ACKNOWLEDGED'
      AND "acknowledged_at" IS NOT NULL
      AND "failed_at" IS NULL
      AND "failure_code" IS NULL
      AND "failure_reason" IS NULL
    )
    OR
    (
      "delivery_status" IN ('FAILED', 'UNCONFIRMED')
      AND "acknowledged_at" IS NULL
      AND "failed_at" IS NOT NULL
      AND "failure_code" IS NOT NULL
      AND "failure_reason" IS NOT NULL
    )
  ) NOT VALID;
ALTER TABLE "conversation_turn_startup_fragment"
  VALIDATE CONSTRAINT "conversation_turn_startup_fragment_terminal_check";

CREATE UNIQUE INDEX "conversation_turn_startup_session_client_key"
  ON "conversation_turn_startup_fragment"("session_id", "client_turn_id");
CREATE INDEX "conversation_turn_startup_target_created_idx"
  ON "conversation_turn_startup_fragment"("target_turn_id", "created_at", "id");

ALTER TABLE "attachment" ADD COLUMN "startup_fragment_id" UUID;
ALTER TABLE "attachment"
  ADD CONSTRAINT "attachment_startup_fragment_id_fkey"
  FOREIGN KEY ("startup_fragment_id") REFERENCES "conversation_turn_startup_fragment"("id")
  ON DELETE CASCADE ON UPDATE CASCADE NOT VALID;
ALTER TABLE "attachment"
  VALIDATE CONSTRAINT "attachment_startup_fragment_id_fkey";
ALTER TABLE "attachment"
  ADD CONSTRAINT "attachment_single_message_owner_check"
  CHECK (num_nonnulls("turn_id", "startup_fragment_id") <= 1) NOT VALID;
ALTER TABLE "attachment"
  VALIDATE CONSTRAINT "attachment_single_message_owner_check";
CREATE INDEX "attachment_startup_fragment_id_idx" ON "attachment"("startup_fragment_id");
