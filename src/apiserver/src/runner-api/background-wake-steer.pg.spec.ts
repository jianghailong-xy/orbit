import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { ConflictException } from '@nestjs/common';
import { Client } from 'pg';
import { SESSION_CURRENT_WORK_ROUTING_V1 } from '@orbit/shared';
import { prismaClientFor } from '../prisma/prisma-client';
import { SessionsService } from '../sessions/sessions.service';
import { BackgroundWakeDto } from './background-job-wake';
import { RunnerApiController } from './runner-api.controller';

/**
 * A background job that exits while its session is running a turn is written INTO that turn, against
 * the real application schema.
 *
 * It used to be queued behind the turn: the agent learned the job had ended only once the turn it was
 * in had finished, and then a whole turn was opened to tell it — 339 of 1,385 wakes between 09-14 and
 * 09-28 waited more than 20 seconds that way, a median of one to sixteen minutes. Now a job's exit is
 * a CURRENT_WORK steer aimed at the running turn whenever the runtime and the runner can take one,
 * decided in createTurn's own transaction under the Session lock (`steerIfLive`), and everything else
 * about a wake is what it was:
 *
 *   (a) a Claude turn running under a live lease, behind a runner that declared routing-v1: a steer
 *       aimed at that exact turn, listed as one, never withdrawable, joined by the next exit while it
 *       still waits for the runner and not once the runner has taken it;
 *   (b) no turn running, a kimi session, or a runner without routing-v1: the next-turn wake turn it
 *       has always been;
 *   (c) a job's new output: always the next turn's, joining the wake queued there and never a steer;
 *   (d) a steer whose turn ended before the engine read it — at the target's completion, or handed
 *       back by the runner — is a deliverable wake turn again, carrying its block, and takes a wake
 *       already queued for the next turn into itself instead of opening a second turn;
 *   (e) the runner is handed the steer with the wake written into it, in the steer's own words, and
 *       its echo is stored as the control plane's note — what every client draws the wake line from.
 *
 * Two traps of the requeue path are built around rather than into: a turn completed with nothing
 * answering it goes back to the queue with the lowest seq, so the next take would hand THAT out
 * instead of the wake behind it; and a turn that fails ends the run, whose drain answers whatever is
 * still queued. So every completion here is a success the engine replied to (`answer`).
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/runner-api/background-wake-steer.pg.spec.ts
 */
const PG_URL = process.env.COORDINATOR_PG_URL;

const OWNER_ID = '81111111-1111-4111-8111-111111111111';
const RUNNER_ID = '82222222-2222-4222-8222-222222222222';
const SESSION_ID = '83333333-3333-4333-8333-333333333333';
const OPENING_TURN_ID = '84444444-4444-4444-8444-444444444444';
const RUNNING_TURN_ID = '85555555-5555-4555-8555-555555555555';

const ROUTING = [SESSION_CURRENT_WORK_ROUTING_V1];
const RUNNER = { id: RUNNER_ID, ownerId: OWNER_ID };

/** How a steer's block says it arrived, and how a turn opened for a wake says it. */
const STEER_HEAD = 'It ended while you were working, so this message was added to the turn you are in:';
const OPENED_HEAD = 'the control plane opened this turn for it:';

let admin: Client;
let prisma: ReturnType<typeof prismaClientFor>;
let sessions: SessionsService;
let runnerApi: RunnerApiController;
let eventSeq = 0;

/** A collaborator whose every method answers nothing: the broadcasts an enqueue and an event batch fire. */
const silent = (): unknown =>
  new Proxy({}, { get: (_target, key) => (key === 'then' ? undefined : () => undefined) });

/** Every case needs the database; without it each one reports SKIP, which run-pg-spec.sh calls RED. */
function scenario(name: string, body: () => Promise<void>): void {
  test(name, { skip: PG_URL ? false : 'set COORDINATOR_PG_URL to run the steered wake suite' }, body);
}

async function cleanup(): Promise<void> {
  await admin.query(`DELETE FROM "session" WHERE owner_id = $1::uuid`, [OWNER_ID]);
  await admin.query(`DELETE FROM "runner" WHERE owner_id = $1::uuid`, [OWNER_ID]);
  await admin.query(`DELETE FROM "user" WHERE id = $1::uuid`, [OWNER_ID]);
}

before(async () => {
  if (!PG_URL) return;
  admin = new Client({ connectionString: PG_URL });
  await admin.connect();
  prisma = prismaClientFor(PG_URL);
  await prisma.$connect();
  await cleanup();
  await admin.query(
    `INSERT INTO "user"(id, email, name, password_hash)
     VALUES ($1::uuid, 'background-wake-steer@example.test', 'wake', 'test')`,
    [OWNER_ID],
  );
  await admin.query(
    `INSERT INTO "runner"(id, name, owner_id, token_hash, status, last_heartbeat_at, capabilities)
     VALUES ($1::uuid, 'background-wake-steer', $2::uuid, 'test', 'ONLINE', clock_timestamp(), $3::text[])`,
    [RUNNER_ID, OWNER_ID, ROUTING],
  );
  const realtime = silent();
  const queue = { notifySessionQueued: () => undefined };
  sessions = new SessionsService(prisma as never, queue as never, realtime as never);
  runnerApi = new RunnerApiController(
    prisma as never,
    queue as never,
    realtime as never,
    silent() as never,
    {} as never,
    { expand: async (_ownerId: string, content?: string) => content } as never,
    { appendFor: async (_tx: unknown, _sessionId: string, content?: string) => content } as never,
    undefined,
    undefined,
    undefined,
    undefined,
    sessions,
  );
});

after(async () => {
  try {
    if (admin) await cleanup();
  } finally {
    await prisma?.$disconnect();
    await admin?.end();
  }
});

interface Seed {
  /** The session's runtime. */
  provider?: string;
  /** Whether a message turn is running, and under what lease. */
  running?: 'live' | 'expired' | false;
  /** What the session's runner declared on its last heartbeat. */
  capabilities?: readonly string[];
}

/** A session one turn into its work, running its second — the state a job usually ends in. */
async function seed({ provider = 'claude', running = 'live', capabilities = ROUTING }: Seed = {}): Promise<void> {
  await admin.query(`DELETE FROM "session" WHERE id = $1::uuid`, [SESSION_ID]);
  await admin.query(
    `UPDATE "runner" SET capabilities = $2::text[], capabilities_reported_at = clock_timestamp()
      WHERE id = $1::uuid`,
    [RUNNER_ID, capabilities],
  );
  await admin.query(
    `INSERT INTO "session"(
       id, title, prompt, owner_id, creator_id, assigned_runner_id, provider,
       provider_builtin, status, num_turns, updated_at
     ) VALUES (
       $1::uuid, 'steered wake', 'opening prompt', $2::uuid, $2::uuid, $3::uuid, $4,
       TRUE, $5, 1, clock_timestamp()
     )`,
    [SESSION_ID, OWNER_ID, RUNNER_ID, provider, running ? 'RUNNING' : 'AWAITING_INPUT'],
  );
  await admin.query(
    `INSERT INTO "conversation_turn"(id, session_id, seq, client_turn_id, kind, content, status)
     VALUES ($1::uuid, $2::uuid, 1, $3, 'message', 'opening prompt', 'ANSWERED')`,
    [OPENING_TURN_ID, SESSION_ID, SessionsService.initialTurnClientId(SESSION_ID)],
  );
  if (running) {
    // Delivered as dequeueTurn delivers one: IN_FLIGHT, with the delivery and the lease it carries.
    await admin.query(
      `INSERT INTO "conversation_turn"(
         id, session_id, seq, client_turn_id, kind, content, status, delivered_at, lease_deadline_at
       ) VALUES (
         $1::uuid, $2::uuid, 2, 'typed-while-the-job-ran', 'message', 'refactor the parser',
         'IN_FLIGHT', clock_timestamp(),
         clock_timestamp() + CASE WHEN $3 THEN interval '2 minutes' ELSE interval '-1 minute' END
       )`,
      [RUNNING_TURN_ID, SESSION_ID, running === 'live'],
    );
  }
  eventSeq = 0;
}

/** One job's exit, as runner-go reports it. */
function exitWake(jobId: string, over: Partial<BackgroundWakeDto> = {}): BackgroundWakeDto {
  return {
    wakeId: `${jobId}:exit`,
    jobId,
    trigger: 'exit',
    kind: 'build',
    command: 'npm run build',
    description: 'the release build',
    status: 'failed',
    exitCode: 2,
    outputPath: `/root/.orbit/runs/${jobId}.output`,
    outputOffset: 0,
    outputSize: 4096,
    outputExcerpt: 'make: *** [build] Error 2',
    ...over,
  } as BackgroundWakeDto;
}

/** The n-th wake a job's new output sent, each picking up where the one before it ended. */
function outputWake(jobId: string, n: number): BackgroundWakeDto {
  return exitWake(jobId, {
    wakeId: `${jobId}:output:${n}`,
    trigger: 'output',
    status: 'running',
    exitCode: undefined,
    outputOffset: (n - 1) * 100,
    outputSize: n * 100,
    outputExcerpt: `step ${n}/9`,
  });
}

const fileWake = (dto: BackgroundWakeDto) => runnerApi.backgroundWake(RUNNER, SESSION_ID, dto);

interface TurnRow {
  id: string;
  seq: number;
  kind: string;
  status: string;
  sendIntent: string | null;
  targetTurnId: string | null;
  clientTurnId: string;
  content: string | null;
}

const TURN_COLUMNS = `id, seq, kind, status, send_intent AS "sendIntent", target_turn_id AS "targetTurnId",
  client_turn_id AS "clientTurnId", content`;

async function turn(turnId: string): Promise<TurnRow> {
  const { rows } = await admin.query<TurnRow>(
    `SELECT ${TURN_COLUMNS} FROM "conversation_turn" WHERE id = $1::uuid`,
    [turnId],
  );
  assert.equal(rows.length, 1, `turn ${turnId} is gone`);
  return rows[0];
}

/** Every wake turn of the session, in queue order. */
async function wakeTurns(): Promise<TurnRow[]> {
  const { rows } = await admin.query<TurnRow>(
    `SELECT ${TURN_COLUMNS} FROM "conversation_turn"
      WHERE session_id = $1::uuid AND client_turn_id LIKE 'bg-wake:%' ORDER BY seq`,
    [SESSION_ID],
  );
  return rows;
}

/** The jobs filed on a wake turn, and what woke each. */
async function jobsOn(clientTurnId: string): Promise<Array<{ jobId: string; trigger: string }>> {
  const { rows } = await admin.query<{ jobId: string; trigger: string }>(
    `SELECT job_id AS "jobId", trigger FROM "background_job_wake"
      WHERE session_id = $1::uuid AND client_turn_id = $2 ORDER BY job_id`,
    [SESSION_ID, clientTurnId],
  );
  return rows;
}

async function sessionStatus(): Promise<string> {
  const { rows } = await admin.query<{ status: string }>(
    `SELECT status FROM "session" WHERE id = $1::uuid`,
    [SESSION_ID],
  );
  return rows[0].status;
}

interface Delivered {
  turnId: string;
  kind: string;
  content?: string;
  targetTurnId?: string;
  steerRequeue?: boolean;
}

/** One poll of the inbox by a runner that takes steers and declared routing-v1. */
function take(): Promise<Delivered | null> {
  return (runnerApi as unknown as {
    dequeueTurn: (
      sessionId: string,
      runnerId: string,
      leaseGeneration: null,
      acceptsSteer: boolean,
      declaredCapabilities: readonly string[],
    ) => Promise<Delivered | null>;
  }).dequeueTurn(SESSION_ID, RUNNER_ID, null, true, ROUTING);
}

/** The engine's reply under a turn: what makes its completion ANSWER it rather than hand it back. */
async function answer(turnId: string): Promise<void> {
  eventSeq += 1;
  await admin.query(
    `INSERT INTO "run_event"(id, session_id, seq, type, payload, turn_id)
     VALUES (gen_random_uuid(), $1::uuid, $2, 'assistant', $3::jsonb, $4::uuid)`,
    [SESSION_ID, eventSeq, JSON.stringify({ text: 'the parser is refactored' }), turnId],
  );
}

function complete(turnId: string, subtype = 'completed') {
  return runnerApi.turnComplete({ id: RUNNER_ID }, SESSION_ID, {
    turnId,
    status: 'SUCCEEDED',
    subtype,
    numTurns: 1,
    costUsd: 0,
  } as never);
}

async function listedActive(): Promise<Array<{
  turnId: string;
  placement: string;
  targetTurnId?: string;
  content: string;
}>> {
  return (await sessions.listQueuedTurns(OWNER_ID, SESSION_ID, 'active')) as never;
}

scenario('(a) a job that exits while a Claude turn runs is a CURRENT_WORK steer aimed at that turn', async () => {
  await seed();
  const receipt = await fileWake(exitWake('bgj_a00000000001'));
  assert.equal(receipt.outcome, 'ENQUEUED');
  const steer = await turn(receipt.turnId!);
  assert.deepEqual(
    {
      kind: steer.kind,
      sendIntent: steer.sendIntent,
      targetTurnId: steer.targetTurnId,
      status: steer.status,
      clientTurnId: steer.clientTurnId,
      content: steer.content,
    },
    {
      kind: 'steer',
      sendIntent: 'CURRENT_WORK',
      targetTurnId: RUNNING_TURN_ID,
      status: 'PENDING',
      clientTurnId: 'bg-wake:bgj_a00000000001:exit',
      // Nobody's words, as for every wake: the block is written in at delivery.
      content: '',
    },
  );
  assert.deepEqual(await jobsOn(steer.clientTurnId), [{ jobId: 'bgj_a00000000001', trigger: 'exit' }]);
  // It opened no turn: the session is still running the one it was running.
  assert.equal(await sessionStatus(), 'RUNNING');
  assert.equal((await turn(RUNNING_TURN_ID)).status, 'IN_FLIGHT');

  // Listed as a steer, with the block the runner will be handed, and not withdrawable: it is on its
  // way into the running turn, and the refusal takes nothing of it along.
  const listed = (await listedActive()).find((row) => row.turnId === steer.id);
  assert.ok(listed, 'the steered wake is not listed');
  assert.equal(listed.placement, 'steer');
  assert.equal(listed.targetTurnId, RUNNING_TURN_ID);
  assert.ok(listed.content.includes('<background-job-wake>') && listed.content.includes(STEER_HEAD), listed.content);
  await assert.rejects(sessions.cancelQueuedTurn(OWNER_ID, SESSION_ID, steer.id), ConflictException);
  assert.deepEqual(await jobsOn(steer.clientTurnId), [{ jobId: 'bgj_a00000000001', trigger: 'exit' }]);

  // Another exit while it still waits for the runner joins it; a retry of the first is answered from
  // its receipt rather than refused for the route it took.
  const second = await fileWake(exitWake('bgj_a00000000002', { status: 'completed', exitCode: 0 }));
  assert.equal(second.outcome, 'MERGED');
  assert.equal(second.turnId, steer.id);
  const retried = await fileWake(exitWake('bgj_a00000000001'));
  assert.equal(retried.turnId, steer.id);
  assert.equal((await wakeTurns()).length, 1, 'wakes the runner has not taken became more than one turn');

  // Once the runner has taken it, nothing more is folded into it: the next exit is a steer of its own.
  const taken = await take();
  assert.equal(taken?.turnId, steer.id);
  const third = await fileWake(exitWake('bgj_a00000000003'));
  assert.equal(third.outcome, 'ENQUEUED');
  assert.notEqual(third.turnId, steer.id);
  const next = await turn(third.turnId!);
  assert.equal(next.kind, 'steer');
  assert.equal(next.targetTurnId, RUNNING_TURN_ID);
  assert.deepEqual(await jobsOn(steer.clientTurnId), [
    { jobId: 'bgj_a00000000001', trigger: 'exit' },
    { jobId: 'bgj_a00000000002', trigger: 'exit' },
  ]);
});

scenario('(b) with no live turn, on kimi, or behind a runner without routing-v1, an exit waits for the next turn as before', async () => {
  const cases: Array<[string, Seed]> = [
    ['no turn running', { running: false }],
    ['a turn whose lease has expired', { running: 'expired' }],
    ['a kimi session', { provider: 'kimi' }],
    ['a runner that never declared routing-v1', { capabilities: [] }],
  ];
  for (const [how, setup] of cases) {
    await seed(setup);
    const first = await fileWake(exitWake('bgj_b00000000001'));
    assert.equal(first.outcome, 'ENQUEUED', how);
    const queued = await turn(first.turnId!);
    assert.deepEqual(
      {
        kind: queued.kind,
        sendIntent: queued.sendIntent,
        targetTurnId: queued.targetTurnId,
        status: queued.status,
        clientTurnId: queued.clientTurnId,
        content: queued.content,
      },
      {
        kind: 'message',
        sendIntent: 'NEXT_TURN',
        targetTurnId: null,
        status: 'PENDING',
        clientTurnId: 'bg-wake:bgj_b00000000001:exit',
        content: '',
      },
      how,
    );
    const second = await fileWake(exitWake('bgj_b00000000002', { status: 'completed', exitCode: 0 }));
    assert.equal(second.outcome, 'MERGED', how);
    assert.equal(second.turnId, queued.id, how);
    assert.equal((await wakeTurns()).length, 1, how);
    const listed = (await listedActive()).find((row) => row.turnId === queued.id);
    assert.equal(listed?.placement, 'queued', how);
  }

  // Delivered as the turn the control plane opened for it, in the words it has always used.
  await seed({ running: false });
  const filed = await fileWake(exitWake('bgj_b00000000003'));
  assert.equal(await sessionStatus(), 'PENDING', 'the wake did not ask for a runner slot');
  await admin.query(`UPDATE "session" SET status = 'RUNNING' WHERE id = $1::uuid`, [SESSION_ID]);
  const delivered = await take();
  assert.equal(delivered?.turnId, filed.turnId);
  assert.equal(delivered?.kind, 'message');
  const content = String(delivered?.content ?? '');
  assert.ok(content.includes('<background-job-wake>') && content.includes(OPENED_HEAD), content);
  assert.ok(!content.includes(STEER_HEAD), content);
});

scenario('(c) output wakes wait for the next turn even while one runs, join each other, and never a steer', async () => {
  await seed();
  const first = await fileWake(outputWake('bgj_c00000000001', 1));
  assert.equal(first.outcome, 'ENQUEUED');
  const queued = await turn(first.turnId!);
  assert.equal(queued.kind, 'message');
  assert.equal(queued.sendIntent, 'NEXT_TURN');
  assert.equal(queued.targetTurnId, null);

  const second = await fileWake(outputWake('bgj_c00000000001', 2));
  assert.equal(second.outcome, 'MERGED');
  assert.equal(second.turnId, queued.id);
  assert.equal((await wakeTurns()).length, 1, 'a second output wake opened a turn of its own');
  const { rows } = await admin.query<{ offset: string; size: string; excerpt: string }>(
    `SELECT output_offset::text AS offset, output_size::text AS size, output_excerpt AS excerpt
       FROM "background_job_wake" WHERE session_id = $1::uuid AND client_turn_id = $2`,
    [SESSION_ID, queued.clientTurnId],
  );
  // The later wake says how the job stands now; what the session has not read starts where it did.
  assert.deepEqual(rows, [{ offset: '0', size: '200', excerpt: 'step 2/9' }]);

  // The two routes never join each other's turn. The same job's exit goes into the running turn as
  // a steer of its own, and the next-turn wake is not folded into it.
  const exit = await fileWake(exitWake('bgj_c00000000001'));
  assert.equal(exit.outcome, 'ENQUEUED');
  const steer = await turn(exit.turnId!);
  assert.equal(steer.kind, 'steer');
  assert.equal(steer.targetTurnId, RUNNING_TURN_ID);
  // ...and a later output wake joins the next-turn wake, not the steer waiting beside it.
  const third = await fileWake(outputWake('bgj_c00000000002', 1));
  assert.equal(third.outcome, 'MERGED');
  assert.equal(third.turnId, queued.id);
  assert.deepEqual(await jobsOn(steer.clientTurnId), [{ jobId: 'bgj_c00000000001', trigger: 'exit' }]);
  assert.deepEqual(await jobsOn(queued.clientTurnId), [
    { jobId: 'bgj_c00000000001', trigger: 'output' },
    { jobId: 'bgj_c00000000002', trigger: 'output' },
  ]);
});

scenario('(d) a steer its turn finished without reading is a deliverable wake turn again', async () => {
  await seed();
  const filed = await fileWake(exitWake('bgj_d00000000001'));
  const steerId = filed.turnId!;
  assert.equal((await turn(steerId)).kind, 'steer', 'the exit was not written into the running turn');

  await answer(RUNNING_TURN_ID);
  await complete(RUNNING_TURN_ID);
  assert.equal((await turn(RUNNING_TURN_ID)).status, 'ANSWERED');

  const requeued = await turn(steerId);
  assert.deepEqual(
    {
      kind: requeued.kind,
      sendIntent: requeued.sendIntent,
      targetTurnId: requeued.targetTurnId,
      status: requeued.status,
      clientTurnId: requeued.clientTurnId,
    },
    {
      kind: 'message',
      sendIntent: 'NEXT_TURN',
      targetTurnId: null,
      status: 'PENDING',
      // Still a wake turn, still carrying its wake: that is what makes it deliverable with its block.
      clientTurnId: 'bg-wake:bgj_d00000000001:exit',
    },
  );
  assert.deepEqual(await jobsOn(requeued.clientTurnId), [{ jobId: 'bgj_d00000000001', trigger: 'exit' }]);
  // The slot passed to it rather than the session parking with a wake queued behind nothing.
  assert.equal(await sessionStatus(), 'RUNNING');
  assert.equal((await listedActive()).find((row) => row.turnId === steerId)?.placement, 'queued');

  const delivered = await take();
  assert.equal(delivered?.turnId, steerId);
  assert.equal(delivered?.kind, 'message');
  const content = String(delivered?.content ?? '');
  for (const fact of ['<background-job-wake>', 'bgj_d00000000001', 'exit code 2', OPENED_HEAD]) {
    assert.ok(content.includes(fact), `the requeued wake does not say ${fact}:\n${content}`);
  }
});

scenario('(d) a missed steer and the wake queued for the next turn are one turn, at the target\'s completion', async () => {
  await seed();
  // The build's output was queued for the next turn; then the build exited while the turn ran and
  // was steered into it; then the deploy's output joined the queued wake.
  const queued = await fileWake(outputWake('bgj_d10000000001', 1));
  const steered = await fileWake(exitWake('bgj_d10000000001', { outputOffset: 100, outputSize: 400 }));
  const joined = await fileWake(outputWake('bgj_d10000000002', 1));
  assert.equal(joined.turnId, queued.turnId);
  assert.notEqual(steered.turnId, queued.turnId);
  assert.equal((await turn(steered.turnId!)).kind, 'steer');

  await answer(RUNNING_TURN_ID);
  await complete(RUNNING_TURN_ID);

  const left = await wakeTurns();
  assert.deepEqual(left.map((row) => [row.id, row.kind, row.status]), [[steered.turnId, 'message', 'PENDING']],
    'the missed steer and the queued wake would each open a turn');
  const kept = left[0];
  assert.deepEqual(await jobsOn(kept.clientTurnId), [
    { jobId: 'bgj_d10000000001', trigger: 'exit' },
    { jobId: 'bgj_d10000000002', trigger: 'output' },
  ]);
  // The build's output was never read, so what the wake covers still starts where its first wake did.
  const { rows } = await admin.query<{ offset: string }>(
    `SELECT output_offset::text AS offset FROM "background_job_wake"
      WHERE session_id = $1::uuid AND client_turn_id = $2 AND job_id = 'bgj_d10000000001'`,
    [SESSION_ID, kept.clientTurnId],
  );
  assert.deepEqual(rows, [{ offset: '0' }]);

  const delivered = await take();
  assert.equal(delivered?.turnId, steered.turnId);
  const content = String(delivered?.content ?? '');
  for (const fact of ['<background-job-wake>', 'bgj_d10000000001', 'exit code 2', 'bgj_d10000000002', 'step 1/9']) {
    assert.ok(content.includes(fact), `the one wake turn does not say ${fact}:\n${content}`);
  }
  const { rows: pending } = await admin.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM "conversation_turn"
      WHERE session_id = $1::uuid AND kind IN ('message', 'shell', 'steer') AND status = 'PENDING'`,
    [SESSION_ID],
  );
  assert.equal(pending[0].n, '0', 'a second turn is still queued behind the wake');
});

scenario('(d) a steer the runner hands back unread takes the queued wake with it', async () => {
  await seed();
  const steered = await fileWake(exitWake('bgj_d20000000001'));
  const taken = await take();
  assert.equal(taken?.turnId, steered.turnId);
  assert.equal(taken?.kind, 'steer');
  assert.equal(taken?.steerRequeue, true);
  // Queued for the next turn while the steer is out with the runner.
  const queued = await fileWake(outputWake('bgj_d20000000002', 1));
  assert.notEqual(queued.turnId, steered.turnId);

  // The runner proves the engine never read it (steer_requeue): the same row, an ordinary wake turn.
  await complete(steered.turnId!, 'steer_requeue');
  const left = await wakeTurns();
  assert.deepEqual(left.map((row) => [row.id, row.kind, row.sendIntent, row.status]), [
    [steered.turnId, 'message', 'NEXT_TURN', 'PENDING'],
  ]);
  assert.deepEqual(await jobsOn(left[0].clientTurnId), [
    { jobId: 'bgj_d20000000001', trigger: 'exit' },
    { jobId: 'bgj_d20000000002', trigger: 'output' },
  ]);

  await answer(RUNNING_TURN_ID);
  await complete(RUNNING_TURN_ID);
  const delivered = await take();
  assert.equal(delivered?.turnId, steered.turnId);
  const content = String(delivered?.content ?? '');
  for (const fact of ['<background-job-wake>', 'bgj_d20000000001', 'bgj_d20000000002', OPENED_HEAD]) {
    assert.ok(content.includes(fact), `the requeued wake does not say ${fact}:\n${content}`);
  }
});

scenario('(e) the runner takes the steer with the wake written into it, and its echo is the control plane\'s note', async () => {
  await seed();
  const job = 'bgj_e00000000001';
  const filed = await fileWake(exitWake(job, { exitCode: 3, outputExcerpt: 'FAIL src/widget.test.ts' }));
  const listed = (await listedActive()).find((row) => row.turnId === filed.turnId);

  const delivered = await take();
  assert.equal(delivered?.turnId, filed.turnId);
  assert.equal(delivered?.kind, 'steer');
  assert.equal(delivered?.targetTurnId, RUNNING_TURN_ID);
  const content = String(delivered?.content ?? '');
  for (const fact of ['<background-job-wake>', job, 'exit code 3', `/root/.orbit/runs/${job}.output`,
    'FAIL src/widget.test.ts', STEER_HEAD]) {
    assert.ok(content.includes(fact), `the steer does not say ${fact}:\n${content}`);
  }
  assert.ok(!content.includes(OPENED_HEAD), `a steer says a turn was opened for it:\n${content}`);
  // The block shown while it waited is the block the runner was handed.
  assert.equal(content, listed?.content);

  // The runner echoes what it wrote into the turn as the steer's `user` event: stored with the whole
  // block as the control plane's note, which is what the clients draw the wake line from.
  eventSeq += 1;
  await runnerApi.events({ id: RUNNER_ID }, SESSION_ID, {
    events: [{
      seq: eventSeq,
      type: 'user',
      ts: new Date().toISOString(),
      turnId: delivered!.turnId,
      payload: { text: content, steer: true, delivery: 'enqueued' },
    }],
  } as never);
  const { rows } = await admin.query<{ payload: { text?: string; steer?: boolean; controlPlaneNote?: string } }>(
    `SELECT payload FROM "run_event" WHERE session_id = $1::uuid AND type = 'user' AND turn_id = $2::uuid`,
    [SESSION_ID, delivered!.turnId],
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].payload.steer, true);
  assert.equal(rows[0].payload.controlPlaneNote, content, 'the wake was stored as words somebody wrote');
});
