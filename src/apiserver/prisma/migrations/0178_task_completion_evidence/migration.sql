-- N10: completion evidence is an explicit append-only fact, never inferred from a Task comment,
-- a final assistant message, or a Session lifecycle state. These tables are additive and empty
-- on upgrade, so a mixed-version deployment keeps every pre-0178 path available.
CREATE TABLE "task_completion_evidence" (
  "id" uuid NOT NULL,
  "task_id" uuid NOT NULL,
  "owner_id" uuid NOT NULL,
  "actor_type" "creator_type" NOT NULL,
  "actor_id" uuid NOT NULL,
  "submitted_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "source_session_id" uuid NOT NULL,
  "source_attempt_id" uuid,
  "criterion_revision" char(64) NOT NULL,
  "criterion" jsonb NOT NULL,
  "evidence" jsonb NOT NULL,
  "evidence_digest" char(64) NOT NULL,
  "revision" bigint NOT NULL,

  CONSTRAINT "task_completion_evidence_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "task_completion_evidence_task_fkey"
    FOREIGN KEY ("task_id", "owner_id") REFERENCES "task"("id", "owner_id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "task_completion_evidence_revision_positive" CHECK ("revision" > 0),
  CONSTRAINT "task_completion_evidence_criterion_object" CHECK (jsonb_typeof("criterion") = 'object'),
  CONSTRAINT "task_completion_evidence_payload_object" CHECK (jsonb_typeof("evidence") = 'object'),
  CONSTRAINT "task_completion_evidence_criterion_digest" CHECK ("criterion_revision" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "task_completion_evidence_payload_digest" CHECK ("evidence_digest" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "task_completion_evidence_id_task_key" UNIQUE ("id", "task_id"),
  CONSTRAINT "task_completion_evidence_task_revision_key" UNIQUE ("task_id", "revision"),
  CONSTRAINT "task_completion_evidence_stable_fact_key" UNIQUE (
    "task_id", "actor_type", "actor_id", "source_session_id",
    "criterion_revision", "evidence_digest"
  )
);

CREATE INDEX "task_completion_evidence_task_submitted_idx"
  ON "task_completion_evidence" ("task_id", "submitted_at", "id");

CREATE TABLE "task_completion_evidence_idempotency" (
  "id" uuid NOT NULL,
  "task_id" uuid NOT NULL,
  "idempotency_key" text NOT NULL,
  "evidence_id" uuid NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "task_completion_evidence_idempotency_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "task_completion_evidence_idempotency_evidence_fkey"
    FOREIGN KEY ("evidence_id", "task_id")
    REFERENCES "task_completion_evidence"("id", "task_id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "task_completion_evidence_idempotency_key_nonempty"
    CHECK (length(btrim("idempotency_key")) BETWEEN 1 AND 200),
  CONSTRAINT "task_completion_evidence_idempotency_task_key"
    UNIQUE ("task_id", "idempotency_key")
);

CREATE INDEX "task_completion_evidence_idempotency_evidence_idx"
  ON "task_completion_evidence_idempotency" ("evidence_id");

COMMENT ON TABLE "task_completion_evidence" IS
  'Immutable structured completion-evidence revisions; never a Task status transition.';
COMMENT ON COLUMN "task_completion_evidence"."source_session_id" IS
  'Immutable provenance snapshot; intentionally no FK so Session retention cannot erase evidence.';
COMMENT ON COLUMN "task_completion_evidence"."source_attempt_id" IS
  'TaskAttempt identity when the source Session has one; NULL for legacy or manual runs.';
