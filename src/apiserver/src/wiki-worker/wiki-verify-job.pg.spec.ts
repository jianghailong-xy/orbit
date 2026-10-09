/**
 * The server's verification (contracts/wiki.contract.json `jobs.kindRuns.verify`, design §2.2 and §8, P3),
 * against a real PostgreSQL and a System model played by a local Node http server:
 *
 *   1. the trigger: an op an Automatic space records `verifying` queues one `verify` job for the session
 *      that proposed it — at the waiting priority — where the executor switch says the server runs for the
 *      account; under the default `runner` mode nothing is queued at all, and so is nothing for a
 *      maintenance run, which verifies its own ops;
 *   2. the job end to end: claimed by the executor, one request per op through the queue, the verdict
 *      recorded through the server's own writer — the entry live, the op applied by the mode, the report
 *      saying what the pass did;
 *   3. a verdict that names a neighbour is mapped from the number the model gave to the entry it stands
 *      for, and an answer that is not a verdict — an id the model copied one character short, the 09-30
 *      failure — is reported as nothing: the op keeps waiting, and nothing of it applies;
 *   4. one queued job covers its session's later ops: two submissions while a job is queued queue one job,
 *      and the one job verifies both.
 *
 *     bash scripts/run-pg-spec.sh src/apiserver/src/wiki-worker/wiki-verify-job.pg.spec.ts
 *
 * Not destructive: it writes only rows under its own account, spaces and sessions, and deletes them
 * afterwards.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { after, afterEach, test } from 'node:test';

import type { PrismaClient } from '@prisma/client';
import { Client } from 'pg';

import { prismaClientFor } from '../prisma/prisma-client';
import { PrismaService } from '../prisma/prisma.service';
import { assertCoordinatorPgUrlIsIsolated, verifyCoordinatorPgIdentity } from '../projects/coordinator-pg-test-safety';
import type { PushService } from '../push/push.service';
import type { RealtimeService } from '../realtime/realtime.service';
import { WikiService, type WikiPrincipal } from '../wiki/wiki.service';
import { WikiJobExecutor, WIKI_JOB_RUNNERS, type WikiJobRunner } from './wiki-job-executor';
import { WikiModelRequestQueue } from './wiki-model-queue.service';
import { WikiModelStatusProbe } from './wiki-model-status';
import { readWikiSystemModel, type WikiSystemModelConfig } from './wiki-system-model';
import { wikiVerifyJobRunner } from './wiki-verify-job';

const URL_ = process.env.COORDINATOR_PG_URL;
const skip = !URL_;

const KEY = `sk-spec-${randomUUID()}`;
const MODEL = 'qwen3-coder-spec';

/** One prompt the fake model was asked. */
interface Hit {
  prompt: string;
}

interface FakeModel {
  base: string;
  /** The answer the next call is given, as a function of the prompt. */
  answer: (hit: Hit) => string;
  hits: Hit[];
  /** Every call's system prompt, so the verifier's own can be read back. */
  systems: string[];
  close: () => Promise<void>;
}

async function fakeModel(): Promise<FakeModel> {
  const sockets = new Set<Socket>();
  const hits: Hit[] = [];
  const systems: string[] = [];
  const state = {
    base: '',
    answer: (): string => '{"verdict": "supported", "reason": "The record says exactly this."}',
    hits,
    systems,
    close: async () => undefined,
  } as FakeModel;
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    let body = '';
    request.on('data', (chunk: Buffer) => {
      body += chunk.toString();
    });
    request.on('end', () => {
      if (request.url === '/health') {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end('{}');
        return;
      }
      let prompt = '';
      let system = '';
      try {
        const parsed = JSON.parse(body) as { messages?: Array<{ content?: string }>; system?: string };
        prompt = parsed.messages?.[0]?.content ?? '';
        system = parsed.system ?? '';
      } catch {
        prompt = '';
      }
      hits.push({ prompt });
      systems.push(system);
      const event = (name: string, data: unknown) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
      const write = (what: string) => {
        try {
          response.write(what);
        } catch {
          /* the call was abandoned */
        }
      };
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      write(event('message_start', { type: 'message_start', message: { model: MODEL, usage: { input_tokens: 3, output_tokens: 1 } } }));
      write(event('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: state.answer({ prompt }) } }));
      write(event('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 12 } }));
      write(event('message_stop', { type: 'message_stop' }));
      try {
        response.end();
      } catch {
        /* the call was abandoned */
      }
    });
  });
  server.on('connection', (socket: Socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  state.base = `http://127.0.0.1:${port}`;
  state.close = async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };
  return state;
}

interface Harness {
  sql: Client;
  prisma: PrismaClient;
  model: FakeModel;
  service: WikiService;
  ownerId: string;
}

/** One space of the spec's own, with the session that proposes into it and the record its ops cite. */
interface Fixture {
  spaceId: string;
  sessionId: string;
  cite: string;
}

let harness: Promise<Harness> | undefined;

function boot(): Promise<Harness> {
  harness ??= (async () => {
    assertCoordinatorPgUrlIsIsolated(URL_);
    const sql = new Client({ connectionString: URL_, connectionTimeoutMillis: 5_000 });
    await sql.connect();
    await verifyCoordinatorPgIdentity(sql);
    const prisma = prismaClientFor(URL_ as string);
    const model = await fakeModel();
    const hub = { publishWikiChanged: () => undefined } as unknown as RealtimeService;
    const push = {
      notifyWikiVerificationTripped: async () => undefined,
      notifyWikiReviewModeTripped: async () => undefined,
    } as unknown as PushService;
    const service = new WikiService(prisma as unknown as PrismaService, hub, push);
    const ownerId = randomUUID();
    await prisma.user.create({ data: { id: ownerId, email: `wiki-verify-job-${ownerId}@wiki.invalid`, name: 'verify job spec', passwordHash: 'x' } });
    return { sql, prisma, model, service, ownerId };
  })();
  return harness;
}

after(async () => {
  if (!harness) return;
  const { prisma, sql, model, ownerId } = await harness;
  delete process.env.ORBIT_WIKI_EXECUTOR;
  delete process.env.ORBIT_WIKI_EXECUTOR_CANARY_OWNERS;
  await prisma.wikiSpace.deleteMany({ where: { ownerId } }).catch(() => undefined);
  await prisma.user.deleteMany({ where: { id: ownerId } }).catch(() => undefined);
  await prisma.session.deleteMany({ where: { ownerId } }).catch(() => undefined);
  await prisma.wikiModelStatus.deleteMany({ where: { id: 1 } }).catch(() => undefined);
  await prisma.$disconnect().catch(() => undefined);
  await sql.end().catch(() => undefined);
  await model.close().catch(() => undefined);
});

function config(h: Harness, concurrency = 2): WikiSystemModelConfig {
  return readWikiSystemModel({
    ORBIT_WIKI_MODEL_BASE_URL: h.model.base,
    ORBIT_WIKI_MODEL_API_KEY: KEY,
    ORBIT_WIKI_MODEL: MODEL,
    ORBIT_WIKI_MODEL_CONCURRENCY: String(concurrency),
  });
}

/** One space of its own per case: the neighbours a draft is offered are the space's entries and no others. */
async function fixture(h: Harness): Promise<Fixture> {
  const spaceId = randomUUID();
  await h.prisma.wikiSpace.create({
    data: {
      id: spaceId, ownerId: h.ownerId, slug: `verify-job-${spaceId.slice(0, 8)}`, title: 'Verify job spec',
      settings: { reviewMode: 'automatic' },
    },
  });
  const sessionId = randomUUID();
  await h.prisma.session.create({
    data: { id: sessionId, title: 'a wiki session', prompt: 'p', ownerId: h.ownerId, creatorId: h.ownerId, dispatchOrigin: 'USER' },
  });
  const cite = randomUUID();
  await h.sql.query(`INSERT INTO "tool_call"("id","session_id","name","output") VALUES ($1,$2,'Bash',$3)`, [
    cite, sessionId, JSON.stringify('The build said: it went wrong.'),
  ]);
  return { spaceId, sessionId, cite };
}

/** The workers this case started; a case that fails halfway must not leave one claiming the next one's jobs. */
const live: Array<{ queue: WikiModelRequestQueue; executor: WikiJobExecutor }> = [];

afterEach(async () => {
  for (const one of live.splice(0)) {
    await one.executor.onModuleDestroy().catch(() => undefined);
    await one.queue.onModuleDestroy().catch(() => undefined);
  }
});

/** The worker under test, its kind map the one the worker module builds — with this spec's wiki service. */
function worker(h: Harness): { queue: WikiModelRequestQueue; executor: WikiJobExecutor } {
  const options = { leaseMs: 400, renewMs: 100, partialMs: 40, pollMs: 30 };
  const config_ = config(h);
  const queue = new WikiModelRequestQueue(
    h.prisma as unknown as PrismaService, config_,
    new WikiModelStatusProbe(h.prisma as unknown as PrismaService, config_), undefined, options,
  );
  const runners: Record<string, WikiJobRunner> = { ...WIKI_JOB_RUNNERS, verify: wikiVerifyJobRunner(h.service, MODEL) };
  const executor = new WikiJobExecutor(h.prisma as unknown as PrismaService, queue, options, runners);
  live.push({ queue, executor });
  return { queue, executor };
}

async function modelUp(h: Harness): Promise<void> {
  await new WikiModelStatusProbe(h.prisma as unknown as PrismaService, config(h)).check();
}

/**
 * What one case leaves behind for the next: the jobs and requests of the account, and the fake model's
 * record of the calls. A case that leaves a job queued would have the next case's worker claim it — a
 * different session's ops verified under a test that never asked for it.
 */
async function clearWork(h: Harness): Promise<void> {
  await h.sql.query('DELETE FROM "wiki_job" WHERE "owner_id" = $1', [h.ownerId]);
  await h.sql.query('DELETE FROM "wiki_model_request" WHERE "owner_id" = $1', [h.ownerId]);
  await h.sql.query('DELETE FROM "wiki_model_status"');
  h.model.hits.length = 0;
  h.model.systems.length = 0;
  h.model.answer = () => '{"verdict": "supported", "reason": "The record says exactly this."}';
  await modelUp(h);
}

/** Run the worker until `done`, or fail the case: a job left queued here would be the next case's flake. */
async function pass(
  h: Harness,
  which: { queue: WikiModelRequestQueue; executor: WikiJobExecutor },
  done: () => Promise<boolean>,
  rounds = 80,
): Promise<void> {
  for (let i = 0; i < rounds; i += 1) {
    await which.executor.runOnce();
    await which.queue.runOnce();
    if (await done()) return;
    await delay(30);
  }
  assert.fail(`the worker did not finish: ${JSON.stringify(await jobs(h))}`);
}

/** A valid pitfall, retitled per use. */
function pitfall(title: string): Record<string, unknown> {
  return {
    kind: 'pitfall',
    title,
    summary: `What the space knows about ${title.toLowerCase()}.`,
    fields: {
      trigger: { paths: ['scripts/release.sh'], commands: ['bash scripts/release.sh next'] },
      symptom: 'It went wrong.',
      cause: 'The script is not a dry run.',
      fix: 'Do the other thing.',
    },
  };
}

function agent(h: Harness, fx: Fixture, over: Partial<WikiPrincipal> = {}): WikiPrincipal {
  return { origin: 'agent', ownerId: h.ownerId, userId: null, sessionId: fx.sessionId, toolCallId: null, ...over };
}

interface Outcome {
  seq: number;
  status: string;
  opId?: string | null;
  waitsFor?: string;
}

/** One op proposed by the fixture's session, and the op row id it made. */
async function propose(h: Harness, fx: Fixture, title: string, over: Partial<WikiPrincipal> = {}): Promise<string> {
  const answer = await h.service.submitChangeset(agent(h, fx, over), fx.spaceId, {
    ops: [{ op: 'add', entry: pitfall(title), sources: [{ kind: 'tool_call', ref: fx.cite }] }],
    rationale: `the spec records ${title}`,
  });
  const first = ((answer.ops ?? []) as Outcome[])[0];
  assert.ok(first, `the proposal was answered with nothing: ${JSON.stringify(answer)}`);
  assert.equal(first.status, 'pending', `the op did not wait: ${JSON.stringify(first)}`);
  return String(first.opId);
}

async function opRow(h: Harness, opId: string) {
  return h.prisma.wikiChangesetOp.findFirstOrThrow({ where: { id: opId } });
}

interface JobRow {
  id: string;
  kind: string;
  state: string;
  priority: number;
  input: { sessionId?: string } | null;
  report: Record<string, unknown> | null;
  error: string | null;
  failure_kind: string | null;
}

async function jobs(h: Harness, sessionId?: string): Promise<JobRow[]> {
  const rows = await h.sql.query<JobRow>(
    `SELECT "id", "kind", "state", "priority", "input", "report", "error", "failure_kind"
       FROM "wiki_job" WHERE "owner_id" = $1 ORDER BY "created_at", "id"`, [h.ownerId],
  ).then((result) => result.rows);
  return sessionId === undefined ? rows : rows.filter((row) => row.input?.sessionId === sessionId);
}

async function jobRow(h: Harness, id: string): Promise<JobRow> {
  const found = (await jobs(h)).find((row) => row.id === id);
  assert.ok(found, `no job ${id}`);
  return found;
}

/** Run the worker until the named job settles, and answer how it ended. */
async function settle(h: Harness, id: string): Promise<JobRow> {
  const which = worker(h);
  await pass(h, which, async () => ['succeeded', 'failed', 'cancelled'].includes((await jobRow(h, id)).state));
  return jobRow(h, id);
}

test('the trigger: an Automatic space\'s waiting op queues its session\'s verification, and runner mode queues nothing', { skip, timeout: 60_000 }, async () => {
  const h = await boot();
  await clearWork(h);
  const fx = await fixture(h);
  // The path every deployment has had: nothing is queued, and the op waits for the session's own verifier.
  process.env.ORBIT_WIKI_EXECUTOR = 'runner';
  const waiting = await propose(h, fx, 'A clock is no verdict');
  assert.deepEqual(await jobs(h, fx.sessionId), [], 'runner mode queued a job');
  assert.equal((await opRow(h, waiting)).decision, 'verifying');
  // The server runs for this account: the op that entered verifying made one job, for this session.
  process.env.ORBIT_WIKI_EXECUTOR = 'canary';
  process.env.ORBIT_WIKI_EXECUTOR_CANARY_OWNERS = h.ownerId;
  await propose(h, fx, 'A verdict comes from the records');
  const queued = await jobs(h, fx.sessionId);
  assert.equal(queued.length, 1, `want one job, got ${JSON.stringify(queued)}`);
  assert.equal(queued[0].kind, 'verify');
  assert.equal(queued[0].state, 'queued');
  assert.equal(queued[0].priority, 1, 'the proposing session is waiting for this verdict');
  assert.equal(queued[0].input?.sessionId, fx.sessionId);
  // A second submission while that job is still queued: the job verifies every op of its session that
  // waits when it runs, so this one rides it — one job, not two.
  await propose(h, fx, 'The second op rides the first job');
  assert.equal((await jobs(h, fx.sessionId)).length, 1, 'a second queued job was made for one waiting session');
  // A maintenance run verifies its own ops in its own process: nothing is queued for it.
  await h.service.submitChangeset(
    agent(h, fx, { origin: 'maintenance', sessionId: randomUUID() }),
    fx.spaceId,
    { ops: [{ op: 'add', entry: pitfall('A run verifies its own'), sources: [{ kind: 'tool_call', ref: fx.cite }] }], rationale: 'a run' },
  );
  assert.equal((await jobs(h)).length, 1, 'a maintenance run\'s op queued a job');
  process.env.ORBIT_WIKI_EXECUTOR = 'runner';
});

test('the job verifies end to end: the verdict applies the op, the entry goes live, and the report says what happened', { skip, timeout: 60_000 }, async () => {
  const h = await boot();
  await clearWork(h);
  const fx = await fixture(h);
  process.env.ORBIT_WIKI_EXECUTOR = 'server';
  const opId = await propose(h, fx, 'The worker reads the records');
  const [job] = await jobs(h, fx.sessionId);
  assert.ok(job);
  assert.equal(job.priority, 1);
  const settled = await settle(h, job.id);
  assert.equal(settled.state, 'succeeded', `the job ended ${settled.state}: ${settled.error}`);
  // One call, carrying the verifier's own system prompt and this op, asked through the queue.
  assert.equal(h.model.hits.length, 1, `the model was asked ${h.model.hits.length} times`);
  assert.match(h.model.systems[0], /^You verify proposed wiki entries against the records they cite\./u);
  assert.match(h.model.hits[0].prompt, /Title: The worker reads the records/u);
  assert.match(h.model.hits[0].prompt, /## Your answer/u);
  // The verdict went through the server's own writer: the op applied, the entry live as Auto and pushed.
  const op = await opRow(h, opId);
  assert.equal(op.decision, 'auto_applied');
  assert.equal(op.verificationVerdict, 'supported');
  assert.equal(op.verificationModel, MODEL);
  assert.equal(op.appliedByMode, 'automatic');
  const entry = await h.prisma.wikiEntry.findFirstOrThrow({ where: { id: op.resultEntryId! } });
  assert.equal(entry.status, 'active');
  assert.equal(entry.trust, 'auto');
  // And the report is the pass's own summary.
  assert.equal(settled.report?.kind, 'verify');
  assert.equal(settled.report?.spaceId, fx.spaceId);
  assert.equal(settled.report?.mode, 'automatic');
  assert.equal(settled.report?.looked, 1);
  assert.equal(settled.report?.verified, 1);
  assert.equal(settled.report?.supported, 1);
  assert.equal(settled.report?.failed, 0);
  assert.equal(settled.report?.model, MODEL);
  assert.equal(settled.report?.stopped, null);
  assert.deepEqual(settled.report?.failures, []);
  assert.ok(((settled.report?.usage as { inputTokens: number }).inputTokens ?? 0) > 0, 'the call\'s tokens are in the report');
  process.env.ORBIT_WIKI_EXECUTOR = 'runner';
});

test('a duplicate names the entry its number stands for, and an answer that is not a verdict applies nothing', { skip, timeout: 60_000 }, async () => {
  const h = await boot();
  await clearWork(h);
  const fx = await fixture(h);
  process.env.ORBIT_WIKI_EXECUTOR = 'server';
  // A live entry of the space, which the next op turns out to repeat.
  const first = await propose(h, fx, 'Closed sets are CHECK constraints');
  const [firstJob] = await jobs(h, fx.sessionId);
  await settle(h, firstJob.id);
  const live = await opRow(h, first);
  const liveEntryId = live.resultEntryId!;
  assert.equal((await h.prisma.wikiEntry.findFirstOrThrow({ where: { id: liveEntryId } })).status, 'active');
  // One op answered by NUMBER, then one whose model copied the id one character short — the 09-30 failure
  // the numbering exists to prevent, read as strictly by the server as by the runner: nothing is reported.
  const byNumber = await propose(h, fx, 'Closed sets are CHECK constraints, always');
  const [numberJob] = (await jobs(h, fx.sessionId)).filter((row) => row.state === 'queued');
  assert.ok(numberJob, 'no job was queued for the duplicate');
  h.model.answer = () => '{"verdict": "duplicate", "reason": "Said already.", "duplicateOf": "E1"}';
  const numberSettled = await settle(h, numberJob.id);
  assert.equal(numberSettled.state, 'succeeded');
  assert.equal(numberSettled.report?.duplicate, 1);
  const mapped = await opRow(h, byNumber);
  assert.equal(mapped.decision, 'rejected');
  assert.equal(mapped.decisionReason, 'duplicate');
  assert.equal(mapped.verificationDuplicateOf, liveEntryId, 'E1 was not mapped to the entry it stands for');
  const byId = await propose(h, fx, 'Closed sets are CHECK constraints, ever');
  const [idJob] = (await jobs(h, fx.sessionId)).filter((row) => row.state === 'queued');
  assert.ok(idJob, 'no job was queued for the cut id');
  h.model.answer = () => `{"verdict": "duplicate", "reason": "Said already.", "duplicateOf": "${liveEntryId.slice(0, -1)}"}`;
  const idSettled = await settle(h, idJob.id);
  assert.equal(idSettled.state, 'succeeded', `an answer that is not a verdict failed the job: ${idSettled.error}`);
  assert.equal(idSettled.report?.verified, 0);
  assert.equal(idSettled.report?.failed, 1);
  const refused = await opRow(h, byId);
  assert.equal(refused.decision, 'verifying', 'an answer that is not a verdict let something through');
  assert.equal(refused.verificationVerdict, null);
  // The pass names the op it could not read, in the runner's own words.
  const failures = (idSettled.report?.failures ?? []) as Array<{ opId: string; why: string; refused: string }>;
  assert.deepEqual(failures.map((one) => one.opId), [byId]);
  assert.match(failures[0].why, /is not a verdict/u);
  const refusedWhy = failures[0].refused;
  assert.equal(refusedWhy, 'a duplicate must name one of the listed entries by its number (E1), and '
    + `"${liveEntryId.slice(0, -1)}" is not one`);
  process.env.ORBIT_WIKI_EXECUTOR = 'runner';
});

test('one queued job covers its session\'s later ops: two submissions queue one job, and it verifies both', { skip, timeout: 60_000 }, async () => {
  const h = await boot();
  await clearWork(h);
  const fx = await fixture(h);
  process.env.ORBIT_WIKI_EXECUTOR = 'server';
  const first = await propose(h, fx, 'The first waiting op');
  const second = await propose(h, fx, 'The second waiting op');
  assert.equal((await jobs(h, fx.sessionId)).length, 1);
  const [job] = await jobs(h, fx.sessionId);
  await settle(h, job.id);
  const settled = await jobRow(h, job.id);
  assert.equal(settled.report?.looked, 2, 'the one job did not verify both waiting ops');
  assert.equal(settled.report?.verified, 2);
  assert.equal((await opRow(h, first)).decision, 'auto_applied');
  assert.equal((await opRow(h, second)).decision, 'auto_applied');
  process.env.ORBIT_WIKI_EXECUTOR = 'runner';
});
