/**
 * The Watch rollout flag against a real PostgreSQL (watch-rollout.ts, docs/watch-rollout.md): what each mode lets an
 * account write, what becomes of the watches that already exist when Watch is drained or switched off, and that
 * switching it back on delivers what came due meanwhile exactly once.
 *
 *   R-01 canary: the listed account makes and edits watches; another account's create, edit, resume and redrive are
 *        refused with WATCHES_DISABLED and write nothing, while it still reads, pauses and cancels what it has, and a
 *        create retried with the key of a watch made while Watch was on is answered with that watch
 *   R-02 drain: a watch made while Watch was on still matches and wakes its observer exactly once; a new one is refused
 *   R-03 off: neither loop runs, so a finished target wakes nobody; back on, the loops' first passes wake the observer
 *        once, and later passes wake nobody again
 *
 *     bash scripts/run-pg-spec.sh src/apiserver/src/watches/watch-rollout.pg.spec.ts
 *
 * Every service here is built with its rollout passed in, the way a replica restarted with a different ORBIT_WATCHES
 * builds its own; the environment of this process is not read.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, beforeEach, test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';

import type { PrismaClient } from '@prisma/client';
import { uuidToBase62 } from '@orbit/shared';
import { Client } from 'pg';
import { EMPTY } from 'rxjs';

import { prismaClientFor } from '../prisma/prisma-client';
import type { PrismaService } from '../prisma/prisma.service';
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from '../projects/coordinator-pg-test-safety';
import type { PushService } from '../push/push.service';
import type { RealtimeService } from '../realtime/realtime.service';
import { SessionsService } from '../sessions/sessions.service';
import type { CreateWatchDto, UpdateWatchDto } from './dto';
import { type WatchDeliveryOptions, type WatchDeliveryResult, WatchDeliveryService } from './watch-delivery.service';
import { WatchEvaluatorService } from './watch-evaluator.service';
import { readWatchRollout, WATCHES_DISABLED, type WatchRollout } from './watch-rollout';
import { WatchesService } from './watches.service';

const URL = process.env.COORDINATOR_PG_URL;
const skip = !URL;

const HOUR = 60 * 60 * 1000;
const ALL_TERMINAL = { kind: 'ALL', over: 'ALL_TARGETS', leaf: 'TASK_TERMINAL' } as const;
const ON = readWatchRollout({ ORBIT_WATCHES: 'on' });
const DRAIN = readWatchRollout({ ORBIT_WATCHES: 'drain' });
const OFF = readWatchRollout({ ORBIT_WATCHES: 'off' });

function rollout(id: string, title: string, body: () => Promise<void>, timeout = 120_000): void {
  test(`${id} ${title}`, { skip, timeout }, body);
}

// ── collaborators a case does not observe ────────────────────────────────────────────────────────

const queue = { notifySessionQueued: () => undefined };
const realtime = { notifyInbox: () => undefined, publishQueuedTurnsChanged: () => undefined };
const push = { notifyWatchMatched: async () => undefined } as unknown as PushService;
const noHints = { localPublications: () => EMPTY } as unknown as RealtimeService;

let sql: Client;
let prisma: PrismaClient;
let db: PrismaService;

before(async () => {
  if (skip) return;
  assertCoordinatorPgUrlIsIsolated(URL);
  sql = new Client({ connectionString: URL, connectionTimeoutMillis: 5_000 });
  await sql.connect();
  await verifyCoordinatorPgIdentity(sql);
  prisma = prismaClientFor(URL!);
  db = prisma as unknown as PrismaService;
});

// A pass claims every due row in the database: retire what an earlier case left live, so each case's passes are its own.
beforeEach(async () => {
  if (skip) return;
  await sql.query(`UPDATE "watch" SET "state" = 'CANCELLED', "next_evaluate_at" = NULL WHERE "state" IN ('ACTIVE', 'PAUSED')`);
  await sql.query(
    `UPDATE "watch_delivery" SET "state" = 'DEAD_LETTER', "dead_lettered_at" = now(), "last_error" = 'OTHER: retired before a later case',
            "lease_owner" = NULL, "lease_generation" = NULL, "lease_deadline_at" = NULL
      WHERE "state" IN ('PENDING', 'IN_FLIGHT')`,
  );
});

after(async () => {
  if (skip) return;
  await prisma?.$disconnect().catch(() => undefined);
  await sql?.end().catch(() => undefined);
});

function watchesUnder(mode: WatchRollout): WatchesService {
  return new WatchesService(db, { rollout: mode });
}

function evaluatorUnder(mode: WatchRollout, pollIntervalMs = HOUR): WatchEvaluatorService {
  return new WatchEvaluatorService(db, noHints, { rollout: mode, pollIntervalMs, reconcileIntervalMs: HOUR });
}

function workerUnder(mode: WatchRollout, options: WatchDeliveryOptions = {}): WatchDeliveryService {
  const sessions = new SessionsService(db, queue as never, realtime as never);
  return new WatchDeliveryService(db, sessions, push, { retryBaseMs: 0, retryMaxMs: 0, pollIntervalMs: HOUR, ...options, rollout: mode });
}

const outcomes = (results: WatchDeliveryResult[]): string[] => results.map((result) => result.outcome).sort();

// ── fixtures ───────────────────────────────────────────────────────────────────────────────────

async function insertUser(): Promise<string> {
  const id = randomUUID();
  await sql.query(`INSERT INTO "user"("id","email","name","password_hash") VALUES ($1,$2,'watch rollout','h')`, [
    id,
    `${id}@watch-rollout.invalid`,
  ]);
  return id;
}

async function insertRunner(owner: string): Promise<string> {
  const id = randomUUID();
  await sql.query(
    `INSERT INTO "runner"("id","name","owner_id","token_hash","status","last_heartbeat_at","capabilities")
     VALUES ($1,'watch rollout',$2,'h','ONLINE',clock_timestamp(),'{}'::text[])`,
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

/** A session that has run on an online runner, parked for input: an observer a wake can be queued on. */
async function insertSession(owner: string, runnerId: string): Promise<string> {
  const id = randomUUID();
  await sql.query(
    `INSERT INTO "session"("id","title","prompt","owner_id","creator_id","updated_at","status","assigned_runner_id",
                           "provider","provider_builtin","num_turns","started_at","runtime_session_id")
     VALUES ($1,'watch rollout','the opening prompt',$2,$2,now(),'AWAITING_INPUT',$3,'claude',TRUE,1,now(),$4)`,
    [id, owner, runnerId, `runtime-${id}`],
  );
  return id;
}

async function account(): Promise<{ owner: string; observer: string }> {
  const owner = await insertUser();
  return { owner, observer: await insertSession(owner, await insertRunner(owner)) };
}

interface WatchBody {
  targets: Array<{ kind: string; id: string }>;
  action?: string;
  observerSessionId?: string;
  idempotencyKey?: string;
}

function create(service: WatchesService, owner: string, body: WatchBody) {
  return service.create(owner, {
    predicateVersion: 1,
    predicate: ALL_TERMINAL,
    ttlSeconds: 3600,
    action: 'NOTIFY_USER',
    ...body,
  } as unknown as CreateWatchDto);
}

const onTask = (task: string) => [{ kind: 'TASK', id: task }];

async function refusedWith(code: string, attempt: Promise<unknown>, why: string): Promise<void> {
  const error = await attempt.then(() => null, (reason: unknown) => reason);
  assert.ok(error, `${why}: it was not refused`);
  const response = (error as { getResponse?: () => unknown }).getResponse?.();
  const answered = typeof response === 'object' && response !== null ? (response as { code?: string }).code : undefined;
  assert.equal(answered, code, `${why}: ${error instanceof Error ? error.message : String(error)}`);
}

/** What an account has written to Watch: a refused write leaves every part of it as it was. */
async function footprint(owner: string): Promise<Record<string, unknown>> {
  const { rows } = await sql.query(
    `SELECT (SELECT count(*)::int FROM "watch" WHERE "owner_id" = $1) AS "watches",
            (SELECT count(*)::int FROM "watch_target" t JOIN "watch" w ON w."id" = t."watch_id" WHERE w."owner_id" = $1) AS "targets",
            (SELECT count(*)::int FROM "watch_delivery" d LEFT JOIN "watch_match" m ON m."id" = d."match_id"
               JOIN "watch" w ON w."id" = COALESCE(d."watch_id", m."watch_id")
              WHERE w."owner_id" = $1 AND d."state" <> 'DEAD_LETTER') AS "liveDeliveries",
            (SELECT json_agg(json_build_object('id', "id", 'state', "state", 'expiresAt', "expires_at", 'updatedAt', "updated_at") ORDER BY "id")
               FROM "watch" WHERE "owner_id" = $1) AS "rows"`,
    [owner],
  );
  return rows[0];
}

async function deliveriesOf(watchId: string): Promise<Array<{ id: string; state: string; lastError: string | null }>> {
  const { rows } = await sql.query(
    `SELECT d."id", d."state", d."last_error" AS "lastError"
       FROM "watch_delivery" d LEFT JOIN "watch_match" m ON m."id" = d."match_id"
      WHERE d."watch_id" = $1 OR m."watch_id" = $1
      ORDER BY d."created_at", d."id"`,
    [watchId],
  );
  return rows;
}

async function wakesOn(sessionId: string): Promise<string[]> {
  const { rows } = await sql.query<{ clientTurnId: string }>(
    `SELECT "client_turn_id" AS "clientTurnId" FROM "conversation_turn"
      WHERE "session_id" = $1 AND "client_turn_id" LIKE 'watch:%' ORDER BY "seq"`,
    [sessionId],
  );
  return rows.map((row) => row.clientTurnId);
}

async function watchState(id: string): Promise<string> {
  const { rows } = await sql.query<{ state: string }>(`SELECT "state" FROM "watch" WHERE "id" = $1`, [id]);
  return rows[0].state;
}

async function eventually(what: string, holds: () => Promise<boolean>, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await holds())) {
    if (Date.now() > deadline) assert.fail(`${what}: not within ${timeoutMs}ms`);
    await sleep(100);
  }
}

// ── cases ──────────────────────────────────────────────────────────────────────────────────────

rollout('R-01', 'canary: the listed account watches; another account is refused, writes nothing and keeps control of what it has', async () => {
  const a = await account();
  const b = await account();
  const canary = watchesUnder(readWatchRollout({ ORBIT_WATCHES: 'canary', ORBIT_WATCHES_CANARY_OWNERS: uuidToBase62(a.owner) }));

  // What B made while Watch was on for every account: a live watch with a key, and a dead letter.
  const everyone = watchesUnder(ON);
  const bTask = await insertTask(b.owner, 'OPEN');
  const earlier = await create(everyone, b.owner, { targets: onTask(bTask), idempotencyKey: 'made-while-on' });
  assert.equal(earlier.state, 'ACTIVE');
  const matched = await create(everyone, b.owner, { targets: onTask(await insertTask(b.owner, 'FAILED')) });
  assert.equal(matched.state, 'MATCHED');
  const [letter] = await deliveriesOf(matched.id);
  await sql.query(
    `UPDATE "watch_delivery" SET "state" = 'DEAD_LETTER', "attempts" = 8, "dead_lettered_at" = now(), "last_error" = 'ATTEMPTS_EXHAUSTED: a fixture' WHERE "id" = $1`,
    [letter.id],
  );

  // A, listed, makes and edits one.
  const made = await create(canary, a.owner, { targets: onTask(await insertTask(a.owner, 'OPEN')) });
  assert.equal(made.state, 'ACTIVE');
  assert.equal((await canary.update(a.owner, made.id, { ttlSeconds: 7200 } as UpdateWatchDto)).state, 'ACTIVE');

  // B, not listed: every write that adds a wait or a wake is refused, and none of them wrote anything.
  const beforeRefusals = await footprint(b.owner);
  await refusedWith(WATCHES_DISABLED, create(canary, b.owner, { targets: onTask(bTask) }), 'a create');
  await refusedWith(WATCHES_DISABLED, canary.update(b.owner, earlier.id, { ttlSeconds: 7200 } as UpdateWatchDto), 'an edit');
  await refusedWith(WATCHES_DISABLED, canary.retryDelivery(b.owner, letter.id), 'a redrive');
  assert.deepEqual(await footprint(b.owner), beforeRefusals);

  // What stops a wait is B's to do, and a resume of what it paused is refused like the rest.
  assert.equal((await canary.pause(b.owner, earlier.id)).state, 'PAUSED');
  const paused = await footprint(b.owner);
  await refusedWith(WATCHES_DISABLED, canary.resume(b.owner, earlier.id), 'a resume');
  assert.deepEqual(await footprint(b.owner), paused);

  // B still reads everything it has, and cancels what it no longer needs.
  assert.equal((await canary.get(b.owner, earlier.id)).state, 'PAUSED');
  assert.deepEqual(
    (await canary.list(b.owner)).map((watch) => watch.id).sort(),
    [earlier.id, matched.id].sort(),
  );
  assert.equal((await canary.listDeliveries(b.owner)).length, 1);
  assert.equal((await canary.cancel(b.owner, earlier.id)).state, 'CANCELLED');

  // A create whose answer was lost while Watch was on, retried now, gets back the watch it made.
  const retried = await create(canary, b.owner, { targets: onTask(bTask), idempotencyKey: 'made-while-on' });
  assert.equal(retried.id, earlier.id);
});

rollout('R-02', 'drain: a watch made while Watch was on still matches and wakes its observer once; a new one is refused', async () => {
  const { owner, observer } = await account();
  const task = await insertTask(owner, 'OPEN');
  const earlier = await create(watchesUnder(ON), owner, { targets: onTask(task), action: 'RESUME_SESSION', observerSessionId: observer });
  assert.equal(earlier.state, 'ACTIVE');

  // The apiserver restarts with ORBIT_WATCHES=drain.
  await refusedWith(
    WATCHES_DISABLED,
    create(watchesUnder(DRAIN), owner, { targets: onTask(await insertTask(owner, 'OPEN')), action: 'RESUME_SESSION', observerSessionId: observer }),
    'a new wait under drain',
  );
  const evaluator = evaluatorUnder(DRAIN);
  const delivery = workerUnder(DRAIN);

  await sql.query(`UPDATE "task" SET "status" = 'FAILED', "updated_at" = now() WHERE "id" = $1`, [task]);
  assert.equal((await evaluator.evaluate(earlier.id)).outcome, 'MATCHED');
  assert.deepEqual(outcomes(await delivery.drain()), ['DELIVERED']);
  assert.deepEqual(await wakesOn(observer), [`watch:${earlier.id}:1`]);
  assert.deepEqual(outcomes(await delivery.drain()), []);
  assert.deepEqual(await wakesOn(observer), [`watch:${earlier.id}:1`]);
});

rollout('R-03', 'off: no loop runs and a finished target wakes nobody; back on, the first passes wake the observer once', async () => {
  const { owner, observer } = await account();
  const task = await insertTask(owner, 'OPEN');
  const earlier = await create(watchesUnder(ON), owner, { targets: onTask(task), action: 'RESUME_SESSION', observerSessionId: observer });

  // The replica restarts with ORBIT_WATCHES=off, and the target fails while it runs.
  const offEvaluator = evaluatorUnder(OFF, 50);
  const offDelivery = workerUnder(OFF, { pollIntervalMs: 50 });
  offEvaluator.onModuleInit();
  offDelivery.onModuleInit();
  await sql.query(`UPDATE "task" SET "status" = 'FAILED', "updated_at" = now() WHERE "id" = $1`, [task]);
  await sleep(2_000); // forty polls of a loop that ran
  assert.equal(await watchState(earlier.id), 'ACTIVE', 'a replica with Watch off evaluated the watch');
  assert.deepEqual(await wakesOn(observer), []);
  await offEvaluator.onModuleDestroy();
  await offDelivery.onModuleDestroy();

  // Back on: the first passes find what came due while no replica ran the loops, and deliver it once.
  const evaluator = evaluatorUnder(ON, 50);
  const delivery = workerUnder(ON, { pollIntervalMs: 50 });
  evaluator.onModuleInit();
  delivery.onModuleInit();
  try {
    await eventually('the wake once Watch is back on', async () => (await wakesOn(observer)).length > 0, 30_000);
    assert.equal(await watchState(earlier.id), 'MATCHED');
    await sleep(2_000);
    assert.deepEqual(await wakesOn(observer), [`watch:${earlier.id}:1`]);
    assert.deepEqual((await deliveriesOf(earlier.id)).map((row) => row.state), ['DELIVERED']);
  } finally {
    await evaluator.onModuleDestroy();
    await delivery.onModuleDestroy();
  }
});
