-- A HUMAN_SIGNOFF is a durable judgment, not an anonymous task.status edit. One event records the
-- signer, the server timestamp and the evidence that person relied on. `task_id` is unique because
-- one signature satisfies the criterion; a retried request reads the same event back.
CREATE TABLE "task_human_signoff" (
  "id" uuid NOT NULL,
  "task_id" uuid NOT NULL,
  "signed_by_id" uuid NOT NULL,
  "evidence" text NOT NULL,
  "signed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "task_human_signoff_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "task_human_signoff_evidence_nonblank"
    CHECK (length(btrim("evidence")) > 0),
  CONSTRAINT "task_human_signoff_task_id_fkey"
    FOREIGN KEY ("task_id") REFERENCES "task"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "task_human_signoff_signed_by_id_fkey"
    FOREIGN KEY ("signed_by_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "task_human_signoff_task_id_key"
  ON "task_human_signoff"("task_id");

CREATE INDEX "task_human_signoff_signed_by_id_signed_at_idx"
  ON "task_human_signoff"("signed_by_id", "signed_at" DESC);
