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

suite('the three project_acceptance_* tables still take, keep and return rows', async (t) => {
  const client = await connect();
  t.after(async () => { await client.end(); });

  // Setting the project's criteria is what fires 0172's `project_acceptance_criteria_fact`, and
  // the definitions it writes are the account-level audit records this change had to preserve.
  await client.query(
    `UPDATE "project" SET "acceptance_criteria" = $2 WHERE "id" = $1`,
    [PROJECT,
      '1. 命令退出码为 0 | 验证方式: 读取退出码\n2. 独立验证通过 | 验证方式: 读取 verdict'],
  );
  const definitions = (await client.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM "project_acceptance_criterion_definition"
      WHERE "project_id" = $1`, [PROJECT],
  )).rows[0].n;
  assert.equal(definitions, '2', 'the 0172 trigger still writes one definition per criterion');

  const runId = randomUUID();
  await client.query(
    `INSERT INTO "project_acceptance_run"
       (id, project_id, attempt, criteria_snapshot, criteria_revision, input_digest, decided_by,
        started_at, created_at, digest_version, acceptance_epoch, conclusion_window_seconds)
     VALUES ($1, $2, 1, 'snapshot', $3, $4, 'USER', now(), now(), 1, 0, 3600)`,
    [runId, PROJECT, 'd'.repeat(64), 'e'.repeat(64)],
  );
  await client.query(
    `INSERT INTO "project_acceptance_criterion"
       (id, run_id, project_id, ordinal, criterion_key, criterion_text, verdict,
        completion_criterion)
     VALUES ($1, $2, $3, 1, 'k1', 'criterion one', 'PASS'::project_acceptance_verdict,
             'EXECUTABLE'::task_completion_criterion)`,
    [randomUUID(), runId, PROJECT],
  );
  await client.query(
    `INSERT INTO "project_acceptance_conclusion"
       (id, project_id, evidence_run_id, evidence_version, ordinal, criterion_key, criterion_text,
        verdict, summary, decided_by, decided_by_id, decided_at, created_at)
     VALUES ($1, $2, $3, 1, 1, 'k1', 'criterion one', 'PASS'::project_acceptance_verdict,
             'preserved', 'USER', $4, now(), now())`,
    [randomUUID(), PROJECT, runId, OWNER],
  );

  const counts = (await client.query<{ definitions: string; criteria: string; conclusions: string }>(
    `SELECT (SELECT count(*)::text FROM "project_acceptance_criterion_definition") AS definitions,
            (SELECT count(*)::text FROM "project_acceptance_criterion") AS criteria,
            (SELECT count(*)::text FROM "project_acceptance_conclusion") AS conclusions`,
  )).rows[0];
  assert.deepEqual(counts, { definitions: '2', criteria: '1', conclusions: '1' });

  // An EXECUTABLE project criterion is still declarable even though nothing satisfies it: the
  // criterion is the statement of what would settle the goal, not a promise about the evaluator.
  const criterionKinds = (await client.query<{ kind: string }>(
    `SELECT DISTINCT "completion_criterion"::text AS kind FROM "project_acceptance_criterion"`,
  )).rows.map((row) => row.kind);
  assert.deepEqual(criterionKinds, ['EXECUTABLE']);
});
