import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import type { Client } from 'pg';

import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from './coordinator-pg-test-safety';

/**
 * What the identity migration does to a database that already has projects in it — asserted on a
 * real server, because every claim here is the DATABASE's rather than a code path's.
 *
 * Three of them cannot be tested any other way. "At most one coordinator per project" is a partial
 * unique index, and the reason it is an index rather than a service check is that two concurrent
 * writers both read "no coordinator yet" — so only a test with two real connections says anything
 * about it. "Deleting an agent a project coordinates with is refused" is a foreign key's ON DELETE.
 * And "every project that already existed comes out of this migration silent" is a statement about
 * column defaults applied to rows that were written before the columns existed.
 *
 * Skipped unless a disposable database is pointed at it, so `node --test` stays green on a laptop:
 *
 *   docker run -d --name pcc03-pg -e POSTGRES_PASSWORD=pcc03 -e POSTGRES_USER=pcc03_admin \
 *     -e POSTGRES_DB=pcc03_mig -p 127.0.0.1:55437:5432 postgres:16-alpine
 *   COORDINATOR_PG_URL=postgres://pcc03_admin:pcc03@127.0.0.1:55437/pcc03_mig \
 *   COORDINATOR_PG_EXPECTED_DATABASE=pcc03_mig COORDINATOR_PG_EXPECTED_USER=pcc03_admin \
 *   COORDINATOR_PG_EXPECTED_SYSTEM_IDENTIFIER=<pg_control_system().system_identifier> \
 *   node --test build/projects/coordinator-identity-migration.pg.spec.js
 */
const URL = process.env.COORDINATOR_PG_URL;

/** Its own schema, so nothing here can touch a table anybody else's spec created. */
const SCHEMA = 'pcc03_identity_migration';

const MIGRATION = readFileSync(
  path.resolve(__dirname, '../../prisma/migrations/0111_project_coordinator_identity/migration.sql'),
  'utf8',
);

const PROJECT_A = '00000000-0000-7000-8000-0000000000a1';
const PROJECT_B = '00000000-0000-7000-8000-0000000000a2';
const AGENT_A = '00000000-0000-7000-8000-0000000000b1';
const AGENT_B = '00000000-0000-7000-8000-0000000000b2';

type ClientCtor = new (config: { connectionString?: string }) => Client;

async function connect(): Promise<Client> {
  assertCoordinatorPgUrlIsIsolated(URL);
  // Loaded lazily and only when a database was pointed at this file: a top-level import would turn
  // "skipped" into a module-resolution failure in a worktree with no node_modules.
  const { Client: Ctor } = (await import('pg')) as unknown as { Client: ClientCtor };
  const client = new Ctor({ connectionString: URL });
  await client.connect();
  await verifyCoordinatorPgIdentity(client);
  await client.query(`SET search_path TO ${SCHEMA}`);
  return client;
}

/**
 * The database as it stands BEFORE this migration: projects and workspaces that were written when
 * none of these columns existed. Only the columns the migration reads or references are recreated —
 * this is the shape 0111 runs against, not a copy of the whole schema.
 */
async function seedPreMigration(client: Client): Promise<void> {
  await client.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
  await client.query(`CREATE SCHEMA ${SCHEMA}`);
  await client.query(`SET search_path TO ${SCHEMA}`);
  await client.query(`
    CREATE TABLE "workspace" (
      "id"         UUID PRIMARY KEY,
      "name"       TEXT NOT NULL,
      "deleted_at" TIMESTAMP(3)
    );
    CREATE TABLE "project" (
      "id"         UUID PRIMARY KEY,
      "title"      TEXT NOT NULL,
      "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    INSERT INTO "workspace" ("id", "name") VALUES ('${AGENT_A}', 'agent A'), ('${AGENT_B}', 'agent B');
    INSERT INTO "project" ("id", "title") VALUES ('${PROJECT_A}', 'older'), ('${PROJECT_B}', 'newer');
  `);
}

async function migrate(client: Client): Promise<void> {
  await client.query(MIGRATION);
}

test('every project that already existed comes out of the migration silent', { skip: URL ? false : 'set COORDINATOR_PG_URL to run' }, async () => {
  const client = await connect();
  try {
    await seedPreMigration(client);
    await migrate(client);

    const { rows } = await client.query(`
      SELECT "id", "coordinator_enabled", "automation_policy", "max_concurrent_tasks",
             "session_budget_per_day", "config_revision"
        FROM "project" ORDER BY "title"`);

    // The whole point of the column defaults being what they are. A project that was running under
    // the old behaviour must not acquire an opinion about automation by being migrated.
    for (const row of rows) {
      assert.equal(row.coordinator_enabled, false);
      assert.equal(row.automation_policy, 'MANUAL');
      assert.equal(row.max_concurrent_tasks, 3);
      assert.equal(row.session_budget_per_day, null);
      assert.equal(row.config_revision, '0');
    }
    assert.equal(rows.length, 2);

    // Nobody coordinates any of them either: a migration that guessed at an identity would be
    // deciding who runs somebody's project on their behalf.
    const members = await client.query(`SELECT count(*)::int AS n FROM "project_member"`);
    assert.equal(members.rows[0].n, 0);
  } finally {
    await client.end();
  }
});

test('each project it found gets a runtime row, at generation zero', { skip: URL ? false : 'set COORDINATOR_PG_URL to run' }, async () => {
  const client = await connect();
  try {
    await seedPreMigration(client);
    await migrate(client);

    const { rows } = await client.query(`
      SELECT p."id", r."coordinator_generation"
        FROM "project" p LEFT JOIN "project_runtime" r ON r."project_id" = p."id"`);

    // Backfilled rather than created on demand, so "does this project have a runtime row" is never
    // a question a later reader answers with a fallback.
    assert.equal(rows.length, 2);
    for (const row of rows) assert.equal(row.coordinator_generation, '0');

    // And the backfill is a statement that can be re-run: applying it twice is a no-op, not a
    // duplicate-key failure, which is what makes a partially-applied migration recoverable.
    const again = await client.query(`
      INSERT INTO "project_runtime" ("project_id", "coordinator_generation", "created_at", "updated_at")
      SELECT "id", 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP FROM "project"
      ON CONFLICT ("project_id") DO NOTHING`);
    assert.equal(again.rowCount, 0);
  } finally {
    await client.end();
  }
});

test('a project runtime row goes with its project, and the count only ever goes up', { skip: URL ? false : 'set COORDINATOR_PG_URL to run' }, async () => {
  const client = await connect();
  try {
    await seedPreMigration(client);
    await migrate(client);

    await client.query(
      `UPDATE "project_runtime" SET "coordinator_generation" = "coordinator_generation" + 1
        WHERE "project_id" = $1`,
      [PROJECT_A],
    );
    const bumped = await client.query(
      `SELECT "coordinator_generation" FROM "project_runtime" WHERE "project_id" = $1`,
      [PROJECT_A],
    );
    assert.equal(bumped.rows[0].coordinator_generation, '1');

    // CASCADE: the control loop's row is the project's internals, and a project that is gone has
    // none. (The membership row goes the same way — a team of a project that no longer exists
    // means nothing.)
    await client.query(`DELETE FROM "project" WHERE "id" = $1`, [PROJECT_A]);
    const left = await client.query(`SELECT count(*)::int AS n FROM "project_runtime"`);
    assert.equal(left.rows[0].n, 1);
  } finally {
    await client.end();
  }
});

test('two writers racing to coordinate one project produce one coordinator', { skip: URL ? false : 'set COORDINATOR_PG_URL to run' }, async () => {
  const a = await connect();
  const b = await connect();
  try {
    await seedPreMigration(a);
    await migrate(a);
    await b.query(`SET search_path TO ${SCHEMA}`);

    await a.query('BEGIN');
    await a.query(
      `INSERT INTO "project_member" ("id", "project_id", "agent_id", "role")
       VALUES (gen_random_uuid(), $1, $2, 'COORDINATOR')`,
      [PROJECT_A, AGENT_A],
    );

    // The second writer read "no coordinator yet" exactly as the first one did — which is why this
    // cannot be a service-level check. It blocks on the index until the first transaction settles.
    const second = b.query(
      `INSERT INTO "project_member" ("id", "project_id", "agent_id", "role")
       VALUES (gen_random_uuid(), $1, $2, 'COORDINATOR')`,
      [PROJECT_A, AGENT_B],
    );
    await a.query('COMMIT');

    await assert.rejects(second, (e: any) => e.code === '23505');

    const { rows } = await client_count(a);
    assert.equal(rows[0].n, 1);

    // Every OTHER membership is outside the index and unconstrained: a project may have as many
    // non-coordinating members as it likes, including on the agents that lost above.
    await a.query(
      `INSERT INTO "project_member" ("id", "project_id", "agent_id", "role")
       VALUES (gen_random_uuid(), $1, $2, 'MEMBER')`,
      [PROJECT_A, AGENT_B],
    );
    // ...and a different project's coordinator is a different row entirely.
    await a.query(
      `INSERT INTO "project_member" ("id", "project_id", "agent_id", "role")
       VALUES (gen_random_uuid(), $1, $2, 'COORDINATOR')`,
      [PROJECT_B, AGENT_A],
    );
  } finally {
    await a.end();
    await b.end();
  }
});

async function client_count(client: Client) {
  return client.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM "project_member" WHERE "role" = 'COORDINATOR'`,
  );
}

test('one membership per agent per project, whatever the role', { skip: URL ? false : 'set COORDINATOR_PG_URL to run' }, async () => {
  const client = await connect();
  try {
    await seedPreMigration(client);
    await migrate(client);

    await client.query(
      `INSERT INTO "project_member" ("id", "project_id", "agent_id", "role")
       VALUES (gen_random_uuid(), $1, $2, 'COORDINATOR')`,
      [PROJECT_A, AGENT_A],
    );
    // A second row for the same pair would let one agent hold two roles on one project, and every
    // reader would have to decide which of them it meant.
    await assert.rejects(
      client.query(
        `INSERT INTO "project_member" ("id", "project_id", "agent_id", "role")
         VALUES (gen_random_uuid(), $1, $2, 'MEMBER')`,
        [PROJECT_A, AGENT_A],
      ),
      (e: any) => e.code === '23505',
    );
  } finally {
    await client.end();
  }
});

test('an agent a project coordinates with cannot be deleted out from under it', { skip: URL ? false : 'set COORDINATOR_PG_URL to run' }, async () => {
  const client = await connect();
  try {
    await seedPreMigration(client);
    await migrate(client);

    await client.query(
      `INSERT INTO "project_member" ("id", "project_id", "agent_id", "role")
       VALUES (gen_random_uuid(), $1, $2, 'COORDINATOR')`,
      [PROJECT_A, AGENT_A],
    );

    // RESTRICT rather than CASCADE or SET NULL: the two alternatives are "silently disband the
    // team" and "leave a membership pointing at nothing", and a project losing its coordinator as
    // a side effect of tidying up an agent is the failure this refuses to make possible.
    await assert.rejects(
      client.query(`DELETE FROM "workspace" WHERE "id" = $1`, [AGENT_A]),
      (e: any) => e.code === '23503',
    );
    // An agent nobody coordinates with is unaffected.
    await client.query(`DELETE FROM "workspace" WHERE "id" = $1`, [AGENT_B]);
  } finally {
    await client.end();
  }
});

test('the objects this migration promises are the objects it creates', { skip: URL ? false : 'set COORDINATOR_PG_URL to run' }, async () => {
  const client = await connect();
  try {
    await seedPreMigration(client);
    await migrate(client);

    // The partial index is raw SQL — `prisma migrate diff` cannot see it and would not report it
    // missing, which is exactly how a hand-written index goes absent without anything turning red.
    const { rows } = await client.query<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes
        WHERE schemaname = $1 AND indexname = 'project_member_coordinator_idx'`,
      [SCHEMA],
    );
    assert.equal(rows.length, 1);
    assert.match(rows[0].indexdef, /UNIQUE/);
    // Its predicate is the whole of "at most one COORDINATOR": an index over all rows would refuse
    // a project's second MEMBER as well.
    assert.match(rows[0].indexdef, /WHERE \(role = 'COORDINATOR'::project_role\)/);

    const enums = await client.query<{ typname: string; labels: string[] }>(
      `SELECT t.typname, array_agg(e.enumlabel::text ORDER BY e.enumsortorder) AS labels
         FROM pg_type t
         JOIN pg_enum e ON e.enumtypid = t.oid
         JOIN pg_namespace n ON n.oid = t.typnamespace
        WHERE n.nspname = $1 GROUP BY t.typname ORDER BY t.typname`,
      [SCHEMA],
    );
    assert.deepEqual(
      enums.rows.map((r) => [r.typname, r.labels]),
      [
        ['project_automation_policy', ['MANUAL', 'GUARDED_AUTO', 'AUTO']],
        ['project_role', ['COORDINATOR', 'MEMBER']],
      ],
    );
  } finally {
    await client.end();
  }
});

test('the migration leaves nothing of its own behind to clean up', { skip: URL ? false : 'set COORDINATOR_PG_URL to run' }, async () => {
  const client = await connect();
  try {
    // Runs last: it is also this file's teardown, so the disposable database is left exactly as it
    // was found — no schema, no tables, no types.
    await client.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    const { rows } = await client.query(
      `SELECT count(*)::int AS n FROM pg_namespace WHERE nspname = $1`,
      [SCHEMA],
    );
    assert.equal(rows[0].n, 0);
  } finally {
    await client.end();
  }
});
