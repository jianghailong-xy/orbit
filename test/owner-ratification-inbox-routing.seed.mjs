import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { Pool } = require('pg');

const URL = process.env.OWNER_RATIFICATION_ROUTING_PG_URL;
const EXPECTED_DATABASE = process.env.OWNER_RATIFICATION_ROUTING_PG_EXPECTED_DATABASE;
const EXPECTED_SYSTEM_IDENTIFIER =
  process.env.OWNER_RATIFICATION_ROUTING_PG_EXPECTED_SYSTEM_IDENTIFIER;
const FIXTURE_PATH = process.env.OWNER_RATIFICATION_ROUTING_FIXTURE_PATH;
const BATCH_AT = '2026-08-29T00:00:00.000Z';

assert.ok(URL, 'OWNER_RATIFICATION_ROUTING_PG_URL is required');
assert.ok(EXPECTED_DATABASE, 'expected disposable database name is required');
assert.ok(EXPECTED_SYSTEM_IDENTIFIER, 'expected disposable cluster identity is required');
assert.ok(FIXTURE_PATH, 'OWNER_RATIFICATION_ROUTING_FIXTURE_PATH is required');

const pool = new Pool({ connectionString: URL, max: 10 });
const ownerId = randomUUID();

async function createLegacyProject(label) {
  const projectId = randomUUID();
  await pool.query(
    `INSERT INTO "project" (
       "id","owner_id","title","goal","coordinator_enabled","automation_policy",
       "max_concurrent_tasks","updated_at"
     ) VALUES ($1,$2,$3,$4,true,'GUARDED_AUTO'::"project_automation_policy",2,now())`,
    [projectId, ownerId, `${label} project`, `${label} exact legacy goal`],
  );
  await pool.query(
    `INSERT INTO "project_acceptance_criterion_definition" (
       "id","project_id","ordinal","text","verification_method","completion_criterion",
       "content_hash"
     ) VALUES (
       gen_random_uuid(),$1,1,$2,'fixture verification',
       'HUMAN_SIGNOFF'::"task_completion_criterion",repeat('0',64)
     )`,
    [projectId, `${label} exact completion criterion`],
  );
  // Reproduce the one-shot 0195 backfill shape, rather than the intermediate projections caused
  // by creating a Project and its definition against an already migrated database.
  await pool.query('DELETE FROM "project_owner_decision_request" WHERE "project_id"=$1', [projectId]);
  await pool.query('DELETE FROM "project_completion_contract" WHERE "project_id"=$1', [projectId]);
  await pool.query(
    `SELECT project_refresh_completion_contract($1::uuid,'OWNER_RATIFICATION_MIGRATION')`,
    [projectId],
  );
  const request = (await pool.query(
    `SELECT "id","contract_digest"::text AS "contractDigest",
            "contract_revision"::text AS "contractRevision",
            "request_generation"::text AS "requestGeneration","semantic_diff" AS "semanticDiff"
       FROM "project_owner_decision_request" WHERE "project_id"=$1`,
    [projectId],
  )).rows[0];
  assert.ok(request);
  return { label, projectId, initialRequest: request };
}

async function forceHistoricalStatus(projectId, status) {
  const client = await pool.connect();
  try {
    await client.query("SET session_replication_role='replica'");
    await client.query(
      'UPDATE "project" SET "status"=$2::"project_status","updated_at"=now() WHERE "id"=$1',
      [projectId, status],
    );
  } finally {
    await client.query("SET session_replication_role='origin'");
    client.release();
  }
}

try {
  const identity = (await pool.query(`
    SELECT current_database() AS database,
           (SELECT system_identifier::text FROM pg_control_system()) AS system_identifier
  `)).rows[0];
  assert.equal(identity.database, EXPECTED_DATABASE);
  assert.equal(identity.system_identifier, EXPECTED_SYSTEM_IDENTIFIER);

  await pool.query(
    `INSERT INTO "user" ("id","email","name","password_hash") VALUES ($1,$2,$3,'x')`,
    [ownerId, `routing-${ownerId}@example.test`, 'Routing fixture owner'],
  );
  const [active, inactive, done, cancelled, stale] = await Promise.all([
    createLegacyProject('open-active'),
    createLegacyProject('open-inactive'),
    createLegacyProject('done'),
    createLegacyProject('cancelled'),
    createLegacyProject('stale-contract'),
  ]);
  const fixtures = { active, inactive, done, cancelled, stale };
  await pool.query(
    `UPDATE "project_owner_decision_request"
        SET "created_at"=$2::timestamptz,
            "expires_at"='2099-09-05T00:00:00Z'::timestamptz
      WHERE "project_id"=ANY($1::uuid[])`,
    [Object.values(fixtures).map((item) => item.projectId), BATCH_AT],
  );
  await forceHistoricalStatus(done.projectId, 'DONE');
  await forceHistoricalStatus(cancelled.projectId, 'CANCELLED');

  mkdirSync(path.dirname(FIXTURE_PATH), { recursive: true });
  writeFileSync(FIXTURE_PATH, `${JSON.stringify({
    schemaVersion: 1,
    seededBeforeMigration: '0210_owner_ratification_inbox_eligibility',
    batchAt: BATCH_AT,
    ownerId,
    fixtures,
  })}\n`);
} finally {
  await pool.end();
}
