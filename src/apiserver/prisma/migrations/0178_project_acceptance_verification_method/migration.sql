-- N3: a project criterion is an authored assertion plus the REQUIRED way it will be judged.
--
-- `acceptance_criteria` remains the rolling-upgrade projection and LEGACY_TEXT remains readable,
-- but the current definition relation is the source a new writer edits. Existing text cannot tell
-- us which test its author intended, so migration records an honest human/direct-evidence method;
-- it does not try to extract commands from comments or prose. The compatibility parser is also
-- narrowed to discard an unmarked, colon-ended lead-in immediately before a marked checklist.

BEGIN;

ALTER TABLE "project_acceptance_criterion_definition"
  ADD COLUMN "verification_method" TEXT;

UPDATE "project_acceptance_criterion_definition"
   SET "verification_method" =
       'Human review against direct evidence for this migrated criterion';

ALTER TABLE "project_acceptance_criterion_definition"
  ALTER COLUMN "verification_method" SET NOT NULL,
  ADD CONSTRAINT "project_acceptance_definition_method_chk"
    CHECK (btrim("verification_method") <> '' AND char_length("verification_method") <= 4000);

-- One parser is used by this repair and every later legacy-client write. Blank lines are removed
-- before LEAD is calculated, so a prose introduction and its numbered list may be separated by
-- normal Markdown spacing. A numbered assertion ending in a colon remains an assertion: only an
-- UNMARKED line followed by a MARKED line is classified as an introduction.
CREATE OR REPLACE FUNCTION project_acceptance_parse_legacy(p_text TEXT)
RETURNS TABLE (ordinal INTEGER, criterion_text TEXT, content_hash TEXT) AS $$
  WITH lines AS (
    SELECT source_ordinal,
           line ~ '^[[:space:]]*(([-*+•])|(\(?[0-9]+[.)、])|([（(][0-9]+[）)])|(第[[:space:]]*[0-9]+[[:space:]]*[条项点]))[[:space:]]*'
             AS has_marker,
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
    SELECT source_ordinal, has_marker, criterion_text
      FROM lines
     WHERE criterion_text <> ''
  ), classified AS (
    SELECT stated.*,
           lead(has_marker) OVER (ORDER BY source_ordinal) AS next_has_marker
      FROM stated
  ), assertions AS (
    SELECT source_ordinal, criterion_text
      FROM classified
     WHERE NOT (
       NOT has_marker
       AND right(criterion_text, 1) IN (':', '：')
       AND next_has_marker IS TRUE
     )
  )
  SELECT row_number() OVER (ORDER BY source_ordinal)::INTEGER,
         criterion_text,
         encode(digest(criterion_text, 'sha256'), 'hex')
    FROM assertions
   ORDER BY source_ordinal
$$ LANGUAGE SQL IMMUTABLE;

-- Both authored fields are normalized database-side so direct writes and rolling binaries cannot
-- create a blank method or make a row's revision disagree with what was edited. The semantic hash
-- remains the assertion text alone in N3: changing acceptance evaluation belongs to N4/N5.
DROP TRIGGER project_acceptance_definition_normalize
  ON "project_acceptance_criterion_definition";

CREATE OR REPLACE FUNCTION project_acceptance_definition_normalize() RETURNS TRIGGER AS $$
BEGIN
  NEW."text" := btrim(NEW."text");
  NEW."verification_method" := btrim(NEW."verification_method");
  NEW."content_hash" := encode(digest(NEW."text", 'sha256'), 'hex');
  IF TG_OP = 'INSERT' THEN
    NEW."revision" := 1;
  ELSE
    NEW."revision" := CASE
      WHEN NEW."text" IS DISTINCT FROM OLD."text"
        OR NEW."verification_method" IS DISTINCT FROM OLD."verification_method"
      THEN OLD."revision" + 1
      ELSE OLD."revision"
    END;
    NEW."updated_at" := CURRENT_TIMESTAMP;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER project_acceptance_definition_normalize
  BEFORE INSERT OR UPDATE OF "text", "verification_method", "revision", "content_hash"
  ON "project_acceptance_criterion_definition"
  FOR EACH ROW EXECUTE FUNCTION project_acceptance_definition_normalize();

-- Re-state 0172's legacy reconciler with the one new required column. Equal assertions retain
-- their ids and methods; only a genuinely new assertion from a legacy text writer receives the
-- explicit migrated/manual method.
CREATE OR REPLACE FUNCTION project_acceptance_sync_legacy_definitions(
  p_project UUID,
  p_text TEXT
) RETURNS VOID AS $$
BEGIN
  UPDATE "project_acceptance_criterion_definition"
     SET "ordinal" = "ordinal" + 1000000000
   WHERE "project_id" = p_project;

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
    ("id", "project_id", "ordinal", "text", "verification_method", "revision", "content_hash")
  SELECT gen_random_uuid(), p_project, i.ordinal, i.criterion_text,
         'Human review against direct evidence for this migrated criterion', 1, i.content_hash
    FROM incoming i
    LEFT JOIN existing_counts e ON e.content_hash = i.content_hash
   WHERE i.occurrence > COALESCE(e.occurrences, 0)
   ORDER BY i.ordinal;
END;
$$ LANGUAGE plpgsql;

-- Repair every already-backfilled legacy project under the new parser. This is the step that
-- removes the false criterion from 34Cn4EO8NtCTVK3gZ8Cr7; structured projects are never reparsed.
DO $$
DECLARE
  legacy_project RECORD;
BEGIN
  FOR legacy_project IN
    SELECT "id", "acceptance_criteria"
      FROM "project"
     WHERE "acceptance_criteria_format" = 'LEGACY_TEXT'
  LOOP
    PERFORM project_acceptance_sync_legacy_definitions(
      legacy_project."id", legacy_project."acceptance_criteria"
    );
  END LOOP;
END;
$$;

UPDATE "project" p
   SET "acceptance_criteria_digest" = project_acceptance_definition_digest(p."id")
 WHERE p."acceptance_criteria_format" = 'LEGACY_TEXT';

COMMIT;
