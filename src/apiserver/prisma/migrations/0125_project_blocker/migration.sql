-- Structured blockers (contract §11), and the durable half of §10.4's wake.
--
-- Everything the control loop has so far been able to say about "this did not go forward" is a
-- refused action row, which answers what was refused and not who can fix it, what would clear it,
-- or when to look again. §11.1 names those five questions and BL1 leaves no third option: a pass
-- that does not advance lands on one of these rows or on a `NOOP` audit line that says why.
--
-- Three of the columns exist because ONE of them was answering three questions in v1 and getting
-- two of them wrong. `owner` decides `run_state` (§4.2 guards 2/3). `recovery` decides the clock
-- (§10.4). `kind` decides whether the coordinator is woken (§7.2). BUDGET_EXHAUSTED is the row
-- that proved they are three: the person who can raise a budget is the user, so v1 wrote
-- owner = USER, which made the state AWAITING_HUMAN, which made `next_wake_at` NULL — and a wait
-- that ends by itself in six hours became a wait for somebody nobody had told (`PC-CX-05`).

CREATE TYPE "project_blocker_owner" AS ENUM ('USER', 'COORDINATOR', 'SYSTEM');
CREATE TYPE "project_blocker_recovery" AS ENUM ('TIME', 'EVENT', 'HUMAN');
CREATE TYPE "project_blocker_severity" AS ENUM ('INFO', 'WARNING', 'CRITICAL');
CREATE TYPE "project_blocker_resolved_by" AS ENUM ('AUTO', 'USER', 'COORDINATOR');

CREATE TABLE "project_blocker" (
  "id"                   UUID PRIMARY KEY,
  "project_id"           UUID NOT NULL,

  "kind"                 TEXT NOT NULL,
  "owner"                "project_blocker_owner" NOT NULL,
  "recovery"             "project_blocker_recovery" NOT NULL,
  "severity"             "project_blocker_severity" NOT NULL,
  "required_action"      TEXT NOT NULL,
  "next_check_at"        TIMESTAMP(3) NOT NULL,

  "subject_type"         TEXT NOT NULL,
  "subject_id"           TEXT NOT NULL,
  "detail"               JSONB NOT NULL DEFAULT '{}'::jsonb,

  "dedupe_key"           TEXT NOT NULL,
  "lifecycle_generation" BIGINT NOT NULL,
  "condition_version"    CHAR(64) NOT NULL,

  "first_seen_at"        TIMESTAMP(3) NOT NULL,
  "last_seen_at"         TIMESTAMP(3) NOT NULL,
  "occurrences"          INTEGER NOT NULL DEFAULT 1,

  "escalated_at"         TIMESTAMP(3),
  "resolved_at"          TIMESTAMP(3),
  "resolved_by"          "project_blocker_resolved_by",

  "created_at"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"           TIMESTAMP(3) NOT NULL
);

ALTER TABLE "project_blocker" ADD CONSTRAINT "project_blocker_project_id_fkey"
  FOREIGN KEY ("project_id") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- §11.2's closed set, declared where every writer meets it. A CHECK rather than an enum because
-- the first six values ARE PAC §12's refusal codes: they are carried across verbatim so that one
-- event does not end up with two names in two contracts, and a second enum spelling them is a
-- second place for them to drift from.
ALTER TABLE "project_blocker" ADD CONSTRAINT "project_blocker_kind_chk"
  CHECK ("kind" IN (
    'WHO_UNRESOLVED', 'WHO_NOT_IN_TEAM', 'WHO_DISABLED', 'PROVIDER_UNAVAILABLE',
    'RUNTIME_REQUIREMENT_UNMET', 'NO_PROJECT_WORKSPACE', 'NO_MATCHING_RUNNER',
    'MERGE_CONFLICT', 'TEST_FAILED', 'VERIFICATION_FAILED', 'BUDGET_EXHAUSTED',
    'AWAITING_USER_APPROVAL', 'AWAITING_USER_INPUT', 'POLICY_MANUAL_HOLD',
    'DEPENDENCY_CYCLE', 'COORDINATOR_UNAVAILABLE', 'COORDINATOR_NO_PROGRESS',
    'UNKNOWN_FAILURE'
  ));

ALTER TABLE "project_blocker" ADD CONSTRAINT "project_blocker_subject_type_chk"
  CHECK ("subject_type" IN ('PROJECT', 'TASK', 'SESSION', 'PROVIDER', 'RUNNER', 'WORKSPACE', 'ACTION'));

-- §11.3 BE1: generations start at 1 and are allocated as `MAX + 1` over the key's whole history.
ALTER TABLE "project_blocker" ADD CONSTRAINT "project_blocker_generation_chk"
  CHECK ("lifecycle_generation" >= 1);

-- BL7's other half: `occurrences` counts observations, so it can only go up, and it starts at the
-- observation that opened the row.
ALTER TABLE "project_blocker" ADD CONSTRAINT "project_blocker_occurrences_chk"
  CHECK ("occurrences" >= 1);

-- Resolution is one fact in two columns, so neither may be written without the other. Without this
-- a row can be resolved by nobody, which reads on the audit as "it cleared itself" — the exact
-- claim §11.4 makes on purpose and only for AUTO.
ALTER TABLE "project_blocker" ADD CONSTRAINT "project_blocker_resolution_chk"
  CHECK (("resolved_at" IS NULL) = ("resolved_by" IS NULL));

ALTER TABLE "project_blocker" ADD CONSTRAINT "project_blocker_seen_order_chk"
  CHECK ("last_seen_at" >= "first_seen_at");

-- §11.3: ONE open episode per key. This is the whole of AC8's dedupe — a repeated cause is a
-- repeated key, the insert conflicts, and the pass reads the existing row and bumps its two display
-- columns instead of opening a second blocker and sending a second notification.
CREATE UNIQUE INDEX "project_blocker_open_dedupe_idx"
  ON "project_blocker" ("project_id", "dedupe_key")
  WHERE "resolved_at" IS NULL;

-- §11.3 BE1's second index, over ALL rows and not just open ones. Two concurrent raises in a
-- takeover window can compute the same `MAX + 1` (ordinary reads do not see uncommitted writes),
-- and this is what stops both from landing: the first wins, the second conflicts and is downgraded
-- to a read by §8.5 C1/C2. The index is the backstop; the lease (§8.1 F1) is the main path.
CREATE UNIQUE INDEX "project_blocker_episode_idx"
  ON "project_blocker" ("project_id", "dedupe_key", "lifecycle_generation");

CREATE INDEX "project_blocker_project_id_resolved_at_idx"
  ON "project_blocker" ("project_id", "resolved_at");

-- §10.4 clauses 1 and 2 read this column on every open row of a due project.
CREATE INDEX "project_blocker_project_id_next_check_at_idx"
  ON "project_blocker" ("project_id", "next_check_at");

-- §11.5: a blocker escalates AT MOST ONCE in its life, and the notification rides that transition.
-- Enforcing it here rather than in the service is the difference between "the code only writes it
-- when it is null" and "it cannot be written twice": the second is still true when a takeover, a
-- replay or a raw statement is the writer. `escalated_at` may be cleared only by a resolution,
-- which ends the episode; the next episode is a different row.
CREATE OR REPLACE FUNCTION "project_blocker_escalation_once"() RETURNS trigger AS $$
BEGIN
  IF OLD."escalated_at" IS NOT NULL AND NEW."escalated_at" IS DISTINCT FROM OLD."escalated_at" THEN
    RAISE EXCEPTION 'BLOCKER_ALREADY_ESCALATED: blocker % escalated at %, cannot re-escalate at %',
      OLD."id", OLD."escalated_at", NEW."escalated_at";
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "project_blocker_escalation_once"
  BEFORE UPDATE OF "escalated_at" ON "project_blocker"
  FOR EACH ROW EXECUTE FUNCTION "project_blocker_escalation_once"();

-- §11.4 / §11.3 BE1: a resolved episode is TERMINAL and its row is never deleted. `MAX + 1` has to
-- still be able to see it, and "what was blocking this last Tuesday" has to stay answerable.
--
-- Re-opening a resolved row in place would take a generation away from a new failure and make it
-- look like the same one, which is precisely what §7.6 TR3 then misreads as "the coordinator made
-- no progress" and hands to a person. So: resolution is a one-way door, and a recurrence is a new
-- row with a larger generation.
--
-- UPDATE only, deliberately. Rows are never deleted INDEPENDENTLY, but the Project cascade is
-- their exit exactly as it is `project_action`'s — a BEFORE DELETE guard here would abort that
-- cascade and make deleting a project fail against its own audit trail.
CREATE OR REPLACE FUNCTION "project_blocker_resolution_final"() RETURNS trigger AS $$
BEGIN
  IF OLD."resolved_at" IS NULL THEN RETURN NEW; END IF;
  IF NEW."resolved_at" IS DISTINCT FROM OLD."resolved_at"
     OR NEW."resolved_by" IS DISTINCT FROM OLD."resolved_by"
     OR NEW."kind" IS DISTINCT FROM OLD."kind"
     OR NEW."dedupe_key" IS DISTINCT FROM OLD."dedupe_key"
     OR NEW."lifecycle_generation" IS DISTINCT FROM OLD."lifecycle_generation"
     OR NEW."first_seen_at" IS DISTINCT FROM OLD."first_seen_at" THEN
    RAISE EXCEPTION 'BLOCKER_RESOLVED_IMMUTABLE: blocker % is resolved and may not be rewritten',
      OLD."id";
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "project_blocker_resolution_final"
  BEFORE UPDATE ON "project_blocker"
  FOR EACH ROW EXECUTE FUNCTION "project_blocker_resolution_final"();

-- §12.1 / I6: existing projects gain no blockers, no wake and no notification from this migration.
-- Legacy rows stay exactly as silent as they were; the table starts empty on purpose.
