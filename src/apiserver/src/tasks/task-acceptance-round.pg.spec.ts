/**
 * EVERY EXECUTABLE ACCEPTANCE ROUND IS RECORDED, AND THE TASK DETAIL LISTS THE ROUNDS PER RUN (migration 1672).
 *
 * Against the production apiserver — `build/main.js`, the whole AppModule, run as a child process — over a real
 * PostgreSQL that `scripts/run-pg-spec.sh` migrates from empty:
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/tasks/task-acceptance-round.pg.spec.ts
 *
 * One EXECUTABLE task (`npm test`, expected exit 0), two runs of it. In each, the runner answers the message turn, the
 * server queues the acceptance shell turn, the inbox hands it out, and the runner reports it through
 * POST /runner/sessions/:id/turn-complete with an exit code, the shell's output and the branch SHA:
 *
 *   1. the first run's round exits 1: the task is FAILED, and the round is recorded with exit 1, expected 0, the SHA,
 *      when it finished and the last 16 KB of a 20 KB output with the database password in it redacted;
 *   2. the task is reopened, and the second run's round exits 0: the task is DONE, and that round is recorded too;
 *   3. GET /tasks/:id lists both, each under its own run, the newer run first, with the fields above; a completion the
 *      runner posts again records no second round.
 *
 * Not destructive: every row belongs to an account this run creates.
 */
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { JwtService } from '@nestjs/jwt';
import { CreatorType, RunStatus, SessionDispatchOrigin, type PrismaClient } from '@prisma/client';
import { toUuid, uuidToBase62 } from '@orbit/shared';
import { Client } from 'pg';

import { call, startApiserver, type Apiserver, type Reply } from '../auth/pat-test-apiserver';
import { prismaClientFor } from '../prisma/prisma-client';
import { assertCoordinatorPgUrlIsIsolated, verifyCoordinatorPgIdentity } from '../projects/coordinator-pg-test-safety';
import { TASK_ACCEPTANCE_CLIENT_TURN_PREFIX } from './executable-acceptance-round';
import '../test-support/daemon-routes-over-http';

const URL_ = process.env.COORDINATOR_PG_URL;
const RUN = randomUUID().slice(0, 8);
const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');
const CAPABLE = ['source-pin/v1'];
const COMMAND = 'npm test';
const MAX_TAIL = 16 * 1024;

/** The failing round's output: 20 KB of log, then the database URL a test printed, then the failure. */
const SECRET = 's3cr3t-database-pw';
const FAILING_OUTPUT = `${'.'.repeat(20_000)}\nconnecting to postgres://app:${SECRET}@db:5432/orbit\nnot ok 3 - widgets render\n# fail 1\n`;
const PASSING_OUTPUT = 'ok 1 - widgets render\nok 2 - widgets save\n# pass 2\n# fail 0\n';
const FAILING_SHA = 'a'.repeat(40);
const PASSING_SHA = 'b'.repeat(40);

test('every EXECUTABLE acceptance round is recorded, and the task detail lists them per run', {
  skip: !URL_, concurrency: 1, timeout: 600_000,
}, async (t) => {
  const url = URL_!;
  assertCoordinatorPgUrlIsIsolated(url);
  const sql = new Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
  await sql.connect();
  await verifyCoordinatorPgIdentity(sql);
  const db: PrismaClient = prismaClientFor(url);
  const jwtSecret = `task-acceptance-round-${randomUUID()}`;
  const jwt = new JwtService({ secret: jwtSecret, signOptions: { expiresIn: '1h' } });
  let server: Apiserver | undefined;
  let beating: ReturnType<typeof setInterval> | undefined;
  t.after(async () => {
    if (beating) clearInterval(beating);
    await server?.stop();
    await db.$disconnect().catch(() => undefined);
    await sql.end().catch(() => undefined);
  });

  const ownerId = randomUUID();
  const email = `owner-${RUN}@task-acceptance-round.test`;
  await db.user.create({ data: { id: ownerId, email, name: 'owner', passwordHash: 'x' } });
  const login = await jwt.signAsync({ sub: ownerId, email });

  const runnerId = randomUUID();
  const token = randomBytes(32).toString('base64url');
  await db.runner.create({
    data: {
      id: runnerId, ownerId, name: `rounds-${RUN}`, tokenHash: sha256(token), status: 'ONLINE', lastHeartbeatAt: new Date(),
      maxConcurrent: 8, capabilities: CAPABLE, capabilitiesReportedAt: new Date(), heartbeatDraining: false,
    },
  });
  const workspaceId = randomUUID();
  await db.workspace.create({ data: { id: workspaceId, ownerId, runnerId, name: `rounds-${RUN}`, enabled: true } });
  // The reaper ends a RUNNING session whose runner stopped heartbeating. This one stays online the whole run.
  beating = setInterval(() => void sql.query(
    `UPDATE "runner" SET "last_heartbeat_at" = clock_timestamp() WHERE "id" = $1::uuid`, [runnerId],
  ).catch(() => undefined), 3_000);

  const taskId = randomUUID();
  await db.task.create({
    data: {
      id: taskId, ownerId, assigneeId: workspaceId, title: `rounds ${RUN}`, creatorType: CreatorType.USER,
      creatorId: ownerId, completionCriterion: 'EXECUTABLE', acceptanceCommand: COMMAND, acceptanceExpectedExitCode: 0,
    },
  });

  server = await startApiserver(url, jwtSecret);
  const runner = (method: string, route: string, body?: unknown): Promise<Reply> =>
    call(server!, method, route, token, body, { 'x-orbit-runner-caller': 'mcp' });
  const owner = (method: string, route: string, body?: unknown): Promise<Reply> => call(server!, method, route, login, body);

  type Run = { id: string; lease: { owner: string; generation: string }; events: number };
  /** A RUNNING run of the task, its inbox held by the engine process `lease` names. */
  async function run(label: string, startedAt: Date): Promise<Run> {
    const id = randomUUID();
    const lease = { owner: randomUUID(), generation: randomUUID() };
    await db.session.create({
      data: {
        id, ownerId, creatorId: ownerId, taskId, workspaceId, assignedRunnerId: runnerId, title: `${label} ${RUN}`,
        prompt: 'do the task', provider: 'claude', providerBuiltin: true, engine: 'claude', status: RunStatus.RUNNING,
        engineTurnActive: true, dispatchOrigin: SessionDispatchOrigin.USER, startsTaskWork: true, startedAt,
        createdAt: startedAt, runtimeSessionId: randomUUID(), numTurns: 1,
        inboxLeaseOwner: lease.owner, inboxLeaseGeneration: lease.generation,
      },
    });
    await sql.query(
      `INSERT INTO "inbox_lease_generation" ("generation", "session_id", "lease_owner") VALUES ($1::uuid, $2::uuid, $3::uuid)`,
      [lease.generation, id, lease.owner],
    );
    return { id, lease, events: 0 };
  }

  const complete = (s: Run, turnId: string, extra: Record<string, unknown> = {}) =>
    runner('POST', `/api/runner/sessions/${uuidToBase62(s.id)}/turn-complete`, {
      turnId: uuidToBase62(turnId), leaseOwner: s.lease.owner, status: 'SUCCEEDED', result: 'done', numTurns: 1,
      costUsd: 0, ...extra,
    });

  /**
   * The message turn answered through the real doors, which queues the acceptance shell turn, and the inbox handing
   * that turn out. Returns the shell turn's id.
   */
  async function acceptanceTurnOf(s: Run): Promise<string> {
    const message = randomUUID();
    await db.conversationTurn.create({
      data: {
        id: message, sessionId: s.id, seq: 1, clientTurnId: randomUUID(), kind: 'message', content: 'do the task',
        status: 'IN_FLIGHT', deliveredAt: new Date(), leaseDeadlineAt: new Date(Date.now() + 300_000),
        leaseGeneration: s.lease.generation,
      },
    });
    const said = await runner('POST', `/api/runner/sessions/${uuidToBase62(s.id)}/events`, {
      leaseOwner: s.lease.owner,
      events: [{ seq: ++s.events, type: 'assistant', turnId: message, ts: new Date().toISOString(), payload: { text: 'Done.' } }],
    });
    assert.equal(said.status, 202, said.text);
    const answered = await complete(s, message);
    assert.equal(answered.status, 200, answered.text);

    const queued = await sql.query<{ id: string; client_turn_id: string }>(
      `SELECT "id", "client_turn_id" FROM "conversation_turn" WHERE "session_id" = $1::uuid AND "kind" = 'shell'`, [s.id]);
    assert.deepEqual(queued.rows.map((r) => r.client_turn_id), [`${TASK_ACCEPTANCE_CLIENT_TURN_PREFIX}${message}:0`],
      'the answered message turn queued its acceptance round');
    const offered = await runner('GET',
      `/api/runner/sessions/${uuidToBase62(s.id)}/inbox?leaseGeneration=${s.lease.generation}`);
    assert.equal(offered.status, 200, offered.text);
    assert.equal(toUuid(String(offered.json?.turnId)), queued.rows[0].id, 'the inbox hands the round out');
    assert.equal(offered.json?.kind, 'shell');
    assert.equal(offered.json?.taskAcceptance, true);
    assert.equal(offered.json?.content, COMMAND);
    return queued.rows[0].id;
  }

  const taskStatus = async () =>
    (await sql.query<{ status: string }>(`SELECT "status" FROM "task" WHERE "id" = $1::uuid`, [taskId])).rows[0].status;
  const roundRows = async () => (await sql.query<{ turn_id: string; exit_code: number | null }>(
    `SELECT "turn_id", "exit_code" FROM "task_acceptance_round" WHERE "task_id" = $1::uuid ORDER BY "finished_at"`,
    [taskId])).rows;

  const firstRun = await run('first run', new Date(Date.now() - 20 * 60_000));
  let failingTurn = '';
  await t.test('(1) a round that exits 1 fails the task and is recorded', async () => {
    failingTurn = await acceptanceTurnOf(firstRun);
    const done = await complete(firstRun, failingTurn, {
      shellExitCode: 1, shellOutput: FAILING_OUTPUT, branchSha: FAILING_SHA,
    });
    assert.equal(done.status, 200, done.text);
    assert.equal(await taskStatus(), 'FAILED', 'exit 1 against an expected 0 is FAILED');
    assert.deepEqual(await roundRows(), [{ turn_id: failingTurn, exit_code: 1 }]);
  });

  const secondRun = await run('second run', new Date(Date.now() - 5 * 60_000));
  let passingTurn = '';
  await t.test('(2) the reopened task\'s next round exits 0: DONE, and recorded too', async () => {
    await sql.query(`UPDATE "task" SET "status" = 'OPEN' WHERE "id" = $1::uuid`, [taskId]);
    passingTurn = await acceptanceTurnOf(secondRun);
    const done = await complete(secondRun, passingTurn, {
      shellExitCode: 0, shellOutput: PASSING_OUTPUT, branchSha: PASSING_SHA,
    });
    assert.equal(done.status, 200, done.text);
    assert.equal(await taskStatus(), 'DONE', 'exit 0 against an expected 0 is DONE');
    assert.deepEqual(await roundRows(), [
      { turn_id: failingTurn, exit_code: 1 },
      { turn_id: passingTurn, exit_code: 0 },
    ]);
  });

  await t.test('(3) GET /tasks/:id lists both rounds, each under its own run, newer run first', async () => {
    // The runner posts a completion again when it lost the answer: the ACK absorbs it, and no second round is written.
    const again = await complete(secondRun, passingTurn, {
      shellExitCode: 0, shellOutput: PASSING_OUTPUT, branchSha: PASSING_SHA,
    });
    assert.equal(again.status, 200, again.text);
    assert.equal((await roundRows()).length, 2, 'a repeated completion records no second round');

    const detail = await owner('GET', `/api/tasks/${uuidToBase62(taskId)}`);
    assert.equal(detail.status, 200, detail.text);
    const runs = (detail.json.sessions as Array<{ id: string; acceptanceRounds: Array<Record<string, any>> }>);
    assert.deepEqual(runs.map((r) => toUuid(r.id)), [secondRun.id, firstRun.id], 'the runs, newest first');
    const [passed, failed] = runs.map((r) => {
      assert.equal(r.acceptanceRounds.length, 1, 'one round per run');
      return r.acceptanceRounds[0];
    });

    assert.equal(toUuid(String(passed.turnId)), passingTurn);
    assert.equal(passed.exitCode, 0);
    assert.equal(passed.expectedExitCode, 0);
    assert.equal(passed.branchSha, PASSING_SHA);
    assert.equal(passed.outputTail, PASSING_OUTPUT, 'a short output is kept whole');

    assert.equal(toUuid(String(failed.turnId)), failingTurn);
    assert.equal(failed.exitCode, 1);
    assert.equal(failed.expectedExitCode, 0);
    assert.equal(failed.branchSha, FAILING_SHA);
    const tail = String(failed.outputTail);
    assert.ok(tail.length > 0 && Buffer.byteLength(tail, 'utf8') <= MAX_TAIL,
      `the tail is clipped to 16 KB (${Buffer.byteLength(tail, 'utf8')} bytes)`);
    assert.ok(tail.endsWith('not ok 3 - widgets render\n# fail 1\n'), 'the tail is the END of the output');
    assert.ok(!tail.includes(SECRET), 'the password the command printed is not stored');
    assert.ok(tail.includes('postgres://[redacted]@db:5432/orbit'), 'it is redacted as an integration check tail is');

    for (const round of [passed, failed]) {
      const finishedAt = Date.parse(String(round.finishedAt));
      assert.ok(Number.isFinite(finishedAt) && Math.abs(Date.now() - finishedAt) < 10 * 60_000,
        `finishedAt is the time the round finished (${round.finishedAt})`);
    }
    assert.ok(Date.parse(passed.finishedAt) >= Date.parse(failed.finishedAt));
    t.diagnostic(`rounds: ${JSON.stringify(runs.map((r) => r.acceptanceRounds.map((x) => ({
      run: r.id, turnId: x.turnId, exitCode: x.exitCode, expectedExitCode: x.expectedExitCode, branchSha: x.branchSha,
      finishedAt: x.finishedAt, outputTailBytes: Buffer.byteLength(String(x.outputTail), 'utf8'),
      outputTailEnd: String(x.outputTail).slice(-90),
    }))))}`);
  });
});
