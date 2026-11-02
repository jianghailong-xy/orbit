/**
 * The Watch evaluator against a real PostgreSQL: leases, hints, reconciliation and restarts.
 *
 * What is under test is a set of promises about time and concurrency — a hint that arrives twice
 * or out of order, a notification that never arrives, a hint that meets a landing parked on a lock, a
 * worker that dies holding a lease, a process restarted around a waiting watch — and none of them is
 * witnessed except by making it happen. So
 * each case injects its fault itself: replicas that each own a Prisma pool and a realtime hub race
 * on one database, a hub drops every event on purpose, a worker is killed between its claim and its
 * landing, a Nest application context is closed and booted again as a new process would be.
 *
 * The job leaf (`SESSION_JOB_NO_OUTPUT_FOR`, predicateVersion 3) is driven the same way: its runner's job
 * reports go through the runner door's own handler, and the silence it decides is the passage of the
 * database's clock after the last of them.
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

import { BadRequestException, ForbiddenException, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient, RunStatus, SessionDispatchOrigin } from '@prisma/client';
import {
  NormalizedRunEvent,
  RunEventType,
  SessionEndReason,
  SessionLifecycleState,
  WATCH_LIMITS,
} from '@orbit/shared';
import { Client } from 'pg';
import { filter, Observable, tap } from 'rxjs';

import { sha256 } from '../common/crypto.util';
import { prismaClientFor } from '../prisma/prisma-client';
import { PrismaService } from '../prisma/prisma.service';
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from '../projects/coordinator-pg-test-safety';
import type { PushService } from '../push/push.service';
import { RealtimeService } from '../realtime/realtime.service';
import { RunnerApiController } from '../runner-api/runner-api.controller';
import type { CreateWatchDto } from './dto';
import {
  WATCH_EVALUATOR_OPTIONS,
  WatchEvaluation,
  WatchEvaluatorOptions,
  WatchEvaluatorService,
  watchHintFor,
} from './watch-evaluator.service';
import { redactReason, redactSnapshot } from './watch-redaction';
import { WatchesService } from './watches.service';

const URL = process.env.COORDINATOR_PG_URL;
const skip = !URL;

const HOUR = 60 * 60 * 1000;
/** A call site inside the Watch evaluator's own modules, as a stack frame names it. */
const WATCH_CODE = /[\\/]watches[\\/]watch-(?:evaluator\.service|evaluator\.module|predicate)\.js:/;

const CONTRACT = JSON.parse(
  readFileSync(path.resolve(__dirname, '../../../../contracts/watch.contract.json'), 'utf8'),
) as {
  leaves: Record<string, { targetKind: 'SESSION' | 'TASK'; sinceVersion?: number }>;
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

/** A replica whose next pass fails, as a pass fails on a database that went away: it throws once `fail` is called. */
class FailingPass extends WatchEvaluatorService {
  /** When each pass began. */
  readonly passes: number[] = [];
  private throwNow: (() => void) | null = null;
  private failNext = false;
  private readonly entered: Promise<void>;
  private enter!: () => void;

  constructor(...args: ConstructorParameters<typeof WatchEvaluatorService>) {
    super(...args);
    this.entered = new Promise((resolve) => (this.enter = resolve));
  }

  /** The next pass starts and waits for `fail`; resolves once it is in flight. */
  failNextPass(): Promise<void> {
    this.failNext = true;
    return this.entered;
  }

  /** The waiting pass throws. Its pass is over by the next timer: everything after the throw runs in microtasks. */
  fail(): void {
    this.throwNow?.();
  }

  override async drain(): Promise<number> {
    this.passes.push(Date.now());
    if (!this.failNext) return super.drain();
    this.failNext = false;
    await new Promise<void>((resolve) => {
      this.throwNow = resolve;
      this.enter();
    });
    throw new Error('the database went away mid-pass');
  }

  override async stop(): Promise<void> {
    this.fail();
    await super.stop();
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
  prisma: PrismaClient = prismaClientFor(URL!),
): Replica {
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
  owner?: string;
}): Promise<string> {
  const id = randomUUID();
  await sql.query(
    `INSERT INTO "session"("id","title","prompt","owner_id","creator_id","updated_at","status","end_reason",
                           "completed_at","deleted_at","assigned_runner_id")
     VALUES ($1,'watched session','p',$2,$2,now(),$3,$4,
             CASE WHEN $5::boolean THEN now() END, CASE WHEN $6::boolean THEN now() END, $7)`,
    [id, row.owner ?? ownerId, row.status, row.endReason ?? null, row.completedAt ?? false, row.deletedAt ?? false, row.runnerId ?? null],
  );
  return id;
}

async function insertApproval(sessionId: string, status: string): Promise<void> {
  await sql.query(
    `INSERT INTO "approval"("id","session_id","tool_name","input","status") VALUES ($1,$2,'Bash','{}'::jsonb,$3)`,
    [randomUUID(), sessionId, status],
  );
}

/**
 * A watch as creation leaves it: ACTIVE, generation 0, due now, its target set frozen. One statement,
 * as creation writes both in one transaction: a loop already running never claims a due watch
 * before its targets exist and settles it UNRESOLVABLE for having none.
 */
async function insertWatch(
  targets: Target[],
  predicate: unknown,
  over: { ttlMs?: number; state?: string; predicateVersion?: number } = {},
): Promise<string> {
  const id = randomUUID();
  await sql.query(
    `WITH "created" AS (
       INSERT INTO "watch"("id","owner_id","observer_type","predicate","mode","action","state","expires_at","next_evaluate_at",
                           "predicate_version")
       VALUES ($1,$2,'USER',$3::jsonb,'ONE_SHOT','NOTIFY_USER',$4,now() + $5::int * interval '1 millisecond',now(),$9)
       RETURNING "id"
     )
     INSERT INTO "watch_target"("id","watch_id","target_kind","target_resource_id")
     SELECT "target"."id", "created"."id", "target"."kind", "target"."resource_id"
       FROM "created", unnest($6::uuid[], $7::text[], $8::uuid[]) AS "target"("id", "kind", "resource_id")`,
    [
      id,
      ownerId,
      JSON.stringify(predicate),
      over.state ?? 'ACTIVE',
      over.ttlMs ?? HOUR,
      targets.map(() => randomUUID()),
      targets.map((target) => target.kind),
      targets.map((target) => target.id),
      over.predicateVersion ?? 1,
    ],
  );
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

/** pg.Pool's default size, which a PrismaPg built from a URL keeps: each replica's pool here, and the apiserver's own. */
const POOL_MAX = 10;
/** A fragment of the statement a hint issues. */
const MARK_DUE = 'SET "next_evaluate_at" = now()';

/**
 * A client whose transactions outlast the lock a case parks them on. Prisma rolls an interactive
 * transaction back after five seconds, which a parked landing on a starved host could reach before the
 * case lets it go; nothing else about it differs from a replica's own.
 */
function patientPrisma(): PrismaClient {
  return new PrismaClient({ adapter: new PrismaPg(URL!), transactionOptions: { timeout: 60_000 } });
}

/** Opens every connection a pool keeps, as a replica that has been serving has them open. */
async function warm(prisma: PrismaClient): Promise<void> {
  await Promise.all(Array.from({ length: POOL_MAX }, () => prisma.$executeRaw`SELECT pg_sleep(0.1)`));
}

/**
 * A transaction of the case's own holding one row lock until released. It is released before anything
 * else a case started is stopped: an evaluation still waiting on it would keep its pool from closing.
 */
async function holdRow(statement: string): Promise<() => Promise<void>> {
  const holder = new Client({ connectionString: URL, connectionTimeoutMillis: 5_000 });
  await holder.connect();
  await holder.query('BEGIN');
  await holder.query(statement);
  let released: Promise<void> | undefined;
  const release = () => (released ??= holder.query('COMMIT').then(() => holder.end()).catch(() => {}));
  running.unshift({ stop: release });
  return release;
}

/** Backends of this database waiting on a lock in a statement containing `fragment`. */
async function waitingOnLocks(fragment: string): Promise<number> {
  const { rows: [{ n }] } = await sql.query<{ n: number }>(
    `SELECT count(*)::int AS "n" FROM pg_stat_activity
     WHERE "datname" = current_database() AND "wait_event_type" = 'Lock' AND position($1 in "query") > 0`,
    [fragment],
  );
  return n;
}

/** Backends of this database whose last statement containing `fragment` started at or after `since` and has finished. */
async function finishedSince(fragment: string, since: string): Promise<number> {
  const { rows: [{ n }] } = await sql.query<{ n: number }>(
    `SELECT count(*)::int AS "n" FROM pg_stat_activity
     WHERE "datname" = current_database() AND "state" = 'idle' AND position($1 in "query") > 0
       AND "query_start" >= $2::timestamp AT TIME ZONE 'UTC'`,
    [fragment, since],
  );
  return n;
}

/** Backends of this database that started a statement containing `fragment` at or after `since`, running or finished. */
async function startedSince(fragment: string, since: string): Promise<number> {
  const { rows: [{ n }] } = await sql.query<{ n: number }>(
    `SELECT count(*)::int AS "n" FROM pg_stat_activity
     WHERE "datname" = current_database() AND position($1 in "query") > 0
       AND "query_start" >= $2::timestamp AT TIME ZONE 'UTC'`,
    [fragment, since],
  );
  return n;
}

/**
 * A landing parked halfway, as a lock held elsewhere parks one. A watch over two open tasks is evaluated
 * once; its first task ends; its next evaluation — `called` directly, or `claimed` by the judge's running
 * loop — reads both tasks, has the ended target's state to write, and stops at that write because the
 * case holds the target's row. Until the case lets go, that evaluation holds the watch's row, having read
 * the second task open. No other loop may be running yet: it would claim the watch, created due, and
 * write the ended target's state itself, leaving the evaluation nothing to stop at.
 */
async function parkLanding(judge: Replica, how: 'called' | 'claimed') {
  const ended = await insertTask('OPEN');
  const open = await insertTask('OPEN');
  const watchId = await insertWatch([{ kind: 'TASK', id: ended }, { kind: 'TASK', id: open }], all('TASK_TERMINAL'));
  assert.equal((await judge.evaluator.evaluate(watchId)).outcome, 'SCHEDULED');
  await sql.query(`UPDATE "task" SET "status" = 'CANCELLED' WHERE "id" = $1`, [ended]);
  const release = await holdRow(
    `SELECT 1 FROM "watch_target" WHERE "watch_id" = '${watchId}' AND "target_resource_id" = '${ended}' FOR UPDATE`,
  );
  let landing: Promise<WatchEvaluation> | null = null;
  if (how === 'called') {
    landing = judge.evaluator.evaluate(watchId);
    landing.catch(() => undefined); // awaited by the case; a case that fails first leaves it to settle unobserved
  } else {
    await sql.query(`UPDATE "watch" SET "next_evaluate_at" = "created_at" WHERE "id" = $1`, [watchId]);
    judge.evaluator.start();
    judge.evaluator.kick();
  }
  await eventually('the landing to park on the target row', () => waitingOnLocks('UPDATE "watch_target"'), (n) => n === 1, 10_000);
  return { watchId, open, release, landing };
}

/** Every hint a replica is handed, published or direct: once all have settled, how many watches they made due. */
function hintsOf(evaluator: WatchEvaluatorService): { settled(): Promise<number> } {
  const applying = new Set<Promise<number>>();
  let pulled = 0;
  const hint = evaluator.hint.bind(evaluator);
  evaluator.hint = (kind, ids) => {
    const applied = hint(kind, ids).then((moved) => {
      pulled += moved;
      return moved;
    });
    applying.add(applied);
    void applied.finally(() => applying.delete(applied));
    return applied;
  };
  return {
    async settled() {
      while (applying.size > 0) await Promise.all(applying);
      return pulled;
    },
  };
}

test('every leaf decides the contract vectors from the rows the evaluator reads', { skip, timeout: 120_000 }, async () => {
  const { evaluator } = replica();
  const exercised = new Set<string>();
  let vectors = 0;
  for (const vector of CONTRACT.vectors) {
    // The version-1 leaves, which a bare `{ kind, over, leaf }` term asks. The leaves a later grammar
    // added take params and progress rows, and watch-advanced.pg.spec.ts drives their vectors.
    const expectations = Object.entries(vector.expect).filter(([key]) => key in CONTRACT.leaves && !CONTRACT.leaves[key].sinceVersion);
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
  assert.deepEqual(
    [...exercised].sort(),
    Object.keys(CONTRACT.leaves).filter((leaf) => !CONTRACT.leaves[leaf].sinceVersion).sort(),
    'a leaf no vector exercised',
  );
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

test('a task.changed on a session\'s key moves the watches of that session\'s account, and no other account\'s', { skip, timeout: 60_000 }, async () => {
  const hinted = replica();
  const work = await insertTask('OPEN');
  const watch = await insertWatch([{ kind: 'TASK', id: work }], all('TASK_TERMINAL'));
  const own = await insertSession({ status: 'RUNNING' });
  const theirs = await insertSession({ status: 'RUNNING', owner: otherOwnerId });
  hinted.evaluator.start();
  const first = await eventually('its first evaluation', () => readWatch(watch), (w) => w.evaluatedAt !== null);
  await sql.query(`UPDATE "task" SET "status" = 'CANCELLED' WHERE "id" = $1`, [work]);

  // A runner re-publishes the events it posts on its own session: another account's machine naming
  // this account's task there is matched among its own account's watches, and moves none of these.
  const foreign = watchHintFor(theirs, event(RunEventType.TASK_CHANGED, { taskIds: [work] }));
  assert.deepEqual(foreign, { kind: 'TASK', ids: [work], owner: { sessionId: theirs } });
  assert.equal(await hinted.evaluator.hint(foreign.kind, foreign.ids, foreign.owner), 0, 'another account\'s session moved the watch');
  assert.equal((await readWatch(watch)).nextEvaluateAt, first.nextEvaluateAt);

  // The control plane's own announcement on a session of the account (`publishTaskChanged`) is still a
  // hint, matched long before the sweep as one on the account's key is.
  hinted.realtime.publishTaskChanged(own, work);
  const [match] = await eventually('the hinted Match', () => readMatches(watch), (m) => m.length === 1);
  assert.ok(match.matchedAt < first.nextEvaluateAt!, 'a hint on the account\'s own session still waited for the sweep');
});

test('a burst of hints naming a watch whose landing is parked on a lock waits for nothing: it holds none of its replica\'s pooled connections, and the watch is still evaluated once the landing lets go', { skip, timeout: 120_000 }, async () => {
  const judge = replica({}, undefined, undefined, patientPrisma());
  const hinted = replica();
  const parked = await parkLanding(judge, 'called');
  await warm(hinted.prisma);
  const hints = hintsOf(hinted.evaluator);
  hinted.evaluator.start();

  // Twice as many hints as the replica has connections, as a burst of events naming one task arrives.
  for (let i = 0; i < 2 * POOL_MAX; i += 1) {
    hinted.realtime.publishForUser(ownerId, RunEventType.TASK_CHANGED, { taskIds: [parked.open], resync: false });
  }
  const burstAt = Date.now();
  const unrelated = hinted.prisma.$queryRaw`SELECT 1`.then(() => Date.now() - burstAt);
  let waiting = 0;
  while (waiting < POOL_MAX && Date.now() - burstAt < 1_500) {
    waiting = Math.max(waiting, await waitingOnLocks(MARK_DUE));
    await sleep(25);
  }
  assert.equal(
    waiting,
    0,
    `${waiting} hints were waiting in the database for the parked landing's watch row, each on one of the ${POOL_MAX} connections its replica's pool has`,
  );
  const answeredMs = await Promise.race([unrelated, sleep(1_000).then(() => null)]);
  assert.notEqual(answeredMs, null, 'a query that reads no watch found no free connection on the replica the hints arrived at');

  // Nothing was dropped: once the landing lets go, the hints make its watch due, and it is evaluated again.
  const releasedAt = await dbNow();
  await parked.release();
  assert.equal((await parked.landing!).outcome, 'SCHEDULED');
  assert.ok((await hints.settled()) >= 1, 'no hint of the burst made the watch due once the landing had let go');
  const again = await eventually(
    'the evaluation the hints caused',
    () => readWatch(parked.watchId),
    (w) => w.evaluatedAt! > releasedAt && w.due === false,
    10_000,
  );
  assert.equal(again.state, 'ACTIVE');
});

test('a hint that finds its watch already due starts a pass for it: a watch whose row another ask held as the pass claimed is matched within seconds, not at the poll interval', { skip, timeout: 60_000 }, async () => {
  const { evaluator } = replica(); // its poll interval is an hour
  const task = await insertTask('OPEN');
  const watchId = await insertWatch([{ kind: 'TASK', id: task }], all('TASK_TERMINAL'));
  assert.equal((await evaluator.evaluate(watchId)).outcome, 'SCHEDULED');

  // 1. Its task ends and the watch is made due, but its row is held when the pass claims, as an ask of a burst
  //    holds it while it decides: one that read the watch before another ask made it due. The claim passes the
  //    row over, and the pass ends with the watch still due.
  await sql.query(`UPDATE "task" SET "status" = 'CANCELLED' WHERE "id" = $1`, [task]);
  await sql.query(`UPDATE "watch" SET "next_evaluate_at" = now() WHERE "id" = $1`, [watchId]);
  const release = await holdRow(`SELECT 1 FROM "watch" WHERE "id" = '${watchId}' FOR UPDATE`);
  const drain = evaluator.drain.bind(evaluator);
  const firstPass = new Promise<number>((resolve, reject) => {
    evaluator.drain = () => {
      evaluator.drain = drain;
      const evaluated = drain();
      evaluated.then(resolve, reject);
      return evaluated;
    };
  });
  evaluator.start();
  assert.equal(await firstPass, 0, 'the pass claimed a watch whose row was held');
  await release();
  assert.equal((await readWatch(watchId)).due, true);
  assert.equal((await readMatches(watchId)).length, 0);

  // 2. The next hint naming it finds it already due. It writes nothing, and the pass it starts matches it.
  assert.equal(await evaluator.hint('TASK', [task]), 0, 'a hint wrote a watch that was already due');
  await eventually('the Match of the pass the hint started', () => readMatches(watchId), (m) => m.length === 1, 10_000);
});

test('a hint that came during a failed pass is not left to the poll interval, and the failed pass is not retried for each of them: however many came, one pass follows, after a pause', { skip, timeout: 60_000 }, async () => {
  const { evaluator } = replica({}, undefined, FailingPass); // its poll interval is an hour
  const failing = evaluator as FailingPass;
  const task = await insertTask('OPEN');
  const watchId = await insertWatch([{ kind: 'TASK', id: task }], all('TASK_TERMINAL'));
  assert.equal((await evaluator.evaluate(watchId)).outcome, 'SCHEDULED');
  await sql.query(`UPDATE "task" SET "status" = 'CANCELLED' WHERE "id" = $1`, [task]);

  const inFlight = failing.failNextPass();
  evaluator.start();
  await inFlight;
  // The first makes the watch due and the others find it so: three hints asking for another pass while this one runs.
  assert.equal(await evaluator.hint('TASK', [task]), 1);
  assert.equal(await evaluator.hint('TASK', [task]), 0);
  assert.equal(await evaluator.hint('TASK', [task]), 0);
  const failedAt = Date.now();
  failing.fail();

  await eventually('the Match of the pass that follows', () => readMatches(watchId), (m) => m.length === 1, 10_000);
  assert.equal(failing.passes.length, 2, 'the failed pass was retried for each hint that came during it');
  const pausedMs = failing.passes[1] - failedAt;
  assert.ok(pausedMs >= 900, `the failed pass was retried after only ${pausedMs} ms`);
});

test('a hint that follows a failed pass is not left to the poll interval, and does not retry the failed pass itself: it brings the next pass forward to a pause, however many follow', { skip, timeout: 60_000 }, async () => {
  const { evaluator } = replica({}, undefined, FailingPass); // its poll interval is an hour
  const failing = evaluator as FailingPass;
  const task = await insertTask('OPEN');
  const watchId = await insertWatch([{ kind: 'TASK', id: task }], all('TASK_TERMINAL'));
  assert.equal((await evaluator.evaluate(watchId)).outcome, 'SCHEDULED');

  // The watch is due, and the pass that should take it fails with no hint beside it: the next look is the timer's.
  await sql.query(`UPDATE "task" SET "status" = 'CANCELLED' WHERE "id" = $1`, [task]);
  await sql.query(`UPDATE "watch" SET "next_evaluate_at" = now() WHERE "id" = $1`, [watchId]);
  const inFlight = failing.failNextPass();
  evaluator.start();
  await inFlight;
  failing.fail();
  await sleep(1);
  assert.equal((await readWatch(watchId)).due, true);
  assert.equal((await readMatches(watchId)).length, 0);

  // Hints keep coming, and each reaches the database. The first finds the watch already due and writes nothing. None
  // of them starts a pass: the pass that matches the watch comes after a pause, and later hints do not put it off.
  const hintedAt = Date.now();
  assert.equal(await evaluator.hint('TASK', [task]), 0, 'a hint wrote a watch that was already due');
  await eventually('the Match of the pass that follows', async () => {
    await evaluator.hint('TASK', [task]);
    return readMatches(watchId);
  }, (m) => m.length === 1, 10_000);
  const pausedMs = failing.passes[1] - hintedAt;
  assert.ok(pausedMs >= 900, `a hint retried the failed pass after only ${pausedMs} ms`);
});

test('a database that is failing is retried by the timer and not by a hint: a hint that cannot reach it starts no pass', { skip, timeout: 60_000 }, async () => {
  // Nothing listens on port 1, so every statement fails as on a database that went away.
  const unreachable = prismaClientFor('postgresql://nobody:nothing@127.0.0.1:1/gone');
  const { evaluator } = replica({}, undefined, FailingPass, unreachable); // its poll interval is an hour
  const { passes } = evaluator as FailingPass;
  evaluator.start();
  assert.equal(passes.length, 1, 'starting the loop did not start its first pass');
  for (let i = 0; i < 5; i += 1) assert.equal(await evaluator.hint('TASK', [randomUUID()]), 0);
  await sleep(1_500); // past the pause of the retry that a hint which did reach the database earns
  assert.equal(passes.length, 1, 'a hint that could not reach the database started a pass');
});

test('a change whose hint meets a landing that read the rows before it is still matched within seconds, not at the reconciliation', { skip, timeout: 120_000 }, async () => {
  const judge = replica({}, undefined, undefined, patientPrisma());
  const hinted = replica();
  const latencyMs: Record<string, number> = {};

  // 1. The landing is another replica's. The change commits while it is parked, then its hint arrives.
  const across = await parkLanding(judge, 'called');
  hinted.evaluator.start();
  let since = await dbNow();
  await sql.query(`UPDATE "task" SET "status" = 'CANCELLED' WHERE "id" = $1`, [across.open]);
  hinted.realtime.publishForUser(ownerId, RunEventType.TASK_CHANGED, { taskIds: [across.open], resync: false });
  await eventually('the hint to reach the database while the landing holds its watch', () => startedSince(MARK_DUE, since), (n) => n > 0);
  let releasedAt = Date.now();
  await across.release();
  assert.equal((await across.landing!).outcome, 'SCHEDULED', 'the parked landing read the change it was parked to miss');
  await eventually('the Match of the change the hint announced', () => readMatches(across.watchId), (m) => m.length === 1, 10_000);
  latencyMs.anotherReplicasLanding = Date.now() - releasedAt;

  // 2. The landing is the hinted replica's own, inside the pass its running loop started.
  const own = await parkLanding(judge, 'claimed');
  since = await dbNow();
  await sql.query(`UPDATE "task" SET "status" = 'CANCELLED' WHERE "id" = $1`, [own.open]);
  judge.realtime.publishForUser(ownerId, RunEventType.TASK_CHANGED, { taskIds: [own.open], resync: false });
  await eventually('the hint to reach the database while the landing holds its watch', () => startedSince(MARK_DUE, since), (n) => n > 0);
  releasedAt = Date.now();
  await own.release();
  await eventually('the Match of the change the hint announced', () => readMatches(own.watchId), (m) => m.length === 1, 10_000);
  latencyMs.itsOwnLanding = Date.now() - releasedAt;
  console.log(`HINT-NOTE ${JSON.stringify(latencyMs)}`);
});

test('a hint that finds its watch held asks again for what the holder was: a landing older than the hint leaves the watch due, a claim leaves it claimed', { skip, timeout: 60_000 }, async () => {
  const { evaluator } = replica(); // never started: nothing but this hint moves either watch
  const task = await insertTask('OPEN');
  const landed = await insertWatch([{ kind: 'TASK', id: task }], all('TASK_TERMINAL'));
  const claimed = await insertWatch([{ kind: 'TASK', id: task }], all('TASK_TERMINAL'));
  for (const id of [landed, claimed]) assert.equal((await evaluator.evaluate(id)).outcome, 'SCHEDULED');

  // Each row is held by a transaction that writes what its real counterpart writes, and began before the hint:
  // a landing moves the schedule and `last_evaluated_at`; a claim moves the schedule by its lease and nothing else.
  const releaseLanding = await holdRow(
    `UPDATE "watch" SET "last_evaluated_at" = now(), "next_evaluate_at" = LEAST(now() + interval '30 minutes', "expires_at") WHERE "id" = '${landed}'`,
  );
  const releaseClaim = await holdRow(
    `UPDATE "watch" SET "next_evaluate_at" = LEAST(now() + interval '1 minute', "expires_at") WHERE "id" = '${claimed}'`,
  );
  const since = await dbNow();
  const hinting = evaluator.hint('TASK', [task]);
  // Released only once the hint's first ask has finished: a release that lands while that statement is still
  // running would let the ask find a row free, and nothing after it would have been needed.
  await eventually('the hint\'s first ask to finish while both watches are held', () => finishedSince(MARK_DUE, since), (n) => n > 0);
  await releaseLanding();
  await releaseClaim();
  const moved = await hinting;

  assert.equal((await readWatch(landed)).due, true, 'a watch whose landing began before the hint was left to its sweep');
  assert.equal((await readWatch(claimed)).due, false, 'a watch claimed while the hint was held off was made due again beside its claim');
  assert.equal(moved, 1);
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

// ── SESSION_JOB_NO_OUTPUT_FOR: a bg_run job's silence (predicateVersion 3) ──────────────────────────────

/**
 * The job leaf against the rows the runner's job reports keep. Every report below goes through the runner door's own
 * handlers — `takeoverLeases`, then `events` carrying `background_task` payloads shaped as runner-go's bgJob sends them —
 * so `running_bg_jobs` and `running_bg_job_activity` are written by the ingestion that writes them in production. No
 * case here writes either column itself: the silence a case decides is what the reports left plus the database's clock.
 */
const JOB = 'bgj_0a1b2c3d4e5f';
const quiet = (seconds: number, jobId?: string) => ({
  kind: 'ANY',
  over: 'ALL_TARGETS',
  leaf: 'SESSION_JOB_NO_OUTPUT_FOR',
  params: jobId === undefined ? { seconds } : { seconds, jobId },
});

/** A collaborator whose every method answers nothing: what the runner door would broadcast goes nowhere. */
const silentCollaborator = (): never =>
  new Proxy({}, { get: (_target, key) => (key === 'then' ? undefined : () => undefined) }) as never;

/** The `running` report runner-go's bgJob.runningPayload sends at launch and again once a minute while the job runs. */
const jobRunning = (id: string, idleMs?: number): Record<string, unknown> => ({
  shellId: id,
  toolUseId: id,
  status: 'running',
  kind: 'job',
  command: 'npm run soak',
  outputPath: `/root/.orbit/runs/job-leaf-spec/${id}.output`,
  ...(idleMs === undefined ? {} : { idleMs }),
});

/** A session parked while the jobs its runner hosts run on, and what that runner reports through the runner door. */
async function jobHost(prisma: PrismaClient) {
  const runner = { id: randomUUID() };
  await prisma.runner.create({
    data: { id: runner.id, name: 'the machine running the soak test', ownerId, tokenHash: sha256(`job-leaf-${runner.id}`) },
  });
  const sessionId = randomUUID();
  await prisma.session.create({
    data: {
      id: sessionId,
      ownerId,
      creatorId: ownerId,
      title: 'a session waiting on its job',
      prompt: 'run the soak test and tell me how it went',
      provider: 'claude',
      status: RunStatus.AWAITING_INPUT,
      dispatchOrigin: SessionDispatchOrigin.USER,
      startsTaskWork: false,
      assignedRunnerId: runner.id,
      numTurns: 1,
    },
  });
  const door = new RunnerApiController(
    prisma as never, silentCollaborator(), silentCollaborator(), silentCollaborator(), silentCollaborator(), silentCollaborator(),
  );
  const leaseOwner = randomUUID();
  await door.takeoverLeases(runner, sessionId, { leaseOwner, expectedLeaseOwner: null } as never);
  let seq = 0;
  const report = (...payloads: Array<Record<string, unknown>>) =>
    door.events(runner, sessionId, {
      leaseOwner,
      events: payloads.map((payload) => ({ type: RunEventType.BACKGROUND_TASK, payload, seq: ++seq, ts: new Date().toISOString() })),
    } as never);
  return {
    sessionId,
    /** The runner says the job is running and has written nothing for `seconds`. */
    quietFor: (id: string, seconds: number) => report(jobRunning(id, seconds * 1000)),
    /** A runner that predates idleMs says the job is running, and nothing about its output. */
    runningUnreported: (id: string) => report(jobRunning(id)),
    /** The job's terminal report (runner-go bgJob.endPayload). */
    ended: (id: string) =>
      report({ ...jobRunning(id), status: 'completed', summary: 'Background job completed (exit code 0)', output: 'soak passed', exitCode: 0 }),
    /** The two columns as the ingestion left them. */
    async columns(): Promise<{ jobs: string[]; activity: Record<string, number> }> {
      const { rows: [row] } = await sql.query<{ jobs: string[]; activity: Record<string, number> }>(
        `SELECT "running_bg_jobs" AS "jobs", "running_bg_job_activity" AS "activity" FROM "session" WHERE "id" = $1`,
        [sessionId],
      );
      return row;
    },
  };
}

/** A version-3 watch through the service POST /api/watches and the runner door create with: validated, read and decided at create. */
function createJobWatch(watches: WatchesService, sessionId: string, predicate: unknown, over: Record<string, unknown> = {}) {
  return watches.create(ownerId, {
    predicateVersion: 3,
    predicate,
    targets: [{ kind: 'SESSION', id: sessionId }],
    action: 'NOTIFY_USER',
    ...over,
  } as unknown as CreateWatchDto);
}

/** The contract code a refused create answered with. */
async function refusalOf(work: () => Promise<unknown>): Promise<string> {
  try {
    await work();
  } catch (error) {
    if (error instanceof BadRequestException || error instanceof ForbiddenException) {
      const body = error.getResponse() as { code?: string };
      if (body.code) return body.code;
    }
    throw error;
  }
  return assert.fail('the create was accepted');
}

/** A watch's schedule against the deadline the job's last reported output sets: that instant plus the window. */
async function jobSchedule(watchId: string, sessionId: string, jobId: string, seconds: number) {
  const { rows: [row] } = await sql.query<{ state: string; landed: boolean; due: boolean; atDeadline: boolean }>(
    `SELECT w."state", w."last_evaluated_at" IS NOT NULL AS "landed", w."next_evaluate_at" <= now() AS "due",
            abs(extract(epoch FROM w."next_evaluate_at"
                - (to_timestamp((s."running_bg_job_activity" ->> $3)::float8 / 1000) + make_interval(secs => $4)))) < 0.002 AS "atDeadline"
       FROM "watch" w, "session" s
      WHERE w."id" = $1 AND s."id" = $2`,
    [watchId, sessionId, jobId, seconds],
  );
  return row;
}

test('the job leaf decides its contract vectors from the rows the runner door writes, at create and in the evaluator alike', { skip, timeout: 120_000 }, async () => {
  const { prisma, evaluator } = replica();
  const watches = new WatchesService(prisma as unknown as PrismaService);
  const exercised: string[] = [];
  for (const vector of CONTRACT.vectors) {
    if (!('SESSION_JOB_NO_OUTPUT_FOR' in vector.expect)) continue;
    const expected = vector.expect.SESSION_JOB_NO_OUTPUT_FOR as boolean;
    const host = await jobHost(prisma);
    // A report places a job's last output at receivedAt - idleMs, so reporting `lastOutputSecondsAgo` of silence now
    // leaves the rows a report that came earlier, saying less, would have left: one instant, measured from on one clock.
    for (const job of vector.given.jobs as Array<{ id: string; lastOutputSecondsAgo: number | null }>) {
      if (job.lastOutputSecondsAgo === null) await host.runningUnreported(job.id);
      else await host.quietFor(job.id, job.lastOutputSecondsAgo);
    }
    for (const job of (vector.given.ended ?? []) as Array<{ id: string; lastOutputSecondsAgo: number }>) {
      await host.quietFor(job.id, job.lastOutputSecondsAgo);
      await host.ended(job.id);
    }
    const predicate = quiet(vector.given.params.seconds, vector.given.params.jobId);
    const created = await createJobWatch(watches, host.sessionId, predicate);
    assert.equal(created.state, expected ? 'MATCHED' : 'ACTIVE', `${vector.id}: decided at create`);
    const waiting = await insertWatch([{ kind: 'SESSION', id: host.sessionId }], predicate, { predicateVersion: 3 });
    assert.equal((await evaluator.evaluate(waiting)).outcome, expected ? 'MATCHED' : 'SCHEDULED', `${vector.id}: decided by the evaluator`);
    exercised.push(vector.id);
  }
  assert.ok(exercised.length >= 6, `only ${exercised.length} job vectors were driven: ${exercised.join(', ')}`);

  // The grammar it arrived in: a version-2 request naming it is refused, as the contract's vector says.
  const refusal = CONTRACT.vectors.find((v) => v.id === 'version-2-refuses-the-job-leaf')!;
  const host = await jobHost(prisma);
  assert.equal(
    await refusalOf(() => createJobWatch(watches, host.sessionId, refusal.given.predicate, { predicateVersion: refusal.given.predicateVersion })),
    refusal.expect.refusal,
  );
});

test('the job leaf holds once a job has been quiet past its window, and output that moves again ends it: a watch that waited through the silence does not match, and its deadline follows the new output', { skip, timeout: 120_000 }, async () => {
  const { prisma, evaluator } = replica();
  const watches = new WatchesService(prisma as unknown as PrismaService);
  const host = await jobHost(prisma);
  await host.quietFor(JOB, 400);
  const quietSince = (await host.columns()).activity[JOB];
  assert.equal(typeof quietSince, 'number', 'the fixture: the report recorded when the job last wrote');

  // Quiet past the window: a watch made now holds at once, by any job and by this one named.
  const anyJob = await createJobWatch(watches, host.sessionId, quiet(300));
  const named = await createJobWatch(watches, host.sessionId, quiet(300, JOB));
  assert.equal(anyJob.state, 'MATCHED', 'four hundred seconds of silence did not hold a three-hundred-second window');
  assert.equal(named.state, 'MATCHED');
  const [match] = await readMatches(anyJob.id);
  assert.equal(match.reason, 'ANY SESSION_JOB_NO_OUTPUT_FOR(300s) 1/1');
  const [target] = match.snapshot.targets as Array<Record<string, any>>;
  assert.deepEqual(target.leaves, { 'SESSION_JOB_NO_OUTPUT_FOR(300s)': true });
  assert.deepEqual(target.observed.jobs, [{ id: JOB, lastOutputAt: new Date(quietSince).toISOString() }]);
  const [namedMatch] = await readMatches(named.id);
  assert.equal(namedMatch.reason, `ANY SESSION_JOB_NO_OUTPUT_FOR(300s, ${JOB}) 1/1`);
  // What a wake carries is rebuilt through the allowlist: the job's id, its last output and the labels all pass whole.
  for (const recorded of [match, namedMatch]) {
    assert.equal(redactReason(recorded.reason), recorded.reason, 'the allowlist withheld the job leaf\'s reason');
    assert.deepEqual(redactSnapshot(recorded.snapshot), recorded.snapshot, 'the allowlist withheld part of the job leaf\'s snapshot');
  }
  // A predicate that does not ask about jobs records none of them.
  const settled = await createJobWatch(watches, host.sessionId, any('SESSION_TURN_SETTLED'), { predicateVersion: 1 });
  const [settledMatch] = await readMatches(settled.id);
  assert.equal('jobs' in (settledMatch.snapshot.targets[0] as Record<string, any>).observed, false, 'a status watch recorded the jobs');

  // A watch that was waiting through that silence, and has not been looked at again since.
  const waiting = await insertWatch([{ kind: 'SESSION', id: host.sessionId }], quiet(300), { predicateVersion: 3 });
  // The job writes, and the runner's next report says so.
  await host.quietFor(JOB, 2);
  const movedTo = (await host.columns()).activity[JOB];
  assert.ok(movedTo - quietSince >= 397_000, `the fixture: the report moved the last output forward by ${movedTo - quietSince}ms`);

  assert.equal((await evaluator.evaluate(waiting)).outcome, 'SCHEDULED');
  assert.equal((await readMatches(waiting)).length, 0, 'output that moved again still ended in a Match');
  assert.deepEqual(await readTargets(waiting), { [host.sessionId]: 'OBSERVED' });
  assert.equal((await jobSchedule(waiting, host.sessionId, JOB, 300)).atDeadline, true,
    'the watch was not scheduled at the deadline the new output set');
  assert.equal((await createJobWatch(watches, host.sessionId, quiet(300))).state, 'ACTIVE', 'a watch made after the output moved held at create');
});

test('a runner that stops reporting is heard as silence: the deadline its last report set arrives on the database\'s clock, and the one loop matches it with no event', { skip, timeout: 120_000 }, async () => {
  // Every hint this replica's hub publishes is dropped, and none would come anyway: the runner door here broadcasts
  // nothing, and a job report is no hint. Only `next_evaluate_at` can bring the watch back.
  const { prisma, evaluator } = replica({ pollIntervalMs: 200 }, (client) => new DroppingRealtime(client));
  const host = await jobHost(prisma);
  // The runner's last word: the job has written nothing for 297 seconds, three short of the window. Then it says
  // nothing more — crashed, cut off, asleep — and the session stays parked, as the reaper leaves a parked one.
  await host.quietFor(JOB, 297);
  const lastReported = await host.columns();
  const watchId = await insertWatch([{ kind: 'SESSION', id: host.sessionId }], quiet(300, JOB), { predicateVersion: 3 });

  evaluator.start();
  const first = await eventually('its first evaluation', () => jobSchedule(watchId, host.sessionId, JOB, 300), (row) => row.landed);
  assert.equal(first.state, 'ACTIVE', 'the watch held before its window had passed');
  assert.equal(first.atDeadline, true, 'the watch was not scheduled at the deadline the last report set: its next look is the sweep an hour out');
  assert.equal(first.due, false);

  await eventually('the silence to reach its window', () => readWatch(watchId), (w) => w.state === 'MATCHED', 30_000);
  const [match] = await readMatches(watchId);
  assert.equal(match.reason, `ANY SESSION_JOB_NO_OUTPUT_FOR(300s, ${JOB}) 1/1`);
  const { rows: [timing] } = await sql.query<{ late: number }>(
    `SELECT extract(epoch FROM m."matched_at"
              - (to_timestamp((s."running_bg_job_activity" ->> $3)::float8 / 1000) + interval '300 seconds'))::float8 AS "late"
       FROM "watch_match" m, "session" s WHERE m."watch_id" = $1 AND s."id" = $2`,
    [watchId, host.sessionId, JOB],
  );
  assert.ok(timing.late >= 0, `matched ${-timing.late}s before the silence reached its window`);
  assert.ok(timing.late < 5, `matched ${timing.late}s after its deadline, on a 200ms poll`);
  assert.deepEqual(await host.columns(), lastReported, 'something wrote the job columns after the runner\'s last report');
  assert.equal(await sessionStatus(host.sessionId), 'AWAITING_INPUT');
});

test('a job that ended is not quiet: the leaf does not hold, no deadline is scheduled for it, the watch waits for its TTL, and ANY_OF with SESSION_RUN_TERMINAL hears the run end', { skip, timeout: 60_000 }, async () => {
  const { prisma, evaluator } = replica();
  const host = await jobHost(prisma);
  await host.quietFor(JOB, 400);
  await host.ended(JOB);
  assert.deepEqual(await host.columns(), { jobs: [], activity: {} }, 'the fixture: the terminal report took the job out of both columns');

  const alone = await insertWatch([{ kind: 'SESSION', id: host.sessionId }], quiet(300, JOB), { predicateVersion: 3, ttlMs: 2_000 });
  assert.equal((await evaluator.evaluate(alone)).outcome, 'SCHEDULED');
  assert.equal((await readWatch(alone)).atExpiry, true, 'an ended job scheduled a deadline: the watch has nothing to wait for but its TTL');
  await eventually('its TTL', async () => {
    await evaluator.evaluate(alone);
    return readWatch(alone);
  }, (w) => w.state === 'EXPIRED', 10_000);
  assert.equal((await readMatches(alone)).length, 0, 'an ended job matched a silence leaf');

  const eitherWay = await insertWatch(
    [{ kind: 'SESSION', id: host.sessionId }],
    { kind: 'ANY_OF', operands: [quiet(300, JOB), any('SESSION_RUN_TERMINAL')] },
    { predicateVersion: 3 },
  );
  assert.equal((await evaluator.evaluate(eitherWay)).outcome, 'SCHEDULED');
  await sql.query(`UPDATE "session" SET "status" = 'SUCCEEDED' WHERE "id" = $1`, [host.sessionId]);
  assert.equal((await evaluator.evaluate(eitherWay)).outcome, 'MATCHED');
  const [match] = await readMatches(eitherWay);
  assert.equal(match.reason, `ANY_OF(ANY SESSION_JOB_NO_OUTPUT_FOR(300s, ${JOB}) 0/1, ANY SESSION_RUN_TERMINAL 1/1)`);
  assert.equal(redactReason(match.reason), match.reason);
});

test('the job leaf is checked where a watch is created: its version, its window, its job id, its keys and its target kind, and a refused create writes nothing', { skip, timeout: 60_000 }, async () => {
  const { prisma } = replica();
  const watches = new WatchesService(prisma as unknown as PrismaService);
  const host = await jobHost(prisma);
  const task = await insertTask('OPEN');
  const count = async () => {
    const { rows: [{ n }] } = await sql.query<{ n: number }>(`SELECT count(*)::int AS "n" FROM "watch" WHERE "owner_id" = $1`, [ownerId]);
    return n;
  };
  const before = await count();
  const refused: Array<[string, Record<string, unknown>, string]> = [
    ['under version 2', { predicateVersion: 2 }, 'UNKNOWN_PREDICATE_KIND'],
    ['under a version this build does not serve', { predicateVersion: 4 }, 'PREDICATE_VERSION_UNSUPPORTED'],
    ['a window under the minimum', { predicate: quiet(WATCH_LIMITS.minNoOutputSeconds - 1) }, 'PREDICATE_PARAMETER_INVALID'],
    ['a window past the longest TTL', { predicate: quiet(WATCH_LIMITS.maxTtlSeconds + 1) }, 'PREDICATE_PARAMETER_INVALID'],
    ['a fractional window', { predicate: quiet(300.5) }, 'PREDICATE_PARAMETER_INVALID'],
    ['no params', { predicate: { kind: 'ANY', over: 'ALL_TARGETS', leaf: 'SESSION_JOB_NO_OUTPUT_FOR' } }, 'PREDICATE_PARAMETER_INVALID'],
    ['a job id that is a command', { predicate: quiet(300, 'bgj_1; rm -rf /') }, 'PREDICATE_PARAMETER_INVALID'],
    ['an id bg_run never hands out', { predicate: quiet(300, 'toolu_01EngineOwnedShell') }, 'PREDICATE_PARAMETER_INVALID'],
    ['a command beside the window', { predicate: { ...quiet(300), params: { seconds: 300, command: 'tail -f build.log' } } }, 'PREDICATE_PARAMETER_INVALID'],
    ['a task target', { targets: [{ kind: 'TASK', id: task }] }, 'TARGET_KIND_MISMATCH'],
  ];
  for (const [why, over, code] of refused) {
    assert.equal(await refusalOf(() => createJobWatch(watches, host.sessionId, quiet(300), over)), code, why);
  }
  assert.equal(await count(), before, 'a refused create wrote a watch');
  // The paired positive: the shortest window, one job named.
  const accepted = await createJobWatch(watches, host.sessionId, quiet(WATCH_LIMITS.minNoOutputSeconds, JOB));
  assert.equal(accepted.state, 'ACTIVE');
  assert.equal(accepted.predicateVersion, 3);
});

async function sessionStatus(sessionId: string): Promise<string> {
  const { rows: [row] } = await sql.query<{ status: string }>(`SELECT "status"::text AS "status" FROM "session" WHERE "id" = $1`, [sessionId]);
  return row.status;
}
