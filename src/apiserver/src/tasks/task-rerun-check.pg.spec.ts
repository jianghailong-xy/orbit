/**
 * RE-RUN THE CHECK: A FAILED EXECUTABLE TASK RUNS ITS ACCEPTANCE COMMAND AGAIN, AND NOTHING ELSE (docs/task-run-sidebar-design.md, D3 = A).
 *
 * Against the production apiserver — `build/main.js`, the whole AppModule, run as a child process — over a real
 * PostgreSQL that `scripts/run-pg-spec.sh` migrates from empty:
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/tasks/task-rerun-check.pg.spec.ts
 *
 * Each task's first round fails through the real doors: the runner answers the run's message turn, the server queues
 * the acceptance shell turn, the inbox hands it out and /turn-complete reports exit 1. Then POST /tasks/:id/rerun-check:
 *
 *   1. a double press (two at once, then a third) queues exactly one acceptance shell turn, under the reserved key, on
 *      the latest run, and no agent turn; the task is IN_PROGRESS and the run is revived for a claim;
 *   2. claimed, taken over and activated through the runner's own doors, the inbox hands out that shell turn and
 *      nothing after it; exit 0 settles the task DONE through the existing comparison, with a new recorded round;
 *   3. on a second task the re-run exits 1: FAILED again, with a new recorded round; the next press names a new key;
 *   4. a task that is not FAILED, one that is not EXECUTABLE, one with no run and one whose runner is offline are each
 *      refused with their typed 409, and queue nothing.
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
import { openingTurnId, openingTurnKey } from '../sessions/orbit-authored-turn';
import { TASK_ACCEPTANCE_CLIENT_TURN_PREFIX } from './executable-acceptance-round';
import { rerunCheckClientTurnId } from './task-rerun-check.service';
import '../test-support/daemon-routes-over-http';

const URL_ = process.env.COORDINATOR_PG_URL;
const RUN = randomUUID().slice(0, 8);
const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');
const CAPABLE = ['source-pin/v1'];
const COMMAND = 'npm test';

test('Re-run the check queues one acceptance round on a FAILED EXECUTABLE task, and no agent turn', {
  skip: !URL_, concurrency: 1, timeout: 600_000,
}, async (t) => {
  const url = URL_!;
  assertCoordinatorPgUrlIsIsolated(url);
  const sql = new Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
  await sql.connect();
  await verifyCoordinatorPgIdentity(sql);
  const db: PrismaClient = prismaClientFor(url);
  const jwtSecret = `task-rerun-check-${randomUUID()}`;
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
  const email = `owner-${RUN}@task-rerun-check.test`;
  await db.user.create({ data: { id: ownerId, email, name: 'owner', passwordHash: 'x' } });
  const login = await jwt.signAsync({ sub: ownerId, email });

  const runnerId = randomUUID();
  const token = randomBytes(32).toString('base64url');
  await db.runner.create({
    data: {
      id: runnerId, ownerId, name: `rerun-${RUN}`, tokenHash: sha256(token), status: 'ONLINE', lastHeartbeatAt: new Date(),
      maxConcurrent: 8, capabilities: CAPABLE, capabilitiesReportedAt: new Date(), heartbeatDraining: false,
    },
  });
  const workspaceId = randomUUID();
  await db.workspace.create({ data: { id: workspaceId, ownerId, runnerId, name: `rerun-${RUN}`, enabled: true } });
  // The reaper ends a RUNNING session whose runner stopped heartbeating. This one stays online the whole run.
  beating = setInterval(() => void sql.query(
    `UPDATE "runner" SET "last_heartbeat_at" = clock_timestamp() WHERE "id" = $1::uuid`, [runnerId],
  ).catch(() => undefined), 3_000);

  // A second machine, signed off: the workspace whose task cannot be re-run now.
  const offlineRunnerId = randomUUID();
  await db.runner.create({
    data: {
      id: offlineRunnerId, ownerId, name: `rerun-offline-${RUN}`, tokenHash: sha256(randomBytes(32).toString('base64url')),
      status: 'OFFLINE', lastHeartbeatAt: new Date(Date.now() - 3_600_000), maxConcurrent: 8, capabilities: CAPABLE,
      capabilitiesReportedAt: new Date(), heartbeatDraining: false,
    },
  });
  const offlineWorkspaceId = randomUUID();
  await db.workspace.create({
    data: { id: offlineWorkspaceId, ownerId, runnerId: offlineRunnerId, name: `rerun-offline-${RUN}`, enabled: true },
  });

  async function task(
    label: string,
    data: { status?: 'OPEN' | 'FAILED'; criterion?: 'EXECUTABLE' | 'EVIDENCE_JUDGMENT'; assigneeId?: string } = {},
  ): Promise<string> {
    const id = randomUUID();
    const executable = (data.criterion ?? 'EXECUTABLE') === 'EXECUTABLE';
    await db.task.create({
      data: {
        id, ownerId, assigneeId: data.assigneeId ?? workspaceId, title: `${label} ${RUN}`, creatorType: CreatorType.USER,
        creatorId: ownerId, status: data.status ?? 'OPEN', completionCriterion: data.criterion ?? 'EXECUTABLE',
        ...(executable ? { acceptanceCommand: COMMAND, acceptanceExpectedExitCode: 0 } : { acceptanceCriteria: 'judged' }),
      },
    });
    return id;
  }

  server = await startApiserver(url, jwtSecret);
  const runner = (method: string, route: string, body?: unknown): Promise<Reply> =>
    call(server!, method, route, token, body, { 'x-orbit-runner-caller': 'mcp' });
  const owner = (method: string, route: string, body?: unknown): Promise<Reply> => call(server!, method, route, login, body);
  const route = (sessionId: string, rest: string) => `/api/runner/sessions/${uuidToBase62(sessionId)}/${rest}`;
  const press = (taskId: string) => owner('POST', `/api/tasks/${uuidToBase62(taskId)}/rerun-check`);

  type Run = { id: string; lease: { owner: string; generation: string }; events: number };
  /** A run of the task, its inbox held by the engine process `lease` names; RUNNING unless told it ended. */
  async function run(taskId: string, label: string, ended?: { runner: string; workspace: string }): Promise<Run> {
    const id = randomUUID();
    const lease = { owner: randomUUID(), generation: randomUUID() };
    const startedAt = new Date(Date.now() - 10 * 60_000);
    await db.session.create({
      data: {
        id, ownerId, creatorId: ownerId, taskId, workspaceId: ended?.workspace ?? workspaceId,
        assignedRunnerId: ended?.runner ?? runnerId, title: `${label} ${RUN}`, prompt: 'do the task', provider: 'claude',
        providerBuiltin: true, engine: 'claude', status: ended ? RunStatus.FAILED : RunStatus.RUNNING,
        engineTurnActive: !ended, dispatchOrigin: SessionDispatchOrigin.USER, startsTaskWork: true, startedAt,
        createdAt: startedAt, runtimeSessionId: randomUUID(), numTurns: 1,
        ...(ended ? { finishedAt: new Date(), error: 'acceptance command exited 1; expected 0' } : {}),
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
    runner('POST', route(s.id, 'turn-complete'), {
      turnId: uuidToBase62(turnId), leaseOwner: s.lease.owner, status: 'SUCCEEDED', result: 'done', numTurns: 1,
      costUsd: 0, ...extra,
    });
  const inbox = (s: Run) => runner('GET', route(s.id, `inbox?leaseGeneration=${s.lease.generation}`));

  /** The run's opening message turn answered through the real doors, which queues the first acceptance round; that round handed out. */
  async function firstRoundOf(s: Run): Promise<string> {
    // The run's opening turn, under the key and id the claim seeds it with (queue.buildSession): a run whose first turn
    // were filed under any other key would be handed its prompt again by the next claim, which no real run is.
    const message = openingTurnId(s.id);
    await db.conversationTurn.create({
      data: {
        id: message, sessionId: s.id, seq: 1, clientTurnId: openingTurnKey(s.id), kind: 'message', content: 'do the task',
        status: 'IN_FLIGHT', deliveredAt: new Date(), leaseDeadlineAt: new Date(Date.now() + 300_000),
        leaseGeneration: s.lease.generation,
      },
    });
    const said = await runner('POST', route(s.id, 'events'), {
      leaseOwner: s.lease.owner,
      events: [{ seq: ++s.events, type: 'assistant', turnId: message, ts: new Date().toISOString(), payload: { text: 'Done.' } }],
    });
    assert.equal(said.status, 202, said.text);
    const answered = await complete(s, message);
    assert.equal(answered.status, 200, answered.text);
    const offered = await inbox(s);
    assert.equal(offered.status, 200, offered.text);
    assert.equal(offered.json?.kind, 'shell');
    assert.equal(offered.json?.taskAcceptance, true);
    return toUuid(String(offered.json?.turnId));
  }

  /** What a runner does with a claimed session: take the inbox over, then activate a generation of its own. */
  async function claimAndAttach(s: Run): Promise<void> {
    const claimed = await runner('GET', '/api/runner/sessions/claim');
    assert.equal(claimed.status, 200, claimed.text);
    assert.equal(toUuid(String(claimed.json?.sessionId)), s.id, `the revived run is the one claimed: ${claimed.text}`);
    const { rows: [current] } = await sql.query<{ owner: string | null }>(
      `SELECT "inbox_lease_owner"::text AS "owner" FROM "session" WHERE "id" = $1::uuid`, [s.id]);
    const process = randomUUID();
    const generation = randomUUID();
    const taken = await runner('POST', route(s.id, 'takeover-leases'), { leaseOwner: process, expectedLeaseOwner: current.owner });
    assert.equal(taken.status, 200, taken.text);
    const activated = await runner('POST', route(s.id, 'activate-leases'), { leaseGeneration: generation, leaseOwner: process });
    assert.equal(activated.status, 200, activated.text);
    s.lease = { owner: process, generation };
  }

  const taskStatus = async (taskId: string) =>
    (await sql.query<{ status: string }>(`SELECT "status" FROM "task" WHERE "id" = $1::uuid`, [taskId])).rows[0].status;
  const sessionStatus = async (sessionId: string) =>
    (await sql.query<{ status: string }>(`SELECT "status" FROM "session" WHERE "id" = $1::uuid`, [sessionId])).rows[0].status;
  const rounds = async (taskId: string) => (await sql.query<{ id: string; turn_id: string; exit_code: number | null }>(
    `SELECT "id", "turn_id", "exit_code" FROM "task_acceptance_round" WHERE "task_id" = $1::uuid ORDER BY "finished_at", "id"`,
    [taskId])).rows;
  const turns = async (sessionId: string) => (await sql.query<{
    id: string; kind: string; status: string; client_turn_id: string; content: string | null;
  }>(
    `SELECT "id", "kind", "status", "client_turn_id", "content" FROM "conversation_turn" WHERE "session_id" = $1::uuid ORDER BY "seq"`,
    [sessionId])).rows;

  // ---------------------------------------------------------------------------------------------------------------
  const taskA = await task('re-run passes');
  const runA = await run(taskA, 'run A');
  let keyA = '';
  let rerunTurnA = '';
  await t.test('(1) a double press queues exactly one acceptance shell turn on the latest run, and no agent turn', async () => {
    const firstRound = await firstRoundOf(runA);
    const failed = await complete(runA, firstRound, { shellExitCode: 1, shellOutput: 'not ok 1\n', branchSha: 'a'.repeat(40) });
    assert.equal(failed.status, 200, failed.text);
    assert.equal(await taskStatus(taskA), 'FAILED', 'exit 1 against an expected 0 is FAILED');
    assert.equal(await sessionStatus(runA.id), 'FAILED', 'the round ended its run');
    const [recorded] = await rounds(taskA);
    assert.equal(recorded.exit_code, 1);
    const before = await turns(runA.id);

    // Two at once, then a third after both answered.
    const [one, two] = await Promise.all([press(taskA), press(taskA)]);
    const three = await press(taskA);
    t.diagnostic(`presses: ${JSON.stringify([one, two, three].map((r) => ({ status: r.status, body: r.json })))}`);
    const accepted = [one, two, three].filter((r) => r.status === 201);
    assert.ok(accepted.length >= 2, 'at least one of the simultaneous presses and the later one are answered');
    for (const r of [one, two]) {
      // A press that met the other mid-write is told to retry, and wrote nothing.
      if (r.status !== 201) assert.equal(r.status, 409, r.text);
    }
    assert.equal(three.status, 201, three.text);
    assert.equal(three.json.replayed, true, 'the later press found the round already queued');
    const turnIds = new Set(accepted.map((r) => toUuid(String(r.json.turnId))));
    assert.equal(turnIds.size, 1, 'every answered press names the same round');
    assert.equal(toUuid(String(three.json.sessionId)), runA.id, 'on the latest run');

    const after = await turns(runA.id);
    const added = after.slice(before.length);
    keyA = rerunCheckClientTurnId(recorded.id, 0);
    assert.deepEqual(added.map((r) => ({ kind: r.kind, status: r.status, key: r.client_turn_id, content: r.content })), [
      { kind: 'shell', status: 'PENDING', key: keyA, content: COMMAND },
    ], 'one acceptance shell turn, under the reserved key, and nothing else');
    assert.ok(keyA.startsWith(TASK_ACCEPTANCE_CLIENT_TURN_PREFIX));
    assert.equal(after.filter((r) => r.kind === 'message').length, 1, 'no agent turn was queued: only the run\'s own message');
    rerunTurnA = added[0].id;
    assert.equal(toUuid(String(three.json.turnId)), rerunTurnA);
    assert.equal(await taskStatus(taskA), 'IN_PROGRESS', 'the task is pending again');
    assert.equal(await sessionStatus(runA.id), 'PENDING', 'the run is revived for a claim');
  });

  await t.test('(2) the runner is handed that shell turn and nothing after it; exit 0 settles DONE with a new round', async () => {
    await claimAndAttach(runA);
    const offered = await inbox(runA);
    assert.equal(offered.status, 200, offered.text);
    assert.equal(toUuid(String(offered.json?.turnId)), rerunTurnA, 'the inbox hands out the re-run round');
    assert.equal(offered.json?.kind, 'shell');
    assert.equal(offered.json?.taskAcceptance, true);
    assert.equal(offered.json?.content, COMMAND);
    const next = await inbox(runA);
    assert.ok(!next.json?.turnId, `nothing is handed out behind it: ${next.text}`);

    const passed = await complete(runA, rerunTurnA, { shellExitCode: 0, shellOutput: 'ok 1\n# pass 1\n', branchSha: 'b'.repeat(40) });
    assert.equal(passed.status, 200, passed.text);
    assert.equal(await taskStatus(taskA), 'DONE', 'exit 0 against an expected 0 is DONE, through the comparison');
    assert.deepEqual((await rounds(taskA)).map((r) => ({ turn: r.turn_id === rerunTurnA, exit: r.exit_code })), [
      { turn: false, exit: 1 },
      { turn: true, exit: 0 },
    ], 'the re-run is a new recorded round');
    const all = await turns(runA.id);
    // Every turn the run has, for whoever reads the run: no message after the opening one.
    t.diagnostic(`run A turns: ${JSON.stringify((await sql.query(
      `SELECT "seq", "kind", "status", "client_turn_id", left("content", 160) AS "content", "delivered_at" FROM "conversation_turn" WHERE "session_id" = $1::uuid ORDER BY "seq"`,
      [runA.id])).rows)}`);
    assert.equal(all.filter((r) => r.kind === 'message').length, 1, 'still no agent turn');
    assert.equal(all.filter((r) => r.kind === 'shell').length, 2, 'the first round and the re-run, nothing more');
    t.diagnostic(`task A: ${JSON.stringify({ status: await taskStatus(taskA), rounds: await rounds(taskA), key: keyA })}`);
  });

  // ---------------------------------------------------------------------------------------------------------------
  const taskB = await task('re-run fails again');
  const runB = await run(taskB, 'run B');
  await t.test('(3) a re-run that exits 1 settles FAILED with a new round, and the next press names a new key', async () => {
    const firstRound = await firstRoundOf(runB);
    assert.equal((await complete(runB, firstRound, { shellExitCode: 1, shellOutput: 'not ok 1\n' })).status, 200);
    assert.equal(await taskStatus(taskB), 'FAILED');

    const pressed = await press(taskB);
    assert.equal(pressed.status, 201, pressed.text);
    assert.equal(pressed.json.replayed, false);
    const rerunTurn = toUuid(String(pressed.json.turnId));
    assert.equal(await taskStatus(taskB), 'IN_PROGRESS');
    await claimAndAttach(runB);
    const offered = await inbox(runB);
    assert.equal(toUuid(String(offered.json?.turnId)), rerunTurn, offered.text);
    assert.equal(offered.json?.taskAcceptance, true);
    const failedAgain = await complete(runB, rerunTurn, { shellExitCode: 1, shellOutput: 'not ok 1\n', branchSha: 'c'.repeat(40) });
    assert.equal(failedAgain.status, 200, failedAgain.text);
    assert.equal(await taskStatus(taskB), 'FAILED', 'exit 1 against an expected 0 is FAILED again');
    const recorded = await rounds(taskB);
    assert.deepEqual(recorded.map((r) => ({ turn: r.turn_id === rerunTurn, exit: r.exit_code })), [
      { turn: false, exit: 1 },
      { turn: true, exit: 1 },
    ], 'the re-run is a new recorded round');
    assert.equal((await turns(runB.id)).filter((r) => r.kind === 'message').length, 1, 'no agent turn');

    // The settled round is the newest now, so the next press is a new press: a new key and a new round.
    const again = await press(taskB);
    assert.equal(again.status, 201, again.text);
    assert.equal(again.json.replayed, false);
    assert.notEqual(toUuid(String(again.json.turnId)), rerunTurn);
    const queued = (await turns(runB.id)).at(-1)!;
    assert.equal(queued.client_turn_id, rerunCheckClientTurnId(recorded[1].id, 0));
    assert.equal(queued.kind, 'shell');
    t.diagnostic(`task B: ${JSON.stringify({ rounds: recorded, nextKey: queued.client_turn_id })}`);
  });

  // ---------------------------------------------------------------------------------------------------------------
  await t.test('(4) not FAILED, not EXECUTABLE, no run, no runner online: each a typed refusal that queues nothing', async () => {
    const open = await task('still open');
    const openRun = await run(open, 'open run');
    const judged = await task('judged', { status: 'FAILED', criterion: 'EVIDENCE_JUDGMENT' });
    const judgedRun = await run(judged, 'judged run', { runner: runnerId, workspace: workspaceId });
    const runless = await task('never ran', { status: 'FAILED' });
    const stranded = await task('runner offline', { status: 'FAILED', assigneeId: offlineWorkspaceId });
    const strandedRun = await run(stranded, 'stranded run', { runner: offlineRunnerId, workspace: offlineWorkspaceId });

    const cases: Array<[string, string, string | null, string]> = [
      [open, 'RERUN_CHECK_TASK_NOT_FAILED', openRun.id, 'OPEN'],
      [taskA, 'RERUN_CHECK_TASK_NOT_FAILED', runA.id, 'DONE'],
      [judged, 'RERUN_CHECK_NOT_EXECUTABLE', judgedRun.id, 'FAILED'],
      [runless, 'RERUN_CHECK_NO_RUN_SESSION', null, 'FAILED'],
      [stranded, 'RERUN_CHECK_RUNNER_OFFLINE', strandedRun.id, 'FAILED'],
    ];
    const refusals: unknown[] = [];
    for (const [taskId, code, sessionId, status] of cases) {
      const before = sessionId ? await turns(sessionId) : [];
      const sessionBefore = sessionId ? await sessionStatus(sessionId) : null;
      const reply = await press(taskId);
      refusals.push({ code: reply.json?.code, status: reply.status, message: reply.json?.message });
      assert.equal(reply.status, 409, reply.text);
      assert.equal(reply.json?.code, code, reply.text);
      assert.equal(typeof reply.json?.message, 'string');
      assert.match(String(reply.json?.message), /^[\x20-\x7E]+$/, 'the refusal is said in English');
      assert.equal(await taskStatus(taskId), status, 'the task is where it was');
      if (sessionId) {
        assert.deepEqual(await turns(sessionId), before, 'nothing was queued');
        assert.equal(await sessionStatus(sessionId), sessionBefore, 'the run was not revived');
      }
    }
    t.diagnostic(`refusals: ${JSON.stringify(refusals)}`);
  });
});
