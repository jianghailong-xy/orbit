import assert from 'node:assert/strict';
import test from 'node:test';

import { Client } from 'pg';

import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from '../projects/coordinator-pg-test-safety';

/**
 * (j)(k) The families the removal was told not to touch, checked rather than assumed.
 *
 * `task_executable_*` is the EXECUTABLE acceptance wall and `project_acceptance_*` settles
 * projects. Neither is completion ACK, and neither was only reachable through it — but 0202 built
 * `executable_runtime_*` in the same migration as the protocol and let it borrow two helpers, so
 * "it was in the same file" is not an argument either way. Each family is checked as a shape that
 * still exists AND as behaviour that still runs.
 *
 * `failure_continuation_*` / `failure_successor_*` were a third family here, for the same reason
 * and with a database half that read their columns back field for field. Migration 0226 removed
 * that family outright — a separate, later decision about the failure router, not a late effect of
 * this one — so the catalog half of that claim has no subject left and is gone. What 0220 does to
 * them is still asserted below, where it always belonged: the statement scan over 0220's own text,
 * which is frozen and still names none of these prefixes.
 */

const URL = process.env.COORDINATOR_PG_URL;
const suite = URL ? test : test.skip;

async function connect(): Promise<Client> {
  assertCoordinatorPgUrlIsIsolated(URL);
  const client = new Client({ connectionString: URL });
  await client.connect();
  await verifyCoordinatorPgIdentity(client);
  return client;
}

/** Relation + trigger census for one family, as the catalog reports it. */
async function census(client: Client, prefix: string) {
  const relations = (await client.query<{ name: string; kind: string }>(
    `SELECT c.relname AS name, c.relkind::text AS kind
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind IN ('r','v') AND c.relname LIKE $1
      ORDER BY 1`,
    [`${prefix}%`],
  )).rows;
  const triggers = (await client.query<{ name: string }>(
    `SELECT c.relname || '|' || t.tgname AS name
       FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
      WHERE NOT t.tgisinternal AND c.relname LIKE $1 ORDER BY 1`,
    [`${prefix}%`],
  )).rows.map((row) => row.name);
  return { relations, triggers };
}

// (j) --------------------------------------------------------------------------------------------
suite('(j) task_executable_* and project_acceptance_* are both still installed', async (t) => {
  const client = await connect();
  t.after(async () => { await client.end(); });

  for (const [prefix, tables, triggers] of [
    ['task_executable_', 6, 1],
    ['project_acceptance_', 5, 1],
  ] as const) {
    const { relations, triggers: installed } = await census(client, prefix);
    assert.ok(relations.length >= tables,
      `${prefix}* has only ${relations.length} relations: ${relations.map((r) => r.name).join(', ')}`);
    assert.ok(installed.length >= triggers,
      `${prefix}* lost its guards: ${installed.join(', ')}`);
  }

  // The named walls the task called out one by one, so a reader sees the exact list.
  for (const table of [
    'task_executable_admission',
    'task_executable_attempt',
    'task_executable_continuation',
    'task_executable_diagnosis',
    'task_executable_judgment_result',
    'project_acceptance_run',
    'project_acceptance_criterion',
    'project_acceptance_conclusion',
  ]) {
    const present = await client.query(
      `SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relname = $1 AND c.relkind IN ('r','v')`,
      [table],
    );
    assert.equal(present.rowCount, 1, `${table} must still exist`);
  }
});

test('(j)(k) 0220 issues no statement against any protected family', () => {
  const sql = require('node:fs').readFileSync(
    require('node:path').resolve(
      __dirname, '../../prisma/migrations/0220_completion_ack_removal/migration.sql',
    ),
    'utf8',
  ) as string;
  // Comments are the only place a protected name may appear: the migration explains what it is NOT
  // touching, and a reader must be able to tell the explanation from a statement.
  const statements = sql
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('--'))
    .join('\n');
  for (const prefix of [
    'task_executable_', 'failure_continuation_', 'failure_successor_', 'project_acceptance_',
  ]) {
    assert.equal(statements.includes(prefix), false,
      `0220 must not name ${prefix}* in any statement`);
  }
  // No DML the migration itself performs. The re-created `executable_runtime_*` bodies contain
  // INSERTs — they are the functions' own text, copied verbatim — so this looks only at what runs
  // when the migration is applied: everything outside a `$$ ... $$` body.
  const outsideBodies = statements
    .replace(/\$function\$[\s\S]*?\$function\$/g, '$body$')
    .replace(/\$\$[\s\S]*?\$\$/g, '$body$');
  // Statement-initial, so `BEFORE INSERT OR UPDATE OF ...` in a trigger definition is not read as
  // a DML statement.
  const dml = outsideBodies
    .split('\n')
    .filter((line) => /^\s*(INSERT\s+INTO|UPDATE|DELETE\s+FROM|TRUNCATE)\b/i.test(line));
  assert.deepEqual(dml, [], '0220 must issue no DML statement of its own');
  // Nothing is archived either: the rows that go, go with their tables.
  assert.equal(/CREATE TABLE/i.test(outsideBodies), false,
    '0220 must not create an archive table to keep the removed rows alive');
});
