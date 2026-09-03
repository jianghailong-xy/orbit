import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { Client } from 'pg';
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from '../projects/coordinator-pg-test-safety';

/**
 * The declaration and its data, on a migrated server, after 0227.
 *
 * The static half is in `task-judgment-data-preserved.spec.ts`. This is the half that only a real
 * database can answer: that a task can still BE written with all three criteria and with the 0177
 * pair, that the pair's CHECK still refuses half a declaration, and that the three
 * `project_acceptance_*` tables still take and keep rows.
 */

const URL = process.env.COORDINATOR_PG_URL;
const suite = URL ? test : test.skip;
const OWNER = '00000000-0000-7000-8000-0000000000d1';
const PROJECT = '00000000-0000-7000-8000-0000000000d2';

async function connect(): Promise<Client> {
  assertCoordinatorPgUrlIsIsolated(URL);
  const client = new Client({ connectionString: URL });
  await client.connect();
  await verifyCoordinatorPgIdentity(client);
  await client.query('TRUNCATE "user" RESTART IDENTITY CASCADE');
  await client.query(
    `INSERT INTO "user" (id, email, name, password_hash) VALUES ($1, $2, 'preserved', 'x')`,
    [OWNER, `${OWNER}@preserved.invalid`],
  );
  await client.query(
    `INSERT INTO "project" (id, owner_id, title, updated_at) VALUES ($1, $2, 'preserved', now())`,
    [PROJECT, OWNER],
  );
  return client;
}

async function insertTask(
  client: Client,
  criterion: 'EXECUTABLE' | 'VERIFICATION' | 'EVIDENCE_JUDGMENT',
  acceptance: { command: string; expectedExitCode: number } | null,
): Promise<string> {
  const id = randomUUID();
  await client.query(
    `INSERT INTO "task"
       (id, owner_id, project_id, title, updated_at, creator_type, creator_id,
        completion_criterion, completion_policy, acceptance_command,
        acceptance_expected_exit_code, completion_fence_revision)
     VALUES ($1, $2, $3, $4, now(), 'USER', $2, $5::task_completion_criterion,
             $6::task_completion_policy, $7, $8, 1)`,
    [id, OWNER, PROJECT, `declares ${criterion}`, criterion,
      criterion === 'VERIFICATION' ? 'VERIFICATION_PASSED' : 'MANUAL',
      acceptance?.command ?? null, acceptance?.expectedExitCode ?? null],
  );
  return id;
}

suite('all three criteria are still writable, and EXECUTABLE still carries its pair', async (t) => {
  const client = await connect();
  t.after(async () => { await client.end(); });

  const executable = await insertTask(client, 'EXECUTABLE',
    { command: 'npm run test:outcome-reconciler:full-api', expectedExitCode: 0 });
  const verification = await insertTask(client, 'VERIFICATION', null);
  const evidenceJudgment = await insertTask(client, 'EVIDENCE_JUDGMENT', null);

  const rows = (await client.query<{
    id: string; criterion: string; command: string | null; expected: number | null;
  }>(
    `SELECT "id", "completion_criterion"::text AS criterion, "acceptance_command" AS command,
            "acceptance_expected_exit_code" AS expected
       FROM "task" WHERE "id" = ANY($1::uuid[]) ORDER BY "completion_criterion"::text`,
    [[executable, verification, evidenceJudgment]],
  )).rows;
  assert.deepEqual(rows.map((row) => row.criterion),
    ['EVIDENCE_JUDGMENT', 'EXECUTABLE', 'VERIFICATION']);
  const stored = rows.find((row) => row.criterion === 'EXECUTABLE')!;
  assert.equal(stored.command, 'npm run test:outcome-reconciler:full-api');
  assert.equal(stored.expected, 0);

  // The pair is still a pair, in both directions, and still enforced by 0177's CHECK rather than
  // by anything the service does.
  await assert.rejects(
    client.query(`UPDATE "task" SET "acceptance_command" = NULL WHERE "id" = $1`, [executable]),
    /task_executable_acceptance_pair/,
  );
  await assert.rejects(
    client.query(
      `UPDATE "task" SET "acceptance_expected_exit_code" = 3 WHERE "id" = $1`, [verification],
    ),
    /task_executable_acceptance_pair/,
  );
  // Clearing both together is legal, and leaves the criterion where it was.
  await client.query(
    `UPDATE "task" SET "acceptance_command" = NULL, "acceptance_expected_exit_code" = NULL
      WHERE "id" = $1`, [executable],
  );
  const cleared = (await client.query<{ criterion: string }>(
    `SELECT "completion_criterion"::text AS criterion FROM "task" WHERE "id" = $1`, [executable],
  )).rows[0];
  assert.equal(cleared.criterion, 'EXECUTABLE');

  // And no task row disappeared behind any of it.
  assert.equal(
    (await client.query<{ n: string }>(`SELECT count(*)::text AS n FROM "task"`)).rows[0].n,
    '3',
  );
});

suite('the project acceptance criterion definitions still take, keep and return rows', async (t) => {
  const client = await connect();
  t.after(async () => { await client.end(); });

  // Migration 0229 removed the three JUDGMENT tables this block used to write — run, criterion and
  // conclusion — along with 0172's `project_acceptance_criteria_fact` trigger and the legacy text
  // column that fired it. What 0228 had to preserve and 0229 still preserves is the DECLARATION:
  // `project_acceptance_criterion_definition`, written per item, with an EXECUTABLE criterion
  // still declarable even though nothing satisfies it.
  const definitionId = randomUUID();
  // An EXECUTABLE declaration names the task that produces its evidence: the check constraint
  // `project_acceptance_definition_declaration_chk` requires the command, the expected exit code
  // and the evidence task together, and that constraint is one of the things 0229 left alone.
  const evidenceTaskId = await insertTask(client, 'EXECUTABLE',
    { command: 'npm test', expectedExitCode: 0 });
  await client.query(
    `INSERT INTO "project_acceptance_criterion_definition"
       (id, project_id, ordinal, text, verification_method, completion_criterion, content_hash,
        acceptance_command, acceptance_expected_exit_code, evidence_task_id)
     VALUES ($1, $2, 1, '命令退出码为 0', '读取退出码',
             'EXECUTABLE'::task_completion_criterion, $3, 'npm test', 0, $4)`,
    [definitionId, PROJECT, 'f'.repeat(64), evidenceTaskId],
  );

  const stored = (await client.query<{
    n: string; kind: string; command: string; hash: string; revision: string;
  }>(
    `SELECT count(*) OVER ()::text AS n, "completion_criterion"::text AS kind,
            "acceptance_command" AS command, "content_hash" AS hash, "revision"::text AS revision
       FROM "project_acceptance_criterion_definition" WHERE "project_id" = $1`, [PROJECT],
  )).rows;
  assert.equal(stored.length, 1);
  assert.equal(stored[0].kind, 'EXECUTABLE');
  assert.equal(stored[0].command, 'npm test');
  assert.equal(stored[0].revision, '1');
  // The normalize trigger that stayed recomputed the hash from the row rather than storing what
  // the caller supplied, which is how the declaration's identity is the database's.
  assert.notEqual(stored[0].hash, 'f'.repeat(64));
  assert.match(stored[0].hash, /^[0-9a-f]{64}$/);

  // And the judgment tables are gone rather than empty: an empty table would still be a place for
  // a verdict to be written.
  const judgment = (await client.query<{ relname: string }>(
    `SELECT c."relname" FROM "pg_class" c JOIN "pg_namespace" n ON n."oid" = c."relnamespace"
      WHERE n."nspname" = 'public' AND c."relkind" = 'r'
        AND c."relname" LIKE 'project_acceptance%' ORDER BY 1`,
  )).rows.map((row) => row.relname);
  assert.deepEqual(judgment, ['project_acceptance_criterion_definition']);
});
