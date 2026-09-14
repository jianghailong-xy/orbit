/**
 * Independent QA of keys a client can forge in the Watch wake namespace, and of a runner completion that names
 * no turn, against a real PostgreSQL and the production apiserver process.
 *
 * Written by the QA session for task 34NPZIL9Hfavd9uqJ8tjD (tree under test: main 41780572); it changes no
 * product code. INTENTIONALLY RED until the defects below are fixed, as watch-core-qa-defects.pg.spec.ts was:
 * each FG-n / G1 case asserts what docs/watch-contract.md promises — a delivery reads DELIVERED only when its
 * wake reached the observer's queue, and a dead letter only when it did not — and fails on today's behaviour,
 * printing what it saw first. The -OK case is the paired control and passes. Do not merge this file into a
 * tree CI runs until the defects are fixed or the file is gated.
 *
 *   FG-1  squatting. `SessionTurnDto.clientTurnId` is free-form, so the owner's client — or the owner's agent
 *         through session_send / `--client-turn-id` — can queue a turn under a wake's key
 *         `watch:<id>:<generation|expired|revoked|unresolvable>` before the watch matches or ends. The delivery
 *         worker's createTurn then replays or conflicts onto that turn and acknowledges DELIVERED: the wake is
 *         never queued, and the observer is reported DELIVERED even when it is in Trash or Completed.
 *   FG-2  a forged queued turn keyed `watch:<id>:<any non-numeric suffix>` that is withdrawn, interrupted or
 *         drained unrun dead-letters that watch's end delivery, although its real wake already ran.
 *   FG-3  the same through a numeric alias: `watch:<id>:01` names generation 1, so a Match whose wake already
 *         ran is dead-lettered.
 *   FG-4-OK  the reach is the observer session itself: the same keys on another session of the owner, in
 *         another account, or an ordinary UUID key change no delivery, and another account cannot queue a turn
 *         on the observer at all.
 *   G1    POST /runner/sessions/:id/turn-complete without `turnId` answers every queued turn of the session, a
 *         wake among them, while its delivery stays DELIVERED. The shipped runner always sends `turnId`.
 *   FG-HTTP  FG-1 and FG-3 again through the production apiserver (build/main.js) and its public routes with an
 *         owner JWT: POST /api/watches, POST /api/sessions/:id/turns, DELETE /api/sessions/:id/turns/:turnId.
 *
 *     RUN_PG_SPEC_TIMEOUT=1500 bash scripts/run-pg-spec.sh src/apiserver/src/watches/watch-core-qa-forge.pg.spec.ts
 *
 * `WATCH_QA_ONLY=FG-2,FG-4-OK` registers only those cases (run-pg-spec.sh strips --test-name-pattern).
 * Non-destructive: every row carries an id this run generated; each case first retires what earlier cases left live.
 */
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { after, before, beforeEach, test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';

import { JwtService } from '@nestjs/jwt';
import type { PrismaClient } from '@prisma/client';
import { toUuid, uuidToBase62, WATCH_LIMITS } from '@orbit/shared';
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
import { WatchDeliveryResult, WatchDeliveryService } from './watch-delivery.service';
import { WatchEvaluatorService } from './watch-evaluator.service';
import { WatchesService } from './watches.service';

const URL = process.env.COORDINATOR_PG_URL;
const skip = !URL;
const ONLY = (process.env.WATCH_QA_ONLY ?? '').split(',').map((id) => id.trim()).filter(Boolean);
const HOUR = 60 * 60 * 1000;
const JWT_SECRET = `watch-qa-forge-${randomUUID()}`;
/** build/watches → build/main.js, the apiserver's production entry point. */
const MAIN = path.resolve(__dirname, '..', 'main.js');
const API_DIR = path.resolve(__dirname, '..', '..');

function qa(id: string, title: string, timeout: number, body: () => Promise<void>): void {
  if (ONLY.length > 0 && !ONLY.includes(id)) return;
  test(`${id} ${title}`, { skip, timeout }, body);
}

/** One line of what a case observed, kept in the TAP output as evidence. */
function note(id: string, facts: Record<string, unknown>): void {
  console.log(`QA-NOTE ${id} ${JSON.stringify(facts)}`);
}

const KINDS = ['MATCH', 'EXPIRY', 'REVOKED', 'UNRESOLVABLE'] as const;
type Kind = (typeof KINDS)[number];
const ALL_TERMINAL = { kind: 'ALL', over: 'ALL_TARGETS', leaf: 'TASK_TERMINAL' } as const;

const inert = <T>(): T =>
  new Proxy({}, { get: (_target, property) => (property === 'then' ? undefined : () => undefined) }) as T;
const push = { notifyWatchMatched: async () => undefined } as unknown as PushService;
const noHints = { localPublications: () => EMPTY } as unknown as RealtimeService;

// ── the harness ────────────────────────────────────────────────────────────────────────────────

let sql: Client;
let watches: WatchesService;
let evaluator: WatchEvaluatorService;
let stranger: string;
const clients: PrismaClient[] = [];
const loops: Array<{ stop(): Promise<unknown> }> = [];
const servers: Apiserver[] = [];
let heartbeat: ReturnType<typeof setInterval> | undefined;
const jwt = new JwtService({ secret: JWT_SECRET });

before(async () => {
  if (skip) return;
  assertCoordinatorPgUrlIsIsolated(URL);
  sql = new Client({ connectionString: URL, connectionTimeoutMillis: 10_000 });
  await sql.connect();
  await verifyCoordinatorPgIdentity(sql);
  const prisma = await pool();
  watches = new WatchesService(prisma as unknown as PrismaService);
  evaluator = new WatchEvaluatorService(prisma as unknown as PrismaService, noHints, { reconcileIntervalMs: HOUR, pollIntervalMs: HOUR });
  stranger = await insertUser();
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
  if (heartbeat) clearInterval(heartbeat);
  for (const server of servers.splice(0)) await server.kill('SIGKILL');
  for (const loop of loops.splice(0)) await loop.stop().catch(() => undefined);
  for (const client of clients.splice(0)) await client.$disconnect().catch(() => undefined);
  await sql?.end().catch(() => undefined);
});

async function pool(): Promise<PrismaClient> {
  const prisma = prismaClientFor(URL!);
  clients.push(prisma);
  await prisma.$executeRaw`SELECT 1`;
  return prisma;
}

interface Worker {
  prisma: PrismaClient;
  sessions: SessionsService;
  delivery: WatchDeliveryService;
}

async function worker(): Promise<Worker> {
  const prisma = await pool();
  const sessions = new SessionsService(prisma as unknown as PrismaService, inert<never>(), inert<never>());
  const delivery = new WatchDeliveryService(prisma as unknown as PrismaService, sessions, push, { retryBaseMs: 0, retryMaxMs: 0, pollIntervalMs: HOUR });
  loops.push(delivery);
  return { prisma, sessions, delivery };
}

interface Doors {
  api: RunnerApiController;
  complete(observer: string, turnId: string, status: 'SUCCEEDED' | 'FAILED'): Promise<unknown>;
  take(observer: string): Promise<string | null>;
}

function doorsFor(prisma: PrismaClient, runner: string): Doors {
  const api = new RunnerApiController(prisma as never, inert<never>(), inert<never>(), inert<never>(), inert<never>(), inert<never>(), inert<never>());
  const inbox = api as unknown as {
    dequeueTurn(sessionId: string, runnerId: string, leaseGeneration: null, acceptsSteer: boolean, declaredCapabilities: readonly string[]): Promise<{ turnId: string } | null>;
  };
  return {
    api,
    complete: (observer, turnId, status) =>
      api.turnComplete({ id: runner }, observer, {
        turnId,
        status,
        subtype: status === 'FAILED' ? 'error_during_execution' : 'completed',
        ...(status === 'FAILED' ? { result: 'API Error: 529 overloaded' } : {}),
        numTurns: 2,
        costUsd: 0,
      } as never),
    take: async (observer) => (await inbox.dequeueTurn(observer, runner, null, false, []))?.turnId ?? null,
  };
}

// ── fixtures ───────────────────────────────────────────────────────────────────────────────────

async function insertUser(): Promise<string> {
  const id = randomUUID();
  await sql.query(`INSERT INTO "user"("id","email","name","password_hash") VALUES ($1,$2,'watch qa forge','h')`, [id, `${id}@watch-qa.invalid`]);
  return id;
}

async function insertRunner(owner: string): Promise<string> {
  const id = randomUUID();
  await sql.query(
    `INSERT INTO "runner"("id","name","owner_id","token_hash","status","last_heartbeat_at","capabilities","max_concurrent")
     VALUES ($1,'watch qa forge',$2,$3,'ONLINE',clock_timestamp(),'{}'::text[],8)`,
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
     VALUES ($1,'watch qa forge','the opening prompt',$2,$2,now(),$3,$4,'claude',TRUE,1,now(),$5)`,
    [id, owner, status, runnerId, `runtime-${id}`],
  );
  return id;
}

/** A turn the session's runner holds, after whatever the session already has. */
async function insertRunningTurn(sessionId: string): Promise<string> {
  const id = randomUUID();
  await sql.query(
    `INSERT INTO "conversation_turn"("id","session_id","seq","client_turn_id","kind","content","status","delivered_at","lease_deadline_at")
     VALUES ($1,$2,COALESCE((SELECT max("seq") FROM "conversation_turn" WHERE "session_id" = $2), 0) + 1,$3,'message',
             'the turn the session is running','IN_FLIGHT',now(),now() + interval '2 hours')`,
    [id, sessionId, `current-${id}`],
  );
  return id;
}

function watchOn(task: string, observerSessionId: string): CreateWatchDto {
  return {
    predicateVersion: 1,
    predicate: ALL_TERMINAL,
    targets: [{ kind: 'TASK', id: task }],
    action: 'RESUME_SESSION',
    observerSessionId,
    ttlSeconds: WATCH_LIMITS.minTtlSeconds,
  } as unknown as CreateWatchDto;
}

function keyOf(kind: Kind, watchId: string): string {
  if (kind === 'MATCH') return `watch:${watchId}:1`;
  if (kind === 'EXPIRY') return `watch:${watchId}:expired`;
  return `watch:${watchId}:${kind.toLowerCase()}`;
}

async function bringAbout(kind: Kind, task: string): Promise<void> {
  const { rowCount } = kind === 'REVOKED'
    ? await sql.query(`UPDATE "task" SET "owner_id" = $2, "status" = 'FAILED' WHERE "id" = $1`, [task, stranger])
    : kind === 'MATCH'
      ? await sql.query(`UPDATE "task" SET "status" = 'FAILED' WHERE "id" = $1`, [task])
      : await sql.query(`DELETE FROM "task" WHERE "id" = $1`, [task]);
  assert.equal(rowCount, 1);
}

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

/** The watch comes to owe its observer this kind of wake: it matches, expires, is revoked or becomes unresolvable. */
async function endIt(kind: Kind, watchId: string, task: string): Promise<void> {
  if (kind === 'EXPIRY') await expire(watchId);
  else await bringAbout(kind, task);
  assert.equal((await evaluator.evaluate(watchId)).outcome, kind === 'EXPIRY' ? 'EXPIRED' : kind === 'MATCH' ? 'MATCHED' : kind);
}

interface Wake {
  kind: Kind;
  observer: string;
  watchId: string;
  deliveryId: string;
  key: string;
  wakeId: string;
}

/** A wake of this kind the runner took and ran to completion — DELIVERED, rightly — after which the observer runs another turn. */
async function ranWake(kind: Kind, owner: string, by: Worker): Promise<{ wake: Wake; doors: Doors; running: string }> {
  const runner = await insertRunner(owner);
  const observer = await insertSession(owner, 'RUNNING', runner);
  const current = await insertRunningTurn(observer);
  const task = await insertTask(owner, 'OPEN');
  const watch = await watches.create(owner, watchOn(task, observer));
  await endIt(kind, watch.id, task);
  const [delivery] = await deliveriesOf(watch.id);
  assert.deepEqual(outcomesFor(await by.delivery.drain(), delivery.id), ['DELIVERED']);
  const key = keyOf(kind, watch.id);
  const [queued] = await turnsKeyed(observer, key);
  const doors = doorsFor(by.prisma, runner);
  await doors.complete(observer, current, 'SUCCEEDED');
  assert.equal(await doors.take(observer), queued.id, `${kind}: the runner took the wake`);
  await doors.complete(observer, queued.id, 'SUCCEEDED');
  assert.equal((await turnById(queued.id))?.status, 'ANSWERED', `${kind}: the wake ran`);
  assert.equal((await deliveryOf(delivery.id)).state, 'DELIVERED');
  // The observer goes on to run something else, as its runner would report it.
  await sql.query(`UPDATE "session" SET "status" = 'RUNNING' WHERE "id" = $1`, [observer]);
  const running = await insertRunningTurn(observer);
  return { wake: { kind, observer, watchId: watch.id, deliveryId: delivery.id, key, wakeId: queued.id }, doors, running };
}

// ── reads ──────────────────────────────────────────────────────────────────────────────────────

interface DeliveryRow {
  id: string;
  kind: string;
  state: string;
  attempts: number;
  lastError: string | null;
}

async function deliveriesOf(watchId: string): Promise<DeliveryRow[]> {
  const { rows } = await sql.query<DeliveryRow>(
    `SELECT d."id", d."kind", d."state", d."attempts", d."last_error" AS "lastError"
       FROM "watch_delivery" d LEFT JOIN "watch_match" m ON m."id" = d."match_id"
      WHERE d."watch_id" = $1 OR m."watch_id" = $1 ORDER BY d."created_at", d."id"`,
    [watchId],
  );
  return rows;
}

async function deliveryOf(id: string): Promise<DeliveryRow> {
  const { rows } = await sql.query<DeliveryRow>(
    `SELECT "id", "kind", "state", "attempts", "last_error" AS "lastError" FROM "watch_delivery" WHERE "id" = $1`,
    [id],
  );
  return rows[0];
}

interface TurnRow {
  id: string;
  seq: number;
  clientTurnId: string;
  status: string;
  content: string | null;
}

const TURN_COLUMNS = `"id", "seq", "client_turn_id" AS "clientTurnId", "status", "content"`;

async function turnsOn(sessionId: string): Promise<TurnRow[]> {
  const { rows } = await sql.query<TurnRow>(`SELECT ${TURN_COLUMNS} FROM "conversation_turn" WHERE "session_id" = $1 ORDER BY "seq"`, [sessionId]);
  return rows;
}

async function turnsKeyed(sessionId: string, key: string): Promise<TurnRow[]> {
  const { rows } = await sql.query<TurnRow>(`SELECT ${TURN_COLUMNS} FROM "conversation_turn" WHERE "session_id" = $1 AND "client_turn_id" = $2`, [sessionId, key]);
  return rows;
}

async function turnById(id: string): Promise<TurnRow | undefined> {
  const { rows } = await sql.query<TurnRow>(`SELECT ${TURN_COLUMNS} FROM "conversation_turn" WHERE "id" = $1`, [id]);
  return rows[0];
}

async function sessionStatus(id: string): Promise<string> {
  const { rows } = await sql.query<{ status: string }>(`SELECT "status" FROM "session" WHERE "id" = $1`, [id]);
  return rows[0].status;
}

/** Whether any turn on the session carries this watch's wake, as the worker writes one. */
async function wakeWrittenFor(sessionId: string, watchId: string): Promise<boolean> {
  return (await turnsOn(sessionId)).some((turn) => (turn.content ?? '').startsWith(`Orbit Watch ${watchId} `));
}

const outcomesFor = (results: WatchDeliveryResult[], deliveryId: string): string[] =>
  results.filter((result) => result.deliveryId === deliveryId).map((result) => result.outcome);

async function eventually<T>(what: string, read: () => Promise<T>, done: (value: T) => boolean, timeoutMs = 30_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (done(value)) return value;
    if (Date.now() > deadline) assert.fail(`${what}: gave up after ${timeoutMs}ms at ${JSON.stringify(value)}`);
    await sleep(100);
  }
}

// ── cases ──────────────────────────────────────────────────────────────────────────────────────

qa('FG-1', 'a turn the owner queued earlier under a wake\'s key must not swallow the wake: the delivery may read DELIVERED only if the wake itself was queued, and an observer in Trash or Completed is a dead letter', 300_000, async () => {
  const owner = await insertUser();
  const by = await worker();
  const runner = await insertRunner(owner);
  const facts: Record<string, unknown> = {};
  const failures: string[] = [];

  const squatted = async (label: string, kind: Kind, afterSquat: (observer: string, turnId: string) => Promise<void>) => {
    const observer = await insertSession(owner, 'AWAITING_INPUT', runner);
    const task = await insertTask(owner, 'OPEN');
    const watch = await watches.create(owner, watchOn(task, observer));
    assert.equal(watch.state, 'ACTIVE');
    const key = keyOf(kind, watch.id);
    // POST /api/sessions/:id/turns hands this DTO to createTurn unchanged: nothing reserves the `watch:` namespace.
    const squat = await by.sessions.createTurn(owner, observer, { clientTurnId: key, content: 'a note from the owner, not a wake', intent: 'NEXT_TURN' });
    const [squatTurn] = await turnsKeyed(observer, key);
    await afterSquat(observer, squatTurn.id);
    await endIt(kind, watch.id, task);
    const [delivery] = await deliveriesOf(watch.id);
    const outcome = outcomesFor(await by.delivery.drain(), delivery.id);
    const settled = await deliveryOf(delivery.id);
    const wakeQueued = await wakeWrittenFor(observer, watch.id);
    const keyed = await turnsKeyed(observer, key);
    facts[label] = {
      squatAccepted: squat !== undefined,
      outcome,
      delivery: [settled.state, settled.lastError],
      turnsUnderKey: keyed.map((turn) => [turn.status, turn.content]),
      wakeQueued,
      observer: await sessionStatus(observer),
    };
    return { settled, wakeQueued };
  };

  for (const kind of KINDS) {
    const { settled, wakeQueued } = await squatted(`${kind}, squat still queued`, kind, async () => undefined);
    if (settled.state === 'DELIVERED' && !wakeQueued) failures.push(`${kind}: DELIVERED, yet no turn carries the wake — the squatted turn under its key does`);
  }
  // The squat already ran (answered, the observer back to waiting): the observer is never woken at all.
  {
    const { settled, wakeQueued } = await squatted('REVOKED, squat already answered', 'REVOKED', async (observer, turnId) => {
      await sql.query(`UPDATE "conversation_turn" SET "status" = 'ANSWERED', "delivered_at" = now(), "answered_at" = now() WHERE "id" = $1`, [turnId]);
      await sql.query(`UPDATE "session" SET "status" = 'AWAITING_INPUT' WHERE "id" = $1`, [observer]);
    });
    if (settled.state === 'DELIVERED' && !wakeQueued) failures.push('REVOKED after an answered squat: DELIVERED, and the observer was never woken');
  }
  // An observer whose life is over owes a dead letter, not DELIVERED.
  for (const [lifecycle, statement, code] of [
    ['Trash', `UPDATE "session" SET "deleted_at" = now() WHERE "id" = $1`, 'OBSERVER_SESSION_IN_TRASH'],
    ['Completed', `UPDATE "session" SET "completed_at" = now() WHERE "id" = $1`, 'OBSERVER_SESSION_COMPLETED'],
  ] as const) {
    const { settled } = await squatted(`UNRESOLVABLE, observer moved to ${lifecycle} after the squat`, 'UNRESOLVABLE', async (observer) => {
      await sql.query(statement, [observer]);
    });
    if (settled.state !== 'DEAD_LETTER' || !(settled.lastError ?? '').startsWith(`${code}:`)) {
      failures.push(`UNRESOLVABLE to an observer in ${lifecycle}: ${settled.state} ${settled.lastError ?? ''}, not a ${code} dead letter`);
    }
  }
  note('FG-1', facts);
  assert.deepEqual(failures, []);
});

qa('FG-2', 'a forged queued turn keyed watch:<id>:<non-numeric suffix> taken off the queue unrun must not dead-letter that watch\'s end delivery, whose real wake already ran', 300_000, async () => {
  const owner = await insertUser();
  const by = await worker();
  const facts: Record<string, unknown> = {};
  const failures: string[] = [];
  for (const kind of ['REVOKED', 'UNRESOLVABLE', 'EXPIRY'] as const) {
    for (const exit of ['withdraw', 'interrupt', 'running turn fails'] as const) {
      const { wake, doors, running } = await ranWake(kind, owner, by);
      const forgedKey = `watch:${wake.watchId}:anything`;
      await by.sessions.createTurn(owner, wake.observer, { clientTurnId: forgedKey, content: 'an owner message under a forged key', intent: 'NEXT_TURN' });
      const [forged] = await turnsKeyed(wake.observer, forgedKey);
      assert.equal(forged?.status, 'PENDING', 'the forged turn is queued behind the running turn');
      if (exit === 'withdraw') await by.sessions.cancelQueuedTurn(owner, wake.observer, forged.id);
      else if (exit === 'interrupt') await by.sessions.interrupt(owner, wake.observer);
      else await doors.complete(wake.observer, running, 'FAILED');
      const settled = await deliveryOf(wake.deliveryId);
      facts[`${kind} ${exit}`] = { realWake: (await turnById(wake.wakeId))?.status, delivery: [settled.state, settled.lastError] };
      if (settled.state !== 'DELIVERED') failures.push(`${kind}, ${exit} of ${forgedKey}: the end wake that ran now reads ${settled.state} (${settled.lastError})`);
    }
  }
  note('FG-2', facts);
  assert.deepEqual(failures, []);
});

qa('FG-3', 'a forged queued turn keyed watch:<id>:01 — a numeric alias of generation 1 — withdrawn unrun must not dead-letter the Match whose wake already ran', 300_000, async () => {
  const owner = await insertUser();
  const by = await worker();
  const facts: Record<string, unknown> = {};
  const failures: string[] = [];
  for (const alias of ['01', '0001', '1.0', '2']) {
    const { wake } = await ranWake('MATCH', owner, by);
    const forgedKey = `watch:${wake.watchId}:${alias}`;
    await by.sessions.createTurn(owner, wake.observer, { clientTurnId: forgedKey, content: 'an owner message under a forged key', intent: 'NEXT_TURN' });
    const [forged] = await turnsKeyed(wake.observer, forgedKey);
    await by.sessions.cancelQueuedTurn(owner, wake.observer, forged.id);
    const settled = await deliveryOf(wake.deliveryId);
    facts[alias] = { realWake: (await turnById(wake.wakeId))?.status, delivery: [settled.state, settled.lastError] };
    if (settled.state !== 'DELIVERED') failures.push(`${forgedKey} withdrawn: the Match whose wake ran now reads ${settled.state} (${settled.lastError})`);
  }
  note('FG-3', facts);
  assert.deepEqual(failures, []);
});

qa('FG-4-OK', 'the reach of a forged key is the observer session itself: on another session of the owner, in another account\'s session, or as an ordinary UUID key, taking it off the queue changes no delivery, and another account cannot queue on the observer', 300_000, async () => {
  const owner = await insertUser();
  const by = await worker();
  const end = await ranWake('REVOKED', owner, by);
  const match = await ranWake('MATCH', owner, by);
  const before = [await deliveryOf(end.wake.deliveryId), await deliveryOf(match.wake.deliveryId)];
  const keys = [`watch:${end.wake.watchId}:revoked`, `watch:${end.wake.watchId}:anything`, `watch:${match.wake.watchId}:1`, `watch:${match.wake.watchId}:01`];

  // Another session of the same owner, running a turn: every key queued there, then withdrawn, interrupted and drained.
  const elsewhereRunner = await insertRunner(owner);
  const elsewhere = await insertSession(owner, 'RUNNING', elsewhereRunner);
  const elsewhereCurrent = await insertRunningTurn(elsewhere);
  for (const key of keys) await by.sessions.createTurn(owner, elsewhere, { clientTurnId: key, content: 'elsewhere', intent: 'NEXT_TURN' });
  const [first] = await turnsKeyed(elsewhere, keys[0]);
  await by.sessions.cancelQueuedTurn(owner, elsewhere, first.id);
  await by.sessions.interrupt(owner, elsewhere);
  for (const key of keys) await by.sessions.createTurn(owner, elsewhere, { clientTurnId: `${key}-again`.replace(/-again$/, ''), content: 'elsewhere', intent: 'NEXT_TURN' }).catch(() => undefined);
  await doorsFor(by.prisma, elsewhereRunner).complete(elsewhere, elsewhereCurrent, 'FAILED');

  // Another account: it cannot queue on the owner's observer, and the same keys in its own session reach nothing.
  const intruder = await insertUser();
  const intruderRunner = await insertRunner(intruder);
  const intruderSession = await insertSession(intruder, 'RUNNING', intruderRunner);
  const intruderCurrent = await insertRunningTurn(intruderSession);
  await assert.rejects(
    by.sessions.createTurn(intruder, end.wake.observer, { clientTurnId: keys[1], content: 'intrusion', intent: 'NEXT_TURN' }),
    'another account queued a turn on the owner\'s observer',
  );
  for (const key of keys) await by.sessions.createTurn(intruder, intruderSession, { clientTurnId: key, content: 'intrusion', intent: 'NEXT_TURN' });
  const [intruded] = await turnsKeyed(intruderSession, keys[2]);
  await by.sessions.cancelQueuedTurn(intruder, intruderSession, intruded.id);
  await by.sessions.interrupt(intruder, intruderSession);
  await doorsFor(by.prisma, intruderRunner).complete(intruderSession, intruderCurrent, 'FAILED');

  // An ordinary UUID key on the observer itself, withdrawn.
  const plain = randomUUID();
  await by.sessions.createTurn(owner, end.wake.observer, { clientTurnId: plain, content: 'an ordinary message', intent: 'NEXT_TURN' });
  const [plainTurn] = await turnsKeyed(end.wake.observer, plain);
  await by.sessions.cancelQueuedTurn(owner, end.wake.observer, plainTurn.id);

  const later = [await deliveryOf(end.wake.deliveryId), await deliveryOf(match.wake.deliveryId)];
  note('FG-4-OK', { before, later });
  assert.deepEqual(later, before, 'a key queued outside the observer session reached its deliveries');
});

qa('G1', 'a runner completion that names no turn must not answer a queued wake unrun while its delivery reads DELIVERED', 300_000, async () => {
  const owner = await insertUser();
  const by = await worker();
  const facts: Record<string, unknown> = {};
  const failures: string[] = [];
  for (const status of ['SUCCEEDED', 'FAILED'] as const) {
    const runner = await insertRunner(owner);
    const observer = await insertSession(owner, 'RUNNING', runner);
    const current = await insertRunningTurn(observer);
    const task = await insertTask(owner, 'OPEN');
    const watch = await watches.create(owner, watchOn(task, observer));
    await endIt('REVOKED', watch.id, task);
    const [delivery] = await deliveriesOf(watch.id);
    assert.deepEqual(outcomesFor(await by.delivery.drain(), delivery.id), ['DELIVERED']);
    const [wake] = await turnsKeyed(observer, keyOf('REVOKED', watch.id));
    assert.equal(wake.status, 'PENDING');
    const { api } = doorsFor(by.prisma, runner);
    // POST /runner/sessions/:id/turn-complete whose body has no turnId.
    const reply = await api
      .turnComplete({ id: runner }, observer, {
        status,
        subtype: status === 'FAILED' ? 'error_during_execution' : 'completed',
        numTurns: 2,
        costUsd: 0,
      } as never)
      .then(() => 'accepted', (error: Error) => `refused: ${error.message}`);
    const settled = await deliveryOf(delivery.id);
    const wakeNow = await turnById(wake.id);
    facts[status] = { reply, current: (await turnById(current))?.status, wake: wakeNow?.status, delivery: settled.state, session: await sessionStatus(observer) };
    if (wakeNow?.status === 'ANSWERED' && settled.state === 'DELIVERED') failures.push(`${status} without turnId: the queued wake was answered unrun and its delivery still reads DELIVERED`);
  }
  note('G1', facts);
  assert.deepEqual(failures, []);
});

// ── the production apiserver ───────────────────────────────────────────────────────────────────

interface Apiserver {
  port: number;
  child: ChildProcess;
  output(): string;
  kill(signal: NodeJS.Signals): Promise<void>;
}

interface Reply {
  status: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  json: any;
  text: string;
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as net.AddressInfo;
      probe.close(() => resolve(port));
    });
  });
}

function request(server: Apiserver, method: string, route: string, options: { token?: string; body?: unknown } = {}): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const payload = options.body === undefined ? undefined : JSON.stringify(options.body);
    const req = http.request(
      {
        host: '127.0.0.1',
        port: server.port,
        path: route,
        method,
        agent: false,
        headers: {
          ...(payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {}),
          ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
        },
      },
      (res) => {
        const parts: Buffer[] = [];
        res.on('data', (chunk: Buffer) => parts.push(chunk));
        res.on('end', () => {
          const text = Buffer.concat(parts).toString('utf8');
          let json: unknown = null;
          try {
            json = JSON.parse(text);
          } catch {
            json = null;
          }
          resolve({ status: res.statusCode ?? 0, json, text });
        });
      },
    );
    req.on('error', reject);
    req.setTimeout(30_000, () => req.destroy(new Error(`${method} ${route} timed out`)));
    if (payload) req.write(payload);
    req.end();
  });
}

async function startApiserver(label: string): Promise<Apiserver> {
  const port = await freePort();
  const env: NodeJS.ProcessEnv = { ...process.env, DATABASE_URL: URL, JWT_SECRET, PORT: String(port), NO_COLOR: '1', CORS_ORIGINS: 'http://127.0.0.1' };
  delete env.NODE_TEST_CONTEXT;
  let log = '';
  const child = spawn(process.execPath, [MAIN], { cwd: API_DIR, env, stdio: ['ignore', 'pipe', 'pipe'] });
  const collect = (chunk: Buffer) => {
    log = (log + chunk.toString('utf8')).slice(-400_000);
  };
  child.stdout!.on('data', collect);
  child.stderr!.on('data', collect);
  const server: Apiserver = {
    port,
    child,
    output: () => log,
    async kill(signal) {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
      child.kill(signal);
      await Promise.race([exited, sleep(20_000)]);
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
        await exited;
      }
    },
  };
  servers.push(server);
  const deadline = Date.now() + 150_000;
  for (;;) {
    if (child.exitCode !== null) assert.fail(`${label}: the apiserver exited ${child.exitCode} before answering:\n${log.slice(-6_000)}`);
    const reply = await request(server, 'GET', '/api/auth/setup-status').catch(() => null);
    if (reply?.status === 200) return server;
    if (Date.now() > deadline) assert.fail(`${label}: the apiserver did not answer within 150s:\n${log.slice(-6_000)}`);
    await sleep(250);
  }
}

/** POST /api/watches for a RESUME_SESSION watch on one task, as a client sends it: public ids. */
async function createWatchOverHttp(server: Apiserver, token: string, task: string, observer: string): Promise<{ id: string; state: string }> {
  const body = {
    predicateVersion: 1,
    predicate: ALL_TERMINAL,
    targets: [{ kind: 'TASK', id: uuidToBase62(task) }],
    action: 'RESUME_SESSION',
    observerSessionId: uuidToBase62(observer),
    ttlSeconds: 3_600,
  };
  const created = await request(server, 'POST', '/api/watches', { token, body });
  assert.equal(created.status, 201, created.text);
  return { id: toUuid(created.json.id), state: created.json.state };
}

qa('FG-HTTP', 'through the production apiserver and its public routes with an owner JWT: a turn posted under an end wake\'s key must not swallow the wake, and a numeric alias withdrawn over DELETE must not dead-letter a Match whose wake is still queued', 600_000, async () => {
  const server = await startApiserver('FG-HTTP');
  const owner = await insertUser();
  const token = await jwt.signAsync({ sub: owner, email: `${owner}@watch-qa.invalid` });
  const runner = await insertRunner(owner);
  // The runner is online for the whole case, as a heartbeating one would be (the apiserver's reaper is running).
  heartbeat = setInterval(() => {
    void sql.query(`UPDATE "runner" SET "last_heartbeat_at" = clock_timestamp() WHERE "name" = 'watch qa forge'`).catch(() => undefined);
  }, 3_000);
  const facts: Record<string, unknown> = {};
  const failures: string[] = [];

  // 1. The squat, over POST /api/sessions/:id/turns, before the watch's target is given away.
  const observer = await insertSession(owner, 'AWAITING_INPUT', runner);
  const task = await insertTask(owner, 'OPEN');
  const watch = await createWatchOverHttp(server, token, task, observer);
  assert.equal(watch.state, 'ACTIVE');
  const key = `watch:${watch.id}:revoked`;
  const squat = await request(server, 'POST', `/api/sessions/${uuidToBase62(observer)}/turns`, {
    token,
    body: { clientTurnId: key, content: 'a note from the owner, not a wake', intent: 'NEXT_TURN' },
  });
  facts.squatReply = [squat.status, squat.text.slice(0, 200)];
  assert.ok(squat.status === 200 || squat.status === 201, `the public turn route refused a watch: key: ${squat.status} ${squat.text}`);
  // No event: the apiserver's own reconciliation (60s) finds the revocation, and its delivery loop settles the end.
  await bringAbout('REVOKED', task);
  const settledStates = await eventually(
    'the apiserver to revoke the watch and settle its end delivery',
    async () => (await deliveriesOf(watch.id)).map((row) => row.state),
    (states) => states.length === 1 && (states[0] === 'DELIVERED' || states[0] === 'DEAD_LETTER'),
    200_000,
  );
  const view = await request(server, 'GET', `/api/watches/${uuidToBase62(watch.id)}`, { token });
  const wakeQueued = await wakeWrittenFor(observer, watch.id);
  facts.squat = {
    delivery: settledStates[0],
    readOverHttp: [view.json?.state, (view.json?.expiryDeliveries ?? []).map((row: { kind: string; state: string }) => `${row.kind} ${row.state}`)],
    turnsUnderKey: (await turnsKeyed(observer, key)).map((turn) => [turn.status, turn.content]),
    wakeQueued,
  };
  if (settledStates[0] === 'DELIVERED' && !wakeQueued) failures.push('HTTP squat: the REVOKED end delivery reads DELIVERED, and no turn carries its wake');

  // 2. A numeric alias withdrawn over DELETE /api/sessions/:id/turns/:turnId while the real Match wake is still queued.
  const observer2 = await insertSession(owner, 'AWAITING_INPUT', runner);
  const matched = await createWatchOverHttp(server, token, await insertTask(owner, 'FAILED'), observer2);
  assert.equal(matched.state, 'MATCHED');
  const realKey = `watch:${matched.id}:1`;
  await eventually('the apiserver to queue the Match wake', () => turnsKeyed(observer2, realKey), (rows) => rows.length === 1, 60_000);
  await eventually('its delivery to read DELIVERED', async () => (await deliveriesOf(matched.id)).map((row) => row.state), (states) => states[0] === 'DELIVERED', 60_000);
  const alias = `watch:${matched.id}:01`;
  const forged = await request(server, 'POST', `/api/sessions/${uuidToBase62(observer2)}/turns`, {
    token,
    body: { clientTurnId: alias, content: 'an owner message under a numeric alias', intent: 'NEXT_TURN' },
  });
  const [forgedTurn] = await turnsKeyed(observer2, alias);
  assert.ok(forgedTurn, `the alias turn was not queued: ${forged.status} ${forged.text}`);
  const withdrawn = await request(server, 'DELETE', `/api/sessions/${uuidToBase62(observer2)}/turns/${forgedTurn.id}`, { token });
  const [matchDelivery] = await deliveriesOf(matched.id);
  const [realWake] = await turnsKeyed(observer2, realKey);
  facts.alias = {
    forgedReply: forged.status,
    withdrawReply: [withdrawn.status, withdrawn.text.slice(0, 200)],
    realWake: realWake?.status,
    delivery: [matchDelivery.state, matchDelivery.lastError],
  };
  if (matchDelivery.state !== 'DELIVERED') failures.push(`HTTP alias: the Match whose wake is still ${realWake?.status} now reads ${matchDelivery.state} (${matchDelivery.lastError})`);

  note('FG-HTTP', facts);
  if (heartbeat) clearInterval(heartbeat);
  heartbeat = undefined;
  await server.kill('SIGTERM');
  assert.deepEqual(failures, []);
});
