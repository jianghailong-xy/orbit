/**
 * Defects the independent Watch core QA (task 34DH29mTc7OQ6AwxAFIJu) reproduced, one case each, RED
 * until the product is fixed. Each case states the contract clause it holds the implementation to
 * (docs/watch-contract.md, contracts/watch.contract.json) and runs its paired control first, so a red
 * here is the defect and not the harness.
 *
 *     bash scripts/run-pg-spec.sh src/apiserver/src/watches/watch-core-qa-defects.pg.spec.ts
 *
 * run-pg-spec.sh strips --test-name-pattern, so `WATCH_QA_ONLY=D1` registers only that case.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, beforeEach, test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';

import type { PrismaClient } from '@prisma/client';
import { RunEventType } from '@orbit/shared';
import { Client } from 'pg';

import { prismaClientFor } from '../prisma/prisma-client';
import { PrismaService } from '../prisma/prisma.service';
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from '../projects/coordinator-pg-test-safety';
import type { PushService } from '../push/push.service';
import { QueueService } from '../queue/queue.service';
import { ReaperService } from '../realtime/reaper.service';
import { RealtimeService } from '../realtime/realtime.service';
import { RunnerApiController } from '../runner-api/runner-api.controller';
import { SessionsService } from '../sessions/sessions.service';
import type { CreateWatchDto } from './dto';
import { WatchDeliveryService } from './watch-delivery.service';
import { WatchEvaluatorService } from './watch-evaluator.service';
import { WatchesService } from './watches.service';

const URL = process.env.COORDINATOR_PG_URL;
const skip = !URL;
const ONLY = (process.env.WATCH_QA_ONLY ?? '').split(',').map((id) => id.trim()).filter(Boolean);
const HOUR = 60 * 60 * 1000;

function defect(id: string, title: string, timeout: number, body: () => Promise<void>): void {
  if (ONLY.length > 0 && !ONLY.includes(id)) return;
  test(`${id} ${title}`, { skip, timeout }, body);
}

const inert = <T>(): T =>
  new Proxy({}, { get: (_target, property) => (property === 'then' ? undefined : () => undefined) }) as T;

const silentPush = {
  scheduleBadgeSync: () => undefined,
  notifySessionSettled: async () => undefined,
  notifyWatchMatched: async () => undefined,
} as unknown as PushService;

class Hub extends RealtimeService {
  constructor(prisma: PrismaClient) {
    super(prisma as unknown as PrismaService, silentPush);
  }

  override async onModuleInit(): Promise<void> {}
}

let sql: Client;
const clients: PrismaClient[] = [];
const loops: Array<{ stop(): Promise<unknown> }> = [];

before(async () => {
  if (skip) return;
  assertCoordinatorPgUrlIsIsolated(URL);
  sql = new Client({ connectionString: URL, connectionTimeoutMillis: 5_000 });
  await sql.connect();
  await verifyCoordinatorPgIdentity(sql);
});

beforeEach(async () => {
  if (skip) return;
  for (const loop of loops.splice(0)) await loop.stop();
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
  for (const loop of loops.splice(0)) await loop.stop();
  for (const client of clients.splice(0)) await client.$disconnect().catch(() => undefined);
  await sql?.end().catch(() => undefined);
});

function stack() {
  const prisma = prismaClientFor(URL!);
  clients.push(prisma);
  const hub = new Hub(prisma);
  const queue = new QueueService(prisma as unknown as PrismaService, hub);
  const sessions = new SessionsService(prisma as unknown as PrismaService, queue as never, hub as never);
  const watches = new WatchesService(prisma as unknown as PrismaService);
  const evaluator = new WatchEvaluatorService(prisma as unknown as PrismaService, hub, { reconcileIntervalMs: HOUR, pollIntervalMs: 200 });
  const delivery = new WatchDeliveryService(prisma as unknown as PrismaService, sessions, silentPush, {
    retryBaseMs: 0,
    retryMaxMs: 0,
    pollIntervalMs: 200,
  });
  loops.push(evaluator, delivery);
  const api = new RunnerApiController(prisma as never, queue as never, hub as never, inert<never>(), inert<never>(), inert<never>(), inert<never>());
  const inbox = api as unknown as {
    dequeueTurn(sessionId: string, runnerId: string, generation: string | null, acceptsSteer: boolean, declared: readonly string[]): Promise<{ turnId: string } | null>;
  };
  return { prisma, hub, queue, sessions, watches, evaluator, delivery, api, inbox };
}

async function eventually<T>(what: string, read: () => Promise<T>, done: (value: T) => boolean, timeoutMs = 30_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (done(value)) return value;
    if (Date.now() > deadline) assert.fail(`${what}: gave up after ${timeoutMs}ms at ${JSON.stringify(value)}`);
    await sleep(50);
  }
}

async function insertUser(): Promise<string> {
  const id = randomUUID();
  await sql.query(`INSERT INTO "user"("id","email","name","password_hash") VALUES ($1,$2,'watch qa','h')`, [id, `${id}@watch-qa.invalid`]);
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

async function insertTask(owner: string, status: string): Promise<string> {
  const id = randomUUID();
  await sql.query(
    `INSERT INTO "task"("id","title","owner_id","creator_type","creator_id","updated_at","completion_criterion","status")
     VALUES ($1,'watched work',$2,'USER',$2,now(),'EVIDENCE_JUDGMENT',$3)`,
    [id, owner, status],
  );
  return id;
}

async function insertSession(owner: string, status: string, runnerId: string): Promise<string> {
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

async function insertRunningTurn(sessionId: string, seq: number): Promise<string> {
  const id = randomUUID();
  await sql.query(
    `INSERT INTO "conversation_turn"("id","session_id","seq","client_turn_id","kind","content","status","delivered_at","lease_deadline_at")
     VALUES ($1,$2,$3,$4,'message','the turn the session is running','IN_FLIGHT',now(),now() + interval '10 minutes')`,
    [id, sessionId, seq, `running-${id}`],
  );
  await say(id, sessionId, 'the turn ran');

  return id;
}
/**
 * A reply under a turn, as the engine writes one — the event that makes a completed turn
 * ANSWERED rather than one handed back to the queue. Without it `turnComplete` puts the turn
 * back in the queue, the session never parks, and a `SESSION_TURN_SETTLED` target never
 * settles.
 */
async function say(turnId: string, sessionId: string, text: string): Promise<void> {
  await sql.query(
    `INSERT INTO "run_event"("id","session_id","seq","type","payload","turn_id")
     VALUES ($1,$2,(SELECT COALESCE(MAX("seq"),0)+1 FROM "run_event" WHERE "session_id" = $2),
             'assistant',$3::jsonb,$4)`,
    [randomUUID(), sessionId, JSON.stringify({ text }), turnId],
  );
}


async function watchState(id: string): Promise<string> {
  const { rows } = await sql.query<{ state: string }>(`SELECT "state" FROM "watch" WHERE "id" = $1`, [id]);
  return rows[0].state;
}

async function deliveriesOf(watchId: string): Promise<Array<{ state: string; attempts: number; lastError: string | null }>> {
  const { rows } = await sql.query(
    `SELECT d."state", d."attempts", d."last_error" AS "lastError"
       FROM "watch_delivery" d JOIN "watch_match" m ON m."id" = d."match_id" WHERE m."watch_id" = $1`,
    [watchId],
  );
  return rows;
}

async function turnsOn(sessionId: string): Promise<Array<{ id: string; seq: number; clientTurnId: string; status: string; content: string | null }>> {
  const { rows } = await sql.query(
    `SELECT "id", "seq", "client_turn_id" AS "clientTurnId", "status", "content" FROM "conversation_turn" WHERE "session_id" = $1 ORDER BY "seq"`,
    [sessionId],
  );
  return rows;
}

async function statusOf(sessionId: string): Promise<string> {
  const { rows } = await sql.query<{ status: string }>(`SELECT "status" FROM "session" WHERE "id" = $1`, [sessionId]);
  return rows[0].status;
}

const body = (input: Record<string, unknown>) => ({ predicateVersion: 1, ...input }) as unknown as CreateWatchDto;
const TERMINAL = { kind: 'ALL', over: 'ALL_TARGETS', leaf: 'TASK_TERMINAL' };

defect('D1', 'contract §5 / vector ttl-expiry-wakes-a-waiting-observer: a RESUME_SESSION watch that expires unmatched gives its observer one turn carrying EXPIRED', 180_000, async () => {
  const owner = await insertUser();
  const runner = await insertRunner(owner);
  const observer = await insertSession(owner, 'AWAITING_INPUT', runner);
  const open = await insertTask(owner, 'OPEN');
  const { watches, evaluator, delivery } = stack();
  evaluator.start();
  delivery.start();
  const watch = await watches.create(owner, body({
    predicate: TERMINAL,
    targets: [{ kind: 'TASK', id: open }],
    action: 'RESUME_SESSION',
    observerSessionId: observer,
    ttlSeconds: 60,
  }));
  assert.equal(watch.state, 'ACTIVE');

  // The control: the running loops do reach the expiry, on the clock, with no hint.
  await eventually('the watch to expire', () => watchState(watch.id), (state) => state === 'EXPIRED', 100_000);

  // The clause: the observer that was waiting is told, with one turn that says EXPIRED.
  const told = await eventually(
    'a turn carrying EXPIRED on the observer',
    async () => (await turnsOn(observer)).filter((turn) => turn.seq > 1),
    (turns) => turns.length > 0,
    20_000,
  ).catch(async () => (await turnsOn(observer)).filter((turn) => turn.seq > 1));
  const deliveries = await deliveriesOf(watch.id);
  assert.equal(
    told.filter((turn) => (turn.content ?? '').includes('EXPIRED')).length,
    1,
    `watch EXPIRED, observer ${await statusOf(observer)}, turns after the opening one: ${JSON.stringify(told)}, deliveries: ${JSON.stringify(deliveries)} — the waiting observer was never told`,
  );
});

defect('D2', 'contract §0.6/§3: a wake queued behind a running turn that then fails is answered away unrun, while its delivery still reads DELIVERED', 120_000, async () => {
  const owner = await insertUser();
  const runner = await insertRunner(owner);
  const { watches, delivery, api, inbox } = stack();
  const wakeBehindRunningTurn = async () => {
    const observer = await insertSession(owner, 'RUNNING', runner);
    const current = await insertRunningTurn(observer, 2);
    const watch = await watches.create(owner, body({
      predicate: TERMINAL,
      targets: [{ kind: 'TASK', id: await insertTask(owner, 'CANCELLED') }],
      action: 'RESUME_SESSION',
      observerSessionId: observer,
    }));
    await delivery.drain();
    const [queued] = (await turnsOn(observer)).filter((turn) => turn.clientTurnId === `watch:${watch.id}:1`);
    assert.equal(queued?.status, 'PENDING');
    assert.equal((await deliveriesOf(watch.id))[0]?.state, 'DELIVERED');
    return { observer, current, watch, wake: queued };
  };

  // The control: the running turn succeeds, and the runner is handed the wake next.
  const ok = await wakeBehindRunningTurn();
  await api.turnComplete({ id: runner }, ok.observer, { turnId: ok.current, status: 'SUCCEEDED', subtype: 'completed', numTurns: 2, costUsd: 0 } as never);
  assert.equal((await inbox.dequeueTurn(ok.observer, runner, null, false, []))?.turnId, ok.wake.id);

  // The clause: the running turn fails instead. Whatever the session does next, a wake no engine
  // ever received must not be recorded as delivered and then forgotten — it either stays runnable or
  // its delivery says it was not delivered.
  const failing = await wakeBehindRunningTurn();
  await api.turnComplete({ id: runner }, failing.observer, {
    turnId: failing.current,
    status: 'FAILED',
    subtype: 'error_during_execution',
    result: 'API Error: 529 overloaded',
    numTurns: 2,
    costUsd: 0,
  } as never);
  const [wakeAfter] = (await turnsOn(failing.observer)).filter((turn) => turn.id === failing.wake.id);
  const [deliveryAfter] = await deliveriesOf(failing.watch.id);
  const facts = {
    session: await statusOf(failing.observer),
    wake: wakeAfter.status,
    delivery: deliveryAfter.state,
    watch: await watchState(failing.watch.id),
  };
  console.log(`QA-NOTE D2 ${JSON.stringify(facts)}`);
  assert.ok(
    wakeAfter.status === 'PENDING' || deliveryAfter.state !== 'DELIVERED',
    `the wake was drained unrun and its delivery still reads DELIVERED: ${JSON.stringify(facts)}`,
  );
});

defect('D2b', 'contract §0.6/§3, runner lost: the reaper finalizes a RUNNING observer whose runner stopped heartbeating and answers its queued wake away, while the delivery still reads DELIVERED', 120_000, async () => {
  const owner = await insertUser();
  const runner = await insertRunner(owner);
  const { prisma, hub, watches, delivery } = stack();
  const observer = await insertSession(owner, 'RUNNING', runner);
  await insertRunningTurn(observer, 2);
  const watch = await watches.create(owner, body({
    predicate: TERMINAL,
    targets: [{ kind: 'TASK', id: await insertTask(owner, 'CANCELLED') }],
    action: 'RESUME_SESSION',
    observerSessionId: observer,
  }));
  await delivery.drain();
  const [wake] = (await turnsOn(observer)).filter((turn) => turn.clientTurnId === `watch:${watch.id}:1`);
  assert.equal(wake?.status, 'PENDING');
  assert.equal((await deliveriesOf(watch.id))[0]?.state, 'DELIVERED');

  // The runner stops heartbeating past the offline window — a restart that outlasts it, a partition,
  // a crash — and the production reaper sweeps.
  await sql.query(`UPDATE "runner" SET "last_heartbeat_at" = now() - interval '10 minutes' WHERE "id" = $1`, [runner]);
  const reaper = new ReaperService(prisma as unknown as PrismaService, hub);
  await (reaper as unknown as { sweep(): Promise<void> }).sweep();

  const { rows: [session] } = await sql.query<{ status: string; retryArmed: boolean; error: string | null }>(
    `SELECT "status", "retry_at" IS NOT NULL AS "retryArmed", "error" FROM "session" WHERE "id" = $1`,
    [observer],
  );
  const [wakeAfter] = (await turnsOn(observer)).filter((turn) => turn.id === wake.id);
  const [deliveryAfter] = await deliveriesOf(watch.id);
  const facts = { session, wake: wakeAfter.status, delivery: deliveryAfter.state, watch: await watchState(watch.id) };
  console.log(`QA-NOTE D2b ${JSON.stringify(facts)}`);
  // The control: the sweep did act on this session.
  assert.notEqual(session.status, 'RUNNING', `the reaper did not finalize the observer: ${JSON.stringify(facts)}`);
  assert.ok(
    wakeAfter.status === 'PENDING' || deliveryAfter.state !== 'DELIVERED',
    `the wake was answered away unrun and its delivery still reads DELIVERED: ${JSON.stringify(facts)}`,
  );
});

async function landed(watchId: string): Promise<boolean> {
  const { rows } = await sql.query<{ landed: boolean | null }>(
    `SELECT "last_evaluated_at" > "created_at" AND "next_evaluate_at" > now() AS "landed" FROM "watch" WHERE "id" = $1`,
    [watchId],
  );
  return rows[0]?.landed === true;
}

async function matchCount(watchId: string): Promise<number> {
  const { rows } = await sql.query<{ n: number }>(`SELECT count(*)::int AS "n" FROM "watch_match" WHERE "watch_id" = $1`, [watchId]);
  return rows[0].n;
}

defect('D3', '[P2, latency] contract §8 hints: a session whose turn settles through the runner door hints no evaluator — turn-complete announces SESSION_UPDATED, which watchHintFor ignores — so SESSION_TURN_SETTLED waits for reconciliation', 120_000, async () => {
  const owner = await insertUser();
  const runner = await insertRunner(owner);
  const { hub, watches, evaluator, api } = stack(); // reconciliation an hour out
  evaluator.start();
  const settling = async () => {
    const target = await insertSession(owner, 'RUNNING', runner);
    const turn = await insertRunningTurn(target, 2);
    const watch = await watches.create(owner, body({
      predicate: { kind: 'ALL', over: 'ALL_TARGETS', leaf: 'SESSION_TURN_SETTLED' },
      targets: [{ kind: 'SESSION', id: target }],
      action: 'NOTIFY_USER',
    }));
    await eventually('the first evaluation to land', () => landed(watch.id), (done) => done, 20_000);
    return { target, turn, watch };
  };
  const complete = (target: string, turn: string) =>
    api.turnComplete({ id: runner }, target, { turnId: turn, status: 'SUCCEEDED', subtype: 'completed', numTurns: 2, costUsd: 0 } as never);

  // The control: the same completion, followed by a STATUS event published after its commit, is matched at once.
  const control = await settling();
  await complete(control.target, control.turn);
  hub.publish(control.target, { seq: 0, type: RunEventType.STATUS, ts: new Date().toISOString(), payload: { status: 'AWAITING_INPUT' } });
  await eventually('the hinted control Match', () => matchCount(control.watch.id), (n) => n === 1, 10_000);

  // The clause: the runner door's completion on its own.
  const bare = await settling();
  const startedAt = Date.now();
  await complete(bare.target, bare.turn);
  const matched = await eventually('a Match soon after the settle', () => matchCount(bare.watch.id), (n) => n === 1, 15_000).then(
    () => true,
    () => false,
  );
  console.log(`QA-NOTE D3 ${JSON.stringify({ matchedWithin15s: matched, waitedMs: Date.now() - startedAt })}`);
  assert.ok(matched, 'turn-complete committed AWAITING_INPUT and hinted nothing: with the production 60s reconciliation the watcher waits up to a minute');
});
