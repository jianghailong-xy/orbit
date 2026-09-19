/**
 * What a watch tells the owner's clients, against a real PostgreSQL (docs/watch-contract.md §8.1).
 *
 * Four things that move a watch write NO task row and NO session row, so until this event existed
 * nothing on the control plane named them and the web watch list found them only on its 60s poll:
 * a NOTIFY_USER delivery (it pushes to APNs and touches nothing else), a TTL running out, a delivery
 * becoming a dead letter, and an agent making or releasing a watch inside its session. Each is
 * driven here through the production path — `WatchesService`, the evaluator's landing, the delivery
 * worker — and read off the real `RealtimeService`, through the same `streamForUser` the browser's
 * `GET /api/events` is served from.
 *
 *     bash scripts/run-pg-spec.sh src/apiserver/src/watches/watch-events.pg.spec.ts
 *
 * The announcement is an accelerant and nothing else: it carries the watch's id and NOT its state,
 * its targets, the snapshot or the Match reason (contract `deliveryGuards.redaction`), a client
 * re-reads `GET /watches` to learn what changed, and every case here would still be true of a watch
 * whose announcements were all dropped — what makes the watch itself correct is `nextEvaluateAt`
 * plus the leased reconciliation sweep, which this spec does not touch.
 *
 * Non-destructive: every row carries an id this run generated, and each case owns an account of its
 * own, so the stream it subscribes to carries its watches and nobody else's.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, beforeEach, test } from 'node:test';

import type { PrismaClient } from '@prisma/client';
import { ControlEvent, ControlEventType, WATCH_LIMITS } from '@orbit/shared';
import { Client } from 'pg';
import type { Subscription } from 'rxjs';

import { prismaClientFor } from '../prisma/prisma-client';
import { PrismaService } from '../prisma/prisma.service';
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from '../projects/coordinator-pg-test-safety';
import { PushService } from '../push/push.service';
import { RealtimeService } from '../realtime/realtime.service';
import { SessionsService } from '../sessions/sessions.service';
import type { CreateWatchDto } from './dto';
import { WatchDeliveryService } from './watch-delivery.service';
import { WatchEvaluatorService } from './watch-evaluator.service';
import { WatchesService } from './watches.service';

const URL = process.env.COORDINATOR_PG_URL;
const skip = !URL;

const HOUR = 60 * 60 * 1000;
const ALL_TERMINAL = { kind: 'ALL', over: 'ALL_TARGETS', leaf: 'TASK_TERMINAL' } as const;

/** Push, recorded nowhere: what APNs is handed is `watch-delivery.pg.spec.ts`'s subject, not this one. */
const silentPush = {
  notifyWatchMatched: async () => undefined,
  scheduleBadgeSync: () => undefined,
} as unknown as PushService;

/** What the workers tell the rest of the system, which no case here reads. */
const queue = { notifySessionQueued: () => undefined };
const sessionHub = { notifyInbox: () => undefined, publishQueuedTurnsChanged: () => undefined };

/**
 * The real hub, with only the LISTEN connection it opens at boot left unopened: every publish below
 * is this replica's own, so the cross-replica NOTIFY bridge has nothing to carry.
 */
class LocalRealtime extends RealtimeService {
  constructor(prisma: PrismaClient) {
    super(prisma as unknown as PrismaService, silentPush);
  }

  override async onModuleInit(): Promise<void> {}
}

// ── the harness ────────────────────────────────────────────────────────────────────────────────

let sql: Client;
let prisma: PrismaClient;
let hub: LocalRealtime;
let watches: WatchesService;
/** Never started: a case lands an evaluation by calling it. */
let evaluator: WatchEvaluatorService;
const clients: PrismaClient[] = [];
const loops: Array<{ stop(): Promise<unknown> }> = [];
const subscriptions: Subscription[] = [];

before(async () => {
  if (skip) return;
  assertCoordinatorPgUrlIsIsolated(URL);
  sql = new Client({ connectionString: URL, connectionTimeoutMillis: 5_000 });
  await sql.connect();
  await verifyCoordinatorPgIdentity(sql);
  prisma = prismaClientFor(URL!);
  clients.push(prisma);
  hub = new LocalRealtime(prisma);
  watches = new WatchesService(prisma as unknown as PrismaService, {}, hub);
  evaluator = new WatchEvaluatorService(prisma as unknown as PrismaService, hub, {
    reconcileIntervalMs: HOUR,
    pollIntervalMs: HOUR,
  });
});

beforeEach(async () => {
  if (skip) return;
  await quiesce();
  // The harness's own pool went with the case before this one, and a case's first write must not be
  // the call that dials it.
  await warm([prisma]);
  // A case's delivery worker claims every due delivery in the database, not only its own: retire
  // what earlier cases left claimable, and stop the watches they left schedulable.
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
  await sql?.end().catch(() => undefined);
});

/** Stops what a case left running and closes its pools, before the next case opens its own. */
async function quiesce(): Promise<void> {
  for (const subscription of subscriptions.splice(0)) subscription.unsubscribe();
  for (const loop of loops.splice(0)) await loop.stop();
  for (const client of clients.splice(0)) await client.$disconnect().catch(() => undefined);
}

/** pg.Pool's default size, which a PrismaPg built from a URL keeps. */
const POOL_MAX = 10;

/**
 * Opens `connections` connections in each pool before a case puts work on it: a pool made moments
 * before its first write opens them in the middle of it, and on a starved host each connection takes
 * longer than the two seconds Prisma waits for one before a transaction fails to start (P2028).
 */
async function warm(pools: PrismaClient[], connections = POOL_MAX): Promise<void> {
  await Promise.all(
    pools.flatMap((pool) => Array.from({ length: connections }, () => pool.$executeRaw`SELECT pg_sleep(0.1)`)),
  );
}

/** One replica's delivery worker: its own pool, the real sessions service, and the shared hub. */
async function worker(): Promise<WatchDeliveryService> {
  const pool = prismaClientFor(URL!);
  clients.push(pool);
  await warm([pool]);
  const sessions = new SessionsService(pool as unknown as PrismaService, queue as never, sessionHub as never);
  const delivery = new WatchDeliveryService(
    pool as unknown as PrismaService,
    sessions,
    silentPush,
    { retryBaseMs: 0, retryMaxMs: 0, pollIntervalMs: HOUR },
    hub,
  );
  loops.push(delivery);
  return delivery;
}

// ── what the owner's stream carried ────────────────────────────────────────────────────────────

/**
 * One account's control-plane stream, as a browser tab reads it: the real `streamForUser`, filtered
 * to this account's watch announcements and checked as each one arrives. Nothing else on that stream
 * may call itself a watch change, and nothing a watch announces may say more than which watch it was.
 */
function announcements(ownerId: string): { ids(): string[]; others(): ControlEvent[] } {
  const ids: string[] = [];
  const others: ControlEvent[] = [];
  const subscription = hub.streamForUser(ownerId).subscribe((event) => {
    if (event.type !== ControlEventType.WATCH_CHANGED) {
      others.push(event);
      return;
    }
    // The whole payload, read as a whole: the id, and no state, targets, snapshot or Match reason.
    // Asserted here rather than at the end, so an announcement that leaked something fails in the
    // case that published it.
    assert.deepEqual(
      Object.keys(event.data).sort(),
      ['id'],
      `a watch announcement carried more than the watch's id: ${JSON.stringify(event.data)}`,
    );
    // A watch belongs to its owner, not to the session observing it: the envelope names no session.
    assert.equal(event.sessionId, '', 'a watch announcement named a session');
    assert.equal(event.agentId, null);
    ids.push(String(event.data.id));
  });
  subscriptions.push(subscription);
  return { ids: () => [...ids], others: () => [...others] };
}

/**
 * Wait until the owner's stream has carried `count` announcements, then hold still long enough for a
 * second one to have arrived if the code published two. `streamForUser` maps each event through an
 * async mapper, so an announcement is never synchronous with the write that made it.
 */
async function untilAnnounced(stream: { ids(): string[] }, count: number): Promise<string[]> {
  const deadline = Date.now() + 10_000;
  while (stream.ids().length < count && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(stream.ids().length, count, `expected ${count} announcement(s), got ${JSON.stringify(stream.ids())}`);
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(stream.ids().length, count, `a second announcement followed: ${JSON.stringify(stream.ids())}`);
  return stream.ids();
}

// ── fixtures ───────────────────────────────────────────────────────────────────────────────────

async function insertUser(): Promise<string> {
  const id = randomUUID();
  await sql.query(
    `INSERT INTO "user"("id","email","name","password_hash") VALUES ($1,$2,'watch events','h')`,
    [id, `${id}@watch-events.invalid`],
  );
  return id;
}

async function insertRunner(owner: string): Promise<string> {
  const id = randomUUID();
  await sql.query(
    `INSERT INTO "runner"("id","name","owner_id","token_hash","status","last_heartbeat_at","capabilities")
     VALUES ($1,'watch events',$2,'h','ONLINE',clock_timestamp(),'{}'::text[])`,
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

/** An observer that has run: started on an online runner, with a runtime behind it. */
async function insertSession(owner: string, runnerId: string): Promise<string> {
  const id = randomUUID();
  await sql.query(
    `INSERT INTO "session"("id","title","prompt","owner_id","creator_id","updated_at","status","assigned_runner_id",
                           "provider","provider_builtin","num_turns","started_at","runtime_session_id")
     VALUES ($1,'watch observer','the opening prompt',$2,$2,now(),'AWAITING_INPUT',$3,'claude',TRUE,1,now(),$4)`,
    [id, owner, runnerId, `runtime-${id}`],
  );
  return id;
}

async function createWatch(
  owner: string,
  body: { targets: string[]; action: 'NOTIFY_USER' | 'RESUME_SESSION'; observerSessionId?: string },
) {
  return watches.create(owner, {
    predicateVersion: 1,
    predicate: ALL_TERMINAL,
    targets: body.targets.map((id) => ({ kind: 'TASK', id })),
    action: body.action,
    ttlSeconds: WATCH_LIMITS.minTtlSeconds,
    ...(body.observerSessionId ? { observerSessionId: body.observerSessionId } : {}),
  } as unknown as CreateWatchDto);
}

/** Its TTL runs out: `expires_at` moves into the past, and the watch is due no later than that. */
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

async function deliveryStateOf(watchId: string): Promise<string[]> {
  const { rows } = await sql.query<{ state: string }>(
    `SELECT d."state" FROM "watch_delivery" d
       LEFT JOIN "watch_match" m ON m."id" = d."match_id"
      WHERE COALESCE(m."watch_id", d."watch_id") = $1
      ORDER BY d."created_at", d."id"`,
    [watchId],
  );
  return rows.map((row) => row.state);
}

// ── the four changes no other event accompanies ────────────────────────────────────────────────

test('an agent making a watch and releasing it is announced, once each — and a release that releases nothing is not', { skip, timeout: 120_000 }, async () => {
  const owner = await insertUser();
  const stream = announcements(owner);

  const watch = await createWatch(owner, { targets: [await insertTask(owner, 'OPEN')], action: 'NOTIFY_USER' });
  assert.equal(watch.state, 'ACTIVE', 'the fixture condition does not hold at create');
  assert.deepEqual(await untilAnnounced(stream, 1), [watch.id], 'making a watch is announced');

  await watches.cancel(owner, watch.id);
  assert.deepEqual(await untilAnnounced(stream, 2), [watch.id, watch.id], 'releasing it is announced');

  // A second cancel decides nothing and writes nothing, so there is nothing for another client to
  // re-read: an announcement here would be a refetch the server cannot justify.
  await watches.cancel(owner, watch.id);
  await untilAnnounced(stream, 2);

  assert.deepEqual(stream.others(), [], 'nothing else rode the owner\'s stream');
});

test('a watch that runs out of time is announced, though nothing about a task or a session changed', { skip, timeout: 120_000 }, async () => {
  const owner = await insertUser();
  const runner = await insertRunner(owner);
  const observer = await insertSession(owner, runner);
  const stream = announcements(owner);

  const watch = await createWatch(owner, {
    targets: [await insertTask(owner, 'OPEN')],
    action: 'RESUME_SESSION',
    observerSessionId: observer,
  });
  await untilAnnounced(stream, 1); // the create

  // Nothing observable changed: the deadline simply passed, which no event in this system reports.
  await expire(watch.id);
  assert.equal((await evaluator.evaluate(watch.id)).outcome, 'EXPIRED');
  assert.deepEqual(await untilAnnounced(stream, 2), [watch.id, watch.id]);
});

test('a NOTIFY_USER delivery is announced — the one change that writes no row a client already reads', { skip, timeout: 120_000 }, async () => {
  const owner = await insertUser();
  const stream = announcements(owner);

  // Matched at create: the condition already holds, so the create path records the Match and its
  // delivery, and the announcement below is the delivery's, not a later evaluation's.
  const watch = await createWatch(owner, { targets: [await insertTask(owner, 'DONE')], action: 'NOTIFY_USER' });
  assert.equal(watch.state, 'MATCHED');
  await untilAnnounced(stream, 1); // the create

  const delivery = await worker();
  const results = await delivery.drain();
  assert.deepEqual(results.map((result) => result.outcome), ['DELIVERED']);
  assert.deepEqual(await deliveryStateOf(watch.id), ['DELIVERED']);

  // The Match carries a reason and a per-target snapshot, and the announcement carries neither —
  // `announcements()` asserts the payload's whole shape as each one arrives.
  const { rows: [match] } = await sql.query<{ reason: string; targets: number }>(
    `SELECT "reason", jsonb_array_length("per_target_snapshot" -> 'targets') AS "targets"
       FROM "watch_match" WHERE "watch_id" = $1`,
    [watch.id],
  );
  assert.ok(match.reason.length > 0 && match.targets > 0, 'the fixture Match has something to leak');
  assert.deepEqual(await untilAnnounced(stream, 2), [watch.id, watch.id]);
});

test('a delivery that becomes a dead letter is announced, and a delivery still retrying is not', { skip, timeout: 120_000 }, async () => {
  const owner = await insertUser();
  const runner = await insertRunner(owner);
  const observer = await insertSession(owner, runner);
  const stream = announcements(owner);

  const watch = await createWatch(owner, {
    targets: [await insertTask(owner, 'DONE')],
    action: 'RESUME_SESSION',
    observerSessionId: observer,
  });
  assert.equal(watch.state, 'MATCHED');
  await untilAnnounced(stream, 1); // the create

  // The observer is moved to Completed before the wake is attempted: a watch does not reopen it, so
  // the wake is refused, and a refusal is a dead letter on its first attempt rather than a retry.
  await sql.query(`UPDATE "session" SET "completed_at" = now() WHERE "id" = $1`, [observer]);

  const delivery = await worker();
  const results = await delivery.drain();
  assert.deepEqual(results.map((result) => result.outcome), ['DEAD_LETTER']);
  assert.deepEqual(await deliveryStateOf(watch.id), ['DEAD_LETTER']);
  assert.deepEqual(await untilAnnounced(stream, 2), [watch.id, watch.id]);

  // And the negative it is paired with: the same delivery redriven, refused again on its way to the
  // same dead letter, announces once more and not twice — one settlement, one announcement.
  await sql.query(
    `UPDATE "watch_delivery" SET "state" = 'PENDING', "attempts" = 0, "next_attempt_at" = now(), "dead_lettered_at" = NULL
      WHERE "match_id" IN (SELECT "id" FROM "watch_match" WHERE "watch_id" = $1)`,
    [watch.id],
  );
  assert.deepEqual((await delivery.drain()).map((result) => result.outcome), ['DEAD_LETTER']);
  await untilAnnounced(stream, 3);
});
