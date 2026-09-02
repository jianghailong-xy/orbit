import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import { Client } from 'pg';

import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from './coordinator-pg-test-safety';

/**
 * Real-PostgreSQL migration proof for N22. The isolated schema starts at the exact relations and
 * named constraints 0189 consumes, uses the two public projects named by the acceptance
 * criterion, then applies the shipped migration file without rewriting it for the test.
 */
const URL = process.env.COORDINATOR_PG_URL;
const skip = URL ? false : 'set COORDINATOR_PG_URL to run';
const SCHEMA = 'n22_project_criteria_migration';
const PROJECT_34CN = '01a03488-be19-7568-a461-6ce7915ab97d';
const PROJECT_N22 = '01a03d90-3897-77d8-9076-8fa44255a2ea';
// 0189 was written when the third completion criterion was spelled HUMAN_SIGNOFF; migration 0224
// renamed that enum LABEL in place, without touching a single row. Replaying an append-only
// migration against today's catalogue therefore needs today's spelling — and only the spelling.
const MIGRATION = readFileSync(
  path.resolve(__dirname, '../../prisma/migrations/0189_project_criteria_automation/migration.sql'),
  'utf8',
).replaceAll("'HUMAN_SIGNOFF'", "'EVIDENCE_JUDGMENT'");

interface Counts {
  project_id: string;
  criteria: number;
  human_signoff: number;
  mechanical_configuration: number;
  pass_conclusions: number;
  pass_runs: number;
  done_projects: number;
  semantic_rows_digest: string;
}

async function connect(): Promise<Client> {
  assertCoordinatorPgUrlIsIsolated(URL);
  const client = new Client({ connectionString: URL, connectionTimeoutMillis: 5_000 });
  await client.connect();
  await verifyCoordinatorPgIdentity(client);
  return client;
}

async function seedPre0189(client: Client): Promise<void> {
  await client.query('CREATE EXTENSION IF NOT EXISTS pgcrypto');
  await client.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
  await client.query(`CREATE SCHEMA ${SCHEMA}`);
  await client.query(`SET search_path TO ${SCHEMA}, public`);
  await client.query(String.raw`
    CREATE TYPE "task_completion_criterion" AS ENUM
      ('EXECUTABLE', 'VERIFICATION', 'EVIDENCE_JUDGMENT');
    CREATE TYPE "project_acceptance_verdict" AS ENUM
      ('PASS', 'FAIL', 'INCONCLUSIVE');

    CREATE TABLE "project" (
      "id" UUID PRIMARY KEY,
      "title" TEXT NOT NULL,
      "status" TEXT NOT NULL DEFAULT 'OPEN',
      "acceptance_criteria" TEXT,
      "acceptance_criteria_digest" CHAR(64) NOT NULL
        DEFAULT 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      "accepted_run_id" UUID,
      "legacy_accepted_at" TIMESTAMP(3),
      "acceptance_epoch" BIGINT NOT NULL DEFAULT 0
    );
    CREATE TABLE "project_acceptance_criterion_definition" (
      "id" UUID PRIMARY KEY,
      "project_id" UUID NOT NULL REFERENCES "project"("id") ON DELETE CASCADE,
      "ordinal" INTEGER NOT NULL,
      "text" TEXT NOT NULL,
      "verification_method" TEXT NOT NULL,
      "revision" INTEGER NOT NULL DEFAULT 1,
      "content_hash" CHAR(64) NOT NULL,
      "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE ("project_id", "ordinal")
    );
    CREATE TABLE "project_acceptance_criterion" (
      "id" UUID PRIMARY KEY,
      "run_id" UUID NOT NULL,
      "project_id" UUID NOT NULL,
      "ordinal" INTEGER NOT NULL
    );
    CREATE TABLE "project_acceptance_run" (
      "id" UUID PRIMARY KEY,
      "project_id" UUID NOT NULL,
      "attempt" BIGINT NOT NULL,
      "verdict" "project_acceptance_verdict",
      "superseded_at" TIMESTAMP(3)
    );
    CREATE TABLE "project_acceptance_conclusion" (
      "id" UUID PRIMARY KEY,
      "project_id" UUID NOT NULL,
      "verdict" "project_acceptance_verdict" NOT NULL,
      "decided_by" TEXT NOT NULL,
      CONSTRAINT "project_acceptance_conclusion_decided_by_chk"
        CHECK ("decided_by" IN ('USER', 'COORDINATOR_AGENT')),
      CONSTRAINT "project_acceptance_conclusion_pass_human_chk"
        CHECK ("verdict" <> 'PASS'::"project_acceptance_verdict" OR "decided_by" = 'USER')
    );
    CREATE TABLE "project_blocker" (
      "project_id" UUID NOT NULL,
      "resolved_at" TIMESTAMP(3)
    );
    CREATE TABLE "task" (
      "id" UUID PRIMARY KEY,
      "terminal_reason" TEXT,
      "superseded_by_task_id" UUID
    );
    CREATE TABLE "task_verification_failure" (
      "project_id" UUID NOT NULL,
      "verifier_task_id" UUID NOT NULL,
      "subject_task_id" UUID NOT NULL,
      "resolved_at" TIMESTAMP(3)
    );

    CREATE FUNCTION project_acceptance_parse_legacy(p_text TEXT)
    RETURNS TABLE (ordinal INTEGER, criterion_text TEXT, content_hash TEXT) AS $old$
      SELECT row_number() OVER ()::INTEGER, line,
             encode(digest(line, 'sha256'), 'hex')
        FROM regexp_split_to_table(COALESCE(p_text, ''), E'\n') AS line
       WHERE btrim(line) <> ''
    $old$ LANGUAGE SQL IMMUTABLE;

    CREATE FUNCTION project_acceptance_definition_digest(p_project UUID) RETURNS CHAR(64) AS $old$
      SELECT encode(digest(COALESCE(string_agg(d."content_hash"::TEXT, ','
                                               ORDER BY d."content_hash", d."id"), ''),
                           'sha256'), 'hex')::CHAR(64)
        FROM "project_acceptance_criterion_definition" d
       WHERE d."project_id" = p_project
    $old$ LANGUAGE SQL STABLE;

    CREATE FUNCTION project_acceptance_definition_normalize() RETURNS TRIGGER AS $old$
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
          THEN OLD."revision" + 1 ELSE OLD."revision" END;
      END IF;
      RETURN NEW;
    END;
    $old$ LANGUAGE plpgsql;
    CREATE TRIGGER project_acceptance_definition_normalize
      BEFORE INSERT OR UPDATE OF "text", "verification_method", "revision", "content_hash"
      ON "project_acceptance_criterion_definition"
      FOR EACH ROW EXECUTE FUNCTION project_acceptance_definition_normalize();

    CREATE FUNCTION project_acceptance_standing(UUID, BIGINT)
    RETURNS TABLE (
      ordinal INTEGER,
      criterion_text TEXT,
      verdict "project_acceptance_verdict"
    ) AS $old$
      SELECT NULL::INTEGER, NULL::TEXT, NULL::"project_acceptance_verdict" WHERE false
    $old$ LANGUAGE SQL STABLE;
  `);

  await client.query(
    `INSERT INTO "project" ("id", "title") VALUES ($1, '34Cn migration fixture'), ($2, 'N22 migration fixture')`,
    [PROJECT_34CN, PROJECT_N22],
  );
  await client.query(String.raw`
    INSERT INTO "project_acceptance_criterion_definition"
      ("id", "project_id", "ordinal", "text", "verification_method", "revision", "content_hash")
    SELECT gen_random_uuid(), fixture.project_id, ordinal,
           format('literal criterion %s/%s', fixture.label, ordinal),
           format('existing verification method %s/%s', fixture.label, ordinal),
           1,
           repeat('0', 64)
      FROM (VALUES ($1::uuid, '34Cn', 10), ($2::uuid, 'N22', 11))
        AS fixture(project_id, label, criterion_count)
      CROSS JOIN LATERAL generate_series(1, fixture.criterion_count) AS ordinal
  `, [PROJECT_34CN, PROJECT_N22]);
  await client.query(String.raw`
    INSERT INTO "project_acceptance_conclusion" ("id", "project_id", "verdict", "decided_by")
    SELECT gen_random_uuid(), $1, 'PASS'::"project_acceptance_verdict", 'USER'
      FROM generate_series(1, 9)
  `, [PROJECT_34CN]);
}

async function counts(client: Client, migrated: boolean): Promise<Counts[]> {
  const human = migrated
    ? `count(*) FILTER (WHERE d."completion_criterion" = 'EVIDENCE_JUDGMENT')::int`
    : '0::int';
  const configured = migrated
    ? `count(*) FILTER (WHERE d."acceptance_command" IS NOT NULL
                         OR d."evidence_task_id" IS NOT NULL)::int`
    : '0::int';
  const result = await client.query<Counts>(`
    SELECT p."id"::text AS project_id,
           count(d."id")::int AS criteria,
           ${human} AS human_signoff,
           ${configured} AS mechanical_configuration,
           (SELECT count(*)::int FROM "project_acceptance_conclusion" c
             WHERE c."project_id" = p."id" AND c."verdict" = 'PASS') AS pass_conclusions,
           (SELECT count(*)::int FROM "project_acceptance_run" r
             WHERE r."project_id" = p."id" AND r."verdict" = 'PASS') AS pass_runs,
           (p."status" = 'DONE')::int AS done_projects,
           encode(digest(COALESCE(string_agg(
             d."id"::text || ':' || d."ordinal"::text || ':' || d."text" || ':' ||
             d."verification_method" || ':' || d."revision"::text,
             ',' ORDER BY d."id"
           ), ''), 'sha256'), 'hex') AS semantic_rows_digest
      FROM "project" p
      LEFT JOIN "project_acceptance_criterion_definition" d ON d."project_id" = p."id"
     WHERE p."id" IN ($1::uuid, $2::uuid)
     GROUP BY p."id", p."status"
     ORDER BY p."id"
  `, [PROJECT_34CN, PROJECT_N22]);
  return result.rows;
}

test('0189 migrates both named project populations conservatively without PASS or DONE',
  { skip, timeout: 60_000 }, async (t) => {
    const client = await connect();
    t.after(() => client.end().catch(() => undefined));
    await seedPre0189(client);

    const before = await counts(client, false);
    await client.query(MIGRATION);
    const after = await counts(client, true);

    assert.deepEqual(before.map((row) => ({
      projectId: row.project_id,
      criteria: row.criteria,
      passConclusions: row.pass_conclusions,
      passRuns: row.pass_runs,
      doneProjects: row.done_projects,
    })), [
      {
        projectId: PROJECT_34CN,
        criteria: 10,
        passConclusions: 9,
        passRuns: 0,
        doneProjects: 0,
      },
      {
        projectId: PROJECT_N22,
        criteria: 11,
        passConclusions: 0,
        passRuns: 0,
        doneProjects: 0,
      },
    ]);
    assert.deepEqual(after.map((row) => ({
      projectId: row.project_id,
      criteria: row.criteria,
      evidenceJudgment: row.human_signoff,
      mechanicalConfiguration: row.mechanical_configuration,
      passConclusions: row.pass_conclusions,
      passRuns: row.pass_runs,
      doneProjects: row.done_projects,
    })), [
      {
        projectId: PROJECT_34CN,
        criteria: 10,
        evidenceJudgment: 10,
        mechanicalConfiguration: 0,
        passConclusions: 9,
        passRuns: 0,
        doneProjects: 0,
      },
      {
        projectId: PROJECT_N22,
        criteria: 11,
        evidenceJudgment: 11,
        mechanicalConfiguration: 0,
        passConclusions: 0,
        passRuns: 0,
        doneProjects: 0,
      },
    ]);
    assert.deepEqual(
      after.map((row) => row.semantic_rows_digest),
      before.map((row) => row.semantic_rows_digest),
      'criterion identity, ordinal, literal text, method, and revision must survive migration',
    );
    const confirmations = await client.query<{ count: number }>(
      'SELECT count(*)::int AS count FROM "project_acceptance_criteria_confirmation"',
    );
    assert.equal(confirmations.rows[0]?.count, 0, 'migration must not invent a standard-set confirmation');
    console.log(`n22-migration-counts before=${JSON.stringify(before)} after=${JSON.stringify(after)}`);
  });
