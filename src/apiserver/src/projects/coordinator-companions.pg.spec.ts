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
 * What migration 0112 does to a database with history in it, and what it goes on doing to writes
 * that arrive afterwards from a binary that has never heard of it.
 *
 * Every claim here is the DATABASE's, so none of it can be tested anywhere else:
 *
 *   * the backfill is a statement about rows that were written before the coordinator identity
 *     existed — including the ones it must LEAVE ALONE, which is most of what makes it safe;
 *   * "an old writer cannot produce a half-migrated project" is a claim about what happens when
 *     the writer is not this codebase at all, so the test writes 0110's INSERT by hand;
 *   * "a rotation is counted whoever performs it" is a trigger, and a trigger is only there if a
 *     real server says it is.
 *
 * Skipped unless a disposable database is pointed at it:
 *
 *   docker run -d --name pcc03a-pg -e POSTGRES_PASSWORD=pcc03a -e POSTGRES_USER=pcc03a_admin \
 *     -e POSTGRES_DB=pcc03a_verify -p 127.0.0.1:45437:5432 postgres:16-alpine
 *   COORDINATOR_PG_URL=postgres://pcc03a_admin:pcc03a@127.0.0.1:45437/pcc03a_verify \
 *   COORDINATOR_PG_EXPECTED_DATABASE=pcc03a_verify COORDINATOR_PG_EXPECTED_USER=pcc03a_admin \
 *   COORDINATOR_PG_EXPECTED_SYSTEM_IDENTIFIER=<pg_control_system()> \
 *   node --test build/projects/coordinator-companions.pg.spec.js
 */
const URL = process.env.COORDINATOR_PG_URL;

/** Its own schema, so nothing here can touch a table anybody else's spec created. */
const SCHEMA = 'pcc03a_companions';

const migration = (name: string) =>
  readFileSync(path.resolve(__dirname, `../../prisma/migrations/${name}/migration.sql`), 'utf8');

const IDENTITY = migration('0111_project_coordinator_identity');
const COMPANIONS = migration('0112_project_coordinator_companions');

const OWNER = '00000000-0000-7000-8000-0000000004a1';
const OWNER_OTHER = '00000000-0000-7000-8000-0000000004a2';
const AGENT = '00000000-0000-7000-8000-0000000004b1';
const AGENT_DELETED = '00000000-0000-7000-8000-0000000004b2';
const AGENT_THEIRS = '00000000-0000-7000-8000-0000000004b3';
const AGENT_OTHER = '00000000-0000-7000-8000-0000000004b4';
/** Bound to a live agent of its own owner: the population the backfill is FOR. */
const P_BOUND = '00000000-0000-7000-8000-0000000004c1';
/** Bound to a workspace belonging to somebody else — a backfill would cross a tenant boundary. */
const P_CROSS_TENANT = '00000000-0000-7000-8000-0000000004c2';
/** Bound to a soft-deleted workspace: a deleted agent must not reappear on a team (PAC M2). */
const P_DELETED_AGENT = '00000000-0000-7000-8000-0000000004c3';
/** Never bound to anything: nobody may guess who coordinates it. */
const P_UNBOUND = '00000000-0000-7000-8000-0000000004c4';
const SESSION_OLD = '00000000-0000-7000-8000-0000000004d1';
const SESSION_NEW = '00000000-0000-7000-8000-0000000004d2';

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
 * The database as it stood at 0110: the columns 0109 gave `project` for its coordinator binding,
 * and a `workspace` with the two facts the backfill has to check — whose it is, and whether it is
 * still there.
 */
async function seedPreMigration(client: Client): Promise<void> {
  await client.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
  await client.query(`CREATE SCHEMA ${SCHEMA}`);
  await client.query(`SET search_path TO ${SCHEMA}`);
  await client.query(`
    CREATE TABLE "workspace" (
      "id"         UUID PRIMARY KEY,
      "owner_id"   UUID NOT NULL,
      "name"       TEXT NOT NULL,
      "deleted_at" TIMESTAMP(3)
    );
    CREATE TABLE "session" (
      "id"       UUID PRIMARY KEY,
      "owner_id" UUID NOT NULL
    );
    CREATE TABLE "project" (
      "id"                        UUID PRIMARY KEY,
      "owner_id"                  UUID NOT NULL,
      "title"                     TEXT NOT NULL,
      "coordinator_session_id"    UUID UNIQUE REFERENCES "session"("id") ON DELETE SET NULL,
      "coordinator_workspace_id"  UUID REFERENCES "workspace"("id") ON DELETE SET NULL,
      "created_at"                TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updated_at"                TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    INSERT INTO "workspace" ("id", "owner_id", "name", "deleted_at") VALUES
      ('${AGENT}',         '${OWNER}',       'agent',        NULL),
      ('${AGENT_DELETED}', '${OWNER}',       'gone',         CURRENT_TIMESTAMP),
      ('${AGENT_THEIRS}',  '${OWNER_OTHER}', 'someone else', NULL),
      ('${AGENT_OTHER}',   '${OWNER}',       'other',        NULL);
    INSERT INTO "session" ("id", "owner_id") VALUES ('${SESSION_OLD}', '${OWNER}'), ('${SESSION_NEW}', '${OWNER}');
    INSERT INTO "project" ("id", "owner_id", "title", "coordinator_session_id", "coordinator_workspace_id") VALUES
      ('${P_BOUND}',         '${OWNER}', 'bound',        '${SESSION_OLD}', '${AGENT}'),
      ('${P_CROSS_TENANT}',  '${OWNER}', 'cross tenant', NULL,             '${AGENT_THEIRS}'),
      ('${P_DELETED_AGENT}', '${OWNER}', 'deleted agent',NULL,             '${AGENT_DELETED}'),
      ('${P_UNBOUND}',       '${OWNER}', 'unbound',      NULL,             NULL);
  `);
}

const coordinators = async (client: Client): Promise<Record<string, string>> => {
  const { rows } = await client.query(
    `SELECT "project_id", "agent_id" FROM "project_member" WHERE "role" = 'COORDINATOR'`,
  );
  return Object.fromEntries(rows.map((r) => [r.project_id, r.agent_id]));
};

const skip = URL ? false : 'set COORDINATOR_PG_URL to run';

test('the backfill records the coordinator every bound project already had — and only those', { skip }, async () => {
  const client = await connect();
  try {
    await seedPreMigration(client);
    await client.query(IDENTITY);
    // 0111 alone is the state validation 04 measured on the real snapshot: three bound projects,
    // zero identities, and nothing that ever fills them in.
    assert.equal((await client.query(`SELECT count(*)::int n FROM "project_member"`)).rows[0].n, 0);

    await client.query(COMPANIONS);

    const members = await coordinators(client);
    // The project whose coordination workspace is a live workspace of its own owner: its
    // coordinator was decided the day it was bound, and this writes it down (PAC §11.2 step 5).
    assert.equal(members[P_BOUND], AGENT);
    // And nothing else. Each of these would be a guess, and each guess is a different kind of
    // wrong: another account's agent, an agent its owner deleted, and one nobody ever named.
    assert.equal(members[P_CROSS_TENANT], undefined);
    assert.equal(members[P_DELETED_AGENT], undefined);
    assert.equal(members[P_UNBOUND], undefined);
    assert.equal(Object.keys(members).length, 1);
  } finally {
    await client.end();
  }
});

test('the backfill is idempotent, and never overwrites a coordinator somebody chose', { skip }, async () => {
  const client = await connect();
  try {
    await seedPreMigration(client);
    await client.query(IDENTITY);
    // A project that already has an identity — set by hand here, as the new service would set it.
    await client.query(`
      INSERT INTO "project_member" ("id", "project_id", "agent_id", "role")
      VALUES (gen_random_uuid(), '${P_BOUND}', '${AGENT_OTHER}', 'COORDINATOR')`);

    await client.query(COMPANIONS);
    const first = await coordinators(client);
    // Re-running the migration is what a re-applied or resumed deploy does.
    await client.query(COMPANIONS);
    const second = await coordinators(client);

    // The chosen coordinator stands: `coordinator_workspace_id` is where the conversation runs, and
    // it does not outrank a membership somebody wrote.
    assert.equal(first[P_BOUND], AGENT_OTHER);
    assert.deepEqual(second, first);
    assert.equal((await client.query(`SELECT count(*)::int n FROM "project_member"`)).rows[0].n, 1);
  } finally {
    await client.end();
  }
});

test('every project comes out of it with a runtime row, and none of them with an opinion', { skip }, async () => {
  const client = await connect();
  try {
    await seedPreMigration(client);
    await client.query(IDENTITY);
    // A project that came out of 0111 without a runtime row: what an old writer produces by
    // inserting after 0111's backfill has already run. It is the mixed-version window, in one row.
    await client.query(`DELETE FROM "project_runtime" WHERE "project_id" = '${P_UNBOUND}'`);

    await client.query(COMPANIONS);

    const { rows } = await client.query(`
      SELECT p."id", r."project_id" IS NOT NULL AS has_runtime, r."coordinator_generation" AS generation,
             p."coordinator_enabled", p."automation_policy"
        FROM "project" p LEFT JOIN "project_runtime" r ON r."project_id" = p."id"`);
    assert.equal(rows.length, 4);
    for (const row of rows) {
      assert.equal(row.has_runtime, true, `${row.id} must have a runtime row`);
      assert.equal(row.generation, '0');
      // 0112 is as silent as 0111 about what a project that already existed is allowed to do.
      assert.equal(row.coordinator_enabled, false);
      assert.equal(row.automation_policy, 'MANUAL');
    }
  } finally {
    await client.end();
  }
});

test('a project created and deleted in one transaction still commits', { skip }, async () => {
  const client = await connect();
  try {
    await seedPreMigration(client);
    await client.query(IDENTITY);
    await client.query(COMPANIONS);

    // The companions are written at COMMIT, by which time this project is gone. Inserting them for
    // a row that no longer exists would be refused by the foreign key — and would take a
    // transaction that did nothing wrong down with it.
    const fresh = '00000000-0000-7000-8000-0000000004e3';
    await client.query('BEGIN');
    await client.query(`
      INSERT INTO "project" ("id", "owner_id", "title", "coordinator_workspace_id", "created_at", "updated_at")
      VALUES ('${fresh}', '${OWNER}', 'short lived', '${AGENT}', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`);
    await client.query(`DELETE FROM "project" WHERE "id" = '${fresh}'`);
    await client.query('COMMIT');

    const left = await client.query(`
      SELECT (SELECT count(*)::int FROM "project" WHERE "id" = '${fresh}') AS projects,
             (SELECT count(*)::int FROM "project_runtime" WHERE "project_id" = '${fresh}') AS runtimes,
             (SELECT count(*)::int FROM "project_member" WHERE "project_id" = '${fresh}') AS members`);
    assert.deepEqual(left.rows[0], { projects: 0, runtimes: 0, members: 0 });
  } finally {
    await client.end();
  }
});

// ── The old writer, after both migrations (validation 04, P1-06) ──────────────────────────────
//
// Every INSERT and UPDATE below is written the way the 0110 binary writes it: the columns it knows
// about, and no companion rows, because it has never heard of them. Nothing in this file's
// application code is involved — that is the point.

test('a project inserted in the 0110 shape still gets its runtime row and its identity', { skip }, async () => {
  const client = await connect();
  try {
    await seedPreMigration(client);
    await client.query(IDENTITY);
    await client.query(COMPANIONS);

    // A project that did not exist when either migration ran, inserted with the columns the 0110
    // binary knows and none of the rows it does not.
    const fresh = '00000000-0000-7000-8000-0000000004e1';
    await client.query(`
      INSERT INTO "project" ("id", "owner_id", "title", "coordinator_session_id", "coordinator_workspace_id",
                            "created_at", "updated_at")
      VALUES ('${fresh}', '${OWNER}', 'old writer', '${SESSION_NEW}', '${AGENT}',
              CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`);

    const runtime = await client.query(
      `SELECT "coordinator_generation" FROM "project_runtime" WHERE "project_id" = '${fresh}'`,
    );
    const members = await coordinators(client);
    // Neither row was written by the inserting statement. Both exist by the time it commits.
    assert.equal(runtime.rowCount, 1);
    assert.equal(runtime.rows[0].coordinator_generation, '0');
    assert.equal(members[fresh], AGENT);
    // And the safe defaults still apply to it: a project an old binary made is not an automatic one.
    const { rows } = await client.query(
      `SELECT "coordinator_enabled", "automation_policy" FROM "project" WHERE "id" = '${fresh}'`,
    );
    assert.equal(rows[0].coordinator_enabled, false);
    assert.equal(rows[0].automation_policy, 'MANUAL');
  } finally {
    await client.end();
  }
});

test('an old writer cannot bind a coordinator to another account’s agent', { skip }, async () => {
  const client = await connect();
  try {
    await seedPreMigration(client);
    await client.query(IDENTITY);
    await client.query(COMPANIONS);

    const fresh = '00000000-0000-7000-8000-0000000004e2';
    await client.query(`
      INSERT INTO "project" ("id", "owner_id", "title", "coordinator_workspace_id", "created_at", "updated_at")
      VALUES ('${fresh}', '${OWNER}', 'cross tenant', '${AGENT_THEIRS}', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`);

    // The runtime row is unconditional; the identity is not. Filling this one in would hand an
    // account's agent to another account's project — the same condition the backfill applies, in
    // the same statement, for the same reason.
    const members = await coordinators(client);
    assert.equal(members[fresh], undefined);
    assert.equal(
      (await client.query(`SELECT count(*)::int n FROM "project_runtime" WHERE "project_id" = '${fresh}'`))
        .rows[0].n,
      1,
    );
  } finally {
    await client.end();
  }
});

test('an old writer binding a coordinator later gets the identity then', { skip }, async () => {
  const client = await connect();
  try {
    await seedPreMigration(client);
    await client.query(IDENTITY);
    await client.query(COMPANIONS);

    // P_UNBOUND has no workspace and no identity; the old binary opens its first coordinator.
    await client.query(`
      UPDATE "project" SET "coordinator_session_id" = '${SESSION_NEW}', "coordinator_workspace_id" = '${AGENT}'
       WHERE "id" = '${P_UNBOUND}'`);

    const members = await coordinators(client);
    assert.equal(members[P_UNBOUND], AGENT);
    // A first coordinator is not a rotation of anything.
    const { rows } = await client.query(
      `SELECT "coordinator_generation" FROM "project_runtime" WHERE "project_id" = '${P_UNBOUND}'`,
    );
    assert.equal(rows[0].coordinator_generation, '0');
  } finally {
    await client.end();
  }
});

test('a rotation performed by an old writer is counted anyway', { skip }, async () => {
  const client = await connect();
  try {
    await seedPreMigration(client);
    await client.query(IDENTITY);
    await client.query(COMPANIONS);
    const generation = async (id: string) =>
      (
        await client.query(
          `SELECT "coordinator_generation" g FROM "project_runtime" WHERE "project_id" = '${id}'`,
        )
      ).rows[0].g;

    assert.equal(await generation(P_BOUND), '0');
    // The 0110 swap: one pointer replaced by another, and nothing else.
    await client.query(
      `UPDATE "project" SET "coordinator_session_id" = '${SESSION_NEW}' WHERE "id" = '${P_BOUND}'`,
    );
    assert.equal(await generation(P_BOUND), '1');

    // Losing the session is not a rotation — the project is waiting for its next coordinator, not
    // running a second one.
    await client.query(`UPDATE "project" SET "coordinator_session_id" = NULL WHERE "id" = '${P_BOUND}'`);
    assert.equal(await generation(P_BOUND), '1');
    // Nor is binding one to a project that had none.
    await client.query(
      `UPDATE "project" SET "coordinator_session_id" = '${SESSION_OLD}' WHERE "id" = '${P_BOUND}'`,
    );
    assert.equal(await generation(P_BOUND), '1');
    // Writing the same pointer again is not a replacement either, however many times it happens.
    await client.query(
      `UPDATE "project" SET "coordinator_session_id" = '${SESSION_OLD}' WHERE "id" = '${P_BOUND}'`,
    );
    assert.equal(await generation(P_BOUND), '1');

    // The identity is untouched by every one of them: rotation changes the conversation, never who
    // is having it (§7.5).
    assert.equal((await coordinators(client))[P_BOUND], AGENT);
  } finally {
    await client.end();
  }
});
