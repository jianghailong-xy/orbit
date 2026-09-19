/**
 * A Watch's expiry, delivered, against a real PostgreSQL (docs/watch-contract.md §5, contract vector
 * `ttl-expiry-wakes-a-waiting-observer`). When a RESUME_SESSION watch expires without its condition
 * ever holding, its observer gets exactly one turn carrying EXPIRED, however often the watch is
 * evaluated, however many workers race the delivery, and however often it is redelivered. A watch that
 * matched gets no such turn, and an observer whose life is over is left as it is, with a dead letter
 * on the watch's own read.
 *
 * The cases use the collaborators production uses: the evaluator's own landing,
 * `SessionsService.createTurn` writing real `conversation_turn` rows, and `RunnerApiController`'s inbox
 * claim and turn completion. The endings that drain a queued expiry unrun — a failed turn, a lost
 * runner, a runner finalize, an owner's end — are driven through the production turn completion, reaper
 * sweep, finalize and end. A case reaches expiry by moving `expires_at` into the past rather than
 * waiting out the 60-second minimum TTL. The evaluator compares that column with the database clock,
 * so both routes reach the same state.
 *
 *     bash scripts/run-pg-spec.sh src/apiserver/src/watches/watch-expiry-delivery.pg.spec.ts
 *
 * Non-destructive: every row carries an id this run generated. Before each case, the watches and
 * deliveries left by earlier cases are retired, so the evaluators and workers a case runs claim only
 * that case's rows.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, beforeEach, test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';

import type { PrismaClient } from '@prisma/client';
import { MAX_PROMPT_CHARS, RunEventType, WATCH_LIMITS } from '@orbit/shared';
import { Client } from 'pg';
import { EMPTY } from 'rxjs';

import { prismaClientFor } from '../prisma/prisma-client';
import { PrismaService } from '../prisma/prisma.service';
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from '../projects/coordinator-pg-test-safety';
import type { PushService } from '../push/push.service';
import type { RealtimeService } from '../realtime/realtime.service';
import { ReaperService } from '../realtime/reaper.service';
import { RunnerApiController } from '../runner-api/runner-api.controller';
import { SessionsService } from '../sessions/sessions.service';
import type { CreateWatchDto } from './dto';
import {
  WatchDeliveryOptions,
  WatchDeliveryOutcome,
  WatchDeliveryResult,
  WatchDeliveryService,
} from './watch-delivery.service';
import { WatchEvaluatorOptions, WatchEvaluatorService } from './watch-evaluator.service';
import { WatchesService } from './watches.service';

const URL = process.env.COORDINATOR_PG_URL;
const skip = !URL;

const HOUR = 60 * 60 * 1000;
const ALL_TERMINAL = { kind: 'ALL', over: 'ALL_TARGETS', leaf: 'TASK_TERMINAL' } as const;

/** A collaborator a case does not observe: every method answers undefined. Not a thenable. */
const inert = <T>(): T =>
  new Proxy({}, { get: (_target, property) => (property === 'then' ? undefined : () => undefined) }) as T;

// ── what the workers tell the rest of the system ───────────────────────────────────────────────

let queueSignals = 0;
const queue = { notifySessionQueued: () => { queueSignals += 1; } };
const realtime = { notifyInbox: () => undefined, publishQueuedTurnsChanged: () => undefined };
const push = { notifyWatchMatched: async () => undefined } as unknown as PushService;
/** A hint source that emits nothing: every evaluation here comes from the sweep or a direct call. */
const noHints = { localPublications: () => EMPTY, publishWatchChanged: () => undefined } as unknown as RealtimeService;

// ── the harness ────────────────────────────────────────────────────────────────────────────────

let sql: Client;
let prisma: PrismaClient;
let watches: WatchesService;
/** Never started: a case lands an evaluation by calling it. */
let evaluator: WatchEvaluatorService;
const clients: PrismaClient[] = [];
const loops: Array<{ stop(): Promise<unknown> }> = [];

/** Refuses the expiry delivery of the watches a case names, so the landing that writes it fails the way a real fault would. */
const FAULTS = `
  CREATE TABLE "pccspec_watch_expiry_fault" ("watch_id" uuid PRIMARY KEY);
  CREATE FUNCTION "pccspec_watch_expiry_fault_refuse"() RETURNS trigger LANGUAGE plpgsql AS $$
  BEGIN
    IF NEW."kind" = 'EXPIRY' AND EXISTS (SELECT 1 FROM "pccspec_watch_expiry_fault" WHERE "watch_id" = NEW."watch_id") THEN
      RAISE EXCEPTION 'injected fault: no expiry delivery may be written for watch %', NEW."watch_id";
    END IF;
    RETURN NEW;
  END $$;
  CREATE TRIGGER "pccspec_watch_expiry_fault_refuse" BEFORE INSERT ON "watch_delivery"
    FOR EACH ROW EXECUTE FUNCTION "pccspec_watch_expiry_fault_refuse"();`;

before(async () => {
  if (skip) return;
  assertCoordinatorPgUrlIsIsolated(URL);
  sql = new Client({ connectionString: URL, connectionTimeoutMillis: 5_000 });
  await sql.connect();
  await verifyCoordinatorPgIdentity(sql);
  prisma = prismaClientFor(URL!);
  clients.push(prisma);
  watches = new WatchesService(prisma as unknown as PrismaService);
  evaluator = new WatchEvaluatorService(prisma as unknown as PrismaService, noHints, {
    reconcileIntervalMs: HOUR,
    pollIntervalMs: HOUR,
  });
  await sql.query(FAULTS);
});

beforeEach(async () => {
  if (skip) return;
  await quiesce();
  // The harness's own pool went with the case before this one, and a case's first write must not be
  // the call that dials it.
  await warm([prisma]);
  queueSignals = 0;
  await sql.query(`DELETE FROM "pccspec_watch_expiry_fault"`);
  await sql.query(`UPDATE "watch" SET "state" = 'CANCELLED', "next_evaluate_at" = NULL WHERE "state" IN ('ACTIVE', 'PAUSED')`);
  await sql.query(
    `UPDATE "watch_delivery"
        SET "state" = 'DEAD_LETTER', "dead_lettered_at" = now(), "last_error" = 'retired before a later case',
            "lease_owner" = NULL, "lease_generation" = NULL, "lease_deadline_at" = NULL
      WHERE "state" IN ('PENDING', 'IN_FLIGHT')`,
  );
});

after(async () => {
  if (skip) return;
  await quiesce();
  await sql
    ?.query(
      `DROP TRIGGER IF EXISTS "pccspec_watch_expiry_fault_refuse" ON "watch_delivery";
       DROP FUNCTION IF EXISTS "pccspec_watch_expiry_fault_refuse"();
       DROP TABLE IF EXISTS "pccspec_watch_expiry_fault";`,
    )
    .catch(() => undefined);
  await sql?.end().catch(() => undefined);
});

/**
 * Stops what a case left running and closes its pools, before the next case opens its own. Each case
 * makes its own, and a pool keeps idle connections for ten seconds: closed only at the end of the file,
 * the cases after one open theirs on top of everything it left up.
 */
async function quiesce(): Promise<void> {
  for (const loop of loops.splice(0)) await loop.stop();
  for (const client of clients.splice(0)) await client.$disconnect().catch(() => undefined);
}

/** pg.Pool's default size, which a PrismaPg built from a URL keeps. */
const POOL_MAX = 10;

/**
 * Opens `connections` connections in each pool before a case bursts work onto it. A replica that has
 * been serving has its pool open when its work arrives; a pool made moments before a burst opens them
 * in the middle of it, and on a starved host each new PostgreSQL connection takes seconds — longer than
 * the two seconds Prisma waits for one before a transaction fails to start (P2028). The race would be
 * the connection handshakes, not the landings, sweeps and turns the case is about.
 */
async function warm(pools: PrismaClient[], connections = POOL_MAX): Promise<void> {
  await Promise.all(pools.flatMap((prisma) => Array.from({ length: connections }, () => prisma.$executeRaw`SELECT pg_sleep(0.1)`)));
}

/**
 * Another replica's evaluator: its own pool, never started unless the case starts it. The pool is
 * connected before it is handed over — see warm().
 */
async function evaluatorFor(options: WatchEvaluatorOptions = {}): Promise<WatchEvaluatorService> {
  const pool = prismaClientFor(URL!);
  clients.push(pool);
  await warm([pool]);
  const replica = new WatchEvaluatorService(pool as unknown as PrismaService, noHints, {
    reconcileIntervalMs: HOUR,
    pollIntervalMs: HOUR,
    ...options,
  });
  loops.push(replica);
  return replica;
}

/**
 * One replica's delivery worker: its own pool and the real sessions service. Its pool is connected
 * before it is handed over — see warm().
 */
async function worker(options: WatchDeliveryOptions = {}, Sessions: typeof SessionsService = SessionsService) {
  const pool = prismaClientFor(URL!);
  clients.push(pool);
  await warm([pool]);
  const sessions = new Sessions(pool as unknown as PrismaService, queue as never, realtime as never);
  const delivery = new WatchDeliveryService(pool as unknown as PrismaService, sessions, push, {
    retryBaseMs: 0,
    retryMaxMs: 0,
    pollIntervalMs: HOUR,
    ...options,
  });
  loops.push(delivery);
  return { prisma: pool, delivery };
}

const outcomesFor = (results: WatchDeliveryResult[], deliveryId: string): WatchDeliveryOutcome[] =>
  results.filter((result) => result.deliveryId === deliveryId).map((result) => result.outcome);

// ── fixtures ───────────────────────────────────────────────────────────────────────────────────

async function insertUser(): Promise<string> {
  const id = randomUUID();
  await sql.query(
    `INSERT INTO "user"("id","email","name","password_hash") VALUES ($1,$2,'watch expiry','h')`,
    [id, `${id}@watch-expiry.invalid`],
  );
  return id;
}

async function insertRunner(owner: string): Promise<string> {
  const id = randomUUID();
  await sql.query(
    `INSERT INTO "runner"("id","name","owner_id","token_hash","status","last_heartbeat_at","capabilities")
     VALUES ($1,'watch expiry',$2,'h','ONLINE',clock_timestamp(),'{}'::text[])`,
    [id, owner],
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

/**
 * An observer that has run: started on an online runner, with a runtime behind it. That is also what
 * makes an ended one REVIVABLE, so an expiry that leaves it alone is refusing, not unable.
 */
async function insertSession(owner: string, status: string, runnerId: string): Promise<string> {
  const id = randomUUID();
  await sql.query(
    `INSERT INTO "session"("id","title","prompt","owner_id","creator_id","updated_at","status","assigned_runner_id",
                           "provider","provider_builtin","num_turns","started_at","runtime_session_id")
     VALUES ($1,'watch observer','the opening prompt',$2,$2,now(),$3,$4,'claude',TRUE,1,now(),$5)`,
    [id, owner, status, runnerId, `runtime-${id}`],
  );
  return id;
}

/**
 * A reply under a turn, as the engine writes one. A completion settles a message turn as ANSWERED only
 * when something answered it, so a turn with none of these under it goes back to the queue instead
 * (criterion 3, ab6407ca4) — and the runner's next take would be handed that turn again rather than
 * what queued behind it, which is the queue shape every case below reads. A turn an engine actually
 * ran has this event.
 */
async function say(turnId: string, sessionId: string, text: string): Promise<void> {
  await sql.query(
    `INSERT INTO "run_event"("id","session_id","seq","type","payload","turn_id")
     VALUES ($1,$2,(SELECT COALESCE(MAX("seq"),0)+1 FROM "run_event" WHERE "session_id" = $2),$3,$4::jsonb,$5)`,
    [randomUUID(), sessionId, RunEventType.ASSISTANT, JSON.stringify({ text }), turnId],
  );
}

async function createWatch(
  owner: string,
  body: { targets: string[]; action?: 'NOTIFY_USER' | 'RESUME_SESSION'; observerSessionId?: string },
) {
  return watches.create(owner, {
    predicateVersion: 1,
    predicate: ALL_TERMINAL,
    targets: body.targets.map((id) => ({ kind: 'TASK', id })),
    action: body.action ?? 'RESUME_SESSION',
    ttlSeconds: WATCH_LIMITS.minTtlSeconds,
    ...(body.observerSessionId ? { observerSessionId: body.observerSessionId } : {}),
  } as unknown as CreateWatchDto);
}

/** A RESUME_SESSION watch on an OPEN task: nothing it watches holds, so its observer is waiting for its TTL. */
async function waitingWatch(owner: string, observerSessionId: string): Promise<string> {
  const watch = await createWatch(owner, { targets: [await insertTask(owner, 'OPEN')], observerSessionId });
  assert.equal(watch.state, 'ACTIVE', 'the fixture condition does not hold at create');
  return watch.id;
}

/**
 * Its TTL runs out: `expires_at` moves into the past. A watch the sweep still has scheduled becomes due
 * no later than that moment, as `watch_next_evaluate_within_ttl_chk` requires; a terminal watch stays
 * unscheduled.
 */
async function expire(watchId: string): Promise<void> {
  const { rowCount } = await sql.query(
    `UPDATE "watch"
        SET "expires_at" = now() - interval '1 second',
            "next_evaluate_at" = CASE WHEN "next_evaluate_at" IS NULL THEN NULL ELSE now() - interval '1 second' END
      WHERE "id" = $1`,
    [watchId],
  );
  assert.equal(rowCount, 1);
}

/** A waiting watch whose TTL ran out, landed EXPIRED by the evaluator. */
async function expiredWatch(owner: string, observerSessionId: string): Promise<string> {
  const watchId = await waitingWatch(owner, observerSessionId);
  await expire(watchId);
  assert.equal((await evaluator.evaluate(watchId)).outcome, 'EXPIRED');
  return watchId;
}

interface DeliveryRow {
  id: string;
  kind: string;
  action: string;
  state: string;
  attempts: number;
  lastError: string | null;
  snapshot: { evaluatedAt: string; targets: unknown[] } | null;
  due: boolean;
  delivered: boolean;
  deadLettered: boolean;
}

/** Every delivery a watch has: its Matches' and its expiry's. */
async function deliveriesOf(watchId: string): Promise<DeliveryRow[]> {
  const { rows } = await sql.query<DeliveryRow>(
    `SELECT d."id", d."kind", d."action", d."state", d."attempts", d."last_error" AS "lastError",
            d."expiry_snapshot" AS "snapshot", d."next_attempt_at" <= now() AS "due",
            d."delivered_at" IS NOT NULL AS "delivered", d."dead_lettered_at" IS NOT NULL AS "deadLettered"
       FROM "watch_delivery" d LEFT JOIN "watch_match" m ON m."id" = d."match_id"
      WHERE d."watch_id" = $1 OR m."watch_id" = $1
      ORDER BY d."created_at", d."id"`,
    [watchId],
  );
  return rows;
}

async function onlyExpiry(watchId: string): Promise<DeliveryRow> {
  const rows = await deliveriesOf(watchId);
  assert.deepEqual(rows.map((row) => row.kind), ['EXPIRY'], `an expired watch has one delivery, its expiry's: ${JSON.stringify(rows)}`);
  return rows[0];
}

interface TurnRow {
  id: string;
  seq: number;
  clientTurnId: string;
  kind: string;
  status: string;
  sendIntent: string | null;
  content: string | null;
}

async function turnsOn(sessionId: string): Promise<TurnRow[]> {
  const { rows } = await sql.query<TurnRow>(
    `SELECT "id", "seq", "client_turn_id" AS "clientTurnId", "kind", "status", "send_intent" AS "sendIntent", "content"
       FROM "conversation_turn" WHERE "session_id" = $1 ORDER BY "seq"`,
    [sessionId],
  );
  return rows;
}

async function sessionOf(id: string) {
  const { rows } = await sql.query<{ status: string; endReason: string | null; completed: boolean; trashed: boolean; cancelling: boolean }>(
    `SELECT "status", "end_reason" AS "endReason", "completed_at" IS NOT NULL AS "completed",
            "deleted_at" IS NOT NULL AS "trashed", "cancel_requested_at" IS NOT NULL AS "cancelling"
       FROM "session" WHERE "id" = $1`,
    [id],
  );
  return rows[0];
}

async function watchStateOf(id: string): Promise<string> {
  const { rows } = await sql.query<{ state: string }>(`SELECT "state" FROM "watch" WHERE "id" = $1`, [id]);
  return rows[0].state;
}

async function leaseLapsed(deliveryId: string): Promise<boolean> {
  const { rows } = await sql.query<{ lapsed: boolean }>(
    `SELECT "lease_deadline_at" <= now() AS "lapsed" FROM "watch_delivery" WHERE "id" = $1`,
    [deliveryId],
  );
  return rows[0]?.lapsed === true;
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

/** The statement is refused, and the refusal names the constraint meant. */
async function refuses(run: () => Promise<unknown>, expected: RegExp, why: string): Promise<void> {
  const error = await run().then(() => null, (e: Error) => e);
  assert.ok(error, `${why} — this write should have been refused, but it succeeded`);
  assert.match(error.message, expected, why);
}

/**
 * The plan for a query with sequential scans priced out. With no usable index the planner still
 * returns a sequential scan, so a plan that names an index shows that index covers the query.
 */
async function planFor(query: string): Promise<string> {
  await sql.query('BEGIN');
  try {
    await sql.query('SET LOCAL enable_seqscan = off');
    const plan = await sql.query<{ 'QUERY PLAN': string }>(`EXPLAIN ${query}`);
    return plan.rows.map((row) => row['QUERY PLAN']).join('\n');
  } finally {
    await sql.query('ROLLBACK');
  }
}

// ── cases ──────────────────────────────────────────────────────────────────────────────────────

test('0261: an expiry delivery names its watch, carries an object snapshot and is one per watch, while a Match\'s delivery is written exactly as before', { skip, timeout: 120_000 }, async () => {
  const owner = await insertUser();
  const observer = await insertSession(owner, 'AWAITING_INPUT', await insertRunner(owner));
  const watchId = await waitingWatch(owner, observer);

  // 0259's writers, unchanged: the create path's own write, and a raw INSERT naming only 0259's columns.
  const matched = await createWatch(owner, { targets: [await insertTask(owner, 'FAILED')], observerSessionId: observer });
  assert.equal(matched.state, 'MATCHED');
  const matchId = matched.matches[0].id;
  await sql.query(
    `INSERT INTO "watch_delivery" ("id", "match_id", "action", "next_attempt_at") VALUES ($1, $2, 'NOTIFY_USER', now())`,
    [randomUUID(), matchId],
  );
  assert.deepEqual(
    (await deliveriesOf(matched.id)).map(({ kind, action }) => `${kind} ${action}`).sort(),
    ['MATCH NOTIFY_USER', 'MATCH RESUME_SESSION'],
    'a row written without a kind is a MATCH row',
  );
  await refuses(
    () => sql.query(`INSERT INTO "watch_delivery" ("id", "match_id", "action") VALUES ($1, $2, 'RESUME_SESSION')`, [randomUUID(), matchId]),
    /watch_delivery_match_action_key/,
    'a Match still causes one delivery per action',
  );

  const insertExpiry = (over: Record<string, unknown> = {}) => {
    const row: Record<string, unknown> = {
      id: randomUUID(),
      kind: 'EXPIRY',
      watch_id: watchId,
      action: 'RESUME_SESSION',
      expiry_snapshot: JSON.stringify({ evaluatedAt: new Date().toISOString(), targets: [] }),
      ...over,
    };
    const cols = Object.keys(row);
    return sql.query(
      `INSERT INTO "watch_delivery" (${cols.map((col) => `"${col}"`).join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')})`,
      Object.values(row),
    );
  };
  // PostgreSQL reports the first CHECK a row violates, in constraint-name order, so each counter-example
  // below breaks exactly one rule.
  for (const [over, why] of [
    [{ watch_id: null }, 'an expiry that names no watch is a delivery of nothing'],
    [{ match_id: matchId }, 'an expiry that also names a Match is two deliveries in one row'],
    [{ expiry_snapshot: null }, 'an expiry with no snapshot would build its turn from rows that may have moved'],
    [{ expiry_snapshot: JSON.stringify('the watch timed out') }, 'the snapshot is structured, never prose'],
    [{ action: 'NOTIFY_USER' }, 'the expiry turn is owed to a waiting session, and a notification has none'],
    [{ kind: 'MATCH' }, 'a MATCH row names its Match and nothing else'],
  ] as Array<[Record<string, unknown>, string]>) {
    await refuses(() => insertExpiry(over), /watch_delivery_kind_shape_chk/, why);
  }
  await refuses(() => insertExpiry({ kind: 'TIMEOUT' }), /watch_delivery_kind_chk/, 'the delivery kinds are a closed set');

  // The row that breaks none is accepted, once per watch.
  await insertExpiry();
  await refuses(() => insertExpiry(), /watch_delivery_expiry_watch_key/, 'a watch expires once, so it has one expiry delivery');

  // The index serves both the "this watch's expiry" read and the foreign key's cascade, which removes the row with its watch.
  assert.match(await planFor(`SELECT "id" FROM "watch_delivery" WHERE "watch_id" = '${watchId}'`), /watch_delivery_expiry_watch_key/);
  await sql.query(`DELETE FROM "watch" WHERE "id" = $1`, [watchId]);
  assert.deepEqual(await deliveriesOf(watchId), [], 'a deleted watch left its expiry delivery behind');
});

test('the evaluator lands EXPIRED together with the expiry delivery, once, however often and however concurrently the watch is evaluated', { skip, timeout: 120_000 }, async () => {
  const owner = await insertUser();
  const observer = await insertSession(owner, 'AWAITING_INPUT', await insertRunner(owner));
  const task = await insertTask(owner, 'OPEN');
  const watch = await createWatch(owner, { targets: [task], observerSessionId: observer });
  await expire(watch.id);

  await sql.query(`INSERT INTO "pccspec_watch_expiry_fault" VALUES ($1)`, [watch.id]);
  await assert.rejects(evaluator.evaluate(watch.id), /injected fault: no expiry delivery may be written/);
  assert.equal(await watchStateOf(watch.id), 'ACTIVE', 'EXPIRED outlived the delivery it was landed with');
  assert.deepEqual(await deliveriesOf(watch.id), []);

  // The control: the same landing with nothing refusing it, raced by three replicas.
  await sql.query(`DELETE FROM "pccspec_watch_expiry_fault"`);
  const replicas = await Promise.all([evaluatorFor(), evaluatorFor()]);
  const raced = await Promise.all([evaluator, ...replicas].map((replica) => replica.evaluate(watch.id)));
  assert.deepEqual(raced.map((evaluation) => evaluation.outcome).sort(), ['EXPIRED', 'SETTLED', 'SETTLED']);
  const delivery = await onlyExpiry(watch.id);
  assert.equal(delivery.action, 'RESUME_SESSION');
  assert.equal(delivery.state, 'PENDING');
  assert.equal(delivery.attempts, 0);
  assert.equal(delivery.due, true, 'and is due at once');
  assert.deepEqual(
    delivery.snapshot?.targets,
    [{ kind: 'TASK', id: task, epoch: 0, state: 'OBSERVED', changed: false, leaves: { TASK_TERMINAL: false }, observed: { status: 'OPEN' } }],
    "the expiring evaluation's reading of every target",
  );

  // Looked at again, by a direct call and by a sweep, it is still one row.
  assert.equal((await evaluator.evaluate(watch.id)).outcome, 'SETTLED');
  await evaluator.drain();
  assert.equal((await onlyExpiry(watch.id)).id, delivery.id);

  // Pausing does not stop the TTL (contract §3), and a paused watch's expiry is delivered the same way.
  // A paused watch is not evaluated, so its snapshot lists the targets as recorded and no reading of them.
  const pausedTask = await insertTask(owner, 'OPEN');
  const paused = await createWatch(owner, { targets: [pausedTask], observerSessionId: observer });
  assert.equal((await watches.pause(owner, paused.id)).state, 'PAUSED');
  await expire(paused.id);
  assert.equal((await evaluator.evaluate(paused.id)).outcome, 'EXPIRED');
  assert.deepEqual(
    (await onlyExpiry(paused.id)).snapshot?.targets,
    [{ kind: 'TASK', id: pausedTask, epoch: 0, state: 'OBSERVED', changed: false }],
  );

  // A notification has nobody waiting on it: its expiry is recorded, and nothing is queued to deliver.
  const notifying = await createWatch(owner, { targets: [await insertTask(owner, 'OPEN')], action: 'NOTIFY_USER' });
  await expire(notifying.id);
  assert.equal((await evaluator.evaluate(notifying.id)).outcome, 'EXPIRED');
  assert.deepEqual(await deliveriesOf(notifying.id), []);
});

test('the observer waiting on the watch gets one turn, keyed watch:<id>:expired and carrying EXPIRED, however many workers race it and however often it is redelivered', { skip, timeout: 120_000 }, async () => {
  const owner = await insertUser();
  const observer = await insertSession(owner, 'AWAITING_INPUT', await insertRunner(owner));
  const watchId = await expiredWatch(owner, observer);
  const { id: deliveryId, snapshot } = await onlyExpiry(watchId);

  const workers = await Promise.all([worker(), worker(), worker()]);
  const raced = (await Promise.all(workers.map(({ delivery }) => delivery.drain()))).flat();
  assert.deepEqual(outcomesFor(raced, deliveryId), ['DELIVERED']);

  const turns = await turnsOn(observer);
  assert.equal(turns.length, 1, 'one expiry, one turn');
  const [turn] = turns;
  assert.equal(turn.clientTurnId, `watch:${watchId}:expired`);
  assert.equal(turn.kind, 'message');
  assert.equal(turn.sendIntent, 'NEXT_TURN');
  assert.equal(turn.status, 'PENDING');
  assert.equal((await sessionOf(observer)).status, 'PENDING', 'a parked observer waits for a runner slot like any sent message');
  assert.equal(queueSignals, 1, 'the queue was told once');
  const delivered = await onlyExpiry(watchId);
  assert.equal(delivered.state, 'DELIVERED');
  assert.equal(delivered.attempts, 0);

  // What the session reads: a line saying it EXPIRED, then the structured payload, and nothing else fenced.
  const content = turn.content ?? '';
  const fenced = [...content.matchAll(/```json\n([\s\S]*?)\n```/g)];
  assert.equal(fenced.length, 1, 'one structured payload');
  const payload = JSON.parse(fenced[0][1]);
  assert.deepEqual(Object.keys(payload), ['watchId', 'state', 'expiresAt', 'latestSnapshot']);
  assert.equal(payload.watchId, watchId);
  assert.equal(payload.state, 'EXPIRED');
  const { rows: [{ expiresAtMs }] } = await sql.query(
    `SELECT floor(extract(epoch FROM "expires_at") * 1000)::bigint::text AS "expiresAtMs" FROM "watch" WHERE "id" = $1`,
    [watchId],
  );
  assert.ok(Math.abs(Date.parse(payload.expiresAt) - Number(expiresAtMs)) <= 1, 'the TTL the watch ran out at');
  assert.deepEqual(payload.latestSnapshot, snapshot, 'the snapshot the expiry was landed with, not a later read');
  assert.equal(content.split('\n')[0], `Orbit Watch ${watchId} EXPIRED at ${payload.expiresAt} without its condition ever holding.`);

  // Redelivered after its turn was written, as by a requeue or an acknowledgement that never landed: the
  // key collapses it onto the turn that is already there.
  await sql.query(
    `UPDATE "watch_delivery" SET "state" = 'PENDING', "delivered_at" = NULL, "next_attempt_at" = now() WHERE "id" = $1`,
    [deliveryId],
  );
  assert.deepEqual(outcomesFor(await workers[1].delivery.drain(), deliveryId), ['DELIVERED']);
  assert.deepEqual(await turnsOn(observer), turns, 'the redelivery wrote a second turn or changed the first');
  assert.equal(queueSignals, 1, 'the redelivery queued the session again');
  assert.equal((await onlyExpiry(watchId)).state, 'DELIVERED');
});

test('a worker whose lease on an expiry was taken over writes nothing, neither turn nor acknowledgement, and the takeover delivers the one turn', { skip, timeout: 120_000 }, async () => {
  const owner = await insertUser();
  const observer = await insertSession(owner, 'AWAITING_INPUT', await insertRunner(owner));
  const watchId = await expiredWatch(owner, observer);
  const { id: deliveryId } = await onlyExpiry(watchId);

  // Worker A stalls between reading its claimed delivery and writing the turn.
  let release!: () => void;
  const stalled = new Promise<void>((resolve) => { release = resolve; });
  let arrived!: () => void;
  const atTheQueue = new Promise<void>((resolve) => { arrived = resolve; });
  class StalledSessions extends SessionsService {
    override async createTurn(...args: Parameters<SessionsService['createTurn']>) {
      arrived();
      await stalled;
      return super.createTurn(...args);
    }
  }
  const a = await worker({ leaseMs: 300 }, StalledSessions);
  const b = await worker();
  const [claim] = (await a.delivery.claimDue()).filter((row) => row.id === deliveryId);
  assert.ok(claim, 'A holds the delivery');
  const attempt = a.delivery.deliver(claim);
  await atTheQueue;

  // A's lease runs out while it waits, and the sweep takes the delivery back.
  await eventually("A's lease to run out", () => leaseLapsed(deliveryId), (lapsed) => lapsed);
  assert.equal(await b.delivery.reclaimExpired(), 1);
  const reclaimed = await onlyExpiry(watchId);
  assert.equal(reclaimed.state, 'PENDING');
  assert.equal(reclaimed.attempts, 1, 'the abandoned attempt is counted');
  assert.match(reclaimed.lastError ?? '', /^LEASE_EXPIRED:/);

  // A resumes: its acknowledgement no longer matches the row, and its turn is rolled back with it.
  release();
  assert.equal(await attempt, 'LEASE_LOST');
  assert.deepEqual(await turnsOn(observer), [], 'a worker that lost its lease wrote a turn');
  assert.equal((await sessionOf(observer)).status, 'AWAITING_INPUT', 'a worker that lost its lease moved the session');

  assert.deepEqual(outcomesFor(await b.delivery.drain(), deliveryId), ['DELIVERED']);
  assert.deepEqual((await turnsOn(observer)).map((turn) => turn.clientTurnId), [`watch:${watchId}:expired`]);
  const settled = await onlyExpiry(watchId);
  assert.equal(settled.state, 'DELIVERED');
  assert.equal(settled.attempts, 1);

  // A, trying again under the lease it lost, changes nothing.
  assert.equal(await a.delivery.deliver(claim), 'LEASE_LOST');
  assert.equal((await turnsOn(observer)).length, 1);
});

test('a watch that matched owes no expiry turn, even once its TTL is behind it, and a condition that already holds when a late evaluation looks is a Match, not an expiry', { skip, timeout: 120_000 }, async () => {
  const owner = await insertUser();
  const observer = await insertSession(owner, 'AWAITING_INPUT', await insertRunner(owner));
  const { delivery } = await worker();

  // Matched while it was live; then its TTL passes, and it is evaluated and swept again.
  const task = await insertTask(owner, 'OPEN');
  const matched = await createWatch(owner, { targets: [task], observerSessionId: observer });
  await sql.query(`UPDATE "task" SET "status" = 'FAILED' WHERE "id" = $1`, [task]);
  assert.equal((await evaluator.evaluate(matched.id)).outcome, 'MATCHED');
  await expire(matched.id);
  assert.equal((await evaluator.evaluate(matched.id)).outcome, 'SETTLED');
  await evaluator.drain();

  // First looked at after its TTL ran out, with its condition already holding.
  const late = await insertTask(owner, 'OPEN');
  const lateWatch = await createWatch(owner, { targets: [late], observerSessionId: observer });
  await sql.query(`UPDATE "task" SET "status" = 'FAILED' WHERE "id" = $1`, [late]);
  await expire(lateWatch.id);
  assert.equal((await evaluator.evaluate(lateWatch.id)).outcome, 'MATCHED');

  for (const id of [matched.id, lateWatch.id]) {
    assert.deepEqual((await deliveriesOf(id)).map((row) => row.kind), ['MATCH'], "a matched watch has its Match's delivery and no expiry");
  }
  await delivery.drain();
  const woken = await turnsOn(observer);
  assert.deepEqual(
    woken.map((turn) => turn.clientTurnId).sort(),
    [`watch:${matched.id}:1`, `watch:${lateWatch.id}:1`].sort(),
    'each matched watch woke its observer once, by generation',
  );
  assert.ok(woken.every((turn) => !(turn.content ?? '').includes('EXPIRED')), 'a matched watch told its observer it EXPIRED');

  // The paired control, last: on the same observer, a watch that never matched is delivered its expiry.
  const waiting = await expiredWatch(owner, observer);
  assert.deepEqual(outcomesFor(await delivery.drain(), (await onlyExpiry(waiting)).id), ['DELIVERED']);
  assert.deepEqual(
    (await turnsOn(observer)).filter((turn) => (turn.content ?? '').includes('EXPIRED')).map((turn) => turn.clientTurnId),
    [`watch:${waiting}:expired`],
  );
});

test('an expiry never revives an observer whose life is over: Completed, ended, ending and Trash are dead letters the watch read shows', { skip, timeout: 180_000 }, async () => {
  const owner = await insertUser();
  const runner = await insertRunner(owner);
  const { delivery } = await worker();
  const cases = [
    { name: 'moved to Completed', end: `UPDATE "session" SET "completed_at" = now() WHERE "id" = $1`, code: 'OBSERVER_SESSION_COMPLETED' },
    { name: 'its run succeeded', end: `UPDATE "session" SET "status" = 'SUCCEEDED', "finished_at" = now() WHERE "id" = $1`, code: 'OBSERVER_SESSION_ENDED' },
    { name: 'ended, interrupted with an end reason', end: `UPDATE "session" SET "status" = 'INTERRUPTED', "end_reason" = 'ended' WHERE "id" = $1`, code: 'OBSERVER_SESSION_ENDED' },
    { name: 'being ended', end: `UPDATE "session" SET "cancel_requested_at" = now(), "end_reason" = 'ended' WHERE "id" = $1`, code: 'OBSERVER_SESSION_ENDED' },
    { name: 'in Trash', end: `UPDATE "session" SET "deleted_at" = now() WHERE "id" = $1`, code: 'OBSERVER_SESSION_IN_TRASH' },
  ];
  for (const { name, end, code } of cases) {
    const observer = await insertSession(owner, 'AWAITING_INPUT', runner);
    const watchId = await expiredWatch(owner, observer);
    const { id: deliveryId } = await onlyExpiry(watchId);
    await sql.query(end, [observer]);
    const before = await sessionOf(observer);

    assert.deepEqual(outcomesFor(await delivery.drain(), deliveryId), ['DEAD_LETTER'], `${name}: not refused for good`);
    assert.deepEqual(await turnsOn(observer), [], `${name}: a turn was written`);
    assert.deepEqual(await sessionOf(observer), before, `${name}: the observer was changed`);
    assert.equal(queueSignals, 0, `${name}: the observer was queued`);
    const settled = await onlyExpiry(watchId);
    assert.equal(settled.state, 'DEAD_LETTER', name);
    assert.equal(settled.attempts, 1, `${name}: a refusal is retried`);
    assert.ok(settled.lastError?.startsWith(`${code}:`), `${name}: ${settled.lastError}`);

    // The dead letter is on the watch's own read, with why.
    const view = await watches.get(owner, watchId);
    assert.equal(view.state, 'EXPIRED', name);
    assert.deepEqual(
      view.expiryDeliveries.map(({ id, state, attempts, lastError, deadLetteredAt }) => ({ id, state, attempts, lastError, deadLettered: deadLetteredAt !== null })),
      [{ id: deliveryId, state: 'DEAD_LETTER', attempts: 1, lastError: settled.lastError, deadLettered: true }],
      `${name}: the dead letter is missing from the watch read`,
    );
  }

  // The paired control, last: the same expiry on an observer that is alive is delivered.
  const alive = await insertSession(owner, 'AWAITING_INPUT', runner);
  const aliveWatch = await expiredWatch(owner, alive);
  assert.deepEqual(outcomesFor(await delivery.drain(), (await onlyExpiry(aliveWatch)).id), ['DELIVERED']);
  assert.deepEqual((await turnsOn(alive)).map((turn) => turn.clientTurnId), [`watch:${aliveWatch}:expired`]);
});

test('an expiry over the largest target set still fits in one turn: the snapshot is replaced by a pointer to the watch read, which returns it whole', { skip, timeout: 120_000 }, async () => {
  const owner = await insertUser();
  const observer = await insertSession(owner, 'AWAITING_INPUT', await insertRunner(owner));
  const { rows: tasks } = await sql.query<{ id: string }>(
    `INSERT INTO "task"("id","title","owner_id","creator_type","creator_id","updated_at","completion_criterion","status")
     SELECT gen_random_uuid(),'watched work',$1,'USER',$1,now(),'EVIDENCE_JUDGMENT','OPEN' FROM generate_series(1, $2::int)
     RETURNING "id"`,
    [owner, WATCH_LIMITS.maxTargetsPerWatch],
  );
  const watch = await createWatch(owner, { targets: tasks.map((task) => task.id), observerSessionId: observer });
  assert.equal(watch.state, 'ACTIVE');
  await expire(watch.id);
  assert.equal((await evaluator.evaluate(watch.id)).outcome, 'EXPIRED');
  const { id: deliveryId, snapshot } = await onlyExpiry(watch.id);
  assert.ok(JSON.stringify(snapshot, null, 2).length > MAX_PROMPT_CHARS, 'the whole snapshot would not fit in a turn');
  const { delivery } = await worker();
  assert.deepEqual(outcomesFor(await delivery.drain(), deliveryId), ['DELIVERED']);

  const [turn] = await turnsOn(observer);
  assert.ok(turn.content && turn.content.length <= MAX_PROMPT_CHARS);
  const payload = JSON.parse(/```json\n([\s\S]*?)\n```/.exec(turn.content)![1]);
  assert.equal(payload.state, 'EXPIRED');
  assert.equal(payload.latestSnapshot.targets, WATCH_LIMITS.maxTargetsPerWatch);
  assert.match(payload.latestSnapshot.omitted, new RegExp(`/api/watches/${watch.id}`));
  const view = await watches.get(owner, watch.id);
  assert.deepEqual(view.expiryDeliveries.map((row) => row.expirySnapshot), [snapshot], 'the read the turn points at returns the snapshot whole');
});

test('with the evaluator and the delivery worker running and nothing called by hand, the TTL runs out and the runner is handed the expiry turn after the turn a RUNNING observer is on', { skip, timeout: 120_000 }, async () => {
  const owner = await insertUser();
  const runner = await insertRunner(owner);
  const observer = await insertSession(owner, 'RUNNING', runner);
  const current = randomUUID();
  await sql.query(
    `INSERT INTO "conversation_turn"("id","session_id","seq","client_turn_id","kind","content","status","delivered_at","lease_deadline_at")
     VALUES ($1,$2,1,$3,'message','the turn the session is running','IN_FLIGHT',now(),now() + interval '10 minutes')`,
    [current, observer, `current-${current}`],
  );
  await say(current, observer, 'working on it');
  const watchId = await waitingWatch(owner, observer);

  const sweeping = await evaluatorFor({ pollIntervalMs: 100 });
  const { delivery, prisma: pool } = await worker({ pollIntervalMs: 100 });
  sweeping.start();
  delivery.start();
  await expire(watchId);

  const [wake] = await eventually(
    'the expiry turn',
    async () => (await turnsOn(observer)).filter((turn) => turn.clientTurnId === `watch:${watchId}:expired`),
    (turns) => turns.length > 0,
  );
  await eventually('its delivery to settle', () => deliveriesOf(watchId), (rows) => rows.length === 1 && rows[0].state === 'DELIVERED');
  await sweeping.stop();
  await delivery.stop();
  assert.equal(await watchStateOf(watchId), 'EXPIRED');
  assert.equal(wake.status, 'PENDING');
  assert.equal(wake.seq, 2, 'behind the running turn');
  assert.equal((await sessionOf(observer)).status, 'RUNNING', 'still the one run it was');

  const runnerApi = new RunnerApiController(pool as never, queue as never, inert<never>(), inert<never>(), inert<never>(), inert<never>(), inert<never>());
  const inbox = runnerApi as unknown as {
    dequeueTurn(
      sessionId: string,
      runnerId: string,
      leaseGeneration: null,
      acceptsSteer: boolean,
      declaredCapabilities: readonly string[],
    ): Promise<{ turnId: string; content?: string } | null>;
  };
  assert.equal(await inbox.dequeueTurn(observer, runner, null, false, []), null, 'the runner was handed the expiry while the current turn runs');
  await runnerApi.turnComplete({ id: runner }, observer, {
    turnId: current,
    status: 'SUCCEEDED',
    subtype: 'completed',
    numTurns: 2,
    costUsd: 0,
  } as never);
  const next = await inbox.dequeueTurn(observer, runner, null, false, []);
  assert.equal(next?.turnId, wake.id, 'the expiry turn is the next thing the runner is handed');
  assert.ok(wake.content && next?.content?.includes(wake.content), 'with the content it was queued with');
});

// ── an expiry its observer's ending drains unrun ───────────────────────────────────────────────

interface QueuedExpiry {
  observer: string;
  watchId: string;
  deliveryId: string;
  wakeId: string;
}

/**
 * An observer RUNNING a turn, with its expiry queued behind it and the expiry's delivery DELIVERED: the
 * state each way that run can end meets (watch-wake-drain.ts). It has already said something — a
 * completion over a turn nothing answered hands that turn back to the queue, and the runner's next take
 * would be handed it again rather than the expiry waiting behind it.
 */
async function expiryQueuedBehindRunningTurn(
  owner: string,
  runner: string,
  pool: Awaited<ReturnType<typeof worker>>,
): Promise<QueuedExpiry & { current: string }> {
  const observer = await insertSession(owner, 'RUNNING', runner);
  const current = randomUUID();
  await sql.query(
    `INSERT INTO "conversation_turn"("id","session_id","seq","client_turn_id","kind","content","status","delivered_at","lease_deadline_at")
     VALUES ($1,$2,1,$3,'message','the turn the session is running','IN_FLIGHT',now(),now() + interval '10 minutes')`,
    [current, observer, `current-${current}`],
  );
  await say(current, observer, 'working on it');
  const watchId = await expiredWatch(owner, observer);
  const { id: deliveryId } = await onlyExpiry(watchId);
  assert.deepEqual(outcomesFor(await pool.delivery.drain(), deliveryId), ['DELIVERED']);
  const [wake] = (await turnsOn(observer)).filter((turn) => turn.clientTurnId === `watch:${watchId}:expired`);
  assert.equal(wake?.status, 'PENDING', 'the expiry waits behind the running turn');
  return { observer, current, watchId, deliveryId, wakeId: wake.id };
}

/** The ending answered the expiry away unrun, its delivery says so on the watch's own read, and the watch is the terminal fact it was. */
async function assertExpiryDeadLettered(owner: string, queued: QueuedExpiry, ending: string): Promise<void> {
  const [wake] = (await turnsOn(queued.observer)).filter((turn) => turn.id === queued.wakeId);
  assert.equal(wake.status, 'ANSWERED', `${ending}: the queue is drained as it always was`);
  const settled = await onlyExpiry(queued.watchId);
  assert.equal(settled.state, 'DEAD_LETTER', `${ending}: an expiry no runner took still reads ${settled.state}`);
  assert.equal(settled.deadLettered, true, ending);
  assert.equal(settled.delivered, false, ending);
  assert.match(settled.lastError ?? '', /^OBSERVER_SESSION_ENDED: /, ending);
  const view = await watches.get(owner, queued.watchId);
  assert.equal(view.state, 'EXPIRED', `${ending}: the watch is the terminal fact it was`);
  assert.deepEqual(
    view.expiryDeliveries.map(({ id, state, lastError }) => ({ id, state, lastError })),
    [{ id: queued.deliveryId, state: 'DEAD_LETTER', lastError: settled.lastError }],
    `${ending}: its dead letter is on the watch's read`,
  );
}

test('an expiry still queued when its observer\'s running turn fails is a dead letter, not DELIVERED; an expiry the runner took stays delivered when its own turn fails', { skip, timeout: 120_000 }, async () => {
  const owner = await insertUser();
  const runner = await insertRunner(owner);
  const pool = await worker();
  const runnerApi = new RunnerApiController(pool.prisma as never, queue as never, inert<never>(), inert<never>(), inert<never>(), inert<never>(), inert<never>());
  const inbox = runnerApi as unknown as {
    dequeueTurn(
      sessionId: string,
      runnerId: string,
      leaseGeneration: null,
      acceptsSteer: boolean,
      declaredCapabilities: readonly string[],
    ): Promise<{ turnId: string } | null>;
  };
  const complete = (observer: string, turnId: string, status: 'SUCCEEDED' | 'FAILED') =>
    runnerApi.turnComplete({ id: runner }, observer, {
      turnId,
      status,
      subtype: status === 'FAILED' ? 'error_during_execution' : 'completed',
      ...(status === 'FAILED' ? { result: 'API Error: 529 overloaded' } : {}),
      numTurns: 2,
      costUsd: 0,
    } as never);
  // Another observer of the same owner on the same runner, whose run nothing here ends.
  const bystander = await expiryQueuedBehindRunningTurn(owner, runner, pool);

  const queued = await expiryQueuedBehindRunningTurn(owner, runner, pool);
  await complete(queued.observer, queued.current, 'FAILED');
  assert.equal((await sessionOf(queued.observer)).status, 'FAILED');
  await assertExpiryDeadLettered(owner, queued, 'the running turn failed');
  assert.deepEqual(outcomesFor(await pool.delivery.drain(), queued.deliveryId), [], 'a dead letter is never claimed again');

  // The control: the runner took the expiry, and it is the expiry's own turn that fails. The engine
  // received it, so it was delivered, whatever its run came to.
  const taken = await expiryQueuedBehindRunningTurn(owner, runner, pool);
  await complete(taken.observer, taken.current, 'SUCCEEDED');
  assert.equal((await inbox.dequeueTurn(taken.observer, runner, null, false, []))?.turnId, taken.wakeId, 'the runner took the expiry');
  // The expiry RAN, so its completion carries the reply an engine that ran produces: a turn nothing
  // answered goes back to the queue, and a run that ends with it queued drains it as an expiry no
  // runner ever took, which is the death this control is about.
  await say(taken.wakeId, taken.observer, 'the expiry ran');
  await complete(taken.observer, taken.wakeId, 'FAILED');
  assert.equal((await sessionOf(taken.observer)).status, 'FAILED', 'the run the expiry started failed');
  assert.equal((await onlyExpiry(taken.watchId)).state, 'DELIVERED', 'an expiry the runner took was dead-lettered by its run failing');

  const [waiting] = (await turnsOn(bystander.observer)).filter((turn) => turn.id === bystander.wakeId);
  assert.equal(waiting.status, 'PENDING', 'another observer lost its queued expiry');
  assert.equal((await onlyExpiry(bystander.watchId)).state, 'DELIVERED', 'the other observers\' endings dead-lettered this one\'s expiry');
});

test('an expiry still queued when its observer\'s runner is lost is a dead letter: the reaper finalizes the run and drains the expiry unrun', { skip, timeout: 120_000 }, async () => {
  const owner = await insertUser();
  const runner = await insertRunner(owner);
  const pool = await worker();
  const queued = await expiryQueuedBehindRunningTurn(owner, runner, pool);

  // The runner stops heartbeating past the offline window, and the production sweep runs.
  await sql.query(`UPDATE "runner" SET "last_heartbeat_at" = now() - interval '10 minutes' WHERE "id" = $1`, [runner]);
  const reaper = new ReaperService(pool.prisma as unknown as PrismaService, inert<never>());
  await (reaper as unknown as { sweep(): Promise<void> }).sweep();

  const { rows: [session] } = await sql.query<{ status: string; retryArmed: boolean }>(
    `SELECT "status", "retry_at" IS NOT NULL AS "retryArmed" FROM "session" WHERE "id" = $1`,
    [queued.observer],
  );
  assert.deepEqual(session, { status: 'FAILED', retryArmed: true }, 'the reaper finalized the observer, with its retry armed');
  await assertExpiryDeadLettered(owner, queued, 'the runner was lost');
});

test('an expiry still queued when the runner finalizes its observer\'s run is a dead letter, and so is a Match\'s wake queued beside it', { skip, timeout: 120_000 }, async () => {
  const owner = await insertUser();
  const runner = await insertRunner(owner);
  const pool = await worker();
  const queued = await expiryQueuedBehindRunningTurn(owner, runner, pool);
  // The same observer also waits on a watch that matched: its wake queues behind the expiry's.
  const matched = await createWatch(owner, { targets: [await insertTask(owner, 'FAILED')], observerSessionId: queued.observer });
  assert.equal(matched.state, 'MATCHED');
  const [{ id: matchDeliveryId }] = await deliveriesOf(matched.id);
  assert.deepEqual(outcomesFor(await pool.delivery.drain(), matchDeliveryId), ['DELIVERED']);
  assert.deepEqual(
    (await turnsOn(queued.observer)).filter((turn) => turn.status === 'PENDING').map((turn) => turn.clientTurnId),
    [`watch:${queued.watchId}:expired`, `watch:${matched.id}:1`],
  );
  const runnerApi = new RunnerApiController(pool.prisma as never, queue as never, inert<never>(), inert<never>(), inert<never>(), inert<never>(), inert<never>());

  await runnerApi.finalize({ id: runner }, queued.observer, { status: 'FAILED', error: 'the engine exited' } as never);
  assert.equal((await sessionOf(queued.observer)).status, 'FAILED');
  await assertExpiryDeadLettered(owner, queued, 'the runner finalized the run');
  const [matchSettled] = await deliveriesOf(matched.id);
  assert.equal(matchSettled.state, 'DEAD_LETTER', 'the Match\'s wake queued beside the expiry still reads DELIVERED');
  assert.match(matchSettled.lastError ?? '', /^OBSERVER_SESSION_ENDED: /);
});

test('an expiry still queued when its running observer is ended is a dead letter', { skip, timeout: 120_000 }, async () => {
  const owner = await insertUser();
  const runner = await insertRunner(owner);
  const pool = await worker();
  // The service the owner's end goes through, with its post-commit announcements sent nowhere.
  const sessions = new SessionsService(pool.prisma as unknown as PrismaService, queue as never, inert<never>());
  const queued = await expiryQueuedBehindRunningTurn(owner, runner, pool);

  await sessions.end(owner, queued.observer);
  const ending = await sessionOf(queued.observer);
  assert.deepEqual([ending.status, ending.endReason, ending.cancelling], ['RUNNING', 'ended', true], 'the running observer is being ended');
  await assertExpiryDeadLettered(owner, queued, 'an end was requested while the observer ran');
});
