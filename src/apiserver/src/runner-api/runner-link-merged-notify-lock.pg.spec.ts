/**
 * The merged event call and PostgreSQL's notification-queue lock (task "Merged event commits queue on Postgres's global
 * NOTIFY lock"; RunnerApiController.ingestLinkEventCall, RealtimeService.sendNotices).
 *
 * THE LOCK
 * --------
 * A transaction that has sent a NOTIFY takes one lock at its commit (PreCommit_Notify: object, database 0, classid 1262,
 * objid 0, AccessExclusiveLock) and holds it until the commit is done, its WAL flush and any synchronous-standby wait
 * included. Task C2b saw merged calls queue on it at cell scale, and one that queued past LINK_CALL_LOCK_TIMEOUT_MS
 * (1 s) fail at its COMMIT, roll back, and send every batch alone.
 *
 * HOW THIS SPEC HOLDS IT
 * ----------------------
 * Deterministically, with a synchronous standby that does not exist. The server's default `synchronous_commit` is made
 * `local` (ALTER SYSTEM) before anything else connects, so no other transaction waits for a standby; then
 * `synchronous_standby_names` names one, and a connection of this spec's own sets `synchronous_commit = on`, writes
 * something (a temporary table: a transaction that writes no WAL, one that only notifies among them, flushes nothing
 * at its commit and waits for no standby), sends a NOTIFY and commits. Its COMMIT writes its commit record and then waits for the standby forever, holding the lock,
 * which is read in pg_locks (granted to that backend, which waits on SyncRep) before anything is asked of the routes.
 * Emptying `synchronous_standby_names` lets it go. Both settings are reset when the spec ends; left behind by a killed
 * run, `local` with a standby named changes nothing for a later spec, which never waits for a standby either.
 *
 * WHAT IT ASSERTS
 * ---------------
 *   (1) With the lock held past LINK_CALL_LOCK_TIMEOUT_MS, a merged call of two sessions commits: its rows are stored
 *       while the lock is still held, its notice waits for the lock outside the transaction, and once the lock is let
 *       go the call is answered as stored (no batch sendAlone) and another apiserver's streams get every event, each
 *       session's notice once. Before the fix the call's COMMIT failed on the lock timeout, nothing was stored, and
 *       every batch was answered sendAlone.
 *   (2) A process that dies between the merged call's commit and its notice: the call is never answered, and no other
 *       apiserver hears of the batches. The gateway then sends the call again to its other backend (it is idempotent),
 *       or fails a batch to its runner, which sends it alone: either ingest finds the seqs stored and announces them
 *       again, and the events reach the session's streams on every other apiserver, the one that took the resend
 *       included.
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/runner-api/runner-link-merged-notify-lock.pg.spec.ts
 *
 * Needs COORDINATOR_PG_URL on a server its role may ALTER SYSTEM on (the scripts provide a disposable one, as a
 * superuser). A role that may not is a failure, not a skip.
 */
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { request as httpRequest, type ClientRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';

import { type INestApplication, Module, ValidationPipe } from '@nestjs/common';
import { HttpAdapterHost, NestFactory } from '@nestjs/core';
import { type PrismaClient, RunStatus } from '@prisma/client';
import { RunEventType, type NormalizedRunEvent } from '@orbit/shared';
import { Client } from 'pg';

import { sha256 } from '../common/crypto.util';
import { publicIdHeaders } from '../common/public-id-headers';
import { PublicIdExceptionFilter } from '../common/public-id.filter';
import { PublicIdInterceptor } from '../common/public-id.interceptor';
import { RunnerLinkErrorFilter } from '../common/runner-link-error.filter';
import { TransientDbConflictFilter } from '../common/transient-db-conflict.filter';
import { prismaClientFor } from '../prisma/prisma-client';
import { PrismaService } from '../prisma/prisma.service';
import { AttemptBudgetMeterService } from '../projects/attempt-budget-meter.service';
import { assertCoordinatorPgUrlIsIsolated, verifyCoordinatorPgIdentity } from '../projects/coordinator-pg-test-safety';
import { ProjectAcceptanceService } from '../projects/project-acceptance.service';
import { ProjectFuseService } from '../projects/project-fuse.service';
import { PushService } from '../push/push.service';
import { QueueService } from '../queue/queue.service';
import { RealtimeService } from '../realtime/realtime.service';
import { MergeReceiptService } from '../sessions/merge-receipt.service';
import { SessionsService } from '../sessions/sessions.service';
import { ListEventsService } from '../task-lists/list-events.service';
import { ReferenceExpansionService } from '../tasks/reference-expansion';
import { TasksService } from '../tasks/tasks.service';
import { RunnerApiController } from './runner-api.controller';
import { RunnerAuthGuard } from './runner-auth.guard';
import { listenForRunnerLinkCalls } from './runner-link-call';
import { RunnerLinkEventsController, RunnerLinkGatewayCallGuard } from './runner-link-events.controller';
import { readRunnerLink, RUNNER_LINK, runnerLinkCredential, signRunnerLinkToken, type RunnerLinkState } from './runner-link-token';
import { RunnerOrchestrationAuthorizer } from './runner-orchestration-authorizer';
import '../test-support/daemon-routes-over-http';

declare global {
  interface BigInt { toJSON(): string; }
}
BigInt.prototype.toJSON = function toJSON(this: bigint): string {
  return this.toString();
};

const PG_URL = process.env.COORDINATOR_PG_URL;
const skip = !PG_URL;

const GATEWAY_TOKEN = `the-link-gateway-secret:${randomUUID()}`;
const PROVIDERS = 'claude,codex,opencode,antigravity,dsh';
const MERGED = '/api/runner/link/events';
/** runner-api.controller.ts's LINK_CALL_LOCK_TIMEOUT_MS: how long a merged transaction waits for any lock. */
const LINK_CALL_LOCK_TIMEOUT_MS = 1_000;
/** A standby nobody runs: a commit that waits for it waits until the name is taken away. */
const NO_SUCH_STANDBY = 'orbit_spec_no_such_standby';
/** Long enough for a notification issued at a commit to arrive, and for a second one to show itself. */
const NOTIFY_SETTLE_MS = 750;

interface Answer {
  status: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  body: any;
}

/** One request on a connection of its own, and the request itself, for a caller that drops it unanswered. */
function sendRequest(port: number, method: string, pathname: string, headers: Record<string, string>, body?: unknown) {
  let req!: ClientRequest;
  const answer = new Promise<Answer>((resolve, reject) => {
    const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    req = httpRequest(
      {
        host: '127.0.0.1',
        port,
        method,
        path: pathname,
        agent: false,
        headers: {
          ...(payload ? { 'content-type': 'application/json', 'content-length': String(payload.length) } : {}),
          ...headers,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('error', reject);
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let parsed: unknown = text;
          try {
            parsed = text === '' ? null : JSON.parse(text);
          } catch {
            /* not JSON: kept as text */
          }
          resolve({ status: res.statusCode ?? 0, body: parsed });
        });
      },
    );
    req.on('error', reject);
    req.end(payload);
  });
  return { req, answer };
}

async function until(what: string, ok: () => boolean | Promise<boolean>, ms = 10_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await ok())) {
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`);
    await sleep(25);
  }
}

/** The control plane's runner door as main.ts builds it, the merged call's controller beside the runner one. */
async function bootDoor(db: PrismaClient, link: RunnerLinkState, realtime: RealtimeService) {
  const push = { scheduleBadgeSync: () => undefined, notifySessionSettled: async () => undefined };
  const queue = new QueueService(db as unknown as PrismaService, realtime);
  const sessions = new SessionsService(db as unknown as PrismaService, queue, realtime);
  @Module({
    controllers: [RunnerApiController, RunnerLinkEventsController],
    providers: [
      { provide: PrismaService, useValue: db },
      { provide: QueueService, useValue: queue },
      { provide: SessionsService, useValue: sessions },
      { provide: RealtimeService, useValue: realtime },
      { provide: PushService, useValue: push },
      { provide: RunnerOrchestrationAuthorizer, useValue: { issue: async () => 'credential' } },
      { provide: ReferenceExpansionService, useValue: { expand: async (_owner: string, content?: string) => content } },
      { provide: ListEventsService, useValue: { appendFor: async (_tx: unknown, _id: string, content?: string) => content } },
      { provide: AttemptBudgetMeterService, useValue: { meterQuietly: async () => undefined } },
      { provide: ProjectAcceptanceService, useValue: {} },
      { provide: ProjectFuseService, useValue: { afterCoordinatorSpend: async () => undefined } },
      { provide: TasksService, useValue: {} },
      { provide: MergeReceiptService, useValue: {} },
      { provide: RUNNER_LINK, useValue: link },
      RunnerAuthGuard,
      RunnerLinkGatewayCallGuard,
    ],
  })
  class RunnerDoor {}

  const app: INestApplication = await NestFactory.create(RunnerDoor, { logger: false, abortOnError: false });
  app.use(publicIdHeaders);
  app.setGlobalPrefix('api');
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: false }));
  app.useGlobalInterceptors(new PublicIdInterceptor());
  const httpAdapter = app.get(HttpAdapterHost).httpAdapter;
  app.useGlobalFilters(
    new TransientDbConflictFilter(
      new RunnerLinkErrorFilter(new PublicIdExceptionFilter(httpAdapter), httpAdapter),
      httpAdapter,
    ),
  );
  await app.listen(0, '127.0.0.1');
  const problems: string[] = [];
  const linkServer = await listenForRunnerLinkCalls(
    app,
    { port: '0', host: '127.0.0.1' },
    { log: () => undefined, error: (message: string) => problems.push(message) },
  );
  assert.ok(linkServer, `the internal listener did not open: ${problems.join('; ')}`);
  return {
    linkPort: (linkServer.address() as AddressInfo).port,
    close: async () => {
      linkServer.closeAllConnections();
      await new Promise<void>((resolve) => linkServer.close(() => resolve()));
      await app.close();
    },
  };
}

test('a merged event call commits past a held notification lock, and its events reach every apiserver even when its process dies before telling them', {
  skip,
  concurrency: 1,
  timeout: 300_000,
}, async (t) => {
  const url = PG_URL!;
  assertCoordinatorPgUrlIsIsolated(url);
  process.env.DATABASE_URL = url;
  const sql = new Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
  await sql.connect();
  await verifyCoordinatorPgIdentity(sql);
  const { rows: [role] } = await sql.query<{ super: boolean }>('SELECT rolsuper AS super FROM pg_roles WHERE rolname = current_user');
  assert.ok(role?.super, 'this spec holds the notification lock through ALTER SYSTEM, which its role may not run');

  // No other transaction waits for a standby: set before anything else of this spec connects, and read back.
  await sql.query(`ALTER SYSTEM SET synchronous_commit = 'local'`);
  await sql.query('SELECT pg_reload_conf()');
  await until('the server defaulting to synchronous_commit = local', async () => {
    const probe = new Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
    await probe.connect();
    try {
      return (await probe.query<{ v: string }>(`SELECT current_setting('synchronous_commit') AS v`)).rows[0].v === 'local';
    } finally {
      await probe.end();
    }
  });
  const unsetStandby = async () => {
    await sql.query('ALTER SYSTEM RESET synchronous_standby_names');
    await sql.query('SELECT pg_reload_conf()');
  };
  t.after(async () => {
    await unsetStandby().catch(() => undefined);
    await sql.query('ALTER SYSTEM RESET synchronous_commit').catch(() => undefined);
    await sql.query('SELECT pg_reload_conf()').catch(() => undefined);
  });

  const prisma: PrismaClient = prismaClientFor(url);
  const { privateKey } = generateKeyPairSync('ed25519');
  const link = readRunnerLink({
    signingKey: Buffer.from(privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), 'utf8').toString('base64'),
    linkUrl: 'wss://link.runner-door.invalid',
    gatewayToken: GATEWAY_TOKEN,
  });
  assert.ok(link.config, `the test link did not configure: ${link.problems.join('; ')}`);
  const push = { scheduleBadgeSync: () => undefined, notifySessionSettled: async () => undefined } as unknown as PushService;

  /** The apiserver the gateway sends the call to first. */
  const origin = new RealtimeService(prisma as unknown as PrismaService, push);
  const door = await bootDoor(prisma, link, origin);
  /** The gateway's other backend, listening on the database like every apiserver. */
  const elsewhere = new RealtimeService(prisma as unknown as PrismaService, push);
  await elsewhere.onModuleInit();
  const door2 = await bootDoor(prisma, link, elsewhere);
  /** An apiserver a client watches from, which takes no runner call at all. */
  const watcher = new RealtimeService(prisma as unknown as PrismaService, push);
  await watcher.onModuleInit();
  await until('the other apiservers listening', () => [elsewhere, watcher].every((r) => (r as unknown as { listener?: unknown }).listener !== undefined));

  // Every notification on the event channel, as any apiserver's listener receives it.
  const notes: Array<Record<string, unknown>> = [];
  const listen = new Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
  await listen.connect();
  listen.on('notification', (msg) => {
    if (msg.channel === 'orbit_event' && msg.payload) notes.push(JSON.parse(msg.payload) as Record<string, unknown>);
  });
  await listen.query('LISTEN orbit_event');

  t.after(async () => {
    await door.close().catch(() => undefined);
    await door2.close().catch(() => undefined);
    origin.onModuleDestroy();
    elsewhere.onModuleDestroy();
    watcher.onModuleDestroy();
    await listen.end().catch(() => undefined);
    await prisma.$disconnect().catch(() => undefined);
    await sql.end().catch(() => undefined);
  });

  // ── the fixture: an account, its machine, and the process it connected ─────────────────────────────────
  const ownerId = randomUUID();
  const runnerId = randomUUID();
  const workspaceId = randomUUID();
  const runnerToken = `notify-lock:${randomUUID()}`;
  const leaseOwner = randomUUID();
  await prisma.user.create({ data: { id: ownerId, email: `notify-lock-${ownerId}@runner-door.invalid`, name: 'The owner', passwordHash: 'x' } });
  await prisma.runner.create({ data: { id: runnerId, ownerId, name: 'the machine', tokenHash: sha256(runnerToken), maxConcurrent: 16 } });
  await prisma.workspace.create({
    data: { id: workspaceId, ownerId, runnerId, name: 'the checkout', enabled: true, workDir: mkdtempSync(path.join(tmpdir(), 'notify-lock-')) },
  });
  const connection = {
    linkToken: signRunnerLinkToken(
      link.config!,
      { runnerId, ownerId, cellId: 'cell-1', leaseOwner, credential: runnerLinkCredential(sha256(runnerToken)) },
      new Date(),
    ).token,
    headers: { 'x-orbit-supported-providers': PROVIDERS, 'x-orbit-runner-capabilities': 'session-terminal-handoff-v1' },
  };

  async function liveSession(title: string): Promise<{ sessionId: string; turnId: string }> {
    const sessionId = randomUUID();
    const turnId = randomUUID();
    const generation = randomUUID();
    await prisma.session.create({
      data: {
        id: sessionId, ownerId, creatorId: ownerId, workspaceId, assignedRunnerId: runnerId, title, prompt: title,
        provider: 'claude', providerBuiltin: true, status: RunStatus.RUNNING, dispatchOrigin: 'USER', startsTaskWork: false,
        startedAt: new Date(), inboxLeaseOwner: leaseOwner, inboxLeaseGeneration: generation,
      },
    });
    await prisma.inboxLeaseGeneration.create({ data: { generation, sessionId, leaseOwner } });
    await prisma.conversationTurn.create({
      data: { id: turnId, sessionId, seq: 1, clientTurnId: randomUUID(), kind: 'message', content: title, status: 'IN_FLIGHT' },
    });
    return { sessionId, turnId };
  }
  const ev = (seq: number, type: string, payload: unknown, turnId: string) => ({ seq, type, ts: new Date().toISOString(), turnId, payload });
  type Batch = { sessionId: string; events: unknown[] };
  const merged = (port: number, batches: Batch[]) => sendRequest(port, 'POST', MERGED, { authorization: `Bearer ${GATEWAY_TOKEN}` }, {
    connections: [connection],
    batches: batches.map((batch) => ({ connection: 0, sessionId: batch.sessionId, events: batch.events })),
  });
  const alone = (port: number, batch: Batch) => sendRequest(port, 'POST', `/api/runner/sessions/${batch.sessionId}/events`, {
    authorization: `Bearer ${GATEWAY_TOKEN}`, 'x-orbit-runner-link-token': connection.linkToken, ...connection.headers,
  }, { leaseOwner, events: batch.events }).answer;

  const storedSeqs = async (sessionId: string) =>
    (await sql.query<{ seq: number }>('SELECT seq FROM run_event WHERE session_id = $1 ORDER BY seq', [sessionId])).rows.map((r) => r.seq);
  /** What a stream of the session on this apiserver receives, as seq:type. */
  function watch(realtime: RealtimeService, sessionId: string) {
    const seen: string[] = [];
    const subscription = realtime.streamForRun(sessionId).subscribe((e: NormalizedRunEvent) => {
      if (e.seq > 0) seen.push(`${e.seq}:${e.type}`);
    });
    t.after(() => subscription.unsubscribe());
    return seen;
  }

  /** The backend granted the notification-queue lock, and what it waits on. */
  async function lockHolder(): Promise<{ pid: number; waitEvent: string | null } | null> {
    const { rows } = await sql.query<{ pid: number; wait_event: string | null }>(`
      SELECT l.pid, a.wait_event FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid
       WHERE l.locktype = 'object' AND l.database = 0 AND l.classid = 1262 AND l.objid = 0
         AND l.mode = 'AccessExclusiveLock' AND l.granted`);
    return rows[0] ? { pid: rows[0].pid, waitEvent: rows[0].wait_event } : null;
  }
  const lockWaiters = async () => (await sql.query<{ n: number }>(`
    SELECT count(*)::int AS n FROM pg_locks
     WHERE locktype = 'object' AND database = 0 AND classid = 1262 AND objid = 0 AND NOT granted`)).rows[0].n;

  /**
   * Hold the notification-queue lock: a transaction that sent a NOTIFY, stuck in its COMMIT waiting for a standby that
   * does not exist. Resolves once pg_locks shows it holding the lock; the function it resolves to lets it go.
   */
  async function holdNotifyLock(): Promise<() => Promise<void>> {
    await sql.query(`ALTER SYSTEM SET synchronous_standby_names = '${NO_SUCH_STANDBY}'`);
    await sql.query('SELECT pg_reload_conf()');
    // The standby is taken up by the checkpointer after the reload, so a commit made too soon does not wait: try again.
    for (let attempt = 1; ; attempt += 1) {
      const blocker = new Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
      await blocker.connect();
      await blocker.query('SET synchronous_commit = on');
      const { rows: [{ pid }] } = await blocker.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
      await blocker.query('BEGIN');
      await blocker.query('CREATE TEMPORARY TABLE orbit_spec_notify_lock_holder (x int)');
      await blocker.query(`SELECT pg_notify('orbit_spec_notify_lock', 'held')`);
      let committed = false;
      const commit = blocker.query('COMMIT').then(() => {
        committed = true;
      });
      const deadline = Date.now() + 2_000;
      while (!committed && Date.now() < deadline) {
        const holder = await lockHolder();
        if (holder?.pid === pid && holder.waitEvent === 'SyncRep') {
          return async () => {
            await unsetStandby();
            await commit;
            await blocker.end();
          };
        }
        await sleep(25);
      }
      await commit;
      await blocker.end();
      assert.ok(attempt < 20, 'a COMMIT never waited for the standby named, holding the notification lock');
      await sleep(100);
    }
  }

  await t.test('(1) the lock held past LINK_CALL_LOCK_TIMEOUT_MS: the merged call commits, its notice waits outside it', async () => {
    const one = await liveSession('one');
    const two = await liveSession('two');
    const batches: Batch[] = [
      { sessionId: one.sessionId, events: [ev(1, RunEventType.USER, { text: 'go' }, one.turnId), ev(2, RunEventType.ASSISTANT, { text: 'going' }, one.turnId)] },
      { sessionId: two.sessionId, events: [ev(1, RunEventType.ASSISTANT, { text: 'two answers' }, two.turnId)] },
    ];
    const there = { one: watch(watcher, one.sessionId), two: watch(watcher, two.sessionId) };
    const notesBefore = notes.length;
    const release = await holdNotifyLock();
    let released = false;
    try {
      const call = merged(door.linkPort, batches);
      let early: Answer | undefined;
      void call.answer.then((a) => (early = a), () => undefined);
      await sleep(LINK_CALL_LOCK_TIMEOUT_MS + 750);
      const holder = await lockHolder();
      assert.equal(holder?.waitEvent, 'SyncRep', 'the lock is still held, past the merged call\'s lock timeout');
      // Committed while the lock is held: before the fix the call's COMMIT queued here, failed on its lock timeout,
      // rolled back, and every batch was answered sendAlone.
      assert.deepEqual(
        { one: await storedSeqs(one.sessionId), two: await storedSeqs(two.sessionId) },
        { one: [1, 2], two: [1] },
        `the merged call stored its batches though the notification lock was held; its answer so far: ${JSON.stringify(early?.body ?? null)}`,
      );
      assert.ok(await lockWaiters() >= 1, 'the call\'s notice waits for the lock, outside the transaction');
      assert.equal(early, undefined, 'the call is answered once its notice is out, not before');
      assert.deepEqual(notes.slice(notesBefore).filter((n) => n.r === one.sessionId || n.r === two.sessionId), [], 'nobody told yet');
      await release();
      released = true;
      const answer = await call.answer;
      assert.equal(answer.status, 200, JSON.stringify(answer.body));
      assert.deepEqual(answer.body.results, [
        { ok: true, durableSeq: 2, rejected: [] },
        { ok: true, durableSeq: 1, rejected: [] },
      ], 'no batch is sent alone');
      await until('the watching apiserver handed every event', () => there.one.length >= 2 && there.two.length >= 1);
      await sleep(NOTIFY_SETTLE_MS);
      assert.deepEqual(there, { one: ['1:user', '2:assistant'], two: ['1:assistant'] });
      for (const { sessionId } of [one, two]) {
        assert.equal(notes.slice(notesBefore).filter((n) => n.r === sessionId).length, 1, `one notice of ${sessionId}`);
      }
    } finally {
      if (!released) await release().catch(() => undefined);
    }
  });

  await t.test('(2) the process dies between the commit and the notice: the batch sent again reaches every apiserver', async () => {
    const one = await liveSession('resent merged');
    const two = await liveSession('resent alone');
    const batches: Batch[] = [
      { sessionId: one.sessionId, events: [ev(1, RunEventType.ASSISTANT, { text: 'first' }, one.turnId), ev(2, RunEventType.TOOL_USE, { id: 'toolu_d1', name: 'Bash', input: {} }, one.turnId)] },
      { sessionId: two.sessionId, events: [ev(1, RunEventType.ASSISTANT, { text: 'second' }, two.turnId)] },
    ];
    const there = { one: watch(watcher, one.sessionId), two: watch(watcher, two.sessionId) };
    const backup = { one: watch(elsewhere, one.sessionId), two: watch(elsewhere, two.sessionId) };
    const notesBefore = notes.length;
    // The origin dies at the point the fix introduces: committed, its notice never sent, its call never answered.
    const own = Object.getOwnPropertyDescriptor(origin, 'sendNotices');
    let reachedNotice = false;
    (origin as unknown as { sendNotices: () => Promise<void> }).sendNotices = () => {
      reachedNotice = true;
      return new Promise<void>(() => undefined);
    };
    try {
      const call = merged(door.linkPort, batches);
      call.answer.catch(() => undefined);
      await until('the merged call committed', async () => (await storedSeqs(one.sessionId)).length === 2 && (await storedSeqs(two.sessionId)).length === 1);
      await until('the call at its notice', () => reachedNotice);
      call.req.destroy(); // the connection the gateway held goes with the process
      await sleep(NOTIFY_SETTLE_MS);
      assert.deepEqual({ there, backup }, { there: { one: [], two: [] }, backup: { one: [], two: [] } }, 'no other apiserver heard of the batches');
      assert.deepEqual(notes.slice(notesBefore).filter((n) => n.r === one.sessionId || n.r === two.sessionId), []);
    } finally {
      if (own) Object.defineProperty(origin, 'sendNotices', own);
      else delete (origin as unknown as { sendNotices?: unknown }).sendNotices;
    }
    // The gateway sends the call again to its other backend, with only the first batch in it (the second's runner had its
    // batch failed and sends it alone), and each ingest finds its seqs stored.
    const again = await merged(door2.linkPort, [batches[0]]).answer;
    assert.equal(again.status, 200, JSON.stringify(again.body));
    assert.deepEqual(again.body.results, [{ ok: true, durableSeq: 2, rejected: [] }]);
    const resent = await alone(door2.linkPort, batches[1]);
    assert.equal(resent.status, 202, JSON.stringify(resent.body));
    assert.deepEqual(resent.body, { ok: true, durableSeq: 1, rejected: [] });
    await until('every apiserver handed the stored events',
      () => there.one.length >= 2 && there.two.length >= 1 && backup.one.length >= 2 && backup.two.length >= 1);
    await sleep(NOTIFY_SETTLE_MS);
    assert.deepEqual(there, { one: ['1:assistant', '2:tool_use'], two: ['1:assistant'] }, 'the watching apiserver, read back');
    assert.deepEqual(backup, { one: ['1:assistant', '2:tool_use'], two: ['1:assistant'] }, 'the apiserver that took the resend, its own streams');
    // Announced again as the seqs to read back, once each.
    const said = notes.slice(notesBefore).filter((n) => n.r === one.sessionId || n.r === two.sessionId)
      .map((n) => ({ r: n.r === one.sessionId ? 'one' : 'two', f: n.f, t: n.t, b: n.b }));
    assert.deepEqual(said, [{ r: 'one', f: 1, t: 2, b: undefined }, { r: 'two', f: 1, t: 1, b: undefined }]);
    assert.deepEqual({ one: await storedSeqs(one.sessionId), two: await storedSeqs(two.sessionId) }, { one: [1, 2], two: [1] }, 'nothing stored twice');
  });
});
