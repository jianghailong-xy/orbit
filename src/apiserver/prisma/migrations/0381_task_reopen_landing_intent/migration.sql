-- 0381 — remember the explicit task_reopen door until its next DONE.
--
-- A plain DONE -> IN_PROGRESS edit is an ordinary continuation of the same work session.  The
-- task_reopen door is different: its next DONE starts a new landing generation that takes over
-- earlier integration cards.  Keep that distinction as a one-row, transactional intent rather
-- than inferring it from a later status (which is already IN_PROGRESS by the time the run ends).

BEGIN;

CREATE TABLE "task_reopen_intent" (
  "task_id" uuid NOT NULL,
  "created_at" timestamptz(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "task_reopen_intent_pkey" PRIMARY KEY ("task_id"),
  CONSTRAINT "task_reopen_intent_task_fkey"
    FOREIGN KEY ("task_id") REFERENCES "task"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

COMMIT;
