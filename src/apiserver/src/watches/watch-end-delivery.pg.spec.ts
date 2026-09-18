/**
 * A Watch's REVOKED or UNRESOLVABLE end, delivered, against a real PostgreSQL (docs/watch-contract.md §3,
 * §7, contract vectors `revoked-wakes-a-waiting-observer-with-no-target-state`,
 * `unresolvable-wakes-a-waiting-observer` and `cancelled-watch-wakes-nobody`). When a RESUME_SESSION watch
 * is revoked or becomes unresolvable, its observer gets exactly one turn that says so, however often the
 * watch is evaluated, however many workers race the delivery, and however often it is redelivered. A
 * revoked watch's turn says nothing about its targets. An observer whose life is over is left as it is,
 * with a dead letter on the watch's own read, and a cancelled watch wakes nobody.
 *
 * The cases use the collaborators production uses, as `watch-expiry-delivery.pg.spec.ts` does: the
 * evaluator's own landing, `SessionsService.createTurn` writing real `conversation_turn` rows, and
 * `RunnerApiController`'s inbox claim and turn completion. A case revokes a watch by giving its target to
 * another account, and makes one unresolvable by deleting its only target. Those are the two conditions the
 * evaluator decides these ends on.
 *
 * An end wake no runner has taken yet can still leave the observer's queue unrun: a failed running turn
 * drains it, an interrupt deletes it, a withdrawal deletes it alone. Its delivery then says so as a dead
 * letter instead of going on reading DELIVERED; those cases go through the production turn completion,
 * interrupt and cancelQueuedTurn.
 *
 *     bash scripts/run-pg-spec.sh src/apiserver/src/watches/watch-end-delivery.pg.spec.ts
 *
 * Non-destructive: every row carries an id this run generated, and the constraint drill runs in a
 * transaction it rolls back. Before each case, the watches and deliveries left by earlier cases are
 * retired, so the evaluators and workers a case runs claim only that case's rows.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { after, before, beforeEach, test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';

import { ConflictException } from '@nestjs/common';
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
import type { RealtimeService } from '../realtime/realtime.service';
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
const ENDS = ['REVOKED', 'UNRESOLVABLE'] as const;
type End = (typeof ENDS)[number];

const MIGRATIONS = path.resolve(__dirname, '../../prisma/migrations');
const CONTRACT = JSON.parse(readFileSync(path.resolve(__dirname, '../../../../contracts/watch.contract.json'), 'utf8'));
/** What the contract says each end's turn is keyed under and carries. */
const END_TURNS: Record<End, { clientTurnId: string; payload: string[] }> =
  CONTRACT.actions.find((action: { kind: string }) => action.kind === 'RESUME_SESSION').endTurns.delivered;

/** The key the contract gives this watch's end turn. */
const endKey = (end: End, watchId: string) => END_TURNS[end].clientTurnId.replace('<watchId>', watchId);

/** A collaborator a case does not observe: every method answers undefined. Not a thenable. */
const inert = <T>(): T =>
  new Proxy({}, { get: (_target, property) => (property === 'then' ? undefined : () => undefined) }) as T;

// ── what the workers tell the rest of the system ───────────────────────────────────────────────

let queueSignals = 0;
const queue = { notifySessionQueued: () => { queueSignals += 1; } };
const realtime = { notifyInbox: () => undefined, publishQueuedTurnsChanged: () => undefined };
const push = { notifyWatchMatched: async () => undefined } as unknown as PushService;
/** A hint source that emits nothing: every evaluation here comes from the sweep or a direct call. */
const noHints = { localPublications: () => EMPTY } as unknown as RealtimeService;

// ── the harness ────────────────────────────────────────────────────────────────────────────────

let sql: Client;
let prisma: PrismaClient;
let watches: WatchesService;
/** Never started: a case lands an evaluation by calling it. */
let evaluator: WatchEvaluatorService;
/** The account a revoked watch's target is given to. */
let stranger: string;
const clients: PrismaClient[] = [];
const loops: Array<{ stop(): Promise<unknown> }> = [];

/** Refuses the end delivery of the watches a case names, so the landing that writes it fails the way a real fault would. */
const FAULTS = `
  CREATE TABLE "pccspec_watch_end_fault" ("watch_id" uuid PRIMARY KEY);
  CREATE FUNCTION "pccspec_watch_end_fault_refuse"() RETURNS trigger LANGUAGE plpgsql AS $$
  BEGIN
    IF NEW."kind" IN ('REVOKED', 'UNRESOLVABLE') AND EXISTS (SELECT 1 FROM "pccspec_watch_end_fault" WHERE "watch_id" = NEW."watch_id") THEN
      RAISE EXCEPTION 'injected fault: no end delivery may be written for watch %', NEW."watch_id";
    END IF;
    RETURN NEW;
  END $$;
  CREATE TRIGGER "pccspec_watch_end_fault_refuse" BEFORE INSERT ON "watch_delivery"
    FOR EACH ROW EXECUTE FUNCTION "pccspec_watch_end_fault_refuse"();`;

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
  stranger = await insertUser();
});

beforeEach(async () => {
  if (skip) return;
  await quiesce();
  // The harness's own pool went with the case before this one, and a case's first write must not be
  // the call that dials it.
  await warm([prisma]);
  queueSignals = 0;
  await sql.query(`DELETE FROM "pccspec_watch_end_fault"`);
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
      `DROP TRIGGER IF EXISTS "pccspec_watch_end_fault_refuse" ON "watch_delivery";
       DROP FUNCTION IF EXISTS "pccspec_watch_end_fault_refuse"();
       DROP TABLE IF EXISTS "pccspec_watch_end_fault";`,
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
    `INSERT INTO "user"("id","email","name","password_hash") VALUES ($1,$2,'watch end','h')`,
    [id, `${id}@watch-end.invalid`],
  );
  return id;
}

async function insertRunner(owner: string): Promise<string> {
  const id = randomUUID();
  await sql.query(
    `INSERT INTO "runner"("id","name","owner_id","token_hash","status","last_heartbeat_at","capabilities")
     VALUES ($1,'watch end',$2,'h','ONLINE',clock_timestamp(),'{}'::text[])`,
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
 * makes an ended one REVIVABLE, so an end turn that leaves it alone is refusing, not unable.
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

/**
 * A watch on one OPEN task: nothing it watches holds, so it is live. With an observer it is a RESUME_SESSION
 * watch that session waits on; without one it notifies its user.
 */
async function waitingWatch(owner: string, observerSessionId?: string): Promise<{ watchId: string; task: string }> {
  const task = await insertTask(owner, 'OPEN');
  const watch = await watches.create(owner, {
    predicateVersion: 1,
    predicate: ALL_TERMINAL,
    targets: [{ kind: 'TASK', id: task }],
    ttlSeconds: WATCH_LIMITS.minTtlSeconds,
    ...(observerSessionId ? { action: 'RESUME_SESSION', observerSessionId } : { action: 'NOTIFY_USER' }),
  } as unknown as CreateWatchDto);
  assert.equal(watch.state, 'ACTIVE', 'the fixture condition does not hold at create');
  return { watchId: watch.id, task };
}

/**
 * What the evaluator ends a watch on. REVOKED: its target now belongs to another account, and has failed,
 * so a Match would be decided if permission were not rechecked first. UNRESOLVABLE: its only target is gone.
 */
async function bringAbout(end: End, task: string): Promise<void> {
  const { rowCount } = end === 'REVOKED'
    ? await sql.query(`UPDATE "task" SET "owner_id" = $2, "status" = 'FAILED' WHERE "id" = $1`, [task, stranger])
    : await sql.query(`DELETE FROM "task" WHERE "id" = $1`, [task]);
  assert.equal(rowCount, 1);
}

/** A waiting RESUME_SESSION watch, ended REVOKED or UNRESOLVABLE by the evaluator. */
async function endedWatch(end: End, owner: string, observer: string): Promise<{ watchId: string; task: string }> {
  const waiting = await waitingWatch(owner, observer);
  await bringAbout(end, waiting.task);
  assert.equal((await evaluator.evaluate(waiting.watchId)).outcome, end);
  return waiting;
}

/**
 * Its TTL runs out: `expires_at` moves into the past, and a scheduled watch is due no later than that. The
 * moment is whole milliseconds, like every `expires_at` the service writes, because a pause or cancel
 * compares the value it read back at that precision.
 */
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

interface DeliveryRow {
  id: string;
  kind: string;
  action: string;
  state: string;
  attempts: number;
  lastError: string | null;
  snapshot: unknown;
  due: boolean;
}

/** Every delivery a watch has: its Matches' and its end's. */
async function deliveriesOf(watchId: string): Promise<DeliveryRow[]> {
  const { rows } = await sql.query<DeliveryRow>(
    `SELECT d."id", d."kind", d."action", d."state", d."attempts", d."last_error" AS "lastError",
            d."expiry_snapshot" AS "snapshot", d."next_attempt_at" <= now() AS "due"
       FROM "watch_delivery" d LEFT JOIN "watch_match" m ON m."id" = d."match_id"
      WHERE d."watch_id" = $1 OR m."watch_id" = $1
      ORDER BY d."created_at", d."id"`,
    [watchId],
  );
  return rows;
}

async function onlyEnd(watchId: string, end: End): Promise<DeliveryRow> {
  const rows = await deliveriesOf(watchId);
  assert.deepEqual(rows.map((row) => row.kind), [end], `a ${end} watch has one delivery, its end's: ${JSON.stringify(rows)}`);
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

/** The one structured payload a turn carries. */
function payloadOf(content: string | null): Record<string, unknown> {
  const fenced = [...(content ?? '').matchAll(/```json\n([\s\S]*?)\n```/g)];
  assert.equal(fenced.length, 1, 'one structured payload');
  return JSON.parse(fenced[0][1]);
}

/** Whatever in a turn's text is about a watch's targets: the ids given, and the words a target or a snapshot is written in. */
function targetMentions(content: string | null, ids: readonly string[]): string[] {
  const text = content ?? '';
  return [...ids, '"targets"', '"latestSnapshot"', '"changedTargets"', '"observed"', '"leaves"', '"status"', 'FAILED', 'OPEN']
    .filter((needle) => text.includes(needle));
}

// ── cases ──────────────────────────────────────────────────────────────────────────────────────

test('0263: a REVOKED or UNRESOLVABLE delivery names its watch, is RESUME_SESSION and carries no snapshot, a watch has one end delivery, and the widened CHECKs refuse no row 0261 allowed', { skip, timeout: 120_000 }, async () => {
  const owner = await insertUser();
  const observer = await insertSession(owner, 'AWAITING_INPUT', await insertRunner(owner));

  const { rows: [{ def }] } = await sql.query<{ def: string }>(
    `SELECT pg_get_constraintdef("oid") AS "def" FROM "pg_constraint" WHERE "conname" = 'watch_delivery_kind_chk'`,
  );
  assert.deepEqual([...def.matchAll(/'([A-Z_]+)'/g)].map((m) => m[1]).sort(), ['EXPIRY', 'MATCH', 'REVOKED', 'UNRESOLVABLE'], def);

  const matched = await watches.create(owner, {
    predicateVersion: 1,
    predicate: ALL_TERMINAL,
    targets: [{ kind: 'TASK', id: await insertTask(owner, 'FAILED') }],
    action: 'RESUME_SESSION',
    observerSessionId: observer,
    ttlSeconds: WATCH_LIMITS.minTtlSeconds,
  } as unknown as CreateWatchDto);
  assert.equal(matched.state, 'MATCHED');
  const matchId = matched.matches[0].id;
  const snapshot = JSON.stringify({ evaluatedAt: new Date().toISOString(), targets: [] });
  const insertDelivery = (row: Record<string, unknown>) => {
    const full: Record<string, unknown> = { id: randomUUID(), action: 'RESUME_SESSION', ...row };
    const cols = Object.keys(full);
    return sql.query(
      `INSERT INTO "watch_delivery" (${cols.map((col) => `"${col}"`).join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')})`,
      Object.values(full),
    );
  };

  const { watchId } = await waitingWatch(owner, observer);
  // PostgreSQL reports the first CHECK a row violates, in constraint-name order, so each counter-example
  // below breaks exactly one rule.
  for (const kind of ENDS) {
    for (const [over, why] of [
      [{ watch_id: null }, 'an end that names no watch is a delivery of nothing'],
      [{ match_id: matchId }, 'an end that also names a Match is two deliveries in one row'],
      [{ expiry_snapshot: snapshot }, 'only an expiry carries a snapshot, so this row has no column that could say what the targets were'],
      [{ action: 'NOTIFY_USER' }, 'the end turn is owed to a waiting session, and a notification has none'],
    ] as Array<[Record<string, unknown>, string]>) {
      await refuses(() => insertDelivery({ kind, watch_id: watchId, ...over }), /watch_delivery_kind_shape_chk/, `${kind}: ${why}`);
    }
  }

  // The row that breaks none is accepted, and is then the watch's one end: no second end of any kind joins it.
  await insertDelivery({ kind: 'REVOKED', watch_id: watchId });
  for (const row of [{ kind: 'REVOKED' }, { kind: 'UNRESOLVABLE' }, { kind: 'EXPIRY', expiry_snapshot: snapshot }]) {
    await refuses(
      () => insertDelivery({ watch_id: watchId, ...row }),
      /watch_delivery_expiry_watch_key/,
      `a watch ends once, so its REVOKED delivery leaves no room for a ${row.kind} one`,
    );
  }

  // The table now holds a row of every kind. Adding 0263's CHECKs back over those rows refuses none of
  // them. Putting 0261's narrower CHECKs back over the same rows refuses the REVOKED and UNRESOLVABLE
  // ones. So the rewrite widened the set and narrowed nothing, and the drill's rows are the ones 0263
  // exists for.
  await insertDelivery({ kind: 'UNRESOLVABLE', watch_id: (await waitingWatch(owner, observer)).watchId });
  await insertDelivery({ kind: 'EXPIRY', watch_id: (await waitingWatch(owner, observer)).watchId, expiry_snapshot: snapshot });
  const { rows: kinds } = await sql.query<{ kind: string }>(`SELECT DISTINCT "kind" FROM "watch_delivery" ORDER BY 1`);
  assert.deepEqual(kinds.map((row) => row.kind), ['EXPIRY', 'MATCH', 'REVOKED', 'UNRESOLVABLE']);
  const migration = (name: string) => readFileSync(path.join(MIGRATIONS, name, 'migration.sql'), 'utf8');
  const widened = migration('0263_watch_revoked_unresolvable_delivery');
  const narrow = migration('0261_watch_expiry_delivery');
  const narrowStart = narrow.indexOf('ADD CONSTRAINT "watch_delivery_kind_chk"');
  assert.ok(narrowStart > 0, "0261's CHECKs were not found where the drill reads them");
  const rehearse = async (statements: string) => {
    await sql.query('BEGIN');
    try {
      await sql.query(statements);
    } finally {
      await sql.query('ROLLBACK');
    }
  };
  await rehearse(widened.slice(widened.indexOf('BEGIN;') + 'BEGIN;'.length, widened.lastIndexOf('COMMIT;')));
  await refuses(
    () => rehearse(
      `ALTER TABLE "watch_delivery" DROP CONSTRAINT "watch_delivery_kind_chk", DROP CONSTRAINT "watch_delivery_kind_shape_chk",
       ${narrow.slice(narrowStart, narrow.indexOf(';', narrowStart))}`,
    ),
    /check constraint "watch_delivery_kind_(shape_)?chk" of relation "watch_delivery" is violated by some row/,
    "0261's definitions admit no REVOKED or UNRESOLVABLE row",
  );
  const { rows: [{ restored }] } = await sql.query<{ restored: string }>(
    `SELECT pg_get_constraintdef("oid") AS "restored" FROM "pg_constraint" WHERE "conname" = 'watch_delivery_kind_chk'`,
  );
  assert.equal(restored, def, 'the drill left the CHECK changed');
});

test('the evaluator lands REVOKED and UNRESOLVABLE together with their end delivery, once, however often and however concurrently the watch is evaluated', { skip, timeout: 120_000 }, async () => {
  const owner = await insertUser();
  const observer = await insertSession(owner, 'AWAITING_INPUT', await insertRunner(owner));

  for (const end of ENDS) {
    const { watchId, task } = await waitingWatch(owner, observer);
    await bringAbout(end, task);

    await sql.query(`INSERT INTO "pccspec_watch_end_fault" VALUES ($1)`, [watchId]);
    await assert.rejects(evaluator.evaluate(watchId), /injected fault: no end delivery may be written/);
    assert.equal(await watchStateOf(watchId), 'ACTIVE', `${end} outlived the delivery it was landed with`);
    assert.deepEqual(await deliveriesOf(watchId), []);

    // The control: the same landing with nothing refusing it, raced by three replicas.
    await sql.query(`DELETE FROM "pccspec_watch_end_fault"`);
    const replicas = await Promise.all([evaluatorFor(), evaluatorFor()]);
    const raced = await Promise.all([evaluator, ...replicas].map((replica) => replica.evaluate(watchId)));
    assert.deepEqual(raced.map((evaluation) => evaluation.outcome).sort(), [end, 'SETTLED', 'SETTLED'].sort());
    const delivery = await onlyEnd(watchId, end);
    assert.equal(delivery.action, 'RESUME_SESSION');
    assert.equal(delivery.state, 'PENDING');
    assert.equal(delivery.attempts, 0);
    assert.equal(delivery.due, true, `${end}: and is due at once`);
    assert.equal(delivery.snapshot, null, `${end}: an end other than an expiry carries no snapshot`);
    const { rows: targets } = await sql.query<{ state: string }>(`SELECT "state" FROM "watch_target" WHERE "watch_id" = $1`, [watchId]);
    assert.deepEqual(
      targets.map((target) => target.state),
      [end === 'REVOKED' ? 'OBSERVED' : 'GONE'],
      `${end}: a revoked target is not written down; a deleted one is recorded GONE`,
    );

    // Looked at again, by a direct call and by a sweep, it is still one row.
    assert.equal((await evaluator.evaluate(watchId)).outcome, 'SETTLED');
    await evaluator.drain();
    assert.equal((await onlyEnd(watchId, end)).id, delivery.id);
  }

  // A notification has nobody waiting on it: the end is recorded, and nothing is queued to deliver.
  for (const end of ENDS) {
    const { watchId, task } = await waitingWatch(owner);
    await bringAbout(end, task);
    assert.equal((await evaluator.evaluate(watchId)).outcome, end);
    assert.deepEqual(await deliveriesOf(watchId), [], `${end}: a NOTIFY_USER watch was given an end delivery`);
  }
});

test('the observer waiting on the watch gets one turn, keyed watch:<id>:revoked or watch:<id>:unresolvable, that names the end and nothing about the targets, however many workers race it and however often it is redelivered', { skip, timeout: 120_000 }, async () => {
  const owner = await insertUser();
  const runner = await insertRunner(owner);

  for (const end of ENDS) {
    queueSignals = 0;
    const observer = await insertSession(owner, 'AWAITING_INPUT', runner);
    const { watchId, task } = await endedWatch(end, owner, observer);
    const { id: deliveryId } = await onlyEnd(watchId, end);

    const workers = await Promise.all([worker(), worker(), worker()]);
    const raced = (await Promise.all(workers.map(({ delivery }) => delivery.drain()))).flat();
    assert.deepEqual(outcomesFor(raced, deliveryId), ['DELIVERED'], end);

    const turns = await turnsOn(observer);
    assert.equal(turns.length, 1, `${end}: one end, one turn`);
    const [turn] = turns;
    assert.equal(turn.clientTurnId, endKey(end, watchId));
    assert.equal(turn.clientTurnId, `watch:${watchId}:${end.toLowerCase()}`);
    assert.equal(turn.kind, 'message');
    assert.equal(turn.sendIntent, 'NEXT_TURN');
    assert.equal(turn.status, 'PENDING');
    assert.equal((await sessionOf(observer)).status, 'PENDING', `${end}: a parked observer waits for a runner slot like any sent message`);
    assert.equal(queueSignals, 1, `${end}: the queue was told once`);
    const delivered = await onlyEnd(watchId, end);
    assert.equal(delivered.state, 'DELIVERED');
    assert.equal(delivered.attempts, 0);

    // What the session reads: a line naming the end, then the structured payload the contract lists, and
    // nothing about the targets — not their ids, their state, the account a revoked one went to, or a snapshot.
    const payload = payloadOf(turn.content);
    assert.deepEqual(Object.keys(payload), END_TURNS[end].payload);
    assert.deepEqual(payload, { watchId, state: end });
    assert.ok(turn.content?.startsWith(`Orbit Watch ${watchId} ended ${end}: `), turn.content ?? '');
    assert.deepEqual(targetMentions(turn.content, [task, stranger]), [], `${end}: the turn says something about the targets`);

    // Redelivered after its turn was written, as by a requeue or an acknowledgement that never landed: the
    // key collapses it onto the turn that is already there.
    await sql.query(
      `UPDATE "watch_delivery" SET "state" = 'PENDING', "delivered_at" = NULL, "next_attempt_at" = now() WHERE "id" = $1`,
      [deliveryId],
    );
    assert.deepEqual(outcomesFor(await workers[1].delivery.drain(), deliveryId), ['DELIVERED']);
    assert.deepEqual(await turnsOn(observer), turns, `${end}: the redelivery wrote a second turn or changed the first`);
    assert.equal(queueSignals, 1, `${end}: the redelivery queued the session again`);
    assert.equal((await onlyEnd(watchId, end)).state, 'DELIVERED');
  }

  // The paired control, last: the same worker's expiry turn for the same kind of watch names its target,
  // so the absence asserted above is the turn's, not the check's.
  const control = await insertSession(owner, 'AWAITING_INPUT', runner);
  const expiring = await waitingWatch(owner, control);
  await expire(expiring.watchId);
  assert.equal((await evaluator.evaluate(expiring.watchId)).outcome, 'EXPIRED');
  await (await worker()).delivery.drain();
  const [expiryTurn] = await turnsOn(control);
  assert.equal(expiryTurn.clientTurnId, `watch:${expiring.watchId}:expired`);
  const seen = targetMentions(expiryTurn.content, [expiring.task]);
  assert.ok(seen.includes(expiring.task) && seen.includes('"latestSnapshot"'), `the check saw only ${JSON.stringify(seen)} in an expiry turn`);
});

test('a worker whose lease on an end delivery was taken over writes nothing, neither turn nor acknowledgement, and the takeover delivers the one turn', { skip, timeout: 120_000 }, async () => {
  const owner = await insertUser();
  const runner = await insertRunner(owner);

  for (const end of ENDS) {
    const observer = await insertSession(owner, 'AWAITING_INPUT', runner);
    const { watchId } = await endedWatch(end, owner, observer);
    const { id: deliveryId } = await onlyEnd(watchId, end);

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
    assert.ok(claim, `${end}: A holds the delivery`);
    const attempt = a.delivery.deliver(claim);
    await atTheQueue;

    // A's lease runs out while it waits, and the sweep takes the delivery back.
    await eventually(`${end}: A's lease to run out`, () => leaseLapsed(deliveryId), (lapsed) => lapsed);
    assert.equal(await b.delivery.reclaimExpired(), 1);
    const reclaimed = await onlyEnd(watchId, end);
    assert.equal(reclaimed.state, 'PENDING');
    assert.equal(reclaimed.attempts, 1, `${end}: the abandoned attempt is counted`);
    assert.match(reclaimed.lastError ?? '', /^LEASE_EXPIRED:/);

    // A resumes: its acknowledgement no longer matches the row, and its turn is rolled back with it.
    release();
    assert.equal(await attempt, 'LEASE_LOST');
    assert.deepEqual(await turnsOn(observer), [], `${end}: a worker that lost its lease wrote a turn`);
    assert.equal((await sessionOf(observer)).status, 'AWAITING_INPUT', `${end}: a worker that lost its lease moved the session`);

    assert.deepEqual(outcomesFor(await b.delivery.drain(), deliveryId), ['DELIVERED']);
    assert.deepEqual((await turnsOn(observer)).map((turn) => turn.clientTurnId), [endKey(end, watchId)]);
    const settled = await onlyEnd(watchId, end);
    assert.equal(settled.state, 'DELIVERED');
    assert.equal(settled.attempts, 1);

    // A, trying again under the lease it lost, changes nothing.
    assert.equal(await a.delivery.deliver(claim), 'LEASE_LOST');
    assert.equal((await turnsOn(observer)).length, 1);
  }
});

test('an end turn never revives an observer whose life is over: Completed, ended, ending and Trash are dead letters the watch read shows', { skip, timeout: 180_000 }, async () => {
  const owner = await insertUser();
  const runner = await insertRunner(owner);
  const { delivery } = await worker();
  const cases = [
    { name: 'moved to Completed', finish: `UPDATE "session" SET "completed_at" = now() WHERE "id" = $1`, code: 'OBSERVER_SESSION_COMPLETED' },
    { name: 'its run succeeded', finish: `UPDATE "session" SET "status" = 'SUCCEEDED', "finished_at" = now() WHERE "id" = $1`, code: 'OBSERVER_SESSION_ENDED' },
    { name: 'ended, interrupted with an end reason', finish: `UPDATE "session" SET "status" = 'INTERRUPTED', "end_reason" = 'ended' WHERE "id" = $1`, code: 'OBSERVER_SESSION_ENDED' },
    { name: 'being ended', finish: `UPDATE "session" SET "cancel_requested_at" = now(), "end_reason" = 'ended' WHERE "id" = $1`, code: 'OBSERVER_SESSION_ENDED' },
    { name: 'in Trash', finish: `UPDATE "session" SET "deleted_at" = now() WHERE "id" = $1`, code: 'OBSERVER_SESSION_IN_TRASH' },
  ];
  for (const end of ENDS) {
    for (const { name, finish, code } of cases) {
      queueSignals = 0;
      const observer = await insertSession(owner, 'AWAITING_INPUT', runner);
      const { watchId } = await endedWatch(end, owner, observer);
      const { id: deliveryId } = await onlyEnd(watchId, end);
      await sql.query(finish, [observer]);
      const before = await sessionOf(observer);

      assert.deepEqual(outcomesFor(await delivery.drain(), deliveryId), ['DEAD_LETTER'], `${end}, ${name}: not refused for good`);
      assert.deepEqual(await turnsOn(observer), [], `${end}, ${name}: a turn was written`);
      assert.deepEqual(await sessionOf(observer), before, `${end}, ${name}: the observer was changed`);
      assert.equal(queueSignals, 0, `${end}, ${name}: the observer was queued`);
      const settled = await onlyEnd(watchId, end);
      assert.equal(settled.state, 'DEAD_LETTER', `${end}, ${name}`);
      assert.equal(settled.attempts, 1, `${end}, ${name}: a refusal is retried`);
      assert.ok(settled.lastError?.startsWith(`${code}:`), `${end}, ${name}: ${settled.lastError}`);

      // The dead letter is on the watch's own read, with why, and with nothing about the targets.
      const view = await watches.get(owner, watchId);
      assert.equal(view.state, end, name);
      assert.deepEqual(
        view.expiryDeliveries.map(({ id, kind, state, attempts, lastError, deadLetteredAt, expirySnapshot }) => (
          { id, kind, state, attempts, lastError, deadLettered: deadLetteredAt !== null, expirySnapshot }
        )),
        [{ id: deliveryId, kind: end, state: 'DEAD_LETTER', attempts: 1, lastError: settled.lastError, deadLettered: true, expirySnapshot: null }],
        `${end}, ${name}: the dead letter is missing from the watch read`,
      );
    }

    // The paired control, last: the same end on an observer that is alive is delivered.
    const alive = await insertSession(owner, 'AWAITING_INPUT', runner);
    const { watchId: aliveWatch } = await endedWatch(end, owner, alive);
    assert.deepEqual(outcomesFor(await delivery.drain(), (await onlyEnd(aliveWatch, end)).id), ['DELIVERED']);
    assert.deepEqual((await turnsOn(alive)).map((turn) => turn.clientTurnId), [endKey(end, aliveWatch)]);
  }
});

test('a cancelled watch wakes nobody, even one whose revocation, unresolvability or expiry had already come about, while the same watches left alone each wake their observer once', { skip, timeout: 120_000 }, async () => {
  const owner = await insertUser();
  const observer = await insertSession(owner, 'AWAITING_INPUT', await insertRunner(owner));
  const { delivery } = await worker();

  // Each is cancelled while live, after the condition it would have ended on already holds, and before
  // any evaluation looked.
  const cancelled: string[] = [];
  for (const end of ENDS) {
    const { watchId, task } = await waitingWatch(owner, observer);
    await bringAbout(end, task);
    assert.equal((await watches.cancel(owner, watchId)).state, 'CANCELLED');
    cancelled.push(watchId);
  }
  const paused = await waitingWatch(owner, observer);
  assert.equal((await watches.pause(owner, paused.watchId)).state, 'PAUSED');
  await expire(paused.watchId);
  assert.equal((await watches.cancel(owner, paused.watchId)).state, 'CANCELLED');
  cancelled.push(paused.watchId);
  const plain = await waitingWatch(owner, observer);
  assert.equal((await watches.cancel(owner, plain.watchId)).state, 'CANCELLED');
  cancelled.push(plain.watchId);

  for (const watchId of cancelled) assert.equal((await evaluator.evaluate(watchId)).outcome, 'SETTLED', 'a cancelled watch was decided again');
  await evaluator.drain();
  assert.deepEqual(await delivery.drain(), [], 'the worker found something to deliver');
  for (const watchId of cancelled) {
    assert.equal(await watchStateOf(watchId), 'CANCELLED');
    assert.deepEqual(await deliveriesOf(watchId), [], 'a cancelled watch has a delivery');
    const view = await watches.get(owner, watchId);
    assert.deepEqual([view.matches, view.expiryDeliveries], [[], []]);
  }
  assert.deepEqual(await turnsOn(observer), [], 'a cancelled watch woke its observer');
  assert.equal((await sessionOf(observer)).status, 'AWAITING_INPUT');
  assert.equal(queueSignals, 0);

  // Nor can an end be cancelled into silence: a watch that has ended is not live, and its one delivery stays.
  const revoked = await endedWatch('REVOKED', owner, observer);
  await assert.rejects(watches.cancel(owner, revoked.watchId), ConflictException);
  assert.equal((await onlyEnd(revoked.watchId, 'REVOKED')).state, 'PENDING');

  // The paired control, last: on the same observer, with the same evaluator and worker, the same three
  // endings left uncancelled each wake it once.
  const unresolvable = await endedWatch('UNRESOLVABLE', owner, observer);
  const expired = await waitingWatch(owner, observer);
  assert.equal((await watches.pause(owner, expired.watchId)).state, 'PAUSED');
  await expire(expired.watchId);
  assert.equal((await evaluator.evaluate(expired.watchId)).outcome, 'EXPIRED');
  await delivery.drain();
  assert.deepEqual(
    (await turnsOn(observer)).map((turn) => turn.clientTurnId).sort(),
    [endKey('REVOKED', revoked.watchId), endKey('UNRESOLVABLE', unresolvable.watchId), `watch:${expired.watchId}:expired`].sort(),
  );
});

test('with the evaluator and the delivery worker running and nothing called by hand, a target given away and a target deleted each wake a RUNNING observer behind its running turn, and the runner is handed turns that say nothing about the targets', { skip, timeout: 120_000 }, async () => {
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
  const revoked = await waitingWatch(owner, observer);
  const unresolvable = await waitingWatch(owner, observer);
  const keys = [endKey('REVOKED', revoked.watchId), endKey('UNRESOLVABLE', unresolvable.watchId)];

  // No hints reach this evaluator: the reconciliation sweep is what looks at the watches again.
  const sweeping = await evaluatorFor({ pollIntervalMs: 100, reconcileIntervalMs: 200 });
  const { delivery, prisma: pool } = await worker({ pollIntervalMs: 100 });
  sweeping.start();
  delivery.start();
  await bringAbout('REVOKED', revoked.task);
  await bringAbout('UNRESOLVABLE', unresolvable.task);

  const wakes = await eventually(
    'both end turns',
    async () => (await turnsOn(observer)).filter((turn) => keys.includes(turn.clientTurnId)),
    (turns) => turns.length === 2,
  );
  await eventually(
    'their deliveries to settle',
    async () => [...await deliveriesOf(revoked.watchId), ...await deliveriesOf(unresolvable.watchId)],
    (rows) => rows.length === 2 && rows.every((row) => row.state === 'DELIVERED'),
  );
  await sweeping.stop();
  await delivery.stop();
  assert.equal(await watchStateOf(revoked.watchId), 'REVOKED');
  assert.equal(await watchStateOf(unresolvable.watchId), 'UNRESOLVABLE');
  assert.deepEqual(wakes.map((turn) => [turn.status, turn.seq > 1]), [['PENDING', true], ['PENDING', true]], 'queued behind the running turn');
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
  assert.equal(await inbox.dequeueTurn(observer, runner, null, false, []), null, 'the runner was handed an end turn while the current turn runs');
  const handed: string[] = [];
  let running: string = current;
  for (let turnNumber = 2; turnNumber <= 3; turnNumber += 1) {
    await runnerApi.turnComplete({ id: runner }, observer, {
      turnId: running,
      status: 'SUCCEEDED',
      subtype: 'completed',
      numTurns: turnNumber,
      costUsd: 0,
    } as never);
    const next = await inbox.dequeueTurn(observer, runner, null, false, []);
    const wake = wakes.find((turn) => turn.id === next?.turnId);
    assert.ok(wake, `the runner was handed ${next?.turnId ?? 'nothing'}, not an end turn`);
    assert.ok(wake.content && next?.content?.includes(wake.content), 'with the content it was queued with');
    assert.deepEqual(targetMentions(next?.content ?? null, [revoked.task, unresolvable.task, stranger]), [], `${wake.clientTurnId} reached the runner saying something about the targets`);
    handed.push(wake.clientTurnId);
    // The runner runs what it took, so that turn has a reply before it is completed: a completion over
    // one that did not goes back to the queue, and the next take would be handed the same end turn.
    await say(wake.id, observer, 'the end turn ran');
    running = wake.id;
  }
  assert.deepEqual(handed.sort(), [...keys].sort(), 'the runner was handed each end turn once');
});

// ── a queued end wake taken off its observer's queue unrun ─────────────────────────────────────

interface QueuedEnd {
  end: End;
  observer: string;
  watchId: string;
  deliveryId: string;
  wakeId: string;
}

/**
 * An observer RUNNING a turn the runner holds, so whatever is queued for it waits behind that turn. It
 * has already said something — a completion over a turn nothing answered hands that turn back to the
 * queue, and the runner's next take would be handed it again rather than the end wake behind it.
 */
async function runningObserver(owner: string, runner: string): Promise<{ observer: string; current: string }> {
  const observer = await insertSession(owner, 'RUNNING', runner);
  const current = randomUUID();
  await sql.query(
    `INSERT INTO "conversation_turn"("id","session_id","seq","client_turn_id","kind","content","status","delivered_at","lease_deadline_at")
     VALUES ($1,$2,1,$3,'message','the turn the session is running','IN_FLIGHT',now(),now() + interval '10 minutes')`,
    [current, observer, `current-${current}`],
  );
  await say(current, observer, 'working on it');
  return { observer, current };
}

/** A watch that ended REVOKED or UNRESOLVABLE, delivered to `observer`: DELIVERED, with its end wake waiting in the queue. */
async function queuedEnd(end: End, owner: string, observer: string, pool: Awaited<ReturnType<typeof worker>>): Promise<QueuedEnd> {
  const { watchId } = await endedWatch(end, owner, observer);
  const { id: deliveryId } = await onlyEnd(watchId, end);
  assert.deepEqual(outcomesFor(await pool.delivery.drain(), deliveryId), ['DELIVERED'], end);
  const [wake] = (await turnsOn(observer)).filter((turn) => turn.clientTurnId === endKey(end, watchId));
  assert.equal(wake?.status, 'PENDING', `${end}: the end wake waits in the queue`);
  return { end, observer, watchId, deliveryId, wakeId: wake.id };
}

/** The state an ending, an interrupt and a withdrawal each meet (watch-wake-drain.ts). */
async function endQueuedBehindRunningTurn(
  end: End,
  owner: string,
  runner: string,
  pool: Awaited<ReturnType<typeof worker>>,
): Promise<QueuedEnd & { current: string }> {
  const { observer, current } = await runningObserver(owner, runner);
  return { ...(await queuedEnd(end, owner, observer, pool)), current };
}

/** The runner's own doors onto its sessions: settle a turn it ran, and take the next one queued. */
function runnerDoors(pool: Awaited<ReturnType<typeof worker>>, runner: string) {
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
  return {
    complete: (observer: string, turnId: string, status: 'SUCCEEDED' | 'FAILED') =>
      runnerApi.turnComplete({ id: runner }, observer, {
        turnId,
        status,
        subtype: status === 'FAILED' ? 'error_during_execution' : 'completed',
        ...(status === 'FAILED' ? { result: 'API Error: 529 overloaded' } : {}),
        numTurns: 2,
        costUsd: 0,
      } as never),
    take: async (observer: string) => (await inbox.dequeueTurn(observer, runner, null, false, []))?.turnId,
  };
}

/** A queued end wake the runner took: the turn in front of it finished, and the end wake is the turn running now. */
async function endTakenByRunner(end: End, owner: string, runner: string, pool: Awaited<ReturnType<typeof worker>>): Promise<QueuedEnd> {
  const { current, ...queued } = await endQueuedBehindRunningTurn(end, owner, runner, pool);
  const doors = runnerDoors(pool, runner);
  await doors.complete(queued.observer, current, 'SUCCEEDED');
  assert.equal(await doors.take(queued.observer), queued.wakeId, `${end}: the runner took the end wake`);
  return queued;
}

/**
 * The end wake was taken off the queue unrun — answered by an ending's drain, or deleted by an interrupt or
 * a withdrawal — its delivery says so on the watch's own read, and the watch is the terminal fact it was.
 */
async function assertEndDeadLettered(
  owner: string,
  queued: QueuedEnd,
  how: string,
  { code, deleted }: { code: string; deleted: boolean },
): Promise<void> {
  const why = `${queued.end}, ${how}`;
  const [wake] = (await turnsOn(queued.observer)).filter((turn) => turn.id === queued.wakeId);
  if (deleted) assert.equal(wake, undefined, `${why}: the wake is deleted as a queued message always was`);
  else assert.equal(wake?.status, 'ANSWERED', `${why}: the queue is drained as it always was`);
  const settled = await onlyEnd(queued.watchId, queued.end);
  assert.equal(settled.state, 'DEAD_LETTER', `${why}: a queued end wake no runner took still reads ${settled.state}`);
  assert.match(settled.lastError ?? '', new RegExp(`^${code}: `), why);
  const view = await watches.get(owner, queued.watchId);
  assert.equal(view.state, queued.end, `${why}: the watch is the terminal fact it was`);
  assert.deepEqual(
    view.expiryDeliveries.map(({ id, kind, state, lastError, deliveredAt, deadLetteredAt }) => (
      { id, kind, state, lastError, delivered: deliveredAt !== null, deadLettered: deadLetteredAt !== null }
    )),
    [{ id: queued.deliveryId, kind: queued.end, state: 'DEAD_LETTER', lastError: settled.lastError, delivered: false, deadLettered: true }],
    `${why}: its dead letter is on the watch's read`,
  );
}

// One case per end and per door, so a key the helper does not recognize fails under its own name.
for (const end of ENDS) {
  test(`a queued end wake keyed watch:<id>:${end.toLowerCase()} is a dead letter, not DELIVERED, when its observer's running turn fails; one the runner took stays delivered, and another observer's is left alone`, { skip, timeout: 120_000 }, async () => {
    const owner = await insertUser();
    const runner = await insertRunner(owner);
    const pool = await worker();
    const doors = runnerDoors(pool, runner);
    // Another observer of the same owner on the same runner, whose run nothing here ends.
    const bystander = await endQueuedBehindRunningTurn(end, owner, runner, pool);

    const queued = await endQueuedBehindRunningTurn(end, owner, runner, pool);
    await doors.complete(queued.observer, queued.current, 'FAILED');
    assert.equal((await sessionOf(queued.observer)).status, 'FAILED');
    await assertEndDeadLettered(owner, queued, 'the running turn failed', { code: 'OBSERVER_SESSION_ENDED', deleted: false });
    assert.deepEqual(outcomesFor(await pool.delivery.drain(), queued.deliveryId), [], 'a dead letter is never claimed again');

    // The control: the runner took the end wake, and it is the wake's own turn that fails. The engine
    // received it, so it was delivered, whatever its run came to.
    const taken = await endTakenByRunner(end, owner, runner, pool);
    // The end wake RAN, so its completion carries the reply an engine that ran produces: a turn nothing
    // answered goes back to the queue, and a run that ends with it queued drains it as a wake no runner
    // ever took, which is the death this control is about.
    await say(taken.wakeId, taken.observer, 'the end wake ran');
    await doors.complete(taken.observer, taken.wakeId, 'FAILED');
    assert.equal((await sessionOf(taken.observer)).status, 'FAILED', 'the run the end wake started failed');
    assert.equal((await onlyEnd(taken.watchId, end)).state, 'DELIVERED', 'an end wake the runner took was dead-lettered by its run failing');

    const [waiting] = (await turnsOn(bystander.observer)).filter((turn) => turn.id === bystander.wakeId);
    assert.equal(waiting?.status, 'PENDING', 'another observer lost its queued end wake');
    assert.equal((await onlyEnd(bystander.watchId, end)).state, 'DELIVERED', 'another observer\'s ending dead-lettered this one\'s end wake');
  });

  test(`a queued end wake keyed watch:<id>:${end.toLowerCase()} that an interrupt of its observer deletes is a dead letter (OBSERVER_TURN_INTERRUPTED); one the runner took stays delivered, and another observer's is left alone`, { skip, timeout: 120_000 }, async () => {
    const owner = await insertUser();
    const runner = await insertRunner(owner);
    const pool = await worker();
    const sessions = new SessionsService(pool.prisma as unknown as PrismaService, queue as never, realtime as never);
    // Another observer of the same owner on the same runner, which nobody interrupts.
    const bystander = await endQueuedBehindRunningTurn(end, owner, runner, pool);

    const queued = await endQueuedBehindRunningTurn(end, owner, runner, pool);
    await sessions.interrupt(owner, queued.observer);
    assert.equal((await sessionOf(queued.observer)).status, 'RUNNING', 'an interrupt stops a turn, and the observer lives on');
    await assertEndDeadLettered(owner, queued, 'the observer was interrupted', { code: 'OBSERVER_TURN_INTERRUPTED', deleted: true });
    assert.deepEqual(outcomesFor(await pool.delivery.drain(), queued.deliveryId), [], 'a dead letter is never claimed again');

    // The control: the runner took the end wake, and it is the wake's own turn the interrupt stops. The
    // engine received it, so it was delivered, whatever the interrupt makes of its run.
    const taken = await endTakenByRunner(end, owner, runner, pool);
    await sessions.interrupt(owner, taken.observer);
    const [stopping] = (await turnsOn(taken.observer)).filter((turn) => turn.id === taken.wakeId);
    assert.equal(stopping?.status, 'IN_FLIGHT', 'the interrupt deleted an end wake the runner had taken');
    assert.equal((await onlyEnd(taken.watchId, end)).state, 'DELIVERED', 'an end wake the runner took was dead-lettered by an interrupt');

    const [waiting] = (await turnsOn(bystander.observer)).filter((turn) => turn.id === bystander.wakeId);
    assert.equal(waiting?.status, 'PENDING', 'another observer lost its queued end wake');
    assert.equal((await onlyEnd(bystander.watchId, end)).state, 'DELIVERED', 'another observer\'s interrupt dead-lettered this one\'s end wake');
  });
}

for (const [end, other] of [['REVOKED', 'UNRESOLVABLE'], ['UNRESOLVABLE', 'REVOKED']] as const) {
  test(`a queued end wake keyed watch:<id>:${end.toLowerCase()} that its owner withdraws is a dead letter (WAKE_WITHDRAWN) for that wake alone: the observer's other queued end wake keeps its delivery, and one the runner took cannot be withdrawn`, { skip, timeout: 120_000 }, async () => {
    const owner = await insertUser();
    const runner = await insertRunner(owner);
    const pool = await worker();
    const sessions = new SessionsService(pool.prisma as unknown as PrismaService, queue as never, realtime as never);
    // Another observer of the same owner on the same runner, whose queue nobody touches.
    const bystander = await endQueuedBehindRunningTurn(end, owner, runner, pool);

    // One observer waits on two watches that ended: this end's wake is queued first, the other end's behind it.
    const { observer, current } = await runningObserver(owner, runner);
    const withdrawn = await queuedEnd(end, owner, observer, pool);
    const kept = await queuedEnd(other, owner, observer, pool);

    await sessions.cancelQueuedTurn(owner, observer, withdrawn.wakeId);
    assert.equal((await sessionOf(observer)).status, 'RUNNING', 'the observer keeps the run it has');
    await assertEndDeadLettered(owner, withdrawn, 'the end wake was withdrawn', { code: 'WAKE_WITHDRAWN', deleted: true });
    assert.deepEqual(outcomesFor(await pool.delivery.drain(), withdrawn.deliveryId), [], 'a dead letter is never claimed again');
    assert.deepEqual(
      (await turnsOn(observer)).map(({ id, status }) => ({ id, status })),
      [{ id: current, status: 'IN_FLIGHT' }, { id: kept.wakeId, status: 'PENDING' }],
      'withdrawing one end wake took more than its own turn off the queue',
    );
    assert.equal((await onlyEnd(kept.watchId, other)).state, 'DELIVERED', 'withdrawing one end wake dead-lettered the observer\'s other');

    // The control: an end wake the runner took can no longer be withdrawn, and stays delivered.
    const taken = await endTakenByRunner(end, owner, runner, pool);
    await assert.rejects(sessions.cancelQueuedTurn(owner, taken.observer, taken.wakeId), /already started or not found/);
    assert.equal((await onlyEnd(taken.watchId, end)).state, 'DELIVERED', 'an end wake the runner took was dead-lettered by a refused withdrawal');

    const [waiting] = (await turnsOn(bystander.observer)).filter((turn) => turn.id === bystander.wakeId);
    assert.equal(waiting?.status, 'PENDING', 'another observer lost its queued end wake');
    assert.equal((await onlyEnd(bystander.watchId, end)).state, 'DELIVERED', 'another observer\'s withdrawal dead-lettered this one\'s end wake');
  });
}

// A client chooses its own clientTurnId, so the words of the other ends can sit on the observer's queue too.
for (const end of ENDS) {
  test(`a queued turn keyed with another end's word under a ${end} watch is not its end wake: withdrawn, it leaves the delivery of the end wake the runner took DELIVERED`, { skip, timeout: 120_000 }, async () => {
    const owner = await insertUser();
    const runner = await insertRunner(owner);
    const pool = await worker();
    const sessions = new SessionsService(pool.prisma as unknown as PrismaService, queue as never, realtime as never);
    const taken = await endTakenByRunner(end, owner, runner, pool);

    for (const word of ['expired', 'revoked', 'unresolvable'].filter((word) => word !== end.toLowerCase())) {
      const forged = `watch:${taken.watchId}:${word}`;
      await sessions.createTurn(owner, taken.observer, { clientTurnId: forged, content: `a message keyed ${word}, not a wake`, intent: 'NEXT_TURN' });
      const [turn] = (await turnsOn(taken.observer)).filter((row) => row.clientTurnId === forged);
      assert.equal(turn?.status, 'PENDING', `${forged}: queued behind the end wake the runner took`);
      await sessions.cancelQueuedTurn(owner, taken.observer, turn.id);
      assert.deepEqual((await turnsOn(taken.observer)).filter((row) => row.clientTurnId === forged), [], `${forged}: not withdrawn`);
      const settled = await onlyEnd(taken.watchId, end);
      assert.equal(settled.state, 'DELIVERED', `withdrawing ${forged} made the ${end} delivery ${settled.state} (${settled.lastError})`);
    }
  });
}
