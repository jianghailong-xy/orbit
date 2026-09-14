/**
 * Independent QA of the Watch core backend, against a real PostgreSQL.
 *
 * Written by the QA session for task 34DH29mTc7OQ6AwxAFIJu, not by the sessions that built the Watch
 * tables, API, evaluator and delivery worker, and it changes none of their code. Every fault is
 * injected from outside the product: a table lock that parks a transaction halfway through its
 * landing, a replica whose events never reach an evaluator, a worker that claims and never settles,
 * a runner process replaced while it holds a turn. Each case drives the production services and the
 * production runner door, and asserts what docs/watch-contract.md promises: one Match per generation,
 * one effect per Match, no concurrent run of an observer, and recovery that does not wait for a hint.
 *
 *     bash scripts/run-pg-spec.sh src/apiserver/src/watches/watch-core-qa.pg.spec.ts
 *
 * run-pg-spec.sh strips --test-name-pattern, so `WATCH_QA_ONLY=QA-03,QA-06` registers only those cases.
 * Non-destructive: every row carries an id this run generated, and each case first retires what
 * earlier cases left live, so the loops a case starts only find that case's rows.
 */
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { after, before, beforeEach, test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';

import { ConflictException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { PrismaClient } from '@prisma/client';
import { NormalizedRunEvent, RunEventType, SessionEndReason, SessionLifecycleState } from '@orbit/shared';
import { Client } from 'pg';

import { prismaClientFor } from '../prisma/prisma-client';
import { PrismaService } from '../prisma/prisma.service';
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from '../projects/coordinator-pg-test-safety';
import { PushService } from '../push/push.service';
import { QueueService } from '../queue/queue.service';
import { RealtimeService } from '../realtime/realtime.service';
import { RunnerApiController } from '../runner-api/runner-api.controller';
import { SessionsService } from '../sessions/sessions.service';
import type { CreateWatchDto } from './dto';
import { WatchDeliveryOptions, WatchDeliveryService } from './watch-delivery.service';
import { WatchEvaluatorOptions, WatchEvaluatorService } from './watch-evaluator.service';
import { WatchesService } from './watches.service';

const URL = process.env.COORDINATOR_PG_URL;
const skip = !URL;
const ONLY = (process.env.WATCH_QA_ONLY ?? '').split(',').map((id) => id.trim()).filter(Boolean);
const HOUR = 60 * 60 * 1000;

function qa(id: string, title: string, timeout: number, body: () => Promise<void>): void {
  if (ONLY.length > 0 && !ONLY.includes(id)) return;
  test(`${id} ${title}`, { skip, timeout }, body);
}

/** One line of what a case observed, kept in the TAP output as evidence. */
function note(id: string, facts: Record<string, unknown>): void {
  console.log(`QA-NOTE ${id} ${JSON.stringify(facts)}`);
}

type Target = { kind: 'TASK' | 'SESSION'; id: string };
const tasks = (...ids: string[]): Target[] => ids.map((id) => ({ kind: 'TASK', id }));
const sessionsOf = (...ids: string[]): Target[] => ids.map((id) => ({ kind: 'SESSION', id }));
const ALL = (leaf: string) => ({ kind: 'ALL', over: 'ALL_TARGETS', leaf });
const ANY = (leaf: string) => ({ kind: 'ANY', over: 'ALL_TARGETS', leaf });
/** The contract's canonical request: all of them ended, or any one failed. */
const ENDED_OR_ANY_FAILED = { kind: 'ANY_OF', operands: [ALL('TASK_TERMINAL'), ANY('TASK_FAILED')] };

function watchBody(input: {
  predicate: unknown;
  targets: Target[];
  action: 'NOTIFY_USER' | 'RESUME_SESSION';
  observerSessionId?: string;
  ttlSeconds?: number;
  idempotencyKey?: string;
}): CreateWatchDto {
  return { predicateVersion: 1, ...input } as unknown as CreateWatchDto;
}

/** A collaborator a case does not observe: every method answers undefined. Not a thenable. */
const inert = <T>(): T =>
  new Proxy({}, { get: (_target, property) => (property === 'then' ? undefined : () => undefined) }) as T;

// ── the push service, recording instead of calling APNs ────────────────────────────────────────

interface Ring {
  token: string;
  collapseId?: string;
  watchId?: string;
  generation?: number;
}
const rings: Ring[] = [];
const { privateKey } = generateKeyPairSync('ec', {
  namedCurve: 'prime256v1',
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});
const APNS = {
  get: (key: string) =>
    ({ APNS_KEY_ID: 'watch-qa', APNS_TEAM_ID: 'watch-qa', APNS_KEY: Buffer.from(privateKey).toString('base64') } as Record<
      string,
      string
    >)[key],
} as unknown as ConfigService;

function recordingPush(prisma: PrismaClient): PushService {
  const push = new PushService(prisma as unknown as PrismaService, APNS);
  Object.assign(push, {
    send: async (
      _host: string,
      token: string,
      body: string,
      _auth: string,
      _pushType: string,
      _priority: string,
      collapseId?: string,
    ) => {
      const payload = JSON.parse(body) as { watchID?: string; generation?: number };
      rings.push({ token, collapseId, watchId: payload.watchID, generation: payload.generation });
      return { status: 200 };
    },
  });
  return push;
}

const silentPush = {
  scheduleBadgeSync: () => undefined,
  notifySessionSettled: async () => undefined,
} as unknown as PushService;

/** A replica's realtime hub without the cross-replica LISTEN connection: publishing works as in production. */
class Hub extends RealtimeService {
  constructor(prisma: PrismaClient) {
    super(prisma as unknown as PrismaService, silentPush);
  }

  override async onModuleInit(): Promise<void> {}
}

// ── the harness ────────────────────────────────────────────────────────────────────────────────

let sql: Client;
const clients: PrismaClient[] = [];
const loops: Array<{ stop(): Promise<unknown> }> = [];
const heldLocks: Array<() => Promise<void>> = [];
let queueSignals = 0;

before(async () => {
  if (skip) return;
  assertCoordinatorPgUrlIsIsolated(URL);
  sql = new Client({ connectionString: URL, connectionTimeoutMillis: 5_000 });
  await sql.connect();
  await verifyCoordinatorPgIdentity(sql);
});

beforeEach(async () => {
  if (skip) return;
  await quiesce();
  rings.length = 0;
  queueSignals = 0;
  await sql.query(`UPDATE "watch" SET "state" = 'CANCELLED', "next_evaluate_at" = NULL WHERE "state" IN ('ACTIVE', 'PAUSED')`);
  await sql.query(
    `UPDATE "watch_delivery"
        SET "state" = 'DEAD_LETTER', "dead_lettered_at" = now(), "last_error" = 'retired by the QA harness before a later case',
            "lease_owner" = NULL, "lease_generation" = NULL, "lease_deadline_at" = NULL
      WHERE "state" IN ('PENDING', 'IN_FLIGHT')`,
  );
});

after(async () => {
  if (skip) return;
  await quiesce();
  await sql?.end().catch(() => undefined);
});

/**
 * Stops what a case left running and closes its pools. QA-03 alone opens seventy connections, and a pool keeps
 * idle ones for ten seconds: closed only at the end of the file, the cases right after it open theirs on top,
 * and a PostgreSQL at its default 100 refuses them — `53300 sorry, too many clients already`.
 */
async function quiesce(): Promise<void> {
  for (const release of heldLocks.splice(0)) await release();
  for (const loop of loops.splice(0)) await loop.stop();
  for (const client of clients.splice(0)) await client.$disconnect().catch(() => undefined);
}

/**
 * A pool that has connected, as a running replica's has. A client made moments before a case uses it
 * starts Prisma's engine and opens its first connection inside that first call, and on a starved host the
 * two together outlast the two seconds Prisma waits before a transaction fails to start (P2028).
 */
async function pool(): Promise<PrismaClient> {
  const prisma = prismaClientFor(URL!);
  clients.push(prisma);
  await warm([prisma], 1);
  return prisma;
}

/** pg.Pool's default size, which a PrismaPg built from a URL keeps. */
const POOL_MAX = 10;

/**
 * Opens `connections` connections in each pool before a case bursts work onto it. A replica that has
 * been serving has its pool open when events arrive; a pool made moments before a burst opens them in
 * the middle of it, and on a starved host each new PostgreSQL connection takes seconds — longer than
 * the two seconds Prisma waits for one before a transaction fails to start (P2028). The race would be
 * the connection handshakes, not the hints, landings and inserts the case is about.
 */
async function warm(pools: PrismaClient[], connections = POOL_MAX): Promise<void> {
  await Promise.all(pools.flatMap((prisma) => Array.from({ length: connections }, () => prisma.$executeRaw`SELECT pg_sleep(0.1)`)));
}

interface Replica {
  prisma: PrismaClient;
  hub: Hub;
  evaluator: WatchEvaluatorService;
  watches: WatchesService;
}

/** One apiserver replica as far as Watch evaluation can tell: its own pool, hub and evaluator. */
async function replica(options: WatchEvaluatorOptions = {}): Promise<Replica> {
  const prisma = await pool();
  const hub = new Hub(prisma);
  const evaluator = new WatchEvaluatorService(prisma as unknown as PrismaService, hub, {
    reconcileIntervalMs: HOUR,
    pollIntervalMs: HOUR,
    ...options,
  });
  loops.push(evaluator);
  return { prisma, hub, evaluator, watches: new WatchesService(prisma as unknown as PrismaService) };
}

interface Worker {
  prisma: PrismaClient;
  sessions: SessionsService;
  delivery: WatchDeliveryService;
}

/** One replica's delivery worker: its own pool, the real sessions service and the recording push. */
async function worker(options: WatchDeliveryOptions = {}, hub?: Hub): Promise<Worker> {
  const prisma = await pool();
  const queue = { notifySessionQueued: () => { queueSignals += 1; } };
  const sessions = new SessionsService(prisma as unknown as PrismaService, queue as never, (hub ?? new Hub(prisma)) as never);
  const delivery = new WatchDeliveryService(prisma as unknown as PrismaService, sessions, recordingPush(prisma), {
    retryBaseMs: 0,
    retryMaxMs: 0,
    pollIntervalMs: HOUR,
    ...options,
  });
  loops.push(delivery);
  return { prisma, sessions, delivery };
}

interface RunnerDoor {
  queue: QueueService;
  api: RunnerApiController;
  inbox: {
    dequeueTurn(
      sessionId: string,
      runnerId: string,
      leaseGeneration: string | null,
      acceptsSteer: boolean,
      declaredCapabilities: readonly string[],
    ): Promise<{ turnId: string; kind: string; content?: string } | null>;
  };
}

/** The production runner door and session queue, on one replica's pool and hub. */
function runnerDoor(prisma: PrismaClient, hub: Hub): RunnerDoor {
  const queue = new QueueService(prisma as unknown as PrismaService, hub);
  const api = new RunnerApiController(
    prisma as never,
    queue as never,
    hub as never,
    inert<never>(),
    inert<never>(),
    inert<never>(),
    inert<never>(),
  );
  return { queue, api, inbox: api as unknown as RunnerDoor['inbox'] };
}

/** A transaction on its own connection holding one lock until released. */
async function holdLock(statement: string): Promise<{ release(): Promise<void> }> {
  const client = new Client({ connectionString: URL, connectionTimeoutMillis: 5_000 });
  await client.connect();
  await client.query('BEGIN');
  await client.query(statement);
  let released = false;
  const release = async () => {
    if (released) return;
    released = true;
    await client.query('COMMIT').catch(() => undefined);
    await client.end().catch(() => undefined);
  };
  heldLocks.push(release);
  return { release };
}

/** Backends of this database waiting on a heavyweight lock in a statement containing `fragment`. */
async function lockWaiters(fragment: string): Promise<number> {
  const { rows } = await sql.query<{ n: number }>(
    `SELECT count(*)::int AS "n" FROM pg_stat_activity
      WHERE "datname" = current_database() AND "wait_event_type" = 'Lock' AND position($1 in "query") > 0`,
    [fragment],
  );
  return rows[0].n;
}

/** Samples a predicate over committed rows until finished; a violation is any non-null answer. */
function invariant(check: () => Promise<string | null>): { finish(): Promise<string[]> } {
  const violations: string[] = [];
  let running = true;
  const loop = (async () => {
    while (running) {
      const violation = await check().catch((error: unknown) => `probe failed: ${String(error)}`);
      if (violation) violations.push(violation);
      await sleep(20, undefined, { ref: false });
    }
  })();
  const finish = async () => {
    running = false;
    await loop;
    return violations;
  };
  // A case that fails before it finishes has quiesce() stop the probe. Every check reads through `sql`:
  // the probe no longer opens a connection of its own that nothing read, which a failed case left open —
  // keeping this process alive until run-pg-spec killed it — and which a starved host could fail to open
  // within its five seconds by itself.
  loops.push({ stop: finish });
  return { finish };
}

async function eventually<T>(what: string, read: () => Promise<T>, done: (value: T) => boolean, timeoutMs = 30_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (done(value)) return value;
    if (Date.now() > deadline) assert.fail(`${what}: gave up after ${timeoutMs}ms at ${JSON.stringify(value)}`);
    await sleep(25);
  }
}

const runEvent = (type: RunEventType, payload: Record<string, unknown> = {}): NormalizedRunEvent => ({
  seq: 0,
  type,
  ts: new Date().toISOString(),
  payload,
});

// ── fixtures ───────────────────────────────────────────────────────────────────────────────────

async function insertUser(): Promise<string> {
  const id = randomUUID();
  await sql.query(`INSERT INTO "user"("id","email","name","password_hash") VALUES ($1,$2,'watch qa','h')`, [
    id,
    `${id}@watch-qa.invalid`,
  ]);
  return id;
}

async function insertRunner(owner: string): Promise<string> {
  const id = randomUUID();
  await sql.query(
    `INSERT INTO "runner"("id","name","owner_id","token_hash","status","last_heartbeat_at","capabilities","max_concurrent")
     VALUES ($1,'watch qa runner',$2,$3,'ONLINE',clock_timestamp(),'{}'::text[],8)`,
    [id, owner, randomUUID()],
  );
  return id;
}

async function insertDevice(owner: string): Promise<void> {
  await sql.query(
    `INSERT INTO "device_token"("id","user_id","token","platform","environment","bundle_id","updated_at")
     VALUES ($1,$2,$3,'ios','production','io.orbitd.app',now())`,
    [randomUUID(), owner, `device-${randomUUID()}`],
  );
}

async function insertTask(owner: string, status: string): Promise<string> {
  const id = randomUUID();
  await sql.query(
    `INSERT INTO "task"("id","title","owner_id","creator_type","creator_id","updated_at","completion_criterion","status")
     VALUES ($1,'watched work',$2,'USER',$2,now(),'EVIDENCE_JUDGMENT',$3)`,
    [id, owner, status],
  );
  return id;
}

/** A conversation that has run: established runtime, and its opening turn already answered. */
async function insertSession(owner: string, status: string, runnerId: string | null): Promise<string> {
  const id = randomUUID();
  await sql.query(
    `INSERT INTO "session"("id","title","prompt","owner_id","creator_id","updated_at","status","assigned_runner_id",
                           "provider","provider_builtin","num_turns","started_at","runtime_session_id")
     VALUES ($1,'watch qa','the opening prompt',$2,$2,now(),$3,$4,'claude',TRUE,1,now(),$5)`,
    [id, owner, status, runnerId, `runtime-${id}`],
  );
  await sql.query(
    `INSERT INTO "conversation_turn"("id","session_id","seq","client_turn_id","kind","content","status","delivered_at","answered_at")
     VALUES ($1,$2,1,$3,'message','the opening prompt','ANSWERED',now(),now())`,
    [randomUUID(), id, `initial-${id}`],
  );
  return id;
}

/** The turn a RUNNING session is executing, leased to its runner. */
async function insertRunningTurn(sessionId: string, seq: number): Promise<string> {
  const id = randomUUID();
  await sql.query(
    `INSERT INTO "conversation_turn"("id","session_id","seq","client_turn_id","kind","content","status","delivered_at","lease_deadline_at")
     VALUES ($1,$2,$3,$4,'message','the turn the session is running','IN_FLIGHT',now(),now() + interval '10 minutes')`,
    [id, sessionId, seq, `running-${id}`],
  );
  return id;
}

// ── reads ──────────────────────────────────────────────────────────────────────────────────────

const MICROS = `'YYYY-MM-DD"T"HH24:MI:SS.US'`;

interface WatchRead {
  state: string;
  generation: number;
  nextEvaluateAt: string | null;
  evaluatedAt: string | null;
  due: boolean | null;
  /** An evaluator landed a decision after creation. A claim alone moves next_evaluate_at too, so `due` cannot say this. */
  landed: boolean | null;
}

async function watchRow(id: string): Promise<WatchRead> {
  const { rows } = await sql.query<WatchRead>(
    `SELECT "state", "generation",
            to_char("next_evaluate_at" AT TIME ZONE 'UTC', ${MICROS}) AS "nextEvaluateAt",
            to_char("last_evaluated_at" AT TIME ZONE 'UTC', ${MICROS}) AS "evaluatedAt",
            "next_evaluate_at" <= now() AS "due",
            "last_evaluated_at" > "created_at" AS "landed"
       FROM "watch" WHERE "id" = $1`,
    [id],
  );
  return rows[0];
}

/** The first evaluation a loop landed for a watch it has not decided yet, with the schedule that landing wrote. */
async function landedEvaluation(id: string, timeoutMs = 30_000): Promise<WatchRead> {
  return eventually(`an evaluation of ${id} to land`, () => watchRow(id), (row) => row.landed === true && row.due === false, timeoutMs);
}

interface MatchRead {
  id: string;
  generation: number;
  reason: string;
  matchedAt: string;
}

async function matchesOf(watchId: string): Promise<MatchRead[]> {
  const { rows } = await sql.query<MatchRead>(
    `SELECT "id", "generation", "reason", to_char("matched_at" AT TIME ZONE 'UTC', ${MICROS}) AS "matchedAt"
       FROM "watch_match" WHERE "watch_id" = $1 ORDER BY "generation"`,
    [watchId],
  );
  return rows;
}

interface DeliveryRead {
  id: string;
  state: string;
  attempts: number;
  lastError: string | null;
  leaseLapsed: boolean | null;
}

async function deliveriesOf(watchId: string): Promise<DeliveryRead[]> {
  const { rows } = await sql.query<DeliveryRead>(
    `SELECT d."id", d."state", d."attempts", d."last_error" AS "lastError", d."lease_deadline_at" <= now() AS "leaseLapsed"
       FROM "watch_delivery" d JOIN "watch_match" m ON m."id" = d."match_id"
      WHERE m."watch_id" = $1 ORDER BY d."created_at", d."id"`,
    [watchId],
  );
  return rows;
}

async function targetsOf(watchId: string): Promise<Record<string, string>> {
  const { rows } = await sql.query<{ id: string; state: string }>(
    `SELECT "target_resource_id" AS "id", "state" FROM "watch_target" WHERE "watch_id" = $1`,
    [watchId],
  );
  return Object.fromEntries(rows.map((row) => [row.id, row.state]));
}

interface TurnRead {
  id: string;
  seq: number;
  clientTurnId: string;
  kind: string;
  status: string;
  content: string | null;
}

async function turnsOn(sessionId: string): Promise<TurnRead[]> {
  const { rows } = await sql.query<TurnRead>(
    `SELECT "id", "seq", "client_turn_id" AS "clientTurnId", "kind", "status", "content"
       FROM "conversation_turn" WHERE "session_id" = $1 ORDER BY "seq"`,
    [sessionId],
  );
  return rows;
}

/** Every turn any session holds under this watch's keys — a wake written anywhere counts. */
async function wakesOf(watchId: string): Promise<TurnRead[]> {
  const { rows } = await sql.query<TurnRead>(
    `SELECT "id", "seq", "client_turn_id" AS "clientTurnId", "kind", "status", "content"
       FROM "conversation_turn" WHERE "client_turn_id" LIKE $1 ORDER BY "seq"`,
    [`watch:${watchId}:%`],
  );
  return rows;
}

async function statusOf(sessionId: string): Promise<string> {
  const { rows } = await sql.query<{ status: string }>(`SELECT "status" FROM "session" WHERE "id" = $1`, [sessionId]);
  return rows[0].status;
}

// ── cases ──────────────────────────────────────────────────────────────────────────────────────

qa('QA-01', 'normal path, NOTIFY_USER: the running loops match a hinted change once and ring each device once', 120_000, async () => {
  const owner = await insertUser();
  await insertDevice(owner);
  await insertDevice(owner);
  const [first, second, third] = [await insertTask(owner, 'OPEN'), await insertTask(owner, 'OPEN'), await insertTask(owner, 'OPEN')];
  // The sweep is an hour out, so anything that matches within seconds was moved by the hint.
  const server = await replica({ pollIntervalMs: 200 });
  const deliveries = await worker({ pollIntervalMs: 100 });
  server.evaluator.start();
  deliveries.delivery.start();

  const created = await server.watches.create(owner, watchBody({
    predicate: ENDED_OR_ANY_FAILED,
    targets: tasks(first, second, third),
    action: 'NOTIFY_USER',
    ttlSeconds: 2 * 3600,
  }));
  assert.equal(created.state, 'ACTIVE');
  assert.deepEqual(created.matches, []);
  const scheduled = await landedEvaluation(created.id);
  assert.equal(scheduled.state, 'ACTIVE');

  // One task fails; the task door publishes TASK_CHANGED on the replica that wrote it.
  await sql.query(`UPDATE "task" SET "status" = 'FAILED' WHERE "id" = $1`, [second]);
  const changedAt = Date.now();
  server.hub.publishForUser(owner, RunEventType.TASK_CHANGED, { taskIds: [second], resync: false });
  const [match] = await eventually('the hinted Match', () => matchesOf(created.id), (rows) => rows.length === 1, 15_000);
  assert.ok(match.matchedAt < scheduled.nextEvaluateAt!, 'the Match waited for the sweep instead of the hint');
  assert.equal(match.generation, 1);
  assert.match(match.reason, /ANY TASK_FAILED 1\/3/);

  const [delivered] = await eventually('the notification', () => deliveriesOf(created.id), (rows) => rows[0]?.state === 'DELIVERED', 15_000);
  note('QA-01', { hintToMatchMs: Date.now() - changedAt, attempts: delivered.attempts });

  // More passes and more changes: nothing new is recorded and nobody is rung again.
  await sql.query(`UPDATE "task" SET "status" = 'CANCELLED' WHERE "id" = ANY($1::uuid[])`, [[first, third]]);
  server.hub.publishForUser(owner, RunEventType.TASK_CHANGED, { taskIds: [first, third], resync: false });
  server.evaluator.kick();
  deliveries.delivery.kick();
  await sleep(1_500);
  assert.equal((await matchesOf(created.id)).length, 1);
  assert.equal((await deliveriesOf(created.id)).length, 1);
  const rung = rings.filter((ring) => ring.watchId === created.id);
  assert.equal(rung.length, 2, 'one notification, once to each of the two devices');
  assert.deepEqual([...new Set(rung.map((ring) => ring.collapseId))], [`watch-${created.id}-1`]);

  const view = await server.watches.get(owner, created.id);
  assert.equal(view.state, 'MATCHED');
  assert.equal(view.generation, 1);
  assert.equal(view.nextEvaluateAt, null);
  assert.deepEqual(
    view.matches.map((row) => row.deliveries.map(({ state, attempts }) => ({ state, attempts }))),
    [[{ state: 'DELIVERED', attempts: 0 }]],
  );
});

qa('QA-02', 'normal path, RESUME_SESSION: a settled target wakes a parked observer through the queue, the runner claim and the inbox, and a replaced runner process is handed the same one turn', 180_000, async () => {
  const owner = await insertUser();
  const runner = await insertRunner(owner);
  const observer = await insertSession(owner, 'AWAITING_INPUT', runner);
  const target = await insertSession(owner, 'RUNNING', runner);
  const targetTurn = await insertRunningTurn(target, 2);
  // Correctness only. How soon the runner door's completion reaches the evaluator is D3's question
  // (watch-core-qa-defects.pg.spec.ts), so a short sweep keeps this case from waiting on it.
  const server = await replica({ reconcileIntervalMs: 5_000, pollIntervalMs: 200 });
  const deliveries = await worker({ pollIntervalMs: 100 }, server.hub);
  const door = runnerDoor(server.prisma, server.hub);
  server.evaluator.start();
  deliveries.delivery.start();

  const watch = await server.watches.create(owner, watchBody({
    predicate: ALL('SESSION_TURN_SETTLED'),
    targets: sessionsOf(target),
    action: 'RESUME_SESSION',
    observerSessionId: observer,
  }));
  assert.equal(watch.state, 'ACTIVE');
  const scheduled = await landedEvaluation(watch.id);

  // The watched session's turn completes through the runner door, as a runner reports it.
  const completedAt = Date.now();
  await door.api.turnComplete({ id: runner }, target, {
    turnId: targetTurn,
    status: 'SUCCEEDED',
    subtype: 'completed',
    numTurns: 2,
    costUsd: 0,
  } as never);
  assert.equal(await statusOf(target), 'AWAITING_INPUT');
  const [match] = await eventually('the Match', () => matchesOf(watch.id), (rows) => rows.length === 1, 60_000);
  note('QA-02', {
    completionToMatchMs: Date.now() - completedAt,
    matchedAt: match.matchedAt,
    sweepDueAt: scheduled.nextEvaluateAt,
    matchedBeforeSweep: match.matchedAt < scheduled.nextEvaluateAt!,
  });

  // The delivery queues exactly one turn, and a parked observer waits for a runner slot.
  const [wake] = await eventually('the wake turn', () => wakesOf(watch.id), (rows) => rows.length === 1, 15_000);
  assert.equal(wake.clientTurnId, `watch:${watch.id}:1`);
  assert.equal(wake.kind, 'message');
  assert.equal(wake.status, 'PENDING');
  assert.equal((await turnsOn(observer)).filter((turn) => turn.id === wake.id).length, 1, 'the wake is on the observer');
  await eventually('the delivery to settle', () => deliveriesOf(watch.id), (rows) => rows[0]?.state === 'DELIVERED');
  assert.equal(await statusOf(observer), 'PENDING');

  // A runner slot claims the observer.
  const claimed = await door.queue.claimSessionForRunner({ id: runner, supportedProviders: ['claude'] as never }, 0, false, false);
  assert.equal(claimed?.sessionId, observer, 'the runner claimed something other than the woken observer');
  assert.equal(await statusOf(observer), 'RUNNING');

  // Runner process P1 takes the inbox and is handed the wake, with its structured payload.
  const [p1, g1] = [randomUUID(), randomUUID()];
  await door.api.takeoverLeases({ id: runner }, observer, { leaseOwner: p1, expectedLeaseOwner: null } as never);
  await door.api.activateLeases({ id: runner }, observer, { leaseGeneration: g1, leaseOwner: p1 } as never);
  const handed = await door.inbox.dequeueTurn(observer, runner, g1, false, []);
  assert.equal(handed?.turnId, wake.id);
  const payload = JSON.parse(/```json\n([\s\S]*?)\n```/.exec(handed?.content ?? '')?.[1] ?? 'null') as {
    watchId?: string;
    generation?: number;
    changedTargets?: Array<{ id: string }>;
  } | null;
  assert.equal(payload?.watchId, watch.id);
  assert.equal(payload?.generation, 1);
  assert.deepEqual(payload?.changedTargets?.map((changed) => changed.id), [target]);

  // P1 dies holding the turn. P2 takes over and activates; P1's generation is refused.
  const [p2, g2] = [randomUUID(), randomUUID()];
  await door.api.takeoverLeases({ id: runner }, observer, { leaseOwner: p2, expectedLeaseOwner: p1 } as never);
  await door.api.activateLeases({ id: runner }, observer, { leaseGeneration: g2, leaseOwner: p2 } as never);
  await assert.rejects(door.inbox.dequeueTurn(observer, runner, g1, false, []), ConflictException);
  const redelivered = await door.inbox.dequeueTurn(observer, runner, g2, false, []);
  assert.equal(redelivered?.turnId, wake.id, 'the replacement process was not handed the wake');
  assert.equal(await door.inbox.dequeueTurn(observer, runner, g2, false, []), null, 'a second turn was handed out');
  await door.api.turnComplete({ id: runner }, observer, {
    turnId: wake.id,
    status: 'SUCCEEDED',
    subtype: 'completed',
    numTurns: 2,
    costUsd: 0,
    leaseOwner: p2,
  } as never);
  assert.equal(await statusOf(observer), 'AWAITING_INPUT');

  // One generation: one Match, one delivery, one turn — however many passes follow.
  server.evaluator.kick();
  deliveries.delivery.kick();
  await sleep(1_000);
  assert.equal((await matchesOf(watch.id)).length, 1);
  const [settled, ...more] = await deliveriesOf(watch.id);
  assert.deepEqual(more, []);
  assert.deepEqual([settled.state, settled.attempts], ['DELIVERED', 0]);
  const wakes = await wakesOf(watch.id);
  assert.deepEqual(wakes.map((turn) => [turn.id, turn.status]), [[wake.id, 'ANSWERED']]);
});

qa('QA-03', 'duplicate, irrelevant and out-of-order hints over four replicas, and a hint that arrives before its write commits: one Match, one delivery, one notification', 180_000, async () => {
  const owner = await insertUser();
  await insertDevice(owner);
  const [first, second, third] = [await insertTask(owner, 'OPEN'), await insertTask(owner, 'OPEN'), await insertTask(owner, 'OPEN')];
  const replicas = await Promise.all([0, 1, 2, 3].map(() => replica({ pollIntervalMs: 50, reconcileIntervalMs: 3_000 })));
  const workers = await Promise.all([0, 1, 2].map(() => worker({ pollIntervalMs: 50 })));
  const pools = [...replicas, ...workers].map(({ prisma }) => prisma);
  await warm(pools); // for step 1's storm; step 3's flood comes after their idle connections have closed
  // Every hint a replica is handed, published or direct, until it has reached the database.
  const hinting = new Set<Promise<number>>();
  for (const { evaluator } of replicas) {
    const hint = evaluator.hint.bind(evaluator);
    evaluator.hint = (kind, ids) => {
      const applying = hint(kind, ids);
      hinting.add(applying);
      void applying.finally(() => hinting.delete(applying));
      return applying;
    };
  }
  const watch = await replicas[0].watches.create(owner, watchBody({
    predicate: ALL('TASK_TERMINAL'),
    targets: tasks(first, second, third),
    action: 'NOTIFY_USER',
  }));
  for (const { evaluator } of replicas) evaluator.start();
  for (const { delivery } of workers) delivery.start();
  const consistent = invariant(async () => {
    const { rows: [row] } = await sql.query<{ state: string; matches: number; deliveries: number }>(
      `SELECT w."state",
              (SELECT count(*)::int FROM "watch_match" m WHERE m."watch_id" = w."id") AS "matches",
              (SELECT count(*)::int FROM "watch_delivery" d JOIN "watch_match" m ON m."id" = d."match_id" WHERE m."watch_id" = w."id") AS "deliveries"
         FROM "watch" w WHERE w."id" = $1`,
      [watch.id],
    );
    if (row.matches > 1 || row.deliveries > 1) return `duplicated: ${JSON.stringify(row)}`;
    if ((row.state === 'MATCHED') !== (row.matches === 1) || row.matches !== row.deliveries) return `torn: ${JSON.stringify(row)}`;
    return null;
  });

  // 1. One target ends; a storm of duplicate, irrelevant and scattered hints and direct evaluations.
  await sql.query(`UPDATE "task" SET "status" = 'CANCELLED' WHERE "id" = $1`, [first]);
  const shapes = [[first], [second], [third], [third, second, first], [randomUUID()], [second, randomUUID()]];
  const storm: Array<Promise<unknown>> = [];
  for (let i = 0; i < 120; i += 1) {
    const { hub, evaluator } = replicas[i % replicas.length];
    const ids = shapes[i % shapes.length];
    if (i % 3 === 0) hub.publishForUser(owner, RunEventType.TASK_CHANGED, { taskIds: ids, resync: false });
    else storm.push(evaluator.hint('TASK', ids));
    if (i % 10 === 0) storm.push(evaluator.evaluate(watch.id));
  }
  await Promise.all(storm);
  await eventually('the ended target to be recorded', () => targetsOf(watch.id), (states) => states[first] === 'SATISFIED');
  assert.equal((await matchesOf(watch.id)).length, 0, 'matched while two targets were still open');

  // 2. The other two end in one transaction whose events are published before it commits.
  const writer = new Client({ connectionString: URL, connectionTimeoutMillis: 5_000 });
  heldLocks.push(() => writer.end().catch(() => undefined)); // a failure below leaves its transaction open
  await writer.connect();
  await writer.query('BEGIN');
  await writer.query(`UPDATE "task" SET "status" = 'FAILED' WHERE "id" = $1`, [second]);
  await writer.query(`UPDATE "task" SET "status" = 'CANCELLED' WHERE "id" = $1`, [third]);
  const beforeHints = await watchRow(watch.id);
  for (const { hub } of replicas) hub.publishForUser(owner, RunEventType.TASK_CHANGED, { taskIds: [second, third], resync: false });
  // Nothing hinted may still be on its way at the commit. A hint that reaches the database after it, or
  // an evaluation such a hint made due that reads the rows after it, arrived after the commit, and the
  // Match it causes rightly comes before the sweep. So every hint is applied first, and then the last
  // evaluation they caused has landed: its schedule is what is read, not a claim's lease.
  while (hinting.size > 0) await Promise.all(hinting);
  // A claim moves next_evaluate_at a lease (a minute) past now; a landing, the 3s reconciliation past itself.
  const leased = (row: WatchRead) => Date.parse(`${row.nextEvaluateAt}Z`) - Date.parse(`${row.evaluatedAt}Z`) > 30_000;
  const stale = await eventually(
    'an evaluation hinted before the commit to land',
    () => watchRow(watch.id),
    (row) => row.evaluatedAt! > beforeHints.evaluatedAt! && row.due === false && !leased(row),
  );
  assert.equal(stale.state, 'ACTIVE', 'an evaluation read a write that had not committed');
  await writer.query('COMMIT');
  await writer.end();
  const committedAt = Date.now();
  const [match] = await eventually('reconciliation to find the committed change', () => matchesOf(watch.id), (rows) => rows.length === 1, 20_000);
  assert.ok(match.matchedAt >= stale.nextEvaluateAt!, `matched at ${match.matchedAt}, before the sweep it was scheduled for at ${stale.nextEvaluateAt}`);
  note('QA-03', { staleScheduleAt: stale.nextEvaluateAt, matchedAt: match.matchedAt, commitToMatchMs: Date.now() - committedAt });

  // 3. After the Match: hints, evaluations and drains keep arriving on every replica.
  await warm(pools);
  const flood: Array<Promise<unknown>> = [];
  const lateEvaluations: Array<Promise<{ outcome: string }>> = [];
  for (let i = 0; i < 200; i += 1) {
    const { hub, evaluator } = replicas[i % replicas.length];
    flood.push(evaluator.hint('TASK', [first, second, third]));
    if (i % 25 === 0) hub.publishForUser(owner, RunEventType.TASK_CHANGED, { taskIds: [second], resync: false });
    if (i % 20 === 0) lateEvaluations.push(evaluator.evaluate(watch.id));
    if (i % 40 === 0) flood.push(workers[i % workers.length].delivery.drain());
  }
  await Promise.all(flood);
  assert.deepEqual([...new Set((await Promise.all(lateEvaluations)).map((evaluation) => evaluation.outcome))], ['SETTLED']);
  await eventually('the delivery', () => deliveriesOf(watch.id), (rows) => rows[0]?.state === 'DELIVERED', 15_000);
  await sleep(1_000);
  assert.deepEqual(await consistent.finish(), []);
  assert.equal((await matchesOf(watch.id)).length, 1);
  assert.equal((await deliveriesOf(watch.id)).length, 1);
  assert.equal(rings.filter((ring) => ring.watchId === watch.id).length, 1, 'one device rung once');
  const settled = await watchRow(watch.id);
  assert.deepEqual([settled.state, settled.generation, settled.nextEvaluateAt], ['MATCHED', 1, null]);
});

qa('QA-04', 'notifications lost on purpose: events published on a replica whose evaluator is gone never reach the survivor, whose reconciliation still matches every leaf class no earlier than its sweep', 180_000, async () => {
  const owner = await insertUser();
  const runner = await insertRunner(owner);
  const writer = await replica(); // handles the writes and publishes the events; its evaluator is never started
  const survivor = await replica({ reconcileIntervalMs: 2_500, pollIntervalMs: 100 });
  let hintsReachingSurvivor = 0;
  const hint = survivor.evaluator.hint.bind(survivor.evaluator);
  survivor.evaluator.hint = async (kind, ids) => {
    hintsReachingSurvivor += 1;
    return hint(kind, ids);
  };

  const failing = await insertTask(owner, 'OPEN');
  const finished = await insertSession(owner, 'SUCCEEDED', null);
  const asking = await insertSession(owner, 'RUNNING', runner);
  const parking = await insertSession(owner, 'RUNNING', runner);
  const cancelled = await insertTask(owner, 'OPEN');
  const deleted = await insertTask(owner, 'OPEN');
  const create = (predicate: unknown, targets: Target[]) =>
    survivor.watches.create(owner, watchBody({ predicate, targets, action: 'NOTIFY_USER' }));
  const watched: Record<string, string> = {
    failed: (await create(ANY('TASK_FAILED'), tasks(failing))).id,
    completed: (await create(ALL('SESSION_LIFECYCLE_TERMINAL'), sessionsOf(finished))).id,
    attention: (await create(ANY('SESSION_NEEDS_ATTENTION'), sessionsOf(asking))).id,
    settled: (await create(ALL('SESSION_TURN_SETTLED'), sessionsOf(parking))).id,
    gone: (await create(ALL('TASK_TERMINAL'), tasks(cancelled, deleted))).id,
  };
  survivor.evaluator.start();
  const scheduled: Record<string, WatchRead> = {};
  for (const [name, id] of Object.entries(watched)) {
    scheduled[name] = await landedEvaluation(id);
    assert.equal(scheduled[name].state, 'ACTIVE', `${name} matched before anything changed`);
  }

  // Each row changes as production changes it, and the writer publishes the event that would hint.
  await sql.query(`UPDATE "task" SET "status" = 'FAILED' WHERE "id" = $1`, [failing]);
  writer.hub.publishForUser(owner, RunEventType.TASK_CHANGED, { taskIds: [failing], resync: false });
  await sql.query(`UPDATE "session" SET "completed_at" = now(), "archived_at" = now() WHERE "id" = $1`, [finished]);
  writer.hub.publishSessionLifecycleChanged(finished, 'SUCCEEDED', SessionEndReason.COMPLETED, SessionLifecycleState.COMPLETED);
  await sql.query(
    `INSERT INTO "approval"("id","session_id","tool_name","input","status") VALUES ($1,$2,'Bash','{}'::jsonb,'PENDING')`,
    [randomUUID(), asking],
  );
  writer.hub.publish(asking, runEvent(RunEventType.APPROVAL_REQUEST, { approvalId: randomUUID() }));
  await sql.query(`UPDATE "session" SET "status" = 'INTERRUPTED' WHERE "id" = $1`, [parking]);
  writer.hub.publish(parking, runEvent(RunEventType.STATUS, { status: 'INTERRUPTED' }));
  await sql.query(`UPDATE "task" SET "status" = 'CANCELLED' WHERE "id" = $1`, [cancelled]);
  await sql.query(`DELETE FROM "task" WHERE "id" = $1`, [deleted]);
  writer.hub.publishForUser(owner, RunEventType.TASK_CHANGED, { taskIds: [cancelled, deleted], resync: false });

  const matched: Record<string, string> = {};
  for (const [name, id] of Object.entries(watched)) {
    const [match] = await eventually(`${name}: reconciliation`, () => matchesOf(id), (rows) => rows.length === 1, 20_000);
    assert.ok(match.matchedAt >= scheduled[name].nextEvaluateAt!, `${name} matched at ${match.matchedAt}, before its sweep at ${scheduled[name].nextEvaluateAt}`);
    matched[name] = match.matchedAt;
  }
  assert.equal(hintsReachingSurvivor, 0, 'an event published on another replica reached this evaluator');
  assert.deepEqual(await targetsOf(watched.gone), { [cancelled]: 'SATISFIED', [deleted]: 'GONE' });
  note('QA-04', { scheduled: Object.fromEntries(Object.entries(scheduled).map(([k, v]) => [k, v.nextEvaluateAt])), matched });

  // The paired control: on the replica that published, a running evaluator is hinted long before an hour-long sweep.
  await survivor.evaluator.stop();
  const control = await replica({ pollIntervalMs: 200 });
  control.evaluator.start();
  const other = await insertTask(owner, 'OPEN');
  const hinted = await control.watches.create(owner, watchBody({ predicate: ANY('TASK_FAILED'), targets: tasks(other), action: 'NOTIFY_USER' }));
  const first = await landedEvaluation(hinted.id);
  await sql.query(`UPDATE "task" SET "status" = 'FAILED' WHERE "id" = $1`, [other]);
  control.hub.publishForUser(owner, RunEventType.TASK_CHANGED, { taskIds: [other], resync: false });
  const [controlMatch] = await eventually('the hinted control Match', () => matchesOf(hinted.id), (rows) => rows.length === 1, 10_000);
  assert.ok(controlMatch.matchedAt < first.nextEvaluateAt!);
});

qa('QA-05', 'creation races: eight creates forced to collide on one key, a target changing between creation\'s read and its commit, and cancel or pause racing a landing', 180_000, async () => {
  const owner = await insertUser();

  // 1. Eight creates with one key, held at the insert until all of them are there.
  const ended = await insertTask(owner, 'CANCELLED');
  const key = `watch-qa-${randomUUID()}`;
  const body = () => watchBody({ predicate: ALL('TASK_TERMINAL'), targets: tasks(ended), action: 'NOTIFY_USER', idempotencyKey: key });
  const pools = await Promise.all(Array.from({ length: 8 }, () => pool()));
  const services = pools.map((prisma) => new WatchesService(prisma as unknown as PrismaService));
  const gate = await holdLock(`LOCK TABLE "watch" IN SHARE ROW EXCLUSIVE MODE`);
  const racing = services.map((service) => service.create(owner, body()));
  const overlap = await eventually('the creates to reach the insert', () => lockWaiters('INSERT INTO "public"."watch" '), (n) => n >= 8, 3_500)
    .catch(async () => lockWaiters('INSERT INTO "public"."watch" '));
  await gate.release();
  const settled = await Promise.allSettled(racing);
  note('QA-05', { overlappingCreates: overlap });
  assert.ok(overlap >= 2, `only ${overlap} creates were in flight together; the race was not exercised`);
  const made = settled.map((outcome) => (outcome.status === 'fulfilled' ? outcome.value.id : `rejected: ${String(outcome.reason)}`));
  assert.equal(new Set(made).size, 1, `one key answered with more than one outcome: ${JSON.stringify(made)}`);
  const { rows: [{ n }] } = await sql.query<{ n: number }>(
    `SELECT count(*)::int AS "n" FROM "watch" WHERE "owner_id" = $1 AND "idempotency_key" = $2`,
    [owner, key],
  );
  assert.equal(n, 1);
  assert.equal((await matchesOf(made[0])).length, 1);
  assert.equal((await deliveriesOf(made[0])).length, 1);
  // The same key asking for something else is refused and writes nothing.
  await assert.rejects(
    services[0].create(owner, watchBody({ predicate: ANY('TASK_FAILED'), targets: tasks(ended), action: 'NOTIFY_USER', idempotencyKey: key })),
    ConflictException,
  );

  // 2. The target changes after creation read it and before the watch commits; the hint that change
  //    publishes finds no watch. Being created due is what must still catch it.
  const server = await replica({ pollIntervalMs: 100 });
  server.evaluator.start();
  const racingTask = await insertTask(owner, 'OPEN');
  const seam = server.watches as unknown as { readTargets: (...args: unknown[]) => Promise<unknown> };
  const read = seam.readTargets.bind(server.watches);
  let release!: () => void;
  const hold = new Promise<void>((resolve) => { release = resolve; });
  let reached!: () => void;
  const atSeam = new Promise<void>((resolve) => { reached = resolve; });
  seam.readTargets = async (...args: unknown[]) => {
    const observed = await read(...args);
    reached();
    await hold;
    return observed;
  };
  const creating = server.watches.create(owner, watchBody({ predicate: ALL('TASK_TERMINAL'), targets: tasks(racingTask), action: 'NOTIFY_USER' }));
  await atSeam;
  await sql.query(`UPDATE "task" SET "status" = 'FAILED' WHERE "id" = $1`, [racingTask]);
  server.hub.publishForUser(owner, RunEventType.TASK_CHANGED, { taskIds: [racingTask], resync: false });
  assert.equal(await server.evaluator.markDue('TASK', [racingTask]), 0, 'the hint found the uncommitted watch: no race');
  release();
  const created = await creating;
  seam.readTargets = read;
  assert.equal(created.state, 'ACTIVE', 'creation decided from the read it made before the change');
  const [caught] = await eventually('the due watch to be matched without a hint', () => matchesOf(created.id), (rows) => rows.length === 1, 10_000);
  await server.evaluator.stop();
  note('QA-05', { createRaceMatchedAt: caught.matchedAt });

  // 3. Cancel or pause against a landing of the same crossing, twelve rounds.
  const judge = await replica();
  const tally: Record<string, number> = {};
  for (let round = 0; round < 12; round += 1) {
    const work = await insertTask(owner, 'OPEN');
    const live = await judge.watches.create(owner, watchBody({ predicate: ALL('TASK_TERMINAL'), targets: tasks(work), action: 'NOTIFY_USER' }));
    await sql.query(`UPDATE "task" SET "status" = 'FAILED' WHERE "id" = $1`, [work]);
    const verb = round % 2 === 0 ? 'cancel' : 'pause';
    const evaluate = () => judge.evaluator.evaluate(live.id);
    const act = () => (verb === 'cancel' ? judge.watches.cancel(owner, live.id) : judge.watches.pause(owner, live.id));
    // The second half of the rounds starts the transition first, so each side gets its turn at the row.
    let evaluation: PromiseSettledResult<unknown>;
    let transition: PromiseSettledResult<unknown>;
    if (round < 6) {
      [evaluation, transition] = await Promise.allSettled([evaluate(), act()]);
    } else {
      [transition, evaluation] = await Promise.allSettled([act(), evaluate()]);
    }
    const row = await watchRow(live.id);
    const matchCount = (await matchesOf(live.id)).length;
    const deliveryCount = (await deliveriesOf(live.id)).length;
    const facts = JSON.stringify({ verb, row, matchCount, deliveryCount, evaluation: evaluation.status, transition: transition.status });
    assert.equal(evaluation.status, 'fulfilled', facts);
    if (row.state === 'MATCHED') {
      assert.deepEqual([matchCount, deliveryCount], [1, 1], facts);
      assert.equal(transition.status, 'rejected', facts);
      assert.ok(transition.status === 'rejected' && transition.reason instanceof ConflictException, facts);
    } else {
      assert.equal(row.state, verb === 'cancel' ? 'CANCELLED' : 'PAUSED', facts);
      assert.deepEqual([matchCount, deliveryCount], [0, 0], facts);
      assert.equal(transition.status, 'fulfilled', facts);
    }
    tally[`${verb}:${row.state}`] = (tally[`${verb}:${row.state}`] ?? 0) + 1;
  }
  note('QA-05', { cancelPauseRounds: tally });
});

qa('QA-06', 'a worker stalled inside its own transaction past its lease: the evaluator\'s landing and the delivery\'s turn commit once, from whichever attempt the database let finish', 180_000, async () => {
  const owner = await insertUser();
  const runner = await insertRunner(owner);

  // 1. The evaluator: parked at the Match insert, past the lease and past the transaction's time limit.
  const holder = await replica({ leaseMs: 1_500 });
  const taker = await replica({ leaseMs: 1_500 });
  const work = await insertTask(owner, 'OPEN');
  const watch = await holder.watches.create(owner, watchBody({ predicate: ALL('TASK_TERMINAL'), targets: tasks(work), action: 'NOTIFY_USER' }));
  await sql.query(`UPDATE "task" SET "status" = 'FAILED' WHERE "id" = $1`, [work]);
  const torn = invariant(async () => {
    const { rows: [row] } = await sql.query<{ state: string; matches: number; deliveries: number }>(
      `SELECT w."state", (SELECT count(*)::int FROM "watch_match" m WHERE m."watch_id" = w."id") AS "matches",
              (SELECT count(*)::int FROM "watch_delivery" d JOIN "watch_match" m ON m."id" = d."match_id" WHERE m."watch_id" = w."id") AS "deliveries"
         FROM "watch" w WHERE w."id" = $1`,
      [watch.id],
    );
    return (row.state === 'MATCHED') === (row.matches === 1) && row.matches === row.deliveries && row.matches <= 1
      ? null
      : `torn landing: ${JSON.stringify(row)}`;
  });
  const matchGate = await holdLock(`LOCK TABLE "watch_match" IN SHARE ROW EXCLUSIVE MODE`);
  const holding = holder.evaluator.drain();
  await eventually('the holder to park at the Match insert', () => lockWaiters('INSERT INTO "watch_match"'), (n) => n >= 1, 15_000);
  assert.deepEqual(await taker.evaluator.claimDue(), [], 'a watch whose landing is open was claimed');
  await sleep(6_000);
  const claimedWhileHeld = await taker.evaluator.claimDue();
  await matchGate.release();
  const holderLanded = await holding;
  await eventually('the lease to lapse', () => watchRow(watch.id), (row) => row.state === 'MATCHED' || row.due === true, 10_000);
  const takerLanded = await taker.evaluator.drain();
  assert.deepEqual(await torn.finish(), []);
  assert.equal((await matchesOf(watch.id)).length, 1);
  assert.equal((await deliveriesOf(watch.id)).length, 1);
  assert.equal((await watchRow(watch.id)).state, 'MATCHED');
  note('QA-06', { evaluator: { holderLanded, takerLanded, claimedWhileHeld: claimedWhileHeld.length } });

  // 2. The delivery: parked at the turn insert, after its acknowledgement, past the lease and the time limit.
  const observer = await insertSession(owner, 'AWAITING_INPUT', runner);
  const resume = await holder.watches.create(owner, watchBody({
    predicate: ALL('TASK_TERMINAL'),
    targets: tasks(await insertTask(owner, 'CANCELLED')),
    action: 'RESUME_SESSION',
    observerSessionId: observer,
  }));
  assert.equal(resume.state, 'MATCHED');
  const slow = await worker({ leaseMs: 1_500 });
  const takeover = await worker();
  const honest = invariant(async () => {
    const [delivery] = await deliveriesOf(resume.id);
    const wakes = await wakesOf(resume.id);
    if (wakes.length > 1) return `two wakes: ${wakes.length}`;
    if (delivery?.state === 'DELIVERED' && wakes.length === 0) return 'DELIVERED with no turn';
    return null;
  });
  const turnGate = await holdLock(`LOCK TABLE "conversation_turn" IN SHARE ROW EXCLUSIVE MODE`);
  const slowAttempt = slow.delivery.drain();
  await eventually('the slow worker to park at the turn insert', () => lockWaiters('INSERT INTO "public"."conversation_turn"'), (n) => n >= 1, 15_000);
  assert.equal((await deliveriesOf(resume.id))[0].state, 'IN_FLIGHT', 'an acknowledgement committed ahead of its turn');
  await sleep(6_000);
  const reclaimedWhileHeld = await takeover.delivery.reclaimExpired();
  await turnGate.release();
  const slowOutcome = await slowAttempt;
  await eventually(
    'the delivery to settle under the takeover',
    async () => {
      await takeover.delivery.drain();
      return deliveriesOf(resume.id);
    },
    (rows) => rows[0]?.state === 'DELIVERED',
    20_000,
  );
  await sleep(500);
  assert.deepEqual(await honest.finish(), []);
  const [settledDelivery] = await deliveriesOf(resume.id);
  const wakes = await wakesOf(resume.id);
  assert.equal(wakes.length, 1, 'one generation, one turn');
  assert.equal(await statusOf(observer), 'PENDING');
  note('QA-06', {
    delivery: {
      slowOutcome: slowOutcome.map((result) => result.outcome),
      reclaimedWhileHeld,
      attempts: settledDelivery.attempts,
    },
  });
});

qa('QA-07', 'a delivery whose workers keep dying is taken back eight times, then left as a dead letter the watch read shows, and is never claimed again', 120_000, async () => {
  const owner = await insertUser();
  const runner = await insertRunner(owner);
  const observer = await insertSession(owner, 'AWAITING_INPUT', runner);
  const watches = new WatchesService((await pool()) as unknown as PrismaService);
  const watch = await watches.create(owner, watchBody({
    predicate: ALL('TASK_TERMINAL'),
    targets: tasks(await insertTask(owner, 'FAILED')),
    action: 'RESUME_SESSION',
    observerSessionId: observer,
  }));
  const [{ id: deliveryId }] = await deliveriesOf(watch.id);
  const sweeper = await worker();
  for (let attempt = 1; attempt <= 8; attempt += 1) {
    const doomed = await worker({ leaseMs: 150 });
    const claims = await doomed.delivery.claimDue();
    assert.ok(claims.some((claim) => claim.id === deliveryId), `attempt ${attempt}: the delivery was not claimable`);
    // The process is gone: its pool closes and nothing settles the claim.
    await doomed.delivery.stop();
    await doomed.prisma.$disconnect();
    await eventually(`attempt ${attempt}: the lease to lapse`, () => deliveriesOf(watch.id), (rows) => rows[0].leaseLapsed === true, 5_000);
    assert.equal(await sweeper.delivery.reclaimExpired(), 1, `attempt ${attempt}`);
    const [row] = await deliveriesOf(watch.id);
    assert.equal(row.attempts, attempt);
    assert.match(row.lastError ?? '', /^LEASE_EXPIRED:/);
    assert.equal(row.state, attempt < 8 ? 'PENDING' : 'DEAD_LETTER', `attempt ${attempt}`);
  }
  const later = await sweeper.delivery.drain();
  assert.deepEqual(later.filter((result) => result.deliveryId === deliveryId), [], 'a dead letter was claimed again');
  assert.deepEqual(await wakesOf(watch.id), []);
  assert.equal(await statusOf(observer), 'AWAITING_INPUT');
  const view = await watches.get(owner, watch.id);
  const [shown, ...others] = view.matches[0].deliveries;
  assert.deepEqual(others, []);
  assert.equal(shown.state, 'DEAD_LETTER');
  assert.equal(shown.attempts, 8);
  assert.ok(shown.deadLetteredAt);
  assert.match(shown.lastError ?? '', /^LEASE_EXPIRED:/);

  // The paired control: one worker dies once, the next one delivers — one turn, one counted loss.
  const recovering = await insertSession(owner, 'AWAITING_INPUT', runner);
  const recoveringWatch = await watches.create(owner, watchBody({
    predicate: ALL('TASK_TERMINAL'),
    targets: tasks(await insertTask(owner, 'FAILED')),
    action: 'RESUME_SESSION',
    observerSessionId: recovering,
  }));
  const doomed = await worker({ leaseMs: 150 });
  assert.equal((await doomed.delivery.claimDue()).length, 1);
  await doomed.delivery.stop();
  await doomed.prisma.$disconnect();
  await eventually('the lease to lapse', () => deliveriesOf(recoveringWatch.id), (rows) => rows[0].leaseLapsed === true, 5_000);
  await sweeper.delivery.drain();
  const [recovered] = await deliveriesOf(recoveringWatch.id);
  assert.deepEqual([recovered.state, recovered.attempts], ['DELIVERED', 1]);
  assert.equal((await wakesOf(recoveringWatch.id)).length, 1);
});

qa('QA-08', 'a RUNNING observer: two wakes and a person\'s message queue behind the running turn, the session is never run twice at once, and the runner is handed each exactly once in order', 150_000, async () => {
  const owner = await insertUser();
  const runner = await insertRunner(owner);
  const observer = await insertSession(owner, 'RUNNING', runner);
  const current = await insertRunningTurn(observer, 2);
  const prisma = await pool();
  const hub = new Hub(prisma);
  const door = runnerDoor(prisma, hub);
  const watches = new WatchesService(prisma as unknown as PrismaService);
  const wakeOn = async () =>
    (await watches.create(owner, watchBody({
      predicate: ALL('TASK_TERMINAL'),
      targets: tasks(await insertTask(owner, 'CANCELLED')),
      action: 'RESUME_SESSION',
      observerSessionId: observer,
    }))).id;
  const [firstWatch, secondWatch] = [await wakeOn(), await wakeOn()];
  const workers = await Promise.all([worker({}, hub), worker({}, hub), worker({}, hub)]);
  const person = new SessionsService(prisma as unknown as PrismaService, { notifySessionQueued: () => undefined } as never, hub as never);
  const oneRun = invariant(async () => {
    const { rows: [row] } = await sql.query<{ status: string; inFlight: number }>(
      `SELECT s."status",
              (SELECT count(*)::int FROM "conversation_turn" t
                WHERE t."session_id" = s."id" AND t."kind" IN ('message','shell') AND t."status" = 'IN_FLIGHT') AS "inFlight"
         FROM "session" s WHERE s."id" = $1`,
      [observer],
    );
    if (row.inFlight > 1) return `${row.inFlight} executable turns in flight`;
    if (row.status !== 'RUNNING' && row.status !== 'AWAITING_INPUT') return `session went ${row.status}`;
    return null;
  });

  await Promise.all([
    ...workers.map(({ delivery }) => delivery.drain()),
    person.createTurn(owner, observer, { clientTurnId: `person-${randomUUID()}`, content: 'one more thing', intent: 'NEXT_TURN' }),
    ...workers.map(({ delivery }) => delivery.drain()),
  ]);
  await Promise.all(workers.map(({ delivery }) => delivery.drain()));
  for (const id of [firstWatch, secondWatch]) {
    assert.equal((await deliveriesOf(id))[0].state, 'DELIVERED');
    assert.equal((await wakesOf(id)).length, 1);
  }
  const queued = (await turnsOn(observer)).filter((turn) => turn.seq > 2);
  assert.equal(queued.length, 3, JSON.stringify(queued));
  assert.deepEqual([...new Set(queued.map((turn) => turn.status))], ['PENDING']);
  assert.equal(await statusOf(observer), 'RUNNING', 'still the one run it was');
  assert.equal(queueSignals, 0, 'a second run was queued for a runner slot');
  assert.equal(await door.inbox.dequeueTurn(observer, runner, null, false, []), null, 'a queued turn was handed out while the current one runs');

  let completing = current;
  for (const expected of queued) {
    await door.api.turnComplete({ id: runner }, observer, {
      turnId: completing,
      status: 'SUCCEEDED',
      subtype: 'completed',
      numTurns: 2,
      costUsd: 0,
    } as never);
    assert.equal(await statusOf(observer), 'RUNNING', 'a queued turn keeps the slot');
    const next = await door.inbox.dequeueTurn(observer, runner, null, false, []);
    assert.equal(next?.turnId, expected.id, 'handed out of order');
    assert.equal(await door.inbox.dequeueTurn(observer, runner, null, false, []), null, 'a second turn was handed out while one runs');
    completing = expected.id;
  }
  await door.api.turnComplete({ id: runner }, observer, {
    turnId: completing,
    status: 'SUCCEEDED',
    subtype: 'completed',
    numTurns: 2,
    costUsd: 0,
  } as never);
  assert.equal(await statusOf(observer), 'AWAITING_INPUT');
  assert.deepEqual(await oneRun.finish(), []);
  assert.deepEqual([...new Set((await turnsOn(observer)).map((turn) => turn.status))], ['ANSWERED']);
  note('QA-08', { order: queued.map((turn) => turn.clientTurnId.replace(/[0-9a-f-]{36}/g, '<id>')) });
});
