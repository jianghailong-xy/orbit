-- N12: an OPEN HUMAN_SIGNOFF request is put in front of its human recipient in the same
-- transaction that creates the request. The in-app item is the reliable primary channel; APNs is
-- a retryable projection with its own receipt, lease and failure budget.

CREATE TYPE "task_judgment_push_delivery_status" AS ENUM (
  'PENDING', 'DELIVERING', 'DELIVERED', 'BLOCKED', 'DEAD', 'CANCELLED'
);

CREATE TABLE "task_judgment_inbox_item" (
  "id" uuid NOT NULL,
  "request_id" uuid NOT NULL,
  -- Requests are immutable today, so their first delivery contract is version 1. Keeping the
  -- version in the identity lets a later request protocol revise delivery without aliasing an old
  -- notification or rewriting its receipt.
  "request_version" integer NOT NULL DEFAULT 1,
  "task_id" uuid NOT NULL,
  "owner_id" uuid NOT NULL,
  "recipient_id" uuid NOT NULL,
  -- Display snapshots: this is what was delivered, not a mutable rendering reconstructed later.
  "project_id" uuid,
  "project_title" text,
  "task_title" text NOT NULL,
  "required_action" text NOT NULL,
  "deep_link" text NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "delivered_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "task_judgment_inbox_item_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "task_judgment_inbox_request_fkey"
    FOREIGN KEY ("request_id") REFERENCES "task_judgment_request"("id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "task_judgment_inbox_task_owner_fkey"
    FOREIGN KEY ("task_id", "owner_id") REFERENCES "task"("id", "owner_id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "task_judgment_inbox_request_version_positive"
    CHECK ("request_version" > 0),
  CONSTRAINT "task_judgment_inbox_recipient_is_owner"
    CHECK ("recipient_id" = "owner_id"),
  CONSTRAINT "task_judgment_inbox_copy_nonblank"
    CHECK (length(btrim("task_title")) > 0
      AND length(btrim("required_action")) > 0
      AND length(btrim("deep_link")) > 0),
  CONSTRAINT "task_judgment_inbox_request_version_key"
    UNIQUE ("request_id", "request_version"),
  CONSTRAINT "task_judgment_inbox_delivery_fkey"
    UNIQUE ("id", "request_id", "request_version")
);

CREATE INDEX "task_judgment_inbox_recipient_idx"
  ON "task_judgment_inbox_item"("recipient_id", "delivered_at" DESC);
CREATE INDEX "task_judgment_inbox_task_idx"
  ON "task_judgment_inbox_item"("task_id", "delivered_at" DESC);

CREATE TABLE "task_judgment_push_delivery" (
  "id" uuid NOT NULL,
  "inbox_item_id" uuid NOT NULL,
  "request_id" uuid NOT NULL,
  "request_version" integer NOT NULL,
  "logical_notification_key" text NOT NULL,
  -- Shared by a recipient's judgment requests. APNs may replace a burst with the newest summary,
  -- while the table still retains one row and one receipt per request/version.
  "collapse_id" text NOT NULL,
  "status" "task_judgment_push_delivery_status" NOT NULL DEFAULT 'PENDING',
  -- Every transport pass, availability included. `failures` alone spends the DEAD budget.
  "attempts" integer NOT NULL DEFAULT 0,
  "failures" integer NOT NULL DEFAULT 0,
  -- Consecutive expired worker leases, reset whenever a worker records an outcome.
  "claims" integer NOT NULL DEFAULT 0,
  "next_attempt_at" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP,
  "lease_holder" text,
  "lease_expires_at" TIMESTAMP(3),
  "last_attempt_at" TIMESTAMP(3),
  "error_code" text,
  "required_action" text,
  "last_error" text,
  "last_payload" jsonb,
  "delivered_devices" integer,
  "delivered_at" TIMESTAMP(3),
  "stopped_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "task_judgment_push_delivery_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "task_judgment_push_inbox_item_key" UNIQUE ("inbox_item_id"),
  CONSTRAINT "task_judgment_push_logical_key" UNIQUE ("logical_notification_key"),
  CONSTRAINT "task_judgment_push_inbox_request_version_key"
    UNIQUE ("inbox_item_id", "request_id", "request_version"),
  CONSTRAINT "task_judgment_push_request_version_key"
    UNIQUE ("request_id", "request_version"),
  CONSTRAINT "task_judgment_push_inbox_fkey"
    FOREIGN KEY ("inbox_item_id", "request_id", "request_version")
    REFERENCES "task_judgment_inbox_item"("id", "request_id", "request_version")
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "task_judgment_push_counters_nonnegative"
    CHECK ("attempts" >= 0 AND "failures" >= 0 AND "claims" >= 0
      AND "failures" <= "attempts"),
  CONSTRAINT "task_judgment_push_copy_nonblank"
    CHECK (length(btrim("logical_notification_key")) > 0
      AND length(btrim("collapse_id")) > 0),
  CONSTRAINT "task_judgment_push_device_count"
    CHECK ("delivered_devices" IS NULL OR "delivered_devices" > 0),
  -- Every state carries exactly the scheduling/lease/terminal fields that make it true. A raw
  -- writer cannot label a row DELIVERED without a receipt or leave terminal work due again.
  CONSTRAINT "task_judgment_push_lifecycle" CHECK (
    ("status" IN ('PENDING', 'BLOCKED')
      AND "next_attempt_at" IS NOT NULL
      AND "lease_holder" IS NULL AND "lease_expires_at" IS NULL
      AND "delivered_at" IS NULL AND "stopped_at" IS NULL
      AND "delivered_devices" IS NULL) OR
    ("status" = 'DELIVERING'
      AND "next_attempt_at" IS NULL
      AND "lease_holder" IS NOT NULL AND "lease_expires_at" IS NOT NULL
      AND "delivered_at" IS NULL AND "stopped_at" IS NULL
      AND "delivered_devices" IS NULL) OR
    ("status" = 'DELIVERED'
      AND "next_attempt_at" IS NULL
      AND "lease_holder" IS NULL AND "lease_expires_at" IS NULL
      AND "delivered_at" IS NOT NULL AND "stopped_at" IS NULL
      AND "delivered_devices" IS NOT NULL) OR
    ("status" IN ('DEAD', 'CANCELLED')
      AND "next_attempt_at" IS NULL
      AND "lease_holder" IS NULL AND "lease_expires_at" IS NULL
      AND "delivered_at" IS NULL AND "stopped_at" IS NOT NULL
      AND "delivered_devices" IS NULL)
  )
);

-- Only retryable work participates. A stable terminal receipt never returns to the worker scan.
CREATE INDEX "task_judgment_push_due_idx"
  ON "task_judgment_push_delivery"("next_attempt_at", "created_at")
  WHERE "status" IN ('PENDING', 'BLOCKED');
CREATE INDEX "task_judgment_push_status_idx"
  ON "task_judgment_push_delivery"("status", "updated_at");

-- Filing the primary inbox item and its device outbox IS the HUMAN_SIGNOFF request insert. This
-- trigger is deliberately below the N11 identity constraints: a blank or mismatched recipient is
-- rejected, never turned into an inbox row whose address was guessed.
CREATE FUNCTION "task_judgment_delivery_file"() RETURNS trigger AS $$
DECLARE
  inbox_id uuid;
  task_title text;
  project_id uuid;
  project_title text;
BEGIN
  IF NEW."kind" <> 'HUMAN_SIGNOFF' OR NEW."status" <> 'OPEN' THEN
    RETURN NEW;
  END IF;
  IF NEW."recipient_type" <> 'ACCOUNT_OWNER'
     OR NEW."recipient_id" <> NEW."owner_id"::text THEN
    RAISE EXCEPTION 'TASK_JUDGMENT_HUMAN_RECIPIENT_REQUIRED';
  END IF;

  SELECT task."title", task."project_id", project."title"
    INTO task_title, project_id, project_title
    FROM "task" task
    LEFT JOIN "project" project ON project."id" = task."project_id"
   WHERE task."id" = NEW."task_id" AND task."owner_id" = NEW."owner_id";
  IF NOT FOUND THEN
    RAISE EXCEPTION 'TASK_JUDGMENT_INBOX_TASK_REQUIRED';
  END IF;

  INSERT INTO "task_judgment_inbox_item" (
    "id", "request_id", "request_version", "task_id", "owner_id", "recipient_id",
    "project_id", "project_title", "task_title", "required_action", "deep_link",
    "created_at", "delivered_at"
  ) VALUES (
    gen_random_uuid(), NEW."id", 1, NEW."task_id", NEW."owner_id", NEW."recipient_id"::uuid,
    project_id, project_title, task_title, 'REVIEW_EVIDENCE_AND_SIGN_OFF',
    '/tasks/' || NEW."task_id"::text || '?judgmentRequest=' || NEW."id"::text,
    statement_timestamp(), statement_timestamp()
  )
  ON CONFLICT ("request_id", "request_version") DO NOTHING
  RETURNING "id" INTO inbox_id;

  IF inbox_id IS NULL THEN
    SELECT "id" INTO inbox_id FROM "task_judgment_inbox_item"
     WHERE "request_id" = NEW."id" AND "request_version" = 1;
  END IF;

  INSERT INTO "task_judgment_push_delivery" (
    "id", "inbox_item_id", "request_id", "request_version",
    "logical_notification_key", "collapse_id"
  ) VALUES (
    gen_random_uuid(), inbox_id, NEW."id", 1,
    'task-judgment:' || NEW."id"::text || ':v1',
    'judgment-' || NEW."recipient_id"
  )
  ON CONFLICT ("inbox_item_id") DO NOTHING;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "task_judgment_delivery_file"
  AFTER INSERT ON "task_judgment_request"
  FOR EACH ROW EXECUTE FUNCTION "task_judgment_delivery_file"();

-- Backfill any N11 request that committed before this migration. Only OPEN human requests need an
-- actionable inbox item; DECIDED/SUPERSEDED history had already reached its decision boundary.
INSERT INTO "task_judgment_inbox_item" (
  "id", "request_id", "request_version", "task_id", "owner_id", "recipient_id",
  "project_id", "project_title", "task_title", "required_action", "deep_link",
  "created_at", "delivered_at"
)
SELECT gen_random_uuid(), request."id", 1, request."task_id", request."owner_id",
       request."recipient_id"::uuid, task."project_id", project."title", task."title",
       'REVIEW_EVIDENCE_AND_SIGN_OFF',
       '/tasks/' || request."task_id"::text || '?judgmentRequest=' || request."id"::text,
       request."created_at", statement_timestamp()
  FROM "task_judgment_request" request
  JOIN "task" task ON task."id" = request."task_id" AND task."owner_id" = request."owner_id"
  LEFT JOIN "project" project ON project."id" = task."project_id"
 WHERE request."kind" = 'HUMAN_SIGNOFF'
   AND request."recipient_type" = 'ACCOUNT_OWNER'
   AND request."recipient_id" = request."owner_id"::text
   AND request."status" = 'OPEN'
ON CONFLICT ("request_id", "request_version") DO NOTHING;

INSERT INTO "task_judgment_push_delivery" (
  "id", "inbox_item_id", "request_id", "request_version",
  "logical_notification_key", "collapse_id"
)
SELECT gen_random_uuid(), inbox."id", inbox."request_id", inbox."request_version",
       'task-judgment:' || inbox."request_id"::text || ':v' || inbox."request_version"::text,
       'judgment-' || inbox."recipient_id"::text
  FROM "task_judgment_inbox_item" inbox
ON CONFLICT ("inbox_item_id") DO NOTHING;

-- A decision or supersession ends future device attempts in the same transaction that ends the
-- request. Successful receipts and exhausted DEAD receipts are historical facts and stay intact.
CREATE FUNCTION "task_judgment_delivery_stop"() RETURNS trigger AS $$
BEGIN
  IF OLD."status" = 'OPEN' AND NEW."status" <> 'OPEN' THEN
    UPDATE "task_judgment_push_delivery" delivery
       SET "status" = 'CANCELLED',
           "next_attempt_at" = NULL,
           "lease_holder" = NULL,
           "lease_expires_at" = NULL,
           "claims" = 0,
           "error_code" = CASE NEW."status"
             WHEN 'DECIDED' THEN 'REQUEST_DECIDED'
             ELSE 'REQUEST_SUPERSEDED'
           END,
           "required_action" = NULL,
           "last_error" = CASE NEW."status"
             WHEN 'DECIDED' THEN 'Judgment request was decided before device delivery.'
             ELSE 'Judgment request was superseded before device delivery.'
           END,
           "stopped_at" = statement_timestamp(),
           "updated_at" = statement_timestamp()
      FROM "task_judgment_inbox_item" inbox
     WHERE inbox."request_id" = NEW."id"
       AND delivery."inbox_item_id" = inbox."id"
       AND delivery."status" IN ('PENDING', 'DELIVERING', 'BLOCKED');
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "task_judgment_delivery_stop"
  AFTER UPDATE OF "status" ON "task_judgment_request"
  FOR EACH ROW EXECUTE FUNCTION "task_judgment_delivery_stop"();
