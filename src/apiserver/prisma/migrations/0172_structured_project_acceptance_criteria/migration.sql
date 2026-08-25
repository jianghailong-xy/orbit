-- Structured authoring for project-level acceptance criteria.
--
-- The acceptance engine has always judged one row per criterion, but the authored source was one
-- TEXT value and `project-acceptance.ts` had to infer rows from physical line breaks. That loses
-- intent irreversibly: "1. a; 2. b" is one line and therefore became one verdict. This migration
-- makes the CURRENT definitions first-class rows while preserving both compatibility surfaces:
--
--   * project.acceptance_criteria remains a readable/writable text projection for old clients;
--   * every historical run and project_acceptance_criterion row stays byte-for-byte untouched.
--
-- New runs receive a JSON snapshot and the definition identity/revision copied into each immutable
-- run row. Historical rows leave those additive columns NULL, which says exactly what is known.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE "project_acceptance_criterion_definition" (
  "id"           UUID PRIMARY KEY,
  "project_id"   UUID NOT NULL,
  "ordinal"      INTEGER NOT NULL,
  "text"         TEXT NOT NULL,
  "revision"     INTEGER NOT NULL DEFAULT 1,
  "content_hash" CHAR(64) NOT NULL,
  "created_at"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

ALTER TABLE "project_acceptance_criterion_definition"
  ADD CONSTRAINT "project_acceptance_definition_project_fkey"
  FOREIGN KEY ("project_id") REFERENCES "project"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

CREATE UNIQUE INDEX "project_acceptance_definition_ordinal_idx"
  ON "project_acceptance_criterion_definition" ("project_id", "ordinal");
CREATE INDEX "project_acceptance_definition_content_idx"
  ON "project_acceptance_criterion_definition" ("project_id", "content_hash");

ALTER TABLE "project_acceptance_criterion_definition"
  ADD CONSTRAINT "project_acceptance_definition_ordinal_chk" CHECK ("ordinal" >= 1),
  ADD CONSTRAINT "project_acceptance_definition_revision_chk" CHECK ("revision" >= 1),
  ADD CONSTRAINT "project_acceptance_definition_text_chk"
    CHECK (btrim("text") <> '' AND position(E'\n' in "text") = 0 AND position(E'\r' in "text") = 0),
  ADD CONSTRAINT "project_acceptance_definition_hash_chk"
    CHECK ("content_hash" ~ '^[0-9a-f]{64}$');

ALTER TABLE "project_acceptance_run"
  ADD COLUMN "criteria_snapshot_v2" JSONB;

ALTER TABLE "project_acceptance_run"
  ADD CONSTRAINT "project_acceptance_run_snapshot_v2_chk"
    CHECK ("criteria_snapshot_v2" IS NULL OR jsonb_typeof("criteria_snapshot_v2") = 'array');

ALTER TABLE "project_acceptance_criterion"
  ADD COLUMN "definition_id" UUID,
  ADD COLUMN "definition_revision" INTEGER;

ALTER TABLE "project_acceptance_criterion"
  ADD CONSTRAINT "project_acceptance_criterion_definition_revision_chk"
    CHECK ("definition_revision" IS NULL OR "definition_revision" >= 1),
  ADD CONSTRAINT "project_acceptance_criterion_definition_pair_chk"
    CHECK (("definition_id" IS NULL) = ("definition_revision" IS NULL));

CREATE UNIQUE INDEX "project_acceptance_criterion_run_definition_idx"
  ON "project_acceptance_criterion" ("run_id", "definition_id");

-- One parser for the migration backfill and for writes made by an older binary after this schema
-- is live. It intentionally implements the existing conservative rule: one non-blank physical
-- line is one item, and a list marker is presentation. In particular it does NOT guess that a
-- semicolon followed by "2." starts a second item; ambiguous legacy data remains one item and is
-- surfaced for a person to correct through the structured API.
CREATE OR REPLACE FUNCTION project_acceptance_parse_legacy(p_text TEXT)
RETURNS TABLE (ordinal INTEGER, criterion_text TEXT, content_hash TEXT) AS $$
  WITH lines AS (
    SELECT source_ordinal,
           btrim(regexp_replace(
             line,
             '^[[:space:]]*(([-*+•])|(\(?[0-9]+[.)、])|([（(][0-9]+[）)])|(第[[:space:]]*[0-9]+[[:space:]]*[条项点]))[[:space:]]*',
             ''
           )) AS criterion_text
      FROM regexp_split_to_table(
             replace(replace(COALESCE(p_text, ''), E'\r\n', E'\n'), E'\r', E'\n'),
             E'\n'
           )
           WITH ORDINALITY AS source(line, source_ordinal)
  ), stated AS (
    SELECT source_ordinal, criterion_text
      FROM lines
     WHERE criterion_text <> ''
  )
  SELECT row_number() OVER (ORDER BY source_ordinal)::INTEGER,
         criterion_text,
         encode(digest(criterion_text, 'sha256'), 'hex')
    FROM stated
   ORDER BY source_ordinal
$$ LANGUAGE SQL IMMUTABLE;

CREATE OR REPLACE FUNCTION project_acceptance_definition_projection(p_project UUID)
RETURNS TEXT AS $$
  SELECT string_agg(d."ordinal"::TEXT || '. ' || d."text", E'\n' ORDER BY d."ordinal")
    FROM "project_acceptance_criterion_definition" d
   WHERE d."project_id" = p_project
$$ LANGUAGE SQL STABLE;

-- Semantic identity is the unordered MULTISET of exact criterion contents. Sorting makes reorder
-- cosmetic; aggregating every hash keeps duplicate criteria countable rather than collapsing them.
CREATE OR REPLACE FUNCTION project_acceptance_definition_digest(p_project UUID)
RETURNS CHAR(64) AS $$
  SELECT encode(digest(COALESCE(string_agg(d."content_hash"::TEXT, ','
                                           ORDER BY d."content_hash", d."id"), ''), 'sha256'), 'hex')::CHAR(64)
    FROM "project_acceptance_criterion_definition" d
   WHERE d."project_id" = p_project
$$ LANGUAGE SQL STABLE;

-- `content_hash` and `revision` are derived facts, not values a writer is allowed to improvise.
-- Keeping them in the table makes legacy reconciliation and digesting cheap; deriving them here
-- keeps a direct/rolling-upgrade write from making the cached hash disagree with the text. An edit
-- increments exactly once, while a reorder (or a writer resending the same text) preserves it.
CREATE OR REPLACE FUNCTION project_acceptance_definition_normalize() RETURNS TRIGGER AS $$
BEGIN
  NEW."text" := btrim(NEW."text");
  NEW."content_hash" := encode(digest(NEW."text", 'sha256'), 'hex');
  IF TG_OP = 'INSERT' THEN
    NEW."revision" := 1;
  ELSE
    NEW."revision" := CASE
      WHEN NEW."text" IS DISTINCT FROM OLD."text" THEN OLD."revision" + 1
      ELSE OLD."revision"
    END;
    NEW."updated_at" := CURRENT_TIMESTAMP;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER project_acceptance_definition_normalize
  BEFORE INSERT OR UPDATE OF "text", "revision", "content_hash"
  ON "project_acceptance_criterion_definition"
  FOR EACH ROW EXECUTE FUNCTION project_acceptance_definition_normalize();

-- Reconcile a legacy text write without pretending the text carries stable ids. Equal content
-- keeps its existing id (including duplicate occurrences, paired in prior order); changed content
-- is a new definition. Structured writers update rows first and then write the exact projection,
-- so the compatibility trigger below skips this function and preserves the ids they supplied.
CREATE OR REPLACE FUNCTION project_acceptance_sync_legacy_definitions(
  p_project UUID,
  p_text TEXT
) RETURNS VOID AS $$
BEGIN
  -- Vacate every real ordinal before reordering; the unique index stays true at every statement.
  UPDATE "project_acceptance_criterion_definition"
     SET "ordinal" = "ordinal" + 1000000000
   WHERE "project_id" = p_project;

  -- Keep at most as many old occurrences of a content hash as the new text contains.
  WITH existing AS (
    SELECT d."id", d."content_hash",
           row_number() OVER (
             PARTITION BY d."content_hash" ORDER BY d."ordinal", d."id"
           ) AS occurrence
      FROM "project_acceptance_criterion_definition" d
     WHERE d."project_id" = p_project
  ), incoming_counts AS (
    SELECT p.content_hash, count(*) AS occurrences
      FROM project_acceptance_parse_legacy(p_text) p
     GROUP BY p.content_hash
  )
  DELETE FROM "project_acceptance_criterion_definition" d
   USING existing e
   LEFT JOIN incoming_counts i ON i.content_hash = e."content_hash"::TEXT
   WHERE d."id" = e."id"
     AND e.occurrence > COALESCE(i.occurrences, 0);

  -- Reuse the remaining ids by equal-content occurrence and put them in the authored order.
  WITH existing AS (
    SELECT d."id", d."content_hash",
           row_number() OVER (
             PARTITION BY d."content_hash" ORDER BY d."ordinal", d."id"
           ) AS occurrence
      FROM "project_acceptance_criterion_definition" d
     WHERE d."project_id" = p_project
  ), incoming AS (
    SELECT p.*,
           row_number() OVER (
             PARTITION BY p.content_hash ORDER BY p.ordinal
           ) AS occurrence
      FROM project_acceptance_parse_legacy(p_text) p
  )
  UPDATE "project_acceptance_criterion_definition" d
     SET "ordinal" = i.ordinal,
         "text" = i.criterion_text
    FROM existing e
    JOIN incoming i
      ON i.content_hash = e."content_hash"::TEXT AND i.occurrence = e.occurrence
   WHERE d."id" = e."id";

  -- Every unmatched incoming occurrence is genuinely new to a legacy writer.
  WITH incoming AS (
    SELECT p.*,
           row_number() OVER (
             PARTITION BY p.content_hash ORDER BY p.ordinal
           ) AS occurrence
      FROM project_acceptance_parse_legacy(p_text) p
  ), existing_counts AS (
    SELECT d."content_hash"::TEXT AS content_hash, count(*) AS occurrences
      FROM "project_acceptance_criterion_definition" d
     WHERE d."project_id" = p_project
     GROUP BY d."content_hash"
  )
  INSERT INTO "project_acceptance_criterion_definition"
    ("id", "project_id", "ordinal", "text", "revision", "content_hash")
  SELECT gen_random_uuid(), p_project, i.ordinal, i.criterion_text, 1, i.content_hash
    FROM incoming i
    LEFT JOIN existing_counts e ON e.content_hash = i.content_hash
   WHERE i.occurrence > COALESCE(e.occurrences, 0)
   ORDER BY i.ordinal;
END;
$$ LANGUAGE plpgsql;

-- Backfill every existing project under the same conservative rule. Historical acceptance runs
-- are not linked retroactively: doing so would make a new identity look like something the old run
-- actually recorded. They remain fully readable through their existing snapshot rows.
INSERT INTO "project_acceptance_criterion_definition"
  ("id", "project_id", "ordinal", "text", "revision", "content_hash")
SELECT gen_random_uuid(), p."id", c.ordinal, c.criterion_text, 1, c.content_hash
  FROM "project" p
 CROSS JOIN LATERAL project_acceptance_parse_legacy(p."acceptance_criteria") c;

ALTER TABLE "project"
  ADD COLUMN "acceptance_criteria_digest" CHAR(64) NOT NULL
  DEFAULT 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
  ADD COLUMN "acceptance_criteria_format" TEXT NOT NULL DEFAULT 'LEGACY_TEXT';

ALTER TABLE "project"
  ADD CONSTRAINT "project_acceptance_criteria_format_chk"
  CHECK ("acceptance_criteria_format" IN ('LEGACY_TEXT', 'STRUCTURED'));

UPDATE "project" p
   SET "acceptance_criteria_digest" = project_acceptance_definition_digest(p."id");

-- Migration 0127 freezes a concluded run by listing every conclusion-bearing column. Extend that
-- guard for the structured snapshot (and include the additive identity columns from later schema
-- revisions while the function is being replaced): after a verdict, only the two supersession
-- annotations may change.
CREATE OR REPLACE FUNCTION project_acceptance_run_immutable() RETURNS TRIGGER AS $$
BEGIN
  IF OLD."verdict" IS NULL THEN RETURN NEW; END IF;
  IF NEW."id" IS DISTINCT FROM OLD."id"
     OR NEW."project_id" IS DISTINCT FROM OLD."project_id"
     OR NEW."attempt" IS DISTINCT FROM OLD."attempt"
     OR NEW."acceptance_epoch" IS DISTINCT FROM OLD."acceptance_epoch"
     OR NEW."criteria_snapshot" IS DISTINCT FROM OLD."criteria_snapshot"
     OR NEW."criteria_snapshot_v2" IS DISTINCT FROM OLD."criteria_snapshot_v2"
     OR NEW."criteria_revision" IS DISTINCT FROM OLD."criteria_revision"
     OR NEW."digest_version" IS DISTINCT FROM OLD."digest_version"
     OR NEW."input_digest" IS DISTINCT FROM OLD."input_digest"
     OR NEW."result_digest" IS DISTINCT FROM OLD."result_digest"
     OR NEW."verdict" IS DISTINCT FROM OLD."verdict"
     OR NEW."decided_by" IS DISTINCT FROM OLD."decided_by"
     OR NEW."coordinator_agent_id" IS DISTINCT FROM OLD."coordinator_agent_id"
     OR NEW."coordinator_session_id" IS DISTINCT FROM OLD."coordinator_session_id"
     OR NEW."project_action_id" IS DISTINCT FROM OLD."project_action_id"
     OR NEW."started_at" IS DISTINCT FROM OLD."started_at"
     OR NEW."completed_at" IS DISTINCT FROM OLD."completed_at"
     OR NEW."created_at" IS DISTINCT FROM OLD."created_at" THEN
    RAISE EXCEPTION 'ACCEPTANCE_RUN_IMMUTABLE: run % has concluded; only supersession may be recorded',
      OLD."id" USING ERRCODE = 'raise_exception';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Replace 0127's raw-text invalidation with definition-aware synchronization and invalidation.
-- A structured writer mutates definitions and then writes their exact legacy projection in the
-- same transaction; an old writer only changes the text, which is detected and reconciled here.
DROP TRIGGER IF EXISTS project_acceptance_criteria_fact ON "project";
DROP FUNCTION IF EXISTS project_acceptance_criteria_fact();

CREATE OR REPLACE FUNCTION project_acceptance_criteria_fact() RETURNS TRIGGER AS $$
DECLARE
  before_digest CHAR(64);
  after_digest  CHAR(64);
  projection    TEXT;
BEGIN
  IF TG_OP = 'INSERT' THEN
    projection := project_acceptance_definition_projection(NEW."id");
    IF projection IS DISTINCT FROM NEW."acceptance_criteria" THEN
      PERFORM project_acceptance_sync_legacy_definitions(NEW."id", NEW."acceptance_criteria");
    END IF;
    after_digest := project_acceptance_definition_digest(NEW."id");
    UPDATE "project" SET "acceptance_criteria_digest" = after_digest WHERE "id" = NEW."id";
    RETURN NEW;
  END IF;

  before_digest := OLD."acceptance_criteria_digest";
  projection := project_acceptance_definition_projection(NEW."id");
  IF projection IS DISTINCT FROM NEW."acceptance_criteria" THEN
    PERFORM project_acceptance_sync_legacy_definitions(NEW."id", NEW."acceptance_criteria");
    -- An older binary cannot name the format column. If it replaced the text with something that
    -- is not the current structured projection, the item boundaries came from legacy parsing.
    UPDATE "project" SET "acceptance_criteria_format" = 'LEGACY_TEXT' WHERE "id" = NEW."id";
  END IF;
  after_digest := project_acceptance_definition_digest(NEW."id");

  UPDATE "project" SET "acceptance_criteria_digest" = after_digest WHERE "id" = NEW."id";

  IF before_digest IS DISTINCT FROM after_digest
     AND OLD."status" = 'DONE' AND NEW."status" = 'DONE'
     AND NEW."accepted_run_id" IS NOT NULL THEN
    PERFORM project_acceptance_reopen(
      NEW."id",
      'project.acceptance_criteria',
      jsonb_build_object('beforeDigest', before_digest, 'afterDigest', after_digest)
    );
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER project_acceptance_criteria_fact
  AFTER INSERT OR UPDATE OF "acceptance_criteria" ON "project"
  FOR EACH ROW EXECUTE FUNCTION project_acceptance_criteria_fact();
