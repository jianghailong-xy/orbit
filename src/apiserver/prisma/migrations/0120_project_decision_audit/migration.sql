-- Coordinator decision protocol: an internally consistent input snapshot, its deterministic
-- outcome and historical Agent/Session attribution. JSON ids are already Base62 on write; UUIDs
-- remain only in relational columns and in the internal idempotency ledger.
CREATE TABLE "project_decision" (
  "id" UUID NOT NULL,
  "project_id" UUID NOT NULL,
  "input_version" INTEGER NOT NULL,
  "decision_input_hash" CHAR(64) NOT NULL,
  "decision_input" JSONB NOT NULL,
  "outcome" JSONB NOT NULL,
  "decided_by" TEXT NOT NULL,
  "coordinator_agent_id" UUID,
  "coordinator_session_id" UUID,
  "fencing_token" BIGINT NOT NULL,
  "reason" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "project_decision_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "project_decision_input_version_chk" CHECK (
    "input_version" > 0
    AND ("decision_input"->>'v')::integer = "input_version"
  ),
  CONSTRAINT "project_decision_hash_chk" CHECK (
    "decision_input_hash" ~ '^[0-9a-f]{64}$'
    AND "decision_input"->>'decisionInputHash' = "decision_input_hash"
    AND "outcome"->>'decisionInputHash' = "decision_input_hash"
  ),
  CONSTRAINT "project_decision_actor_chk" CHECK (
    "decided_by" IN ('ORCHESTRATOR', 'COORDINATOR_AGENT')
  ),
  CONSTRAINT "project_decision_fencing_token_chk" CHECK ("fencing_token" > 0),
  CONSTRAINT "project_decision_id_project_id_key" UNIQUE ("id", "project_id")
);

ALTER TABLE "project_decision" ADD CONSTRAINT "project_decision_project_id_fkey"
  FOREIGN KEY ("project_id") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- The composite key is the database proof that an action cannot cite another Project's decision.
-- Existing 0119 actions remain nullable for rolling deployment; every action written through the
-- v1 decision protocol supplies both columns.
ALTER TABLE "project_action" ADD CONSTRAINT "project_action_decision_project_fkey"
  FOREIGN KEY ("decision_id", "project_id")
  REFERENCES "project_decision"("id", "project_id") ON DELETE NO ACTION ON UPDATE CASCADE;

CREATE INDEX "project_decision_project_id_created_at_idx"
  ON "project_decision"("project_id", "created_at");
CREATE INDEX "project_decision_project_id_input_hash_idx"
  ON "project_decision"("project_id", "decision_input_hash");

-- Audit contents are append-only. Project deletion may still cascade the whole audit as declared
-- by the Project lifecycle; no writer may revise an individual historical judgment in place.
CREATE OR REPLACE FUNCTION "project_decision_immutable_guard"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION USING
    ERRCODE = '23514',
    MESSAGE = format('PROJECT_DECISION_IMMUTABLE: decision %s cannot be updated', OLD."id");
END;
$$;

CREATE TRIGGER "project_decision_immutable_guard"
BEFORE UPDATE ON "project_decision"
FOR EACH ROW EXECUTE FUNCTION "project_decision_immutable_guard"();

-- A nullable 0119 action may be attributed once during a rolling upgrade, but a non-null lineage
-- is historical and cannot be detached, moved to another decision or moved across Projects.
CREATE OR REPLACE FUNCTION "project_action_decision_link_guard"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."decision_id" IS NOT NULL AND (
       NEW."decision_id" IS DISTINCT FROM OLD."decision_id"
       OR NEW."project_id" IS DISTINCT FROM OLD."project_id"
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = format('ACTION_DECISION_LINK_FROZEN: action %s cannot change decision lineage', OLD."id");
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "project_action_decision_link_guard"
BEFORE UPDATE OF "decision_id", "project_id" ON "project_action"
FOR EACH ROW EXECUTE FUNCTION "project_action_decision_link_guard"();
