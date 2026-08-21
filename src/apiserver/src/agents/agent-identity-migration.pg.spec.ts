import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import type { Client } from 'pg';

import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from '../projects/coordinator-pg-test-safety';

/**
 * Unit 02A, the migration half: what `0129_project_agent_identity` does to a database that already
 * has legacy agents in it — asserted on a real server, because every claim here is the DATABASE's.
 *
 * The fixture is the shape 0111 really left behind, foreign key included: `project_member.agent_id`
 * REFERENCES `workspace(id)`, non-deferrable. That detail is the whole reason the mirror set is a
 * UNION rather than "the live workspaces" (§3.2 T5): a membership may name a SOFT-DELETED
 * workspace, because a soft delete never fired RESTRICT. Mirror only the live ones and 02B's
 * re-point has nothing to map that membership onto — and it fails on the production snapshot only,
 * after the DROP CONSTRAINT has already run. A test on a bare table with no foreign key cannot see
 * that, which is why this one builds the constraint.
 *
 * Cases: 02A.6 (the union, one mirror per source, columns equal), 02A.7 (duplicate names),
 * 02A.9 (a deleted source's mirror is deleted, and in no selector).
 *
 * Skipped unless a disposable database is pointed at it:
 *
 *   docker run -d --name pac02a-pg -e POSTGRES_USER=pac02a_admin -e POSTGRES_PASSWORD=pac02a_pw \
 *     -e POSTGRES_DB=postgres -p 127.0.0.1:55491:5432 postgres:16-alpine
 *   COORDINATOR_PG_URL=postgres://pac02a_admin:pac02a_pw@127.0.0.1:55491/pac02a_mig \
 *   COORDINATOR_PG_EXPECTED_DATABASE=pac02a_mig COORDINATOR_PG_EXPECTED_USER=pac02a_admin \
 *   COORDINATOR_PG_EXPECTED_SYSTEM_IDENTIFIER=<pg_control_system().system_identifier> \
 *   node --test build/agents/agent-identity-migration.pg.spec.js
 */
const URL = process.env.COORDINATOR_PG_URL;
const skip = URL ? false : 'set COORDINATOR_PG_URL to run';

/** Its own schema, so nothing here can touch a table another spec created. */
const SCHEMA = 'pac02a_agent_identity';

const MIGRATION = readFileSync(
  path.resolve(__dirname, '../../prisma/migrations/0129_project_agent_identity/migration.sql'),
  'utf8',
);

/** The 02A slice: everything up to the first step a later unit appends. Today that is the whole
 *  file — sliced anyway, because 02B–02E land in this same migration by design (§11.2), and this
 *  spec is about 02A's claims rather than about theirs. */
const SLICE = MIGRATION;

const OWNER_A = '00000000-0000-7000-8000-00000000a001';
const OWNER_B = '00000000-0000-7000-8000-00000000b001';
const PROJECT = '00000000-0000-7000-8000-0000000000c1';

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
 * The database as it stands BEFORE this migration: `user`, `workspace`, `project` and the
 * `project_member` 0111 built, with its real foreign key. Only the columns the migration reads or
 * references are recreated — this is the shape 0129 runs against, not a copy of the whole schema.
 */
async function seedPreMigration(client: Client): Promise<void> {
  await client.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
  await client.query(`CREATE SCHEMA ${SCHEMA}`);
  await client.query(`SET search_path TO ${SCHEMA}`);
  await client.query(`
    CREATE TABLE "user" (
      "id"    UUID PRIMARY KEY,
      "email" TEXT NOT NULL
    );
    CREATE TABLE "workspace" (
      "id"                   UUID PRIMARY KEY,
      "owner_id"             UUID NOT NULL REFERENCES "user"("id"),
      "name"                 TEXT NOT NULL,
      "description"          TEXT,
      "system_prompt"        TEXT,
      "append_system_prompt" TEXT,
      "model"                TEXT,
      "effort"               TEXT,
      "disallowed_tools"     JSONB NOT NULL DEFAULT '[]',
      "provider_fallbacks"   JSONB NOT NULL DEFAULT '[]',
      "target_runner_id"     UUID,
      "target_labels"        TEXT[] DEFAULT ARRAY[]::TEXT[],
      "work_dir"             TEXT,
      "enable_worktree"      BOOLEAN NOT NULL DEFAULT false,
      "env"                  JSONB,
      "enabled"              BOOLEAN NOT NULL DEFAULT true,
      "created_at"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "deleted_at"           TIMESTAMP(3)
    );
    CREATE TABLE "project" (
      "id"    UUID PRIMARY KEY,
      "title" TEXT NOT NULL
    );
    CREATE TYPE "project_role" AS ENUM ('COORDINATOR', 'MEMBER');
    CREATE TABLE "project_member" (
      "id"         UUID NOT NULL,
      "project_id" UUID NOT NULL,
      "agent_id"   UUID NOT NULL,
      "role"       "project_role" NOT NULL,
      "added_at"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT "project_member_pkey" PRIMARY KEY ("id")
    );
    CREATE UNIQUE INDEX "project_member_project_id_agent_id_key"
      ON "project_member"("project_id", "agent_id");
    CREATE INDEX "project_member_agent_id_idx" ON "project_member"("agent_id");
    CREATE UNIQUE INDEX "project_member_coordinator_idx"
      ON "project_member"("project_id") WHERE "role" = 'COORDINATOR';
    ALTER TABLE "project_member" ADD CONSTRAINT "project_member_project_id_fkey"
      FOREIGN KEY ("project_id") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
    -- The 0111 shape, verbatim: the target is the workspace table, and it is not DEFERRABLE.
    ALTER TABLE "project_member" ADD CONSTRAINT "project_member_agent_id_fkey"
      FOREIGN KEY ("agent_id") REFERENCES "workspace"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

    INSERT INTO "user" ("id", "email")
      VALUES ('${OWNER_A}', 'a@example.test'), ('${OWNER_B}', 'b@example.test');
    INSERT INTO "project" ("id", "title") VALUES ('${PROJECT}', 'legacy project');
  `);
}

/** A legacy agent — i.e. a workspace row, which is what the word means on the wire today. */
async function workspace(
  client: Client,
  id: string,
  fields: Record<string, unknown> & { owner_id: string; name: string },
): Promise<void> {
  const columns = ['id', ...Object.keys(fields)];
  const values = [id, ...Object.values(fields)];
  await client.query(
    `INSERT INTO "workspace" (${columns.map((c) => `"${c}"`).join(', ')})
       VALUES (${values.map((_, i) => `$${i + 1}`).join(', ')})`,
    values,
  );
}

async function member(client: Client, id: string, agentId: string, role = 'MEMBER'): Promise<void> {
  await client.query(
    `INSERT INTO "project_member" ("id", "project_id", "agent_id", "role")
       VALUES ($1, $2, $3, $4::"project_role")`,
    [id, PROJECT, agentId, role],
  );
}

const uuid = (tail: string) => `00000000-0000-7000-8000-${tail.padStart(12, '0')}`;

test('02A.6 the mirror set is the union: live workspaces, plus any a membership still names',
  { skip }, async () => {
    const client = await connect();
    try {
      await seedPreMigration(client);
      const live = uuid('1');
      const deletedAndReferenced = uuid('2');
      const deletedAndForgotten = uuid('3');
      const otherOwner = uuid('4');
      await workspace(client, live, { owner_id: OWNER_A, name: 'dev' });
      await workspace(client, deletedAndReferenced, {
        owner_id: OWNER_A, name: 'retired coordinator', deleted_at: '2026-01-01 00:00:00',
      });
      await workspace(client, deletedAndForgotten, {
        owner_id: OWNER_A, name: 'forgotten', deleted_at: '2026-01-01 00:00:00',
      });
      await workspace(client, otherOwner, { owner_id: OWNER_B, name: 'theirs' });
      // A soft delete never fires RESTRICT, so this membership is legal and really exists in
      // production databases. It is the entire reason the mirror set is a union.
      await member(client, uuid('a1'), deletedAndReferenced, 'COORDINATOR');

      await client.query(SLICE);

      const { rows } = await client.query(
        `SELECT "legacy_workspace_id" FROM "agent" ORDER BY "legacy_workspace_id"`,
      );
      assert.deepEqual(
        rows.map((r) => r.legacy_workspace_id).sort(),
        [live, deletedAndReferenced, otherOwner].sort(),
        'the mirror set must be {live} ∪ {referenced by a membership} — and nothing else',
      );

      // Exactly one mirror per source: the count is what 02B's bijection stands on.
      const perSource = await client.query(
        `SELECT "legacy_workspace_id", count(*)::int AS n FROM "agent"
          GROUP BY "legacy_workspace_id" HAVING count(*) > 1`,
      );
      assert.deepEqual(perSource.rows, []);

      // Nothing was taken away. M4: this migration drops no column, no table and no row.
      const workspaces = await client.query(`SELECT count(*)::int AS n FROM "workspace"`);
      assert.equal(workspaces.rows[0].n, 4);
      const members = await client.query(`SELECT count(*)::int AS n FROM "project_member"`);
      assert.equal(members.rows[0].n, 1);
    } finally {
      await client.end();
    }
  });

test('02A.6 every mirrored column equals its source, and every unmapped one is the safe default',
  { skip }, async () => {
    const client = await connect();
    try {
      await seedPreMigration(client);
      const id = uuid('11');
      await workspace(client, id, {
        owner_id: OWNER_A,
        name: 'ios build',
        description: 'builds and ships the iOS client',
        system_prompt: 'you are the iOS build agent',
        append_system_prompt: 'always run the Mac CI',
        model: 'claude-opus-5',
        effort: 'high',
        disallowed_tools: JSON.stringify(['WebSearch']),
        // Configured on the workspace, and deliberately NOT carried across (§11.2 step 3).
        provider_fallbacks: JSON.stringify([{ provider: 'codex' }]),
        // A1's six columns all have data here, so "the mirror copied everything it saw" fails.
        target_runner_id: uuid('f1'),
        target_labels: ['macos'],
        work_dir: '/Users/ci/orbit',
        enable_worktree: true,
        env: JSON.stringify({ CI: '1' }),
        enabled: false,
      });

      await client.query(SLICE);

      const { rows } = await client.query(
        `SELECT a.*, w."created_at" AS "source_created_at"
           FROM "agent" a JOIN "workspace" w ON w."id" = a."legacy_workspace_id"`,
      );
      assert.equal(rows.length, 1);
      const [agent] = rows;

      assert.equal(agent.owner_id, OWNER_A);
      assert.equal(agent.name, 'ios build');
      assert.equal(agent.description, 'builds and ships the iOS client');
      assert.equal(agent.system_prompt, 'you are the iOS build agent');
      assert.equal(agent.append_system_prompt, 'always run the Mac CI');
      assert.equal(agent.default_model, 'claude-opus-5');
      assert.equal(agent.default_effort, 'high');
      assert.deepEqual(agent.disallowed_tools, ['WebSearch']);
      assert.equal(agent.legacy_workspace_id, uuid('11'));
      // Compared in SQL: `timestamp(3) without time zone` round-tripped through a JS Date is a
      // comparison of two conversions, not of the two columns.
      const stamps = await client.query(
        `SELECT (a."created_at" IS NOT DISTINCT FROM w."created_at") AS created,
                (a."deleted_at" IS NOT DISTINCT FROM w."deleted_at") AS deleted
           FROM "agent" a JOIN "workspace" w ON w."id" = a."legacy_workspace_id"`);
      assert.deepEqual(stamps.rows, [{ created: true, deleted: true }]);

      // A legacy agent somebody turned OFF must not come back on by being migrated.
      assert.equal(agent.enabled, false);

      // The four the contract pins, each for its own reason. `default_provider` NULL keeps the
      // derived behaviour a workspace has always had; an empty fallback list means "do not
      // downgrade" (§7.4); nothing is required of a runner and nothing is granted (§8).
      assert.equal(agent.default_provider, null);
      assert.deepEqual(agent.provider_fallbacks, []);
      assert.deepEqual(agent.required_capabilities, []);
      assert.equal(agent.can_create_tasks, false);
      assert.equal(agent.can_delegate, false);
      assert.equal(agent.role, null);
      assert.equal(agent.deleted_at, null);
    } finally {
      await client.end();
    }
  });

test('02A.7 duplicate source names are numbered, stably, and the migration still lands',
  { skip }, async () => {
    const client = await connect();
    try {
      await seedPreMigration(client);
      // Three legacy agents called "orbit", plus one already literally called "orbit (2)". The
      // obvious implementation — row_number() over the name — assigns "orbit (2)" twice and takes
      // the whole migration down on A2's index. That input is the point of this case.
      await workspace(client, uuid('21'), { owner_id: OWNER_A, name: 'orbit' });
      await workspace(client, uuid('22'), { owner_id: OWNER_A, name: 'orbit' });
      await workspace(client, uuid('23'), { owner_id: OWNER_A, name: 'orbit (2)' });
      await workspace(client, uuid('24'), { owner_id: OWNER_A, name: 'orbit' });
      // A different owner's identical name is not a conflict at all: uniqueness is per tenant.
      await workspace(client, uuid('25'), { owner_id: OWNER_B, name: 'orbit' });

      await client.query(SLICE);

      const { rows } = await client.query(
        `SELECT "legacy_workspace_id", "name", "owner_id" FROM "agent"
          ORDER BY "legacy_workspace_id"`,
      );
      const bySource = Object.fromEntries(rows.map((r) => [r.legacy_workspace_id, r.name]));
      assert.equal(bySource[uuid('21')], 'orbit');
      assert.equal(bySource[uuid('22')], 'orbit (2)');
      assert.equal(bySource[uuid('23')], 'orbit (2) (2)');
      assert.equal(bySource[uuid('24')], 'orbit (3)');
      assert.equal(bySource[uuid('25')], 'orbit');
      assert.equal(rows.length, 5);

      // Re-running the backfill is a no-op, not a second identity and not a fresh ' (2)'. The key
      // is `legacy_workspace_id` (§11.2 step 3), which is what makes a half-applied migration
      // recoverable by running it again.
      const backfill = SLICE.slice(SLICE.indexOf('DO $$'));
      await client.query(backfill);
      const after = await client.query(
        `SELECT "legacy_workspace_id", "name" FROM "agent" ORDER BY "legacy_workspace_id"`,
      );
      assert.deepEqual(after.rows, rows.map((r) => ({
        legacy_workspace_id: r.legacy_workspace_id, name: r.name,
      })));
    } finally {
      await client.end();
    }
  });

test('02A.9 a soft-deleted source mirrors to a soft-deleted Agent, in no selector', { skip },
  async () => {
    const client = await connect();
    try {
      await seedPreMigration(client);
      await workspace(client, uuid('31'), {
        owner_id: OWNER_A, name: 'decommissioned', deleted_at: '2026-01-02 03:04:05.678',
      });
      await workspace(client, uuid('32'), { owner_id: OWNER_A, name: 'live one' });
      await member(client, uuid('a2'), uuid('31'), 'COORDINATOR');

      await client.query(SLICE);

      const mirrored = await client.query(
        `SELECT a."name",
                a."deleted_at" IS NOT NULL AS "is_deleted",
                a."deleted_at" IS NOT DISTINCT FROM w."deleted_at" AS "follows_source"
           FROM "agent" a JOIN "workspace" w ON w."id" = a."legacy_workspace_id"
          WHERE a."legacy_workspace_id" = $1`, [uuid('31')],
      );
      assert.equal(mirrored.rows.length, 1);
      // M2: it exists so 02B's foreign key has something to point at, and it carries the source's
      // stamp so it is invisible everywhere else.
      assert.equal(mirrored.rows[0].is_deleted, true);
      assert.equal(mirrored.rows[0].follows_source, true);

      // The selector every listing uses. The mirror is present in the table and absent from it.
      const assignable = await client.query(
        `SELECT "name" FROM "agent"
          WHERE "owner_id" = $1 AND "deleted_at" IS NULL AND "enabled" ORDER BY "name"`,
        [OWNER_A],
      );
      assert.deepEqual(assignable.rows.map((r) => r.name), ['live one']);

      // And a soft-deleted mirror keeps its source's name verbatim: it sits outside A2's partial
      // index, so the live agent that comes along later may take that same name.
      assert.equal(mirrored.rows[0].name, 'decommissioned');
      await client.query(
        `INSERT INTO "agent" ("id", "owner_id", "name") VALUES ($1, $2, 'decommissioned')`,
        [uuid('33'), OWNER_A],
      );
    } finally {
      await client.end();
    }
  });

test('02A.1 a raw-SQL writer cannot leave required_capabilities NULL', { skip }, async () => {
  const client = await connect();
  try {
    await seedPreMigration(client);
    await client.query(SLICE);

    // The hole `prisma migrate diff` reports as zero drift: Prisma emits a scalar list as a
    // NULLABLE column while typing it `String[]`, so without the explicit NOT NULL a raw INSERT
    // stores a value every reader's own type says is impossible. Asserted at the door a raw writer
    // actually uses, because the Prisma client can never produce this row.
    await assert.rejects(
      () => client.query(
        `INSERT INTO "agent" ("id", "owner_id", "name", "required_capabilities")
           VALUES ($1, $2, 'null caps', NULL)`, [uuid('41'), OWNER_A]),
      (error: { code?: string }) => error.code === '23502',
      'agent.required_capabilities must be NOT NULL: an empty set and "unknown" are different facts',
    );

    // Omitting it is fine, and the default is the empty set rather than NULL.
    await client.query(
      `INSERT INTO "agent" ("id", "owner_id", "name") VALUES ($1, $2, 'default caps')`,
      [uuid('42'), OWNER_A],
    );
    const { rows } = await client.query(
      `SELECT "required_capabilities", "provider_fallbacks", "disallowed_tools"
         FROM "agent" WHERE "id" = $1`, [uuid('42')],
    );
    assert.deepEqual(rows[0].required_capabilities, []);
    assert.deepEqual(rows[0].provider_fallbacks, []);
    assert.deepEqual(rows[0].disallowed_tools, []);
  } finally {
    await client.end();
  }
});

test('02A.6 an empty database is migrated too, and backfills nothing', { skip }, async () => {
  const client = await connect();
  try {
    await seedPreMigration(client);
    await client.query(SLICE);
    const { rows } = await client.query(`SELECT count(*)::int AS n FROM "agent"`);
    assert.equal(rows[0].n, 0);
  } finally {
    await client.end();
  }
});
