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
 *      and the one job verifies both;
 *   5. a NUL in the model's answer (2026-10-09): written as \u0000 inside the verdict's JSON, the verdict is
 *      recorded with the NUL left out (contract `jobs.serverWrites`); written raw, the answer is kept as it came
 *      (`modelQueue.answerEncoding`) and its JSON does not read — a control character in a string, which Go's
 *      decoder refuses too — so it is reported as nothing, the op keeps waiting, and the job goes on;
 *   6. a worker stopped while the model answers the third of a session's four ops hands the job back, and the next one
 *      finishes it: the report the replay ends with is the whole job's (contract `jobs.carry`) — the two verdicts
 *      recorded before the stop counted with the two after it, every call once — exactly what the same job reports when
 *      nothing stops it.
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
import { WIKI_JOB } from '@orbit/shared';
import { Client } from 'pg';

import { prismaClientFor } from '../prisma/prisma-client';
import { PrismaService } from '../prisma/prisma.service';
import { assertCoordinatorPgUrlIsIsolated, verifyCoordinatorPgIdentity } from '../projects/coordinator-pg-test-safety';
import type { PushService } from '../push/push.service';
import type { RealtimeService } from '../realtime/realtime.service';
import { WikiService, type WikiPrincipal } from '../wiki/wiki.service';
import { WikiJobExecutor, WIKI_JOB_RUNNERS, type WikiJobRunner } from './wiki-job-executor';
import { claimWikiJobs, reclaimExpiredWikiJobs, WIKI_JOB_HANDED_BACK } from './wiki-jobs';
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
  /** Waited for before a call is answered: a case holds a call here while it stops the worker. */
  before: (hit: Hit) => Promise<void>;
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
    before: async () => undefined,
    close: async () => undefined,
  } as FakeModel;
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    let body = '';
    request.on('data', (chunk: Buffer) => {
      body += chunk.toString();
    });
    request.on('end', () => void (async () => {
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
      await state.before({ prompt });
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
    })());
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

/**
 * The lease this spec's worker claims under: the deployment's own — the same lease and renewal every claim
 * outside a spec gets. No case of this spec is about a lease running out, so the harness must not claim under
 * a shortened one: the 400 ms it used to be let a stall of the event loop longer than the lease hand the job
 * to the sweep of the next pass mid-run, so the case read the second attempt's work. wiki-jobs.pg.spec.ts is
 * the one file that claims under a short lease on purpose: there the lease is the subject. The last case of
 * this file pins this margin the deterministic way.
 */
const HARNESS_LEASE_MS = WIKI_JOB.leaseSeconds * 1000;
const HARNESS_RENEW_MS = WIKI_JOB.renewSeconds * 1000;

/** The worker under test, its kind map the one the worker module builds — with this spec's wiki service. */
function worker(h: Harness): { queue: WikiModelRequestQueue; executor: WikiJobExecutor } {
  const options = { leaseMs: HARNESS_LEASE_MS, renewMs: HARNESS_RENEW_MS, partialMs: 40, pollMs: 30 };
  const config_ = config(h);
  const queue = new WikiModelRequestQueue(
    h.prisma as unknown as PrismaService, config_,
    new WikiModelStatusProbe(h.prisma as unknown as PrismaService, config_), undefined, options,
  );
  const runners: Record<string, WikiJobRunner> = { ...WIKI_JOB_RUNNERS, verify: wikiVerifyJobRunner(h.service, MODEL, h.prisma as unknown as PrismaService) };
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
  h.model.before = async () => undefined;
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

/**
 * Block the event loop for `ms` (the loaded host's own stall, here on demand): no timer of this process fires
 * while it runs, which is what a busy machine does to the lease renewals of a worker on it.
 */
function stallEventLoop(ms: number): void {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    /* the loop is the point */
  }
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

test('a NUL in the answer: as \\u0000 the verdict is recorded without it; raw, its JSON does not read, as Go\'s decoder says', { skip, timeout: 60_000 }, async () => {
  const h = await boot();
  await clearWork(h);
  const fx = await fixture(h);
  process.env.ORBIT_WIKI_EXECUTOR = 'server';
  // Built rather than written: a raw NUL in this source is the hazard itself (runner-api/strip-nul.ts).
  const NUL = String.fromCharCode(0);
  try {
    // The model escapes the NUL of what it was shown: the JSON reads, and the reason it gives has a NUL in it.
    const escaped = await propose(h, fx, 'A source file can carry a NUL');
    const [escapedJob] = (await jobs(h, fx.sessionId)).filter((row) => row.state === 'queued');
    assert.ok(escapedJob, 'no job was queued for the op');
    h.model.answer = () => '{"verdict": "supported", "reason": "The record quotes the regex a\\u0000b."}';
    const first = await settle(h, escapedJob.id);
    assert.equal(first.state, 'succeeded', `the job ended ${first.state}: ${first.error}`);
    const applied = await opRow(h, escaped);
    assert.equal(applied.decision, 'auto_applied', 'the verdict was recorded');
    assert.equal(applied.verificationReason, 'The record quotes the regex ab.', 'the NUL the model wrote is left out, and nothing else');

    // The model writes the NUL raw, inside a JSON string: the answer is kept as it came, as its bytes ...
    const raw = await propose(h, fx, 'A source file can carry a raw NUL');
    const [rawJob] = (await jobs(h, fx.sessionId)).filter((row) => row.state === 'queued');
    assert.ok(rawJob, 'no job was queued for the second op');
    h.model.answer = () => `{"verdict": "supported", "reason": "The record quotes the regex a${NUL}b."}`;
    const second = await settle(h, rawJob.id);
    assert.equal(second.state, 'succeeded', `the job ended ${second.state}: ${second.error}`);
    const { rows: [call] } = await h.sql.query<{ state: string; answer: string; answer_encoding: string }>(
      `SELECT "state", "answer", "answer_encoding" FROM "wiki_model_request" WHERE "job_id" = $1`, [rawJob.id]);
    assert.equal(call.state, 'succeeded', 'the call answered, and its answer was written');
    assert.equal(call.answer_encoding, 'base64');
    assert.equal(Buffer.from(call.answer, 'base64').toString('utf8'), `{"verdict": "supported", "reason": "The record quotes the regex a${NUL}b."}`);
    // ... and its JSON does not read, which is what Go's decoder says of it too: nothing is applied, the op waits.
    const waiting = await opRow(h, raw);
    assert.equal(waiting.decision, 'verifying', 'an answer whose JSON does not read let something through');
    assert.equal(waiting.verificationVerdict, null);
    const failures = (second.report?.failures ?? []) as Array<{ opId: string; why: string; refused: string }>;
    assert.deepEqual(failures.map((one) => one.opId), [raw]);
    assert.match(failures[0].refused, /JSON/u);
  } finally {
    h.model.answer = () => '{"verdict": "supported", "reason": "The record says exactly this."}';
    process.env.ORBIT_WIKI_EXECUTOR = 'runner';
  }
});

test('the lease this harness claims under outlives a two-second stall: the sweep finds nothing to take over', { skip, timeout: 60_000 }, async () => {
  const h = await boot();
  await clearWork(h);
  const fx = await fixture(h);
  process.env.ORBIT_WIKI_EXECUTOR = 'server';
  await propose(h, fx, 'The job the stall is spent on');
  const [job] = await jobs(h, fx.sessionId);
  assert.ok(job);
  // The claim this spec's worker makes, made by hand so the sweep can be run in the same synchronous window
  // the loop resumes in — the call the next pass makes a moment later. Under the 400 ms lease this harness
  // used to claim under, the stall below spent it and that sweep took the job over: the row came back
  // 'queued', its attempt counted, LEASE_EXPIRED. The mechanism's own cases are wiki-jobs.pg.spec.ts's; what
  // this pins is the lease THIS spec's worker claims under.
  const [claimed] = await claimWikiJobs(h.prisma as unknown as PrismaService, {
    workerId: randomUUID(), kinds: ['verify'], owners: [h.ownerId], limit: 1, leaseMs: HARNESS_LEASE_MS,
  });
  assert.equal(claimed?.id, job.id, 'the queued verification was not the one claimed');
  stallEventLoop(2_000);
  assert.deepEqual(
    await reclaimExpiredWikiJobs(h.prisma as unknown as PrismaService, 4), [],
    'a two-second stall spent the lease: the next pass would take the job over mid-run',
  );
  const { rows: [row] } = await h.sql.query<{ state: string; attempts: number; failure_kind: string | null }>(
    'SELECT "state", "attempts", "failure_kind" FROM "wiki_job" WHERE "id" = $1', [job.id],
  );
  assert.deepEqual(row, { state: 'running', attempts: 0, failure_kind: null }, 'the stall cost the job its attempt');
  process.env.ORBIT_WIKI_EXECUTOR = 'runner';
});


// ── 6. a worker stopped mid-job: the report is the whole job's ───────────────────────────────────

/** How many of a session's ops have their verdict recorded. */
async function verdicts(h: Harness, sessionId: string): Promise<number> {
  const { rows } = await h.sql.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM "wiki_changeset_op" o JOIN "wiki_changeset" c ON c."id" = o."changeset_id"
      WHERE c."session_id" = $1 AND o."verification_verdict" IS NOT NULL`, [sessionId]);
  return rows[0].n;
}

test('a worker stopped after two verdicts hands the job back, and the report the replay ends with is the whole job\'s', { skip, timeout: 90_000 }, async () => {
  const h = await boot();
  await clearWork(h);
  process.env.ORBIT_WIKI_EXECUTOR = 'server';
  const titles = ['The first op is verified', 'The second op is verified', 'The third op is held', 'The fourth op is left'];

  // What the job reports when nothing stops it: a session of four ops, verified straight through.
  const straight = await fixture(h);
  for (const title of titles) await propose(h, straight, title);
  const [whole] = await jobs(h, straight.sessionId);
  const through = await settle(h, whole.id);
  assert.equal(through.state, 'succeeded', `${through.state}: ${through.error}`);

  // The same session again, in a space of its own: two verdicts recorded, the third op's call held while the worker stops.
  const stopped = await fixture(h);
  for (const title of titles) await propose(h, stopped, title);
  const [job] = await jobs(h, stopped.sessionId);
  let holding = false;
  let release: () => void = () => undefined;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  h.model.before = async (hit) => {
    if (!hit.prompt.includes('Title: The third op is held')) return;
    holding = true;
    await released;
  };
  const one = worker(h);
  await pass(h, one, async () => holding && (await verdicts(h, stopped.sessionId)) === 2);
  // SIGTERM: the job's wait for the held call is cancelled and the job is handed back; the call is let go with it.
  await one.executor.onModuleDestroy();
  await one.queue.onModuleDestroy();
  release();
  h.model.before = async () => undefined;
  const { rows: [back] } = await h.sql.query<{ state: string; attempts: number; error: string | null }>(
    'SELECT "state", "attempts", "error" FROM "wiki_job" WHERE "id" = $1', [job.id]);
  assert.deepEqual(back, { state: 'queued', attempts: 0, error: WIKI_JOB_HANDED_BACK }, 'the job is handed back, nothing counted');

  // The next worker takes it over: the list no longer holds the two ops that have their verdicts, and it verifies the rest.
  const done = await settle(h, job.id);
  assert.equal(done.state, 'succeeded', `${done.state}: ${done.error}`);
  assert.equal(await verdicts(h, stopped.sessionId), 4);
  const report = done.report as Record<string, unknown>;
  // What the same job reports when nothing stops it, to the verdict and the token.
  const { spaceId: _stoppedSpace, ...stoppedTotals } = report;
  const { spaceId: _straightSpace, ...straightTotals } = through.report as Record<string, unknown>;
  assert.deepEqual(stoppedTotals, straightTotals, 'the stopped job reports what the straight one does');
  assert.deepEqual(
    [report.looked, report.verified, report.supported, report.failed, report.stopped],
    [4, 4, 4, 0, null],
    'every op of the session, the two verified before the stop included, once',
  );
  // The usage is the job's calls', each once: the call the stop cut off was asked again under its own row.
  const requests = await h.prisma.wikiModelRequest.findMany({ where: { jobId: job.id }, select: { state: true, inputTokens: true, outputTokens: true } });
  assert.equal(requests.length, 4, JSON.stringify(requests));
  assert.ok(requests.every((request) => request.state === 'succeeded'), JSON.stringify(requests));
  assert.deepEqual(report.usage, {
    inputTokens: requests.reduce((total, request) => total + (request.inputTokens ?? 0), 0),
    outputTokens: requests.reduce((total, request) => total + (request.outputTokens ?? 0), 0),
  });
  process.env.ORBIT_WIKI_EXECUTOR = 'runner';
});
