import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { Client } from 'pg';

import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from './coordinator-pg-test-safety';

/** Real-Postgres proof for N3's data migration. It starts at the 0172 relation shape, including
 * the parser result already stored as rows, then applies the exact 0178 file shipped to deploys.
 * Kept in its own schema; still guarded by the destructive-PG identity fence because it drops that
 * schema on each run. */
const URL = process.env.COORDINATOR_PG_URL;
const skip = URL ? false : 'set COORDINATOR_PG_URL to run';
const SCHEMA = 'n3_acceptance_method_migration';
const PROJECT = '00000000-0000-7000-8000-000000003403';
const MIGRATION = readFileSync(
  path.resolve(
    __dirname,
    '../../prisma/migrations/0178_project_acceptance_verification_method/migration.sql',
  ),
  'utf8',
);

const LEGACY_TEXT = `全部任务 DONE，且以下端到端检验通过：

1. 解绑成立
2. 唤醒幂等
3. 没有定时器
4. 一次性判断会话
5. 止损可测
6. 授权边界可测
7. 状态由证据推导
8. 验收闭环
9. 不新增失败
10. 线上验证`;

async function connect(): Promise<Client> {
  assertCoordinatorPgUrlIsIsolated(URL);
  const client = new Client({ connectionString: URL, connectionTimeoutMillis: 5_000 });
  await client.connect();
  await verifyCoordinatorPgIdentity(client);
  return client;
}

/** Only objects 0178 reads or changes, in their 0172 shape. The old parser deliberately stores
 * the introduction as ordinal 1, reproducing the production defect before the migration repairs
 * it. */
async function seedPre0178(client: Client): Promise<void> {
  await client.query('CREATE EXTENSION IF NOT EXISTS pgcrypto');
  await client.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
  await client.query(`CREATE SCHEMA ${SCHEMA}`);
  await client.query(`SET search_path TO ${SCHEMA}, public`);
  await client.query(String.raw`
    CREATE TABLE "project" (
      "id" UUID PRIMARY KEY,
      "acceptance_criteria" TEXT,
      "acceptance_criteria_format" TEXT NOT NULL DEFAULT 'LEGACY_TEXT',
      "acceptance_criteria_digest" CHAR(64) NOT NULL
        DEFAULT 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
    );
    CREATE TABLE "project_acceptance_criterion_definition" (
      "id" UUID PRIMARY KEY,
      "project_id" UUID NOT NULL REFERENCES "project"("id") ON DELETE CASCADE,
      "ordinal" INTEGER NOT NULL,
      "text" TEXT NOT NULL,
      "revision" INTEGER NOT NULL DEFAULT 1,
      "content_hash" CHAR(64) NOT NULL,
      "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE UNIQUE INDEX "project_acceptance_definition_ordinal_idx"
      ON "project_acceptance_criterion_definition" ("project_id", "ordinal");

    CREATE FUNCTION project_acceptance_parse_legacy(p_text TEXT)
    RETURNS TABLE (ordinal INTEGER, criterion_text TEXT, content_hash TEXT) AS $old$
      WITH lines AS (
        SELECT source_ordinal,
               btrim(regexp_replace(
                 line,
                 '^[[:space:]]*(([-*+•])|(\(?[0-9]+[.)、])|([（(][0-9]+[）)])|(第[[:space:]]*[0-9]+[[:space:]]*[条项点]))[[:space:]]*',
                 ''
               )) AS criterion_text
          FROM regexp_split_to_table(
                 replace(replace(COALESCE(p_text, ''), E'\r\n', E'\n'), E'\r', E'\n'), E'\n'
               ) WITH ORDINALITY AS source(line, source_ordinal)
      ), stated AS (
        SELECT source_ordinal, criterion_text FROM lines WHERE criterion_text <> ''
      )
      SELECT row_number() OVER (ORDER BY source_ordinal)::INTEGER,
             criterion_text,
             encode(digest(criterion_text, 'sha256'), 'hex')
        FROM stated ORDER BY source_ordinal
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
      NEW."content_hash" := encode(digest(NEW."text", 'sha256'), 'hex');
      IF TG_OP = 'INSERT' THEN
        NEW."revision" := 1;
      ELSE
        NEW."revision" := CASE WHEN NEW."text" IS DISTINCT FROM OLD."text"
          THEN OLD."revision" + 1 ELSE OLD."revision" END;
        NEW."updated_at" := CURRENT_TIMESTAMP;
      END IF;
      RETURN NEW;
    END;
    $old$ LANGUAGE plpgsql;
    CREATE TRIGGER project_acceptance_definition_normalize
      BEFORE INSERT OR UPDATE OF "text", "revision", "content_hash"
      ON "project_acceptance_criterion_definition"
      FOR EACH ROW EXECUTE FUNCTION project_acceptance_definition_normalize();
  `);
  await client.query(
    `INSERT INTO "project" ("id", "acceptance_criteria") VALUES ($1, $2)`,
    [PROJECT, LEGACY_TEXT],
  );
  await client.query(`
    INSERT INTO "project_acceptance_criterion_definition"
      ("id", "project_id", "ordinal", "text", "revision", "content_hash")
    SELECT gen_random_uuid(), $1, p.ordinal, p.criterion_text, 1, p.content_hash
      FROM project_acceptance_parse_legacy($2) p
  `, [PROJECT, LEGACY_TEXT]);
  const before = await client.query<{ count: number }>(
    `SELECT count(*)::int AS count FROM "project_acceptance_criterion_definition"`,
  );
  assert.equal(before.rows[0].count, 11, 'the pre-migration fixture includes the false lead-in row');
}

test('0178 migrates legacy prose to ten assertion/method rows and drops the lead-in',
  { skip, timeout: 60_000 }, async (t) => {
    const client = await connect();
    t.after(() => client.end().catch(() => undefined));
    await seedPre0178(client);

    await client.query(MIGRATION);

    const migrated = await client.query<{
      ordinal: number;
      text: string;
      verification_method: string;
    }>(`
      SELECT "ordinal", "text", "verification_method"
        FROM "project_acceptance_criterion_definition"
       WHERE "project_id" = $1
       ORDER BY "ordinal"
    `, [PROJECT]);
    assert.equal(migrated.rows.length, 10);
    assert.deepEqual(migrated.rows.map((row) => row.ordinal), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    assert.equal(migrated.rows.some((row) => row.text.startsWith('全部任务 DONE')), false);
    assert.equal(migrated.rows.every((row) => row.verification_method.trim() !== ''), true);

    const conservative = await client.query<{ criterion_text: string }>(
      `SELECT criterion_text FROM project_acceptance_parse_legacy('a real assertion:')`,
    );
    assert.deepEqual(conservative.rows, [{ criterion_text: 'a real assertion:' }],
      'a colon alone is not enough to classify a line as an introduction');

    const readable = await client.query<{ acceptance_criteria: string; acceptance_criteria_format: string }>(
      `SELECT "acceptance_criteria", "acceptance_criteria_format" FROM "project" WHERE "id" = $1`,
      [PROJECT],
    );
    assert.deepEqual(readable.rows, [{
      acceptance_criteria: LEGACY_TEXT,
      acceptance_criteria_format: 'LEGACY_TEXT',
    }]);

    await assert.rejects(
      () => client.query(`
        INSERT INTO "project_acceptance_criterion_definition"
          ("id", "project_id", "ordinal", "text", "revision", "content_hash")
        VALUES (gen_random_uuid(), $1, 11, 'missing method', 1, repeat('0', 64))
      `, [PROJECT]),
      /verification_method/u,
    );
  });
