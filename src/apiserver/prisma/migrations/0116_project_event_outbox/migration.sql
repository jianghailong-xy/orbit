-- Project events are dirty signals, not business facts. A producer inserts/upserts this row in
-- the SAME transaction as its authoritative write; the consumer marks it consumed in the SAME
-- transaction as the effects of re-reading and reconciling the current Project state.
CREATE TABLE "project_event" (
    "id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "v" INTEGER NOT NULL DEFAULT 1,
    "kind" TEXT NOT NULL,
    "occurred_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "source_type" TEXT NOT NULL,
    "source_id" UUID NOT NULL,
    "dedupe_key" TEXT NOT NULL,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "occurrences" INTEGER NOT NULL DEFAULT 1,
    "last_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "next_attempt_at" TIMESTAMP(3),
    "consumed_at" TIMESTAMP(3),
    "disposition" TEXT,

    CONSTRAINT "project_event_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "project_event_v_chk" CHECK ("v" > 0),
    CONSTRAINT "project_event_source_type_chk" CHECK (
      "source_type" IN ('TASK', 'SESSION', 'RUNNER', 'PROVIDER', 'MERGE', 'USER', 'TIMER')
    ),
    CONSTRAINT "project_event_counters_chk" CHECK ("occurrences" > 0 AND "attempts" >= 0),
    CONSTRAINT "project_event_disposition_chk" CHECK (
      ("consumed_at" IS NULL AND "disposition" IS NULL)
      OR
      ("consumed_at" IS NOT NULL AND "disposition" IS NOT NULL AND "disposition" IN (
        'RECONCILED', 'DISCARDED_OUT_OF_LOOP', 'DEAD'
      ))
    )
);

ALTER TABLE "project_event" ADD CONSTRAINT "project_event_project_id_fkey"
    FOREIGN KEY ("project_id") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Prisma cannot express either partial predicate. The first is the outbox's coalescing point:
-- one cause has one pending row, while a later occurrence after consumption is a new signal. The
-- second is the retry/restart scan and is also the index the liveness backstop will use later.
CREATE UNIQUE INDEX "project_event_open_dedupe_idx"
    ON "project_event"("project_id", "dedupe_key") WHERE "consumed_at" IS NULL;
CREATE INDEX "project_event_due_idx"
    ON "project_event"("next_attempt_at") WHERE "consumed_at" IS NULL;
CREATE INDEX "project_event_project_id_idx" ON "project_event"("project_id");

-- NOTIFY is only a latency accelerator. Because this trigger fires inside the producer's
-- transaction, PostgreSQL emits the notification only after COMMIT; a crash or lost notification
-- leaves the durable row for the polling path. Updating occurrences covers a coalesced signal.
CREATE OR REPLACE FUNCTION "project_event_notify_pending"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_notify('project_event', NEW."project_id"::text);
  RETURN NULL;
END;
$$;

CREATE TRIGGER "project_event_notify_pending"
AFTER INSERT OR UPDATE OF "occurrences", "next_attempt_at" ON "project_event"
FOR EACH ROW WHEN (NEW."consumed_at" IS NULL)
EXECUTE FUNCTION "project_event_notify_pending"();
