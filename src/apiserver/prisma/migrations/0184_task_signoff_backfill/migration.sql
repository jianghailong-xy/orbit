-- N8: migration metadata and operator ledgers only. This migration deliberately does NOT scan
-- Task, infer evidence from comments, create requests, or update Task.status. The separately
-- invoked, bounded backfill owns those decisions after an operator has inspected the scale.

CREATE TYPE "task_judgment_request_origin" AS ENUM (
  'LIVE_EVIDENCE', 'LEGACY_IMPORT', 'BACKFILL'
);

CREATE TYPE "task_judgment_device_policy" AS ENUM (
  'IMMEDIATE', 'IN_APP_ONLY'
);

CREATE TABLE "task_judgment_backfill_batch" (
  "id" uuid NOT NULL,
  "owner_id" uuid NOT NULL,
  "actor_type" "creator_type" NOT NULL,
  "actor_id" uuid NOT NULL,
  "idempotency_key" text NOT NULL,
  "input_digest" char(64) NOT NULL,
  "batch_size" integer NOT NULL,
  "push_task_ids" uuid[] NOT NULL DEFAULT ARRAY[]::uuid[],
  "selection" jsonb NOT NULL,
  "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "finished_at" TIMESTAMP(3),
  "scanned_count" integer,
  "request_count" integer,
  "inbox_count" integer,
  "push_selected_count" integer,
  "push_suppressed_count" integer,
  "duration_ms" bigint,

  CONSTRAINT "task_judgment_backfill_batch_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "task_judgment_backfill_batch_owner_fkey"
    FOREIGN KEY ("owner_id") REFERENCES "user"("id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "task_judgment_backfill_batch_key_nonblank"
    CHECK (length(btrim("idempotency_key")) BETWEEN 1 AND 200),
  CONSTRAINT "task_judgment_backfill_batch_digest"
    CHECK ("input_digest" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "task_judgment_backfill_batch_size"
    CHECK ("batch_size" BETWEEN 1 AND 1000),
  CONSTRAINT "task_judgment_backfill_batch_selection_object"
    CHECK (jsonb_typeof("selection") = 'object'),
  CONSTRAINT "task_judgment_backfill_batch_counts"
    CHECK (
      ("finished_at" IS NULL
        AND "scanned_count" IS NULL AND "request_count" IS NULL
        AND "inbox_count" IS NULL AND "push_selected_count" IS NULL
        AND "push_suppressed_count" IS NULL AND "duration_ms" IS NULL)
      OR
      ("finished_at" IS NOT NULL
        AND "scanned_count" >= 0 AND "request_count" >= 0
        AND "inbox_count" >= 0 AND "push_selected_count" >= 0
        AND "push_suppressed_count" >= 0 AND "duration_ms" >= 0
        AND "request_count" = "inbox_count"
        AND "request_count" = "push_selected_count" + "push_suppressed_count")
    ),
  CONSTRAINT "task_judgment_backfill_batch_owner_key"
    UNIQUE ("owner_id", "idempotency_key")
);

CREATE INDEX "task_judgment_backfill_batch_owner_started_idx"
  ON "task_judgment_backfill_batch"("owner_id", "started_at" DESC);

ALTER TABLE "task_judgment_request"
  ADD COLUMN "origin" "task_judgment_request_origin"
    NOT NULL DEFAULT 'LIVE_EVIDENCE',
  ADD COLUMN "device_policy" "task_judgment_device_policy"
    NOT NULL DEFAULT 'IMMEDIATE',
  ADD COLUMN "backfill_batch_id" uuid,
  ADD CONSTRAINT "task_judgment_request_backfill_batch_fkey"
    FOREIGN KEY ("backfill_batch_id") REFERENCES "task_judgment_backfill_batch"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "task_judgment_request_origin_shape" CHECK (
    ("origin" = 'BACKFILL' AND "backfill_batch_id" IS NOT NULL)
    OR ("origin" <> 'BACKFILL' AND "backfill_batch_id" IS NULL)
  );

CREATE INDEX "task_judgment_request_backfill_batch_idx"
  ON "task_judgment_request"("backfill_batch_id")
  WHERE "backfill_batch_id" IS NOT NULL;

-- Origin, notification policy and batch attribution are immutable parts of request identity.
CREATE FUNCTION "task_judgment_request_migration_metadata_guard"() RETURNS trigger AS $$
BEGIN
  IF ROW(NEW."origin", NEW."device_policy", NEW."backfill_batch_id") IS DISTINCT FROM
     ROW(OLD."origin", OLD."device_policy", OLD."backfill_batch_id") THEN
    RAISE EXCEPTION 'TASK_JUDGMENT_REQUEST_MIGRATION_METADATA_IMMUTABLE';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "task_judgment_request_migration_metadata_guard"
  BEFORE UPDATE OF "origin", "device_policy", "backfill_batch_id"
  ON "task_judgment_request"
  FOR EACH ROW EXECUTE FUNCTION "task_judgment_request_migration_metadata_guard"();

-- A comment address is paired with its task so an import cannot point at another task's prose.
ALTER TABLE "task_comment"
  ADD CONSTRAINT "task_comment_id_task_id_key" UNIQUE ("id", "task_id");

CREATE TABLE "task_legacy_evidence_import" (
  "id" uuid NOT NULL,
  "task_id" uuid NOT NULL,
  "owner_id" uuid NOT NULL,
  "evidence_id" uuid NOT NULL,
  "source_comment_id" uuid NOT NULL,
  "source_session_id" uuid NOT NULL,
  "source_author_type" "creator_type" NOT NULL,
  "source_author_id" uuid NOT NULL,
  "source_created_at" TIMESTAMP(3) NOT NULL,
  "source_digest" char(64) NOT NULL,
  "structured_evidence_digest" char(64) NOT NULL,
  "imported_by_id" uuid NOT NULL,
  "imported_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "idempotency_key" text NOT NULL,
  "review_note" text NOT NULL,
  "device_policy" "task_judgment_device_policy" NOT NULL,

  CONSTRAINT "task_legacy_evidence_import_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "task_legacy_evidence_import_task_fkey"
    FOREIGN KEY ("task_id", "owner_id") REFERENCES "task"("id", "owner_id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "task_legacy_evidence_import_evidence_fkey"
    FOREIGN KEY ("evidence_id", "task_id")
    REFERENCES "task_completion_evidence"("id", "task_id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "task_legacy_evidence_import_comment_fkey"
    FOREIGN KEY ("source_comment_id", "task_id")
    REFERENCES "task_comment"("id", "task_id")
    ON DELETE NO ACTION ON UPDATE CASCADE,
  CONSTRAINT "task_legacy_evidence_import_reviewer_fkey"
    FOREIGN KEY ("imported_by_id") REFERENCES "user"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "task_legacy_evidence_import_reviewer_is_owner"
    CHECK ("imported_by_id" = "owner_id"),
  CONSTRAINT "task_legacy_evidence_import_source_digest"
    CHECK ("source_digest" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "task_legacy_evidence_import_structured_digest"
    CHECK ("structured_evidence_digest" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "task_legacy_evidence_import_key_nonblank"
    CHECK (length(btrim("idempotency_key")) BETWEEN 1 AND 200),
  CONSTRAINT "task_legacy_evidence_import_review_nonblank"
    CHECK (length(btrim("review_note")) > 0),
  CONSTRAINT "task_legacy_evidence_import_evidence_key" UNIQUE ("evidence_id", "task_id"),
  CONSTRAINT "task_legacy_evidence_import_source_key" UNIQUE ("task_id", "source_comment_id"),
  CONSTRAINT "task_legacy_evidence_import_idempotency_key"
    UNIQUE ("task_id", "idempotency_key")
);

CREATE INDEX "task_legacy_evidence_import_reviewer_idx"
  ON "task_legacy_evidence_import"("imported_by_id", "imported_at" DESC);
CREATE INDEX "task_legacy_evidence_import_source_session_idx"
  ON "task_legacy_evidence_import"("source_session_id");

-- The import receipt is append-only. Deleting its Task still cascades the whole task-owned audit
-- tree, but no caller can rewrite who reviewed which immutable source after the fact.
CREATE FUNCTION "task_legacy_evidence_import_immutable"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'TASK_LEGACY_EVIDENCE_IMPORT_IMMUTABLE';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "task_legacy_evidence_import_immutable"
  BEFORE UPDATE ON "task_legacy_evidence_import"
  FOR EACH ROW EXECUTE FUNCTION "task_legacy_evidence_import_immutable"();

-- Replace N12's filing function: every human request still receives its durable in-app item and a
-- device-delivery ledger row in the request transaction. IN_APP_ONLY is recorded as a terminal,
-- zero-attempt cancellation instead of due work, so a large backfill cannot become an APNs storm.
CREATE OR REPLACE FUNCTION "task_judgment_delivery_file"() RETURNS trigger AS $$
DECLARE
  inbox_id uuid;
  task_title text;
  project_id uuid;
  project_title text;
  delivery_status "task_judgment_push_delivery_status";
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

  delivery_status := CASE NEW."device_policy"
    WHEN 'IMMEDIATE' THEN 'PENDING'::"task_judgment_push_delivery_status"
    ELSE 'CANCELLED'::"task_judgment_push_delivery_status"
  END;
  INSERT INTO "task_judgment_push_delivery" (
    "id", "inbox_item_id", "request_id", "request_version",
    "logical_notification_key", "collapse_id", "status", "next_attempt_at",
    "error_code", "last_error", "stopped_at"
  ) VALUES (
    gen_random_uuid(), inbox_id, NEW."id", 1,
    'task-judgment:' || NEW."id"::text || ':v1',
    'judgment-' || NEW."recipient_id", delivery_status,
    CASE WHEN delivery_status = 'PENDING' THEN statement_timestamp() ELSE NULL END,
    CASE WHEN delivery_status = 'CANCELLED' THEN 'POLICY_IN_APP_ONLY' ELSE NULL END,
    CASE WHEN delivery_status = 'CANCELLED'
      THEN 'Device push was explicitly suppressed; the durable in-app item remains delivered.'
      ELSE NULL END,
    CASE WHEN delivery_status = 'CANCELLED' THEN statement_timestamp() ELSE NULL END
  )
  ON CONFLICT ("inbox_item_id") DO NOTHING;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

COMMENT ON TABLE "task_legacy_evidence_import" IS
  'Explicit user-reviewed conversion of one immutable TaskComment source into structured evidence.';
COMMENT ON TABLE "task_judgment_backfill_batch" IS
  'One bounded, replayable operator invocation; no row is created by schema migration itself.';
COMMENT ON COLUMN "task_judgment_request"."device_policy" IS
  'IMMEDIATE creates due device work; IN_APP_ONLY records a terminal suppressed delivery ledger.';
