/**
 * Watch delivery against a real PostgreSQL: one Match, one effect — a turn on the observer session or
 * one notification — however the delivery is raced, retried, taken over or redelivered.
 *
 * Under test are the delivery worker (`watch-delivery.service.ts`) and the two writers of its rows,
 * the create path and the evaluator's landing, driven through the collaborators production uses:
 * `SessionsService.createTurn` is the real queue entry point writing real `conversation_turn` rows,
 * the runner inbox claim and turn completion are `RunnerApiController`'s own, and `PushService` is real
 * down to its HTTP/2 request, which is the one thing replaced — each APNs request is recorded instead
 * of sent. Faults are injected in the database, by a trigger that refuses one session's turns or one
 * watch's delivery, so a failure travels the path a real one takes. The endings that drain a queued
 * wake unrun — a failed turn, a lost runner, a runner finalize, an owner's end — are driven through the
 * production turn completion, reaper sweep, finalize and end; an interrupt and a withdrawal that delete
 * one from a live observer's queue, through the production interrupt and cancelQueuedTurn.
 *
 *     bash scripts/run-pg-spec.sh src/apiserver/src/watches/watch-delivery.pg.spec.ts
 *
 * Non-destructive: every row carries an id this run generated. Each case first retires the deliveries
 * earlier cases left claimable, so the workers it starts claim only that case's rows.
 */
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { after, before, beforeEach, test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';

import type { ConfigService } from '@nestjs/config';
import type { PrismaClient } from '@prisma/client';
import { MAX_PROMPT_CHARS, RunEventType, WATCH_LIMITS } from '@orbit/shared';
import { Client } from 'pg';

import { prismaClientFor } from '../prisma/prisma-client';
import { PrismaService } from '../prisma/prisma.service';
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from '../projects/coordinator-pg-test-safety';
import { PushService } from '../push/push.service';
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
import { WatchEvaluatorService } from './watch-evaluator.service';
import { WatchesService } from './watches.service';

const URL = process.env.COORDINATOR_PG_URL;
const skip = !URL;

const HOUR = 60 * 60 * 1000;

// From build/watches back to the repository root.
const CONTRACT = JSON.parse(
  readFileSync(path.resolve(__dirname, '../../../../contracts/watch.contract.json'), 'utf8'),
) as {
  limits: { maxDeliveryAttempts: number };
  actions: Array<{
    kind: string;
    payload?: string[];
    idempotency?: { clientTurnId: string };
    sendIntent?: { value: string };
  }>;
};
const RESUME = CONTRACT.actions.find((action) => action.kind === 'RESUME_SESSION')!;

const ALL_TERMINAL = { kind: 'ALL', over: 'ALL_TARGETS', leaf: 'TASK_TERMINAL' } as const;

/** A collaborator a case does not observe: every method answers undefined. Not a thenable. */
const inert = <T>(): T =>
  new Proxy({}, { get: (_target, property) => (property === 'then' ? undefined : () => undefined) }) as T;

// ── what the workers tell the rest of the system ───────────────────────────────────────────────

let queueSignals = 0;
const inboxWakes: string[] = [];
const queue = { notifySessionQueued: () => { queueSignals += 1; } };
const realtime = {
  notifyInbox: (sessionId: string) => { inboxWakes.push(sessionId); },
  publishQueuedTurnsChanged: () => undefined,
};

interface ApnsRequest {
  token: string;
  collapseId?: string;
  payload: { aps: { alert: { title: string; body: string } }; watchID?: string; generation?: number; kind?: string };
}
const apns: ApnsRequest[] = [];

const { privateKey } = generateKeyPairSync('ec', {
  namedCurve: 'prime256v1',
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});
const APNS_CONFIG = {
  get: (key: string) =>
    ({
      APNS_KEY_ID: 'watch-delivery-spec',
      APNS_TEAM_ID: 'watch-delivery-spec',
      APNS_KEY: Buffer.from(privateKey).toString('base64'),
    } as Record<string, string>)[key],
} as unknown as ConfigService;

/** The real push service, with only its HTTP/2 request to APNs replaced by a recording. */
function pushFor(prisma: PrismaClient): PushService {
  const push = new PushService(prisma as unknown as PrismaService, APNS_CONFIG);
  Object.assign(push, {
    send: async (
      _host: string,
      token: string,
      body: string,
      _auth: string,
      _pushType: string,
      _priority: string,
      collapseId?: string,
    ) => {
      apns.push({ token, collapseId, payload: JSON.parse(body) });
      return { status: 200 };
    },
  });
  return push;
}

// ── the harness ────────────────────────────────────────────────────────────────────────────────

let sql: Client;
let prisma: PrismaClient;
let watches: WatchesService;
let evaluator: WatchEvaluatorService;
const clients: PrismaClient[] = [];
const running: WatchDeliveryService[] = [];

/** Refuses the INSERTs a case names: every turn on a session, or the delivery of a watch's Match. */
const FAULTS = `
  CREATE TABLE "pccspec_watch_fault" ("relation" text NOT NULL, "key" uuid NOT NULL, PRIMARY KEY ("relation", "key"));
  CREATE FUNCTION "pccspec_watch_fault_turn"() RETURNS trigger LANGUAGE plpgsql AS $$
  BEGIN
    IF EXISTS (SELECT 1 FROM "pccspec_watch_fault" WHERE "relation" = 'conversation_turn' AND "key" = NEW."session_id") THEN
      RAISE EXCEPTION 'injected fault: no turn may be written on session %', NEW."session_id";
    END IF;
    RETURN NEW;
  END $$;
  CREATE FUNCTION "pccspec_watch_fault_delivery"() RETURNS trigger LANGUAGE plpgsql AS $$
  BEGIN
    IF EXISTS (SELECT 1 FROM "pccspec_watch_fault" f JOIN "watch_match" m ON m."watch_id" = f."key"
               WHERE f."relation" = 'watch_delivery' AND m."id" = NEW."match_id") THEN
      RAISE EXCEPTION 'injected fault: no delivery may be written for match %', NEW."match_id";
    END IF;
    RETURN NEW;
  END $$;
  CREATE TRIGGER "pccspec_watch_fault_turn" BEFORE INSERT ON "conversation_turn"
    FOR EACH ROW EXECUTE FUNCTION "pccspec_watch_fault_turn"();
  CREATE TRIGGER "pccspec_watch_fault_delivery" BEFORE INSERT ON "watch_delivery"
    FOR EACH ROW EXECUTE FUNCTION "pccspec_watch_fault_delivery"();`;

before(async () => {
  if (skip) return;
  assertCoordinatorPgUrlIsIsolated(URL);
  sql = new Client({ connectionString: URL, connectionTimeoutMillis: 5_000 });
  await sql.connect();
  await verifyCoordinatorPgIdentity(sql);
  prisma = prismaClientFor(URL!);
  clients.push(prisma);
  watches = new WatchesService(prisma as unknown as PrismaService);
  // Never started: a case lands an evaluation by calling it.
  evaluator = new WatchEvaluatorService(prisma as unknown as PrismaService, inert<never>(), {
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
  inboxWakes.length = 0;
  apns.length = 0;
  await sql.query(`DELETE FROM "pccspec_watch_fault"`);
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
      `DROP TRIGGER IF EXISTS "pccspec_watch_fault_turn" ON "conversation_turn";
       DROP TRIGGER IF EXISTS "pccspec_watch_fault_delivery" ON "watch_delivery";
       DROP FUNCTION IF EXISTS "pccspec_watch_fault_turn"();
       DROP FUNCTION IF EXISTS "pccspec_watch_fault_delivery"();
       DROP TABLE IF EXISTS "pccspec_watch_fault";`,
    )
    .catch(() => undefined);
  await sql?.end().catch(() => undefined);
});

/**
 * Stops the workers a case left running and closes its pools, before the next case opens its own. Each
 * case makes its own, and a pool keeps idle connections for ten seconds: closed only at the end of the
 * file, the cases after one open theirs on top of everything it left up.
 */
async function quiesce(): Promise<void> {
  for (const worker of running.splice(0)) await worker.stop();
  for (const client of clients.splice(0)) await client.$disconnect().catch(() => undefined);
}

/** pg.Pool's default size, which a PrismaPg built from a URL keeps. */
const POOL_MAX = 10;

/**
 * Opens `connections` connections in each pool before a case bursts work onto it. A replica that has
 * been serving has its pool open when its work arrives; a pool made moments before a burst opens them
 * in the middle of it, and on a starved host each new PostgreSQL connection takes seconds — longer than
 * the two seconds Prisma waits for one before a transaction fails to start (P2028). The race would be
 * the connection handshakes, not the claims, landings and turns the case is about.
 */
async function warm(pools: PrismaClient[], connections = POOL_MAX): Promise<void> {
  await Promise.all(pools.flatMap((prisma) => Array.from({ length: connections }, () => prisma.$executeRaw`SELECT pg_sleep(0.1)`)));
}

interface Worker {
  prisma: PrismaClient;
  sessions: SessionsService;
  delivery: WatchDeliveryService;
}

/**
 * One replica's delivery worker: its own pool, the real sessions service, the real push service. Its
 * pool is connected before it is handed over — see warm().
 */
async function worker(options: WatchDeliveryOptions = {}, Sessions: typeof SessionsService = SessionsService): Promise<Worker> {
  const pool = prismaClientFor(URL!);
  clients.push(pool);
  await warm([pool]);
  const sessions = new Sessions(pool as unknown as PrismaService, queue as never, realtime as never);
  const delivery = new WatchDeliveryService(pool as unknown as PrismaService, sessions, pushFor(pool), {
    retryBaseMs: 0,
    retryMaxMs: 0,
    pollIntervalMs: HOUR,
    ...options,
  });
  running.push(delivery);
  return { prisma: pool, sessions, delivery };
}

const outcomesFor = (results: WatchDeliveryResult[], deliveryId: string): WatchDeliveryOutcome[] =>
  results.filter((result) => result.deliveryId === deliveryId).map((result) => result.outcome);

// ── fixtures ───────────────────────────────────────────────────────────────────────────────────

async function insertUser(): Promise<string> {
  const id = randomUUID();
  await sql.query(
    `INSERT INTO "user"("id","email","name","password_hash") VALUES ($1,$2,'watch delivery','h')`,
    [id, `${id}@watch-delivery.invalid`],
  );
  return id;
}

async function insertRunner(owner: string): Promise<string> {
  const id = randomUUID();
  await sql.query(
    `INSERT INTO "runner"("id","name","owner_id","token_hash","status","last_heartbeat_at","capabilities")
     VALUES ($1,'watch delivery',$2,'h','ONLINE',clock_timestamp(),'{}'::text[])`,
    [id, owner],
  );
  return id;
}

async function insertDevice(owner: string, environment: 'sandbox' | 'production'): Promise<void> {
  await sql.query(
    `INSERT INTO "device_token"("id","user_id","token","platform","environment","bundle_id","updated_at")
     VALUES ($1,$2,$3,'ios',$4,'io.orbitd.app',now())`,
    [randomUUID(), owner, `device-${randomUUID()}`, environment],
  );
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
 * An observer that has run: started on an online runner, with a runtime and a turn behind it. That is
 * also what makes an ended one REVIVABLE, so a wake that stays out of it is refusing, not unable.
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
  body: { predicate: unknown; targets: string[]; action: 'NOTIFY_USER' | 'RESUME_SESSION'; observerSessionId?: string },
) {
  return watches.create(owner, {
    predicateVersion: 1,
    predicate: body.predicate,
    targets: body.targets.map((id) => ({ kind: 'TASK', id })),
    action: body.action,
    ...(body.observerSessionId ? { observerSessionId: body.observerSessionId } : {}),
  } as unknown as CreateWatchDto);
}

/** A watch whose condition already holds, so the create path records its Match and the delivery. */
async function matchedWatch(
  owner: string,
  action: 'NOTIFY_USER' | 'RESUME_SESSION',
  observerSessionId?: string,
  targets?: string[],
): Promise<string> {
  const watch = await createWatch(owner, {
    predicate: ALL_TERMINAL,
    targets: targets ?? [await insertTask(owner, 'DONE')],
    action,
    observerSessionId,
  });
  assert.equal(watch.state, 'MATCHED', 'the fixture condition holds at create');
  return watch.id;
}

interface DeliveryRow {
  id: string;
  action: string;
  state: string;
  attempts: number;
  leaseGeneration: string | null;
  lastError: string | null;
  due: boolean;
  delivered: boolean;
  deadLettered: boolean;
  /** How far past the row's last write its next attempt is scheduled. */
  backoffMs: number | null;
}

async function deliveriesOf(watchId: string): Promise<DeliveryRow[]> {
  const { rows } = await sql.query<DeliveryRow>(
    `SELECT d."id", d."action", d."state", d."attempts", d."lease_generation" AS "leaseGeneration",
            d."last_error" AS "lastError", d."next_attempt_at" <= now() AS "due",
            d."delivered_at" IS NOT NULL AS "delivered", d."dead_lettered_at" IS NOT NULL AS "deadLettered",
            round(extract(epoch FROM d."next_attempt_at" - d."updated_at") * 1000)::int AS "backoffMs"
       FROM "watch_delivery" d JOIN "watch_match" m ON m."id" = d."match_id"
      WHERE m."watch_id" = $1
      ORDER BY d."created_at", d."id"`,
    [watchId],
  );
  return rows;
}

async function onlyDelivery(watchId: string): Promise<DeliveryRow> {
  const rows = await deliveriesOf(watchId);
  assert.equal(rows.length, 1, `one generation has exactly one delivery row, found ${rows.length}`);
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
  const { rows } = await sql.query<{
    status: string;
    endReason: string | null;
    completed: boolean;
    trashed: boolean;
    cancelling: boolean;
  }>(
    `SELECT "status", "end_reason" AS "endReason", "completed_at" IS NOT NULL AS "completed",
            "deleted_at" IS NOT NULL AS "trashed", "cancel_requested_at" IS NOT NULL AS "cancelling"
       FROM "session" WHERE "id" = $1`,
    [id],
  );
  return rows[0];
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

// ── cases ──────────────────────────────────────────────────────────────────────────────────────

test('the evaluator lands a Match and its delivery in one transaction: a delivery that cannot be written takes the Match with it', { skip, timeout: 120_000 }, async () => {
  const owner = await insertUser();
  const observer = await insertSession(owner, 'AWAITING_INPUT', await insertRunner(owner));
  const task = await insertTask(owner, 'OPEN');
  const watch = await createWatch(owner, { predicate: ALL_TERMINAL, targets: [task], action: 'RESUME_SESSION', observerSessionId: observer });
  assert.equal(watch.state, 'ACTIVE', 'nothing holds yet');
  // FAILED rather than DONE: DONE is a projection of a satisfied criterion, and no fixture can write it.
  await sql.query(`UPDATE "task" SET "status" = 'FAILED' WHERE "id" = $1`, [task]);

  await sql.query(`INSERT INTO "pccspec_watch_fault" VALUES ('watch_delivery', $1)`, [watch.id]);
  await assert.rejects(evaluator.evaluate(watch.id), /injected fault: no delivery may be written/);
  const { rows: [refused] } = await sql.query(
    `SELECT "state", "generation", (SELECT count(*)::int FROM "watch_match" WHERE "watch_id" = $1) AS "matches"
       FROM "watch" WHERE "id" = $1`,
    [watch.id],
  );
  assert.deepEqual(refused, { state: 'ACTIVE', generation: 0, matches: 0 }, 'the Match outlived the delivery it was landed with');
  assert.deepEqual(await deliveriesOf(watch.id), []);

  // The control: the same landing, with nothing refusing the delivery, writes both.
  await sql.query(`DELETE FROM "pccspec_watch_fault"`);
  assert.equal((await evaluator.evaluate(watch.id)).outcome, 'MATCHED');
  const delivery = await onlyDelivery(watch.id);
  assert.equal(delivery.action, 'RESUME_SESSION', 'the delivery carries the watch action');
  assert.equal(delivery.state, 'PENDING');
  assert.equal(delivery.attempts, 0);
  assert.equal(delivery.due, true, 'and is due at once');

  // Landing the same crossing again adds neither a Match nor a delivery.
  assert.equal((await evaluator.evaluate(watch.id)).outcome, 'SETTLED');
  assert.equal((await onlyDelivery(watch.id)).id, delivery.id);
  const { rows: [{ matches }] } = await sql.query(`SELECT count(*)::int AS "matches" FROM "watch_match" WHERE "watch_id" = $1`, [watch.id]);
  assert.equal(matches, 1);
});

test('NOTIFY_USER: one generation rings the owner once, however many workers and passes reach its delivery', { skip, timeout: 120_000 }, async () => {
  const owner = await insertUser();
  await insertDevice(owner, 'production');
  await insertDevice(owner, 'sandbox');
  const watchId = await matchedWatch(owner, 'NOTIFY_USER');
  const { id: deliveryId } = await onlyDelivery(watchId);
  const { rows: [{ reason }] } = await sql.query(`SELECT "reason" FROM "watch_match" WHERE "watch_id" = $1`, [watchId]);

  const [a, b] = await Promise.all([worker(), worker()]);
  const raced = (await Promise.all([a.delivery.drain(), b.delivery.drain(), a.delivery.drain(), b.delivery.drain()])).flat();
  assert.deepEqual(outcomesFor(raced, deliveryId), ['DELIVERED'], 'exactly one attempt delivered it');
  const later = [...(await a.delivery.drain()), ...(await b.delivery.drain())];
  assert.deepEqual(outcomesFor(later, deliveryId), [], 'a delivered row is never claimed again');

  const delivery = await onlyDelivery(watchId);
  assert.equal(delivery.id, deliveryId, 'the row the create path wrote is the one settled');
  assert.equal(delivery.state, 'DELIVERED');
  assert.equal(delivery.delivered, true);
  assert.equal(delivery.attempts, 0);
  assert.equal(delivery.leaseGeneration, null);

  const rings = apns.filter((request) => request.payload.watchID === watchId);
  assert.equal(rings.length, 2, 'one notification, sent once to each of the two devices');
  assert.deepEqual([...new Set(rings.map((request) => request.collapseId))], [`watch-${watchId}-1`]);
  assert.equal(new Set(rings.map((request) => request.token)).size, 2);
  for (const ring of rings) {
    assert.equal(ring.payload.kind, 'watch-matched');
    assert.equal(ring.payload.generation, 1);
    assert.equal(ring.payload.aps.alert.body, reason);
  }

  // And the table refuses a second delivery of this Match's action outright.
  await assert.rejects(
    sql.query(
      `INSERT INTO "watch_delivery"("id","match_id","action","next_attempt_at")
       SELECT $1, "match_id", "action", now() FROM "watch_delivery" WHERE "id" = $2`,
      [randomUUID(), deliveryId],
    ),
    /watch_delivery_match_action_key/,
  );

  // A worker whose lease on a notification ran out rings nobody; the pass that took it over rang once.
  const abandonedWatch = await matchedWatch(owner, 'NOTIFY_USER');
  const { id: abandonedDelivery } = await onlyDelivery(abandonedWatch);
  const slow = await worker({ leaseMs: 300 });
  const [stale] = (await slow.delivery.claimDue()).filter((row) => row.id === abandonedDelivery);
  assert.ok(stale, 'the slow worker holds the delivery');
  await eventually("the slow worker's lease to run out", () => leaseLapsed(abandonedDelivery), (lapsed) => lapsed);
  assert.deepEqual(outcomesFor(await b.delivery.drain(), abandonedDelivery), ['DELIVERED'], 'a pass takes an abandoned delivery back and delivers it');
  assert.equal(await slow.delivery.deliver(stale), 'LEASE_LOST');
  assert.equal(
    apns.filter((request) => request.payload.watchID === abandonedWatch).length,
    2,
    'one notification to the two devices, and none from the worker that lost its lease',
  );
  assert.equal((await onlyDelivery(abandonedWatch)).attempts, 1, 'the abandoned attempt is counted');
});

test('RESUME_SESSION on an AWAITING_INPUT observer: one turn keyed watch:<id>:<generation>, queued for a runner slot, however many workers race it or it is redelivered', { skip, timeout: 120_000 }, async () => {
  const owner = await insertUser();
  const observer = await insertSession(owner, 'AWAITING_INPUT', await insertRunner(owner));
  const watchId = await matchedWatch(owner, 'RESUME_SESSION', observer);
  const { id: deliveryId } = await onlyDelivery(watchId);

  const workers = await Promise.all([worker(), worker(), worker()]);
  const raced = (await Promise.all(workers.map(({ delivery }) => delivery.drain()))).flat();
  assert.deepEqual(outcomesFor(raced, deliveryId), ['DELIVERED']);

  const turns = await turnsOn(observer);
  assert.equal(turns.length, 1, 'one generation, one turn');
  const [turn] = turns;
  assert.equal(turn.clientTurnId, RESUME.idempotency!.clientTurnId.replace('<watchId>', watchId).replace('<generation>', '1'));
  assert.equal(turn.clientTurnId, `watch:${watchId}:1`);
  assert.equal(turn.kind, 'message');
  assert.equal(turn.sendIntent, RESUME.sendIntent!.value);
  assert.equal(turn.status, 'PENDING');
  assert.equal((await sessionOf(observer)).status, 'PENDING', 'a parked observer waits for a runner slot like any sent message');
  assert.equal(queueSignals, 1, 'the queue was told once');
  const delivery = await onlyDelivery(watchId);
  assert.equal(delivery.state, 'DELIVERED');
  assert.equal(delivery.attempts, 0);

  // Redelivered after its turn was written — a requeue, or an acknowledgement that never landed: the
  // key collapses it onto the turn that is already there.
  await sql.query(
    `UPDATE "watch_delivery" SET "state" = 'PENDING', "delivered_at" = NULL, "next_attempt_at" = now() WHERE "id" = $1`,
    [deliveryId],
  );
  assert.deepEqual(outcomesFor(await workers[1].delivery.drain(), deliveryId), ['DELIVERED']);
  assert.deepEqual(await turnsOn(observer), turns, 'the redelivery wrote a second turn or changed the first');
  assert.equal(queueSignals, 1, 'the redelivery queued the session again');
  assert.equal((await onlyDelivery(watchId)).state, 'DELIVERED');
});

test('a turn somebody else queued under a wake\'s key is not the wake: the delivery is a WAKE_KEY_TAKEN dead letter the watch read shows, and the turn under the key is left as it was', { skip, timeout: 120_000 }, async () => {
  const owner = await insertUser();
  const observer = await insertSession(owner, 'AWAITING_INPUT', await insertRunner(owner));
  const watchId = await matchedWatch(owner, 'RESUME_SESSION', observer);
  const { id: deliveryId } = await onlyDelivery(watchId);
  const { sessions, delivery } = await worker();

  // Before any worker reached the Match, the owner's client sent a message under the key its wake is written under.
  await sessions.createTurn(owner, observer, { clientTurnId: `watch:${watchId}:1`, content: 'a message of the owner\'s, not the wake', intent: 'NEXT_TURN' });
  const queued = await turnsOn(observer);
  const signals = queueSignals;

  assert.deepEqual(outcomesFor(await delivery.drain(), deliveryId), ['DEAD_LETTER'], 'a wake that was never queued was not refused for good');
  const settled = await onlyDelivery(watchId);
  assert.equal(settled.state, 'DEAD_LETTER');
  assert.equal(settled.delivered, false);
  assert.equal(settled.attempts, 1, 'a taken key is retried');
  assert.match(settled.lastError ?? '', new RegExp(`^WAKE_KEY_TAKEN: .*watch:${watchId}:1\\b`));
  assert.deepEqual(await turnsOn(observer), queued, 'the delivery wrote a turn or changed the one under its key');
  assert.equal(queueSignals, signals, 'the observer was queued again');
  const view = await watches.get(owner, watchId);
  assert.deepEqual(
    view.matches[0].deliveries.map(({ id, state, lastError }) => ({ id, state, lastError })),
    [{ id: deliveryId, state: 'DEAD_LETTER', lastError: settled.lastError }],
    'the dead letter is not on the watch read',
  );
  assert.deepEqual(outcomesFor(await delivery.drain(), deliveryId), [], 'a dead letter is never claimed again');
});

test('a worker whose lease was taken over writes nothing — no turn, no acknowledgement — and the takeover delivers the one turn', { skip, timeout: 120_000 }, async () => {
  const owner = await insertUser();
  const observer = await insertSession(owner, 'AWAITING_INPUT', await insertRunner(owner));
  const watchId = await matchedWatch(owner, 'RESUME_SESSION', observer);
  const { id: deliveryId } = await onlyDelivery(watchId);

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
  const reclaimed = await onlyDelivery(watchId);
  assert.equal(reclaimed.state, 'PENDING');
  assert.equal(reclaimed.attempts, 1, 'the abandoned attempt is counted');
  assert.match(reclaimed.lastError ?? '', /^LEASE_EXPIRED:/);

  // A resumes: its acknowledgement no longer matches the row, and its turn is rolled back with it.
  release();
  assert.equal(await attempt, 'LEASE_LOST');
  assert.deepEqual(await turnsOn(observer), [], 'a worker that lost its lease wrote a turn');
  assert.equal((await sessionOf(observer)).status, 'AWAITING_INPUT', 'a worker that lost its lease moved the session');
  assert.equal(queueSignals, 0);

  assert.deepEqual(outcomesFor(await b.delivery.drain(), deliveryId), ['DELIVERED']);
  assert.equal((await turnsOn(observer)).length, 1);
  const settled = await onlyDelivery(watchId);
  assert.equal(settled.state, 'DELIVERED');
  assert.equal(settled.attempts, 1);

  // A, trying again under the lease it lost, changes nothing.
  assert.equal(await a.delivery.deliver(claim), 'LEASE_LOST');
  assert.equal((await turnsOn(observer)).length, 1);
});

test('a RUNNING observer keeps its one run: the wake queues behind the current turn and reaches the runner only after it', { skip, timeout: 120_000 }, async () => {
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
  const watchId = await matchedWatch(owner, 'RESUME_SESSION', observer);
  const { id: deliveryId } = await onlyDelivery(watchId);
  const { delivery, sessions, prisma: pool } = await worker();
  assert.deepEqual(outcomesFor(await delivery.drain(), deliveryId), ['DELIVERED']);

  const [runningTurn, wake, ...extra] = await turnsOn(observer);
  assert.deepEqual(extra, []);
  assert.equal(runningTurn.id, current);
  assert.equal(runningTurn.status, 'IN_FLIGHT');
  assert.equal(wake.clientTurnId, `watch:${watchId}:1`);
  assert.equal(wake.status, 'PENDING');
  assert.equal(wake.seq, 2, 'behind the running turn');
  assert.equal((await sessionOf(observer)).status, 'RUNNING', 'still the one run it was');
  assert.equal(queueSignals, 0, 'no second run was queued for a runner slot');
  assert.deepEqual(inboxWakes, [observer], 'the running engine is told a turn waits');
  assert.deepEqual((await sessions.listQueuedTurns(owner, observer)).map((turn) => turn.turnId), [wake.id], 'clients show it queued');

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
  assert.equal(await inbox.dequeueTurn(observer, runner, null, false, []), null, 'the runner was handed the wake while the current turn runs');

  await runnerApi.turnComplete({ id: runner }, observer, {
    turnId: current,
    status: 'SUCCEEDED',
    subtype: 'completed',
    numTurns: 2,
    costUsd: 0,
  } as never);
  assert.equal((await sessionOf(observer)).status, 'RUNNING', 'a queued turn keeps the slot');
  const next = await inbox.dequeueTurn(observer, runner, null, false, []);
  assert.equal(next?.turnId, wake.id, 'the wake is the next thing the runner is handed');
  assert.ok(wake.content && next?.content?.includes(wake.content), 'with the content it was queued with');
  const inFlight = (await turnsOn(observer)).filter((turn) => turn.status === 'IN_FLIGHT');
  assert.deepEqual(inFlight.map((turn) => turn.id), [wake.id], 'one executable turn in flight at a time');
});

test('a wake never revives an observer whose life is over: Completed, ended, ending and Trash are dead letters, and a deleted observer takes its delivery with it', { skip, timeout: 180_000 }, async () => {
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
    const watchId = await matchedWatch(owner, 'RESUME_SESSION', observer);
    const { id: deliveryId } = await onlyDelivery(watchId);
    await sql.query(end, [observer]);
    const before = await sessionOf(observer);

    assert.deepEqual(outcomesFor(await delivery.drain(), deliveryId), ['DEAD_LETTER'], `${name}: not refused for good`);
    assert.deepEqual(await turnsOn(observer), [], `${name}: a turn was written`);
    assert.deepEqual(await sessionOf(observer), before, `${name}: the observer was changed`);
    assert.equal(queueSignals, 0, `${name}: the observer was queued`);
    const settled = await onlyDelivery(watchId);
    assert.equal(settled.state, 'DEAD_LETTER', name);
    assert.equal(settled.deadLettered, true, name);
    assert.equal(settled.attempts, 1, `${name}: a refusal is retried`);
    assert.ok(settled.lastError?.startsWith(`${code}:`), `${name}: ${settled.lastError}`);

    // A dead letter is on the watch's own read, with why.
    const view = await watches.get(owner, watchId);
    assert.deepEqual(
      view.matches[0].deliveries.map(({ id, state, attempts, lastError }) => ({ id, state, attempts, lastError })),
      [{ id: deliveryId, state: 'DEAD_LETTER', attempts: 1, lastError: settled.lastError }],
      name,
    );
  }

  // Deleted outright: the watch, its Match and its delivery go with the session...
  const doomed = await insertSession(owner, 'AWAITING_INPUT', runner);
  const doomedWatch = await matchedWatch(owner, 'RESUME_SESSION', doomed);
  const { id: doomedDelivery } = await onlyDelivery(doomedWatch);
  const [claim] = (await delivery.claimDue()).filter((row) => row.id === doomedDelivery);
  assert.ok(claim, 'the delivery was claimed before its observer was deleted');
  await sql.query(`DELETE FROM "session" WHERE "id" = $1`, [doomed]);
  // ...so the attempt already holding it has nothing to deliver, and writes nothing.
  assert.equal(await delivery.deliver(claim), 'LEASE_LOST');
  assert.deepEqual(await deliveriesOf(doomedWatch), []);
  assert.deepEqual(await turnsOn(doomed), []);

  // The paired control, last: the same watch on an observer that is alive is delivered.
  const alive = await insertSession(owner, 'AWAITING_INPUT', runner);
  const aliveWatch = await matchedWatch(owner, 'RESUME_SESSION', alive);
  const { id: aliveDelivery } = await onlyDelivery(aliveWatch);
  assert.deepEqual(outcomesFor(await delivery.drain(), aliveDelivery), ['DELIVERED']);
  assert.equal((await turnsOn(alive)).length, 1);
});

test('a delivery that keeps failing is retried on a doubling backoff, then left as a dead letter the watch read shows', { skip, timeout: 180_000 }, async () => {
  const owner = await insertUser();
  const runner = await insertRunner(owner);
  const observer = await insertSession(owner, 'AWAITING_INPUT', runner);
  const watchId = await matchedWatch(owner, 'RESUME_SESSION', observer);
  const { id: deliveryId } = await onlyDelivery(watchId);
  await sql.query(`INSERT INTO "pccspec_watch_fault" VALUES ('conversation_turn', $1)`, [observer]);

  const RETRY_BASE_MS = 1_000;
  const RETRY_MAX_MS = 4_000;
  const { delivery } = await worker({ retryBaseMs: RETRY_BASE_MS, retryMaxMs: RETRY_MAX_MS });
  const cap = CONTRACT.limits.maxDeliveryAttempts;
  assert.equal(WATCH_LIMITS.maxDeliveryAttempts, cap);

  for (let attempt = 1; attempt <= cap; attempt += 1) {
    const last = attempt === cap;
    assert.deepEqual(outcomesFor(await delivery.drain(), deliveryId), [last ? 'DEAD_LETTER' : 'RETRY'], `attempt ${attempt}`);
    const row = await onlyDelivery(watchId);
    assert.equal(row.attempts, attempt);
    assert.match(row.lastError ?? '', /injected fault: no turn may be written/, `attempt ${attempt}`);
    assert.equal(row.leaseGeneration, null, 'a settled attempt holds no lease');
    if (last) {
      assert.equal(row.state, 'DEAD_LETTER');
      assert.equal(row.deadLettered, true);
      break;
    }
    assert.equal(row.state, 'PENDING');
    assert.equal(row.backoffMs, Math.min(RETRY_BASE_MS * 2 ** (attempt - 1), RETRY_MAX_MS), `attempt ${attempt}'s backoff`);
    if (attempt === 1) {
      assert.deepEqual(outcomesFor(await delivery.drain(), deliveryId), [], 'retried before its backoff was up');
    }
    await sql.query(`UPDATE "watch_delivery" SET "next_attempt_at" = now() WHERE "id" = $1`, [deliveryId]);
  }

  assert.deepEqual(outcomesFor(await delivery.drain(), deliveryId), [], 'a dead letter is never claimed again');
  assert.deepEqual(await turnsOn(observer), []);
  assert.equal((await sessionOf(observer)).status, 'AWAITING_INPUT');
  const view = await watches.get(owner, watchId);
  const [shown, ...others] = view.matches[0].deliveries;
  assert.deepEqual(others, []);
  assert.equal(shown.state, 'DEAD_LETTER');
  assert.equal(shown.attempts, cap);
  assert.ok(shown.deadLetteredAt, 'the watch read says when it gave up');
  assert.match(shown.lastError ?? '', /injected fault/);

  // The control: the same fault lifted after two failures leaves one turn, and the count of what it took.
  const recovering = await insertSession(owner, 'AWAITING_INPUT', runner);
  const recoveringWatch = await matchedWatch(owner, 'RESUME_SESSION', recovering);
  const { id: recoveringDelivery } = await onlyDelivery(recoveringWatch);
  await sql.query(`INSERT INTO "pccspec_watch_fault" VALUES ('conversation_turn', $1)`, [recovering]);
  const immediate = await worker();
  assert.deepEqual(outcomesFor(await immediate.delivery.drain(), recoveringDelivery), ['RETRY']);
  assert.deepEqual(outcomesFor(await immediate.delivery.drain(), recoveringDelivery), ['RETRY']);
  await sql.query(`DELETE FROM "pccspec_watch_fault" WHERE "key" = $1`, [recovering]);
  assert.deepEqual(outcomesFor(await immediate.delivery.drain(), recoveringDelivery), ['DELIVERED']);
  const recovered = await onlyDelivery(recoveringWatch);
  assert.equal(recovered.state, 'DELIVERED');
  assert.equal(recovered.attempts, 2);
  assert.equal((await turnsOn(recovering)).length, 1);
});

test('the wake is auditable in the transcript: the Match\'s reason, the targets that changed and its snapshot, as the watch recorded them', { skip, timeout: 120_000 }, async () => {
  const owner = await insertUser();
  const observer = await insertSession(owner, 'AWAITING_INPUT', await insertRunner(owner));
  const steady = await insertTask(owner, 'OPEN');
  const failing = await insertTask(owner, 'OPEN');
  const watch = await createWatch(owner, {
    predicate: { kind: 'ANY', over: 'ALL_TARGETS', leaf: 'TASK_FAILED' },
    targets: [steady, failing],
    action: 'RESUME_SESSION',
    observerSessionId: observer,
  });
  assert.equal(watch.state, 'ACTIVE');
  await sql.query(`UPDATE "task" SET "status" = 'FAILED' WHERE "id" = $1`, [failing]);
  assert.equal((await evaluator.evaluate(watch.id)).outcome, 'MATCHED');
  const { id: deliveryId } = await onlyDelivery(watch.id);
  const { delivery, sessions } = await worker();
  assert.deepEqual(outcomesFor(await delivery.drain(), deliveryId), ['DELIVERED']);

  const { rows: [match] } = await sql.query(
    `SELECT "generation", "reason", "per_target_snapshot" AS "snapshot",
            floor(extract(epoch FROM "matched_at") * 1000)::bigint::text AS "matchedAtMs"
       FROM "watch_match" WHERE "watch_id" = $1`,
    [watch.id],
  );
  const [turn] = await turnsOn(observer);
  const content = turn.content ?? '';
  assert.equal(content.split('\n')[0], `Orbit Watch ${watch.id} matched at generation 1: ${match.reason}`);
  const fenced = [...content.matchAll(/```json\n([\s\S]*?)\n```/g)];
  assert.equal(fenced.length, 1, 'one structured payload, and nothing else fenced');
  const payload = JSON.parse(fenced[0][1]);
  for (const key of RESUME.payload ?? []) assert.ok(key in payload, `the contract's payload names ${key}`);
  assert.equal(payload.watchId, watch.id);
  assert.equal(payload.generation, match.generation);
  assert.equal(payload.reason, match.reason);
  assert.ok(Math.abs(Date.parse(payload.matchedAt) - Number(match.matchedAtMs)) <= 1, 'the moment the Match recorded');
  assert.deepEqual(payload.latestSnapshot, match.snapshot, 'the snapshot the Match recorded, not a later read');
  assert.deepEqual(payload.changedTargets, [{ kind: 'TASK', id: failing, state: 'SATISFIED', observed: { status: 'FAILED' } }]);

  // What clients render for the turn until the runner reports it — the transcript's own source.
  const listed = await sessions.listQueuedTurns(owner, observer, 'active');
  assert.deepEqual(listed.map((queued) => [queued.turnId, queued.content]), [[turn.id, content]]);
});

test('a wake over the largest target set still fits one turn: every changed target is named and the snapshot points at the watch', { skip, timeout: 120_000 }, async () => {
  const owner = await insertUser();
  const observer = await insertSession(owner, 'AWAITING_INPUT', await insertRunner(owner));
  const { rows: tasks } = await sql.query<{ id: string }>(
    `INSERT INTO "task"("id","title","owner_id","creator_type","creator_id","updated_at","completion_criterion","status")
     SELECT gen_random_uuid(),'watched work',$1,'USER',$1,now(),'EVIDENCE_JUDGMENT','DONE' FROM generate_series(1, $2::int)
     RETURNING "id"`,
    [owner, WATCH_LIMITS.maxTargetsPerWatch],
  );
  const watchId = await matchedWatch(owner, 'RESUME_SESSION', observer, tasks.map((task) => task.id));
  const { rows: [{ snapshot }] } = await sql.query(`SELECT "per_target_snapshot" AS "snapshot" FROM "watch_match" WHERE "watch_id" = $1`, [watchId]);
  assert.ok(JSON.stringify(snapshot, null, 2).length > MAX_PROMPT_CHARS, 'the whole snapshot would not fit a turn');
  const { id: deliveryId } = await onlyDelivery(watchId);
  const { delivery } = await worker();
  assert.deepEqual(outcomesFor(await delivery.drain(), deliveryId), ['DELIVERED']);

  const [turn] = await turnsOn(observer);
  assert.ok(turn.content && turn.content.length <= MAX_PROMPT_CHARS);
  const payload = JSON.parse(/```json\n([\s\S]*?)\n```/.exec(turn.content)![1]);
  assert.equal(payload.changedTargets.length, WATCH_LIMITS.maxTargetsPerWatch);
  assert.equal(payload.latestSnapshot.targets, WATCH_LIMITS.maxTargetsPerWatch);
  assert.match(payload.latestSnapshot.omitted, new RegExp(`/api/watches/${watchId}`));
});

test('a started worker delivers what is due without being asked, and stops cleanly', { skip, timeout: 120_000 }, async () => {
  const owner = await insertUser();
  await insertDevice(owner, 'production');
  const watchId = await matchedWatch(owner, 'NOTIFY_USER');
  const { delivery } = await worker({ pollIntervalMs: 50 });
  delivery.start();
  await eventually('the loop to deliver', () => onlyDelivery(watchId), (row) => row.state === 'DELIVERED');
  await delivery.stop();
  assert.equal(apns.filter((request) => request.payload.watchID === watchId).length, 1);
});

// ── a wake its observer's ending drains unrun ──────────────────────────────────────────────────

interface QueuedWake {
  observer: string;
  watchId: string;
  deliveryId: string;
  wakeId: string;
}

/**
 * An observer RUNNING a turn, with a wake queued behind it whose delivery is DELIVERED: the state each
 * way that run can end meets (watch-wake-drain.ts). It has already said something — a completion over a
 * turn nothing answered hands that turn back to the queue, and the runner's next take would be handed
 * it again rather than the wake waiting behind it.
 */
async function wakeQueuedBehindRunningTurn(owner: string, runner: string, pool: Worker): Promise<QueuedWake & { current: string }> {
  const observer = await insertSession(owner, 'RUNNING', runner);
  const current = randomUUID();
  await sql.query(
    `INSERT INTO "conversation_turn"("id","session_id","seq","client_turn_id","kind","content","status","delivered_at","lease_deadline_at")
     VALUES ($1,$2,1,$3,'message','the turn the session is running','IN_FLIGHT',now(),now() + interval '10 minutes')`,
    [current, observer, `current-${current}`],
  );
  await say(current, observer, 'working on it');
  const watchId = await matchedWatch(owner, 'RESUME_SESSION', observer);
  const { id: deliveryId } = await onlyDelivery(watchId);
  assert.deepEqual(outcomesFor(await pool.delivery.drain(), deliveryId), ['DELIVERED']);
  const [wake] = (await turnsOn(observer)).filter((turn) => turn.clientTurnId === `watch:${watchId}:1`);
  assert.equal(wake?.status, 'PENDING', 'the wake waits behind the running turn');
  return { observer, current, watchId, deliveryId, wakeId: wake.id };
}

/**
 * The wake was taken off the queue unrun — answered by an ending's drain, or deleted by an interrupt or a
 * withdrawal — its delivery says so on the watch's own read, and nothing else about the watch moved.
 */
async function assertDeadLettered(
  owner: string,
  queued: QueuedWake,
  ending: string,
  { code = 'OBSERVER_SESSION_ENDED', deleted = false }: { code?: string; deleted?: boolean } = {},
): Promise<void> {
  const [wake] = (await turnsOn(queued.observer)).filter((turn) => turn.id === queued.wakeId);
  if (deleted) assert.equal(wake, undefined, `${ending}: the wake is deleted as a queued message always was`);
  else assert.equal(wake?.status, 'ANSWERED', `${ending}: the queue is drained as it always was`);
  const settled = await onlyDelivery(queued.watchId);
  assert.equal(settled.state, 'DEAD_LETTER', `${ending}: a wake no runner took still reads ${settled.state}`);
  assert.equal(settled.deadLettered, true, ending);
  assert.equal(settled.delivered, false, ending);
  assert.match(settled.lastError ?? '', new RegExp(`^${code}: `), ending);
  const view = await watches.get(owner, queued.watchId);
  assert.equal(view.state, 'MATCHED', `${ending}: the watch is the terminal fact it was`);
  assert.deepEqual(
    view.matches.map((match) => match.deliveries.map(({ id, state, lastError }) => ({ id, state, lastError }))),
    [[{ id: queued.deliveryId, state: 'DEAD_LETTER', lastError: settled.lastError }]],
    `${ending}: one Match, and its dead letter is on the watch's read`,
  );
}

test('a wake still queued when its observer\'s running turn fails is a dead letter, not DELIVERED; a wake the runner took stays delivered when its own turn fails', { skip, timeout: 120_000 }, async () => {
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
  const bystander = await wakeQueuedBehindRunningTurn(owner, runner, pool);

  const queued = await wakeQueuedBehindRunningTurn(owner, runner, pool);
  await complete(queued.observer, queued.current, 'FAILED');
  assert.equal((await sessionOf(queued.observer)).status, 'FAILED');
  await assertDeadLettered(owner, queued, 'the running turn failed');
  assert.deepEqual(outcomesFor(await pool.delivery.drain(), queued.deliveryId), [], 'a dead letter is never claimed again');

  // The control: the runner took the wake, and it is the wake's own turn that fails. The engine received
  // it, so it was delivered, whatever its run came to.
  const taken = await wakeQueuedBehindRunningTurn(owner, runner, pool);
  await complete(taken.observer, taken.current, 'SUCCEEDED');
  assert.equal((await inbox.dequeueTurn(taken.observer, runner, null, false, []))?.turnId, taken.wakeId, 'the runner took the wake');
  await complete(taken.observer, taken.wakeId, 'FAILED');
  assert.equal((await sessionOf(taken.observer)).status, 'FAILED', 'the run the wake started failed');
  assert.equal((await onlyDelivery(taken.watchId)).state, 'DELIVERED', 'a wake the runner took was dead-lettered by its run failing');

  const [waiting] = (await turnsOn(bystander.observer)).filter((turn) => turn.id === bystander.wakeId);
  assert.equal(waiting.status, 'PENDING', 'another observer lost its queued wake');
  assert.equal((await onlyDelivery(bystander.watchId)).state, 'DELIVERED', 'the other observers\' endings dead-lettered this one\'s wake');
});

test('a wake still queued when its observer\'s runner is lost is a dead letter: the reaper finalizes the run and drains the wake unrun', { skip, timeout: 120_000 }, async () => {
  const owner = await insertUser();
  const runner = await insertRunner(owner);
  const pool = await worker();
  const queued = await wakeQueuedBehindRunningTurn(owner, runner, pool);

  // The runner stops heartbeating past the offline window, and the production sweep runs.
  await sql.query(`UPDATE "runner" SET "last_heartbeat_at" = now() - interval '10 minutes' WHERE "id" = $1`, [runner]);
  const reaper = new ReaperService(pool.prisma as unknown as PrismaService, inert<never>());
  await (reaper as unknown as { sweep(): Promise<void> }).sweep();

  const { rows: [session] } = await sql.query<{ status: string; retryArmed: boolean }>(
    `SELECT "status", "retry_at" IS NOT NULL AS "retryArmed" FROM "session" WHERE "id" = $1`,
    [queued.observer],
  );
  assert.deepEqual(session, { status: 'FAILED', retryArmed: true }, 'the reaper finalized the observer, with its retry armed');
  await assertDeadLettered(owner, queued, 'the runner was lost');
});

test('a wake still queued when the runner finalizes its observer\'s run is a dead letter', { skip, timeout: 120_000 }, async () => {
  const owner = await insertUser();
  const runner = await insertRunner(owner);
  const pool = await worker();
  const queued = await wakeQueuedBehindRunningTurn(owner, runner, pool);
  const runnerApi = new RunnerApiController(pool.prisma as never, queue as never, inert<never>(), inert<never>(), inert<never>(), inert<never>(), inert<never>());

  await runnerApi.finalize({ id: runner }, queued.observer, { status: 'FAILED', error: 'the engine exited' } as never);
  assert.equal((await sessionOf(queued.observer)).status, 'FAILED');
  await assertDeadLettered(owner, queued, 'the runner finalized the run');
});

test('a wake still queued when its observer is ended is a dead letter, whether the observer was running or waiting for a runner slot', { skip, timeout: 120_000 }, async () => {
  const owner = await insertUser();
  const runner = await insertRunner(owner);
  const pool = await worker();
  // The service the owner's end goes through, with its post-commit announcements sent nowhere.
  const sessions = new SessionsService(pool.prisma as unknown as PrismaService, queue as never, inert<never>());

  const running = await wakeQueuedBehindRunningTurn(owner, runner, pool);
  await sessions.end(owner, running.observer);
  const ending = await sessionOf(running.observer);
  assert.deepEqual([ending.status, ending.endReason, ending.cancelling], ['RUNNING', 'ended', true], 'the running observer is being ended');
  await assertDeadLettered(owner, running, 'an end was requested while the observer ran');

  // A parked observer the wake moved to PENDING is settled at once.
  const parked = await insertSession(owner, 'AWAITING_INPUT', runner);
  const parkedWatch = await matchedWatch(owner, 'RESUME_SESSION', parked);
  const { id: parkedDelivery } = await onlyDelivery(parkedWatch);
  assert.deepEqual(outcomesFor(await pool.delivery.drain(), parkedDelivery), ['DELIVERED']);
  const [parkedWake] = await turnsOn(parked);
  assert.equal((await sessionOf(parked)).status, 'PENDING', 'the wake queued the parked observer for a runner slot');
  await sessions.end(owner, parked);
  assert.equal((await sessionOf(parked)).status, 'CANCELLED');
  await assertDeadLettered(
    owner,
    { observer: parked, watchId: parkedWatch, deliveryId: parkedDelivery, wakeId: parkedWake.id },
    'an end was requested while the observer waited for a slot',
  );
});

// ── a wake an observer that lives on takes off its queue ───────────────────────────────────────

/** An observer whose runner took its wake: the turn in front of it finished, and the wake is the turn running now. */
async function wakeTakenByRunner(owner: string, runner: string, pool: Worker): Promise<QueuedWake> {
  const queued = await wakeQueuedBehindRunningTurn(owner, runner, pool);
  const runnerApi = new RunnerApiController(pool.prisma as never, queue as never, inert<never>(), inert<never>(), inert<never>(), inert<never>(), inert<never>());
  await runnerApi.turnComplete({ id: runner }, queued.observer, {
    turnId: queued.current,
    status: 'SUCCEEDED',
    subtype: 'completed',
    numTurns: 2,
    costUsd: 0,
  } as never);
  const inbox = runnerApi as unknown as {
    dequeueTurn(
      sessionId: string,
      runnerId: string,
      leaseGeneration: null,
      acceptsSteer: boolean,
      declaredCapabilities: readonly string[],
    ): Promise<{ turnId: string } | null>;
  };
  assert.equal((await inbox.dequeueTurn(queued.observer, runner, null, false, []))?.turnId, queued.wakeId, 'the runner took the wake');
  return queued;
}

/** A message the observer's owner sent, queued behind whatever the observer has queued already. */
async function queuedMessage(pool: Worker, owner: string, observer: string): Promise<TurnRow> {
  const clientTurnId = randomUUID();
  await pool.sessions.createTurn(owner, observer, { clientTurnId, content: 'and then this', intent: 'NEXT_TURN' });
  const [message] = (await turnsOn(observer)).filter((turn) => turn.clientTurnId === clientTurnId);
  assert.equal(message?.status, 'PENDING', 'the message waits in the queue');
  return message;
}

test('a wake still queued when its observer is interrupted is a dead letter: the interrupt deletes it with the rest of the queue, and nothing queues it again', { skip, timeout: 120_000 }, async () => {
  const owner = await insertUser();
  const runner = await insertRunner(owner);
  const pool = await worker();
  // Another observer of the same owner on the same runner, which nobody interrupts.
  const bystander = await wakeQueuedBehindRunningTurn(owner, runner, pool);

  const queued = await wakeQueuedBehindRunningTurn(owner, runner, pool);
  const message = await queuedMessage(pool, owner, queued.observer);
  await pool.sessions.interrupt(owner, queued.observer);
  assert.equal((await sessionOf(queued.observer)).status, 'RUNNING', 'an interrupt stops a turn, and the observer lives on');
  assert.deepEqual(
    (await turnsOn(queued.observer)).filter((turn) => turn.id === message.id),
    [],
    'the message queued behind the wake is deleted as it always was',
  );
  await assertDeadLettered(owner, queued, 'the observer was interrupted', { code: 'OBSERVER_TURN_INTERRUPTED', deleted: true });
  assert.deepEqual(outcomesFor(await pool.delivery.drain(), queued.deliveryId), [], 'a dead letter is never claimed again');

  // The control: the runner took the wake, and it is the wake's own turn the interrupt stops. The engine
  // received it, so it was delivered, whatever the interrupt makes of its run.
  const taken = await wakeTakenByRunner(owner, runner, pool);
  await pool.sessions.interrupt(owner, taken.observer);
  const [stopping] = (await turnsOn(taken.observer)).filter((turn) => turn.id === taken.wakeId);
  assert.equal(stopping?.status, 'IN_FLIGHT', 'the interrupt deleted a wake the runner had taken');
  assert.equal((await onlyDelivery(taken.watchId)).state, 'DELIVERED', 'a wake the runner took was dead-lettered by an interrupt');

  const [waiting] = (await turnsOn(bystander.observer)).filter((turn) => turn.id === bystander.wakeId);
  assert.equal(waiting?.status, 'PENDING', 'another observer lost its queued wake');
  assert.equal((await onlyDelivery(bystander.watchId)).state, 'DELIVERED', 'other observers\' interrupts dead-lettered this one\'s wake');
});

test('a wake its owner withdraws from the observer\'s queue is a dead letter; the observer\'s other queued wake and message keep theirs', { skip, timeout: 120_000 }, async () => {
  const owner = await insertUser();
  const runner = await insertRunner(owner);
  const pool = await worker();
  // Another observer of the same owner on the same runner, whose queue nobody touches.
  const bystander = await wakeQueuedBehindRunningTurn(owner, runner, pool);

  const queued = await wakeQueuedBehindRunningTurn(owner, runner, pool);
  // Behind the wake: a second watch's wake on the same observer, and a message its owner sent.
  const otherWatch = await matchedWatch(owner, 'RESUME_SESSION', queued.observer);
  const { id: otherDelivery } = await onlyDelivery(otherWatch);
  assert.deepEqual(outcomesFor(await pool.delivery.drain(), otherDelivery), ['DELIVERED']);
  const [otherWake] = (await turnsOn(queued.observer)).filter((turn) => turn.clientTurnId === `watch:${otherWatch}:1`);
  assert.equal(otherWake?.status, 'PENDING', 'the second wake waits behind the first');
  const message = await queuedMessage(pool, owner, queued.observer);

  await pool.sessions.cancelQueuedTurn(owner, queued.observer, queued.wakeId);
  assert.equal((await sessionOf(queued.observer)).status, 'RUNNING', 'the observer keeps the run it has');
  await assertDeadLettered(owner, queued, 'the wake was withdrawn', { code: 'WAKE_WITHDRAWN', deleted: true });
  assert.deepEqual(outcomesFor(await pool.delivery.drain(), queued.deliveryId), [], 'a dead letter is never claimed again');
  assert.deepEqual(
    (await turnsOn(queued.observer)).map(({ id, status }) => ({ id, status })),
    [
      { id: queued.current, status: 'IN_FLIGHT' },
      { id: otherWake.id, status: 'PENDING' },
      { id: message.id, status: 'PENDING' },
    ],
    'withdrawing the wake took more than its own turn off the queue',
  );
  assert.equal((await onlyDelivery(otherWatch)).state, 'DELIVERED', 'withdrawing one wake dead-lettered another');

  // A queued message that is not a wake is withdrawn as it always was, and no delivery moves.
  await pool.sessions.cancelQueuedTurn(owner, queued.observer, message.id);
  assert.deepEqual((await turnsOn(queued.observer)).filter((turn) => turn.id === message.id), [], 'the message was not withdrawn');
  assert.equal((await onlyDelivery(otherWatch)).state, 'DELIVERED', 'withdrawing a message dead-lettered a wake');

  // The control: a wake the runner took can no longer be withdrawn, and stays delivered.
  const taken = await wakeTakenByRunner(owner, runner, pool);
  await assert.rejects(pool.sessions.cancelQueuedTurn(owner, taken.observer, taken.wakeId), /already started or not found/);
  assert.equal((await onlyDelivery(taken.watchId)).state, 'DELIVERED', 'a wake the runner took was dead-lettered by a refused withdrawal');

  const [waiting] = (await turnsOn(bystander.observer)).filter((turn) => turn.id === bystander.wakeId);
  assert.equal(waiting?.status, 'PENDING', 'another observer lost its queued wake');
  assert.equal((await onlyDelivery(bystander.watchId)).state, 'DELIVERED', 'other observers\' withdrawals dead-lettered this one\'s wake');
});

test('a queued turn keyed watch:<id>:<a generation no integer holds> is not a wake: withdrawing it succeeds and changes no delivery', { skip, timeout: 120_000 }, async () => {
  const owner = await insertUser();
  const runner = await insertRunner(owner);
  const pool = await worker();
  const taken = await wakeTakenByRunner(owner, runner, pool);

  // No Match has such a generation: `watch_match.generation` is an integer.
  const forged = `watch:${taken.watchId}:2147483648`;
  await pool.sessions.createTurn(owner, taken.observer, { clientTurnId: forged, content: 'a message keyed past any generation', intent: 'NEXT_TURN' });
  const [turn] = (await turnsOn(taken.observer)).filter((row) => row.clientTurnId === forged);
  assert.equal(turn?.status, 'PENDING', 'the message waits behind the wake the runner took');
  await pool.sessions.cancelQueuedTurn(owner, taken.observer, turn.id);
  assert.deepEqual((await turnsOn(taken.observer)).filter((row) => row.clientTurnId === forged), [], 'the message was not withdrawn');
  assert.equal((await onlyDelivery(taken.watchId)).state, 'DELIVERED', 'withdrawing a message dead-lettered the wake the runner took');
});
