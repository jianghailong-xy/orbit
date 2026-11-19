-- K7 request facts. Session and consuming promotion are immutable history references.
CREATE TABLE "project_promotion_request" (
  "id" uuid PRIMARY KEY,
  "project_id" uuid NOT NULL REFERENCES "project"("id") ON DELETE CASCADE,
  "session_id" uuid NOT NULL,
  "reason" text NOT NULL CHECK (length(btrim("reason")) BETWEEN 1 AND 2000),
  "created_at" timestamptz(6) NOT NULL DEFAULT now(),
  "consumed_by_promotion_id" uuid
);
CREATE INDEX "project_promotion_request_project_id_created_at_idx"
  ON "project_promotion_request" ("project_id", "created_at");
