/**
 * SESSION_QUIESCENT against a real PostgreSQL (docs/session-three-state-plan.md step 1.3): the condition
 * `session_await` and `session_create(wait)` wait for by default, decided from the rows the evaluator and the
 * create path read — the session's running sets, its retry, the RESUME_SESSION watches it observes and its
 * pending wake-ups.
 *
 *     bash scripts/run-pg-spec.sh src/apiserver/src/watches/watch-session-quiescent.pg.spec.ts
 *
 * Non-destructive: every row carries an id this run generated.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { after, before, test } from 'node:test';

import { BadRequestException } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { Client } from 'pg';

import { prismaClientFor } from '../prisma/prisma-client';
import { PrismaService } from '../prisma/prisma.service';
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from '../projects/coordinator-pg-test-safety';
import type { PushService } from '../push/push.service';
import { RealtimeService } from '../realtime/realtime.service';
import type { CreateWatchDto } from './dto';
import { WatchEvaluatorService } from './watch-evaluator.service';
import { WatchesService } from './watches.service';

const URL = process.env.COORDINATOR_PG_URL;
const skip = !URL;
const HOUR = 60 * 60 * 1000;

const CONTRACT = JSON.parse(
  readFileSync(path.resolve(__dirname, '../../../../contracts/watch.contract.json'), 'utf8'),
) as {
  agentSurface: {
    awaitPresets: { session_await: { default: string; until: Record<string, unknown> } };
    sessionCreateWait: { watch: { predicate: unknown; predicateVersion: number } };
  };
  vectors: Array<{ id: string; given: Record<string, any>; expect: Record<string, unknown> }>;
};

const sessionAwait = CONTRACT.agentSurface.awaitPresets.session_await;
/** The two default waits, each with the grammar version it is sent under. */
const DEFAULTS: Array<{ name: string; predicate: unknown; version: number }> = [
  { name: 'session_await default', predicate: sessionAwait.until[sessionAwait.default], version: 4 },
  {
    name: 'session_create(wait)',
    predicate: CONTRACT.agentSurface.sessionCreateWait.watch.predicate,
    version: CONTRACT.agentSurface.sessionCreateWait.watch.predicateVersion,
  },
];
const SETTLED = { kind: 'ALL', over: 'ALL_TARGETS', leaf: 'SESSION_TURN_SETTLED' };
const QUIESCENT = { kind: 'ALL', over: 'ALL_TARGETS', leaf: 'SESSION_QUIESCENT' };

const silentPush = { scheduleBadgeSync: () => undefined, notifySessionSettled: async () => undefined } as unknown as PushService;

class LocalRealtime extends RealtimeService {
  constructor(prisma: PrismaClient) {
    super(prisma as unknown as PrismaService, silentPush);
  }

  override async onModuleInit(): Promise<void> {}
}

let sql: Client;
let prisma: PrismaClient;
let ownerId: string;
let evaluator: WatchEvaluatorService;
let watches: WatchesService;

before(async () => {
  if (skip) return;
  assertCoordinatorPgUrlIsIsolated(URL);
  sql = new Client({ connectionString: URL, connectionTimeoutMillis: 5_000 });
  await sql.connect();
  await verifyCoordinatorPgIdentity(sql);
  ownerId = randomUUID();
  await sql.query(
    `INSERT INTO "user"("id","email","name","password_hash") VALUES ($1,$2,'quiescent watch','h')`,
    [ownerId, `${ownerId}@watch-quiescent.invalid`],
  );
  prisma = prismaClientFor(URL!);
  evaluator = new WatchEvaluatorService(prisma as unknown as PrismaService, new LocalRealtime(prisma), {
    reconcileIntervalMs: HOUR,
    pollIntervalMs: HOUR,
  });
  watches = new WatchesService(prisma as unknown as PrismaService);
});

after(async () => {
  if (skip) return;
  await evaluator.stop();
  await prisma.$disconnect().catch(() => undefined);
  await sql?.end().catch(() => undefined);
});

interface SessionRow {
  status?: string;
  endReason?: string | null;
  completed?: boolean;
  jobs?: string[];
  subagents?: string[];
  engineTurn?: boolean;
  retryInSeconds?: number | null;
}

async function insertSession(row: SessionRow = {}): Promise<string> {
  const id = randomUUID();
  await sql.query(
    `INSERT INTO "session"("id","title","prompt","owner_id","creator_id","updated_at","status","end_reason",
                           "completed_at","running_bg_jobs","running_subagents","engine_turn_active","retry_at")
     VALUES ($1,'a child session','p',$2,$2,now(),$3,$4,CASE WHEN $5::boolean THEN now() END,$6::text[],$7::text[],$8,
             CASE WHEN $9::int IS NOT NULL THEN now() + make_interval(secs => $9::int) END)`,
    [
      id, ownerId, row.status ?? 'AWAITING_INPUT', row.endReason ?? null, row.completed ?? false,
      row.jobs ?? [], row.subagents ?? [], row.engineTurn ?? false, row.retryInSeconds ?? null,
    ],
  );
  return id;
}

async function update(sessionId: string, set: string): Promise<void> {
  await sql.query(`UPDATE "session" SET ${set} WHERE "id" = $1`, [sessionId]);
}

/** A RESUME_SESSION watch `observer` waits on, as task_await or session_await leaves it: the observer is armed to wake. */
async function armWatch(observer: string): Promise<string> {
  const other = await insertSession({ status: 'RUNNING' });
  return insertWatch(other, SETTLED, 1, { observer, state: 'ACTIVE' });
}

async function armWakeup(sessionId: string): Promise<void> {
  await sql.query(
    `INSERT INTO "session_scheduled_wakeup"("id","session_id","state","delay_seconds","reason","due_at")
     VALUES ($1,$2,'PENDING',600,'check the soak test',now() + interval '10 minutes')`,
    [randomUUID(), sessionId],
  );
}

/** A ONE_SHOT watch as creation leaves it, due now: a user's NOTIFY_USER one, or `observer`'s RESUME_SESSION one. */
async function insertWatch(
  target: string,
  predicate: unknown,
  version: number,
  over: { observer?: string; state?: string } = {},
): Promise<string> {
  const id = randomUUID();
  await sql.query(
    `WITH "created" AS (
       INSERT INTO "watch"("id","owner_id","observer_type","observer_session_id","predicate","mode","action","state",
                           "expires_at","next_evaluate_at","predicate_version")
       VALUES ($1,$2,$3,$4,$5::jsonb,'ONE_SHOT',$6,$7,now() + interval '1 hour',now(),$8)
       RETURNING "id"
     )
     INSERT INTO "watch_target"("id","watch_id","target_kind","target_resource_id")
     SELECT $9, "created"."id", 'SESSION', $10 FROM "created"`,
    [
      id, ownerId, over.observer ? 'SESSION' : 'USER', over.observer ?? null, JSON.stringify(predicate),
      over.observer ? 'RESUME_SESSION' : 'NOTIFY_USER', over.state ?? 'ACTIVE', version, randomUUID(), target,
    ],
  );
  return id;
}

/** What the evaluator decides for a fresh watch with this predicate over `target`: true when it MATCHED. */
async function decides(target: string, predicate: unknown, version: number): Promise<boolean> {
  const watchId = await insertWatch(target, predicate, version);
  const { outcome } = await evaluator.evaluate(watchId);
  assert.ok(outcome === 'MATCHED' || outcome === 'SCHEDULED', `unexpected outcome ${outcome}`);
  return outcome === 'MATCHED';
}

/** What the create path decides for the same watch: the service POST /api/watches and the runner door create with. */
async function decidedAtCreate(target: string, predicate: unknown, version: number): Promise<boolean> {
  const created = await watches.create(ownerId, {
    predicateVersion: version,
    predicate,
    targets: [{ kind: 'SESSION', id: target }],
    action: 'NOTIFY_USER',
  } as unknown as CreateWatchDto);
  return created.state === 'MATCHED';
}

async function bothDefaults(target: string): Promise<Record<string, boolean>> {
  const verdicts: Record<string, boolean> = {};
  for (const wait of DEFAULTS) {
    verdicts[`${wait.name} (evaluator)`] = await decides(target, wait.predicate, wait.version);
    verdicts[`${wait.name} (create)`] = await decidedAtCreate(target, wait.predicate, wait.version);
  }
  return verdicts;
}

const every = (value: boolean) =>
  Object.fromEntries(DEFAULTS.flatMap((wait) => [[`${wait.name} (evaluator)`, value], [`${wait.name} (create)`, value]]));

test('a child at AWAITING_INPUT with a job in running_bg_jobs does not satisfy the default waits until the job ends', { skip, timeout: 60_000 }, async () => {
  const child = await insertSession({ jobs: ['bgj_0a1b2c3d4e5f'] });
  // The stored condition the default used to be holds for it: that is the early return this step removes.
  assert.equal(await decides(child, SETTLED, 1), true);
  assert.deepEqual(await bothDefaults(child), every(false));
  await update(child, `"running_bg_jobs" = '{}'`);
  assert.deepEqual(await bothDefaults(child), every(true));
});

test('a child at AWAITING_INPUT with a running subagent does not satisfy the default waits until the subagent ends', { skip, timeout: 60_000 }, async () => {
  const child = await insertSession({ subagents: ['toolu_01AbCdEf'] });
  assert.equal(await decides(child, SETTLED, 1), true);
  assert.deepEqual(await bothDefaults(child), every(false));
  await update(child, `"running_subagents" = '{}'`);
  assert.deepEqual(await bothDefaults(child), every(true));
});

test('a waiting watch on a working child matches once the work ends, decided again from the rows', { skip, timeout: 60_000 }, async () => {
  const child = await insertSession({ jobs: ['bgj_0a1b2c3d4e5f'], subagents: ['toolu_01AbCdEf'] });
  const watchId = await insertWatch(child, DEFAULTS[1].predicate, DEFAULTS[1].version);
  assert.equal((await evaluator.evaluate(watchId)).outcome, 'SCHEDULED');
  await update(child, `"running_bg_jobs" = '{}'`);
  assert.equal((await evaluator.evaluate(watchId)).outcome, 'SCHEDULED', 'the subagent still runs');
  await update(child, `"running_subagents" = '{}'`);
  assert.equal((await evaluator.evaluate(watchId)).outcome, 'MATCHED');
  const { rows: [match] } = await sql.query<{ snapshot: any }>(
    `SELECT "per_target_snapshot" AS "snapshot" FROM "watch_match" WHERE "watch_id" = $1`,
    [watchId],
  );
  const observed = match.snapshot.targets[0].observed;
  assert.deepEqual({ executing: observed.executing, wakeArmed: observed.wakeArmed }, { executing: false, wakeArmed: false });
});

test('SESSION_QUIESCENT answers each case of the table from the rows', { skip, timeout: 120_000 }, async () => {
  const cases: Array<[string, () => Promise<string>, boolean]> = [
    ['held idle, nothing armed', () => insertSession(), true],
    ['held idle with a job', () => insertSession({ jobs: ['bgj_0a1b2c3d4e5f'] }), false],
    ['held idle with a subagent', () => insertSession({ subagents: ['toolu_01AbCdEf'] }), false],
    ['held idle with an engine turn', () => insertSession({ engineTurn: true }), false],
    ['held idle with a watch it waits on', async () => { const s = await insertSession(); await armWatch(s); return s; }, false],
    ['held idle with a wake-up', async () => { const s = await insertSession(); await armWakeup(s); return s; }, false],
    ['held idle with a retry armed', () => insertSession({ retryInSeconds: 600 }), false],
    ['FAILED with a retry armed', () => insertSession({ status: 'FAILED', retryInSeconds: 600 }), false],
    ['FAILED with nothing armed', () => insertSession({ status: 'FAILED' }), true],
    [
      'ended by a person with a stale watch and wake-up',
      async () => {
        const s = await insertSession({ status: 'CANCELLED', endReason: 'ended' });
        await armWatch(s);
        await armWakeup(s);
        return s;
      },
      true,
    ],
    ['a turn queued', () => insertSession({ status: 'PENDING' }), false],
    ['a turn running', () => insertSession({ status: 'RUNNING' }), false],
  ];
  for (const [name, make, expected] of cases) {
    const target = await make();
    assert.equal(await decides(target, QUIESCENT, 4), expected, `${name} (evaluator)`);
    assert.equal(await decidedAtCreate(target, QUIESCENT, 4), expected, `${name} (create)`);
  }
});

test('the contract vectors that ask SESSION_QUIESCENT are decided as they say', { skip, timeout: 60_000 }, async () => {
  let driven = 0;
  for (const vector of CONTRACT.vectors) {
    if (!('SESSION_QUIESCENT' in vector.expect)) continue;
    const given = vector.given.session;
    const target = await insertSession({
      status: given.status,
      endReason: given.endReason ?? null,
      jobs: (vector.given.jobs ?? []).map((job: { id: string }) => job.id),
      subagents: given.runningSubagents ?? [],
      retryInSeconds: given.retryAt ? 600 : null,
    });
    if (given.hasResumeWatch) await armWatch(target);
    if (given.hasPendingWakeup) await armWakeup(target);
    assert.equal(await decides(target, QUIESCENT, 4), vector.expect.SESSION_QUIESCENT, vector.id);
    driven += 1;
  }
  assert.ok(driven >= 6, `only ${driven} vectors asked SESSION_QUIESCENT`);
});

test('a stored SESSION_TURN_SETTLED watch gives the same verdict as before for the same rows, work running beside the turn or not', { skip, timeout: 120_000 }, async () => {
  // The base commit's leaf: the status left PENDING and RUNNING. Nothing else about the row is read.
  const before = (status: string) => !['PENDING', 'RUNNING'].includes(status);
  const statuses = ['PENDING', 'RUNNING', 'AWAITING_INPUT', 'INTERRUPTED', 'SUCCEEDED', 'FAILED', 'CANCELLED'];
  const beside: SessionRow[] = [{}, { jobs: ['bgj_0a1b2c3d4e5f'] }, { subagents: ['toolu_01AbCdEf'] }, { engineTurn: true }, { retryInSeconds: 600 }];
  for (const status of statuses) {
    for (const extra of beside) {
      const target = await insertSession({ status, ...extra });
      for (const version of [1, 2, 3, 4]) {
        assert.equal(await decides(target, SETTLED, version), before(status), `${status} ${JSON.stringify(extra)} v${version}`);
      }
    }
    const watched = await insertSession({ status });
    await armWatch(watched);
    await armWakeup(watched);
    assert.equal(await decides(watched, SETTLED, 1), before(status), `${status} with a watch and a wake-up armed`);
  }
});

test('a version-3 request naming SESSION_QUIESCENT is refused, so no older grammar meets it', { skip, timeout: 30_000 }, async () => {
  const target = await insertSession();
  await assert.rejects(
    () => decidedAtCreate(target, QUIESCENT, 3),
    (error: unknown) => error instanceof BadRequestException && (error.getResponse() as { code?: string }).code === 'UNKNOWN_PREDICATE_KIND',
  );
});
