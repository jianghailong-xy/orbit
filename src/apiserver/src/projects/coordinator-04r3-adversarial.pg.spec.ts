import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import type { Client } from 'pg';

import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from './coordinator-pg-test-safety';

/**
 * 04R3's independent fault-injection matrix for migration 0114.
 *
 * This file deliberately does not import the development fixture or its expected states. It
 * builds the 0110 shape, applies the four migrations as released, and writes each transition in
 * the shape of the binary being modelled. Set COORDINATOR_PG_REVERSE_0114=1 to put the 0113
 * reconcile function back on the forward schema: the paired derived/explicit counterexample and
 * every absorbing-state assertion must then catch the regression which 04R2 reported.
 */
const URL = process.env.COORDINATOR_PG_URL;
const SCHEMA = 'pcc04r3_adversarial';

const migration = (name: string) =>
  readFileSync(path.resolve(__dirname, `../../prisma/migrations/${name}/migration.sql`), 'utf8');

const IDENTITY = migration('0111_project_coordinator_identity');
const COMPANIONS = migration('0112_project_coordinator_companions');
const FINAL_ROW = migration('0113_project_coordinator_final_row');
const IDENTITY_SOURCE_GUARD = migration('0113_project_coordinator_identity_source_guard');
const IDENTITY_SOURCE = migration('0114_project_coordinator_identity_source');
const IDENTITY_WINDOW_REPAIR = migration('0115_project_coordinator_identity_window_repair');

const PRISMA_SCHEMA = `
generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "postgresql"
}
`;

/**
 * Prisma 7 takes `migrations.path` from the project's own `prisma.config.ts`, which `--schema`
 * does not override: pointed at a temporary schema the executor still read the repository's whole
 * migration history and died in 0068 on a private schema that cannot see `public.pg_trgm`. The
 * fixture therefore ships a config of its own, bound to the directory it just wrote.
 */
const PRISMA_CONFIG = (root: string) => `export default {
  schema: ${JSON.stringify(path.join(root, 'schema.prisma'))},
  migrations: { path: ${JSON.stringify(path.join(root, 'migrations'))} },
  datasource: { url: process.env.DATABASE_URL },
};
`;

/** Every migration name this fixture ever writes. Nothing else may reach the executor. */
const FIXTURE_MIGRATIONS = [
  '0000_coordinator_0110',
  '0111_project_coordinator_identity',
  '0112_project_coordinator_companions',
  '0113_project_coordinator_final_row',
  '0113_project_coordinator_identity_source_guard',
  '0114_project_coordinator_identity_source',
  '0115_project_coordinator_identity_window_repair',
];

const BASELINE_0110 = `
CREATE TABLE "workspace" (
  "id" UUID PRIMARY KEY,
  "owner_id" UUID NOT NULL,
  "name" TEXT NOT NULL,
  "enabled" BOOLEAN NOT NULL DEFAULT true,
  "deleted_at" TIMESTAMP(3)
);
CREATE TABLE "session" ("id" UUID PRIMARY KEY, "owner_id" UUID NOT NULL);
CREATE TABLE "project" (
  "id" UUID PRIMARY KEY,
  "owner_id" UUID NOT NULL,
  "title" TEXT NOT NULL,
  "coordinator_session_id" UUID UNIQUE REFERENCES "session"("id") ON DELETE SET NULL,
  "coordinator_workspace_id" UUID REFERENCES "workspace"("id") ON DELETE SET NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
`;

const OWNER = '00000000-0000-7000-8000-0000000008a1';
const OTHER_OWNER = '00000000-0000-7000-8000-0000000008a2';
const A = '00000000-0000-7000-8000-0000000008b1';
const B = '00000000-0000-7000-8000-0000000008b2';
const C = '00000000-0000-7000-8000-0000000008b3';
const DELETED = '00000000-0000-7000-8000-0000000008b4';
const THEIRS = '00000000-0000-7000-8000-0000000008b5';
const DISABLED = '00000000-0000-7000-8000-0000000008b6';
const S = Array.from(
  { length: 8 },
  (_, i) => `00000000-0000-7000-8000-0000000008c${i + 1}`,
);
const P = (n: number) =>
  `00000000-0000-7000-8000-000000008d${n.toString(16).padStart(2, '0')}`;

type ClientCtor = new (config: { connectionString?: string }) => Client;

async function open(schema = SCHEMA): Promise<Client> {
  assertCoordinatorPgUrlIsIsolated(URL);
  const { Client: Ctor } = (await import('pg')) as unknown as { Client: ClientCtor };
  const client = new Ctor({ connectionString: URL });
  await client.connect();
  await verifyCoordinatorPgIdentity(client);
  await client.query(`SET search_path TO ${schema}`);
  return client;
}

async function writeMigration(root: string, name: string, sql: string): Promise<void> {
  const directory = path.join(root, 'migrations', name);
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, 'migration.sql'), sql);
}

type ExecutorFixture = {
  root: string;
  schemaPath: string;
  configPath: string;
  databaseUrl: string;
};

async function makeExecutorFixture(schema: string): Promise<ExecutorFixture> {
  assert.ok(URL);
  const root = await mkdtemp(path.join(os.tmpdir(), 'pcc03d-prisma-'));
  const schemaPath = path.join(root, 'schema.prisma');
  const configPath = path.join(root, 'prisma.config.ts');
  await writeFile(schemaPath, PRISMA_SCHEMA);
  await writeFile(configPath, PRISMA_CONFIG(root));
  await writeMigration(root, '0000_coordinator_0110', BASELINE_0110);
  await writeMigration(root, '0111_project_coordinator_identity', IDENTITY);
  await writeMigration(root, '0112_project_coordinator_companions', COMPANIONS);
  await writeMigration(root, '0113_project_coordinator_final_row', FINAL_ROW);
  const parsed = new globalThis.URL(URL);
  parsed.searchParams.set('schema', schema);
  parsed.searchParams.set('application_name', `prisma_${schema}`);
  return { root, schemaPath, configPath, databaseUrl: parsed.toString() };
}

/**
 * The CLI reports which config it loaded and how many migrations it found; both must be the
 * fixture's. It labels the directory `prisma/migrations` whatever the configured path is, so the
 * count is what distinguishes these few files from the repository's whole history.
 */
function assertFixtureMigrationsOnly(output: string, fixture: ExecutorFixture, found: number): void {
  assert.ok(
    output.includes(`${path.basename(fixture.root)}${path.sep}prisma.config.ts`),
    `the executor did not load the fixture's own Prisma config:\n${output}`,
  );
  assert.match(
    output, new RegExp(`^${found} migrations found`, 'm'),
    `the executor found migrations other than the fixture's ${found}:\n${output}`,
  );
  const foreign = [...output.matchAll(/Applying migration `([^`]+)`/g)]
    .map((match) => match[1])
    .filter((name) => !FIXTURE_MIGRATIONS.includes(name));
  assert.deepEqual(foreign, [], `the executor applied migrations the fixture never wrote:\n${output}`);
}

function startPrismaDeploy(fixture: ExecutorFixture) {
  let output = '';
  let finished = false;
  const found = readdirSync(path.join(fixture.root, 'migrations')).length;
  const child = spawn(
    process.platform === 'win32' ? 'npx.cmd' : 'npx',
    [
      '--no-install', 'prisma', 'migrate', 'deploy',
      '--config', fixture.configPath,
      '--schema', fixture.schemaPath,
    ],
    {
      cwd: path.resolve(__dirname, '../..'),
      env: { ...process.env, DATABASE_URL: fixture.databaseUrl, NO_COLOR: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    },
  );
  child.stdout.on('data', (chunk) => { output += String(chunk); });
  child.stderr.on('data', (chunk) => { output += String(chunk); });
  const done = new Promise<string>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => {
      finished = true;
      if (code !== 0) {
        reject(new Error(`prisma migrate deploy exited ${code ?? signal}:\n${output}`));
        return;
      }
      try {
        assertFixtureMigrationsOnly(output, fixture, found);
        resolve(output);
      } catch (error) {
        reject(error);
      }
    });
  });
  return {
    done,
    output: () => output,
    finished: () => finished,
    stop: () => {
      if (process.platform !== 'win32' && child.pid !== undefined) {
        process.kill(-child.pid, 'SIGTERM');
      } else {
        child.kill('SIGTERM');
      }
    },
  };
}

async function prismaDeploy(fixture: ExecutorFixture): Promise<string> {
  return startPrismaDeploy(fixture).done;
}

async function waitForExecutorPause(client: Client, schema: string, deploy: ReturnType<typeof startPrismaDeploy>) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const { rows } = await client.query(`
      SELECT state, wait_event
        FROM pg_stat_activity
       WHERE datname = current_database()
         AND pid <> pg_backend_pid()
         AND application_name = $1`, [`prisma_${schema}`]);
    if (rows.some((row: any) => row.state === 'active' && row.wait_event === 'PgSleep')) return;
    if (deploy.finished()) throw new Error(`migration exited before pause was observed:\n${deploy.output()}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`did not observe Prisma executor pause in ${schema}:\n${deploy.output()}`);
}

async function seedExecutor(client: Client): Promise<void> {
  await client.query(`
    INSERT INTO "workspace" ("id", "owner_id", "name", "enabled", "deleted_at") VALUES
      ('${A}', '${OWNER}', 'A', true, NULL),
      ('${B}', '${OWNER}', 'B', true, NULL),
      ('${C}', '${OWNER}', 'C', true, NULL);
    INSERT INTO "session" ("id", "owner_id")
    SELECT s, '${OWNER}' FROM unnest(ARRAY[${S.map((s) => `'${s}'::uuid`).join(',')}]) s;
  `);
}

async function setup(client: Client, mode: 'current' | 'applied-0114' = 'current'): Promise<void> {
  await client.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
  await client.query(`CREATE SCHEMA ${SCHEMA}`);
  await client.query(`SET search_path TO ${SCHEMA}`);
  await client.query(`
    CREATE TABLE "workspace" (
      "id" UUID PRIMARY KEY,
      "owner_id" UUID NOT NULL,
      "name" TEXT NOT NULL,
      "enabled" BOOLEAN NOT NULL DEFAULT true,
      "deleted_at" TIMESTAMP(3)
    );
    CREATE TABLE "session" ("id" UUID PRIMARY KEY, "owner_id" UUID NOT NULL);
    CREATE TABLE "project" (
      "id" UUID PRIMARY KEY,
      "owner_id" UUID NOT NULL,
      "title" TEXT NOT NULL,
      "coordinator_session_id" UUID UNIQUE REFERENCES "session"("id") ON DELETE SET NULL,
      "coordinator_workspace_id" UUID REFERENCES "workspace"("id") ON DELETE SET NULL,
      "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    INSERT INTO "workspace" ("id", "owner_id", "name", "enabled", "deleted_at") VALUES
      ('${A}', '${OWNER}', 'A', true, NULL),
      ('${B}', '${OWNER}', 'B', true, NULL),
      ('${C}', '${OWNER}', 'C', true, NULL),
      ('${DELETED}', '${OWNER}', 'deleted', true, CURRENT_TIMESTAMP),
      ('${THEIRS}', '${OTHER_OWNER}', 'theirs', true, NULL),
      ('${DISABLED}', '${OWNER}', 'disabled', false, NULL);
    INSERT INTO "session" ("id", "owner_id")
    SELECT s, '${OWNER}' FROM unnest(ARRAY[${S.map((s) => `'${s}'::uuid`).join(',')}]) s;
  `);
  await client.query(IDENTITY);
  await client.query(COMPANIONS);
  await client.query(FINAL_ROW);
  if (mode === 'current') await client.query(IDENTITY_SOURCE_GUARD);
  await client.query(IDENTITY_SOURCE);
  if (mode === 'current') await client.query(IDENTITY_WINDOW_REPAIR);
  if (process.env.COORDINATOR_PG_REVERSE_0114 === '1') await client.query(FINAL_ROW);
}

const oldInsert = (id: string, landing: string | null, session: string | null) => `
  INSERT INTO "project" ("id", "owner_id", "title", "coordinator_session_id",
                         "coordinator_workspace_id", "created_at", "updated_at")
  VALUES ('${id}', '${OWNER}', '04r3 ${id}', ${session ? `'${session}'` : 'NULL'},
          ${landing ? `'${landing}'` : 'NULL'}, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`;

async function choose(client: Client, id: string, agent: string | null): Promise<void> {
  await client.query('BEGIN');
  await client.query(`SELECT "id" FROM "project" WHERE "id" = '${id}' FOR NO KEY UPDATE`);
  await client.query(`
    INSERT INTO "project_runtime" ("project_id", "coordinator_identity_source",
                                   "coordinator_identity_landing_id", "created_at", "updated_at")
    VALUES ('${id}', 'EXPLICIT', NULL, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    ON CONFLICT ("project_id") DO UPDATE
       SET "coordinator_identity_source" = 'EXPLICIT',
           "coordinator_identity_landing_id" = NULL,
           "updated_at" = CURRENT_TIMESTAMP`);
  await client.query(
    `DELETE FROM "project_member" WHERE "project_id" = '${id}' AND "role" = 'COORDINATOR'`,
  );
  if (agent !== null) {
    await client.query(`
      INSERT INTO "project_member" ("id", "project_id", "agent_id", "role", "added_at")
      VALUES (gen_random_uuid(), '${id}', '${agent}', 'COORDINATOR', CURRENT_TIMESTAMP)
      ON CONFLICT ("project_id", "agent_id") DO UPDATE SET "role" = 'COORDINATOR'`);
  }
  await client.query('COMMIT');
}

async function state(client: Client, id: string) {
  const { rows } = await client.query(`
    SELECT p."coordinator_workspace_id" AS landing,
           p."coordinator_session_id" AS session,
           m."agent_id" AS agent,
           r."coordinator_generation"::int AS generation,
           r."coordinator_session_id" AS session_baseline,
           r."coordinator_identity_source" AS source,
           r."coordinator_identity_landing_id" AS identity_baseline,
           (SELECT count(*)::int FROM "project_member" pm
             WHERE pm."project_id" = p."id" AND pm."role" = 'COORDINATOR') AS coordinators
      FROM "project" p
      JOIN "project_runtime" r ON r."project_id" = p."id"
      LEFT JOIN "project_member" m
        ON m."project_id" = p."id" AND m."role" = 'COORDINATOR'
     WHERE p."id" = '${id}'`);
  return rows[0];
}

const skip = URL ? false : 'set COORDINATOR_PG_URL to run';

test('the corrected old assertion distinguishes a derivation from the 04R2 explicit counterexample', { skip }, async () => {
  const client = await open();
  try {
    await setup(client);
    const derived = P(1);
    const explicit = P(2);
    await client.query(oldInsert(derived, A, S[0]));
    await client.query(oldInsert(explicit, A, S[1]));
    await choose(client, explicit, C);

    for (const id of [derived, explicit]) {
      await client.query(`
        UPDATE "project" SET "coordinator_workspace_id" = '${B}',
                             "coordinator_session_id" = '${id === derived ? S[2] : S[3]}'
         WHERE "id" = '${id}'`);
    }

    const d = await state(client, derived);
    const e = await state(client, explicit);
    assert.deepEqual(
      { landing: d.landing, agent: d.agent, source: d.source, identity_baseline: d.identity_baseline },
      { landing: B, agent: B, source: 'DERIVED', identity_baseline: B },
      '04R: only the identity which the database derived follows WHERE',
    );
    assert.deepEqual(
      { landing: e.landing, agent: e.agent, source: e.source, identity_baseline: e.identity_baseline },
      { landing: B, agent: C, source: 'EXPLICIT', identity_baseline: null },
      '04R2: the same relocation cannot rewrite somebody’s chosen WHO',
    );
    assert.equal(d.generation, 1);
    assert.equal(e.generation, 1);
  } finally {
    await client.end();
  }
});
test('chooser-first and relocation-first commits both preserve the final explicit WHO', { skip }, async () => {
  const left = await open();
  const right = await open();
  try {
    // Ordering 1: the chooser owns the Project lock first; the old relocation waits, then observes
    // EXPLICIT. This independently repeats the ordering development covered.
    await setup(left);
    await right.query(`SET search_path TO ${SCHEMA}`);
    const chooserFirst = P(0x10);
    await left.query(oldInsert(chooserFirst, A, S[0]));
    await left.query('BEGIN');
    await left.query(`SELECT "id" FROM "project" WHERE "id" = '${chooserFirst}' FOR NO KEY UPDATE`);
    await left.query(`UPDATE "project_runtime" SET "coordinator_identity_source" = 'EXPLICIT',
      "coordinator_identity_landing_id" = NULL WHERE "project_id" = '${chooserFirst}'`);
    await left.query(`UPDATE "project_member" SET "agent_id" = '${C}'
      WHERE "project_id" = '${chooserFirst}' AND "role" = 'COORDINATOR'`);

    await right.query('BEGIN');
    let moved = false;
    const moveAfterChoice = right
      .query(`UPDATE "project" SET "coordinator_workspace_id" = '${B}',
                                  "coordinator_session_id" = '${S[1]}'
               WHERE "id" = '${chooserFirst}'`)
      .then(() => right.query('COMMIT'))
      .then(() => { moved = true; });
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(moved, false, 'the relocation waits for the chooser’s row lock');
    await left.query('COMMIT');
    await moveAfterChoice;
    assert.deepEqual(
      (({ landing, agent, source }: any) => ({ landing, agent, source }))(await state(left, chooserFirst)),
      { landing: B, agent: C, source: 'EXPLICIT' },
    );

    // Ordering 2: the old relocation owns the same lock first; the chooser waits, then makes the
    // last authorized WHO write against the already-relocated row. This was the missing ordering.
    const moverFirst = P(0x11);
    await left.query(oldInsert(moverFirst, A, S[2]));
    await left.query('BEGIN');
    await left.query(`UPDATE "project" SET "coordinator_workspace_id" = '${B}',
                                          "coordinator_session_id" = '${S[3]}'
                       WHERE "id" = '${moverFirst}'`);

    await right.query('BEGIN');
    let locked = false;
    const chooseAfterMove = right
      .query(`SELECT "id" FROM "project" WHERE "id" = '${moverFirst}' FOR NO KEY UPDATE`)
      .then(async () => {
        locked = true;
        await right.query(`UPDATE "project_runtime" SET "coordinator_identity_source" = 'EXPLICIT',
          "coordinator_identity_landing_id" = NULL WHERE "project_id" = '${moverFirst}'`);
        await right.query(`UPDATE "project_member" SET "agent_id" = '${C}'
          WHERE "project_id" = '${moverFirst}' AND "role" = 'COORDINATOR'`);
        await right.query('COMMIT');
      });
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(locked, false, 'the chooser waits for the relocation’s row lock');
    await left.query('COMMIT');
    await chooseAfterMove;
    const final = await state(left, moverFirst);
    assert.deepEqual(
      { landing: final.landing, agent: final.agent, source: final.source },
      { landing: B, agent: C, source: 'EXPLICIT' },
    );
    assert.equal(final.generation, 1);
  } finally {
    await left.end();
    await right.end();
  }
});

test('EXPLICIT is absorbing across rotation, duplicate events, clear and reselect', { skip }, async () => {
  const client = await open();
  try {
    await setup(client);
    const id = P(0x20);
    await client.query(oldInsert(id, A, S[0]));
    await choose(client, id, C);

    await client.query('BEGIN');
    await client.query(`UPDATE "project" SET "coordinator_session_id" = '${S[1]}' WHERE "id" = '${id}'`);
    await client.query(`UPDATE "project" SET "coordinator_workspace_id" = '${B}' WHERE "id" = '${id}'`);
    await client.query(`UPDATE "project" SET "coordinator_workspace_id" = '${A}' WHERE "id" = '${id}'`);
    await client.query(`UPDATE "project" SET "coordinator_workspace_id" = '${B}' WHERE "id" = '${id}'`);
    await client.query('COMMIT');
    assert.deepEqual(
      (({ landing, agent, source, generation }: any) => ({ landing, agent, source, generation }))(
        await state(client, id),
      ),
      { landing: B, agent: C, source: 'EXPLICIT', generation: 1 },
    );

    await client.query(`UPDATE "project" SET "coordinator_session_id" = '${S[2]}' WHERE "id" = '${id}'`);
    assert.equal((await state(client, id)).agent, C, 'a pure Session rotation cannot change WHO');
    assert.equal((await state(client, id)).generation, 2);

    await choose(client, id, null);
    await client.query(`UPDATE "project" SET "coordinator_workspace_id" = '${A}',
                                            "coordinator_session_id" = '${S[3]}'
                         WHERE "id" = '${id}'`);
    const cleared = await state(client, id);
    assert.equal(cleared.agent, null, 'landing movement cannot undo an explicit clear');
    assert.equal(cleared.source, 'EXPLICIT');
    assert.equal(cleared.generation, 3);

    await client.query(`UPDATE "project" SET "coordinator_workspace_id" = '${A}',
                                            "coordinator_session_id" = '${S[3]}'
                         WHERE "id" = '${id}'`);
    assert.deepEqual(await state(client, id), cleared, 'an exact replay changes nothing');

    await choose(client, id, C);
    await client.query(`UPDATE "project" SET "coordinator_workspace_id" = '${B}',
                                            "coordinator_session_id" = '${S[4]}'
                         WHERE "id" = '${id}'`);
    const reselected = await state(client, id);
    assert.equal(reselected.agent, C);
    assert.equal(reselected.source, 'EXPLICIT');
    assert.equal(reselected.generation, 4);
  } finally {
    await client.end();
  }
});

test('an illegal old-binary choice is structurally promoted and typed fail-closed', { skip }, async () => {
  const client = await open();
  try {
    await setup(client);
    for (const [offset, illegal] of [DELETED, THEIRS].entries()) {
      const id = P(0x30 + offset);
      await client.query(oldInsert(id, A, S[offset]));
      // No provenance write: this is the 0113 binary on a forward schema. Before the next Project
      // event the runtime still says DERIVED, so the test only passes if 0114 recognises the shape,
      // promotes it, validates the chosen seat, and refuses — in that order.
      await client.query(`UPDATE "project_member" SET "agent_id" = '${illegal}'
        WHERE "project_id" = '${id}' AND "role" = 'COORDINATOR'`);
      assert.equal((await state(client, id)).source, 'DERIVED');

      await assert.rejects(
        () => client.query(`UPDATE "project" SET "coordinator_workspace_id" = '${B}' WHERE "id" = '${id}'`),
        (error: any) => {
          assert.equal(error.code, 'ORB01');
          assert.match(String(error.message), /explicitly chosen coordinator agent/);
          return true;
        },
      );
      const unchanged = await state(client, id);
      assert.equal(unchanged.landing, A, 'the unsafe relocation did not commit');
      assert.equal(unchanged.agent, illegal, 'the trigger did not silently replace the choice');
      assert.equal(unchanged.source, 'DERIVED', 'the attempted promotion rolled back atomically too');
    }
  } finally {
    await client.end();
  }
});

test('the two pre-0114 indistinguishability boundaries remain explicit and deterministic', { skip }, async () => {
  const client = await open();
  try {
    await setup(client);

    // A rolled-back binary explicitly names the agent which already equals the landing, but cannot
    // write provenance. The bytes are identical to a derivation, so the documented answer is
    // DERIVED: a later landing relocation takes the seat with it.
    const equal = P(0x40);
    await client.query(oldInsert(equal, A, S[0]));
    await client.query(`UPDATE "project_member" SET "agent_id" = '${A}'
      WHERE "project_id" = '${equal}' AND "role" = 'COORDINATOR'`);
    await client.query(`UPDATE "project" SET "coordinator_workspace_id" = '${B}' WHERE "id" = '${equal}'`);
    const equalAfter = await state(client, equal);
    assert.equal(equalAfter.source, 'DERIVED');
    assert.equal(equalAfter.agent, B);

    // With neither a seat nor a recorded derivation, an old-binary clear is byte-for-byte the same
    // as "there was never an identity". The documented answer is again DERIVED: the first legal
    // landing may seat one. This is the exact no-baseline clear boundary, not a claimed success.
    const noBaseline = P(0x41);
    await client.query(oldInsert(noBaseline, null, S[1]));
    await client.query(`DELETE FROM "project_member" WHERE "project_id" = '${noBaseline}'`);
    const beforeLanding = await state(client, noBaseline);
    assert.equal(beforeLanding.source, 'DERIVED');
    assert.equal(beforeLanding.identity_baseline, null);
    await client.query(`UPDATE "project" SET "coordinator_workspace_id" = '${A}' WHERE "id" = '${noBaseline}'`);
    const afterLanding = await state(client, noBaseline);
    assert.equal(afterLanding.agent, A);
    assert.equal(afterLanding.source, 'DERIVED');

    // Disabled is a separate boundary from deleted/cross-tenant: it is still a truthful identity,
    // although the service refuses to run a coordinator on a disabled landing. Provenance therefore
    // preserves it; the run path's COORDINATOR_UNAVAILABLE test remains the fail-closed mechanism.
    const disabled = P(0x42);
    await client.query(oldInsert(disabled, A, S[2]));
    await choose(client, disabled, DISABLED);
    await client.query(`UPDATE "project" SET "coordinator_workspace_id" = '${B}' WHERE "id" = '${disabled}'`);
    const disabledAfter = await state(client, disabled);
    assert.equal(disabledAfter.agent, DISABLED);
    assert.equal(disabledAfter.source, 'EXPLICIT');
  } finally {
    await client.end();
  }
});

test('a DERIVED row committed in the 0114 backfill/function gap still converges A to B', { skip }, async () => {
  const client = await open();
  try {
    await setup(client);
    const id = P(0x50);
    await client.query(oldInsert(id, A, S[0]));

    // This is the exact durable shape observed while a real `prisma migrate deploy` was paused
    // after 0114's backfill and before its CREATE OR REPLACE FUNCTION. The still-serving 0113
    // function inserted the project and its mechanically-derived A, but could not record the new
    // provenance column. Prisma applies the migration file statement by statement, so that old
    // writer committed during the gap; this assignment recreates only the resulting bytes, not a
    // state invented by the test.
    await client.query(`UPDATE "project_runtime"
      SET "coordinator_identity_source" = 'DERIVED',
          "coordinator_identity_landing_id" = NULL
      WHERE "project_id" = '${id}'`);
    assert.deepEqual(await state(client, id), {
      landing: A,
      session: S[0],
      agent: A,
      generation: 0,
      session_baseline: S[0],
      source: 'DERIVED',
      identity_baseline: null,
      coordinators: 1,
    });

    // 04R's invariant is unconditional for legacy derivations: after the landing moves, WHO must
    // converge to B. f2883075 instead promotes the baseline-less A to EXPLICIT and commits A/B.
    await client.query(`UPDATE "project" SET "coordinator_workspace_id" = '${B}' WHERE "id" = '${id}'`);
    const after = await state(client, id);
    assert.equal(after.landing, B);
    assert.equal(after.agent, B, 'a legacy-derived identity must keep converging with its landing');
    assert.equal(after.source, 'DERIVED');
    assert.equal(after.identity_baseline, B);
  } finally {
    await client.end();
  }
});

test('an already-applied 0114 database installs the guard and recovers a gap row safely', { skip }, async () => {
  const client = await open();
  try {
    await setup(client, 'applied-0114');
    const id = P(0x51);
    await client.query(oldInsert(id, A, S[0]));
    await client.query(`UPDATE "project_runtime"
      SET "coordinator_identity_source" = 'DERIVED',
          "coordinator_identity_landing_id" = NULL
      WHERE "project_id" = '${id}'`);

    // A database which already recorded 0114 sees the newly-added, lexically earlier guard as a
    // pending migration. It remains retryably fail-closed until 0115 installs the recovery path.
    await client.query(IDENTITY_SOURCE_GUARD);
    await assert.rejects(
      () => client.query(`UPDATE "project" SET "coordinator_workspace_id" = '${B}' WHERE "id" = '${id}'`),
      (error: any) => {
        assert.equal(error.code, 'ORB02');
        assert.match(String(error.message), /provenance migration is in progress/);
        return true;
      },
    );
    assert.deepEqual(
      (({ landing, agent, source, identity_baseline }: any) =>
        ({ landing, agent, source, identity_baseline }))(await state(client, id)),
      { landing: A, agent: A, source: 'DERIVED', identity_baseline: null },
      'the typed refusal commits no partial relocation or provenance change',
    );

    await client.query(IDENTITY_WINDOW_REPAIR);
    const repairedBeforeMove = await state(client, id);
    assert.equal(repairedBeforeMove.identity_baseline, A, '0115 safely backfills the equal seat');
    await client.query(`UPDATE "project" SET "coordinator_workspace_id" = '${B}' WHERE "id" = '${id}'`);
    const after = await state(client, id);
    assert.deepEqual(
      { landing: after.landing, agent: after.agent, source: after.source,
        identity_baseline: after.identity_baseline },
      { landing: B, agent: B, source: 'DERIVED', identity_baseline: B },
    );
  } finally {
    await client.end();
  }
});

test('0115 adopts only a provable derivation and preserves every ambiguous or explicit row',
  { skip }, async () => {
    const client = await open();
    try {
      await setup(client, 'applied-0114');
      const safe = P(0x54);
      const explicitEqual = P(0x55);
      const ambiguousChoice = P(0x56);
      const alreadyPromoted = P(0x57);
      await client.query(oldInsert(safe, A, S[0]));
      await client.query(oldInsert(explicitEqual, A, S[1]));
      await client.query(oldInsert(ambiguousChoice, A, S[2]));
      await client.query(oldInsert(alreadyPromoted, B, S[3]));

      await client.query(`
        UPDATE "project_runtime"
           SET "coordinator_identity_source" = 'DERIVED',
               "coordinator_identity_landing_id" = NULL
         WHERE "project_id" IN ('${safe}', '${ambiguousChoice}');
        UPDATE "project_runtime"
           SET "coordinator_identity_source" = 'EXPLICIT',
               "coordinator_identity_landing_id" = NULL
         WHERE "project_id" IN ('${explicitEqual}', '${alreadyPromoted}');
        UPDATE "project_member" SET "agent_id" = '${C}'
         WHERE "project_id" = '${ambiguousChoice}' AND "role" = 'COORDINATOR';
        UPDATE "project_member" SET "agent_id" = '${A}'
         WHERE "project_id" = '${alreadyPromoted}' AND "role" = 'COORDINATOR';
      `);

      await client.query(IDENTITY_SOURCE_GUARD);
      await client.query(IDENTITY_WINDOW_REPAIR);

      const adopted = await state(client, safe);
      const equalChoice = await state(client, explicitEqual);
      const ambiguous = await state(client, ambiguousChoice);
      const promoted = await state(client, alreadyPromoted);
      assert.deepEqual(
        { agent: adopted.agent, source: adopted.source,
          baseline: adopted.identity_baseline },
        { agent: A, source: 'DERIVED', baseline: A },
        'DERIVED + no baseline + member == landing is the one mechanically provable adoption',
      );
      assert.deepEqual(
        { agent: equalChoice.agent, source: equalChoice.source,
          baseline: equalChoice.identity_baseline },
        { agent: A, source: 'EXPLICIT', baseline: null },
        'an explicit choice equal to the landing is never silently demoted',
      );
      assert.deepEqual(
        { agent: ambiguous.agent, source: ambiguous.source,
          baseline: ambiguous.identity_baseline },
        { agent: C, source: 'DERIVED', baseline: null },
        'a different member is not safe for 0115 to adopt from shape alone',
      );
      assert.deepEqual(
        { landing: promoted.landing, agent: promoted.agent, source: promoted.source,
          baseline: promoted.identity_baseline },
        { landing: B, agent: A, source: 'EXPLICIT', baseline: null },
        'an already-promoted historical window row remains on the explicit/manual-recovery side',
      );

      await client.query(`UPDATE "project" SET "coordinator_workspace_id" = '${B}'
        WHERE "id" IN ('${safe}', '${explicitEqual}', '${ambiguousChoice}')`);
      const adoptedAfter = await state(client, safe);
      const equalChoiceAfter = await state(client, explicitEqual);
      const ambiguousAfter = await state(client, ambiguousChoice);
      assert.deepEqual(
        { landing: adoptedAfter.landing, agent: adoptedAfter.agent,
          source: adoptedAfter.source, baseline: adoptedAfter.identity_baseline },
        { landing: B, agent: B, source: 'DERIVED', baseline: B },
      );
      assert.deepEqual(
        { landing: equalChoiceAfter.landing, agent: equalChoiceAfter.agent,
          source: equalChoiceAfter.source, baseline: equalChoiceAfter.identity_baseline },
        { landing: B, agent: A, source: 'EXPLICIT', baseline: null },
      );
      assert.deepEqual(
        { landing: ambiguousAfter.landing, agent: ambiguousAfter.agent,
          source: ambiguousAfter.source, baseline: ambiguousAfter.identity_baseline },
        { landing: B, agent: C, source: 'EXPLICIT', baseline: null },
        'the permanent predicate leaves an old-binary C choice for 0114 to promote, not demote',
      );
    } finally {
      await client.end();
    }
  });

test('the migration guard remains durable and fail-closed after the 0114 executor is interrupted',
  { skip, timeout: 30_000 }, async () => {
    const executorSchema = 'pcc04r4_interrupted_guard';
    const marker = 'pcc04r4_0114_interrupted_pause';
    const admin = await open('public');
    let writer: Client | undefined;
    let fixture: Awaited<ReturnType<typeof makeExecutorFixture>> | undefined;
    let deploy: ReturnType<typeof startPrismaDeploy> | undefined;
    try {
      await admin.query(`DROP SCHEMA IF EXISTS ${executorSchema} CASCADE`);
      await admin.query(`CREATE SCHEMA ${executorSchema}`);
      fixture = await makeExecutorFixture(executorSchema);
      await prismaDeploy(fixture);
      writer = await open(executorSchema);
      await seedExecutor(writer);

      await writeMigration(
        fixture.root,
        '0113_project_coordinator_identity_source_guard',
        IDENTITY_SOURCE_GUARD,
      );
      const breakpoint = '-- ── The one rule, now told where the identity came from';
      assert.ok(IDENTITY_SOURCE.includes(breakpoint), '0114 pause injection point moved');
      await writeMigration(
        fixture.root,
        '0114_project_coordinator_identity_source',
        IDENTITY_SOURCE.replace(
          breakpoint,
          `SELECT pg_sleep(20) /* ${marker} */;\n\n${breakpoint}`,
        ),
      );
      await writeMigration(
        fixture.root,
        '0115_project_coordinator_identity_window_repair',
        IDENTITY_WINDOW_REPAIR,
      );

      deploy = startPrismaDeploy(fixture);
      await waitForExecutorPause(admin, executorSchema, deploy);
      const id = P(0x58);
      await assert.rejects(
        () => writer!.query(oldInsert(id, A, S[0])),
        (error: any) => error.code === 'ORB02',
      );

      const interrupted = assert.rejects(deploy.done, /prisma migrate deploy exited/);
      deploy.stop();
      await interrupted;
      deploy = undefined;

      const { rows: guards } = await writer.query(`
        SELECT tgname
          FROM pg_trigger
         WHERE tgrelid = '"project"'::regclass
           AND NOT tgisinternal
           AND tgname LIKE 'project_coordinator_identity_migration_%'
         ORDER BY tgname`);
      assert.deepEqual(
        guards.map((row: any) => row.tgname),
        [
          'project_coordinator_identity_migration_insert_guard',
          'project_coordinator_identity_migration_update_guard',
        ],
        'both guards were committed by the earlier migration and survived the interrupted 0114',
      );
      await assert.rejects(
        () => writer!.query(oldInsert(id, A, S[0])),
        (error: any) => {
          assert.equal(error.code, 'ORB02');
          assert.match(String(error.hint), /migrate deploy has completed/);
          return true;
        },
      );
      const { rows: residue } = await writer.query(`
        SELECT
          (SELECT count(*)::int FROM "project" WHERE "id" = '${id}') AS projects,
          (SELECT count(*)::int FROM "project_runtime" WHERE "project_id" = '${id}') AS runtimes,
          (SELECT count(*)::int FROM "project_member" WHERE "project_id" = '${id}') AS members`);
      assert.deepEqual(
        residue[0],
        { projects: 0, runtimes: 0, members: 0 },
        'a failed write before and after interruption leaves no Project or companion row',
      );
    } finally {
      if (deploy) {
        if (!deploy.finished()) deploy.stop();
        await deploy.done.catch(() => undefined);
      }
      await writer?.end();
      await admin.query(`DROP SCHEMA IF EXISTS ${executorSchema} CASCADE`);
      await admin.end();
      if (fixture) await rm(fixture.root, { recursive: true, force: true });
    }
  });

test('the real Prisma executor keeps an old writer typed fail-closed in the 0114 statement gap',
  { skip, timeout: 30_000 }, async () => {
    const executorSchema = 'pcc03d_executor';
    const marker = 'pcc03d_0114_executor_pause';
    const admin = await open('public');
    let writer: Client | undefined;
    let fixture: Awaited<ReturnType<typeof makeExecutorFixture>> | undefined;
    let deploy: ReturnType<typeof startPrismaDeploy> | undefined;
    try {
      await admin.query(`DROP SCHEMA IF EXISTS ${executorSchema} CASCADE`);
      await admin.query(`CREATE SCHEMA ${executorSchema}`);
      fixture = await makeExecutorFixture(executorSchema);
      await prismaDeploy(fixture);

      writer = await open(executorSchema);
      await seedExecutor(writer);
      await writeMigration(
        fixture.root,
        '0113_project_coordinator_identity_source_guard',
        IDENTITY_SOURCE_GUARD,
      );
      const breakpoint = '-- ── The one rule, now told where the identity came from';
      assert.ok(IDENTITY_SOURCE.includes(breakpoint), '0114 pause injection point moved');
      const paused0114 = IDENTITY_SOURCE.replace(
        breakpoint,
        `SELECT pg_sleep(4) /* ${marker} */;\n\n${breakpoint}`,
      );
      await writeMigration(
        fixture.root,
        '0114_project_coordinator_identity_source',
        paused0114,
      );
      await writeMigration(
        fixture.root,
        '0115_project_coordinator_identity_window_repair',
        IDENTITY_WINDOW_REPAIR,
      );

      deploy = startPrismaDeploy(fixture);
      await waitForExecutorPause(admin, executorSchema, deploy);
      const id = P(0x52);
      await assert.rejects(
        () => writer!.query(oldInsert(id, A, S[0])),
        (error: any) => {
          assert.equal(error.code, 'ORB02');
          assert.match(String(error.hint), /migrate deploy has completed/);
          return true;
        },
      );
      assert.equal(
        (await writer.query(`SELECT count(*)::int AS n FROM "project" WHERE "id" = '${id}'`)).rows[0].n,
        0,
        'the refused window write leaves no Project or companion rows',
      );

      const output = await deploy.done;
      deploy = undefined;
      assert.match(output, /Applying migration `0113_project_coordinator_identity_source_guard`/);
      assert.match(output, /Applying migration `0114_project_coordinator_identity_source`/);
      assert.match(output, /Applying migration `0115_project_coordinator_identity_window_repair`/);
      const recorded = (await writer.query(`SELECT migration_name FROM "_prisma_migrations"`))
        .rows.map((row: any) => row.migration_name).sort();
      assert.deepEqual(recorded, [...FIXTURE_MIGRATIONS].sort(),
        'the ledger holds this fixture\'s migrations and none of the repository\'s');

      await writer.query(oldInsert(id, A, S[0]));
      await writer.query(`UPDATE "project" SET "coordinator_workspace_id" = '${B}' WHERE "id" = '${id}'`);
      const after = await state(writer, id);
      assert.deepEqual(
        { landing: after.landing, agent: after.agent, source: after.source,
          identity_baseline: after.identity_baseline },
        { landing: B, agent: B, source: 'DERIVED', identity_baseline: B },
        'the same old writer succeeds and converges after the guarded deploy commits',
      );
    } finally {
      if (deploy) {
        if (!deploy.finished()) deploy.stop();
        await deploy.done.catch(() => undefined);
      }
      await writer?.end();
      await admin.query(`DROP SCHEMA IF EXISTS ${executorSchema} CASCADE`);
      await admin.end();
      if (fixture) await rm(fixture.root, { recursive: true, force: true });
    }
  });

test('Prisma applies the compatibility migrations after recorded 0114 without changing its checksum',
  { skip, timeout: 30_000 }, async () => {
    const executorSchema = 'pcc03d_applied_0114';
    const admin = await open('public');
    let writer: Client | undefined;
    let fixture: Awaited<ReturnType<typeof makeExecutorFixture>> | undefined;
    try {
      await admin.query(`DROP SCHEMA IF EXISTS ${executorSchema} CASCADE`);
      await admin.query(`CREATE SCHEMA ${executorSchema}`);
      fixture = await makeExecutorFixture(executorSchema);
      await writeMigration(
        fixture.root,
        '0114_project_coordinator_identity_source',
        IDENTITY_SOURCE,
      );
      await prismaDeploy(fixture);

      writer = await open(executorSchema);
      await seedExecutor(writer);
      const id = P(0x53);
      await writer.query(oldInsert(id, A, S[0]));
      await writer.query(`UPDATE "project_runtime"
        SET "coordinator_identity_source" = 'DERIVED',
            "coordinator_identity_landing_id" = NULL
        WHERE "project_id" = '${id}'`);
      const checksumBefore = (
        await writer.query(`SELECT checksum FROM "_prisma_migrations"
          WHERE migration_name = '0114_project_coordinator_identity_source'`)
      ).rows[0].checksum;
      assert.equal(
        checksumBefore,
        createHash('sha256').update(IDENTITY_SOURCE).digest('hex'),
        'the applied checksum is the unchanged 0114 file',
      );

      // Prisma sees both additions as pending even though the guard sorts before an already
      // recorded 0114. This is the deployed-database compatibility path, not a checksum rewrite.
      await writeMigration(
        fixture.root,
        '0113_project_coordinator_identity_source_guard',
        IDENTITY_SOURCE_GUARD,
      );
      await writeMigration(
        fixture.root,
        '0115_project_coordinator_identity_window_repair',
        IDENTITY_WINDOW_REPAIR,
      );
      const output = await prismaDeploy(fixture);
      assert.match(output, /Applying migration `0113_project_coordinator_identity_source_guard`/);
      assert.match(output, /Applying migration `0115_project_coordinator_identity_window_repair`/);
      const checksumAfter = (
        await writer.query(`SELECT checksum FROM "_prisma_migrations"
          WHERE migration_name = '0114_project_coordinator_identity_source'`)
      ).rows[0].checksum;
      assert.equal(checksumAfter, checksumBefore, '0114 history remains byte-for-byte compatible');

      const repaired = await state(writer, id);
      assert.equal(repaired.identity_baseline, A);
      await writer.query(`UPDATE "project" SET "coordinator_workspace_id" = '${B}' WHERE "id" = '${id}'`);
      const after = await state(writer, id);
      assert.deepEqual(
        { landing: after.landing, agent: after.agent, source: after.source,
          identity_baseline: after.identity_baseline },
        { landing: B, agent: B, source: 'DERIVED', identity_baseline: B },
      );
    } finally {
      await writer?.end();
      await admin.query(`DROP SCHEMA IF EXISTS ${executorSchema} CASCADE`);
      await admin.end();
      if (fixture) await rm(fixture.root, { recursive: true, force: true });
    }
  });

test('source has a closed enum, a safe old-writer default, and a deliberately non-FK baseline', { skip }, async () => {
  const client = await open();
  try {
    await setup(client);
    const { rows: labels } = await client.query(`
      SELECT e.enumlabel FROM pg_enum e
      JOIN pg_type t ON t.oid = e.enumtypid
      JOIN pg_namespace n ON n.oid = t.typnamespace
       WHERE n.nspname = '${SCHEMA}' AND t.typname = 'project_identity_source'
       ORDER BY e.enumsortorder`);
    assert.deepEqual(labels.map((row: any) => row.enumlabel), ['DERIVED', 'EXPLICIT']);

    const { rows: columns } = await client.query(`
      SELECT a.attname, a.attnotnull, pg_get_expr(d.adbin, d.adrelid) AS default_expr
        FROM pg_attribute a
        LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
       WHERE a.attrelid = '${SCHEMA}.project_runtime'::regclass
         AND a.attname IN ('coordinator_identity_source', 'coordinator_identity_landing_id')
       ORDER BY a.attname`);
    assert.deepEqual(columns, [
      { attname: 'coordinator_identity_landing_id', attnotnull: false, default_expr: null },
      { attname: 'coordinator_identity_source', attnotnull: true,
        default_expr: `'DERIVED'::project_identity_source` },
    ]);

    const id = P(0x50);
    await client.query(oldInsert(id, A, S[0]));
    await assert.rejects(
      () => client.query(`UPDATE "project_runtime" SET "coordinator_identity_source" = NULL
                           WHERE "project_id" = '${id}'`),
      (error: any) => error.code === '23502',
    );
    await assert.rejects(
      () => client.query(`UPDATE "project_runtime" SET "coordinator_identity_source" = 'UNKNOWN'
                           WHERE "project_id" = '${id}'`),
      (error: any) => error.code === '22P02',
    );

    const { rows: foreignKeys } = await client.query(`
      SELECT conname FROM pg_constraint
       WHERE conrelid = '${SCHEMA}.project_runtime'::regclass AND contype = 'f'
         AND pg_get_constraintdef(oid) LIKE '%coordinator_identity_landing_id%'`);
    assert.equal(foreignKeys.length, 0, 'the baseline is a historical marker, not a live relation');

    const { rows: triggers } = await client.query(`
      SELECT tgname FROM pg_trigger
       WHERE tgrelid = '${SCHEMA}.project'::regclass AND NOT tgisinternal
         AND tgname LIKE 'project_coordinator_identity%'
       ORDER BY tgname`);
    assert.deepEqual(
      triggers.map((row: any) => row.tgname),
      ['project_coordinator_identity_window_repair'],
      '0115 removes both temporary guards only after the permanent recovery predicate exists',
    );
  } finally {
    await client.end();
  }
});
