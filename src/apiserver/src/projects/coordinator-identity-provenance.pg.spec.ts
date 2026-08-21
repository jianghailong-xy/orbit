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
 * Migration 0114: where a coordinator identity CAME FROM, and what that entitles a writer to do.
 *
 * 0113 made every `landing` event re-derive the identity from the committed row, which closed
 * validation 04R's stale identity. Independent validation 04R2 showed what that costs when the
 * identity was not derived at all: an owner's explicit `coordinatorAgentId` was deleted and
 * replaced by a 0110 binary that only moved `coordinator_workspace_id`, with no error and no
 * audit (P1-04R2-01). The two states are indistinguishable in `project` and `project_member`
 * alone — "identity A, landing B" is a stale derivation when the database derived it and an
 * owner's decision when a person wrote it — so 0114 writes the difference down.
 *
 * Every case here is written the way the writer it models actually writes:
 *
 *   * a 0110 binary — raw INSERT/UPDATE of the `project` columns it knows, and no companion rows;
 *   * a 0113-era binary rolled back onto this schema — raw writes of `project_member`, which it
 *     knows, and nothing of `project_runtime.coordinator_identity_source`, which it does not;
 *   * the current service — the membership and the provenance in ONE transaction.
 *
 * Skipped unless a disposable database is pointed at it:
 *
 *   COORDINATOR_PG_URL=postgres://pcc03c_admin:***@127.0.0.1:45440/pcc03c_verify \
 *   COORDINATOR_PG_EXPECTED_DATABASE=pcc03c_verify COORDINATOR_PG_EXPECTED_USER=pcc03c_admin \
 *   COORDINATOR_PG_EXPECTED_SYSTEM_IDENTIFIER=<pg_control_system()> \
 *   node --test build/projects/coordinator-identity-provenance.pg.spec.js
 */
const URL = process.env.COORDINATOR_PG_URL;

/** Its own schema, so nothing here can touch a table anybody else's spec created. */
const SCHEMA = 'pcc03c_provenance';

const migration = (name: string) =>
  readFileSync(path.resolve(__dirname, `../../prisma/migrations/${name}/migration.sql`), 'utf8');

const IDENTITY = migration('0111_project_coordinator_identity');
const COMPANIONS = migration('0112_project_coordinator_companions');
const FINAL_ROW = migration('0113_project_coordinator_final_row');
const IDENTITY_SOURCE = migration('0114_project_coordinator_identity_source');

const OWNER = '00000000-0000-7000-8000-0000000007a1';
const OWNER_OTHER = '00000000-0000-7000-8000-0000000007a2';
/** The project's own live agents: the legal landings, and the A → B of every relocation. */
const AGENT_A = '00000000-0000-7000-8000-0000000007b1';
const AGENT_B = '00000000-0000-7000-8000-0000000007b2';
/** Live, this owner's, and never a landing: the agent an owner CHOOSES. */
const AGENT_C = '00000000-0000-7000-8000-0000000007b3';
/** Soft-deleted: a deleted agent must not reappear on a team (PAC M2). */
const AGENT_DELETED = '00000000-0000-7000-8000-0000000007b4';
/** Somebody else's: `coordinator_workspace_id` carries no tenant check of its own. */
const AGENT_THEIRS = '00000000-0000-7000-8000-0000000007b5';
const S = Array.from(
  { length: 9 },
  (_, i) => `00000000-0000-7000-8000-0000000007c${i + 1}`,
);

type ClientCtor = new (config: { connectionString?: string }) => Client;

async function open(): Promise<Client> {
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

/** The database as it stood at 0110 — the shape every writer below was written against. */
async function at0110(client: Client): Promise<void> {
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
      ('${AGENT_A}',       '${OWNER}',       'agent A', NULL),
      ('${AGENT_B}',       '${OWNER}',       'agent B', NULL),
      ('${AGENT_C}',       '${OWNER}',       'agent C', NULL),
      ('${AGENT_DELETED}', '${OWNER}',       'gone',    CURRENT_TIMESTAMP),
      ('${AGENT_THEIRS}',  '${OWNER_OTHER}', 'theirs',  NULL);
    INSERT INTO "session" ("id", "owner_id")
    SELECT s, '${OWNER}' FROM unnest(ARRAY[${S.map((s) => `'${s}'::uuid`).join(',')}]) AS s;
  `);
}

/**
 * Apply the coordinator migrations, stopping wherever a mixed-version deployment stopped.
 *
 * `upTo` is what a database that was left behind has: the 0114 cases below then roll it forward
 * from exactly that point, which is the property "safely applicable from 0110, 0111, 0112 and
 * 0113" asks for and the only way to check it that does not assume the answer.
 */
async function migrated(client: Client, upTo: 110 | 111 | 112 | 113 | 114 = 114): Promise<void> {
  await at0110(client);
  if (upTo >= 111) await client.query(IDENTITY);
  if (upTo >= 112) await client.query(COMPANIONS);
  if (upTo >= 113) await client.query(FINAL_ROW);
  if (upTo >= 114) await client.query(IDENTITY_SOURCE);
  // The reverse control, in one environment variable: 0113 re-applied on top replaces
  // `project_coordinator_reconcile` with the version that has no notion of provenance, while the
  // columns stay (a rollback keeps the forward schema). That is the older BINARY against the newer
  // DATABASE, and it is the state 04R2 measured — every case this file is responsible for then
  // fails, which is how the file says what it is testing.
  if (upTo >= 114 && process.env.COORDINATOR_PG_REVERSE_0114 === '1') await client.query(FINAL_ROW);
}

/** The 0110 INSERT: the columns that binary knows, and none of the rows it does not. */
const oldWriterInsert = (id: string, workspace: string | null, session: string | null) => `
  INSERT INTO "project" ("id", "owner_id", "title", "coordinator_session_id", "coordinator_workspace_id",
                         "created_at", "updated_at")
  VALUES ('${id}', '${OWNER}', 'old writer ${id}', ${session ? `'${session}'` : 'NULL'},
          ${workspace ? `'${workspace}'` : 'NULL'}, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`;

/**
 * What a 0113-era binary rolled back onto this schema does when its owner sets `coordinatorAgentId`:
 * it writes the membership it knows about and cannot write the provenance column it has never
 * heard of. Recognising THIS is what the derivation baseline is for.
 */
const rolledBackBinaryChooses = (id: string, agent: string) => `
  UPDATE "project_member" SET "agent_id" = '${agent}'
   WHERE "project_id" = '${id}' AND "role" = 'COORDINATOR'`;

/** What the current service writes for the same request: the membership and the source, together. */
async function serviceChooses(client: Client, id: string, agent: string | null): Promise<void> {
  await client.query('BEGIN');
  await client.query(`
    INSERT INTO "project_runtime" ("project_id", "coordinator_identity_source",
                                   "coordinator_identity_landing_id", "created_at", "updated_at")
    VALUES ('${id}', 'EXPLICIT', NULL, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    ON CONFLICT ("project_id") DO UPDATE
       SET "coordinator_identity_source" = 'EXPLICIT',
           "coordinator_identity_landing_id" = NULL,
           "updated_at" = CURRENT_TIMESTAMP`);
  if (agent === null) {
    await client.query(
      `DELETE FROM "project_member" WHERE "project_id" = '${id}' AND "role" = 'COORDINATOR'`,
    );
  } else {
    await client.query(`
      INSERT INTO "project_member" ("id", "project_id", "agent_id", "role", "added_at")
      VALUES (gen_random_uuid(), '${id}', '${agent}', 'COORDINATOR', CURRENT_TIMESTAMP)
      ON CONFLICT ("project_id", "agent_id") DO UPDATE SET "role" = 'COORDINATOR'`);
    await client.query(`
      DELETE FROM "project_member"
       WHERE "project_id" = '${id}' AND "role" = 'COORDINATOR' AND "agent_id" <> '${agent}'`);
  }
  await client.query('COMMIT');
}

/** What committed: the final row, its identity, its count, and where that identity came from. */
async function committed(client: Client, id: string) {
  const { rows } = await client.query(
    `SELECT p."coordinator_workspace_id" AS landing,
            p."coordinator_session_id"   AS session,
            m."agent_id"                 AS agent,
            (SELECT count(*)::int FROM "project_member" WHERE "project_id" = p."id") AS memberships,
            r."coordinator_generation"::int      AS generation,
            r."coordinator_session_id"           AS baseline,
            r."coordinator_identity_source"      AS source,
            r."coordinator_identity_landing_id"  AS derived_from
       FROM "project" p
       LEFT JOIN "project_runtime" r ON r."project_id" = p."id"
       LEFT JOIN "project_member" m ON m."project_id" = p."id" AND m."role" = 'COORDINATOR'
      WHERE p."id" = '${id}'`,
  );
  return rows[0] as {
    landing: string | null;
    session: string | null;
    agent: string | null;
    memberships: number;
    generation: number | null;
    baseline: string | null;
    source: 'DERIVED' | 'EXPLICIT' | null;
    derived_from: string | null;
  };
}

const skip = URL ? false : 'set COORDINATOR_PG_URL to run';

const P = (n: number) => `00000000-0000-7000-8000-000000007d${n.toString(16).padStart(2, '0')}`;

// ── What the database derived, it may still correct (04R stays closed) ─────────────────────────

test('a derived identity is recorded as derived, and still follows its landing', { skip }, async () => {
  const client = await open();
  try {
    await migrated(client);
    const id = P(1);
    await client.query(oldWriterInsert(id, AGENT_A, S[0]));

    const seeded = await committed(client, id);
    assert.equal(seeded.agent, AGENT_A);
    assert.equal(seeded.source, 'DERIVED', 'nobody chose this — the database worked it out');
    assert.equal(seeded.derived_from, AGENT_A, 'and it wrote down what it worked it out from');

    // 04R, unchanged: a 0110 binary relocating the landing takes the identity with it, because
    // this identity is the database's own and is still exactly what it derived.
    await client.query(
      `UPDATE "project" SET "coordinator_workspace_id" = '${AGENT_B}',
                            "coordinator_session_id" = '${S[1]}' WHERE "id" = '${id}'`,
    );
    const moved = await committed(client, id);
    assert.equal(moved.agent, AGENT_B, 'no reader may observe a stale coordinator identity');
    assert.equal(moved.source, 'DERIVED');
    assert.equal(moved.derived_from, AGENT_B, 'the baseline moves with the derivation');
    assert.equal(moved.generation, 1, 'the rotation is still counted mechanically');
    assert.equal(moved.memberships, 1);
  } finally {
    await client.end();
  }
});

// ── P1-04R2-01: what somebody chose, no mechanical path may replace ────────────────────────────

test('an explicit choice survives every shape of old-writer relocation', { skip }, async () => {
  const client = await open();
  try {
    await migrated(client);
    // Four projects, four ways a 0110 binary can move WHERE, one explicit WHO each. The choice is
    // made the way a ROLLED-BACK binary makes it — membership only, no provenance column — so
    // every case here is also the forward-schema rollback case.
    const shapes: Array<[string, (id: string) => Promise<void>]> = [
      [
        'the landing alone',
        async (id) =>
          void (await client.query(
            `UPDATE "project" SET "coordinator_workspace_id" = '${AGENT_B}' WHERE "id" = '${id}'`,
          )),
      ],
      [
        'the landing and the session in one statement',
        async (id) =>
          void (await client.query(
            `UPDATE "project" SET "coordinator_workspace_id" = '${AGENT_B}',
                                  "coordinator_session_id" = '${S[5]}' WHERE "id" = '${id}'`,
          )),
      ],
      [
        'two statements in one transaction, session first',
        async (id) => {
          await client.query('BEGIN');
          await client.query(
            `UPDATE "project" SET "coordinator_session_id" = '${S[6]}' WHERE "id" = '${id}'`,
          );
          await client.query(
            `UPDATE "project" SET "coordinator_workspace_id" = '${AGENT_B}' WHERE "id" = '${id}'`,
          );
          await client.query('COMMIT');
        },
      ],
      [
        'A → B → C, all in one transaction',
        async (id) => {
          await client.query('BEGIN');
          for (const w of [AGENT_B, AGENT_A, AGENT_B]) {
            await client.query(
              `UPDATE "project" SET "coordinator_workspace_id" = '${w}' WHERE "id" = '${id}'`,
            );
          }
          await client.query('COMMIT');
        },
      ],
    ];

    for (const [n, [what, relocate]] of shapes.entries()) {
      const id = P(0x10 + n);
      await client.query(oldWriterInsert(id, AGENT_A, S[n]));
      await client.query(rolledBackBinaryChooses(id, AGENT_C));

      await relocate(id);

      const state = await committed(client, id);
      assert.equal(state.landing, AGENT_B, `${what}: WHERE moved`);
      assert.equal(state.agent, AGENT_C, `${what}: WHERE must not rewrite an explicit WHO`);
      assert.equal(state.memberships, 1, `${what}: and must not add a second identity`);
      // Recognised structurally and then WRITTEN DOWN, so the next writer that cannot make this
      // judgement inherits it rather than having to repeat it.
      assert.equal(state.source, 'EXPLICIT', `${what}: the choice is on record`);
      assert.equal(state.derived_from, null, `${what}: and no derivation is claimed alongside it`);
    }
  } finally {
    await client.end();
  }
});

test('duplicate and out-of-order deferred events leave an explicit choice untouched', { skip }, async () => {
  const client = await open();
  try {
    await migrated(client);
    const id = P(0x20);
    await client.query(oldWriterInsert(id, AGENT_A, S[0]));
    await client.query(rolledBackBinaryChooses(id, AGENT_C));

    // One transaction that fires both deferred events several times each, interleaved, and ends
    // where a single statement would have ended. A deferred constraint trigger fires once per
    // event, so this is the duplicate-and-out-of-order delivery the contract asks about.
    await client.query('BEGIN');
    await client.query(`UPDATE "project" SET "coordinator_session_id" = '${S[1]}' WHERE "id" = '${id}'`);
    await client.query(`UPDATE "project" SET "coordinator_workspace_id" = '${AGENT_B}' WHERE "id" = '${id}'`);
    await client.query(`UPDATE "project" SET "coordinator_session_id" = '${S[2]}' WHERE "id" = '${id}'`);
    await client.query(`UPDATE "project" SET "coordinator_workspace_id" = '${AGENT_A}' WHERE "id" = '${id}'`);
    await client.query(`UPDATE "project" SET "coordinator_workspace_id" = '${AGENT_B}' WHERE "id" = '${id}'`);
    await client.query(`UPDATE "project" SET "coordinator_session_id" = '${S[1]}' WHERE "id" = '${id}'`);
    await client.query('COMMIT');

    const once = await committed(client, id);
    assert.equal(once.agent, AGENT_C);
    assert.equal(once.landing, AGENT_B);
    assert.equal(once.source, 'EXPLICIT');
    // The count is a function of the committed row and the recorded baseline, so five moves that
    // end one session away from where they started are one replacement (0113, unchanged).
    assert.equal(once.generation, 1);
    assert.equal(once.baseline, S[1]);

    // And a replay of the whole thing writes nothing: same identity, same count, same row.
    const seatedFirst = (
      await client.query(
        `SELECT "id" FROM "project_member" WHERE "project_id" = '${id}' AND "role" = 'COORDINATOR'`,
      )
    ).rows[0].id;
    await client.query(
      `UPDATE "project" SET "coordinator_workspace_id" = '${AGENT_B}',
                            "coordinator_session_id" = '${S[1]}' WHERE "id" = '${id}'`,
    );
    assert.deepEqual(await committed(client, id), once, 'a replay is a no-op');
    const seatedAgain = (
      await client.query(
        `SELECT "id" FROM "project_member" WHERE "project_id" = '${id}' AND "role" = 'COORDINATOR'`,
      )
    ).rows[0].id;
    assert.equal(seatedAgain, seatedFirst, 'and never re-seats the same identity');
  } finally {
    await client.end();
  }
});

// ── The choice that looks exactly like a derivation ────────────────────────────────────────────

test('choosing the agent the project already lands on is a choice when it is recorded as one', { skip }, async () => {
  const client = await open();
  try {
    await migrated(client);

    // The current service: the membership and the source in one transaction. The seat is the
    // landing, so nothing about the ROWS says a person chose it — the source column does, and it
    // is the only thing that can.
    const chosen = P(0x30);
    await client.query(oldWriterInsert(chosen, AGENT_A, S[0]));
    await serviceChooses(client, chosen, AGENT_A);
    assert.equal((await committed(client, chosen)).source, 'EXPLICIT');

    await client.query(
      `UPDATE "project" SET "coordinator_workspace_id" = '${AGENT_B}' WHERE "id" = '${chosen}'`,
    );
    const kept = await committed(client, chosen);
    assert.equal(kept.landing, AGENT_B);
    assert.equal(kept.agent, AGENT_A, 'an explicit choice is not undone by moving the landing');

    // The contrast, stated so the rule is not mistaken for a guess: a writer that CANNOT record
    // the source and picks the agent the project already lands on leaves nothing to tell its
    // choice apart from the derivation it is identical to. That project is treated as derived —
    // the same answer the 0114 backfill gives, and the safe one, because reading it the other way
    // would freeze every stale identity 04R closed.
    const indistinguishable = P(0x31);
    await client.query(oldWriterInsert(indistinguishable, AGENT_A, S[1]));
    await client.query(rolledBackBinaryChooses(indistinguishable, AGENT_A));
    await client.query(
      `UPDATE "project" SET "coordinator_workspace_id" = '${AGENT_B}' WHERE "id" = '${indistinguishable}'`,
    );
    const rederived = await committed(client, indistinguishable);
    assert.equal(rederived.agent, AGENT_B);
    assert.equal(rederived.source, 'DERIVED');
  } finally {
    await client.end();
  }
});

// ── Clearing is a choice too ───────────────────────────────────────────────────────────────────

test('a coordinator somebody removed is not seated again by a landing event', { skip }, async () => {
  const client = await open();
  try {
    await migrated(client);

    // The current service clearing `coordinatorAgentId`: the membership goes and the source says
    // why. A landing event may not answer "this project has no coordinator" by inventing one.
    const cleared = P(0x40);
    await client.query(oldWriterInsert(cleared, AGENT_A, S[0]));
    await serviceChooses(client, cleared, null);
    assert.equal((await committed(client, cleared)).agent, null);

    await client.query(
      `UPDATE "project" SET "coordinator_workspace_id" = '${AGENT_B}' WHERE "id" = '${cleared}'`,
    );
    const still = await committed(client, cleared);
    assert.equal(still.agent, null, 'a landing may not undo a clear');
    assert.equal(still.memberships, 0);
    assert.equal(still.source, 'EXPLICIT');

    // And the same request from a binary that cannot write the source: the seat it deleted was one
    // the database had derived and recorded, so its absence is evidence of a removal rather than
    // of a project that never had one.
    const mechanical = P(0x41);
    await client.query(oldWriterInsert(mechanical, AGENT_A, S[1]));
    assert.equal((await committed(client, mechanical)).derived_from, AGENT_A);
    await client.query(
      `DELETE FROM "project_member" WHERE "project_id" = '${mechanical}' AND "role" = 'COORDINATOR'`,
    );
    await client.query(
      `UPDATE "project" SET "coordinator_workspace_id" = '${AGENT_B}' WHERE "id" = '${mechanical}'`,
    );
    const mechanicalAfter = await committed(client, mechanical);
    assert.equal(mechanicalAfter.agent, null, 'a removal is recognised without being announced');
    assert.equal(mechanicalAfter.source, 'EXPLICIT');

    // Re-selecting after a clear is an ordinary explicit write, and it sticks.
    await serviceChooses(client, cleared, AGENT_C);
    await client.query(
      `UPDATE "project" SET "coordinator_workspace_id" = '${AGENT_A}' WHERE "id" = '${cleared}'`,
    );
    const reselected = await committed(client, cleared);
    assert.equal(reselected.agent, AGENT_C);
    assert.equal(reselected.source, 'EXPLICIT');
  } finally {
    await client.end();
  }
});

// ── When keeping it cannot be proved safe ──────────────────────────────────────────────────────

test('an explicit identity that is no longer a live agent fails the transaction closed', { skip }, async () => {
  const client = await open();
  try {
    await migrated(client);
    for (const [n, illegal] of [AGENT_DELETED, AGENT_THEIRS].entries()) {
      const id = P(0x50 + n);
      await client.query(oldWriterInsert(id, AGENT_A, S[n]));
      // Neither of these is reachable through the product: the service checks the agent under a
      // lock (`lockLiveAgent`) and `WorkspacesService.remove` refuses to delete an agent that
      // coordinates a project. If it is reached anyway, the two things this trigger must never do
      // are seat an agent PAC M2 excludes and silently replace a choice — so it does neither and
      // the transaction fails with a code a caller can match on.
      await client.query(rolledBackBinaryChooses(id, illegal));
      await client.query(`
        UPDATE "project_runtime" SET "coordinator_identity_source" = 'EXPLICIT',
                                     "coordinator_identity_landing_id" = NULL
         WHERE "project_id" = '${id}'`);

      await assert.rejects(
        () =>
          client.query(
            `UPDATE "project" SET "coordinator_workspace_id" = '${AGENT_B}' WHERE "id" = '${id}'`,
          ),
        (e: any) => {
          assert.equal(e.code, 'ORB01', `${illegal}: a typed failure, not a generic one`);
          assert.match(String(e.message), /explicitly chosen coordinator agent/);
          return true;
        },
      );
      await client.query('ROLLBACK');

      // Nothing was rewritten and nothing was half-written: the transaction that could not be
      // proved safe did not happen.
      const state = await committed(client, id);
      assert.equal(state.landing, AGENT_A, `${illegal}: the relocation did not commit`);
      assert.equal(state.agent, illegal, `${illegal}: and the choice was not replaced`);
    }
  } finally {
    await client.end();
  }
});

// ── The rows that already exist ────────────────────────────────────────────────────────────────

test('the backfill classifies existing rows by what only a chooser could have written', { skip }, async () => {
  const client = await open();
  try {
    // The world as it was before 0114: 0111, 0112 and 0113, and four projects an old writer left.
    await migrated(client, 113);
    const derived = P(0x60);
    const chosen = P(0x61);
    const undervivable = P(0x62);
    const unlanded = P(0x63);
    await client.query(oldWriterInsert(derived, AGENT_A, S[0]));
    await client.query(oldWriterInsert(chosen, AGENT_A, S[1]));
    await client.query(rolledBackBinaryChooses(chosen, AGENT_C));
    await client.query(oldWriterInsert(undervivable, AGENT_DELETED, S[2]));
    await client.query(oldWriterInsert(unlanded, null, S[3]));

    await client.query(IDENTITY_SOURCE);

    const seen = async (id: string) => {
      const s = await committed(client, id);
      return { agent: s.agent, source: s.source, derived_from: s.derived_from };
    };
    assert.deepEqual(await seen(derived), {
      agent: AGENT_A,
      source: 'DERIVED',
      derived_from: AGENT_A,
    }, 'an identity equal to the landing is a derivation as far as anything can tell');
    assert.deepEqual(await seen(chosen), {
      agent: AGENT_C,
      source: 'EXPLICIT',
      derived_from: null,
    }, 'an identity the project never landed on can only have been chosen');
    assert.deepEqual(await seen(undervivable), {
      agent: null,
      source: 'DERIVED',
      derived_from: null,
    }, 'a project with no identity has nothing to have chosen');
    assert.deepEqual(await seen(unlanded), { agent: null, source: 'DERIVED', derived_from: null });

    // And the classification is load-bearing rather than decorative: the same relocation now has
    // two different right answers, and the backfill is what tells them apart.
    for (const id of [derived, chosen]) {
      await client.query(
        `UPDATE "project" SET "coordinator_workspace_id" = '${AGENT_B}' WHERE "id" = '${id}'`,
      );
    }
    assert.equal((await committed(client, derived)).agent, AGENT_B, '04R: a derivation follows');
    assert.equal((await committed(client, chosen)).agent, AGENT_C, '04R2: a choice does not');
  } finally {
    await client.end();
  }
});

test('re-applying the backfill changes nothing, and can never demote a recorded choice', { skip }, async () => {
  const client = await open();
  try {
    await migrated(client);
    const derived = P(0x70);
    const chosen = P(0x71);
    await client.query(oldWriterInsert(derived, AGENT_A, S[0]));
    await client.query(oldWriterInsert(chosen, AGENT_A, S[1]));
    await serviceChooses(client, chosen, AGENT_A);

    const before = [await committed(client, derived), await committed(client, chosen)];
    // An interrupted deploy re-runs the whole file. `chosen` is the case that matters: its seat
    // equals its landing, so a backfill that re-derived from the rows alone would call it DERIVED
    // and throw away the record of a decision.
    await client.query(IDENTITY_SOURCE);
    await client.query(IDENTITY_SOURCE);
    assert.deepEqual([await committed(client, derived), await committed(client, chosen)], before);
    assert.equal(before[1].source, 'EXPLICIT');
  } finally {
    await client.end();
  }
});

// ── Mixed-version deployments ──────────────────────────────────────────────────────────────────

test('0114 rolls forward from a database that stopped at 0110, 0111, 0112 or 0113', { skip }, async () => {
  const client = await open();
  try {
    for (const stopped of [110, 111, 112, 113] as const) {
      await migrated(client, stopped);
      const id = P(0x80);
      // A project the old writer left BEFORE the catch-up, so each run also proves the earlier
      // migrations' own backfills still reach it in this order.
      await client.query(oldWriterInsert(id, AGENT_A, S[0]));

      if (stopped < 111) await client.query(IDENTITY);
      if (stopped < 112) await client.query(COMPANIONS);
      if (stopped < 113) await client.query(FINAL_ROW);
      await client.query(IDENTITY_SOURCE);

      const state = await committed(client, id);
      assert.equal(state.agent, AGENT_A, `from ${stopped}: the identity every path derives`);
      assert.equal(state.source, 'DERIVED', `from ${stopped}`);
      assert.equal(state.derived_from, AGENT_A, `from ${stopped}: with its baseline recorded`);
      assert.equal(state.generation, 0, `from ${stopped}: nothing has rotated`);

      // And the behaviour is the same wherever the database was caught up from.
      await client.query(rolledBackBinaryChooses(id, AGENT_C));
      await client.query(
        `UPDATE "project" SET "coordinator_workspace_id" = '${AGENT_B}' WHERE "id" = '${id}'`,
      );
      assert.equal((await committed(client, id)).agent, AGENT_C, `from ${stopped}: choice kept`);
    }
  } finally {
    await client.end();
  }
});

test('an empty database gets the same objects as one that was caught up', { skip }, async () => {
  const client = await open();
  try {
    await migrated(client);
    const objects = async () =>
      (
        await client.query(`
          SELECT a."attname" AS column, format_type(a."atttypid", a."atttypmod") AS type,
                 a."attnotnull" AS not_null, pg_get_expr(d."adbin", d."adrelid") AS default_expr
            FROM pg_attribute a
            LEFT JOIN pg_attrdef d ON d."adrelid" = a."attrelid" AND d."adnum" = a."attnum"
           WHERE a."attrelid" = '${SCHEMA}."project_runtime"'::regclass
             AND a."attnum" > 0 AND NOT a."attisdropped"
             AND a."attname" LIKE 'coordinator_identity%'
           ORDER BY a."attname"`)
      ).rows;
    const fresh = await objects();
    assert.deepEqual(fresh, [
      {
        column: 'coordinator_identity_landing_id',
        type: 'uuid',
        not_null: false,
        default_expr: null,
      },
      {
        column: 'coordinator_identity_source',
        type: 'project_identity_source',
        not_null: true,
        default_expr: `'DERIVED'::project_identity_source`,
      },
    ]);

    await migrated(client, 113);
    await client.query(IDENTITY_SOURCE);
    assert.deepEqual(await objects(), fresh, 'the same columns, however the database got here');

    // One live function under one name, so nothing has to work out which of two is authoritative.
    const { rows } = await client.query(`
      SELECT p."proname" FROM pg_proc p
       JOIN pg_namespace n ON n."oid" = p."pronamespace"
      WHERE n."nspname" = '${SCHEMA}' AND p."proname" LIKE 'project_coordinator%'
      ORDER BY p."proname"`);
    assert.deepEqual(rows.map((r: any) => r.proname), ['project_coordinator_reconcile']);
  } finally {
    await client.end();
  }
});

// ── Two writers at once ────────────────────────────────────────────────────────────────────────

test('a relocation and an explicit choice are two orderings, never an interleaving', { skip }, async () => {
  const mover = await open();
  const chooser = await open();
  try {
    await migrated(mover);
    await chooser.query(`SET search_path TO ${SCHEMA}`);
    const id = P(0x90);
    await mover.query(oldWriterInsert(id, AGENT_A, S[0]));

    // The chooser goes first and does not commit: it holds the project's row lock, which is what
    // `ProjectsService.update` takes before writing the membership.
    await chooser.query('BEGIN');
    await chooser.query(`SELECT "id" FROM "project" WHERE "id" = '${id}' FOR NO KEY UPDATE`);
    await chooser.query(`
      INSERT INTO "project_runtime" ("project_id", "coordinator_identity_source", "created_at", "updated_at")
      VALUES ('${id}', 'EXPLICIT', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      ON CONFLICT ("project_id") DO UPDATE SET "coordinator_identity_source" = 'EXPLICIT',
                                               "coordinator_identity_landing_id" = NULL`);
    await chooser.query(rolledBackBinaryChooses(id, AGENT_C));

    // The 0110 relocation now has to wait for it. Its UPDATE of a non-key column takes the same
    // FOR NO KEY UPDATE the chooser is holding, so it blocks before it even reaches the deferred
    // reconciliation — the two cannot both read "no choice has been made".
    await mover.query('BEGIN');
    const moving = mover
      .query(`UPDATE "project" SET "coordinator_workspace_id" = '${AGENT_B}' WHERE "id" = '${id}'`)
      .then(() => mover.query('COMMIT'));
    let landed = false;
    moving.then(
      () => {
        landed = true;
      },
      () => {},
    );
    await new Promise((r) => setTimeout(r, 400));
    assert.equal(landed, false, 'the relocation must wait for the choice to resolve');

    await chooser.query('COMMIT');
    await moving;

    const state = await committed(mover, id);
    assert.equal(state.landing, AGENT_B, 'the relocation committed');
    assert.equal(state.agent, AGENT_C, 'and read the choice that committed before it');
    assert.equal(state.source, 'EXPLICIT');
  } finally {
    await mover.end();
    await chooser.end();
  }
});
