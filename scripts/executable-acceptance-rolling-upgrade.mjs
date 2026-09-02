#!/usr/bin/env node
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);
const repo = path.resolve(import.meta.dirname, '..');
const apiDist = path.join(repo, 'src/apiserver/dist');
const url = process.env.EXECUTABLE_ACCEPTANCE_ROLLING_PG_URL;
const phase = process.argv[2];
assert.ok(url, 'EXECUTABLE_ACCEPTANCE_ROLLING_PG_URL is required');
assert.ok(phase === 'seed' || phase === 'verify', 'phase must be seed or verify');

const { Pool } = require('pg');
const pool = new Pool({ connectionString: url, max: 4 });
const fixture = {
  ownerId: '01a04900-0000-7000-8000-000000000001',
  runnerId: '01a04900-0000-7000-8000-000000000002',
  workspaceId: '01a04900-0000-7000-8000-000000000003',
  projectId: '01a04900-0000-7000-8000-000000000008',
  taskId: '01a04900-0000-7000-8000-000000000004',
  sessionId: '01a04900-0000-7000-8000-000000000005',
  turnId: '01a04900-0000-7000-8000-000000000006',
  predecessorTurnId: '01a04900-0000-7000-8000-000000000007',
  terminalEventId: '01a04900-0000-7000-8000-000000000009',
};
const rawOutput = 'legacy result survived 0193, 0200, and 0201\n';

async function seed() {
  await pool.query(`
    CREATE TABLE rolling_v1_fixture_stage (
      fixture text PRIMARY KEY,
      seeded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      migration_frontier text NOT NULL
    )
  `);
  await pool.query(`
    INSERT INTO "user" (id,email,name,password_hash)
    VALUES ($1,'rolling-v1@acceptance.invalid','rolling-v1','x')
  `, [fixture.ownerId]);
  await pool.query(`
    INSERT INTO runner (id,owner_id,name,token_hash,status)
    VALUES ($1,$2,'rolling-v1-runner','x','ONLINE')
  `, [fixture.runnerId, fixture.ownerId]);
  await pool.query(`
    INSERT INTO workspace (id,owner_id,runner_id,name,enabled)
    VALUES ($1,$2,$3,'rolling-v1-workspace',true)
  `, [fixture.workspaceId, fixture.ownerId, fixture.runnerId]);
  await pool.query(`
    INSERT INTO project (id,owner_id,title,updated_at)
    VALUES ($1,$2,'rolling-v1-project',clock_timestamp())
  `, [fixture.projectId, fixture.ownerId]);
  await pool.query(`
    INSERT INTO task (
      id,owner_id,creator_type,creator_id,title,project_id,assignee_id,status,
      completion_criterion,acceptance_criteria,acceptance_command,
      acceptance_expected_exit_code,updated_at
    ) VALUES ($1,$2,'USER',$2,'rolling v1 before writer fence',$3,$4,'OPEN',
              'EXECUTABLE','command exits zero','true',0,clock_timestamp())
  `, [fixture.taskId, fixture.ownerId, fixture.projectId, fixture.workspaceId]);
  await pool.query(`
    INSERT INTO session (
      id,owner_id,creator_id,task_id,workspace_id,assigned_runner_id,title,prompt,
      provider,status,engine_turn_active,dispatch_origin,starts_task_work,updated_at
    ) VALUES ($1,$2,$2,$3,$4,$5,'rolling-v1','rolling-v1','claude','RUNNING',true,'USER',true,
              clock_timestamp())
  `, [fixture.sessionId, fixture.ownerId, fixture.taskId, fixture.workspaceId, fixture.runnerId]);
  await pool.query(`
    INSERT INTO conversation_turn (
      id,session_id,seq,client_turn_id,kind,content,status,delivered_at
    ) VALUES ($1,$2,2,$3,'shell','true','IN_FLIGHT',clock_timestamp())
  `, [
    fixture.turnId,
    fixture.sessionId,
    `system:task-acceptance:v1:${fixture.predecessorTurnId}:0`,
  ]);
  // This is deliberately written before 0201 exists. The rolling migration must leave its new
  // ingestion/provenance columns NULL and use the DB-owned rollout epoch as the SLO clock; treating
  // the runner's historical created_at as current truth would either alarm immediately or never.
  await pool.query(`
    INSERT INTO run_event (id,session_id,seq,type,payload,turn_id,created_at)
    VALUES ($1,$2,1,'tool_result',$3::jsonb,$4,clock_timestamp() - interval '1 day')
  `, [
    fixture.terminalEventId,
    fixture.sessionId,
    JSON.stringify({
      toolUseId: `shell-${fixture.turnId}`,
      content: rawOutput,
      isError: false,
    }),
    fixture.turnId,
  ]);
  await pool.query(`
    INSERT INTO rolling_v1_fixture_stage (fixture,migration_frontier)
    VALUES ('legacy-shell-in-flight','0192_verifier_role_completion')
  `);
}

function realtime() {
  return {
    publishSessionUpdated() {}, publishTaskChanged() {}, publishQueuedTurnsChanged() {},
    publish() {}, publishForUser() {}, notifyInbox() {}, waitForInbox: async () => undefined,
  };
}

async function verify() {
  const { prismaClientFor } = require(path.join(apiDist, 'prisma/prisma-client.js'));
  const { RunnerApiController } = require(path.join(apiDist, 'runner-api/runner-api.controller.js'));
  const { RunStatus } = require(path.join(repo, 'src/apiserver/node_modules/@prisma/client'));
  const db = prismaClientFor(url);
  try {
    const history = await pool.query(`
      SELECT f.seeded_at,
             max(m.finished_at) FILTER (WHERE m.migration_name = '0193_task_done_writer_fence') AS fence_at,
             max(m.finished_at) FILTER (WHERE m.migration_name = '0200_executable_acceptance_runtime_contract') AS runtime_at
        FROM rolling_v1_fixture_stage f
        CROSS JOIN _prisma_migrations m
       WHERE f.fixture = 'legacy-shell-in-flight'
       GROUP BY f.seeded_at
    `);
    assert.equal(history.rowCount, 1);
    assert.ok(history.rows[0].fence_at > history.rows[0].seeded_at);
    assert.ok(history.rows[0].runtime_at > history.rows[0].seeded_at);
    const before = await db.task.findUniqueOrThrow({ where: { id: fixture.taskId } });
    assert.equal(before.status, 'OPEN');
    assert.equal(before.acceptanceEvaluationPlanDigest, null);
    assert.equal(await db.taskExecutableAdmission.count({ where: { taskId: fixture.taskId } }), 0);
    assert.equal(await db.taskExecutableAttempt.count({ where: { taskId: fixture.taskId } }), 0);

    const historicalEvent = (await pool.query(`
      SELECT ingested_at, ingested_by_runner_id, ingested_under_lease_generation
        FROM run_event WHERE id = $1::uuid
    `, [fixture.terminalEventId])).rows[0];
    assert.equal(historicalEvent.ingested_at, null);
    assert.equal(historicalEvent.ingested_by_runner_id, null);
    assert.equal(historicalEvent.ingested_under_lease_generation, null);
    const api = new RunnerApiController(
      db,
      { notifySessionQueued() {} },
      realtime(),
      {}, {}, {},
      { appendFor: async (_tx, _sessionId, content) => content },
      undefined, undefined,
    );
    const callback = {
      turnId: fixture.turnId,
      status: RunStatus.SUCCEEDED,
      subtype: 'shell',
      shellExitCode: 0,
      shellOutput: rawOutput,
    };
    // The reserved acceptance turn now reaches the pre-existing needs-human signal rather than a
    // comparison, so the SESSION ends FAILED where it used to park at AWAITING_INPUT. The task
    // does not: a transport-shaped outcome was never allowed to guess a task status, and that is
    // the branch this callback lands in now.
    assert.deepEqual(
      await api.turnComplete({ id: fixture.runnerId }, fixture.sessionId, callback),
      { ok: true, status: RunStatus.FAILED },
    );
    assert.deepEqual(
      await api.turnComplete({ id: fixture.runnerId }, fixture.sessionId, callback),
      { ok: true, status: RunStatus.FAILED },
    );
    // What this proves changed on 2026-09-02. The pre-0193 v1 turn still SURVIVES the rolling
    // upgrade — the ACK commits, the turn is answered, the session is not wedged and no exception
    // reaches the runner — but it no longer settles the task, because the evaluator that compared
    // its exit code to the declaration was removed with the judgment machinery. The declaration
    // itself is untouched, which is the half the account owner kept.
    const [task, session, turn] = await Promise.all([
      db.task.findUniqueOrThrow({ where: { id: fixture.taskId } }),
      db.session.findUniqueOrThrow({ where: { id: fixture.sessionId } }),
      db.conversationTurn.findUniqueOrThrow({ where: { id: fixture.turnId } }),
    ]);
    assert.equal(turn.status, 'ANSWERED');
    assert.equal(session.engineTurnActive, false);
    assert.equal(task.status, 'OPEN');
    assert.equal(task.completionCriterion, 'EXECUTABLE');
    assert.equal(task.acceptanceExpectedExitCode, 0);
    assert.ok(task.acceptanceCommand);
    assert.equal(await db.taskExecutableAdmission.count({ where: { taskId: fixture.taskId } }), 0);
    assert.equal(await db.taskExecutableAttempt.count({ where: { taskId: fixture.taskId } }), 0);

    const evidencePath = process.env.EXECUTABLE_ACCEPTANCE_EVIDENCE_PATH;
    if (evidencePath) {
      const evidence = existsSync(evidencePath)
        ? JSON.parse(readFileSync(evidencePath, 'utf8'))
        : {};
      evidence.compatibility ??= {};
      evidence.compatibility.stagedPre0193V1Turn = true;
      evidence.compatibility.v1CallbackNoLongerDerivesStatus = true;
      evidence.compatibility.crossed0193And0200 = true;
      evidence.compatibility.historicalTerminalEventUningested = true;
      writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
    }
  } finally {
    await db.$disconnect();
  }
}

try {
  if (phase === 'seed') await seed();
  else await verify();
} finally {
  await pool.end();
}
