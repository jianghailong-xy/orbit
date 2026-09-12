/**
 * The Watch evaluator against a real PostgreSQL: leases, hints, reconciliation and restarts.
 *
 * What is under test is a set of promises about time and concurrency — a hint that arrives twice
 * or out of order, a notification that never arrives, a worker that dies holding a lease, a process
 * restarted around a waiting watch — and none of them is witnessed except by making it happen. So
 * each case injects its fault itself: replicas that each own a Prisma pool and a realtime hub race
 * on one database, a hub drops every event on purpose, a worker is killed between its claim and its
 * landing, a Nest application context is closed and booted again as a new process would be.
 *
 *     bash scripts/run-pg-spec.sh src/apiserver/src/watches/watch-evaluator.pg.spec.ts
 *
 * Non-destructive: every row carries an id this run generated. Each case first retires the live
 * watches earlier cases left, so a replica started in it claims only that case's watches.
 */
import assert from 'node:assert/strict';
import { createHook } from 'node:async_hooks';
import childProcess from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { after, before, beforeEach, test } from 'node:test';

import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { PrismaClient } from '@prisma/client';
import {
  NormalizedRunEvent,
  RunEventType,
  SessionEndReason,
  SessionLifecycleState,
} from '@orbit/shared';
import { Client } from 'pg';
import { filter, Observable, tap } from 'rxjs';

import { prismaClientFor } from '../prisma/prisma-client';
import { PrismaService } from '../prisma/prisma.service';
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from '../projects/coordinator-pg-test-safety';
import type { PushService } from '../push/push.service';
import { RealtimeService } from '../realtime/realtime.service';
import {
  WATCH_EVALUATOR_OPTIONS,
  WatchEvaluation,
  WatchEvaluatorOptions,
  WatchEvaluatorService,
} from './watch-evaluator.service';

const URL = process.env.COORDINATOR_PG_URL;
const skip = !URL;

const HOUR = 60 * 60 * 1000;
/** A call site inside the Watch evaluator's own modules, as a stack frame names it. */
const WATCH_CODE = /[\\/]watches[\\/]watch-(?:evaluator\.service|evaluator\.module|predicate)\.js:/;

const CONTRACT = JSON.parse(
  readFileSync(path.resolve(__dirname, '../../../../contracts/watch.contract.json'), 'utf8'),
) as {
  leaves: Record<string, { targetKind: 'SESSION' | 'TASK' }>;
  vectors: Array<{ id: string; given: Record<string, any>; expect: Record<string, unknown> }>;
};

type Target = { kind: 'SESSION' | 'TASK'; id: string };
const all = (leaf: string) => ({ kind: 'ALL', over: 'ALL_TARGETS', leaf });
const any = (leaf: string) => ({ kind: 'ANY', over: 'ALL_TARGETS', leaf });

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const silentPush = {
  scheduleBadgeSync: () => undefined,
  notifySessionSettled: async () => undefined,
} as unknown as PushService;

/** A replica's realtime hub, minus the cross-replica LISTEN connection: publishing works as in production. */
class LocalRealtime extends RealtimeService {
  constructor(prisma: PrismaClient) {
    super(prisma as unknown as PrismaService, silentPush);
  }

  override async onModuleInit(): Promise<void> {}
}

/** A hub that publishes every event and lets none reach an in-process consumer: the lost notification, on purpose. */
class DroppingRealtime extends LocalRealtime {
  dropped = 0;

  override localPublications(): Observable<{ runId: string; event: NormalizedRunEvent }> {
    return super.localPublications().pipe(
      tap(() => {
        this.dropped += 1;
      }),
      filter(() => false),
    );
  }
}

/** A worker killed after its claim committed and before it landed anything. */
class KilledAfterClaim extends WatchEvaluatorService {
  override async evaluate(): Promise<WatchEvaluation> {
    throw new Error('the worker was killed after its claim committed');
  }
}

let sql: Client;
let ownerId: string;
let otherOwnerId: string;
const clients: PrismaClient[] = [];
const running: Array<{ stop(): Promise<unknown> }> = [];

before(async () => {
  if (skip) return;
  assertCoordinatorPgUrlIsIsolated(URL);
  sql = new Client({ connectionString: URL, connectionTimeoutMillis: 5_000 });
  await sql.connect();
  await verifyCoordinatorPgIdentity(sql);
  ownerId = await insertUser();
  otherOwnerId = await insertUser();
});

beforeEach(async () => {
  if (skip) return;
  await stopEverything();
  await sql.query(
    `UPDATE "watch" SET "state" = 'CANCELLED', "next_evaluate_at" = NULL WHERE "state" IN ('ACTIVE', 'PAUSED')`,
  );
});

after(async () => {
  if (skip) return;
  await stopEverything();
  for (const client of clients.splice(0)) await client.$disconnect().catch(() => undefined);
  await sql?.end().catch(() => undefined);
});

async function stopEverything(): Promise<void> {
  for (const handle of running.splice(0)) await handle.stop();
}

interface Replica {
  prisma: PrismaClient;
  realtime: LocalRealtime;
  evaluator: WatchEvaluatorService;
}

/** One replica: its own pool, its own hub, its own evaluator. Nothing moves unless the case says how often. */
function replica(
  options: WatchEvaluatorOptions = {},
  hub: (prisma: PrismaClient) => LocalRealtime = (prisma) => new LocalRealtime(prisma),
  Evaluator: typeof WatchEvaluatorService = WatchEvaluatorService,
): Replica {
  const prisma = prismaClientFor(URL!);
  clients.push(prisma);
  const realtime = hub(prisma);
  const evaluator = new Evaluator(prisma as unknown as PrismaService, realtime, {
    reconcileIntervalMs: HOUR,
    pollIntervalMs: HOUR,
    ...options,
  });
  running.push(evaluator);
  return { prisma, realtime, evaluator };
}

/** An apiserver process as far as the evaluator can tell: a Nest context with its own pool and hub, closed the way a deploy closes it. */
async function bootApiServer(options: WatchEvaluatorOptions) {
  const prisma = prismaClientFor(URL!);
  clients.push(prisma);
  const realtime = new LocalRealtime(prisma);
  @Module({
    providers: [
      WatchEvaluatorService,
      { provide: PrismaService, useValue: prisma },
      { provide: RealtimeService, useValue: realtime },
      { provide: WATCH_EVALUATOR_OPTIONS, useValue: options },
    ],
  })
  class ApiServer {}
  const app = await NestFactory.createApplicationContext(ApiServer, { logger: false, abortOnError: false });
  let closing: Promise<void> | undefined;
  const close = () => (closing ??= app.close());
  running.push({ stop: close });
  return { prisma, realtime, close };
}

async function insertUser(): Promise<string> {
  const id = randomUUID();
  await sql.query(
    `INSERT INTO "user"("id","email","name","password_hash") VALUES ($1,$2,'watch evaluator','h')`,
    [id, `${id}@watch-evaluator.invalid`],
  );
  return id;
}

async function insertTask(status: string, owner = ownerId): Promise<string> {
  const id = randomUUID();
  await sql.query(
    `INSERT INTO "task"("id","title","owner_id","creator_type","creator_id","updated_at","completion_criterion","status")
     VALUES ($1,'watched work',$2,'USER',$2,now(),'EVIDENCE_JUDGMENT',$3)`,
    [id, owner, status],
  );
  return id;
}

async function insertSession(row: {
  status: string;
  endReason?: string | null;
  completedAt?: boolean;
  deletedAt?: boolean;
  runnerId?: string;
}): Promise<string> {
  const id = randomUUID();
  await sql.query(
    `INSERT INTO "session"("id","title","prompt","owner_id","creator_id","updated_at","status","end_reason",
                           "completed_at","deleted_at","assigned_runner_id")
     VALUES ($1,'watched session','p',$2,$2,now(),$3,$4,
             CASE WHEN $5::boolean THEN now() END, CASE WHEN $6::boolean THEN now() END, $7)`,
    [id, ownerId, row.status, row.endReason ?? null, row.completedAt ?? false, row.deletedAt ?? false, row.runnerId ?? null],
  );
  return id;
}

async function insertApproval(sessionId: string, status: string): Promise<void> {
  await sql.query(
    `INSERT INTO "approval"("id","session_id","tool_name","input","status") VALUES ($1,$2,'Bash','{}'::jsonb,$3)`,
    [randomUUID(), sessionId, status],
  );
}

/** A watch as creation leaves it: ACTIVE, generation 0, due now, its target set frozen. */
async function insertWatch(
  targets: Target[],
  predicate: unknown,
  over: { ttlMs?: number; state?: string } = {},
): Promise<string> {
  const id = randomUUID();
  await sql.query(
    `INSERT INTO "watch"("id","owner_id","observer_type","predicate","mode","action","state","expires_at","next_evaluate_at")
     VALUES ($1,$2,'USER',$3::jsonb,'ONE_SHOT','NOTIFY_USER',$4,now() + $5::int * interval '1 millisecond',now())`,
    [id, ownerId, JSON.stringify(predicate), over.state ?? 'ACTIVE', over.ttlMs ?? HOUR],
  );
  for (const target of targets) {
    await sql.query(
      `INSERT INTO "watch_target"("id","watch_id","target_kind","target_resource_id") VALUES ($1,$2,$3,$4)`,
      [randomUUID(), id, target.kind, target.id],
    );
  }
  return id;
}

/** Timestamps as microsecond UTC text, so two evaluations inside one millisecond still compare. */
const MICROS = `'YYYY-MM-DD"T"HH24:MI:SS.US'`;

type WatchRead = {
  state: string;
  generation: number;
  nextEvaluateAt: string | null;
  evaluatedAt: string | null;
  due: boolean | null;
  atExpiry: boolean | null;
};

async function readWatch(id: string): Promise<WatchRead> {
  const { rows } = await sql.query<WatchRead>(
    `SELECT "state", "generation",
            to_char("next_evaluate_at" AT TIME ZONE 'UTC', ${MICROS}) AS "nextEvaluateAt",
            to_char("last_evaluated_at" AT TIME ZONE 'UTC', ${MICROS}) AS "evaluatedAt",
            "next_evaluate_at" <= now() AS "due",
            abs(extract(epoch FROM "next_evaluate_at" - "expires_at")) < 0.002 AS "atExpiry"
     FROM "watch" WHERE "id" = $1`,
    [id],
  );
  return rows[0];
}

type MatchRead = {
  id: string;
  generation: number;
  reason: string;
  matchedAt: string;
  snapshot: { targets: Array<{ id: string; state: string; observed?: { status: string } }> };
};

async function readMatches(id: string): Promise<MatchRead[]> {
  const { rows } = await sql.query<MatchRead>(
    `SELECT "id", "generation", "reason", "per_target_snapshot" AS "snapshot",
            to_char("matched_at" AT TIME ZONE 'UTC', ${MICROS}) AS "matchedAt"
     FROM "watch_match" WHERE "watch_id" = $1 ORDER BY "generation"`,
    [id],
  );
  return rows;
}

async function readTargets(id: string): Promise<Record<string, string>> {
  const { rows } = await sql.query<{ resourceId: string; state: string }>(
    `SELECT "target_resource_id" AS "resourceId", "state" FROM "watch_target" WHERE "watch_id" = $1`,
    [id],
  );
  return Object.fromEntries(rows.map((row) => [row.resourceId, row.state]));
}

async function dbNow(): Promise<string> {
  const { rows } = await sql.query<{ now: string }>(`SELECT to_char(now() AT TIME ZONE 'UTC', ${MICROS}) AS "now"`);
  return rows[0].now;
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

const event = (type: RunEventType, payload: Record<string, unknown> = {}): NormalizedRunEvent => ({
  seq: 0,
  type,
  ts: new Date().toISOString(),
  payload,
});

test('every leaf decides the contract vectors from the rows the evaluator reads', { skip, timeout: 120_000 }, async () => {
  const { evaluator } = replica();
  const exercised = new Set<string>();
  let vectors = 0;
  for (const vector of CONTRACT.vectors) {
    const expectations = Object.entries(vector.expect).filter(([key]) => key in CONTRACT.leaves);
    const { session: givenSession, task: givenTask, approvals = [] } = vector.given;
    if (expectations.length === 0 || !(givenSession || givenTask)) continue;
    vectors += 1;
    const session = givenSession
      ? await insertSession({
          status: givenSession.status,
          endReason: givenSession.endReason ?? null,
          completedAt: givenSession.completedAt != null,
          deletedAt: givenSession.deletedAt != null,
        })
      : null;
    for (const status of approvals) await insertApproval(session!, status);
    const task = givenTask ? await insertTask(givenTask.status) : null;
    for (const [leaf, expected] of expectations) {
      const kind = CONTRACT.leaves[leaf].targetKind;
      const target = kind === 'SESSION' ? session : task;
      assert.ok(target, `${vector.id} expects ${leaf} but gives no ${kind}`);
      const watchId = await insertWatch([{ kind, id: target }], all(leaf));
      const { outcome } = await evaluator.evaluate(watchId);
      assert.equal(outcome, expected ? 'MATCHED' : 'SCHEDULED', `${vector.id}: ${leaf} should be ${expected}`);
      exercised.add(leaf);
    }
  }
  assert.ok(vectors >= 9, `only ${vectors} contract vectors carried a leaf expectation`);
  assert.deepEqual([...exercised].sort(), Object.keys(CONTRACT.leaves).sort(), 'a leaf no vector exercised');
});

test('a Match states what the rows said: GONE targets leave the set, a reopened task unmatches nothing, a foreign target is REVOKED', { skip, timeout: 120_000 }, async () => {
  const { evaluator } = replica();

  // all-terminal-or-any-failed: the ANY branch holds while three of the seven are still open.
  const seven: string[] = [];
  for (const status of ['DONE', 'DONE', 'FAILED', 'IN_PROGRESS', 'OPEN', 'DONE', 'OPEN']) seven.push(await insertTask(status));
  const canonical = await insertWatch(
    seven.map((id) => ({ kind: 'TASK' as const, id })),
    { kind: 'ANY_OF', operands: [all('TASK_TERMINAL'), any('TASK_FAILED')] },
  );
  assert.equal((await evaluator.evaluate(canonical)).outcome, 'MATCHED');
  const [canonicalMatch] = await readMatches(canonical);
  assert.equal(canonicalMatch.reason, 'ANY_OF(ALL TASK_TERMINAL 4/7, ANY TASK_FAILED 1/7)');
  assert.equal(canonicalMatch.snapshot.targets.length, 7);

  // target-deleted-is-excluded-and-recorded: the open target holds the watch back until it is deleted.
  const done = await insertTask('DONE');
  const doomed = await insertTask('OPEN');
  const partial = await insertWatch([{ kind: 'TASK', id: done }, { kind: 'TASK', id: doomed }], all('TASK_TERMINAL'));
  assert.equal((await evaluator.evaluate(partial)).outcome, 'SCHEDULED');
  await sql.query(`DELETE FROM "task" WHERE "id" = $1`, [doomed]);
  assert.equal((await evaluator.evaluate(partial)).outcome, 'MATCHED');
  assert.deepEqual(await readTargets(partial), { [done]: 'SATISFIED', [doomed]: 'GONE' });
  const [partialMatch] = await readMatches(partial);
  assert.deepEqual(
    Object.fromEntries(partialMatch.snapshot.targets.map((target) => [target.id, target.state])),
    { [done]: 'SATISFIED', [doomed]: 'GONE' },
  );

  // all-targets-gone-is-unresolvable-not-silent
  const first = await insertTask('OPEN');
  const second = await insertTask('OPEN');
  const orphan = await insertWatch([{ kind: 'TASK', id: first }, { kind: 'TASK', id: second }], all('TASK_TERMINAL'));
  await sql.query(`DELETE FROM "task" WHERE "id" = ANY($1::uuid[])`, [[first, second]]);
  assert.equal((await evaluator.evaluate(orphan)).outcome, 'UNRESOLVABLE');
  const unresolvable = await readWatch(orphan);
  assert.equal(unresolvable.state, 'UNRESOLVABLE');
  assert.equal(unresolvable.nextEvaluateAt, null);
  assert.deepEqual(await readTargets(orphan), { [first]: 'GONE', [second]: 'GONE' });
  assert.equal((await readMatches(orphan)).length, 0);

  // task-reopened-after-match-does-not-unmatch
  const reopened = await insertTask('FAILED');
  const fact = await insertWatch([{ kind: 'TASK', id: reopened }], all('TASK_TERMINAL'));
  assert.equal((await evaluator.evaluate(fact)).outcome, 'MATCHED');
  const recorded = await readMatches(fact);
  await sql.query(`UPDATE "task" SET "status" = 'OPEN' WHERE "id" = $1`, [reopened]);
  assert.equal((await evaluator.evaluate(fact)).outcome, 'SETTLED');
  assert.deepEqual(await readMatches(fact), recorded);

  // Permission is rechecked where it is used: another owner's row ends the watch without being written down.
  const foreign = await insertTask('DONE', otherOwnerId);
  const revoked = await insertWatch([{ kind: 'TASK', id: foreign }], all('TASK_TERMINAL'));
  assert.equal((await evaluator.evaluate(revoked)).outcome, 'REVOKED');
  assert.equal((await readWatch(revoked)).state, 'REVOKED');
  assert.equal((await readMatches(revoked)).length, 0);
  assert.deepEqual(await readTargets(revoked), { [foreign]: 'OBSERVED' });
});

test('duplicate and out-of-order hints racing three replicas record exactly one Match', { skip, timeout: 120_000 }, async () => {
  const [a, b, c] = [replica(), replica(), replica()].map((r) => r.evaluator);
  const drainAll = () => Promise.all([a.drain(), b.drain(), c.drain()]);
  const t1 = await insertTask('OPEN');
  const t2 = await insertTask('OPEN');
  const watchId = await insertWatch([{ kind: 'TASK', id: t1 }, { kind: 'TASK', id: t2 }], all('TASK_TERMINAL'));
  const created = await drainAll();
  assert.equal(created[0] + created[1] + created[2], 1, 'three replicas draining at once evaluated a new watch other than once');

  // t2 settles. Its hint arrives twice, beside one about t1, which did not change.
  await sql.query(`UPDATE "task" SET "status" = 'CANCELLED' WHERE "id" = $1`, [t2]);
  const pulled = await Promise.all([a.hint('TASK', [t1]), b.hint('TASK', [t2]), c.hint('TASK', [t2])]);
  assert.ok(pulled[0] + pulled[1] + pulled[2] >= 1, 'no hint made the watch due');
  await drainAll();
  assert.deepEqual(await readTargets(watchId), { [t1]: 'OBSERVED', [t2]: 'SATISFIED' });
  assert.equal((await readMatches(watchId)).length, 0);

  // t1 fails. Without a hint the watch is not due, and no replica looks at it before its sweep.
  await sql.query(`UPDATE "task" SET "status" = 'FAILED' WHERE "id" = $1`, [t1]);
  assert.deepEqual(await drainAll(), [0, 0, 0]);
  assert.equal((await readWatch(watchId)).state, 'ACTIVE');

  // Its hints arrive as t2, t1, t2, t1, scattered over the replicas, each chased by a drain, all at once, three rounds over.
  const scattered: Array<[WatchEvaluatorService, string]> = [[a, t2], [b, t1], [c, t2], [a, t1]];
  for (let round = 0; round < 3; round += 1) {
    await Promise.all([
      ...scattered.map(([evaluator, id]) => evaluator.hint('TASK', [id]).then(() => evaluator.drain())),
      drainAll(),
    ]);
  }
  const matches = await readMatches(watchId);
  assert.equal(matches.length, 1, 'duplicate or reordered hints recorded a second Match');
  assert.equal(matches[0].generation, 1);
  const matched = await readWatch(watchId);
  assert.deepEqual([matched.state, matched.generation, matched.nextEvaluateAt], ['MATCHED', 1, null]);

  // Late hints find nothing to schedule, and failing t1 again after reopening it is a second crossing a
  // one-shot watch does not record.
  await sql.query(`UPDATE "task" SET "status" = 'OPEN' WHERE "id" = $1`, [t1]);
  await sql.query(`UPDATE "task" SET "status" = 'FAILED' WHERE "id" = $1`, [t1]);
  assert.deepEqual(await Promise.all([a.hint('TASK', [t1]), b.hint('TASK', [t2]), c.hint('TASK', [t1, t2])]), [0, 0, 0]);
  assert.deepEqual(await drainAll(), [0, 0, 0]);
  assert.deepEqual(await readMatches(watchId), matches);
});

test('a published event only schedules an evaluation: a status it claims is not a status the row has', { skip, timeout: 60_000 }, async () => {
  const { evaluator, realtime } = replica();
  const session = await insertSession({ status: 'RUNNING' });
  const watchId = await insertWatch([{ kind: 'SESSION', id: session }], all('SESSION_RUN_TERMINAL'));
  evaluator.start();
  const created = await eventually('the evaluation at creation', () => readWatch(watchId), (w) => w.evaluatedAt !== null);
  assert.equal(created.state, 'ACTIVE');
  assert.equal(created.due, false);

  // The event says the session failed. Its row still says RUNNING.
  realtime.publish(session, event(RunEventType.STATUS, { status: 'FAILED' }));
  const hinted = await eventually('the hinted evaluation', () => readWatch(watchId), (w) => w.evaluatedAt! > created.evaluatedAt!);
  assert.equal(hinted.state, 'ACTIVE', 'a Match was derived from an event payload');
  assert.equal((await readMatches(watchId)).length, 0);

  // The row fails too, and the same event now finds it.
  await sql.query(`UPDATE "session" SET "status" = 'FAILED' WHERE "id" = $1`, [session]);
  realtime.publish(session, event(RunEventType.STATUS, { status: 'FAILED' }));
  const [match] = await eventually('the Match', () => readMatches(watchId), (m) => m.length === 1);
  assert.equal(match.snapshot.targets[0].observed?.status, 'FAILED');
});

test('notifications dropped on purpose are caught by the periodic reconciliation, no earlier than it was due', { skip, timeout: 120_000 }, async () => {
  const lossy = replica({ reconcileIntervalMs: 3_000, pollIntervalMs: 100 }, (prisma) => new DroppingRealtime(prisma));
  const hub = lossy.realtime as DroppingRealtime;
  const finished = await insertSession({ status: 'SUCCEEDED' });
  const asking = await insertSession({ status: 'RUNNING' });
  const work = await insertTask('OPEN');
  // Two of these leaves have no durable event at all (contract §8); the third has one, and loses it.
  const watches: Record<string, string> = {
    completed: await insertWatch([{ kind: 'SESSION', id: finished }], all('SESSION_LIFECYCLE_TERMINAL')),
    attention: await insertWatch([{ kind: 'SESSION', id: asking }], any('SESSION_NEEDS_ATTENTION')),
    cancelled: await insertWatch([{ kind: 'TASK', id: work }], all('TASK_TERMINAL')),
  };
  lossy.evaluator.start();
  const scheduled: Record<string, WatchRead> = {};
  for (const [name, id] of Object.entries(watches)) {
    scheduled[name] = await eventually(`${name}: its first evaluation`, () => readWatch(id), (w) => w.evaluatedAt !== null);
    assert.equal(scheduled[name].state, 'ACTIVE', `${name} matched before anything changed`);
  }

  // Each row changes the way production changes it, and the event that would have hinted is published — and dropped.
  await sql.query(`UPDATE "session" SET "completed_at" = now() WHERE "id" = $1`, [finished]);
  hub.publishSessionLifecycleChanged(finished, 'SUCCEEDED', SessionEndReason.COMPLETED, SessionLifecycleState.COMPLETED);
  await insertApproval(asking, 'PENDING');
  hub.publish(asking, event(RunEventType.APPROVAL_REQUEST, { approvalId: randomUUID() }));
  await sql.query(`UPDATE "task" SET "status" = 'CANCELLED' WHERE "id" = $1`, [work]);
  hub.publishForUser(ownerId, RunEventType.TASK_CHANGED, { taskIds: [work], resync: false });
  assert.ok(hub.dropped >= 3, `only ${hub.dropped} events reached the dropping hub`);

  // The drop is real: nothing moved any of them earlier than their sweep.
  for (const [name, id] of Object.entries(watches)) {
    assert.equal((await readWatch(id)).nextEvaluateAt, scheduled[name].nextEvaluateAt, `${name} was rescheduled by something`);
    assert.equal((await readMatches(id)).length, 0, `${name} matched before its sweep`);
  }

  // The sweep comes round and finds all three, each no earlier than it was due.
  for (const [name, id] of Object.entries(watches)) {
    const [match] = await eventually(`${name}: the reconciliation`, () => readMatches(id), (m) => m.length === 1);
    assert.ok(
      match.matchedAt >= scheduled[name].nextEvaluateAt!,
      `${name} matched at ${match.matchedAt}, before its sweep was due at ${scheduled[name].nextEvaluateAt}`,
    );
  }
  await lossy.evaluator.stop();

  // The paired control: the same change through a hub that delivers is matched long before its sweep.
  const prompt = replica();
  const other = await insertTask('OPEN');
  const hinted = await insertWatch([{ kind: 'TASK', id: other }], all('TASK_TERMINAL'));
  prompt.evaluator.start();
  const first = await eventually('its first evaluation', () => readWatch(hinted), (w) => w.evaluatedAt !== null);
  await sql.query(`UPDATE "task" SET "status" = 'CANCELLED' WHERE "id" = $1`, [other]);
  prompt.realtime.publishForUser(ownerId, RunEventType.TASK_CHANGED, { taskIds: [other], resync: false });
  const [match] = await eventually('the hinted Match', () => readMatches(hinted), (m) => m.length === 1);
  assert.ok(match.matchedAt < first.nextEvaluateAt!, 'a delivered hint still waited for the sweep');
});

test('an expired lease is taken over, and the stalled holder lands nothing a second time', { skip, timeout: 120_000 }, async () => {
  const holder = replica({ leaseMs: 2_000 }).evaluator;
  const taker = replica({ leaseMs: 2_000 }).evaluator;
  const work = await insertTask('OPEN');
  const watchId = await insertWatch([{ kind: 'TASK', id: work }], all('TASK_TERMINAL'));

  // The holder claims it and stalls before evaluating: a paused process, a partition, a long GC.
  assert.deepEqual(await holder.claimDue(), [watchId]);
  const leased = await readWatch(watchId);
  assert.equal(leased.due, false, 'a claim moves next_evaluate_at past now; that is the lease');
  await sql.query(`UPDATE "task" SET "status" = 'FAILED' WHERE "id" = $1`, [work]);

  // While the lease runs nobody else takes it, though its condition already holds.
  assert.deepEqual(await taker.claimDue(), []);
  assert.equal(await taker.drain(), 0);
  assert.equal((await readMatches(watchId)).length, 0);

  // The lease lapses, and the taker's ordinary pass takes the watch over.
  await eventually('the lease to lapse', () => readWatch(watchId), (w) => w.due === true, 10_000);
  assert.equal(await taker.drain(), 1);
  const landed = await readMatches(watchId);
  assert.equal(landed.length, 1);
  const settled = await readWatch(watchId);
  assert.equal(settled.state, 'MATCHED');

  // The holder resumes and finishes what it claimed. It finds the watch settled and writes nothing.
  assert.deepEqual(await holder.evaluate(watchId), { watchId, outcome: 'SETTLED', matchId: null });
  assert.deepEqual(await readMatches(watchId), landed);
  assert.deepEqual(await readWatch(watchId), settled);

  // Two workers deciding one watch at the same instant: one lands it, the other finds it landed.
  const raced = await insertWatch([{ kind: 'TASK', id: await insertTask('CANCELLED') }], all('TASK_TERMINAL'));
  const outcomes = await Promise.all([holder.evaluate(raced), taker.evaluate(raced)]);
  assert.deepEqual(outcomes.map((outcome) => outcome.outcome).sort(), ['MATCHED', 'SETTLED']);
  assert.equal((await readMatches(raced)).length, 1);
});

test('a worker killed holding a lease, an apiserver restarted around waiting watches and a runner restarted under one all recover', { skip, timeout: 180_000 }, async () => {
  // 1. A worker dies between its claim and its landing, and its process — pool and all — is gone.
  const doomed = replica({ leaseMs: 1_500 }, undefined, KilledAfterClaim);
  const orphanedWork = await insertTask('OPEN');
  const orphaned = await insertWatch([{ kind: 'TASK', id: orphanedWork }], all('TASK_TERMINAL'));
  assert.equal(await doomed.evaluator.drain(), 0);
  const lease = await readWatch(orphaned);
  assert.deepEqual([lease.state, lease.due, lease.evaluatedAt], ['ACTIVE', false, null], 'the claim did not hold a lease');
  await doomed.evaluator.stop();
  await doomed.prisma.$disconnect();
  await sql.query(`UPDATE "task" SET "status" = 'CANCELLED' WHERE "id" = $1`, [orphanedWork]);
  const successor = replica({ pollIntervalMs: 100 });
  successor.evaluator.start();
  const [recovered] = await eventually(
    'a successor to take over the dead worker\'s watch',
    () => readMatches(orphaned),
    (m) => m.length === 1,
  );
  assert.ok(recovered.matchedAt >= lease.nextEvaluateAt!, 'taken over before the dead worker\'s lease lapsed');
  await successor.evaluator.stop();

  // 2. The apiserver stops around two waiting watches and starts again as a new process.
  const firstServer = await bootApiServer({ pollIntervalMs: 100, reconcileIntervalMs: 1_500 });
  const work = await insertTask('OPEN');
  const conversation = await insertSession({ status: 'RUNNING' });
  const waiting = [
    await insertWatch([{ kind: 'TASK', id: work }], all('TASK_TERMINAL')),
    await insertWatch([{ kind: 'SESSION', id: conversation }], all('SESSION_TURN_SETTLED')),
  ];
  for (const id of waiting) {
    await eventually('the first apiserver to evaluate it', () => readWatch(id), (w) => w.evaluatedAt !== null);
  }
  await firstServer.close();

  // While it is down both conditions come true, and the event that would have hinted reaches nobody.
  await sql.query(`UPDATE "task" SET "status" = 'FAILED' WHERE "id" = $1`, [work]);
  await sql.query(`UPDATE "session" SET "status" = 'AWAITING_INPUT' WHERE "id" = $1`, [conversation]);
  firstServer.realtime.publish(conversation, event(RunEventType.STATUS, { status: 'AWAITING_INPUT' }));
  // Due, and nobody takes them: the closed application really did stop its loop.
  for (const id of waiting) await eventually('its sweep to come due', () => readWatch(id), (w) => w.due === true, 10_000);
  await sleep(600);
  for (const id of waiting) {
    assert.equal((await readWatch(id)).state, 'ACTIVE', 'a closed apiserver kept evaluating');
    assert.equal((await readMatches(id)).length, 0);
  }

  const restartedAt = await dbNow();
  const secondServer = await bootApiServer({ pollIntervalMs: 100, reconcileIntervalMs: 1_500 });
  for (const id of waiting) {
    const [match] = await eventually('the restarted apiserver to match it', () => readMatches(id), (m) => m.length === 1);
    assert.ok(match.matchedAt >= restartedAt, 'matched before the restart');
  }

  // 3. A runner restarts under a watched session. What it was about to report dies with it, and the
  //    process that comes back parks the session with writes that publish nothing to this replica.
  const runnerId = randomUUID();
  await secondServer.prisma.runner.create({
    data: { id: runnerId, name: 'restarting runner', ownerId, tokenHash: randomUUID(), lastHeartbeatAt: new Date() },
  });
  const onRunner = await insertSession({ status: 'RUNNING', runnerId });
  const watched = await insertWatch([{ kind: 'SESSION', id: onRunner }], all('SESSION_TURN_SETTLED'));
  const beforeRestart = await eventually('its evaluation while the runner runs it', () => readWatch(watched), (w) => w.evaluatedAt !== null);
  assert.equal(beforeRestart.state, 'ACTIVE');
  await sql.query(`UPDATE "runner" SET "last_heartbeat_at" = NULL WHERE "id" = $1`, [runnerId]);
  await sql.query(`UPDATE "runner" SET "last_heartbeat_at" = now() WHERE "id" = $1`, [runnerId]);
  await sql.query(`UPDATE "session" SET "status" = 'AWAITING_INPUT' WHERE "id" = $1`, [onRunner]);
  const [parked] = await eventually('the watch to see the parked session', () => readMatches(watched), (m) => m.length === 1);
  assert.ok(parked.matchedAt >= beforeRestart.nextEvaluateAt!, 'matched before its sweep, so something other than the row decided');
  await secondServer.close();
});

test('next_evaluate_at is the clock: an unhinted watch expires on time, and pausing a watch does not stop it', { skip, timeout: 60_000 }, async () => {
  const { evaluator } = replica({ pollIntervalMs: 100 });
  const open = await insertTask('OPEN');
  const finished = await insertTask('DONE');
  const waiting = await insertWatch([{ kind: 'TASK', id: open }], all('TASK_TERMINAL'), { ttlMs: 2_500 });
  const paused = await insertWatch([{ kind: 'TASK', id: finished }], all('TASK_TERMINAL'), { ttlMs: 2_500, state: 'PAUSED' });
  evaluator.start();
  for (const id of [waiting, paused]) {
    const first = await eventually('its first evaluation', () => readWatch(id), (w) => w.evaluatedAt !== null);
    assert.equal(first.atExpiry, true, 'a watch an hour from its next sweep was not scheduled for its expiry');
  }
  assert.equal((await readMatches(paused)).length, 0, 'a paused watch was evaluated');
  for (const id of [waiting, paused]) {
    const expired = await eventually('its expiry', () => readWatch(id), (w) => w.state === 'EXPIRED');
    assert.equal(expired.nextEvaluateAt, null);
    assert.equal((await readMatches(id)).length, 0);
  }
});

test('idle watches hold no timer, process or session of their own: one loop timer serves all of them', { skip, timeout: 120_000 }, async () => {
  // The probes' controls come first: a probe that reports nothing has to be one that could report something.
  const control = timerProbe(/perWatchTimerControl/);
  const handles = perWatchTimerControl(61);
  await sleep(100);
  assert.equal(control.live(), 61, 'the timer probe cannot see a timer per watch');
  for (const handle of handles) clearTimeout(handle);
  await sleep(100);
  assert.equal(control.live(), 0, 'the timer probe does not see a timer go');
  control.disable();

  const spawns = spawnProbe();
  try {
    await new Promise<void>((resolve, reject) => {
      childProcess.execFile('true', (error) => (error ? reject(error) : resolve()));
    });
    assert.equal(spawns.calls.length, 1, 'the process probe cannot see a child process');
    spawns.calls.length = 0;

    const sessions: string[] = [];
    const tasks: string[] = [];
    for (let i = 0; i < 30; i += 1) sessions.push(await insertSession({ status: 'RUNNING' }));
    for (let i = 0; i < 31; i += 1) tasks.push(await insertTask('OPEN'));
    const rows = async () => {
      const { rows: [counts] } = await sql.query<{ sessions: number; turns: number }>(
        `SELECT (SELECT count(*) FROM "session")::int AS "sessions", (SELECT count(*) FROM "conversation_turn")::int AS "turns"`,
      );
      return counts;
    };
    const before = await rows();

    // Every pass here is started by a kick or a hint, and the poll timer is ten minutes out, so a timer
    // alive between passes is the loop's own. The reconciliation period is long enough for one pass
    // to finish all of them: shorter, and a pass finds the first watches due again before it reaches
    // the last, and rightly never stops to arm a timer at all.
    const { evaluator, realtime } = replica({ reconcileIntervalMs: 8_000, pollIntervalMs: 10 * 60_000 });
    const probe = timerProbe(WATCH_CODE);
    const idle = [await insertWatch([{ kind: 'TASK', id: tasks[0] }], all('TASK_TERMINAL'))];
    evaluator.start();
    await eventually('the one idle watch evaluated', () => readWatch(idle[0]), (w) => w.evaluatedAt !== null);
    await eventually('the loop to hold its timer', async () => probe.live(), (live) => live === 1, 5_000);

    for (const id of sessions) idle.push(await insertWatch([{ kind: 'SESSION', id }], all('SESSION_RUN_TERMINAL')));
    for (const id of tasks.slice(1)) idle.push(await insertWatch([{ kind: 'TASK', id }], all('TASK_TERMINAL')));
    const evaluatedSince = async (since: string | null) => {
      const { rows: [{ n }] } = await sql.query<{ n: number }>(
        `SELECT count(*)::int AS "n" FROM "watch"
         WHERE "id" = ANY($1::uuid[]) AND "last_evaluated_at" IS NOT NULL
           AND ($2::text IS NULL OR to_char("last_evaluated_at" AT TIME ZONE 'UTC', ${MICROS}) > $2::text)`,
        [idle, since],
      );
      return n;
    };
    const allDue = async () => {
      const { rows: [{ due }] } = await sql.query<{ due: boolean }>(
        `SELECT bool_and("next_evaluate_at" <= now()) AS "due" FROM "watch" WHERE "id" = ANY($1::uuid[])`,
        [idle],
      );
      return due;
    };
    evaluator.kick();
    await eventually('every idle watch evaluated', () => evaluatedSince(null), (n) => n === idle.length);
    await eventually('the loop back to its one timer', async () => probe.live(), (live) => live === 1, 5_000);

    // Their reconciliation comes round: a kick starts the pass, and hints arrive in the middle of it.
    await eventually('every idle watch due again', allDue, (due) => due === true, 30_000);
    const roundStart = await dbNow();
    evaluator.kick();
    for (const id of sessions.slice(0, 5)) realtime.publish(id, event(RunEventType.STATUS, { status: 'RUNNING' }));
    realtime.publishForUser(ownerId, RunEventType.TASK_CHANGED, { taskIds: tasks.slice(0, 5), resync: false });
    await eventually('every idle watch evaluated again', () => evaluatedSince(roundStart), (n) => n === idle.length);
    await eventually('the loop back to its one timer', async () => probe.live(), (live) => live === 1, 5_000);
    await sleep(300);
    assert.equal(probe.live(), 1, `${idle.length} idle watches, each evaluated at least twice: still exactly one timer`);
    assert.ok(probe.created() < idle.length, `${probe.created()} timers were created for ${idle.length} idle watches`);
    assert.equal((await readMatches(idle[0])).length, 0);

    await evaluator.stop();
    await sleep(100);
    assert.equal(probe.live(), 0, 'a stopped evaluator left a timer behind');
    probe.disable();

    assert.deepEqual(spawns.calls, [], 'evaluating idle watches started a process');
    assert.equal(process.getActiveResourcesInfo().includes('ProcessWrap'), false, 'a child process is still running');
    assert.deepEqual(await rows(), before, 'evaluating idle watches created a session or a turn');
    // ...and the count is one that sees a session when one is made.
    await insertSession({ status: 'AWAITING_INPUT' });
    assert.equal((await rows()).sessions, before.sessions + 1);
  } finally {
    spawns.restore();
  }
});

/** The design the idle case rules out: a timer per watch. The probe has to see every one. */
function perWatchTimerControl(watches: number): Array<ReturnType<typeof setTimeout>> {
  const handles: Array<ReturnType<typeof setTimeout>> = [];
  for (let i = 0; i < watches; i += 1) handles.push(setTimeout(() => undefined, HOUR).unref());
  return handles;
}

/**
 * Timers alive right now whose creating call site matches `site`, followed through async_hooks from
 * creation to destroy. The call site is the first frame outside Node's own timer machinery, so a
 * timer the evaluator's code made is attributed to it however the loop that made it was reached.
 */
function timerProbe(site: RegExp): { live(): number; created(): number; disable(): void } {
  const live = new Set<number>();
  let created = 0;
  const hook = createHook({
    init: function probeInit(asyncId: number, type: string): void {
      if (type !== 'Timeout' && type !== 'Immediate') return;
      const limit = Error.stackTraceLimit;
      Error.stackTraceLimit = 50;
      const stack = new Error().stack ?? '';
      Error.stackTraceLimit = limit;
      const caller = stack.split('\n').slice(1).find((frame) => !frame.includes('node:') && !frame.includes('probeInit'));
      if (caller !== undefined && site.test(caller)) {
        live.add(asyncId);
        created += 1;
      }
    },
    destroy: function probeDestroy(asyncId: number): void {
      live.delete(asyncId);
    },
  });
  hook.enable();
  return { live: () => live.size, created: () => created, disable: () => void hook.disable() };
}

/** Every child process started while it is installed, by any spelling `child_process` offers. */
function spawnProbe(): { calls: string[]; restore(): void } {
  const calls: string[] = [];
  const prototype = childProcess.ChildProcess.prototype as unknown as { spawn: (options: { file?: string }) => unknown };
  const spawn = prototype.spawn;
  prototype.spawn = function probedSpawn(this: unknown, options: { file?: string }) {
    calls.push(String(options?.file));
    return spawn.call(this, options);
  };
  const exported = childProcess as unknown as Record<string, (...args: unknown[]) => unknown>;
  const synchronous = ['spawnSync', 'execSync', 'execFileSync'].map((name) => [name, exported[name]] as const);
  for (const [name, original] of synchronous) {
    exported[name] = (...args: unknown[]) => {
      calls.push(name);
      return original(...args);
    };
  }
  return {
    calls,
    restore() {
      prototype.spawn = spawn;
      for (const [name, original] of synchronous) exported[name] = original;
    },
  };
}
