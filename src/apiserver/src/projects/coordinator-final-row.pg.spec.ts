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
 * Migration 0113: what 0111 and 0112 promise, asked of the row that actually commits.
 *
 * 0112 wrote the promise as three DEFERRABLE INITIALLY DEFERRED constraint triggers so that it
 * would hold whichever binary did the writing. Independent validation 04R showed that deferring
 * the trigger does not defer `NEW`: a deferred trigger still receives the row image from when its
 * event happened, so a transaction that moved the coordination workspace after inserting the
 * project committed an identity naming the workspace it no longer names.
 *
 * Every case below is written the way a writer that has never heard of any of this writes: raw
 * INSERT / UPDATE of the `project` columns 0110 knew, and no companion rows. None of it can be
 * tested anywhere but on a real server — a trigger is only there if Postgres says it is, and the
 * two orderings in the last case are locks or they are nothing.
 *
 * Skipped unless a disposable database is pointed at it:
 *
 *   docker run -d --name pcc03b-pg --tmpfs /var/lib/postgresql/data \
 *     -e POSTGRES_PASSWORD=*** -e POSTGRES_USER=pcc03b_admin -e POSTGRES_DB=pcc03b_verify \
 *     -p 127.0.0.1:45438:5432 postgres:16-alpine
 *   COORDINATOR_PG_URL=postgres://pcc03b_admin:***@127.0.0.1:45438/pcc03b_verify \
 *   COORDINATOR_PG_EXPECTED_DATABASE=pcc03b_verify COORDINATOR_PG_EXPECTED_USER=pcc03b_admin \
 *   COORDINATOR_PG_EXPECTED_SYSTEM_IDENTIFIER=<pg_control_system()> \
 *   node --test build/projects/coordinator-final-row.pg.spec.js
 */
const URL = process.env.COORDINATOR_PG_URL;

/** Its own schema, so nothing here can touch a table anybody else's spec created. */
const SCHEMA = 'pcc03b_final_row';

const migration = (name: string) =>
  readFileSync(path.resolve(__dirname, `../../prisma/migrations/${name}/migration.sql`), 'utf8');

const IDENTITY = migration('0111_project_coordinator_identity');
const COMPANIONS = migration('0112_project_coordinator_companions');
const FINAL_ROW = migration('0113_project_coordinator_final_row');

const OWNER = '00000000-0000-7000-8000-0000000006a1';
const OWNER_OTHER = '00000000-0000-7000-8000-0000000006a2';
/** Two live agents of the project's own owner: the legal landings, and the A → B of every case. */
const AGENT_A = '00000000-0000-7000-8000-0000000006b1';
const AGENT_B = '00000000-0000-7000-8000-0000000006b2';
/** Soft-deleted: a deleted agent must not reappear on a team (PAC M2). */
const AGENT_DELETED = '00000000-0000-7000-8000-0000000006b3';
/** Somebody else's: `coordinator_workspace_id` carries no tenant check of its own. */
const AGENT_THEIRS = '00000000-0000-7000-8000-0000000006b4';
/** Live, this owner's, and switched off — a landing that cannot RUN, which is a different thing. */
const AGENT_DISABLED = '00000000-0000-7000-8000-0000000006b5';
const S1 = '00000000-0000-7000-8000-0000000006c1';
const S2 = '00000000-0000-7000-8000-0000000006c2';
const S3 = '00000000-0000-7000-8000-0000000006c3';

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

/** The database as it stood at 0110, then all three migrations, in the order a deploy applies them. */
async function migrated(client: Client): Promise<void> {
  await client.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
  await client.query(`CREATE SCHEMA ${SCHEMA}`);
  await client.query(`SET search_path TO ${SCHEMA}`);
  await client.query(`
    CREATE TABLE "workspace" (
      "id"         UUID PRIMARY KEY,
      "owner_id"   UUID NOT NULL,
      "name"       TEXT NOT NULL,
      -- Present so that "0113 does not read it" is a statement this file can make. Whether a
      -- landing may RUN a coordinator is the service's question (lastCoordinatorWorkspace, and a
      -- structured COORDINATOR_UNAVAILABLE, §7.5); whether it may BE one is this migration's.
      "enabled"    BOOLEAN NOT NULL DEFAULT true,
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
    INSERT INTO "workspace" ("id", "owner_id", "name", "enabled", "deleted_at") VALUES
      ('${AGENT_A}',        '${OWNER}',       'agent A',  true,  NULL),
      ('${AGENT_B}',        '${OWNER}',       'agent B',  true,  NULL),
      ('${AGENT_DELETED}',  '${OWNER}',       'gone',     true,  CURRENT_TIMESTAMP),
      ('${AGENT_THEIRS}',   '${OWNER_OTHER}', 'theirs',   true,  NULL),
      ('${AGENT_DISABLED}', '${OWNER}',       'disabled', false, NULL);
    INSERT INTO "session" ("id", "owner_id") VALUES
      ('${S1}', '${OWNER}'), ('${S2}', '${OWNER}'), ('${S3}', '${OWNER}');
  `);
  await client.query(IDENTITY);
  await client.query(COMPANIONS);
  await client.query(FINAL_ROW);
  // The reverse control, in one environment variable: 0112 re-applied on top puts its own two
  // functions back and re-points all three triggers at them, which is the state 04R measured. Every
  // case below that 0113 is responsible for then fails, and the ones it inherited unchanged pass —
  // which is how this file says which half of it is new.
  if (process.env.COORDINATOR_PG_REVERSE_0113 === '1') await client.query(COMPANIONS);
}

/** The 0110 INSERT: the columns that binary knows, and none of the rows it does not. */
const oldWriterInsert = (id: string, workspace: string | null, session: string | null) => `
  INSERT INTO "project" ("id", "owner_id", "title", "coordinator_session_id", "coordinator_workspace_id",
                         "created_at", "updated_at")
  VALUES ('${id}', '${OWNER}', 'old writer ${id}', ${session ? `'${session}'` : 'NULL'},
          ${workspace ? `'${workspace}'` : 'NULL'}, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`;

/** What committed: the final row, its identity, its count and the baseline that count is measured from. */
async function committed(client: Client, id: string) {
  const { rows } = await client.query(
    `SELECT p."coordinator_workspace_id" AS landing,
            p."coordinator_session_id"   AS session,
            m."agent_id"                 AS agent,
            (SELECT count(*)::int FROM "project_member" WHERE "project_id" = p."id") AS memberships,
            r."coordinator_generation"::int AS generation,
            r."coordinator_session_id"   AS baseline
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
  };
}

const skip = URL ? false : 'set COORDINATOR_PG_URL to run';

// ── The two states validation 04R committed ────────────────────────────────────────────────────

test('one transaction that inserts at A and lands at B commits the identity B names', { skip }, async () => {
  const client = await open();
  try {
    await migrated(client);
    const id = '00000000-0000-7000-8000-0000000006d1';

    await client.query('BEGIN');
    await client.query(oldWriterInsert(id, AGENT_A, S1));
    await client.query(
      `UPDATE "project" SET "coordinator_workspace_id" = '${AGENT_B}', "coordinator_session_id" = '${S2}'
        WHERE "id" = '${id}'`,
    );
    await client.query('COMMIT');

    const state = await committed(client, id);
    // 0112 answered AGENT_A here: the INSERT event's own image, which stopped being true one
    // statement later and was never revisited.
    assert.equal(state.landing, AGENT_B);
    assert.equal(state.agent, AGENT_B, 'the identity must be the one the committed row names');
    assert.equal(state.memberships, 1);
    // One replacement, measured from the session the project was born naming.
    assert.equal(state.generation, 1);
    assert.equal(state.baseline, S2);
  } finally {
    await client.end();
  }
});

test('a 0110 relocation moves the identity with the landing, not just the count', { skip }, async () => {
  const client = await open();
  try {
    await migrated(client);
    const id = '00000000-0000-7000-8000-0000000006d2';
    await client.query(oldWriterInsert(id, AGENT_A, S1));

    const before = await committed(client, id);
    assert.equal(before.agent, AGENT_A);
    assert.equal(before.generation, 0);
    assert.equal(before.baseline, S1);

    // The 0110 binary's own coordinator path, which still relocates a landing (repair-03a §6.3).
    await client.query(
      `UPDATE "project" SET "coordinator_workspace_id" = '${AGENT_B}', "coordinator_session_id" = '${S2}'
        WHERE "id" = '${id}'`,
    );

    const after = await committed(client, id);
    assert.equal(after.landing, AGENT_B);
    // 0112 left AGENT_A standing: a non-null identity contradicting a non-null landing, which a
    // new reader believes instead of failing closed.
    assert.equal(after.agent, AGENT_B, 'no reader may observe a stale coordinator identity');
    assert.equal(after.memberships, 1);
    assert.equal(after.generation, 1, 'the rotation is still counted mechanically');
  } finally {
    await client.end();
  }
});

test('a project created and dropped in one transaction still commits, and leaves nothing', { skip }, async () => {
  const client = await open();
  try {
    await migrated(client);
    const id = '00000000-0000-7000-8000-0000000006d3';

    await client.query('BEGIN');
    await client.query(oldWriterInsert(id, AGENT_A, S1));
    await client.query(`DELETE FROM "project" WHERE "id" = '${id}'`);
    await client.query('COMMIT');

    const { rows } = await client.query(`
      SELECT (SELECT count(*)::int FROM "project"         WHERE "id"         = '${id}') AS projects,
             (SELECT count(*)::int FROM "project_runtime" WHERE "project_id" = '${id}') AS runtimes,
             (SELECT count(*)::int FROM "project_member"  WHERE "project_id" = '${id}') AS members`);
    assert.deepEqual(rows[0], { projects: 0, runtimes: 0, members: 0 });
  } finally {
    await client.end();
  }
});

// ── Repeated, out-of-order and net-zero events ─────────────────────────────────────────────────

test('A → B → A in one transaction lands where it started and counts nothing', { skip }, async () => {
  const client = await open();
  try {
    await migrated(client);
    const id = '00000000-0000-7000-8000-0000000006d4';
    await client.query(oldWriterInsert(id, AGENT_A, S1));

    await client.query('BEGIN');
    await client.query(
      `UPDATE "project" SET "coordinator_workspace_id" = '${AGENT_B}', "coordinator_session_id" = '${S2}'
        WHERE "id" = '${id}'`,
    );
    await client.query(
      `UPDATE "project" SET "coordinator_workspace_id" = '${AGENT_A}', "coordinator_session_id" = '${S1}'
        WHERE "id" = '${id}'`,
    );
    await client.query('COMMIT');

    const state = await committed(client, id);
    assert.equal(state.agent, AGENT_A);
    assert.equal(state.memberships, 1);
    // Four deferred events fired for a transaction that changed nothing. A count derived from the
    // events would be at 2; a count derived from the committed row against its own baseline is 0.
    assert.equal(state.generation, 0);
    assert.equal(state.baseline, S1);
  } finally {
    await client.end();
  }
});

test('A → B → C in one transaction is one replacement, not two', { skip }, async () => {
  const client = await open();
  try {
    await migrated(client);
    const id = '00000000-0000-7000-8000-0000000006d5';
    await client.query(oldWriterInsert(id, AGENT_A, S1));

    await client.query('BEGIN');
    await client.query(`UPDATE "project" SET "coordinator_session_id" = '${S2}' WHERE "id" = '${id}'`);
    await client.query(`UPDATE "project" SET "coordinator_session_id" = '${S3}' WHERE "id" = '${id}'`);
    await client.query('COMMIT');

    assert.equal((await committed(client, id)).generation, 1);
    assert.equal((await committed(client, id)).baseline, S3);

    // And the same three pointers moved one transaction at a time are two replacements, because
    // that is what they are — the count follows the committed history, not the statement count.
    await client.query(`UPDATE "project" SET "coordinator_session_id" = '${S1}' WHERE "id" = '${id}'`);
    await client.query(`UPDATE "project" SET "coordinator_session_id" = '${S2}' WHERE "id" = '${id}'`);
    assert.equal((await committed(client, id)).generation, 3);
  } finally {
    await client.end();
  }
});

test('losing a coordinator, re-binding it, and writing the same pointer again count nothing', { skip }, async () => {
  const client = await open();
  try {
    await migrated(client);
    const id = '00000000-0000-7000-8000-0000000006d6';
    await client.query(oldWriterInsert(id, AGENT_A, S1));

    // Exactly 0112's three non-rotations, which 0113 must go on answering the same way.
    await client.query(`UPDATE "project" SET "coordinator_session_id" = '${S2}' WHERE "id" = '${id}'`);
    assert.equal((await committed(client, id)).generation, 1);
    await client.query(`UPDATE "project" SET "coordinator_session_id" = NULL WHERE "id" = '${id}'`);
    assert.equal((await committed(client, id)).generation, 1);
    await client.query(`UPDATE "project" SET "coordinator_session_id" = '${S1}' WHERE "id" = '${id}'`);
    assert.equal((await committed(client, id)).generation, 1);
    await client.query(`UPDATE "project" SET "coordinator_session_id" = '${S1}' WHERE "id" = '${id}'`);
    assert.equal((await committed(client, id)).generation, 1);
    // Null in and out again inside ONE transaction is the same non-event.
    await client.query('BEGIN');
    await client.query(`UPDATE "project" SET "coordinator_session_id" = NULL WHERE "id" = '${id}'`);
    await client.query(`UPDATE "project" SET "coordinator_session_id" = '${S1}' WHERE "id" = '${id}'`);
    await client.query('COMMIT');
    assert.equal((await committed(client, id)).generation, 1);

    // None of them touched who is having the conversation (§7.5).
    assert.equal((await committed(client, id)).agent, AGENT_A);
  } finally {
    await client.end();
  }
});

test('replaying the same relocation, and re-applying 0113, write nothing the second time', { skip }, async () => {
  const client = await open();
  try {
    await migrated(client);
    const id = '00000000-0000-7000-8000-0000000006d7';
    await client.query(oldWriterInsert(id, AGENT_A, S1));
    await client.query(
      `UPDATE "project" SET "coordinator_workspace_id" = '${AGENT_B}', "coordinator_session_id" = '${S2}'
        WHERE "id" = '${id}'`,
    );
    const once = await committed(client, id);
    const membershipId = async () =>
      (
        await client.query(
          `SELECT "id" FROM "project_member" WHERE "project_id" = '${id}' AND "role" = 'COORDINATOR'`,
        )
      ).rows[0].id as string;
    const seatedFirst = await membershipId();

    // The same statement again: every value it writes is already the committed value.
    await client.query(
      `UPDATE "project" SET "coordinator_workspace_id" = '${AGENT_B}', "coordinator_session_id" = '${S2}'
        WHERE "id" = '${id}'`,
    );
    // And the migration itself again, which is what a resumed or re-applied deploy does.
    await client.query(FINAL_ROW);

    assert.deepEqual(await committed(client, id), once);
    assert.equal(await membershipId(), seatedFirst, 'a replay must not re-seat the same identity');
  } finally {
    await client.end();
  }
});

// ── Landings nothing may be derived from ───────────────────────────────────────────────────────

test('an illegal landing is never derived from, and never left contradicting an identity', { skip }, async () => {
  const client = await open();
  try {
    await migrated(client);
    for (const [n, bad] of [AGENT_THEIRS, AGENT_DELETED].entries()) {
      // Inserted straight onto the illegal landing: nobody may guess an identity for it.
      const fresh = `00000000-0000-7000-8000-0000000006e${n}`;
      await client.query(oldWriterInsert(fresh, bad, null));
      const inserted = await committed(client, fresh);
      assert.equal(inserted.agent, null, `${bad}: no identity may be invented`);
      assert.equal(inserted.generation, 0, `${bad}: the runtime row is unconditional`);

      // And relocated ONTO it from a legal one: the identity it had describes a landing this
      // project no longer names, so it goes rather than contradicting the row.
      const moved = `00000000-0000-7000-8000-0000000006f${n}`;
      // A session each: `coordinator_session_id` is unique, and both halves of this loop bind one.
      await client.query(oldWriterInsert(moved, AGENT_A, [S1, S2][n]));
      assert.equal((await committed(client, moved)).agent, AGENT_A);
      await client.query(
        `UPDATE "project" SET "coordinator_workspace_id" = '${bad}' WHERE "id" = '${moved}'`,
      );
      const after = await committed(client, moved);
      assert.equal(after.landing, bad);
      assert.equal(after.agent, null, `${bad}: no identity rather than a wrong one`);
      assert.equal(after.memberships, 0);
    }
  } finally {
    await client.end();
  }
});

test('a landing that goes soft-deleted underneath a project does not cost it its identity', { skip }, async () => {
  const client = await open();
  try {
    await migrated(client);
    const id = '00000000-0000-7000-8000-0000000006d8';
    await client.query(oldWriterInsert(id, AGENT_B, S1));
    assert.equal((await committed(client, id)).agent, AGENT_B);

    // The soft delete the service refuses (409, `WorkspacesService.remove`) and a 0110 binary does
    // not. The landing is now underivable — but the identity still NAMES it, so there is nothing
    // contradictory to resolve, and §7.5 keeps the agent across the rotation that follows.
    await client.query(`UPDATE "workspace" SET "deleted_at" = CURRENT_TIMESTAMP WHERE "id" = '${AGENT_B}'`);
    await client.query(`UPDATE "project" SET "coordinator_session_id" = '${S2}' WHERE "id" = '${id}'`);

    const state = await committed(client, id);
    assert.equal(state.agent, AGENT_B, 'rotation changes the conversation, never who is having it');
    assert.equal(state.generation, 1);
  } finally {
    await client.end();
  }
});

test('a disabled landing is still an identity — running there is the service’s question', { skip }, async () => {
  const client = await open();
  try {
    await migrated(client);
    const id = '00000000-0000-7000-8000-0000000006d9';
    await client.query(oldWriterInsert(id, AGENT_DISABLED, S1));

    // `enabled` is not a condition here, and deliberately not: the two conditions this trigger
    // applies are the two the 0111 backfill applies (same owner, not soft-deleted), because they
    // are about whether an identity is TRUE. Whether it can run is `lastCoordinatorWorkspace`'s
    // question, and its answer is a structured COORDINATOR_UNAVAILABLE rather than a silent
    // migration (§7.5) — proved in coordinator-service-linearization.pg.spec.ts.
    assert.equal((await committed(client, id)).agent, AGENT_DISABLED);
  } finally {
    await client.end();
  }
});

// ── §7.5: a rotation may fill an identity in, and may never replace one ────────────────────────

test('rotating the session leaves a coordinator somebody chose exactly where it was', { skip }, async () => {
  const client = await open();
  try {
    await migrated(client);
    const id = '00000000-0000-7000-8000-0000000006da';
    await client.query(oldWriterInsert(id, AGENT_A, S1));
    // What `PATCH /projects/:id` with `coordinatorAgentId` writes: an identity that is NOT the
    // landing, and does not touch `coordinator_workspace_id` to become one.
    await client.query(`
      UPDATE "project_member" SET "agent_id" = '${AGENT_DISABLED}'
       WHERE "project_id" = '${id}' AND "role" = 'COORDINATOR'`);

    await client.query(`UPDATE "project" SET "coordinator_session_id" = '${S2}' WHERE "id" = '${id}'`);

    const rotated = await committed(client, id);
    assert.equal(rotated.agent, AGENT_DISABLED, '§7.5: the session changes, the agent does not');
    assert.equal(rotated.generation, 1);

    // Moving the LANDING is the other event, and that one does re-derive: a chosen identity is
    // stable across rotations, not across a relocation of the workspace it is derived from.
    await client.query(
      `UPDATE "project" SET "coordinator_workspace_id" = '${AGENT_B}' WHERE "id" = '${id}'`,
    );
    assert.equal((await committed(client, id)).agent, AGENT_B);
  } finally {
    await client.end();
  }
});

test('a rotation fills in an identity a project never had', { skip }, async () => {
  const client = await open();
  try {
    await migrated(client);
    const id = '00000000-0000-7000-8000-0000000006db';
    // Bound to a landing nothing could be derived from, then that landing becomes derivable
    // — the project has a workspace and no identity, and the next event it gets is a rotation.
    await client.query(oldWriterInsert(id, AGENT_DELETED, S1));
    assert.equal((await committed(client, id)).agent, null);
    await client.query(`UPDATE "workspace" SET "deleted_at" = NULL WHERE "id" = '${AGENT_DELETED}'`);

    await client.query(`UPDATE "project" SET "coordinator_session_id" = '${S2}' WHERE "id" = '${id}'`);

    assert.equal((await committed(client, id)).agent, AGENT_DELETED);
  } finally {
    await client.end();
  }
});

test('an agent already on the team is promoted rather than refused', { skip }, async () => {
  const client = await open();
  try {
    await migrated(client);
    const id = '00000000-0000-7000-8000-0000000006dc';
    await client.query(oldWriterInsert(id, AGENT_A, S1));
    // `project_member_project_id_agent_id_key` is one membership per agent per project, whatever
    // the role. Re-seating by UPDATE of `agent_id` would violate it — at COMMIT, on a transaction
    // that did nothing wrong.
    await client.query(`
      INSERT INTO "project_member" ("id", "project_id", "agent_id", "role")
      VALUES (gen_random_uuid(), '${id}', '${AGENT_B}', 'MEMBER')`);

    await client.query(
      `UPDATE "project" SET "coordinator_workspace_id" = '${AGENT_B}' WHERE "id" = '${id}'`,
    );

    const state = await committed(client, id);
    assert.equal(state.agent, AGENT_B);
    assert.equal(state.memberships, 1, 'the one row changed role rather than becoming two');
  } finally {
    await client.end();
  }
});

// ── Commit ordering against a concurrent soft delete ───────────────────────────────────────────

test('a relocation and the deletion of its target are two orderings, never an interleaving', { skip }, async () => {
  const mover = await open();
  const deleter = await open();
  try {
    await migrated(mover);
    await deleter.query(`SET search_path TO ${SCHEMA}`);
    const id = '00000000-0000-7000-8000-0000000006dd';
    await mover.query(oldWriterInsert(id, AGENT_A, S1));

    // The delete goes first and does not commit: it holds FOR NO KEY UPDATE on AGENT_B.
    await deleter.query('BEGIN');
    await deleter.query(`UPDATE "workspace" SET "deleted_at" = CURRENT_TIMESTAMP WHERE "id" = '${AGENT_B}'`);

    await mover.query('BEGIN');
    await mover.query(`UPDATE "project" SET "coordinator_workspace_id" = '${AGENT_B}' WHERE "id" = '${id}'`);
    // COMMIT runs the deferred trigger, whose FOR SHARE on AGENT_B conflicts with the lock the
    // deleter is holding. Without that lock this is the interleaving validation 04 recorded as
    // P1-03: the check passes, the delete commits, and a membership lands on a deleted agent.
    const committing = mover.query('COMMIT');
    let landed = false;
    committing.then(() => {
      landed = true;
    }, () => {});
    await new Promise((r) => setTimeout(r, 400));
    assert.equal(landed, false, 'the reconciliation must wait for the delete to resolve');

    await deleter.query('COMMIT');
    await committing;

    // Postgres re-evaluates a locked row's qualifier against the version the deleter committed,
    // so the landing is underivable by the time the answer is given.
    const state = await committed(mover, id);
    assert.equal(state.landing, AGENT_B);
    assert.equal(state.agent, null, 'no membership may commit onto a deleted agent');
  } finally {
    await mover.end();
    await deleter.end();
  }
});
