/**
 * Watch P3 against a real PostgreSQL (docs/watch-contract.md §12): structured progress and its revisions,
 * the lifecycle epoch a reopened Task starts, stalls decided by the evaluator's one schedule, quorums over
 * the sealed target set, and CONTINUOUS watches that fold a burst of crossings into one Match and one wake
 * per debounce window, within a wake budget.
 *
 *     bash scripts/run-pg-spec.sh src/apiserver/src/watches/watch-advanced.pg.spec.ts
 *
 * `WATCH_ADVANCED_ONLY=A3,A4` registers only those cases: run-pg-spec strips `--test-name-pattern`, and a
 * skip there is red, so a case left out is never registered rather than skipped.
 *
 * What is under test is mostly about what may NOT decide a watch — a message, a transcript, a timer of a
 * watch's own, a burst of hints — so every "nothing happened" here is paired with the same fixture made to
 * produce the thing, and the timer probe proves it can see a timer before it is believed about none.
 *
 * Non-destructive: every row carries an id this run generated. Each case first retires the live watches and
 * pending deliveries earlier cases left, so a loop started in it claims only that case's rows.
 */
import assert from 'node:assert/strict';
import { createHook } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { after, before, beforeEach, test } from 'node:test';

import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  type INestApplication,
  Module,
  NotFoundException,
  ValidationPipe,
} from '@nestjs/common';
import { NestFactory, Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import type { PrismaClient } from '@prisma/client';
import {
  NormalizedRunEvent,
  TASK_PROGRESS_LIMITS,
  toUuid,
  WATCH_LEAF_SINCE_VERSION,
  WATCH_LIMITS,
  WATCH_PREDICATE_VERSIONS,
  WATCH_REFUSAL_CODES,
} from '@orbit/shared';
import { Client } from 'pg';
import { filter, Observable, tap } from 'rxjs';

import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PublicIdInterceptor } from '../common/public-id.interceptor';
import { prismaClientFor } from '../prisma/prisma-client';
import { PrismaService } from '../prisma/prisma.service';
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from '../projects/coordinator-pg-test-safety';
import type { PushService } from '../push/push.service';
import { RealtimeService } from '../realtime/realtime.service';
import { SessionsService } from '../sessions/sessions.service';
import { TaskProgressController } from '../tasks/task-progress.controller';
import { TaskProgressService } from '../tasks/task-progress.service';
import type { CreateWatchDto } from './dto';
import { WatchDeliveryService } from './watch-delivery.service';
import { WatchEvaluatorOptions, WatchEvaluatorService } from './watch-evaluator.service';
import { WATCH_LEAF_SINCE_VERSION as EVALUATED_SINCE_VERSION } from './watch-predicate';
import { WatchesService } from './watches.service';

const URL = process.env.COORDINATOR_PG_URL;
const skip = !URL;

const HOUR = 60 * 60 * 1000;
/** A call site inside the Watch evaluator's own modules, as a stack frame names it. */
const WATCH_CODE = /[\\/]watches[\\/]watch-(?:evaluator\.service|evaluator\.module|predicate)\.js:/;

// From build/watches back to the repository root, and to the apiserver's sources.
const API = path.resolve(__dirname, '../..');
const CONTRACT = JSON.parse(
  readFileSync(path.resolve(__dirname, '../../../../contracts/watch.contract.json'), 'utf8'),
) as Record<string, any>;

const ONLY = new Set((process.env.WATCH_ADVANCED_ONLY ?? '').split(',').map((id) => id.trim()).filter(Boolean));

/** Register a case unless WATCH_ADVANCED_ONLY names others. Never a skip: run-pg-spec counts one as red. */
function scenario(id: string, name: string, timeout: number, body: () => Promise<void>): void {
  if (ONLY.size > 0 && !ONLY.has(id)) return;
  test(`${id} ${name}`, { skip, timeout }, body);
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const silentPush = {
  scheduleBadgeSync: () => undefined,
  notifySessionSettled: async () => undefined,
  notifyWatchMatched: async () => undefined,
} as unknown as PushService;

/** A replica's realtime hub, minus the cross-replica LISTEN connection: publishing works as in production. */
class LocalRealtime extends RealtimeService {
  constructor(prisma: PrismaClient) {
    super(prisma as unknown as PrismaService, silentPush);
  }

  override async onModuleInit(): Promise<void> {}
}

/** A hub that publishes every event and lets none reach an in-process consumer: the lost hint, on purpose. */
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
  await quiesce();
  await sql.query(
    `UPDATE "watch" SET "state" = 'CANCELLED', "next_evaluate_at" = NULL,
            "window_opened_at" = NULL, "window_closes_at" = NULL, "window_crossings" = 0
      WHERE "state" IN ('ACTIVE', 'PAUSED')`,
  );
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
  if (http) {
    const { app, prisma } = await http;
    await app.close().catch(() => undefined);
    await prisma.$disconnect().catch(() => undefined);
  }
  await sql?.end().catch(() => undefined);
});

/** Stop every loop a case started, then close its pools: a later case never runs on an earlier one's connections. */
async function quiesce(): Promise<void> {
  for (const handle of running.splice(0)) await handle.stop();
  for (const client of clients.splice(0)) await client.$disconnect().catch(() => undefined);
}

// ── the harness ────────────────────────────────────────────────────────────────────────────────

interface Stack {
  prisma: PrismaClient;
  realtime: LocalRealtime;
  progress: TaskProgressService;
  watches: WatchesService;
  evaluator: WatchEvaluatorService;
}

/** One replica: its pool, its hub, the report door, the watch service and an evaluator nothing moves unless the case says how often. */
function stack(options: WatchEvaluatorOptions = {}, Hub: typeof LocalRealtime = LocalRealtime): Stack {
  const prisma = prismaClientFor(URL!);
  clients.push(prisma);
  const realtime = new Hub(prisma);
  const evaluator = new WatchEvaluatorService(prisma as unknown as PrismaService, realtime, {
    reconcileIntervalMs: HOUR,
    pollIntervalMs: HOUR,
    ...options,
  });
  running.push(evaluator);
  return {
    prisma,
    realtime,
    evaluator,
    progress: new TaskProgressService(prisma as unknown as PrismaService, realtime),
    watches: new WatchesService(prisma as unknown as PrismaService),
  };
}

/** The real sessions service, with what it tells the rest of the system recorded nowhere. */
function sessionsFor(prisma: PrismaClient): SessionsService {
  const queue = { notifySessionQueued: () => undefined };
  const hub = { notifyInbox: () => undefined, publishQueuedTurnsChanged: () => undefined };
  return new SessionsService(prisma as unknown as PrismaService, queue as never, hub as never);
}

/** A delivery worker turning Matches into turns through the normal queue entry point. */
function deliveryWorker(prisma: PrismaClient): WatchDeliveryService {
  const worker = new WatchDeliveryService(prisma as unknown as PrismaService, sessionsFor(prisma), silentPush, {
    retryBaseMs: 0,
    retryMaxMs: 0,
    pollIntervalMs: 200,
  });
  running.push(worker);
  return worker;
}

interface Http {
  base: string;
  app: INestApplication;
  prisma: PrismaClient;
  bearers: Map<string, string>;
}

let http: Promise<Http> | undefined;

/** The report door over real HTTP: the real controller, pipe, guard and public-id interceptor, with a bearer per account. */
function bootHttp(): Promise<Http> {
  http ??= (async () => {
    const prisma = prismaClientFor(URL!);
    const bearers = new Map<string, string>();

    @Module({
      controllers: [TaskProgressController],
      providers: [
        { provide: TaskProgressService, useValue: new TaskProgressService(prisma as unknown as PrismaService) },
        JwtAuthGuard,
        Reflector,
        {
          provide: JwtService,
          useValue: {
            verifyAsync: async (token: string) => {
              const sub = bearers.get(token);
              if (!sub) throw new Error('not a bearer this run issued');
              return { sub };
            },
          },
        },
      ],
    })
    class ProgressApiModule {}

    const app = await NestFactory.create(ProgressApiModule, { logger: false, abortOnError: false });
    app.setGlobalPrefix('api');
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: false }));
    app.useGlobalInterceptors(new PublicIdInterceptor());
    await app.listen(0, '127.0.0.1');
    return { base: await app.getUrl(), app, prisma, bearers };
  })();
  return http;
}

function bearerFor(h: Http, account: string): string {
  const bearer = `bearer-${account}`;
  h.bearers.set(bearer, account);
  return bearer;
}

async function call(h: Http, bearer: string, method: string, route: string, body?: unknown): Promise<{ status: number; body: any }> {
  const response = await fetch(`${h.base}/api${route}`, {
    method,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${bearer}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

// ── fixtures ───────────────────────────────────────────────────────────────────────────────────

async function insertUser(): Promise<string> {
  const id = randomUUID();
  await sql.query(
    `INSERT INTO "user"("id","email","name","password_hash") VALUES ($1,$2,'watch advanced','h')`,
    [id, `${id}@watch-advanced.invalid`],
  );
  return id;
}

async function insertTask(status: string, owner = ownerId): Promise<string> {
  const id = randomUUID();
  await sql.query(
    `INSERT INTO "task"("id","title","owner_id","creator_type","creator_id","updated_at","completion_criterion","status")
     VALUES ($1,'progressing work',$2,'USER',$2,now(),'EVIDENCE_JUDGMENT',$3)`,
    [id, owner, status],
  );
  return id;
}

async function setStatus(taskId: string, status: string): Promise<void> {
  await sql.query(`UPDATE "task" SET "status" = $2 WHERE "id" = $1`, [taskId, status]);
}

async function insertRunner(): Promise<string> {
  const id = randomUUID();
  await sql.query(
    `INSERT INTO "runner"("id","name","owner_id","token_hash","status","last_heartbeat_at","capabilities")
     VALUES ($1,'watch advanced',$2,'h','ONLINE',clock_timestamp(),'{}'::text[])`,
    [id, ownerId],
  );
  return id;
}

/** A session that has run and is waiting for its next turn on an online runner: one a wake can reach. */
async function insertObserver(runnerId: string): Promise<string> {
  const id = randomUUID();
  await sql.query(
    `INSERT INTO "session"("id","title","prompt","owner_id","creator_id","updated_at","status","assigned_runner_id",
                           "provider","provider_builtin","num_turns","started_at","runtime_session_id")
     VALUES ($1,'watch observer','the opening prompt',$2,$2,now(),'AWAITING_INPUT',$3,'claude',TRUE,1,now(),$4)`,
    [id, ownerId, runnerId, `runtime-${id}`],
  );
  return id;
}

/** A watch row as creation leaves it, in one statement with its targets, for cases that drive the evaluator alone. */
async function insertWatchRow(
  targets: string[],
  predicate: unknown,
  over: { version?: number; mode?: string; debounce?: number | null; budget?: number | null } = {},
): Promise<string> {
  const id = randomUUID();
  await sql.query(
    `WITH "created" AS (
       INSERT INTO "watch"("id","owner_id","observer_type","predicate","predicate_version","mode","debounce_seconds",
                           "wake_budget","action","state","expires_at","next_evaluate_at")
       VALUES ($1,$2,'USER',$3::jsonb,$4,$5,$6,$7,'NOTIFY_USER','ACTIVE',now() + interval '1 hour',now())
       RETURNING "id"
     )
     INSERT INTO "watch_target"("id","watch_id","target_kind","target_resource_id")
     SELECT "target"."id", "created"."id", 'TASK', "target"."resource_id"
       FROM "created", unnest($8::uuid[], $9::uuid[]) AS "target"("id", "resource_id")`,
    [id, ownerId, JSON.stringify(predicate), over.version ?? 2, over.mode ?? 'ONE_SHOT', over.debounce ?? null,
      over.budget ?? null, targets.map(() => randomUUID()), targets],
  );
  return id;
}

const tasks = (ids: string[]) => ids.map((id) => ({ kind: 'TASK', id }));
const term = (kind: string, leaf: string, params?: unknown) => ({ kind, over: 'ALL_TARGETS', leaf, ...(params ? { params } : {}) });
const stallFor = (seconds: number) => term('ANY', 'TASK_NO_PROGRESS_FOR', { seconds });
const reached = (params: unknown) => term('ANY', 'TASK_PROGRESS_AT_LEAST', params);

function createWatch(s: Stack, body: Record<string, unknown>) {
  return s.watches.create(ownerId, { predicateVersion: 2, action: 'NOTIFY_USER', ...body } as unknown as CreateWatchDto);
}

/** The contract code a refused request answered with. */
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
  return assert.fail('the request was accepted');
}

/** The body of a 409 the report door answered with. */
async function conflictOf(work: () => Promise<unknown>): Promise<Record<string, any>> {
  try {
    await work();
  } catch (error) {
    if (error instanceof ConflictException) return error.getResponse() as Record<string, any>;
    throw error;
  }
  return assert.fail('the report was accepted');
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

interface WatchRead {
  state: string;
  generation: number;
  holding: boolean;
  windowOpen: boolean;
  windowCrossings: number;
  scheduled: boolean;
  landed: boolean;
  due: boolean | null;
  atWindowClose: boolean | null;
}

async function readWatch(id: string): Promise<WatchRead> {
  const { rows } = await sql.query<WatchRead>(
    `SELECT "state", "generation", "holding", "window_opened_at" IS NOT NULL AS "windowOpen",
            "window_crossings" AS "windowCrossings", "next_evaluate_at" IS NOT NULL AS "scheduled",
            "last_evaluated_at" > "created_at" AS "landed", "next_evaluate_at" <= now() AS "due",
            abs(extract(epoch FROM "next_evaluate_at" - "window_closes_at")) < 0.002 AS "atWindowClose"
       FROM "watch" WHERE "id" = $1`,
    [id],
  );
  return rows[0];
}

interface MatchRead {
  generation: number;
  reason: string;
  snapshot: Record<string, any>;
}

async function readMatches(id: string): Promise<MatchRead[]> {
  const { rows } = await sql.query<MatchRead>(
    `SELECT "generation", "reason", "per_target_snapshot" AS "snapshot"
       FROM "watch_match" WHERE "watch_id" = $1 ORDER BY "generation"`,
    [id],
  );
  return rows;
}

async function deliveriesOf(id: string): Promise<string[]> {
  const { rows } = await sql.query<{ state: string }>(
    `SELECT d."state" FROM "watch_delivery" d JOIN "watch_match" m ON m."id" = d."match_id"
      WHERE m."watch_id" = $1 ORDER BY m."generation"`,
    [id],
  );
  return rows.map((row) => row.state);
}

async function targetsOf(id: string): Promise<Record<string, { state: string; epoch: number }>> {
  const { rows } = await sql.query<{ id: string; state: string; epoch: number }>(
    `SELECT "target_resource_id" AS "id", "state", "target_epoch" AS "epoch" FROM "watch_target" WHERE "watch_id" = $1`,
    [id],
  );
  return Object.fromEntries(rows.map((row) => [row.id, { state: row.state, epoch: row.epoch }]));
}

/** A window's close is a row value: this moves it to now, so a case that is not about waiting does not spend the debounce. */
async function closeWindow(id: string): Promise<void> {
  const { rowCount } = await sql.query(
    `UPDATE "watch" SET "window_closes_at" = now(), "next_evaluate_at" = now()
      WHERE "id" = $1 AND "window_closes_at" IS NOT NULL`,
    [id],
  );
  assert.equal(rowCount, 1, 'there was no open window to close');
}

// ── A0: the vocabulary ─────────────────────────────────────────────────────────────────────────

scenario('A0', 'the served vocabulary and the database hold what the contract says: versions, leaves, codes and limits', 60_000, async () => {
  assert.deepEqual([...WATCH_PREDICATE_VERSIONS], CONTRACT.servedPredicateVersions);
  for (const [leaf, since] of Object.entries(WATCH_LEAF_SINCE_VERSION)) {
    assert.equal(since, CONTRACT.leaves[leaf].sinceVersion ?? 1, `${leaf} arrives in the version the contract says`);
  }
  // The door and the evaluator read one grammar.
  assert.deepEqual(EVALUATED_SINCE_VERSION, WATCH_LEAF_SINCE_VERSION);
  assert.deepEqual(CONTRACT.aggregations, ['ALL', 'ANY', 'AT_LEAST']);
  for (const code of ['PREDICATE_PARAMETER_INVALID', 'CONTINUOUS_POLICY_INVALID']) {
    assert.ok((WATCH_REFUSAL_CODES as readonly string[]).includes(code), `${code} is not served`);
  }
  assert.deepEqual({ ...TASK_PROGRESS_LIMITS }, CONTRACT.progress.limits);

  // The same bounds, as the database's own CHECKs print them.
  const { rows } = await sql.query<{ name: string; def: string }>(
    `SELECT c.conname AS "name", pg_get_constraintdef(c.oid) AS "def"
       FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid
      WHERE t.relname IN ('watch', 'task_progress') AND c.contype = 'c'`,
  );
  const defs = new Map(rows.map((row) => [row.name, row.def]));
  const bounds: Array<[string, number, number]> = [
    ['watch_debounce_range_chk', WATCH_LIMITS.continuousDebounceSeconds, WATCH_LIMITS.maxContinuousDebounceSeconds],
    ['watch_wake_budget_range_chk', 1, WATCH_LIMITS.maxContinuousWakeBudget],
    ['task_progress_phase_chk', 1, TASK_PROGRESS_LIMITS.maxPhaseChars],
    ['task_progress_message_chk', 1, TASK_PROGRESS_LIMITS.maxMessageChars],
  ];
  for (const [name, min, max] of bounds) {
    assert.match(defs.get(name) ?? '', new RegExp(`>= ${min}\\b[\\s\\S]*<= ${max}\\b`), `${name} does not hold [${min}, ${max}]`);
  }
  const { rows: triggers } = await sql.query<{ event: string }>(
    `SELECT pg_get_triggerdef(t.oid) AS "event" FROM pg_trigger t
      WHERE NOT t.tgisinternal AND t.tgname = 'task_progress_epoch_advance'`,
  );
  assert.equal(triggers.length, 1, 'the reopen trigger is not installed');
  assert.match(triggers[0].event, /AFTER UPDATE OF status ON public\.task/u);
});

// ── A1: a progress report is a structured revision ────────────────────────────────────────────

scenario('A1', 'a progress report is a structured revision: phase, current, total, message, revision and lastProgressAt, and only a changed position is progress', 120_000, async () => {
  const s = stack();
  const task = await insertTask('IN_PROGRESS');

  const empty = await s.progress.get(ownerId, task);
  const { rows: [created] } = await sql.query<{ at: Date }>(
    `SELECT "created_at" AT TIME ZONE 'UTC' AS "at" FROM "task" WHERE "id" = $1`, [task]);
  assert.deepEqual(empty, {
    taskId: task, lifecycleEpoch: 0, epochStartedAt: created.at.toISOString(),
    phase: null, current: null, total: null, message: null, revision: 0, lastProgressAt: null, updatedAt: null,
  }, 'a task that never reported is in epoch 0, begun at its creation, with nothing in it');

  const first = await s.progress.report(ownerId, task, { phase: 'build', current: 1, total: 4, message: 'compiling' });
  assert.deepEqual(
    { phase: first.phase, current: first.current, total: first.total, message: first.message, revision: first.revision,
      changed: first.changed, progressed: first.progressed },
    { phase: 'build', current: 1, total: 4, message: 'compiling', revision: 1, changed: true, progressed: true },
  );
  assert.ok(first.lastProgressAt, 'a first position has a time');

  // The same report again is neither a change nor progress, and writes nothing.
  const repeated = await s.progress.report(ownerId, task, { phase: 'build', current: 1, total: 4, message: 'compiling' });
  assert.deepEqual(
    { changed: repeated.changed, progressed: repeated.progressed, revision: repeated.revision, at: repeated.lastProgressAt, updated: repeated.updatedAt },
    { changed: false, progressed: false, revision: 1, at: first.lastProgressAt, updated: first.updatedAt },
  );

  // A message alone is a change, never progress; the fields it does not name are kept.
  await sleep(5);
  const narrated = await s.progress.report(ownerId, task, { message: 'still compiling, nearly there' });
  assert.deepEqual(
    { phase: narrated.phase, current: narrated.current, total: narrated.total, message: narrated.message,
      revision: narrated.revision, changed: narrated.changed, progressed: narrated.progressed, at: narrated.lastProgressAt },
    { phase: 'build', current: 1, total: 4, message: 'still compiling, nearly there', revision: 2, changed: true, progressed: false,
      at: first.lastProgressAt },
  );

  // A moved position is progress, and it moves lastProgressAt.
  await sleep(5);
  const advanced = await s.progress.report(ownerId, task, { current: 2 });
  assert.deepEqual(
    { phase: advanced.phase, current: advanced.current, total: advanced.total, revision: advanced.revision, progressed: advanced.progressed },
    { phase: 'build', current: 2, total: 4, revision: 3, progressed: true },
  );
  assert.ok(Date.parse(advanced.lastProgressAt!) > Date.parse(first.lastProgressAt!), 'progress did not move lastProgressAt');

  // expectedRevision is a compare-and-set.
  const stale = await conflictOf(() => s.progress.report(ownerId, task, { current: 3, expectedRevision: 2 }));
  assert.deepEqual({ code: stale.code, revision: stale.revision, epoch: stale.lifecycleEpoch }, { code: 'PROGRESS_REVISION_CONFLICT', revision: 3, epoch: 0 });
  assert.equal((await s.progress.report(ownerId, task, { current: 3, expectedRevision: 3 })).revision, 4);

  // What a report may not leave behind is refused, and a refused report writes nothing.
  const refused: Array<[string, Record<string, unknown>]> = [
    ['a count past its total', { current: 5 }],
    ['a negative count', { current: -1 }],
    ['a count that is not an integer', { current: 2.5 }],
    ['an empty phase', { phase: '' }],
    ['a phase over its limit', { phase: 'p'.repeat(TASK_PROGRESS_LIMITS.maxPhaseChars + 1) }],
    ['a message over its limit', { message: 'm'.repeat(TASK_PROGRESS_LIMITS.maxMessageChars + 1) }],
    ['a total left with no count', { current: null }],
    ['no position left at all', { phase: null, current: null, total: null }],
    ['a revision that is not an integer', { current: 3, expectedRevision: 1.5 }],
  ];
  for (const [why, report] of refused) {
    await assert.rejects(s.progress.report(ownerId, task, report), BadRequestException, why);
  }
  const unchanged = await s.progress.get(ownerId, task);
  assert.deepEqual({ revision: unchanged.revision, current: unchanged.current }, { revision: 4, current: 3 }, 'a refused report wrote');

  // Somebody else's task reads as missing, and a task with a conclusion makes no progress.
  await assert.rejects(s.progress.report(otherOwnerId, task, { current: 1 }), NotFoundException);
  await assert.rejects(s.progress.get(otherOwnerId, task), NotFoundException);
  const failed = await insertTask('FAILED');
  assert.equal((await conflictOf(() => s.progress.report(ownerId, failed, { current: 1 }))).code, 'TASK_NOT_OPEN');
  assert.equal((await sql.query(`SELECT 1 FROM "task_progress" WHERE "task_id" = $1`, [failed])).rowCount, 0);

  // The database holds the same shape for a writer that is not the door.
  await assert.rejects(sql.query(`UPDATE "task_progress" SET "current" = 9 WHERE "task_id" = $1`, [task]), /task_progress_total_chk/);
  await assert.rejects(
    sql.query(`UPDATE "task_progress" SET "message" = repeat('m', 501) WHERE "task_id" = $1`, [task]),
    /task_progress_message_chk/,
  );
  await assert.rejects(
    sql.query(`UPDATE "task_progress" SET "phase" = NULL, "current" = NULL, "total" = NULL WHERE "task_id" = $1`, [task]),
    /task_progress_position_chk/,
  );

  // The same door over HTTP.
  const h = await bootHttp();
  const bearer = bearerFor(h, ownerId);
  const read = await call(h, bearer, 'GET', `/tasks/${task}/progress`);
  assert.equal(read.status, 200, JSON.stringify(read.body));
  assert.equal(toUuid(read.body.taskId), task);
  assert.deepEqual({ revision: read.body.revision, phase: read.body.phase, current: read.body.current, total: read.body.total },
    { revision: 4, phase: 'build', current: 3, total: 4 });
  const posted = await call(h, bearer, 'POST', `/tasks/${task}/progress`, { phase: 'test', current: 4, expectedRevision: 4 });
  assert.equal(posted.status, 200, JSON.stringify(posted.body));
  assert.deepEqual({ revision: posted.body.revision, phase: posted.body.phase, progressed: posted.body.progressed },
    { revision: 5, phase: 'test', progressed: true });
  assert.equal((await call(h, bearer, 'POST', `/tasks/${task}/progress`, { current: '4' })).status, 400, 'a count as text');
  const clash = await call(h, bearer, 'POST', `/tasks/${task}/progress`, { current: 4, expectedRevision: 1 });
  assert.equal(clash.status, 409);
  assert.equal(clash.body.code, 'PROGRESS_REVISION_CONFLICT');
  assert.equal((await call(h, bearerFor(h, otherOwnerId), 'GET', `/tasks/${task}/progress`)).status, 404);
});

// ── A2: progress is only what the report door states ──────────────────────────────────────────

scenario('A2', 'progress is only what the report door states: text in a turn, a comment or a message reaches no threshold, and only the door and the reopen trigger write task_progress', 120_000, async () => {
  const s = stack();
  const task = await insertTask('IN_PROGRESS');
  const watch = await createWatch(s, { predicate: reached({ percent: 90 }), targets: tasks([task]) });
  assert.equal(watch.state, 'ACTIVE');

  // Ninety per cent, claimed in every channel that is text: the report's message, a comment, a turn.
  await s.progress.report(ownerId, task, { phase: 'files', current: 1, total: 10, message: '90% done: 9 of 10 files, practically finished' });
  await sql.query(
    `INSERT INTO "task_comment"("id","task_id","author_type","author_id","body") VALUES ($1,$2,'USER',$3,'progress: 9/10 (90%)')`,
    [randomUUID(), task, ownerId],
  );
  const session = await insertObserver(await insertRunner());
  await sessionsFor(s.prisma).createTurn(ownerId, session, {
    clientTurnId: `progress-claim-${randomUUID()}`,
    content: 'Status update: 90% complete, 9/10 files migrated. $ ./migrate --all\n[##########------] 90%',
    intent: 'NEXT_TURN',
  } as never);
  assert.equal((await s.evaluator.evaluate(watch.id)).outcome, 'SCHEDULED', 'text reached a threshold');
  const still = await s.progress.get(ownerId, task);
  assert.deepEqual({ current: still.current, total: still.total, revision: still.revision }, { current: 1, total: 10, revision: 1 });

  // The paired positive: the same claim, stated as numbers through the door, reaches it.
  await s.progress.report(ownerId, task, { current: 9 });
  assert.equal((await s.evaluator.evaluate(watch.id)).outcome, 'MATCHED');
  const [match] = await readMatches(watch.id);
  assert.equal(match.reason, 'ANY TASK_PROGRESS_AT_LEAST(90%) 1/1');
  const [observed] = match.snapshot.targets;
  assert.deepEqual(observed.leaves, { 'TASK_PROGRESS_AT_LEAST(90%)': true });
  assert.deepEqual(
    { status: observed.observed.status, phase: observed.observed.progress.phase, current: observed.observed.progress.current, total: observed.observed.progress.total },
    { status: 'IN_PROGRESS', phase: 'files', current: 9, total: 10 },
  );
  assert.equal(JSON.stringify(match.snapshot).includes('practically finished'), false, 'a message reached a Match snapshot');

  // The contract's vectors for the version-2 leaves, decided from rows written the way the door writes them.
  const exercised = new Set<string>();
  for (const vector of CONTRACT.vectors as Array<Record<string, any>>) {
    const expectations = Object.entries(vector.expect).filter(([key]) => CONTRACT.leaves[key]?.sinceVersion === 2);
    if (expectations.length === 0) continue;
    const target = await insertTask(vector.given.task.status);
    const progress = vector.given.progress;
    await sql.query(
      `INSERT INTO "task_progress"("task_id","current","total","message","revision","last_progress_at")
       VALUES ($1,$2,$3,$4,1,now() - make_interval(secs => $5))`,
      [target, progress.current, progress.total ?? null, progress.message ?? null, progress.lastProgressSecondsAgo ?? 0],
    );
    for (const [leaf, expected] of expectations) {
      const id = await insertWatchRow([target], term('ALL', leaf, vector.given.params));
      const { outcome } = await s.evaluator.evaluate(id);
      assert.equal(outcome, expected ? 'MATCHED' : 'SCHEDULED', `${vector.id}: ${leaf} should be ${expected}`);
      exercised.add(leaf);
    }
  }
  assert.deepEqual(
    [...exercised].sort(),
    Object.keys(CONTRACT.leaves).filter((leaf) => CONTRACT.leaves[leaf].sinceVersion === 2).sort(),
    'a version-2 leaf no vector exercised',
  );

  // One door: nothing in the server writes task_progress but the report door, and no migration but the
  // reopen trigger's body. A second writer would be somewhere progress could be made up.
  const WRITE = /INSERT\s+INTO\s+"task_progress"|UPDATE\s+"task_progress"|DELETE\s+FROM\s+"task_progress"|\.taskProgress\.(?:create|createMany|update|updateMany|upsert|delete|deleteMany)\b/;
  const writers: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.spec.ts') && WRITE.test(readFileSync(full, 'utf8'))) {
        writers.push(path.relative(path.join(API, 'src'), full).split(path.sep).join('/'));
      }
    }
  };
  walk(path.join(API, 'src'));
  assert.deepEqual(writers, ['tasks/task-progress.service.ts']);
  const migrations = path.join(API, 'prisma', 'migrations');
  const migrationWriters = readdirSync(migrations)
    .filter((dir) => /^\d{4}_/.test(dir))
    .filter((dir) => {
      try {
        return WRITE.test(readFileSync(path.join(migrations, dir, 'migration.sql'), 'utf8'));
      } catch {
        return false;
      }
    });
  assert.deepEqual(migrationWriters, ['0271_watch_progress_continuous']);
  const migration = readFileSync(path.join(migrations, '0271_watch_progress_continuous', 'migration.sql'), 'utf8');
  const body = migration.slice(migration.indexOf('CREATE OR REPLACE FUNCTION "task_progress_epoch_advance"'));
  const outsideTheTrigger = migration.replace(body.slice(0, body.indexOf('$$ LANGUAGE plpgsql;')), '');
  assert.equal(WRITE.test(outsideTheTrigger), false, '0271 writes task_progress outside the reopen trigger');
  // And no leaf is handed the message to read.
  const evaluatorSource = readFileSync(path.join(API, 'src', 'watches', 'watch-evaluator.service.ts'), 'utf8');
  assert.doesNotMatch(evaluatorSource, /"message"/u, 'the evaluator reads a progress message');
  const watchesSource = readFileSync(path.join(API, 'src', 'watches', 'watches.service.ts'), 'utf8');
  assert.doesNotMatch(watchesSource, /progress:\s*\{\s*select:\s*\{[^}]*message/u, 'the create path reads a progress message');
});

// ── A3: stalls are decided by the one schedule ────────────────────────────────────────────────

scenario('A3', 'a stall is decided on next_evaluate_at by the one evaluator loop: no hint, no timer of its own, and not before its deadline', 180_000, async () => {
  // The probe's control first: a probe that reports nothing has to be one that could report something.
  const control = timerProbe(/perWatchTimerControl/);
  const handles = perWatchTimerControl(42);
  await sleep(100);
  assert.equal(control.live(), 42, 'the timer probe cannot see a timer per watch');
  for (const handle of handles) clearTimeout(handle);
  await sleep(100);
  assert.equal(control.live(), 0, 'the timer probe does not see a timer go');
  control.disable();

  // Every hint is dropped: whatever decides these watches, it is not an event.
  const s = stack({ pollIntervalMs: 1_000, reconcileIntervalMs: HOUR }, DroppingRealtime);
  const hub = s.realtime as DroppingRealtime;

  // Forty stalls an hour away, which the loop has to wait on without paying anything per watch.
  const idle: string[] = [];
  for (let i = 0; i < 40; i += 1) {
    const quiet = await insertTask('IN_PROGRESS');
    await s.progress.report(ownerId, quiet, { current: i });
    idle.push((await createWatch(s, { predicate: stallFor(3_600), targets: tasks([quiet]) })).id);
  }
  // Two whose last progress was 50 seconds ago: their 60-second windows end ten seconds from now.
  const stalling = await insertTask('IN_PROGRESS');
  const moving = await insertTask('IN_PROGRESS');
  for (const task of [stalling, moving]) {
    await s.progress.report(ownerId, task, { phase: 'scan', current: 3 });
    await sql.query(`UPDATE "task_progress" SET "last_progress_at" = now() - interval '50 seconds' WHERE "task_id" = $1`, [task]);
  }
  const stalled = await createWatch(s, { predicate: stallFor(60), targets: tasks([stalling]) });
  const movingWatch = await createWatch(s, { predicate: stallFor(60), targets: tasks([moving]) });
  assert.equal(stalled.state, 'ACTIVE', 'ten seconds short of its window, the stall held at create');

  const scheduleOf = async (watchId: string, taskId: string) => {
    const { rows: [row] } = await sql.query<{ landed: boolean; due: boolean; atDeadline: boolean; deadline: string }>(
      `SELECT w."last_evaluated_at" > w."created_at" AS "landed", w."next_evaluate_at" <= now() AS "due",
              abs(extract(epoch FROM w."next_evaluate_at" - (p."last_progress_at" + interval '60 seconds'))) < 0.002 AS "atDeadline",
              (p."last_progress_at" + interval '60 seconds')::text AS "deadline"
         FROM "watch" w, "task_progress" p WHERE w."id" = $1 AND p."task_id" = $2`,
      [watchId, taskId],
    );
    return row;
  };

  const probe = timerProbe(WATCH_CODE);
  s.evaluator.start();
  for (const [watchId, taskId] of [[stalled.id, stalling], [movingWatch.id, moving]]) {
    await eventually('its first evaluation landed', () => scheduleOf(watchId, taskId), (row) => row.landed && !row.due);
    assert.equal((await scheduleOf(watchId, taskId)).atDeadline, true,
      'the watch was not scheduled at its stall deadline: its next look is the reconciliation an hour out');
  }
  const { rows: [{ n: evaluatedIdle }] } = await sql.query<{ n: number }>(
    `SELECT count(*)::int AS "n" FROM "watch" WHERE "id" = ANY($1::uuid[]) AND "last_evaluated_at" > "created_at"`, [idle]);
  assert.equal(evaluatedIdle, idle.length, 'the first pass did not evaluate every idle watch');
  await eventually('the loop down to its one timer', async () => probe.live(), (live) => live === 1, 5_000);

  // A report before its deadline moves it. Its hint is dropped too, so only the rows can tell the evaluator.
  const oldDeadline = (await scheduleOf(movingWatch.id, moving)).deadline;
  const publishedBefore = hub.dropped;
  await s.progress.report(ownerId, moving, { current: 4 });
  assert.ok(hub.dropped > publishedBefore, 'the report published no hint that could have been dropped');

  await eventually('the stall matched', () => readWatch(stalled.id), (w) => w.state === 'MATCHED', 30_000);
  const [match] = await readMatches(stalled.id);
  assert.equal(match.reason, 'ANY TASK_NO_PROGRESS_FOR(60s) 1/1');
  const { rows: [timing] } = await sql.query<{ late: number }>(
    `SELECT extract(epoch FROM m."matched_at" - (p."last_progress_at" + interval '60 seconds'))::float AS "late"
       FROM "watch_match" m, "task_progress" p WHERE m."watch_id" = $1 AND p."task_id" = $2`,
    [stalled.id, stalling],
  );
  assert.ok(timing.late >= 0, `matched ${-timing.late}s before its deadline`);
  assert.ok(timing.late < 10, `matched ${timing.late}s after its deadline, on a one-second poll`);

  // The moved deadline: the look at the old one re-read the rows, found progress, and scheduled the new one.
  await eventually(
    'the moving watch looked at its old deadline and rescheduled',
    async () => {
      const { rows: [row] } = await sql.query<{ lookedAtOld: boolean }>(
        `SELECT "last_evaluated_at" >= $2::timestamptz AS "lookedAtOld" FROM "watch" WHERE "id" = $1`, [movingWatch.id, oldDeadline]);
      return { ...row, ...(await scheduleOf(movingWatch.id, moving)) };
    },
    (row) => row.lookedAtOld && row.atDeadline,
    30_000,
  );
  assert.equal((await readWatch(movingWatch.id)).state, 'ACTIVE');
  assert.equal((await readMatches(movingWatch.id)).length, 0, 'progress before the deadline still ended in a stall');

  await sleep(300);
  assert.equal(probe.live(), 1, `${idle.length + 2} stall watches waiting: still exactly one timer`);
  assert.ok(probe.created() < idle.length, `${probe.created()} timers were created for ${idle.length + 2} waiting watches`);
  await s.evaluator.stop();
  await sleep(100);
  assert.equal(probe.live(), 0, 'a stopped evaluator left a timer behind');
  probe.disable();
});

// ── A4: a burst folds into one Match and one wake per window ──────────────────────────────────

scenario('A4', 'a CONTINUOUS watch folds a burst of progress crossings into one Match and one wake per debounce window', 240_000, async () => {
  const s = stack({ pollIntervalMs: 200, reconcileIntervalMs: HOUR });
  const worker = deliveryWorker(s.prisma);
  const observer = await insertObserver(await insertRunner());
  const task = await insertTask('IN_PROGRESS');
  await s.progress.report(ownerId, task, { phase: 'sync', current: 4 });
  const watch = await createWatch(s, {
    predicate: reached({ current: 5 }),
    targets: tasks([task]),
    action: 'RESUME_SESSION',
    observerSessionId: observer,
    mode: 'CONTINUOUS',
    debounceSeconds: WATCH_LIMITS.continuousDebounceSeconds,
    wakeBudget: 5,
  });
  assert.deepEqual(
    { mode: watch.mode, debounce: watch.debounceSeconds, budget: watch.wakeBudget, state: watch.state, generation: watch.generation, holding: watch.holding },
    { mode: 'CONTINUOUS', debounce: 10, budget: 5, state: 'ACTIVE', generation: 0, holding: false },
  );
  s.evaluator.start();
  worker.start();

  // The burst: the reported count flips across the threshold a hundred times, every report a hint.
  const reports = 200;
  const burstStarted = Date.now();
  for (let i = 0; i < reports; i += 1) await s.progress.report(ownerId, task, { current: i % 2 === 0 ? 5 : 4 });
  await s.progress.report(ownerId, task, { current: 5 });
  const burstMs = Date.now() - burstStarted;

  const closed = await eventually(
    'the window closed into a Match and nothing reopened it',
    async () => ({ watch: await readWatch(watch.id), matches: await readMatches(watch.id) }),
    ({ watch: row, matches }) => matches.length >= 1 && !row.windowOpen && row.generation === matches.length,
    60_000,
  );
  const burstMatches = closed.matches;
  const crossings = burstMatches.reduce((sum, m) => sum + m.snapshot.window.crossings, 0);
  console.log(`${reports + 1} reports over ${burstMs}ms: ${crossings} crossings seen, folded into ${burstMatches.length} Match(es)`);
  // One window per debounce interval the burst spanned — one, unless the host took most of ten seconds over it.
  assert.ok(burstMatches.length <= 1 + Math.floor(burstMs / (WATCH_LIMITS.continuousDebounceSeconds * 1000)),
    `${burstMatches.length} Matches for a burst of ${burstMs}ms`);
  assert.ok(crossings >= burstMatches.length && crossings <= reports / 2 + 1, `${crossings} crossings counted`);
  assert.ok(crossings > burstMatches.length, 'the burst was not coalesced: every crossing became a Match');
  assert.equal(closed.watch.holding, true);
  assert.equal(closed.watch.state, 'ACTIVE');
  for (const [index, m] of burstMatches.entries()) {
    assert.equal(m.generation, index + 1);
    assert.match(m.reason, /^ANY TASK_PROGRESS_AT_LEAST\(5\) 1\/1; \d+ crossings? since \S+; wake \d of 5$/u);
    assert.deepEqual(m.snapshot.budget, { wake: index + 1, of: 5 });
  }

  // Each Match is one wake: one turn on the observer, under the generation's key, and no more.
  const turnsOf = async () =>
    (await sql.query<{ key: string }>(
      `SELECT "client_turn_id" AS "key" FROM "conversation_turn" WHERE "session_id" = $1 AND "client_turn_id" LIKE 'watch:%' ORDER BY 1`,
      [observer],
    )).rows.map((row) => row.key);
  const expectedKeys = (count: number) => Array.from({ length: count }, (_, i) => `watch:${watch.id}:${i + 1}`).sort();
  await eventually('each Match delivered as one turn', turnsOf, (keys) => keys.length === burstMatches.length, 30_000);
  assert.deepEqual(await turnsOf(), expectedKeys(burstMatches.length));
  await eventually('every delivery settled', () => deliveriesOf(watch.id), (states) => states.every((state) => state === 'DELIVERED'));

  // A later, single crossing is a window of its own: the next generation, one more wake.
  await s.progress.report(ownerId, task, { current: 4 });
  await eventually('the fall landed', () => readWatch(watch.id), (w) => !w.holding, 30_000);
  await s.progress.report(ownerId, task, { current: 5 });
  const next = await eventually('the next window closed into the next Match', () => readMatches(watch.id),
    (matches) => matches.length === burstMatches.length + 1, 60_000);
  assert.equal(next[next.length - 1].snapshot.window.crossings, 1);
  await eventually('its one wake', turnsOf, (keys) => keys.length === next.length, 30_000);
  assert.deepEqual(await turnsOf(), expectedKeys(next.length));
});

// ── A5: the wake budget ───────────────────────────────────────────────────────────────────────

scenario('A5', 'the wake budget ends a CONTINUOUS watch at MATCHED with its last Match, and the database refuses a generation past it', 120_000, async () => {
  const s = stack();
  const task = await insertTask('IN_PROGRESS');
  await s.progress.report(ownerId, task, { current: 0 });
  const watch = await createWatch(s, { predicate: reached({ current: 1 }), targets: tasks([task]), mode: 'CONTINUOUS', wakeBudget: 2 });
  assert.equal(watch.debounceSeconds, WATCH_LIMITS.continuousDebounceSeconds, 'the default window');

  const cross = async () => {
    await s.progress.report(ownerId, task, { current: 1 });
    assert.equal((await s.evaluator.evaluate(watch.id)).outcome, 'SCHEDULED', 'a crossing matched without its window');
    const opened = await readWatch(watch.id);
    assert.deepEqual(
      { open: opened.windowOpen, crossings: opened.windowCrossings, holding: opened.holding, atClose: opened.atWindowClose },
      { open: true, crossings: 1, holding: true, atClose: true },
      'a crossing opens a window and schedules the watch at its close',
    );
    // A second look inside the window, with nothing crossing again, adds nothing to it.
    assert.equal((await s.evaluator.evaluate(watch.id)).outcome, 'SCHEDULED');
    assert.equal((await readWatch(watch.id)).windowCrossings, 1);
    await closeWindow(watch.id);
    return s.evaluator.evaluate(watch.id);
  };
  const fall = async () => {
    await s.progress.report(ownerId, task, { current: 0 });
    assert.equal((await s.evaluator.evaluate(watch.id)).outcome, 'SCHEDULED');
    assert.equal((await readWatch(watch.id)).holding, false);
  };

  assert.equal((await cross()).outcome, 'MATCHED');
  let row = await readWatch(watch.id);
  assert.deepEqual({ state: row.state, generation: row.generation, open: row.windowOpen, scheduled: row.scheduled },
    { state: 'ACTIVE', generation: 1, open: false, scheduled: true });
  // Still holding, nothing crossing: however often it is looked at, no window and no Match.
  for (let i = 0; i < 3; i += 1) assert.equal((await s.evaluator.evaluate(watch.id)).outcome, 'SCHEDULED');
  assert.equal((await readMatches(watch.id)).length, 1);

  await fall();
  assert.equal((await cross()).outcome, 'MATCHED');
  row = await readWatch(watch.id);
  assert.deepEqual({ state: row.state, generation: row.generation, scheduled: row.scheduled, open: row.windowOpen },
    { state: 'MATCHED', generation: 2, scheduled: false, open: false }, 'the last of the budget did not settle the watch');
  const matches = await readMatches(watch.id);
  assert.deepEqual(matches.map((m) => m.snapshot.budget), [{ wake: 1, of: 2 }, { wake: 2, of: 2 }]);
  assert.match(matches[1].reason, /; wake 2 of 2$/u);
  assert.deepEqual(await deliveriesOf(watch.id), ['PENDING', 'PENDING'], 'one delivery per Match');

  // Spent: further crossings reach nothing.
  await s.progress.report(ownerId, task, { current: 0 });
  await s.progress.report(ownerId, task, { current: 1 });
  assert.equal((await s.evaluator.evaluate(watch.id)).outcome, 'SETTLED');
  assert.equal((await readMatches(watch.id)).length, 2);
  assert.equal((await deliveriesOf(watch.id)).length, 2);
  // The ceiling is the database's, not a counter the evaluator is trusted with.
  await assert.rejects(sql.query(`UPDATE "watch" SET "generation" = 3 WHERE "id" = $1`, [watch.id]), /watch_continuous_generation_chk/);

  // The policy's bounds, at the door and in the table.
  const refused: Array<[string, Record<string, unknown>]> = [
    ['a window under the minimum', { mode: 'CONTINUOUS', debounceSeconds: WATCH_LIMITS.continuousDebounceSeconds - 1 }],
    ['a window over the maximum', { mode: 'CONTINUOUS', debounceSeconds: WATCH_LIMITS.maxContinuousDebounceSeconds + 1 }],
    ['a budget of none', { mode: 'CONTINUOUS', wakeBudget: 0 }],
    ['a budget over the maximum', { mode: 'CONTINUOUS', wakeBudget: WATCH_LIMITS.maxContinuousWakeBudget + 1 }],
    ['a budget on a one-shot watch', { wakeBudget: 3 }],
    ['a window on a one-shot watch', { mode: 'ONE_SHOT', debounceSeconds: 10 }],
  ];
  for (const [why, body] of refused) {
    assert.equal(await refusalOf(() => createWatch(s, { predicate: reached({ current: 1 }), targets: tasks([task]), ...body })),
      'CONTINUOUS_POLICY_INVALID', why);
  }
  const defaults = await createWatch(s, { predicate: reached({ current: 1 }), targets: tasks([task]), mode: 'CONTINUOUS' });
  assert.deepEqual([defaults.debounceSeconds, defaults.wakeBudget],
    [WATCH_LIMITS.continuousDebounceSeconds, WATCH_LIMITS.defaultContinuousWakeBudget]);
  assert.equal(defaults.state, 'ACTIVE', 'a CONTINUOUS watch whose condition holds at create is not matched at create');
  assert.equal(defaults.generation, 0);
  await assert.rejects(insertWatchRow([task], reached({ current: 1 }), { mode: 'CONTINUOUS' }), /watch_continuous_policy_chk/);
  await assert.rejects(insertWatchRow([task], reached({ current: 1 }), { debounce: 10, budget: 2 }), /watch_continuous_policy_chk/);

  // Cancelling a watch with an open window ends the window with it.
  assert.equal((await s.evaluator.evaluate(defaults.id)).outcome, 'SCHEDULED');
  assert.equal((await readWatch(defaults.id)).windowOpen, true);
  const cancelled = await s.watches.cancel(ownerId, defaults.id);
  assert.deepEqual({ state: cancelled.state, open: cancelled.windowOpenedAt, crossings: cancelled.windowCrossings },
    { state: 'CANCELLED', open: null, crossings: 0 });
});

// ── A6: the lifecycle epoch ───────────────────────────────────────────────────────────────────

scenario('A6', 'reopening a Task starts a new lifecycle epoch: nothing reported in it, a stale revision refused, no Match rewritten, and watches observe the new epoch', 120_000, async () => {
  const s = stack();
  const task = await insertTask('IN_PROGRESS');
  await s.progress.report(ownerId, task, { phase: 'ship', current: 3, total: 3, message: 'all three' });
  const before = await s.progress.get(ownerId, task);

  // A one-shot watch matched in epoch 0, at its create.
  const oneShot = await createWatch(s, { predicate: reached({ percent: 100 }), targets: tasks([task]) });
  assert.equal(oneShot.state, 'MATCHED');
  const recorded = await readMatches(oneShot.id);
  assert.equal(recorded[0].snapshot.targets[0].epoch, 0);
  // A continuous watch whose first Match is in epoch 0.
  const continuous = await createWatch(s, { predicate: reached({ percent: 100 }), targets: tasks([task]), mode: 'CONTINUOUS', wakeBudget: 5 });
  assert.equal((await s.evaluator.evaluate(continuous.id)).outcome, 'SCHEDULED');
  await closeWindow(continuous.id);
  assert.equal((await s.evaluator.evaluate(continuous.id)).outcome, 'MATCHED');

  // Writes that do not reopen the task leave its epoch alone: open to open, into a conclusion, between conclusions.
  const epochOf = async () => {
    const view = await s.progress.get(ownerId, task);
    return { epoch: view.lifecycleEpoch, revision: view.revision };
  };
  for (const status of ['OPEN', 'IN_PROGRESS', 'FAILED', 'CANCELLED']) {
    await setStatus(task, status);
    assert.deepEqual(await epochOf(), { epoch: 0, revision: before.revision }, `moving to ${status} advanced the epoch`);
  }

  // Reopened, by a plain write, as any writer would.
  await setStatus(task, 'OPEN');
  const reopened = await s.progress.get(ownerId, task);
  assert.deepEqual(
    { epoch: reopened.lifecycleEpoch, phase: reopened.phase, current: reopened.current, total: reopened.total,
      message: reopened.message, lastProgressAt: reopened.lastProgressAt, revision: reopened.revision },
    { epoch: 1, phase: null, current: null, total: null, message: null, lastProgressAt: null, revision: before.revision + 1 },
    'the reopened epoch carried the previous epoch\'s progress',
  );
  assert.ok(Date.parse(reopened.epochStartedAt) > Date.parse(before.lastProgressAt!), 'the new epoch did not start at the reopen');

  // A report still aimed at the old epoch loses its compare-and-set.
  const stale = await conflictOf(() => s.progress.report(ownerId, task, { current: 3, expectedRevision: before.revision }));
  assert.deepEqual({ code: stale.code, epoch: stale.lifecycleEpoch, revision: stale.revision },
    { code: 'PROGRESS_REVISION_CONFLICT', epoch: 1, revision: before.revision + 1 });

  // The Match about epoch 0 is still exactly what it was.
  assert.deepEqual(await readMatches(oneShot.id), recorded);

  // The continuous watch sees the new epoch: its progress is gone, the leaf falls, the target moves to epoch 1.
  assert.equal((await s.evaluator.evaluate(continuous.id)).outcome, 'SCHEDULED');
  assert.deepEqual(await targetsOf(continuous.id), { [task]: { state: 'OBSERVED', epoch: 1 } });
  assert.equal((await readWatch(continuous.id)).holding, false);
  // Reaching it again in epoch 1 is a new crossing, recorded against epoch 1.
  await s.progress.report(ownerId, task, { phase: 'ship', current: 3, total: 3, expectedRevision: reopened.revision });
  assert.equal((await s.evaluator.evaluate(continuous.id)).outcome, 'SCHEDULED');
  await closeWindow(continuous.id);
  assert.equal((await s.evaluator.evaluate(continuous.id)).outcome, 'MATCHED');
  assert.deepEqual((await readMatches(continuous.id)).map((m) => m.snapshot.targets[0].epoch), [0, 1]);

  // A second reopen is a second epoch.
  await setStatus(task, 'FAILED');
  await setStatus(task, 'IN_PROGRESS');
  assert.equal((await s.progress.get(ownerId, task)).lifecycleEpoch, 2);

  // A stall in a reopened epoch counts from the reopen, not from the last report of the epoch before.
  const quiet = await insertTask('IN_PROGRESS');
  await s.progress.report(ownerId, quiet, { current: 1 });
  await sql.query(`UPDATE "task_progress" SET "last_progress_at" = now() - interval '2 hours' WHERE "task_id" = $1`, [quiet]);
  const stalledBefore = await createWatch(s, { predicate: stallFor(60), targets: tasks([quiet]) });
  assert.equal(stalledBefore.state, 'MATCHED', 'two hours without progress is a stall');
  await setStatus(quiet, 'FAILED');
  await setStatus(quiet, 'OPEN');
  const fresh = await createWatch(s, { predicate: stallFor(60), targets: tasks([quiet]) });
  assert.equal(fresh.state, 'ACTIVE', 'the reopened epoch has not gone a minute without progress');
  assert.equal(fresh.targets[0].targetEpoch, 1, 'the watch did not record the epoch it observed');
  assert.equal((await s.evaluator.evaluate(fresh.id)).outcome, 'SCHEDULED');
  const { rows: [at] } = await sql.query<{ fromReopen: boolean }>(
    `SELECT abs(extract(epoch FROM w."next_evaluate_at" - (p."epoch_started_at" + interval '60 seconds'))) < 0.002 AS "fromReopen"
       FROM "watch" w, "task_progress" p WHERE w."id" = $1 AND p."task_id" = $2`,
    [fresh.id, quiet],
  );
  assert.equal(at.fromReopen, true, 'the stall deadline did not count from the reopen');
});

// ── A7: quorums over the sealed set ───────────────────────────────────────────────────────────

scenario('A7', 'a quorum is counted over the sealed target set: at least N of it, refused when N cannot fit, UNRESOLVABLE once N is out of reach', 120_000, async () => {
  const s = stack();
  const quorum = (count: unknown) => ({ kind: 'AT_LEAST', count, over: 'ALL_TARGETS', leaf: 'TASK_TERMINAL' });
  const [a, b, c] = [await insertTask('OPEN'), await insertTask('OPEN'), await insertTask('OPEN')];
  const watch = await createWatch(s, { predicate: quorum(2), targets: tasks([a, b, c]) });
  assert.equal(watch.state, 'ACTIVE');
  await setStatus(a, 'FAILED');
  assert.equal((await s.evaluator.evaluate(watch.id)).outcome, 'SCHEDULED', 'one of three is not two');
  await setStatus(b, 'CANCELLED');
  assert.equal((await s.evaluator.evaluate(watch.id)).outcome, 'MATCHED');
  assert.equal((await readMatches(watch.id))[0].reason, 'AT_LEAST 2 TASK_TERMINAL 2/3');

  // quorum-over-the-sealed-set, through the create path.
  const vector = await createWatch(s, {
    predicate: quorum(2),
    targets: tasks([await insertTask('DONE'), await insertTask('FAILED'), await insertTask('OPEN')]),
  });
  assert.equal(vector.state, 'MATCHED');

  // Refused before anything is written.
  const { rows: [{ n: watchesBefore }] } = await sql.query<{ n: number }>(`SELECT count(*)::int AS "n" FROM "watch"`);
  const refused: Array<[string, Record<string, unknown>, string]> = [
    ['a quorum larger than the sealed set', { predicate: quorum(4) }, 'PREDICATE_PARAMETER_INVALID'],
    ['a quorum of none', { predicate: quorum(0) }, 'PREDICATE_PARAMETER_INVALID'],
    ['a fractional quorum', { predicate: quorum(1.5) }, 'PREDICATE_PARAMETER_INVALID'],
    ['a quorum inside a composite that cannot fit', { predicate: { kind: 'ANY_OF', operands: [quorum(4), term('ANY', 'TASK_FAILED')] } }, 'PREDICATE_PARAMETER_INVALID'],
    ['AT_LEAST under version 1', { predicateVersion: 1, predicate: quorum(2) }, 'UNKNOWN_PREDICATE_KIND'],
    ['a progress leaf under version 1', { predicateVersion: 1, predicate: stallFor(60) }, 'UNKNOWN_PREDICATE_KIND'],
    ['params under version 1', { predicateVersion: 1, predicate: term('ALL', 'TASK_DONE', {}) }, 'UNKNOWN_PREDICATE_KIND'],
    ['a stall window under the minimum', { predicate: stallFor(WATCH_LIMITS.minNoProgressSeconds - 1) }, 'PREDICATE_PARAMETER_INVALID'],
    ['a stall window over the maximum', { predicate: stallFor(WATCH_LIMITS.maxTtlSeconds + 1) }, 'PREDICATE_PARAMETER_INVALID'],
    ['a threshold in both forms', { predicate: reached({ current: 1, percent: 50 }) }, 'PREDICATE_PARAMETER_INVALID'],
    ['a percent over a hundred', { predicate: reached({ percent: 101 }) }, 'PREDICATE_PARAMETER_INVALID'],
    ['a progress leaf with no params', { predicate: term('ANY', 'TASK_PROGRESS_AT_LEAST') }, 'PREDICATE_PARAMETER_INVALID'],
    ['params on a leaf that takes none', { predicate: term('ALL', 'TASK_DONE', { seconds: 60 }) }, 'PREDICATE_PARAMETER_INVALID'],
    ['a version this build does not serve', { predicateVersion: 3 }, 'PREDICATE_VERSION_UNSUPPORTED'],
  ];
  for (const [why, body, code] of refused) {
    assert.equal(await refusalOf(() => createWatch(s, { predicate: quorum(2), targets: tasks([a, b, c]), ...body })), code, why);
  }
  for (const vectorId of ['quorum-larger-than-the-set-refused', 'version-1-refuses-version-2-terms']) {
    const { given, expect: expected } = (CONTRACT.vectors as Array<Record<string, any>>).find((v) => v.id === vectorId)!;
    const targets = tasks(await Promise.all((given.tasks ?? ['OPEN']).map((status: string) => insertTask(status))));
    assert.equal(await refusalOf(() => createWatch(s, { predicateVersion: given.predicateVersion ?? 2, predicate: given.predicate, targets })),
      expected.refusal, vectorId);
  }
  const { rows: [{ n: watchesAfter }] } = await sql.query<{ n: number }>(`SELECT count(*)::int AS "n" FROM "watch"`);
  assert.equal(watchesAfter, watchesBefore, 'a refused create wrote a watch');

  // quorum-unreachable-after-deletion-is-unresolvable, with the paired positive on the same set.
  const [x, y, z] = [await insertTask('OPEN'), await insertTask('OPEN'), await insertTask('OPEN')];
  const allThree = await createWatch(s, { predicate: quorum(3), targets: tasks([x, y, z]) });
  const twoOfThree = await createWatch(s, { predicate: quorum(2), targets: tasks([x, y, z]) });
  await sql.query(`DELETE FROM "task" WHERE "id" = $1`, [z]);
  assert.equal((await s.evaluator.evaluate(twoOfThree.id)).outcome, 'SCHEDULED', 'two of the remaining two can still settle');
  assert.equal((await s.evaluator.evaluate(allThree.id)).outcome, 'UNRESOLVABLE');
  assert.deepEqual(await targetsOf(allThree.id), {
    [x]: { state: 'OBSERVED', epoch: 0 }, [y]: { state: 'OBSERVED', epoch: 0 }, [z]: { state: 'GONE', epoch: 0 },
  });
  // An edit is held to the sealed set the same way.
  assert.equal(
    await refusalOf(() => s.watches.update(ownerId, twoOfThree.id, { predicateVersion: 2, predicate: quorum(4) } as never)),
    'PREDICATE_PARAMETER_INVALID',
  );
  await setStatus(x, 'FAILED');
  await setStatus(y, 'CANCELLED');
  assert.equal((await s.evaluator.evaluate(twoOfThree.id)).outcome, 'MATCHED');
});

// ── probes ─────────────────────────────────────────────────────────────────────────────────────

/** The design ruled out: a timer per watch. The probe has to see every one. */
function perWatchTimerControl(watches: number): Array<ReturnType<typeof setTimeout>> {
  const handles: Array<ReturnType<typeof setTimeout>> = [];
  for (let i = 0; i < watches; i += 1) handles.push(setTimeout(() => undefined, HOUR).unref());
  return handles;
}

/**
 * Timers alive right now whose creating call site matches `site`, followed through async_hooks from
 * creation to destroy. The call site is the first frame outside Node's own timer machinery, so a timer
 * the evaluator's code made is attributed to it however the loop that made it was reached.
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
