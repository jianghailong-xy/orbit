/**
 * Independent QA of the Watch follow-ups that landed after D1/D2/D2b, against a real PostgreSQL.
 *
 * Written by the QA session for task 34NPZIL9Hfavd9uqJ8tjD, not by the sessions that wrote those fixes, and it
 * changes none of their code. The tree under test is main 41780572: 33dae0e6 (an expiry drained unrun is a
 * dead letter), befa925f (an interrupt or a withdrawal that deletes a queued wake dead-letters its delivery),
 * 62822bd0 (REVOKED and UNRESOLVABLE wake their observer once, migration 0263) and 41780572 (every
 * `watch:<uuid>:` key is recognised when a queued wake leaves the queue unrun). Each case drives the
 * production services and the production runner door, and checks what those fixes promise over more than
 * the cases each was written against:
 *
 *   F-01  every kind of wake (Match, expiry, revoked, unresolvable) against every exit that takes it off its
 *         observer's queue unrun, with runner-took controls and an observer no exit touches;
 *   F-02  an interrupt or a withdrawal racing the runner for the same queued wake;
 *   F-03  the delivery worker racing a failing turn, an end or an interrupt of the observer;
 *   F-04  a dead letter stays one: re-evaluation, redelivery, lease reclaims and later traffic queue nothing;
 *   F-05  hints lost on purpose: reconciliation alone ends and delivers a revoked, an unresolvable and a
 *         matched watch, once each;
 *   F-06  one wake per generation or end under racing workers and replicas, forced redelivery and a stalled lease.
 *
 *     RUN_PG_SPEC_TIMEOUT=3000 bash scripts/run-pg-spec.sh src/apiserver/src/watches/watch-core-qa-followups.pg.spec.ts
 *
 * `WATCH_QA_ONLY=F-01,F-05` registers only those cases (run-pg-spec.sh strips --test-name-pattern).
 * Non-destructive: every row carries an id this run generated, and each case first retires what earlier
 * cases left live, so the loops a case starts only find that case's rows.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, beforeEach, test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';

import type { PrismaClient } from '@prisma/client';
import { RunEventType, WATCH_LIMITS } from '@orbit/shared';
import { Client } from 'pg';
import { EMPTY } from 'rxjs';

import { prismaClientFor } from '../prisma/prisma-client';
import { PrismaService } from '../prisma/prisma.service';
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from '../projects/coordinator-pg-test-safety';
import type { PushService } from '../push/push.service';
import { RealtimeService } from '../realtime/realtime.service';
import { ReaperService } from '../realtime/reaper.service';
import { RunnerApiController } from '../runner-api/runner-api.controller';
import { SessionsService } from '../sessions/sessions.service';
import type { CreateWatchDto } from './dto';
import { WatchDeliveryOptions, WatchDeliveryResult, WatchDeliveryService } from './watch-delivery.service';
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

const KINDS = ['MATCH', 'EXPIRY', 'REVOKED', 'UNRESOLVABLE'] as const;
type Kind = (typeof KINDS)[number];
const ALL_TERMINAL = { kind: 'ALL', over: 'ALL_TARGETS', leaf: 'TASK_TERMINAL' } as const;
const ENDED = 'OBSERVER_SESSION_ENDED';

/** A collaborator a case does not observe: every method answers undefined. Not a thenable. */
const inert = <T>(): T =>
  new Proxy({}, { get: (_target, property) => (property === 'then' ? undefined : () => undefined) }) as T;

let queueSignals = 0;
/** The session queue as far as these cases can tell: it counts the signals that a session has something queued. */
const queue = new Proxy({}, {
  get: (_target, property) => {
    if (property === 'then') return undefined;
    if (property === 'notifySessionQueued') return () => { queueSignals += 1; };
    return () => undefined;
  },
});
const push = { notifyWatchMatched: async () => undefined } as unknown as PushService;
const silentPush = { scheduleBadgeSync: () => undefined, notifySessionSettled: async () => undefined } as unknown as PushService;
/** A hint source that emits nothing: an evaluation here comes from a sweep or a direct call. */
const noHints = { localPublications: () => EMPTY } as unknown as RealtimeService;

/** A replica's realtime hub without the cross-replica LISTEN connection: publishing works as in production. */
class Hub extends RealtimeService {
  constructor(prisma: PrismaClient) {
    super(prisma as unknown as PrismaService, silentPush);
  }

  override async onModuleInit(): Promise<void> {}
}

// ── the harness ────────────────────────────────────────────────────────────────────────────────

let sql: Client;
let watches: WatchesService;
/** Never started: a case lands an evaluation by calling it. */
let evaluator: WatchEvaluatorService;
/** The account a revoked watch's target is given to. */
let stranger: string;
const clients: PrismaClient[] = [];
const loops: Array<{ stop(): Promise<unknown> }> = [];

before(async () => {
  if (skip) return;
  assertCoordinatorPgUrlIsIsolated(URL);
  sql = new Client({ connectionString: URL, connectionTimeoutMillis: 10_000 });
  await sql.connect();
  await verifyCoordinatorPgIdentity(sql);
  const prisma = await pool();
  watches = new WatchesService(prisma as unknown as PrismaService);
  evaluator = new WatchEvaluatorService(prisma as unknown as PrismaService, noHints, {
    reconcileIntervalMs: HOUR,
    pollIntervalMs: HOUR,
  });
  stranger = await insertUser();
});

beforeEach(async () => {
  if (skip) return;
  for (const loop of loops.splice(0)) await loop.stop();
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
  for (const loop of loops.splice(0)) await loop.stop().catch(() => undefined);
  for (const client of clients.splice(0)) await client.$disconnect().catch(() => undefined);
  await sql?.end().catch(() => undefined);
});

/** A pool that has connected, as a running replica's has: a cold client's first transaction can miss Prisma's 2s start window on a starved host. */
async function pool(): Promise<PrismaClient> {
  const prisma = prismaClientFor(URL!);
  clients.push(prisma);
  await prisma.$executeRaw`SELECT 1`;
  return prisma;
}

/** Opens `connections` connections in each pool before a case bursts work onto it. */
async function warm(pools: PrismaClient[], connections: number): Promise<void> {
  await Promise.all(pools.flatMap((prisma) => Array.from({ length: connections }, () => prisma.$executeRaw`SELECT pg_sleep(0.1)`)));
}

interface Worker {
  prisma: PrismaClient;
  sessions: SessionsService;
  delivery: WatchDeliveryService;
}

/** One replica's delivery worker: its own pool and the real sessions service. */
async function worker(options: WatchDeliveryOptions = {}): Promise<Worker> {
  const prisma = await pool();
  const sessions = new SessionsService(prisma as unknown as PrismaService, queue as never, inert<never>());
  const delivery = new WatchDeliveryService(prisma as unknown as PrismaService, sessions, push, {
    retryBaseMs: 0,
    retryMaxMs: 0,
    pollIntervalMs: HOUR,
    ...options,
  });
  loops.push(delivery);
  return { prisma, sessions, delivery };
}

/** Another replica's evaluator that hears nothing: its own pool, never started unless the case starts it. */
async function evaluatorFor(options: WatchEvaluatorOptions = {}): Promise<WatchEvaluatorService> {
  const prisma = await pool();
  const other = new WatchEvaluatorService(prisma as unknown as PrismaService, noHints, {
    reconcileIntervalMs: HOUR,
    pollIntervalMs: HOUR,
    ...options,
  });
  loops.push(other);
  return other;
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
  const own = new WatchEvaluatorService(prisma as unknown as PrismaService, hub, {
    reconcileIntervalMs: HOUR,
    pollIntervalMs: HOUR,
    ...options,
  });
  loops.push(own);
  return { prisma, hub, evaluator: own, watches: new WatchesService(prisma as unknown as PrismaService) };
}

interface Doors {
  complete(observer: string, turnId: string, status: 'SUCCEEDED' | 'FAILED'): Promise<unknown>;
  finalize(observer: string): Promise<unknown>;
  take(observer: string): Promise<string | null>;
}

/** The runner's own doors onto its sessions: settle a turn it ran, finalize a run, take the next queued turn. */
function doorsFor(prisma: PrismaClient, runner: string): Doors {
  const api = new RunnerApiController(prisma as never, queue as never, inert<never>(), inert<never>(), inert<never>(), inert<never>(), inert<never>());
  const inbox = api as unknown as {
    dequeueTurn(
      sessionId: string,
      runnerId: string,
      leaseGeneration: null,
      acceptsSteer: boolean,
      declaredCapabilities: readonly string[],
    ): Promise<{ turnId: string } | null>;
  };
  return {
    complete: (observer, turnId, status) =>
      api.turnComplete({ id: runner }, observer, {
        turnId,
        status,
        subtype: status === 'FAILED' ? 'error_during_execution' : 'completed',
        ...(status === 'FAILED' ? { result: 'API Error: 529 overloaded' } : {}),
        numTurns: 2,
        costUsd: 0,
      } as never),
    finalize: (observer) => api.finalize({ id: runner }, observer, { status: 'FAILED', error: 'the engine exited' } as never),
    take: async (observer) => (await inbox.dequeueTurn(observer, runner, null, false, []))?.turnId ?? null,
  };
}

// ── fixtures ───────────────────────────────────────────────────────────────────────────────────

async function insertUser(): Promise<string> {
  const id = randomUUID();
  await sql.query(`INSERT INTO "user"("id","email","name","password_hash") VALUES ($1,$2,'watch qa followups','h')`, [
    id,
    `${id}@watch-qa.invalid`,
  ]);
  return id;
}

async function insertRunner(owner: string): Promise<string> {
  const id = randomUUID();
  await sql.query(
    `INSERT INTO "runner"("id","name","owner_id","token_hash","status","last_heartbeat_at","capabilities","max_concurrent")
     VALUES ($1,'watch qa followups',$2,$3,'ONLINE',clock_timestamp(),'{}'::text[],8)`,
    [id, owner, randomUUID()],
  );
  return id;
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

/** An observer that has run: started on an online runner, with a runtime behind it. */
async function insertSession(owner: string, status: string, runnerId: string): Promise<string> {
  const id = randomUUID();
  await sql.query(
    `INSERT INTO "session"("id","title","prompt","owner_id","creator_id","updated_at","status","assigned_runner_id",
                           "provider","provider_builtin","num_turns","started_at","runtime_session_id")
     VALUES ($1,'watch qa followups','the opening prompt',$2,$2,now(),$3,$4,'claude',TRUE,1,now(),$5)`,
    [id, owner, status, runnerId, `runtime-${id}`],
  );
  return id;
}

/** The turn a RUNNING observer is executing, leased to its runner: whatever is queued waits behind it. */
async function insertRunningTurn(sessionId: string): Promise<string> {
  const id = randomUUID();
  await sql.query(
    `INSERT INTO "conversation_turn"("id","session_id","seq","client_turn_id","kind","content","status","delivered_at","lease_deadline_at")
     VALUES ($1,$2,1,$3,'message','the turn the session is running','IN_FLIGHT',now(),now() + interval '2 hours')`,
    [id, sessionId, `current-${id}`],
  );
  return id;
}

function watchOn(task: string, observerSessionId: string): CreateWatchDto {
  return {
    predicateVersion: 1,
    predicate: ALL_TERMINAL,
    targets: [{ kind: 'TASK', id: task }],
    action: 'RESUME_SESSION',
    observerSessionId,
    ttlSeconds: WATCH_LIMITS.minTtlSeconds,
  } as unknown as CreateWatchDto;
}

/** The key the delivery worker queues this kind of wake under (watch-delivery.service.ts). */
function keyOf(kind: Kind, watchId: string): string {
  if (kind === 'MATCH') return `watch:${watchId}:1`;
  if (kind === 'EXPIRY') return `watch:${watchId}:expired`;
  return `watch:${watchId}:${kind.toLowerCase()}`;
}

/** What the evaluator ends a watch on: REVOKED, its target given to another account; otherwise its only target deleted. */
async function bringAbout(kind: Kind, task: string): Promise<void> {
  const { rowCount } = kind === 'REVOKED'
    ? await sql.query(`UPDATE "task" SET "owner_id" = $2, "status" = 'FAILED' WHERE "id" = $1`, [task, stranger])
    : await sql.query(`DELETE FROM "task" WHERE "id" = $1`, [task]);
  assert.equal(rowCount, 1);
}

/** Its TTL runs out, in whole milliseconds as the service writes it (a sub-millisecond `expires_at` breaks its CAS). */
async function expire(watchId: string): Promise<void> {
  const { rowCount } = await sql.query(
    `UPDATE "watch"
        SET "expires_at" = date_trunc('milliseconds', now()) - interval '1 second',
            "next_evaluate_at" = CASE WHEN "next_evaluate_at" IS NULL THEN NULL
                                      ELSE date_trunc('milliseconds', now()) - interval '1 second' END
      WHERE "id" = $1`,
    [watchId],
  );
  assert.equal(rowCount, 1);
}

interface Owed {
  kind: Kind;
  observer: string;
  watchId: string;
  deliveryId: string;
  key: string;
}

interface Wake extends Owed {
  wakeId: string;
}

/** A RESUME_SESSION watch on `observer` that owes it a wake of this kind: its delivery PENDING, nothing queued yet. */
async function owedWake(kind: Kind, owner: string, observer: string): Promise<Owed> {
  if (kind === 'MATCH') {
    const watch = await watches.create(owner, watchOn(await insertTask(owner, 'FAILED'), observer));
    assert.equal(watch.state, 'MATCHED', 'MATCH: the fixture holds at create');
    const deliveries = await deliveriesOf(watch.id);
    assert.deepEqual(deliveries.map((row) => [row.kind, row.state]), [['MATCH', 'PENDING']]);
    return { kind, observer, watchId: watch.id, deliveryId: deliveries[0].id, key: keyOf(kind, watch.id) };
  }
  const task = await insertTask(owner, 'OPEN');
  const watch = await watches.create(owner, watchOn(task, observer));
  assert.equal(watch.state, 'ACTIVE', `${kind}: the fixture is live at create`);
  if (kind === 'EXPIRY') await expire(watch.id);
  else await bringAbout(kind, task);
  assert.equal((await evaluator.evaluate(watch.id)).outcome, kind === 'EXPIRY' ? 'EXPIRED' : kind);
  const deliveries = await deliveriesOf(watch.id);
  assert.deepEqual(deliveries.map((row) => [row.kind, row.state]), [[kind, 'PENDING']], `${kind}: the end owes one delivery`);
  return { kind, observer, watchId: watch.id, deliveryId: deliveries[0].id, key: keyOf(kind, watch.id) };
}

/** The worker delivers what is owed: DELIVERED, with the wake waiting in the observer's queue. */
async function queuedWake(owed: Owed, by: Worker): Promise<Wake> {
  assert.deepEqual(outcomesFor(await by.delivery.drain(), owed.deliveryId), ['DELIVERED'], `${owed.kind}: delivered`);
  const [wake, ...more] = await turnsKeyed(owed.observer, owed.key);
  assert.deepEqual(more, []);
  assert.equal(wake?.status, 'PENDING', `${owed.kind}: the wake waits in the queue`);
  return { ...owed, wakeId: wake.id };
}

// ── reads ──────────────────────────────────────────────────────────────────────────────────────

interface DeliveryRow {
  id: string;
  kind: string;
  state: string;
  attempts: number;
  lastError: string | null;
  deliveredAt: Date | null;
  deadLetteredAt: Date | null;
}

const DELIVERY_COLUMNS = `d."id", d."kind", d."state", d."attempts", d."last_error" AS "lastError",
  d."delivered_at" AS "deliveredAt", d."dead_lettered_at" AS "deadLetteredAt"`;

/** Every delivery a watch has: its Match's and its end's. */
async function deliveriesOf(watchId: string): Promise<DeliveryRow[]> {
  const { rows } = await sql.query<DeliveryRow>(
    `SELECT ${DELIVERY_COLUMNS}
       FROM "watch_delivery" d LEFT JOIN "watch_match" m ON m."id" = d."match_id"
      WHERE d."watch_id" = $1 OR m."watch_id" = $1
      ORDER BY d."created_at", d."id"`,
    [watchId],
  );
  return rows;
}

async function deliveryOf(id: string): Promise<DeliveryRow> {
  const { rows } = await sql.query<DeliveryRow>(`SELECT ${DELIVERY_COLUMNS} FROM "watch_delivery" d WHERE d."id" = $1`, [id]);
  return rows[0];
}

interface TurnRow {
  id: string;
  seq: number;
  clientTurnId: string;
  kind: string;
  status: string;
  content: string | null;
}

const TURN_COLUMNS = `"id", "seq", "client_turn_id" AS "clientTurnId", "kind", "status", "content"`;

async function turnsOn(sessionId: string): Promise<TurnRow[]> {
  const { rows } = await sql.query<TurnRow>(`SELECT ${TURN_COLUMNS} FROM "conversation_turn" WHERE "session_id" = $1 ORDER BY "seq"`, [sessionId]);
  return rows;
}

async function turnsKeyed(sessionId: string, key: string): Promise<TurnRow[]> {
  const { rows } = await sql.query<TurnRow>(
    `SELECT ${TURN_COLUMNS} FROM "conversation_turn" WHERE "session_id" = $1 AND "client_turn_id" = $2 ORDER BY "seq"`,
    [sessionId, key],
  );
  return rows;
}

async function turnById(id: string): Promise<TurnRow | undefined> {
  const { rows } = await sql.query<TurnRow>(`SELECT ${TURN_COLUMNS} FROM "conversation_turn" WHERE "id" = $1`, [id]);
  return rows[0];
}

async function sessionStatus(id: string): Promise<string> {
  const { rows } = await sql.query<{ status: string }>(`SELECT "status" FROM "session" WHERE "id" = $1`, [id]);
  return rows[0].status;
}

async function matchCount(watchId: string): Promise<number> {
  const { rows } = await sql.query<{ n: number }>(`SELECT count(*)::int AS "n" FROM "watch_match" WHERE "watch_id" = $1`, [watchId]);
  return rows[0].n;
}

interface Schedule {
  state: string;
  nextEvaluateAt: Date | null;
  updatedAt: Date;
  due: boolean | null;
  /** An evaluator landed a decision after creation. */
  landed: boolean | null;
  /** The schedule is a claim's lease (a minute), not a landing's reconciliation. */
  leased: boolean | null;
}

async function scheduleOf(watchId: string): Promise<Schedule> {
  const { rows } = await sql.query<Schedule>(
    `SELECT "state", "next_evaluate_at" AS "nextEvaluateAt", "updated_at" AS "updatedAt", "next_evaluate_at" <= now() AS "due",
            "last_evaluated_at" > "created_at" AS "landed",
            "next_evaluate_at" - "last_evaluated_at" > interval '30 seconds' AS "leased"
       FROM "watch" WHERE "id" = $1`,
    [watchId],
  );
  return rows[0];
}

const codeOf = (lastError: string | null): string => (lastError === null ? '-' : lastError.split(':')[0]);

const outcomesFor = (results: WatchDeliveryResult[], deliveryId: string): string[] =>
  results.filter((result) => result.deliveryId === deliveryId).map((result) => result.outcome);

async function eventually<T>(what: string, read: () => Promise<T>, done: (value: T) => boolean, timeoutMs = 30_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (done(value)) return value;
    if (Date.now() > deadline) assert.fail(`${what}: gave up after ${timeoutMs}ms at ${JSON.stringify(value)}`);
    await sleep(25);
  }
}

// ── cases ──────────────────────────────────────────────────────────────────────────────────────

interface ExitContext {
  owner: string;
  runner: string;
  observer: string;
  current: string | null;
  wake: Wake;
  by: Worker;
  doors: Doors;
}

interface Exit {
  name: string;
  /** RUNNING: the observer runs a turn its runner holds, and the wake queues behind it. PARKED: it waited for input, and the wake queued it for a runner slot. */
  observer: 'RUNNING' | 'PARKED';
  code: string;
  wake: 'ANSWERED' | 'DELETED';
  run(context: ExitContext): Promise<unknown>;
}

/** Every door in the tree that takes a queued wake off its observer's queue without a runner running it. */
const EXITS: Exit[] = [
  {
    name: 'its running turn fails',
    observer: 'RUNNING', code: ENDED, wake: 'ANSWERED',
    run: (c) => c.doors.complete(c.observer, c.current!, 'FAILED'),
  },
  {
    name: 'its runner goes quiet and the reaper finalizes it',
    observer: 'RUNNING', code: ENDED, wake: 'ANSWERED',
    run: async (c) => {
      // Only this observer's runner is offline at the sweep; every other runner of the file answers.
      await sql.query(`UPDATE "runner" SET "last_heartbeat_at" = clock_timestamp() WHERE "id" <> $1`, [c.runner]);
      await sql.query(`UPDATE "runner" SET "last_heartbeat_at" = now() - interval '10 minutes' WHERE "id" = $1`, [c.runner]);
      const reaper = new ReaperService(c.by.prisma as unknown as PrismaService, inert<never>());
      await (reaper as unknown as { sweep(): Promise<void> }).sweep();
    },
  },
  {
    name: 'its runner finalizes the run',
    observer: 'RUNNING', code: ENDED, wake: 'ANSWERED',
    run: (c) => c.doors.finalize(c.observer),
  },
  {
    name: 'its owner ends it while it runs',
    observer: 'RUNNING', code: ENDED, wake: 'ANSWERED',
    run: (c) => c.by.sessions.end(c.owner, c.observer),
  },
  {
    name: 'its owner moves it to Completed while it runs',
    observer: 'RUNNING', code: ENDED, wake: 'ANSWERED',
    run: (c) => c.by.sessions.complete(c.owner, c.observer),
  },
  {
    name: 'its owner moves it to Trash while it runs',
    observer: 'RUNNING', code: ENDED, wake: 'ANSWERED',
    run: (c) => c.by.sessions.remove(c.owner, c.observer),
  },
  {
    name: 'its owner ends it while the wake waits for a runner slot',
    observer: 'PARKED', code: ENDED, wake: 'ANSWERED',
    run: (c) => c.by.sessions.end(c.owner, c.observer),
  },
  {
    name: 'its owner interrupts it',
    observer: 'RUNNING', code: 'OBSERVER_TURN_INTERRUPTED', wake: 'DELETED',
    run: (c) => c.by.sessions.interrupt(c.owner, c.observer),
  },
  {
    name: 'its owner withdraws the wake while it runs',
    observer: 'RUNNING', code: 'WAKE_WITHDRAWN', wake: 'DELETED',
    run: (c) => c.by.sessions.cancelQueuedTurn(c.owner, c.observer, c.wake.wakeId),
  },
  {
    name: 'its owner withdraws the wake while it waits for a runner slot',
    observer: 'PARKED', code: 'WAKE_WITHDRAWN', wake: 'DELETED',
    run: (c) => c.by.sessions.cancelQueuedTurn(c.owner, c.observer, c.wake.wakeId),
  },
];

qa('F-01', 'every kind of wake against every exit that takes it off its observer\'s queue unrun is a dead letter with that exit\'s code, never DELIVERED and never queued again; a wake the runner took stays DELIVERED; an observer no exit touched keeps all four', 1_200_000, async () => {
  const owner = await insertUser();
  const by = await worker();

  // An observer no exit below touches, with one queued wake of every kind.
  const sentinel = await insertSession(owner, 'RUNNING', await insertRunner(owner));
  await insertRunningTurn(sentinel);
  const untouched: Wake[] = [];
  for (const kind of KINDS) untouched.push(await queuedWake(await owedWake(kind, owner, sentinel), by));

  const expected: string[] = [];
  const observed: string[] = [];
  for (const exit of EXITS) {
    for (const kind of KINDS) {
      const runner = await insertRunner(owner);
      const observer = await insertSession(owner, exit.observer === 'RUNNING' ? 'RUNNING' : 'AWAITING_INPUT', runner);
      const current = exit.observer === 'RUNNING' ? await insertRunningTurn(observer) : null;
      const wake = await queuedWake(await owedWake(kind, owner, observer), by);
      let threw = '';
      await exit.run({ owner, runner, observer, current, wake, by, doors: doorsFor(by.prisma, runner) })
        .catch((error: Error) => { threw = ` THREW ${error.message.slice(0, 200)}`; });
      const settled = await deliveryOf(wake.deliveryId);
      const turn = await turnById(wake.wakeId);
      const again = outcomesFor(await by.delivery.drain(), wake.deliveryId);
      const keyed = await turnsKeyed(observer, wake.key);
      const label = `${kind} | ${exit.name}`;
      expected.push(
        `${label}: DEAD_LETTER ${exit.code} dead-lettered-at=set delivered-at=null wake=${exit.wake} redelivered=none keyed=${exit.wake === 'DELETED' ? 0 : 1}`,
      );
      observed.push(
        `${label}: ${settled.state} ${codeOf(settled.lastError)} dead-lettered-at=${settled.deadLetteredAt ? 'set' : 'null'} ` +
        `delivered-at=${settled.deliveredAt ? 'set' : 'null'} wake=${turn ? turn.status : 'DELETED'} ` +
        `redelivered=${again.join('+') || 'none'} keyed=${keyed.length}${threw}`,
      );
    }
  }

  // The controls: a wake the runner already took reached the observer's engine, and stays DELIVERED
  // whatever then stops the run it started.
  const CONTROLS = ['its own turn fails', 'the observer is interrupted', 'its withdrawal is refused'] as const;
  for (const kind of KINDS) {
    for (const control of CONTROLS) {
      const runner = await insertRunner(owner);
      const observer = await insertSession(owner, 'RUNNING', runner);
      const current = await insertRunningTurn(observer);
      const wake = await queuedWake(await owedWake(kind, owner, observer), by);
      const doors = doorsFor(by.prisma, runner);
      await doors.complete(observer, current, 'SUCCEEDED');
      const taken = await doors.take(observer);
      let refused = false;
      if (control === 'its own turn fails') await doors.complete(observer, wake.wakeId, 'FAILED');
      else if (control === 'the observer is interrupted') await by.sessions.interrupt(owner, observer);
      else refused = await by.sessions.cancelQueuedTurn(owner, observer, wake.wakeId).then(() => false, () => true);
      const settled = await deliveryOf(wake.deliveryId);
      const turn = await turnById(wake.wakeId);
      const label = `${kind} taken by the runner | ${control}`;
      expected.push(`${label}: taken=true DELIVERED refused=${control === 'its withdrawal is refused'} wake=${control === 'its own turn fails' ? 'ran' : 'IN_FLIGHT'}`);
      observed.push(
        `${label}: taken=${taken === wake.wakeId} ${settled.state} refused=${refused} ` +
        `wake=${control === 'its own turn fails' ? (turn ? 'ran' : 'DELETED') : (turn?.status ?? 'DELETED')}`,
      );
    }
  }

  for (const wake of untouched) {
    expected.push(`untouched observer | ${wake.kind}: DELIVERED PENDING`);
    observed.push(`untouched observer | ${wake.kind}: ${(await deliveryOf(wake.deliveryId)).state} ${(await turnById(wake.wakeId))?.status ?? 'DELETED'}`);
  }
  note('F-01', { scenarios: observed.length, queueSignals, observed });
  assert.deepEqual(observed, expected);
});

qa('F-02', 'an interrupt or a withdrawal racing the runner for the same queued wake: the wake is either run and DELIVERED or deleted and a dead letter — never deleted and DELIVERED, never run and dead-lettered, never two turns running', 1_200_000, async () => {
  const owner = await insertUser();
  const by = await worker();
  const runnerPool = await pool();
  const ownerPool = await pool();
  await warm([by.prisma, runnerPool, ownerPool], 4);
  const owners = new SessionsService(ownerPool as unknown as PrismaService, queue as never, inert<never>());
  const tally: Record<string, number> = {};
  const violations: string[] = [];
  const coverage = { interrupt: { run: 0, deleted: 0 }, withdraw: { run: 0, deleted: 0 } };
  // The runner's side is what it does when the running turn ends: settle that turn, then take the next one; the
  // owner's side starts while the turn still runs. An earlier run settled the turn before the race, raced only the
  // take, and gave the owner at most 50ms of head start: the runner won all 72 rounds, so the other order was never
  // exercised. Each round now holds one side back, the runner in even rounds and the owner in odd ones, by up to 400ms.
  const LEAD_MS = [0, 0, 10, 10, 40, 40, 100, 100, 200, 200, 400, 400];
  for (const kind of ['MATCH', 'EXPIRY', 'REVOKED'] as const) {
    for (const contender of ['interrupt', 'withdraw'] as const) {
      for (let round = 0; round < LEAD_MS.length; round += 1) {
        const runner = await insertRunner(owner);
        const observer = await insertSession(owner, 'RUNNING', runner);
        const current = await insertRunningTurn(observer);
        const wake = await queuedWake(await owedWake(kind, owner, observer), by);
        const doors = doorsFor(runnerPool, runner);

        const runnerWaits = round % 2 === 0;
        const [took, stopped] = await Promise.allSettled([
          sleep(runnerWaits ? LEAD_MS[round] : 0).then(async () => {
            await doors.complete(observer, current, 'SUCCEEDED');
            return doors.take(observer);
          }),
          sleep(runnerWaits ? 0 : LEAD_MS[round]).then(() =>
            contender === 'interrupt' ? owners.interrupt(owner, observer) : owners.cancelQueuedTurn(owner, observer, wake.wakeId)),
        ]);
        if (took.status === 'fulfilled' && took.value === wake.wakeId) coverage[contender].run += 1;

        const turn = await turnById(wake.wakeId);
        const settled = await deliveryOf(wake.deliveryId);
        const running = (await turnsOn(observer)).filter((row) => row.status === 'IN_FLIGHT');
        const handedId = took.status === 'fulfilled' ? took.value : null;
        const handed = handedId ? await turnById(handedId) : undefined;
        const tookWake = handedId === wake.wakeId;
        const stopOk = stopped.status === 'fulfilled';
        const shape = `took=${took.status === 'rejected' ? 'threw' : tookWake ? 'wake' : (handed?.kind ?? 'nothing')} ${contender}=${stopOk ? 'ok' : 'refused'} ` +
          `-> wake=${turn ? turn.status : 'DELETED'} delivery=${settled.state} ${codeOf(settled.lastError)}`;
        tally[`${kind} ${shape}`] = (tally[`${kind} ${shape}`] ?? 0) + 1;

        const code = contender === 'interrupt' ? 'OBSERVER_TURN_INTERRUPTED' : 'WAKE_WITHDRAWN';
        const problems: string[] = [];
        if (running.length > 1) problems.push(`${running.length} turns IN_FLIGHT at once`);
        if (!turn && settled.state !== 'DEAD_LETTER') problems.push('deleted but still DELIVERED');
        if (!turn && settled.state === 'DEAD_LETTER' && codeOf(settled.lastError) !== code) problems.push(`deleted with code ${codeOf(settled.lastError)}`);
        if (turn && settled.state !== 'DELIVERED') problems.push(`still on the session (${turn.status}) but ${settled.state}`);
        if (tookWake && turn?.status !== 'IN_FLIGHT') problems.push(`handed to the runner but ${turn ? turn.status : 'DELETED'}`);
        if (!tookWake && turn?.status === 'IN_FLIGHT') problems.push('IN_FLIGHT without the runner being handed it');
        if (handed && handed.kind === 'message' && !tookWake) problems.push(`the runner was handed another message ${handed.id}`);
        if (contender === 'withdraw' && stopOk && (turn || tookWake)) problems.push('a withdrawal that succeeded left or handed out the wake');
        if (!turn) coverage[contender].deleted += 1;
        if (problems.length > 0) violations.push(`${kind} ${contender} round ${round}: ${shape}: ${problems.join('; ')}`);
      }
    }
  }
  note('F-02', { tally, coverage, queueSignals });
  assert.deepEqual(violations, []);
  // Not the product's promise, the case's own strength: both orders of the race happened for both contenders.
  for (const contender of ['interrupt', 'withdraw'] as const) {
    assert.ok(coverage[contender].run > 0 && coverage[contender].deleted > 0, `the ${contender} race was not exercised both ways: ${JSON.stringify(coverage)}`);
  }
});

qa('F-03', 'the delivery worker racing a failing turn, an end or an interrupt of its observer: a wake no runner took is never left DELIVERED on a queue that no longer holds it, and never waits on an ended observer', 1_200_000, async () => {
  const owner = await insertUser();
  const racer = await worker();
  const exitPool = await pool();
  await warm([racer.prisma, exitPool], 4);
  const owners = new SessionsService(exitPool as unknown as PrismaService, queue as never, inert<never>());
  const tally: Record<string, number> = {};
  const violations: string[] = [];
  const coverage = { 'turn fails': { wakeFirst: 0, exitFirst: 0 }, end: { wakeFirst: 0, exitFirst: 0 }, interrupt: { wakeFirst: 0, exitFirst: 0 } };
  // As in F-02, each round gives one side a head start: even rounds hold the worker back, odd rounds the exit.
  const LEAD_MS = [0, 1, 3, 6, 12, 25, 50, 100];
  for (const kind of ['MATCH', 'REVOKED', 'UNRESOLVABLE'] as const) {
    for (const exit of ['turn fails', 'end', 'interrupt'] as const) {
      for (let round = 0; round < LEAD_MS.length; round += 1) {
        const runner = await insertRunner(owner);
        const observer = await insertSession(owner, 'RUNNING', runner);
        const current = await insertRunningTurn(observer);
        const owed = await owedWake(kind, owner, observer);
        const doors = doorsFor(exitPool, runner);

        const workerWaits = round % 2 === 0;
        const [delivered, exited] = await Promise.allSettled([
          sleep(workerWaits ? LEAD_MS[round] : 0).then(() => racer.delivery.drain()),
          sleep(workerWaits ? 0 : LEAD_MS[round]).then(() =>
            exit === 'turn fails'
              ? doors.complete(observer, current, 'FAILED')
              : exit === 'end' ? owners.end(owner, observer) : owners.interrupt(owner, observer)),
        ]);
        // A retry the race caused is settled before the outcome is judged.
        for (let pass = 0; pass < 9 && ['PENDING', 'IN_FLIGHT'].includes((await deliveryOf(owed.deliveryId)).state); pass += 1) {
          await racer.delivery.drain();
        }

        const settled = await deliveryOf(owed.deliveryId);
        const wakes = await turnsKeyed(observer, owed.key);
        const outcome = delivered.status === 'fulfilled' ? outcomesFor(delivered.value, owed.deliveryId).join('+') || 'none' : 'threw';
        const shape = `worker=${outcome} ${exit}=${exited.status} -> wakes=${wakes.map((row) => row.status).join('+') || 'none'} delivery=${settled.state} ${codeOf(settled.lastError)}`;
        tally[`${kind} ${exit} ${shape}`] = (tally[`${kind} ${exit} ${shape}`] ?? 0) + 1;

        const problems: string[] = [];
        if (exited.status === 'rejected') problems.push(`the ${exit} was refused: ${String(exited.reason).slice(0, 200)}`);
        if (wakes.length > 1) problems.push(`${wakes.length} wakes`);
        if (exit === 'interrupt') {
          const kept = wakes.length === 1 && wakes[0].status === 'PENDING' && settled.state === 'DELIVERED';
          const dropped = wakes.length === 0 && settled.state === 'DEAD_LETTER' && codeOf(settled.lastError) === 'OBSERVER_TURN_INTERRUPTED';
          if (!kept && !dropped) problems.push('neither queued after the interrupt and DELIVERED, nor deleted by it and a dead letter');
        } else {
          if (settled.state !== 'DEAD_LETTER' || codeOf(settled.lastError) !== ENDED) problems.push(`an ended observer's wake reads ${settled.state} ${codeOf(settled.lastError)}`);
          if (wakes.some((row) => row.status !== 'ANSWERED')) problems.push('a wake still waits on an ended observer');
        }
        // Which order the race ran in, read off what it left: an interrupt deletes a wake queued before it and
        // leaves one queued after it; an ending drains a wake queued before it and refuses one after it.
        if (exit === 'interrupt') {
          if (wakes.length === 0) coverage[exit].wakeFirst += 1;
          else coverage[exit].exitFirst += 1;
        } else if (wakes.length === 1) coverage[exit].wakeFirst += 1;
        else coverage[exit].exitFirst += 1;
        if (problems.length > 0) violations.push(`${kind} ${exit} round ${round}: ${shape}: ${problems.join('; ')}`);
      }
    }
  }
  note('F-03', { tally, coverage });
  assert.deepEqual(violations, []);
  // Not the product's promise, the case's own strength: for every exit, both orders of the race happened.
  for (const [exit, seen] of Object.entries(coverage)) {
    assert.ok(seen.wakeFirst > 0 && seen.exitFirst > 0, `the race with "${exit}" was not exercised both ways: ${JSON.stringify(coverage)}`);
  }
});

qa('F-04', 'a dead letter stays one: re-evaluation on three replicas, three draining workers, lease reclaims and the observer\'s later traffic neither queue the wake again nor touch its delivery, and a Match stays one', 900_000, async () => {
  const owner = await insertUser();
  const by = await worker();
  const replicas = [evaluator, await evaluatorFor(), await evaluatorFor()];
  const workers = [by, await worker(), await worker()];
  const violations: string[] = [];
  let checked = 0;
  for (const kind of KINDS) {
    for (const exit of ['interrupt', 'withdraw', 'turn fails'] as const) {
      const runner = await insertRunner(owner);
      const observer = await insertSession(owner, 'RUNNING', runner);
      const current = await insertRunningTurn(observer);
      const wake = await queuedWake(await owedWake(kind, owner, observer), by);
      if (exit === 'interrupt') await by.sessions.interrupt(owner, observer);
      else if (exit === 'withdraw') await by.sessions.cancelQueuedTurn(owner, observer, wake.wakeId);
      else await doorsFor(by.prisma, runner).complete(observer, current, 'FAILED');
      const label = `${kind} after ${exit}`;
      const dead = await deliveryOf(wake.deliveryId);
      if (dead.state !== 'DEAD_LETTER') {
        violations.push(`${label}: not a dead letter to begin with (${dead.state})`);
        continue;
      }
      const statusBefore = await sessionStatus(observer);

      // Everything that could put the wake back.
      await Promise.all([
        ...replicas.flatMap((one) => [one.evaluate(wake.watchId), one.evaluate(wake.watchId)]),
        ...workers.map((one) => one.delivery.drain()),
        ...workers.map((one) => one.delivery.reclaimExpired()),
      ]);
      await Promise.all(replicas.map((one) => one.drain()));
      await Promise.all(workers.map((one) => one.delivery.drain()));
      if (exit !== 'turn fails') {
        // The observer lives on: its owner sends it something, and the workers pass again.
        await by.sessions.createTurn(owner, observer, { clientTurnId: randomUUID(), content: 'carry on', intent: 'NEXT_TURN' });
        await Promise.all(workers.map((one) => one.delivery.drain()));
      }

      const problems: string[] = [];
      const later = await deliveryOf(wake.deliveryId);
      if (JSON.stringify(later) !== JSON.stringify(dead)) problems.push(`the dead letter changed to ${JSON.stringify(later)}`);
      const rows = await deliveriesOf(wake.watchId);
      if (rows.length !== 1) problems.push(`${rows.length} deliveries`);
      const keyed = await turnsKeyed(observer, wake.key);
      if (keyed.length !== (exit === 'turn fails' ? 1 : 0)) problems.push(`${keyed.length} turns under the wake's key`);
      if (keyed.some((row) => row.status !== 'ANSWERED')) problems.push('the wake waits again');
      if (kind === 'MATCH' && (await matchCount(wake.watchId)) !== 1) problems.push('a second Match');
      if (exit === 'turn fails' && (await sessionStatus(observer)) !== statusBefore) problems.push(`the ended observer moved to ${await sessionStatus(observer)}`);
      if (problems.length > 0) violations.push(`${label}: ${problems.join('; ')}`);
      checked += 1;
    }
  }
  note('F-04', { checked, violations });
  assert.deepEqual(violations, []);
});

qa('F-05', 'hints lost on purpose: the events about a revoked, an unresolvable and a matched RESUME_SESSION watch are published where its evaluator never hears them, and reconciliation alone lands each no earlier than its sweep and wakes its observer exactly once; the hinted control lands long before an hour-long sweep', 300_000, async () => {
  const owner = await insertUser();
  const runner = await insertRunner(owner);
  const writer = await replica(); // publishes the events; its evaluator never starts
  const survivor = await replica({ reconcileIntervalMs: 2_500, pollIntervalMs: 100 });
  const deliveries = await worker({ pollIntervalMs: 100 });
  let hintsReachingSurvivor = 0;
  const hint = survivor.evaluator.hint.bind(survivor.evaluator);
  survivor.evaluator.hint = async (kind, ids) => {
    hintsReachingSurvivor += 1;
    return hint(kind, ids);
  };
  let pulledDue = 0;
  const markDue = survivor.evaluator.markDue.bind(survivor.evaluator);
  survivor.evaluator.markDue = async (kind, ids) => {
    pulledDue += 1;
    return markDue(kind, ids);
  };
  survivor.evaluator.start();
  deliveries.delivery.start();

  const cases: Array<{ kind: 'REVOKED' | 'UNRESOLVABLE' | 'MATCH'; state: string; observer: string; task: string; watchId: string; key: string; sweepAt: Date; changedAt: number }> = [];
  for (const kind of ['REVOKED', 'UNRESOLVABLE', 'MATCH'] as const) {
    const observer = await insertSession(owner, 'AWAITING_INPUT', runner);
    const task = await insertTask(owner, 'OPEN');
    const watch = await survivor.watches.create(owner, watchOn(task, observer));
    assert.equal(watch.state, 'ACTIVE');
    const landed = await eventually(
      `${kind}: the first sweep to land`,
      () => scheduleOf(watch.id),
      (row) => row.landed === true && row.due === false && row.leased === false,
    );
    assert.equal(landed.state, 'ACTIVE', `${kind} ended before anything changed`);
    // The end comes about as production writes it, and the event that would hint goes where the survivor never hears it.
    if (kind === 'MATCH') await sql.query(`UPDATE "task" SET "status" = 'FAILED' WHERE "id" = $1`, [task]);
    else await bringAbout(kind, task);
    writer.hub.publishForUser(owner, RunEventType.TASK_CHANGED, { taskIds: [task], resync: false });
    cases.push({
      kind, state: kind === 'MATCH' ? 'MATCHED' : kind, observer, task, watchId: watch.id, key: keyOf(kind, watch.id),
      sweepAt: landed.nextEvaluateAt!, changedAt: Date.now(),
    });
  }

  const timings: Record<string, unknown> = {};
  for (const item of cases) {
    const ended = await eventually(`${item.kind}: reconciliation to land it`, () => scheduleOf(item.watchId), (row) => row.state === item.state, 30_000);
    assert.ok(
      ended.updatedAt.getTime() >= item.sweepAt.getTime(),
      `${item.kind} landed at ${ended.updatedAt.toISOString()}, before the sweep it was scheduled for at ${item.sweepAt.toISOString()}`,
    );
    await eventually(`${item.kind}: its wake`, () => turnsKeyed(item.observer, item.key), (rows) => rows.length > 0, 30_000);
    await eventually(
      `${item.kind}: its delivery`,
      async () => (await deliveriesOf(item.watchId)).map((row) => [row.kind, row.state].join(' ')),
      (rows) => rows.length === 1 && rows[0] === `${item.kind} DELIVERED`,
      30_000,
    );
    timings[item.kind] = { sweepAt: item.sweepAt.toISOString(), landedAt: ended.updatedAt.toISOString(), changeToLandingMs: ended.updatedAt.getTime() - item.changedAt };
  }

  // More passes change nothing: one wake each.
  survivor.evaluator.kick();
  deliveries.delivery.kick();
  await sleep(3_000);
  for (const item of cases) {
    assert.deepEqual((await turnsOn(item.observer)).map((row) => row.clientTurnId), [item.key], `${item.kind}: the observer holds exactly its one wake`);
    assert.deepEqual((await deliveriesOf(item.watchId)).map((row) => [row.kind, row.state]), [[item.kind, 'DELIVERED']]);
  }
  assert.equal(hintsReachingSurvivor, 0, 'an event published on another replica reached this evaluator');
  assert.equal(pulledDue, 0, 'something pulled a watch due on the survivor');
  note('F-05', { timings, hintsReachingSurvivor, pulledDue });

  // The paired control: an evaluator that hears the publishing hub lands a revocation long before its hour-long sweep.
  await survivor.evaluator.stop();
  const control = await replica({ pollIntervalMs: 100 });
  control.evaluator.start();
  const controlObserver = await insertSession(owner, 'AWAITING_INPUT', runner);
  const controlTask = await insertTask(owner, 'OPEN');
  const controlWatch = await control.watches.create(owner, watchOn(controlTask, controlObserver));
  // Its first landing schedules the next sweep an hour out, capped by the TTL, so nothing claims it again while
  // this runs: landed and not due is that landing's schedule (the lease heuristic above assumes a short sweep).
  const first = await eventually(
    'the control\'s first sweep to land',
    () => scheduleOf(controlWatch.id),
    (row) => row.landed === true && row.due === false,
  );
  await bringAbout('REVOKED', controlTask);
  control.hub.publishForUser(owner, RunEventType.TASK_CHANGED, { taskIds: [controlTask], resync: false });
  const revoked = await eventually('the hinted control to be revoked', () => scheduleOf(controlWatch.id), (row) => row.state === 'REVOKED', 15_000);
  assert.ok(revoked.updatedAt.getTime() < first.nextEvaluateAt!.getTime(), 'the hinted control waited for its sweep, so the case above proved nothing about lost hints');
});

qa('F-06', 'one wake per generation or end: twelve owed wakes of every kind raced by four workers, three re-evaluating replicas and lease reclaims, then every acknowledgement redone, then a stalled worker overtaken — each observer holds exactly one wake with the bytes it was first written with', 900_000, async () => {
  const owner = await insertUser();
  const runner = await insertRunner(owner);
  const replicas = [evaluator, await evaluatorFor(), await evaluatorFor()];
  const workers = [await worker(), await worker(), await worker(), await worker()];
  await warm(workers.map((one) => one.prisma), 4);
  const owed: Owed[] = [];
  for (let i = 0; i < 12; i += 1) {
    const running = i % 2 === 1;
    const observer = await insertSession(owner, running ? 'RUNNING' : 'AWAITING_INPUT', runner);
    if (running) await insertRunningTurn(observer);
    owed.push(await owedWake(KINDS[i % KINDS.length], owner, observer));
  }

  const race = async () => {
    await Promise.all([
      ...workers.map((one) => one.delivery.drain()),
      ...replicas.flatMap((one) => owed.map((item) => one.evaluate(item.watchId))),
      ...workers.map((one) => one.delivery.reclaimExpired()),
    ]);
    for (let pass = 0; pass < 5; pass += 1) await Promise.all(workers.map((one) => one.delivery.drain()));
  };
  const first = new Map<string, TurnRow>();
  const violations: string[] = [];
  const judge = async (phase: string) => {
    for (const item of owed) {
      const label = `${phase} ${item.kind} ${item.watchId}`;
      const rows = await deliveriesOf(item.watchId);
      if (rows.length !== 1 || rows[0].state !== 'DELIVERED') violations.push(`${label}: deliveries ${JSON.stringify(rows.map((row) => row.state))}`);
      const wakes = (await turnsOn(item.observer)).filter((row) => row.clientTurnId.startsWith('watch:'));
      if (wakes.length !== 1 || wakes[0].clientTurnId !== item.key) {
        violations.push(`${label}: wakes ${JSON.stringify(wakes.map((row) => row.clientTurnId))}`);
        continue;
      }
      const seen = first.get(item.deliveryId);
      if (!seen) first.set(item.deliveryId, wakes[0]);
      else if (wakes[0].id !== seen.id || wakes[0].content !== seen.content || wakes[0].status !== seen.status) violations.push(`${label}: the wake was rewritten`);
    }
  };

  await race();
  await judge('raced');
  // As if every acknowledgement had been lost after its turn was written: every delivery is due again.
  await sql.query(
    `UPDATE "watch_delivery" SET "state" = 'PENDING', "delivered_at" = NULL, "next_attempt_at" = now() WHERE "id" = ANY($1::uuid[])`,
    [owed.map((item) => item.deliveryId)],
  );
  await race();
  await judge('redelivered');

  // A worker stalls holding a claim past its lease; another reclaims it and delivers; the stalled attempt writes nothing.
  const stalled = await worker({ leaseMs: 300 });
  const late = await owedWake('UNRESOLVABLE', owner, await insertSession(owner, 'AWAITING_INPUT', runner));
  const [claim] = (await stalled.delivery.claimDue()).filter((row) => row.id === late.deliveryId);
  assert.ok(claim, 'the stalled worker holds the delivery');
  await eventually(
    'the stalled lease to lapse',
    async () => (await sql.query<{ lapsed: boolean }>(`SELECT "lease_deadline_at" <= now() AS "lapsed" FROM "watch_delivery" WHERE "id" = $1`, [late.deliveryId])).rows[0].lapsed,
    (lapsed) => lapsed === true,
  );
  assert.deepEqual(outcomesFor(await workers[0].delivery.drain(), late.deliveryId), ['DELIVERED']);
  assert.equal(await stalled.delivery.deliver(claim), 'LEASE_LOST');
  assert.equal((await turnsKeyed(late.observer, late.key)).length, 1, 'the overtaken worker wrote a second wake');
  const [settled] = await deliveriesOf(late.watchId);
  assert.deepEqual([settled.state, settled.attempts], ['DELIVERED', 1]);

  note('F-06', { owed: owed.length, violations, queueSignals });
  assert.deepEqual(violations, []);
});
