import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import * as nodeModule from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { Client } from 'pg';
import { RunEventType } from '@orbit/shared';
import { prismaClientFor } from '../prisma/prisma-client';
import { SessionsService } from './sessions.service';
import { AutoRetryService } from './auto-retry.service';
import { RunnerApiController } from '../runner-api/runner-api.controller';
import { BackgroundWakeDto } from '../runner-api/background-job-wake';
import { ScheduledWakeupDto } from '../runner-api/scheduled-wakeup';
import { ScheduledWakeupWorker } from '../runner-api/scheduled-wakeup.worker';

/**
 * The queued state of a wake turn, against the real application schema.
 *
 * A turn the control plane opens to wake a session — a `bg_run` job with the news its agent was
 * waiting for, a `schedule_wakeup` coming due — used to be filtered out of `GET /sessions/:id/turns`
 * outright, so the queued card both clients draw for it (web `WorkspaceView`'s queued tail,
 * `ConsoleView`'s `.queued` branch) could never be fed: the row was hidden, and the block it
 * delivers was written only inside the claim transaction.
 *
 * It is listed now, carrying the block that same claim will hand the runner — built there by the
 * very functions delivery calls, over rows written in the same transaction as the turn, so a wake
 * has one rendering and not two that can drift.
 *
 * What the old filter's comment protected is the other half of this file: the wake is still nobody's
 * words. Its `content` column stays empty, so it reaches neither the session list's preview nor
 * auto-retry's re-send — and the last case holds it to that, because a fix that wrote the block into
 * the column would pass every positive case here and quietly break both.
 */
const PG_URL = process.env.COORDINATOR_PG_URL;

const OWNER_ID = '61111111-1111-4111-8111-111111111111';
const RUNNER_ID = '62222222-2222-4222-8222-222222222222';
const SESSION_ID = '63333333-3333-4333-8333-333333333333';
const SEED_TURN_ID = '64444444-4444-4444-8444-444444444444';
const TYPED_TURN_ID = '65555555-5555-4555-8555-555555555555';
const BARE_WAKE_TURN_ID = '66666666-6666-4666-8666-666666666666';

const JOB_ID = 'bgj_0123456789ab';
const SECOND_JOB_ID = 'bgj_cba987654321';
const OUTPUT_TAIL = 'make: *** [build] Error 2\n  see build.log';
const TYPED_MESSAGE = 'please rerun the build when it finishes';

// ── the browser's own reading of the block ───────────────────────────────────────────────────────
// Loaded from `src/web/src/lib/backgroundWake.ts` itself rather than restated here: what has to be
// true is that the BROWSER can read a job out of the field this endpoint returns, and a copy of the
// parser living in this file would only answer a question about the copy. The module is
// self-contained — no imports, no DOM — so stripping its types (node:module, no compiler in this
// workspace to ask) and importing the result is the whole bridge. Not finding it is RED and never a
// skip: a parity check that cannot reach its peer has proven nothing at all.

interface WebWakeJob {
  id: string;
  kind: string;
  command: string;
  description: string | null;
  status: string;
  ended: boolean;
  exitCode: number | null;
  killReason: string | null;
  outputPath: string | null;
  outputFrom: number | null;
  outputTo: number | null;
  outputTail: string;
}

interface WebWakeup {
  askedAt: string | null;
  delaySeconds: number | null;
  dueAt: string | null;
  reason: string | null;
  prompt: string;
}

interface WebWake {
  jobs: WebWakeJob[];
  wakeups: WebWakeup[];
  text: string;
  rest: string;
}

type ParseBackgroundWake = (note: string | null | undefined) => WebWake | null;

const WEB_PARSER = path.resolve(__dirname, '../../../web/src/lib/backgroundWake.ts');

/** `node:module.stripTypeScriptTypes`, which @types/node does not declare yet. */
const stripTypeScriptTypes = (nodeModule as unknown as {
  stripTypeScriptTypes: (code: string, options: { mode: 'strip' }) => string;
}).stripTypeScriptTypes;

let stripped: string | undefined;

async function loadWebParser(): Promise<ParseBackgroundWake> {
  assert.ok(
    existsSync(WEB_PARSER),
    `${WEB_PARSER} was not found: this spec proves the browser can read what the endpoint returns, `
      + 'and it cannot do that against a parser that has moved or been deleted.',
  );
  stripped = path.join(mkdtempSync(path.join(os.tmpdir(), 'orbit-web-wake-')), 'backgroundWake.mjs');
  writeFileSync(stripped, stripTypeScriptTypes(readFileSync(WEB_PARSER, 'utf8'), { mode: 'strip' }));
  const loaded = await import(pathToFileURL(stripped).href) as Record<string, unknown>;
  assert.equal(
    typeof loaded.parseBackgroundWake,
    'function',
    `${WEB_PARSER} exports no parseBackgroundWake`,
  );
  return loaded.parseBackgroundWake as ParseBackgroundWake;
}

let parseBackgroundWake: ParseBackgroundWake;

let admin: Client;
let prisma: ReturnType<typeof prismaClientFor>;
/** Every session the realtime service was told to refresh the queue of, in order. */
let queueRefreshed: string[] = [];
let sessions: SessionsService;
let runnerApi: RunnerApiController;
let wakeupWorker: ScheduledWakeupWorker;
let autoRetry: AutoRetryService;

const RUNNER = { id: RUNNER_ID, ownerId: OWNER_ID };

/** Every case needs the database; without it each one reports SKIP, which run-pg-spec.sh calls RED. */
function scenario(name: string, body: () => Promise<void>): void {
  test(name, { skip: PG_URL ? false : 'set COORDINATOR_PG_URL to run the queued wake suite' }, body);
}

before(async () => {
  if (!PG_URL) return;
  parseBackgroundWake = await loadWebParser();
  admin = new Client({ connectionString: PG_URL });
  await admin.connect();
  prisma = prismaClientFor(PG_URL);
  await prisma.$connect();
  await admin.query(`DELETE FROM "session" WHERE owner_id = $1::uuid`, [OWNER_ID]);
  await admin.query(`DELETE FROM "runner" WHERE owner_id = $1::uuid`, [OWNER_ID]);
  await admin.query(`DELETE FROM "user" WHERE id = $1::uuid`, [OWNER_ID]);
  await admin.query(
    `INSERT INTO "user"(id, email, name, password_hash)
     VALUES ($1::uuid, 'background-wake-queue@example.test', 'wake', 'test')`,
    [OWNER_ID],
  );
  await admin.query(
    `INSERT INTO "runner"(id, name, owner_id, token_hash, status, last_heartbeat_at)
     VALUES ($1::uuid, 'background-wake-queue', $2::uuid, 'test', 'ONLINE', clock_timestamp())`,
    [RUNNER_ID, OWNER_ID],
  );
  const realtime = {
    notifyInbox: () => undefined,
    publish: () => undefined,
    publishSessionUpdated: () => undefined,
    publishQueuedTurnsChanged: (sessionId: string) => queueRefreshed.push(sessionId),
  };
  const queue = { notifySessionQueued: () => undefined };
  sessions = new SessionsService(prisma as never, queue as never, realtime as never);
  runnerApi = new RunnerApiController(
    prisma as never,
    queue as never,
    realtime as never,
    {} as never,
    {} as never,
    { expand: async (_ownerId: string, content?: string) => content } as never,
    { appendFor: async (_tx: unknown, _sessionId: string, content?: string) => content } as never,
    undefined,
    undefined,
    undefined,
    undefined,
    sessions,
  );
  wakeupWorker = new ScheduledWakeupWorker(prisma as never, sessions);
  autoRetry = new AutoRetryService(prisma as never, sessions, realtime as never);
});

after(async () => {
  try {
    if (admin) {
      await admin.query(`DELETE FROM "session" WHERE owner_id = $1::uuid`, [OWNER_ID]);
      await admin.query(`DELETE FROM "runner" WHERE owner_id = $1::uuid`, [OWNER_ID]);
      await admin.query(`DELETE FROM "user" WHERE id = $1::uuid`, [OWNER_ID]);
    }
  } finally {
    if (stripped) rmSync(path.dirname(stripped), { recursive: true, force: true });
    await prisma?.$disconnect();
    await admin?.end();
  }
});

/**
 * A session that has already run a turn and is now waiting — the state a wake actually arrives in.
 * Its opening prompt turn is DONE, so nothing of it remains in the queue snapshot.
 */
async function seedIdleSession(): Promise<void> {
  await admin.query(`DELETE FROM "session" WHERE id = $1::uuid`, [SESSION_ID]);
  await admin.query(
    `INSERT INTO "session"(
       id, title, prompt, owner_id, creator_id, assigned_runner_id, provider,
       provider_builtin, status, num_turns, updated_at
     ) VALUES (
       $1::uuid, 'wake', 'opening prompt', $2::uuid, $2::uuid, $3::uuid, 'claude',
       TRUE, 'AWAITING_INPUT', 1, clock_timestamp()
     )`,
    [SESSION_ID, OWNER_ID, RUNNER_ID],
  );
  await admin.query(
    `INSERT INTO "conversation_turn"(id, session_id, seq, client_turn_id, kind, content, status)
     VALUES ($1::uuid, $2::uuid, 1, $3, 'message', 'opening prompt', 'DONE')`,
    [SEED_TURN_ID, SESSION_ID, SessionsService.initialTurnClientId(SESSION_ID)],
  );
  queueRefreshed = [];
}

/** One job's wake, as runner-go reports it. */
function wakeOf(jobId: string, over: Partial<BackgroundWakeDto> = {}): BackgroundWakeDto {
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
    outputExcerpt: OUTPUT_TAIL,
    ...over,
  } as BackgroundWakeDto;
}

/** File one job's wake through the runner door that files them. */
function fileWake(jobId: string, over: Partial<BackgroundWakeDto> = {}) {
  return runnerApi.backgroundWake(RUNNER, SESSION_ID, wakeOf(jobId, over));
}

/** The person types a message into the same session, through the door they type into. */
async function typeMessage(): Promise<string> {
  const receipt = await sessions.createTurn(OWNER_ID, SESSION_ID, {
    clientTurnId: TYPED_TURN_ID,
    content: TYPED_MESSAGE,
    intent: 'NEXT_TURN',
  });
  return receipt.turnId;
}

async function lastUserText(): Promise<string | null> {
  const { rows } = await admin.query<{ last_user_text: string | null }>(
    `SELECT last_user_text FROM "session" WHERE id = $1::uuid`,
    [SESSION_ID],
  );
  return rows[0].last_user_text;
}

async function storedContent(turnId: string): Promise<string | null> {
  const { rows } = await admin.query<{ content: string | null }>(
    `SELECT content FROM "conversation_turn" WHERE id = $1::uuid`,
    [turnId],
  );
  return rows[0].content;
}

/** What auto-retry would re-send for this session, read from the sweeper's own chooser. */
function messageToResend(numTurns: number): Promise<{ content: string }> {
  return (autoRetry as unknown as {
    messageToResend: (
      sessionId: string,
      prompt: string,
      numTurns: number,
    ) => Promise<{ content: string }>;
  }).messageToResend(SESSION_ID, 'opening prompt', numTurns);
}

scenario('a queued background-job wake is listed, with the block the browser reads it from', async () => {
  await seedIdleSession();

  const receipt = await fileWake(JOB_ID);
  assert.equal(receipt.outcome, 'ENQUEUED');
  const turnId = receipt.turnId!;

  // Web's view. `queued`, never `accepted`: an accepted row is represented as the person's own
  // message bridged into the transcript (queuedTurnFromActiveSnapshot), which a wake is not.
  const active = await sessions.listQueuedTurns(OWNER_ID, SESSION_ID, 'active');
  assert.deepEqual(active.map((turn) => turn.turnId), [turnId], 'the queued wake is in the active view');
  assert.equal(active[0].placement, 'queued');

  // The installed native client's view, which has no placement to reason about at all.
  const queueOnly = await sessions.listQueuedTurns(OWNER_ID, SESSION_ID);
  assert.deepEqual(queueOnly.map((turn) => turn.turnId), [turnId], 'and in the queue-only view');
  assert.equal(queueOnly[0].content, active[0].content, 'both views say the same thing');

  const wake = parseBackgroundWake(active[0].content);
  assert.ok(wake, 'the browser reads a wake out of the listed content');
  assert.deepEqual(wake.jobs.map((job) => job.id), [JOB_ID]);
  assert.equal(wake.jobs[0].status, 'failed');
  assert.equal(wake.jobs[0].ended, true);
  assert.equal(wake.jobs[0].exitCode, 2);
  assert.equal(wake.jobs[0].command, 'npm run build');
  assert.equal(wake.jobs[0].description, 'the release build');
  assert.equal(wake.jobs[0].outputTail, OUTPUT_TAIL);
  assert.equal(wake.jobs[0].outputTo, 4096);
});

scenario('a wakeup that came due onto the same turn is listed with it', async () => {
  await seedIdleSession();
  await fileWake(JOB_ID);

  // Held by the control plane, then delivered onto the wake turn already waiting — through the
  // worker's own path rather than a hand-written row.
  await runnerApi.scheduledWakeup(RUNNER, SESSION_ID, {
    delaySeconds: 60,
    reason: 'watching the build',
    prompt: 'read the tail and decide',
  } as ScheduledWakeupDto);
  const { rows } = await admin.query<{ id: string }>(
    `UPDATE "session_scheduled_wakeup" SET due_at = clock_timestamp() - interval '1 second'
     WHERE session_id = $1::uuid AND state = 'PENDING' RETURNING id`,
    [SESSION_ID],
  );
  assert.equal(await wakeupWorker.deliver(rows[0].id, SESSION_ID, OWNER_ID), 'DELIVERED');

  const listed = await sessions.listQueuedTurns(OWNER_ID, SESSION_ID, 'active');
  assert.equal(listed.length, 1, 'the wakeup joined the turn already queued rather than opening one');
  const wake = parseBackgroundWake(listed[0].content);
  assert.ok(wake, 'the browser reads the pair out of the listed content');
  assert.deepEqual(wake.jobs.map((job) => job.id), [JOB_ID]);
  assert.equal(wake.wakeups.length, 1);
  assert.equal(wake.wakeups[0].reason, 'watching the build');
  assert.equal(wake.wakeups[0].prompt, 'read the tail and decide');
  assert.equal(wake.wakeups[0].delaySeconds, 60);
});

scenario('the block shown queued is the block the runner is handed', async () => {
  await seedIdleSession();
  await fileWake(JOB_ID);
  const queued = (await sessions.listQueuedTurns(OWNER_ID, SESSION_ID, 'active'))[0];

  // Filing the wake left the session PENDING — waiting for a runner slot. What happens next in
  // production is the queue's claim, which is the only thing that makes an executable turn
  // deliverable at all (`active.status = 'RUNNING'` in the inbox predicate); stand in for it here,
  // since what this case is about is the content the claim then builds.
  await admin.query(
    `UPDATE "session" SET status = 'RUNNING' WHERE id = $1::uuid`,
    [SESSION_ID],
  );
  const delivered = await (runnerApi as unknown as {
    dequeueTurn: (
      sessionId: string,
      runnerId: string,
      leaseGeneration: null,
    ) => Promise<{ turnId: string; content?: string } | null>;
  }).dequeueTurn(SESSION_ID, RUNNER_ID, null);
  assert.ok(delivered, 'the runner claimed the wake turn');
  assert.equal(delivered.turnId, queued.turnId);
  // Not "both look like a wake block": the same bytes. Two renderings of one wake is the drift
  // reading from delivery's own functions exists to avoid.
  assert.equal(delivered.content, queued.content);
});

scenario('a wake never takes the accepted head, and never gives it away either', async () => {
  // The wake arrives first and the person types behind it. The wake is queued, and the message
  // behind it stays queued: it did not inherit an `accepted` place the wake vacated.
  await seedIdleSession();
  const wakeFirst = (await fileWake(JOB_ID)).turnId!;
  const typedSecond = await typeMessage();
  const behind = await sessions.listQueuedTurns(OWNER_ID, SESSION_ID, 'active');
  assert.deepEqual(
    behind.map((turn) => [turn.turnId, turn.placement]),
    [[wakeFirst, 'queued'], [typedSecond, 'queued']],
  );

  // The person typed first. Their message is still the accepted head — the wake behind it changed
  // nothing about where the runner's attention is.
  await seedIdleSession();
  const typedFirst = await typeMessage();
  const wakeSecond = (await fileWake(JOB_ID)).turnId!;
  const ahead = await sessions.listQueuedTurns(OWNER_ID, SESSION_ID, 'active');
  assert.deepEqual(
    ahead.map((turn) => [turn.turnId, turn.placement]),
    [[typedFirst, 'accepted'], [wakeSecond, 'queued']],
  );
  // And the queue-only view drops the accepted head, as it always has, while keeping the wake.
  assert.deepEqual(
    (await sessions.listQueuedTurns(OWNER_ID, SESSION_ID)).map((turn) => turn.turnId),
    [wakeSecond],
  );
});

scenario('a wake already leased is not listed: the transcript is what shows it', async () => {
  await seedIdleSession();
  const turnId = (await fileWake(JOB_ID)).turnId!;
  await admin.query(
    `UPDATE "conversation_turn" SET status = 'IN_FLIGHT' WHERE id = $1::uuid`,
    [turnId],
  );

  assert.deepEqual(await sessions.listQueuedTurns(OWNER_ID, SESSION_ID, 'active'), []);
  assert.deepEqual(await sessions.listQueuedTurns(OWNER_ID, SESSION_ID), []);
});

scenario('a wake turn with nothing filed on it is not listed at all', async () => {
  await seedIdleSession();
  // The empty bubble the old blanket filter existed to avoid: a `bg-wake:` row carrying no wakes
  // has nothing to say, so it is still no row at all.
  await admin.query(
    `INSERT INTO "conversation_turn"(id, session_id, seq, client_turn_id, kind, content, status)
     VALUES ($1::uuid, $2::uuid, 2, $3, 'message', '', 'PENDING')`,
    [BARE_WAKE_TURN_ID, SESSION_ID, `bg-wake:${JOB_ID}:exit`],
  );

  assert.deepEqual(await sessions.listQueuedTurns(OWNER_ID, SESSION_ID, 'active'), []);
  assert.deepEqual(await sessions.listQueuedTurns(OWNER_ID, SESSION_ID), []);
});

scenario('a second job joining a queued wake tells focused clients the queue moved', async () => {
  await seedIdleSession();
  const turnId = (await fileWake(JOB_ID)).turnId!;
  queueRefreshed = [];

  const joined = await fileWake(SECOND_JOB_ID, { status: 'completed', exitCode: 0 });
  assert.equal(joined.outcome, 'MERGED');
  assert.equal(joined.turnId, turnId, 'no second turn was opened');
  // Without this the card would sit at one job until something unrelated nudged the client.
  assert.deepEqual(queueRefreshed, [SESSION_ID]);

  const wake = parseBackgroundWake(
    (await sessions.listQueuedTurns(OWNER_ID, SESSION_ID, 'active'))[0].content,
  );
  assert.ok(wake);
  assert.deepEqual([...wake.jobs.map((job) => job.id)].sort(), [JOB_ID, SECOND_JOB_ID].sort());
});

// ── the control: it is listed, and it is still nobody's words ────────────────────────────────────

scenario("the listed wake is not the person's words: not the column, the preview, or a re-send", async () => {
  await seedIdleSession();
  const typedTurnId = await typeMessage();
  assert.equal(await lastUserText(), TYPED_MESSAGE, "the person's message is what the list previews");

  // The durable receipt of that message, so auto-retry has something it would re-send.
  await admin.query(
    `INSERT INTO "run_event"(id, session_id, seq, type, payload, turn_id)
     VALUES (gen_random_uuid(), $1::uuid, 1, $2, $3::jsonb, $4::uuid)`,
    [SESSION_ID, RunEventType.USER, JSON.stringify({ text: TYPED_MESSAGE }), typedTurnId],
  );
  assert.equal((await messageToResend(1)).content, TYPED_MESSAGE);

  const wakeTurnId = (await fileWake(JOB_ID)).turnId!;
  const listed = (await sessions.listQueuedTurns(OWNER_ID, SESSION_ID, 'active'))
    .find((turn) => turn.turnId === wakeTurnId);
  assert.ok(listed && parseBackgroundWake(listed.content), 'the wake is listed with its block');

  // The three reads of the person's words, none of which is that list.
  assert.equal(await storedContent(wakeTurnId), '', 'the turn stores none of it');
  assert.equal(await lastUserText(), TYPED_MESSAGE, 'the list still previews what the person said');
  const resent = await messageToResend(2);
  assert.equal(resent.content, TYPED_MESSAGE, "a retry re-sends the person's message");
  assert.ok(
    !resent.content.includes('<background-job-wake>'),
    'and never the block, which nobody typed',
  );
});
