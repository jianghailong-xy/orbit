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
const IDENTITY_SOURCE = migration('0114_project_coordinator_identity_source');

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

async function open(): Promise<Client> {
  assertCoordinatorPgUrlIsIsolated(URL);
  const { Client: Ctor } = (await import('pg')) as unknown as { Client: ClientCtor };
  const client = new Ctor({ connectionString: URL });
  await client.connect();
  await verifyCoordinatorPgIdentity(client);
  await client.query(`SET search_path TO ${SCHEMA}`);
  return client;
}

async function setup(client: Client): Promise<void> {
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
  await client.query(IDENTITY_SOURCE);
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
  } finally {
    await client.end();
  }
});
