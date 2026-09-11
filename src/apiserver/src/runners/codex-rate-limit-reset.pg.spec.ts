/**
 * Codex rate-limit reset operations: admission, both idempotency layers and the persisted state
 * (docs/codex-rate-limit-reset-contract.md §5, §6.1, §7, §9.3; migration 0255).
 *
 * WHY REAL HTTP AND A REAL POSTGRESQL
 * ----------------------------------
 * Every claim here is about a boundary a unit test would fake. "A retried POST is the same operation"
 * and "of two racing confirmations one wins" are claims about unique indexes and about an
 * ON CONFLICT insert waiting on an uncommitted one. "The provider key never reaches the browser" is a
 * claim about response bytes after PublicIdInterceptor re-spelled them. "A backward move is refused"
 * has to hold for writers that are not the repository, which only a trigger in a real database shows.
 *
 * WHAT EACH CASE IS FOR
 * ---------------------
 *   (1) an eligible confirmation creates one PENDING operation; its provider key is a stored UUID that
 *       no body carries in any spelling, and GET reads it back by either id spelling.
 *   (2) a replay is 200 with the same row and key even after every admission condition broke, beside a
 *       non-replay refused on that same runner at that same moment.
 *   (3) a request id reused for another runner or account is refused with the existing operation's id;
 *       request ids belong to one owner.
 *   (4) concurrent POSTs: one request id → one 201 and replays; many ids → one 201 and in-flight 409s.
 *   (5) the same race with the interleaving forced: a POST waiting on an uncommitted insert replays it,
 *       reports it in flight, or — when it rolls back — creates its own row with its own key.
 *   (6) a client that times out after the commit, or retries while the first answer is still on its
 *       way, gets the operation its first request created.
 *   (7) owner / runner / workspace scope and authentication, each refusal writing nothing.
 *   (8) malformed bodies are 400 and write nothing.
 *   (9) every admission refusal, walked in the contract's order on one runner, each step repairing one
 *       condition, until the same request is created; plus the workspace override and the in-flight
 *       slot freeing once its operation settles.
 *  (10) a heartbeat writes the lease owner and draining flag admission reads; an old runner writes NULL.
 *  (11) consume and refresh are two persisted checkpoints, moved by the contract's own decisions.
 *  (12) the repository refuses illegal and backward moves, and writes nothing when it does.
 *  (13) the database refuses the same moves, and impossible rows, from a writer that bypasses it.
 *  (14) two transitions racing through the repository: one lands, the other is judged against it.
 *  (15) two raw updates racing: the guard refuses the second against the first's committed row.
 *
 *   bash scripts/test-codex-reset-operation.sh
 *
 * Not destructive: every case owns freshly generated users, runners and operations.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test, type TestContext } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';

import { Module, ValidationPipe, type CallHandler, type ExecutionContext, type NestInterceptor } from '@nestjs/common';
import { HttpAdapterHost, NestFactory, Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import type { PrismaClient } from '@prisma/client';
import {
  CODEX_RATE_LIMIT_RESET_CAPABILITY_V1,
  CODEX_RATE_LIMIT_RESET_WIRE,
  applyCodexResetResult,
  codexResetOperationViewViolations,
  decideCodexResetDispatch,
  expireCodexResetOperation,
  uuidToBase62,
  type CodexRateLimitResetOperationState,
  type PlanUsageRateLimitReset,
} from '@orbit/shared';
import { Client } from 'pg';
import { delay } from 'rxjs/operators';

import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PublicIdExceptionFilter } from '../common/public-id.filter';
import { PublicIdInterceptor } from '../common/public-id.interceptor';
import { TransientDbConflictFilter } from '../common/transient-db-conflict.filter';
import { prismaClientFor } from '../prisma/prisma-client';
import type { PrismaService } from '../prisma/prisma.service';
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from '../projects/coordinator-pg-test-safety';
import { RunnerApiController } from '../runner-api/runner-api.controller';
import { CodexRateLimitResetController } from './codex-rate-limit-reset.controller';
import { CodexRateLimitResetRepository, CodexResetTransitionRefused } from './codex-rate-limit-reset.repository';
import { CodexRateLimitResetService } from './codex-rate-limit-reset.service';

const URL = process.env.COORDINATOR_PG_URL;
const skip = !URL;

const CAPABILITY = CODEX_RATE_LIMIT_RESET_CAPABILITY_V1;
const FINGERPRINT = 'cxa1_92381c922ad04574cc61964161fd5687';
const OTHER_FINGERPRINT = 'cxa1_0123456789abcdef0123456789abcdef';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** Read by this spec's own interceptor: hold the answer back this long AFTER the handler — and so its
 *  transaction — has finished. A client that gives up in that window is a timeout after the commit. */
const HOLD = 'x-spec-hold-response-ms';
/** The contract's view fields, and the twins PublicIdInterceptor adds beside `id` and `runnerId`. */
const VIEW_FIELDS = Object.keys(CODEX_RATE_LIMIT_RESET_WIRE.CodexRateLimitResetOperationView);
const TWINS = ['publicId', 'runnerPublicId'];

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;
interface Sent {
  status: number;
  text: string;
  json: Json;
}
interface SendOptions {
  /** The user the bearer token stands for; null sends no token. */
  as?: string | null;
  body?: unknown;
  headers?: Record<string, string>;
  signal?: AbortSignal;
}
interface World {
  prisma: PrismaClient;
  sql: Client;
  repository: CodexRateLimitResetRepository;
  heartbeats: RunnerApiController;
  send(method: 'GET' | 'POST', path: string, options?: SendOptions): Promise<Sent>;
  /** Another connection to the same database, for holding locks and transactions open. */
  connect(): Promise<Client>;
}
interface Machine {
  id: string;
  ownerId: string;
  leaseOwner: string;
}
type StoredOperation = {
  id: string;
  key: string;
  clientRequestId: string;
  accountFingerprint: string;
  consumeState: string;
  consumeOutcome: string | null;
  refreshState: string;
  failureCode: string | null;
  claimGeneration: number;
  confirmedAt: string | null;
};

class HoldResponse implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler) {
    const request = context.switchToHttp().getRequest<{ headers: Record<string, string | undefined> }>();
    const ms = Number(request.headers[HOLD] ?? 0);
    return ms > 0 ? next.handle().pipe(delay(ms)) : next.handle();
  }
}

/** The routes as main.ts serves them — pipes, both id exits, the conflict boundary — over one database. */
async function world(t: TestContext): Promise<World> {
  const url = URL!;
  assertCoordinatorPgUrlIsIsolated(url);
  const sql = new Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
  await sql.connect();
  await verifyCoordinatorPgIdentity(sql);
  const prisma = prismaClientFor(url);
  const db = prisma as unknown as PrismaService;
  const repository = new CodexRateLimitResetRepository(db);
  const service = new CodexRateLimitResetService(db, repository);

  @Module({
    controllers: [CodexRateLimitResetController],
    providers: [
      { provide: CodexRateLimitResetService, useValue: service },
      JwtAuthGuard,
      Reflector,
      // The bearer token is the user id: JwtAuthGuard makes whatever `sub` this returns the caller.
      { provide: JwtService, useValue: { verifyAsync: async (token: string) => ({ sub: token }) } },
    ],
  })
  class ResetRoutes {}

  const app = await NestFactory.create(ResetRoutes, { logger: false, abortOnError: false });
  app.setGlobalPrefix('api');
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: false }));
  app.useGlobalInterceptors(new HoldResponse(), new PublicIdInterceptor());
  const adapter = app.get(HttpAdapterHost).httpAdapter;
  app.useGlobalFilters(new TransientDbConflictFilter(new PublicIdExceptionFilter(adapter), adapter));
  await app.listen(0, '127.0.0.1');
  const base = `${await app.getUrl()}/api`;
  const held: Client[] = [];
  t.after(async () => {
    // Connections a case held open go first. Their locks are what anything still waiting waits on, and
    // closing the pool while one of those waits is in flight would never return.
    for (const client of held) await client.end().catch(() => undefined);
    await app.close();
    await prisma.$disconnect().catch(() => undefined);
    await sql.end().catch(() => undefined);
  });

  // Only the heartbeat is called on it. Every collaborator it reaches after the runner write sits
  // inside the heartbeat's own try, so these empty stand-ins cost the relays, not the write.
  const heartbeats = new RunnerApiController(db, {} as never, {} as never, {} as never, {} as never, {} as never);

  return {
    prisma,
    sql,
    repository,
    heartbeats,
    async connect() {
      const client = new Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
      held.push(client);
      await client.connect();
      await verifyCoordinatorPgIdentity(client);
      return client;
    },
    async send(method, path, { as, body, headers, signal } = {}) {
      const response = await fetch(`${base}${path}`, {
        method,
        headers: {
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          ...(as ? { authorization: `Bearer ${as}` } : {}),
          ...headers,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal,
      });
      const text = await response.text();
      let json: Json = null;
      try {
        json = JSON.parse(text);
      } catch {
        json = null;
      }
      return { status: response.status, text, json };
    },
  };
}

async function newUser(prisma: PrismaClient): Promise<string> {
  const id = randomUUID();
  await prisma.user.create({ data: { id, email: `${id}@codex-reset.test`, name: 'codex reset', passwordHash: 'x' } });
  return id;
}

/** What this runner process's own read produced a minute ago: supported, identified, two credits. */
function block(leaseOwner: string, patch: Partial<PlanUsageRateLimitReset> = {}): PlanUsageRateLimitReset {
  return {
    protocolVersion: 1,
    support: 'SUPPORTED',
    accountFingerprint: FINGERPRINT,
    rateLimitResetCredits: { availableCount: 2, credits: null },
    fetchedAt: new Date(Date.now() - 60_000).toISOString(),
    generation: leaseOwner,
    sequence: 1,
    ...patch,
  };
}

function planUsage(reset: PlanUsageRateLimitReset): string {
  return JSON.stringify({ codex: { provider: 'codex', rateLimitReset: reset } });
}

/** A runner every admission check passes on: online, capable, leased, not draining, a fresh block. */
async function eligibleRunner(w: World, ownerId: string): Promise<Machine> {
  const id = randomUUID();
  const leaseOwner = randomUUID();
  await w.prisma.runner.create({
    data: {
      id,
      ownerId,
      name: `codex-reset-${id}`,
      tokenHash: randomUUID(),
      status: 'ONLINE',
      lastHeartbeatAt: new Date(),
      capabilities: [CAPABILITY],
      heartbeatLeaseOwner: leaseOwner,
      heartbeatDraining: false,
      planUsage: JSON.parse(planUsage(block(leaseOwner))),
    },
  });
  return { id, ownerId, leaseOwner };
}

function request(clientRequestId: string = randomUUID(), patch: Record<string, unknown> = {}): Record<string, unknown> {
  return { clientRequestId, accountFingerprint: FINGERPRINT, ...patch };
}

function post(w: World, machine: Machine, body: unknown, options: Omit<SendOptions, 'body'> = {}): Promise<Sent> {
  return w.send('POST', `/runners/${machine.id}/codex-rate-limit-reset`, { as: machine.ownerId, ...options, body });
}

/** Every operation of one runner as the table holds it, key included. */
async function stored(w: World, runnerId: string): Promise<StoredOperation[]> {
  const { rows } = await w.sql.query<StoredOperation>(
    `SELECT id::text AS "id", provider_idempotency_key::text AS "key", client_request_id::text AS "clientRequestId",
            account_fingerprint AS "accountFingerprint", consume_state AS "consumeState",
            consume_outcome AS "consumeOutcome", refresh_state AS "refreshState", failure_code AS "failureCode",
            claim_generation AS "claimGeneration", consume_confirmed_at::text AS "confirmedAt"
       FROM codex_rate_limit_reset_operation WHERE runner_id = $1 ORDER BY created_at, id`,
    [runnerId],
  );
  return rows;
}

/** The contract's operation view inside a body: exactly its fields beside the interceptor's two twins,
 *  and a valid view once those are set aside — the strict decoding a client applies. */
function contractView(body: Json): Record<string, unknown> {
  assert.equal(typeof body, 'object', `not an operation: ${JSON.stringify(body)}`);
  const view = Object.fromEntries(Object.entries(body as Record<string, unknown>).filter(([key]) => !TWINS.includes(key)));
  assert.deepEqual(Object.keys(view).sort(), [...VIEW_FIELDS].sort(), 'the view carries exactly the contract fields');
  assert.deepEqual(codexResetOperationViewViolations(view), []);
  assert.equal(body.publicId, view.id);
  assert.equal(body.runnerPublicId, view.runnerId);
  return view;
}

/** A body carries the provider key in no spelling, and does not name the field at all. */
function assertNoKey(text: string, key: string, where: string): void {
  assert.match(key, UUID);
  for (const spelling of [key, key.toUpperCase(), key.replace(/-/g, ''), uuidToBase62(key)]) {
    assert.equal(text.includes(spelling), false, `${where} carries the provider idempotency key as ${spelling}`);
  }
  assert.equal(/providerIdempotencyKey|provider_idempotency_key/i.test(text), false, `${where} names the provider key`);
}

async function eventually(what: string, check: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting until ${what}`);
    await sleep(20);
  }
}

/** Until `waiters` backends of this database wait on a lock. Every waiter a case creates queues behind
 *  the one connection that case holds open — directly, or behind another waiter's tuple lock, which is
 *  why this does not ask who blocks whom. A forced interleaving, not a sleep. */
async function lockWaiters(w: World, waiters = 1): Promise<void> {
  await eventually(`${waiters} backend(s) wait on a lock`, async () => {
    const { rows } = await w.sql.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM pg_stat_activity
        WHERE datname = current_database() AND cardinality(pg_blocking_pids(pid)) > 0`,
    );
    return rows[0].n >= waiters;
  });
}

/** Opens a transaction on `holder` and inserts an operation in it, left uncommitted. */
async function holdInsert(holder: Client, machine: Machine, clientRequestId: string): Promise<{ id: string; key: string }> {
  const id = randomUUID();
  const key = randomUUID();
  await holder.query('BEGIN');
  await holder.query(
    `INSERT INTO codex_rate_limit_reset_operation (id, owner_id, runner_id, account_fingerprint, client_request_id,
       provider_idempotency_key, consume_state, refresh_state, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, 'PENDING', 'NONE', now(), now())`,
    [id, machine.ownerId, machine.id, FINGERPRINT, clientRequestId, key],
  );
  return { id, key };
}

test('(1) an eligible confirmation creates one PENDING operation whose provider key is stored and never shown', {
  skip, timeout: 120_000,
}, async (t) => {
  const w = await world(t);
  const owner = await newUser(w.prisma);
  const machine = await eligibleRunner(w, owner);
  const clientRequestId = randomUUID();

  // The runner by its public id, the way a browser URL names it.
  const created = await w.send('POST', `/runners/${uuidToBase62(machine.id)}/codex-rate-limit-reset`, {
    as: owner,
    body: request(clientRequestId),
  });
  assert.equal(created.status, 201, created.text);
  assert.deepEqual(Object.keys(created.json).sort(), ['operation', 'replayed']);
  assert.equal(created.json.replayed, false);
  const view = contractView(created.json.operation);
  assert.deepEqual(
    [view.status, view.consumeState, view.consumeOutcome, view.refreshState, view.failureCode, view.lastErrorCode,
      view.consumeConfirmedAt, view.completedAt],
    ['PENDING', 'PENDING', null, 'NONE', null, null, null, null],
  );
  assert.equal(view.clientRequestId, clientRequestId);
  assert.equal(view.accountFingerprint, FINGERPRINT);
  assert.equal(view.runnerId, uuidToBase62(machine.id));

  const rows = await stored(w, machine.id);
  assert.equal(rows.length, 1);
  const [row] = rows;
  assert.equal(view.id, uuidToBase62(row.id));
  assert.match(row.key, UUID, 'the provider key is a UUID stored with the row');
  assert.notEqual(row.key, clientRequestId, 'the two idempotency keys are two values');
  assertNoKey(created.text, row.key, 'the 201');

  const listed = await w.send('GET', `/runners/${machine.id}/codex-rate-limit-reset`, { as: owner });
  assert.equal(listed.status, 200, listed.text);
  assert.deepEqual(Object.keys(listed.json).sort(), ['active', 'latest']);
  assert.deepEqual(contractView(listed.json.active), view);
  assert.deepEqual(contractView(listed.json.latest), view);
  assertNoKey(listed.text, row.key, 'the list');

  for (const spelling of [view.id as string, row.id]) {
    const one = await w.send('GET', `/runners/${machine.id}/codex-rate-limit-reset/${spelling}`, { as: owner });
    assert.equal(one.status, 200, `GET by ${spelling}: ${one.text}`);
    assert.deepEqual(contractView(one.json), view);
    assertNoKey(one.text, row.key, `GET by ${spelling}`);
  }
});

test('(2) a retried confirmation replays its operation: 200, the same key, eligibility not asked again', {
  skip, timeout: 120_000,
}, async (t) => {
  const w = await world(t);
  const owner = await newUser(w.prisma);
  const machine = await eligibleRunner(w, owner);
  const body = request();
  const first = await post(w, machine, body);
  assert.equal(first.status, 201, first.text);
  const before = await stored(w, machine.id);

  // Every condition admission refuses on, broken at once.
  await w.sql.query(
    `UPDATE runner SET status = 'OFFLINE', last_heartbeat_at = NULL, capabilities = '{}',
            heartbeat_lease_owner = NULL, heartbeat_draining = true, plan_usage = NULL
      WHERE id = $1`,
    [machine.id],
  );
  const again = await post(w, machine, body);
  assert.equal(again.status, 200, again.text);
  assert.equal(again.json.replayed, true);
  assert.deepEqual(contractView(again.json.operation), contractView(first.json.operation));
  assert.deepEqual(await stored(w, machine.id), before, 'the one row, with the key it was created with');
  assertNoKey(again.text, before[0].key, 'the replay');

  // Paired: a request that is not a replay is refused on this runner at this moment.
  const other = await post(w, machine, request(randomUUID(), { accountFingerprint: OTHER_FINGERPRINT }));
  assert.equal(other.status, 409, other.text);
  assert.deepEqual(other.json, { code: 'RUNNER_OFFLINE' });
});

test('(3) a request id reused for another runner or another account is refused and changes nothing', {
  skip, timeout: 120_000,
}, async (t) => {
  const w = await world(t);
  const owner = await newUser(w.prisma);
  const first = await eligibleRunner(w, owner);
  const second = await eligibleRunner(w, owner);
  const clientRequestId = randomUUID();
  const created = await post(w, first, request(clientRequestId));
  assert.equal(created.status, 201, created.text);
  const [operation] = await stored(w, first.id);

  const otherRunner = await post(w, second, request(clientRequestId));
  assert.equal(otherRunner.status, 409, otherRunner.text);
  assert.deepEqual(otherRunner.json, { code: 'REQUEST_ID_REUSED', operationId: operation.id });
  assert.deepEqual(await stored(w, second.id), []);

  const otherAccount = await post(w, first, request(clientRequestId, { accountFingerprint: OTHER_FINGERPRINT }));
  assert.equal(otherAccount.status, 409, otherAccount.text);
  assert.deepEqual(otherAccount.json, { code: 'REQUEST_ID_REUSED', operationId: operation.id });
  assert.deepEqual(await stored(w, first.id), [operation]);
  assertNoKey(`${otherRunner.text}${otherAccount.text}`, operation.key, 'the refusals');

  // Paired: the second runner was eligible all along, and a request id is one owner's only.
  assert.equal((await post(w, second, request())).status, 201);
  const stranger = await newUser(w.prisma);
  const theirs = await eligibleRunner(w, stranger);
  const sameIdAnotherOwner = await post(w, theirs, request(clientRequestId));
  assert.equal(sameIdAnotherOwner.status, 201, sameIdAnotherOwner.text);
  assert.equal(sameIdAnotherOwner.json.replayed, false);
});

test('(4) concurrent POSTs: one request id is one operation; many for one runner and account are one and the rest in flight', {
  skip, timeout: 180_000,
}, async (t) => {
  const w = await world(t);
  const owner = await newUser(w.prisma);
  const PARALLEL = 8;

  const retried = await eligibleRunner(w, owner);
  const body = request();
  const same = await Promise.all(Array.from({ length: PARALLEL }, () => post(w, retried, body)));
  assert.deepEqual(
    same.map((answer) => answer.status).sort((a, b) => a - b),
    [...Array(PARALLEL - 1).fill(200), 201],
    same.map((answer) => `${answer.status} ${answer.text}`).join('\n'),
  );
  const retriedRows = await stored(w, retried.id);
  assert.equal(retriedRows.length, 1);
  for (const answer of same) {
    assert.equal(contractView(answer.json.operation).id, uuidToBase62(retriedRows[0].id));
    assertNoKey(answer.text, retriedRows[0].key, 'a concurrent answer');
  }

  const raced = await eligibleRunner(w, owner);
  const many = await Promise.all(Array.from({ length: PARALLEL }, () => post(w, raced, request())));
  const winners = many.filter((answer) => answer.status === 201);
  assert.equal(winners.length, 1, many.map((answer) => `${answer.status} ${answer.text}`).join('\n'));
  const racedRows = await stored(w, raced.id);
  assert.equal(racedRows.length, 1);
  assert.equal(contractView(winners[0].json.operation).id, uuidToBase62(racedRows[0].id));
  for (const loser of many.filter((answer) => answer.status !== 201)) {
    assert.equal(loser.status, 409, loser.text);
    assert.deepEqual(loser.json, { code: 'OPERATION_IN_FLIGHT', operationId: racedRows[0].id });
  }
});

test('(5) a confirmation waiting on an uncommitted one resolves to what that one did', {
  skip, timeout: 120_000,
}, async (t) => {
  const w = await world(t);
  const owner = await newUser(w.prisma);
  const holder = await w.connect();

  // Committed, with the same request id: the waiting POST is its replay.
  const replayed = await eligibleRunner(w, owner);
  const sameRequest = randomUUID();
  const held = await holdInsert(holder, replayed, sameRequest);
  const waiting = post(w, replayed, request(sameRequest));
  await lockWaiters(w);
  await holder.query('COMMIT');
  const replay = await waiting;
  assert.equal(replay.status, 200, replay.text);
  assert.equal(replay.json.replayed, true);
  assert.equal(contractView(replay.json.operation).id, uuidToBase62(held.id));
  assert.deepEqual((await stored(w, replayed.id)).map((row) => row.key), [held.key]);

  // Committed, with another request id: the waiting POST finds it in flight.
  const inFlight = await eligibleRunner(w, owner);
  const other = await holdInsert(holder, inFlight, randomUUID());
  const waitingToo = post(w, inFlight, request());
  await lockWaiters(w);
  await holder.query('COMMIT');
  const refused = await waitingToo;
  assert.equal(refused.status, 409, refused.text);
  assert.deepEqual(refused.json, { code: 'OPERATION_IN_FLIGHT', operationId: other.id });
  assert.equal((await stored(w, inFlight.id)).length, 1);

  // Rolled back: nothing was taken, so the waiting POST creates its own row with a key of its own.
  const rolledBack = await eligibleRunner(w, owner);
  const abandonedRequest = randomUUID();
  const abandoned = await holdInsert(holder, rolledBack, abandonedRequest);
  const waitingThree = post(w, rolledBack, request(abandonedRequest));
  await lockWaiters(w);
  await holder.query('ROLLBACK');
  const created = await waitingThree;
  assert.equal(created.status, 201, created.text);
  const rows = await stored(w, rolledBack.id);
  assert.equal(rows.length, 1);
  assert.notEqual(rows[0].id, abandoned.id);
  assert.notEqual(rows[0].key, abandoned.key);
});

test('(6) a client that gives up before the answer, or retries ahead of it, gets the operation it created', {
  skip, timeout: 120_000,
}, async (t) => {
  const w = await world(t);
  const owner = await newUser(w.prisma);

  // Committed, then the answer held back past the client's patience.
  const machine = await eligibleRunner(w, owner);
  const body = request();
  const impatient = new AbortController();
  const lost = post(w, machine, body, { headers: { [HOLD]: '3000' }, signal: impatient.signal });
  await eventually('the first request committed its operation', async () => (await stored(w, machine.id)).length === 1);
  impatient.abort();
  await assert.rejects(lost, (error: Error) => error.name === 'AbortError');
  const committed = await stored(w, machine.id);
  const retry = await post(w, machine, body);
  assert.equal(retry.status, 200, retry.text);
  assert.equal(retry.json.replayed, true);
  assert.equal(contractView(retry.json.operation).id, uuidToBase62(committed[0].id));
  assert.deepEqual(await stored(w, machine.id), committed);
  assertNoKey(retry.text, committed[0].key, 'the retry');

  // A retry that overtakes the first answer while it is still on its way.
  const overtaken = await eligibleRunner(w, owner);
  const slowBody = request();
  const slow = post(w, overtaken, slowBody, { headers: { [HOLD]: '1500' } });
  await eventually('the slow request committed its operation', async () => (await stored(w, overtaken.id)).length === 1);
  const fast = await post(w, overtaken, slowBody);
  assert.equal(fast.status, 200, fast.text);
  assert.equal(fast.json.replayed, true);
  const late = await slow;
  assert.equal(late.status, 201, late.text);
  assert.equal(contractView(late.json.operation).id, contractView(fast.json.operation).id);
  assert.equal((await stored(w, overtaken.id)).length, 1);
});

test('(7) scope: another owner’s runner, another runner’s operation, a foreign workspace, no token', {
  skip, timeout: 120_000,
}, async (t) => {
  const w = await world(t);
  const owner = await newUser(w.prisma);
  const stranger = await newUser(w.prisma);
  const machine = await eligibleRunner(w, owner);
  const sibling = await eligibleRunner(w, owner);
  const path = `/runners/${machine.id}/codex-rate-limit-reset`;

  const asStranger: Array<['GET' | 'POST', string]> = [['POST', path], ['GET', path], ['GET', `${path}/${randomUUID()}`]];
  for (const [method, target] of asStranger) {
    const answer = await w.send(method, target, { as: stranger, body: method === 'POST' ? request() : undefined });
    assert.equal(answer.status, 404, `${method} ${target} as another owner: ${answer.text}`);
  }
  const anonymous: Array<['GET' | 'POST', string]> = [['POST', path], ['GET', path]];
  for (const [method, target] of anonymous) {
    const answer = await w.send(method, target, { as: null, body: method === 'POST' ? request() : undefined });
    assert.equal(answer.status, 401, `${method} ${target} without a token: ${answer.text}`);
  }

  const foreignWorkspace = await w.prisma.workspace.create({ data: { name: `theirs-${randomUUID()}`, ownerId: stranger } });
  const siblingWorkspace = await w.prisma.workspace.create({
    data: { name: `other-machine-${randomUUID()}`, ownerId: owner, runnerId: sibling.id },
  });
  for (const workspaceId of [foreignWorkspace.id, siblingWorkspace.id, randomUUID()]) {
    const answer = await post(w, machine, request(randomUUID(), { workspaceId }));
    assert.equal(answer.status, 404, `workspace ${workspaceId}: ${answer.text}`);
  }
  assert.deepEqual(await stored(w, machine.id), [], 'no refusal above wrote a row');

  // Paired: the owner creates on their own runner — and it is still not readable through the other one.
  const created = await post(w, machine, request());
  assert.equal(created.status, 201, created.text);
  const operationId = contractView(created.json.operation).id as string;
  assert.equal((await w.send('GET', `${path}/${operationId}`, { as: owner })).status, 200);
  assert.equal((await w.send('GET', `/runners/${sibling.id}/codex-rate-limit-reset/${operationId}`, { as: owner })).status, 404);
  assert.equal((await w.send('GET', `${path}/${operationId}`, { as: stranger })).status, 404);
  const siblingList = await w.send('GET', `/runners/${sibling.id}/codex-rate-limit-reset`, { as: owner });
  assert.deepEqual(siblingList.json, { active: null, latest: null });
});

test('(8) a malformed body is a 400 and writes nothing', { skip, timeout: 120_000 }, async (t) => {
  const w = await world(t);
  const owner = await newUser(w.prisma);
  const machine = await eligibleRunner(w, owner);
  const cases: Array<[string, unknown]> = [
    ['no clientRequestId', { accountFingerprint: FINGERPRINT }],
    ['a clientRequestId that is not a canonical lowercase UUID', request(randomUUID().toUpperCase())],
    ['no accountFingerprint', { clientRequestId: randomUUID() }],
    ['an email where the fingerprint goes', request(randomUUID(), { accountFingerprint: 'someone@example.test' })],
    ['a provider key smuggled in', request(randomUUID(), { providerIdempotencyKey: randomUUID() })],
    ['a creditId, which protocol v1 does not have', request(randomUUID(), { creditId: 'rlrc_fixture_1' })],
    ['a blank workspaceId', request(randomUUID(), { workspaceId: '   ' })],
    ['a workspaceId that is no id at all', request(randomUUID(), { workspaceId: 'no such id!' })],
    ['an array', [request()]],
  ];
  for (const [what, body] of cases) {
    const answer = await post(w, machine, body);
    assert.equal(answer.status, 400, `${what}: ${answer.status} ${answer.text}`);
  }
  const badRunner = await w.send('POST', '/runners/not-a-runner!/codex-rate-limit-reset', { as: owner, body: request() });
  assert.equal(badRunner.status, 400, badRunner.text);
  assert.deepEqual(await stored(w, machine.id), []);

  // Paired: the same runner takes a well-formed one.
  assert.equal((await post(w, machine, request())).status, 201);
});

/** The heartbeat relay's own decision for `machine`'s process, persisted: a first claim. */
function claim(w: World, machine: Machine, id: string): Promise<CodexRateLimitResetOperationState | null> {
  return w.repository.transition(id, (op) => {
    const decision = decideCodexResetDispatch(op, {
      runnerId: machine.id,
      leaseOwner: machine.leaseOwner,
      draining: false,
      capabilities: [CAPABILITY],
      rateLimitReset: block(machine.leaseOwner),
      now: new Date(),
    });
    assert.equal(decision.kind, 'DELIVER', JSON.stringify(decision));
    return decision.kind === 'DELIVER' ? decision.operation : null;
  });
}

/** A result from `machine`'s current claim, applied by the contract's own function and persisted. */
function apply(
  w: World,
  machine: Machine,
  id: string,
  fields: Record<string, unknown>,
): Promise<CodexRateLimitResetOperationState | null> {
  return w.repository.transition(id, (op) => {
    const applied = applyCodexResetResult(op, machine.id, {
      protocolVersion: 1,
      operationId: op.id,
      leaseOwner: machine.leaseOwner,
      claimGeneration: op.claimGeneration,
      ...fields,
    }, new Date());
    assert.equal(applied.kind, 'APPLIED', JSON.stringify(applied));
    return applied.kind === 'APPLIED' ? applied.operation : null;
  });
}

/** A database refusal: its SQLSTATE, and the guard's message or the constraint that raised it. */
async function refusedBy(
  write: Promise<unknown>,
  expected: { code?: string; message?: string; constraint?: string },
  what: string,
): Promise<void> {
  await assert.rejects(write, (error: { code?: string; message?: string; constraint?: string }) => {
    assert.equal(error.code, expected.code ?? '23514', `${what}: ${error.message}`);
    if (expected.message !== undefined) assert.equal(error.message?.includes(expected.message), true, `${what}: ${error.message}`);
    if (expected.constraint !== undefined) assert.equal(error.constraint, expected.constraint, `${what}: ${error.message}`);
    return true;
  }, what);
}

test('(9) every admission refusal, in the contract’s order, until the same request is created', {
  skip, timeout: 180_000,
}, async (t) => {
  const w = await world(t);
  const owner = await newUser(w.prisma);

  // One runner, every runner-level condition broken at once, then repaired one at a time: each answer
  // is the FIRST refusal in CODEX_RATE_LIMIT_RESET_ELIGIBILITY_ORDER that still holds.
  const machine = await eligibleRunner(w, owner);
  const body = request();
  const setRunner = (assignments: string, ...params: unknown[]) =>
    w.sql.query(`UPDATE runner SET ${assignments} WHERE id = $1`, [machine.id, ...params]);
  const setBlock = (patch: Partial<PlanUsageRateLimitReset>) =>
    setRunner('plan_usage = $2::jsonb', planUsage(block(machine.leaseOwner, patch)));
  const listedCredit = {
    id: 'rlrc_fixture_1', resetType: 'codexRateLimits', status: 'available',
    grantedAt: '2026-08-29T10:40:00Z', expiresAt: null, title: null, description: null,
  };
  await setRunner(
    `status = 'OFFLINE', last_heartbeat_at = now() - interval '5 minutes', capabilities = '{}',
     heartbeat_lease_owner = NULL, heartbeat_draining = true, plan_usage = NULL`,
  );
  const walk: Array<[string, () => Promise<unknown>]> = [
    ['RUNNER_OFFLINE', () => setRunner(`status = 'ONLINE', last_heartbeat_at = now()`)],
    ['CAPABILITY_MISSING', () => setRunner('capabilities = $2::text[]', [CAPABILITY])],
    ['NO_ACTIVE_LEASE', () => setRunner('heartbeat_lease_owner = $2::uuid', machine.leaseOwner)],
    ['RUNNER_DRAINING', () => setRunner('heartbeat_draining = false')],
    // No plan usage at all, then an old runner's Codex usage with no reset block, then a block from a
    // protocol this server does not speak: all three are "no snapshot", never "zero credits".
    ['SNAPSHOT_MISSING', () => setRunner('plan_usage = $2::jsonb', JSON.stringify({ codex: { provider: 'codex' } }))],
    ['SNAPSHOT_MISSING', () => setBlock({ protocolVersion: 2 })],
    ['SNAPSHOT_MISSING', () => setBlock({ support: 'UNSUPPORTED_AUTH', accountFingerprint: undefined, rateLimitResetCredits: null })],
    ['UNSUPPORTED_AUTH', () => setBlock({ support: 'PROVIDER_UNSUPPORTED', accountFingerprint: undefined, rateLimitResetCredits: null })],
    ['PROVIDER_UNSUPPORTED', () => setBlock({ support: 'ACCOUNT_UNIDENTIFIED', accountFingerprint: undefined, rateLimitResetCredits: null })],
    ['ACCOUNT_UNIDENTIFIED', () => setBlock({ accountFingerprint: OTHER_FINGERPRINT })],
    ['ACCOUNT_MISMATCH', () => setBlock({ fetchedAt: new Date(Date.now() - 16 * 60_000).toISOString() })],
    ['SNAPSHOT_STALE', () => setBlock({ fetchedAt: new Date(Date.now() + 6 * 60_000).toISOString() })],
    ['SNAPSHOT_STALE', () => setBlock({ support: 'CREDITS_UNAVAILABLE', rateLimitResetCredits: null })],
    // The count is `availableCount`, even when the detail lists an available credit beside a zero.
    ['CREDITS_UNAVAILABLE', () => setBlock({ rateLimitResetCredits: { availableCount: 0, credits: [listedCredit] } })],
    ['NO_CREDIT_AVAILABLE', () => setBlock({})],
  ];
  for (const [code, repair] of walk) {
    const answer = await post(w, machine, body);
    assert.equal(answer.status, 409, `expected ${code}: ${answer.status} ${answer.text}`);
    assert.deepEqual(answer.json, { code });
    assert.deepEqual(await stored(w, machine.id), [], `${code} wrote a row`);
    await repair();
  }
  const created = await post(w, machine, body);
  assert.equal(created.status, 201, `every condition repaired: ${created.text}`);
  assert.equal(created.json.replayed, false, 'no refusal above burned the request id');

  // ACCOUNT_OVERRIDE, first of all, and only for a confirmation made from a workspace.
  const contextual = await eligibleRunner(w, owner);
  const workspace = await w.prisma.workspace.create({
    data: { name: `codex-reset-${randomUUID()}`, ownerId: owner, runnerId: contextual.id, env: { OPENAI_API_KEY: 'sk-spec' } },
  });
  const fromWorkspace = () => post(w, contextual, request(randomUUID(), { workspaceId: uuidToBase62(workspace.id) }));
  const session = (provider: string, providerBuiltin: boolean, at: number) =>
    w.prisma.session.create({
      data: {
        ownerId: owner, creatorId: owner, title: 'codex reset context', prompt: 'codex reset context',
        provider, providerBuiltin, workspaceId: workspace.id, startsTaskWork: false, createdAt: new Date(at),
      },
    });
  const overridden = async (why: string) => {
    const answer = await fromWorkspace();
    assert.equal(answer.status, 409, `${why}: ${answer.text}`);
    assert.deepEqual(answer.json, { code: 'ACCOUNT_OVERRIDE' }, why);
  };
  await overridden('an OPENAI_* key in the workspace env');
  await w.prisma.workspace.update({ where: { id: workspace.id }, data: { env: { CODEX_HOME: '' } } });
  await overridden('a workspace whose sessions never ran Codex starts on Claude');
  const start = Date.now();
  await session('codex', false, start - 3_000);
  await overridden('a configured provider, whatever its slug');
  await session('codex', true, start - 2_000);
  await w.prisma.workspace.update({ where: { id: workspace.id }, data: { env: { CODEX_API_KEY: 'sk-spec' } } });
  await overridden('the built-in Codex, but on an API key of its own');
  await w.prisma.workspace.update({ where: { id: workspace.id }, data: { env: { CODEX_HOME: '' } } });
  const fromCodexWorkspace = await fromWorkspace();
  assert.equal(fromCodexWorkspace.status, 201, `the built-in Codex on the runner's own login: ${fromCodexWorkspace.text}`);
  await w.prisma.workspace.update({ where: { id: workspace.id }, data: { env: { OPENAI_BASE_URL: 'http://proxy' } } });
  await overridden('ACCOUNT_OVERRIDE is answered before OPERATION_IN_FLIGHT');

  // OPERATION_IN_FLIGHT, until the operation in the way settles.
  const busy = await eligibleRunner(w, owner);
  assert.equal((await post(w, busy, request())).status, 201);
  const [inTheWay] = await stored(w, busy.id);
  const blocked = await post(w, busy, request());
  assert.equal(blocked.status, 409, blocked.text);
  assert.deepEqual(blocked.json, { code: 'OPERATION_IN_FLIGHT', operationId: inTheWay.id });
  const expired = await w.repository.transition(inTheWay.id, (op) =>
    expireCodexResetOperation(op, new Date(Date.parse(op.createdAt) + 11 * 60_000)));
  assert.deepEqual([expired?.consumeState, expired?.failureCode], ['NOT_ATTEMPTED', 'CONSUME_EXPIRED']);
  const afterSettling = await post(w, busy, request());
  assert.equal(afterSettling.status, 201, afterSettling.text);
});

test('(10) a heartbeat writes the lease owner and draining flag admission reads; an old runner writes NULL', {
  skip, timeout: 120_000,
}, async (t) => {
  const w = await world(t);
  const owner = await newUser(w.prisma);
  const id = randomUUID();
  await w.prisma.runner.create({ data: { id, ownerId: owner, name: `codex-reset-heartbeat-${id}`, tokenHash: randomUUID() } });
  const machine: Machine = { id, ownerId: owner, leaseOwner: randomUUID() };
  const beat = (dto: Record<string, unknown>, capabilities?: string) =>
    w.heartbeats.heartbeat({ id, version: null }, { status: 'ONLINE', idleCapacity: 1, ...dto } as never, capabilities);
  const columns = async () =>
    (await w.sql.query<{ lease: string | null; draining: boolean | null; capabilities: string[] }>(
      'SELECT heartbeat_lease_owner::text AS lease, heartbeat_draining AS draining, capabilities FROM runner WHERE id = $1',
      [id],
    )).rows[0];
  const usage = JSON.parse(planUsage(block(machine.leaseOwner)));

  const draining = await beat({ leaseOwner: machine.leaseOwner, draining: true, planUsage: usage }, CAPABILITY);
  assert.equal('codexRateLimitResetRequest' in draining, false, 'admission relays nothing to a runner');
  assert.deepEqual(await columns(), { lease: machine.leaseOwner, draining: true, capabilities: [CAPABILITY] });
  const whileDraining = await post(w, machine, request());
  assert.deepEqual([whileDraining.status, whileDraining.json], [409, { code: 'RUNNER_DRAINING' }]);

  // The same process, no longer draining: the Go runner omits a false flag, and the column follows.
  await beat({ leaseOwner: machine.leaseOwner, planUsage: usage }, CAPABILITY);
  assert.deepEqual(await columns(), { lease: machine.leaseOwner, draining: null, capabilities: [CAPABILITY] });
  const created = await post(w, machine, request());
  assert.equal(created.status, 201, created.text);

  // An old runner: no leaseOwner, no draining flag, no capability header, no reset block.
  const legacy = await beat({ version: '0.1.180', planUsage: { codex: { provider: 'codex' } } });
  assert.equal('codexRateLimitResetRequest' in legacy, false);
  assert.deepEqual(await columns(), { lease: null, draining: null, capabilities: [] });
  const fromOldRunner = await post(w, machine, request(randomUUID(), { accountFingerprint: OTHER_FINGERPRINT }));
  assert.deepEqual([fromOldRunner.status, fromOldRunner.json], [409, { code: 'CAPABILITY_MISSING' }]);
});

test('(11) consume and refresh are two persisted checkpoints, moved by the contract’s own decisions', {
  skip, timeout: 120_000,
}, async (t) => {
  const w = await world(t);
  const owner = await newUser(w.prisma);
  const machine = await eligibleRunner(w, owner);
  const path = `/runners/${machine.id}/codex-rate-limit-reset`;
  const read = async (id: string) => contractView((await w.send('GET', `${path}/${id}`, { as: owner })).json);

  assert.equal((await post(w, machine, request())).status, 201);
  const [{ id, key }] = await stored(w, machine.id);

  const claimed = await claim(w, machine, id);
  assert.deepEqual(
    [claimed?.consumeState, claimed?.claimGeneration, claimed?.claimLeaseOwner, claimed?.claimsWithUnknownCall],
    ['CLAIMED', 1, machine.leaseOwner, 1],
  );
  assert.equal((await read(id)).status, 'CONSUMING');

  // The provider answered `reset`: the consume checkpoint is final, the refresh checkpoint has only begun.
  await apply(w, machine, id, { phase: 'CONSUME', kind: 'CONSUME_OUTCOME', outcome: 'reset' });
  const [confirmed] = await stored(w, machine.id);
  assert.deepEqual([confirmed.consumeState, confirmed.consumeOutcome, confirmed.refreshState], ['CONFIRMED', 'reset', 'PENDING']);
  assert.ok(confirmed.confirmedAt, 'the confirmation time is stored with the outcome');
  const refreshing = await read(id);
  assert.deepEqual(
    [refreshing.status, refreshing.consumeState, refreshing.refreshState, refreshing.completedAt],
    ['REFRESHING', 'CONFIRMED', 'PENDING', null],
  );

  // A recoverable refresh failure is recorded as the last error, and moves neither checkpoint.
  await apply(w, machine, id, { phase: 'REFRESH', kind: 'REFRESH_FAILED', code: 'READ_FAILED' });
  const retrying = await read(id);
  assert.deepEqual([retrying.status, retrying.consumeState, retrying.refreshState, retrying.lastErrorCode],
    ['REFRESHING', 'CONFIRMED', 'PENDING', 'READ_FAILED']);

  // The refresh fails for good. Its checkpoint settles; the consume checkpoint does not move by a byte.
  await apply(w, machine, id, { phase: 'REFRESH', kind: 'REFRESH_FAILED', code: 'ACCOUNT_MISMATCH' });
  const [failed] = await stored(w, machine.id);
  assert.deepEqual(
    [failed.consumeState, failed.consumeOutcome, failed.confirmedAt, failed.refreshState, failed.failureCode],
    ['CONFIRMED', 'reset', confirmed.confirmedAt, 'FAILED', 'ACCOUNT_MISMATCH'],
  );
  const failedView = await read(id);
  assert.deepEqual([failedView.status, failedView.consumeState, failedView.refreshState, failedView.failureCode],
    ['REFRESH_FAILED', 'CONFIRMED', 'FAILED', 'ACCOUNT_MISMATCH']);
  assert.equal(failed.key, key, 'the provider key survived every move');

  // Settled, the slot is free. The next one reaches SUCCEEDED through alreadyRedeemed and a refreshed block.
  assert.equal((await post(w, machine, request())).status, 201);
  const next = (await stored(w, machine.id)).find((row) => row.id !== id)!;
  await claim(w, machine, next.id);
  await apply(w, machine, next.id, { phase: 'CONSUME', kind: 'CONSUME_OUTCOME', outcome: 'alreadyRedeemed' });
  await apply(w, machine, next.id, { phase: 'REFRESH', kind: 'REFRESHED', rateLimitReset: block(machine.leaseOwner, { sequence: 2 }) });
  const succeeded = await read(next.id);
  assert.deepEqual([succeeded.status, succeeded.consumeOutcome, succeeded.refreshState, succeeded.failureCode],
    ['SUCCEEDED', 'alreadyRedeemed', 'SUCCEEDED', null]);
  const listed = await w.send('GET', path, { as: owner });
  assert.equal(listed.json.active, null);
  assert.equal(contractView(listed.json.latest).id, uuidToBase62(next.id));
  assert.equal((await stored(w, machine.id)).find((row) => row.id === next.id)!.key, next.key);
});

test('(12) the repository refuses illegal and backward moves, and writes nothing when it does', {
  skip, timeout: 120_000,
}, async (t) => {
  const w = await world(t);
  const owner = await newUser(w.prisma);
  const machine = await eligibleRunner(w, owner);
  assert.equal((await post(w, machine, request())).status, 201);
  const [{ id }] = await stored(w, machine.id);
  await claim(w, machine, id);
  await apply(w, machine, id, { phase: 'CONSUME', kind: 'CONSUME_OUTCOME', outcome: 'reset' });
  const row = async () =>
    (await w.sql.query<{ row: string }>('SELECT row_to_json(o)::text AS row FROM codex_rate_limit_reset_operation o WHERE id = $1', [id]))
      .rows[0].row;
  const confirmed = await row();

  const refusals: Array<[string, (op: CodexRateLimitResetOperationState) => CodexRateLimitResetOperationState]> = [
    ['consumeState may not move from CONFIRMED to CLAIMED', (op) => ({ ...op, consumeState: 'CLAIMED', consumeOutcome: null, consumeConfirmedAt: null })],
    ['consumeOutcome is immutable once recorded', (op) => ({ ...op, consumeOutcome: 'alreadyRedeemed' })],
    ['refreshState may not move from PENDING to NONE', (op) => ({ ...op, refreshState: 'NONE' })],
    ['consumeConfirmedAt is immutable once recorded', (op) => ({ ...op, consumeConfirmedAt: new Date(0).toISOString() })],
    ['providerIdempotencyKey is immutable', (op) => ({ ...op, providerIdempotencyKey: randomUUID() })],
    ['clientRequestId is immutable', (op) => ({ ...op, clientRequestId: randomUUID() })],
    ['accountFingerprint is immutable', (op) => ({ ...op, accountFingerprint: OTHER_FINGERPRINT })],
    ['claimGeneration never decreases', (op) => ({ ...op, claimGeneration: 0 })],
  ];
  for (const [violation, move] of refusals) {
    await assert.rejects(
      w.repository.transition(id, move),
      (error: unknown) => error instanceof CodexResetTransitionRefused && error.violations.includes(violation),
      violation,
    );
    assert.equal(await row(), confirmed, `refused (${violation}), yet the row changed`);
  }

  // Paired: a legal move from this same state is written.
  const moved = await apply(w, machine, id, { phase: 'REFRESH', kind: 'REFRESH_FAILED', code: 'ACCOUNT_MISMATCH' });
  assert.equal(moved?.refreshState, 'FAILED');
  const settled = await row();
  assert.notEqual(settled, confirmed);

  // Settled, nothing moves it — not even a column no checkpoint depends on.
  await assert.rejects(
    w.repository.transition(id, (op) => ({ ...op, lastErrorCode: 'READ_FAILED' })),
    (error: unknown) => error instanceof CodexResetTransitionRefused && error.violations.includes('a settled operation never changes'),
  );
  assert.equal(await row(), settled);
  // Deciding not to move is not a refusal, and a missing operation is not an error.
  assert.equal((await w.repository.transition(id, () => null))?.refreshState, 'FAILED');
  assert.equal(await w.repository.transition(randomUUID(), (op) => op), null);
});

test('(13) the database refuses the same moves, and impossible rows, from a writer that bypasses the repository', {
  skip, timeout: 120_000,
}, async (t) => {
  const w = await world(t);
  const owner = await newUser(w.prisma);
  const machine = await eligibleRunner(w, owner);
  assert.equal((await post(w, machine, request())).status, 201);
  const [operation] = await stored(w, machine.id);
  await claim(w, machine, operation.id);
  await apply(w, machine, operation.id, { phase: 'CONSUME', kind: 'CONSUME_OUTCOME', outcome: 'reset' });
  const update = (assignments: string) =>
    w.sql.query(`UPDATE codex_rate_limit_reset_operation SET ${assignments} WHERE id = $1`, [operation.id]);
  const snapshot = async () =>
    (await w.sql.query<{ row: string }>('SELECT row_to_json(o)::text AS row FROM codex_rate_limit_reset_operation o WHERE id = $1', [operation.id]))
      .rows[0].row;
  const confirmed = await snapshot();

  const guarded: Array<[string, string]> = [
    ['provider_idempotency_key = gen_random_uuid()', 'are immutable'],
    ['client_request_id = gen_random_uuid()', 'are immutable'],
    [`account_fingerprint = '${OTHER_FINGERPRINT}'`, 'are immutable'],
    [`consume_state = 'CLAIMED', consume_outcome = NULL, consume_confirmed_at = NULL, refresh_state = 'NONE'`,
      'consume_state may not move from CONFIRMED to CLAIMED'],
    [`consume_outcome = 'alreadyRedeemed'`, 'consume_outcome is immutable once recorded'],
    [`consume_confirmed_at = consume_confirmed_at + interval '1 second'`, 'consume_confirmed_at is immutable once recorded'],
    ['claim_generation = claim_generation - 1', 'claim_generation never decreases'],
    [`refresh_state = 'NONE'`, 'refresh_state may not move from PENDING to NONE'],
  ];
  for (const [assignments, message] of guarded) {
    await refusedBy(update(assignments), { message }, assignments);
  }
  // A move the guard has no objection to, into a combination §7.3 does not list: the CHECK refuses it.
  await refusedBy(update('completed_at = now()'), { constraint: 'codex_rate_limit_reset_operation_completed_at_check' }, 'completed while active');
  // I1, underneath the service: a second active row for this runner and account.
  const insert = (overrides: Record<string, unknown>) => {
    const row: Record<string, unknown> = {
      id: randomUUID(), owner_id: owner, runner_id: machine.id, account_fingerprint: OTHER_FINGERPRINT,
      client_request_id: randomUUID(), provider_idempotency_key: randomUUID(),
      consume_state: 'PENDING', refresh_state: 'NONE', created_at: new Date(), updated_at: new Date(),
      ...overrides,
    };
    const columns = Object.keys(row);
    return w.sql.query(
      `INSERT INTO codex_rate_limit_reset_operation (${columns.join(', ')}) VALUES (${columns.map((_, i) => `$${i + 1}`).join(', ')})`,
      Object.values(row),
    );
  };
  await refusedBy(insert({ account_fingerprint: FINGERPRINT }),
    { code: '23505', constraint: 'codex_rate_limit_reset_operation_in_flight_key' }, 'a second active operation');
  assert.equal(await snapshot(), confirmed, 'no refused write changed the row');

  // Settled, the guard refuses any change at all.
  await apply(w, machine, operation.id, { phase: 'REFRESH', kind: 'REFRESH_FAILED', code: 'ACCOUNT_MISMATCH' });
  await refusedBy(update(`last_error_code = 'READ_FAILED'`), { message: 'a settled operation never changes' }, 'a settled row');

  const impossible: Array<[string, Record<string, unknown>, { code?: string; constraint: string }]> = [
    ['a confirmed consume with no refresh checkpoint',
      { consume_state: 'CONFIRMED', consume_outcome: 'reset', consume_confirmed_at: new Date() },
      { constraint: 'codex_rate_limit_reset_operation_checkpoints_check' }],
    ['a failure code on a pending operation', { failure_code: 'CONSUME_EXPIRED' },
      { constraint: 'codex_rate_limit_reset_operation_failure_code_check' }],
    ['an email where the fingerprint goes', { account_fingerprint: 'someone@example.test' },
      { constraint: 'codex_rate_limit_reset_operation_account_fingerprint_check' }],
    // A code alone, in a row whose checkpoints are fine: PostgreSQL checks CHECKs in name order, so an
    // unknown STATE would be answered by `checkpoints_check` before `values_check` is reached.
    ['an error code the contract does not have', { last_error_code: 'PROVIDER_OUTAGE' },
      { constraint: 'codex_rate_limit_reset_operation_values_check' }],
    ['a provider key another operation holds', { provider_idempotency_key: operation.key },
      { code: '23505', constraint: 'codex_rate_limit_reset_operation_provider_idempotency_key_key' }],
    ['a request id this owner already used', { client_request_id: operation.clientRequestId },
      { code: '23505', constraint: 'codex_rate_limit_reset_operation_owner_id_client_request_id_key' }],
  ];
  for (const [what, overrides, expected] of impossible) {
    await refusedBy(insert(overrides), expected, what);
  }

  // Paired: a legal row and a legal move, written by the same raw writer.
  const legal = randomUUID();
  await insert({ id: legal });
  await w.sql.query(
    `UPDATE codex_rate_limit_reset_operation
        SET consume_state = 'CLAIMED', claim_lease_owner = $2, claim_generation = 1, claimed_at = now(),
            claims_with_unknown_call = 1, updated_at = now()
      WHERE id = $1`,
    [legal, machine.leaseOwner],
  );
  const { rows } = await w.sql.query<{ consume_state: string }>('SELECT consume_state FROM codex_rate_limit_reset_operation WHERE id = $1', [legal]);
  assert.deepEqual(rows, [{ consume_state: 'CLAIMED' }]);
});

test('(14) two transitions racing through the repository: one lands, the other is judged against it', {
  skip, timeout: 120_000,
}, async (t) => {
  const w = await world(t);
  const owner = await newUser(w.prisma);
  const machine = await eligibleRunner(w, owner);
  assert.equal((await post(w, machine, request())).status, 201);
  const [{ id }] = await stored(w, machine.id);
  const claimed = (await claim(w, machine, id))!;

  // Two outcomes decided from the same CLAIMED state, each blind to whatever lands first: the writer
  // `transition` exists to refuse.
  const decided = (outcome: string): CodexRateLimitResetOperationState => {
    const applied = applyCodexResetResult(claimed, machine.id, {
      protocolVersion: 1, operationId: id, leaseOwner: machine.leaseOwner, claimGeneration: claimed.claimGeneration,
      phase: 'CONSUME', kind: 'CONSUME_OUTCOME', outcome,
    }, new Date());
    assert.equal(applied.kind, 'APPLIED');
    return applied.kind === 'APPLIED' ? applied.operation : claimed;
  };
  const stale = [decided('reset'), decided('noCredit')];

  const holder = await w.connect();
  await holder.query('BEGIN');
  await holder.query('SELECT id FROM codex_rate_limit_reset_operation WHERE id = $1 FOR UPDATE', [id]);
  const racing = stale.map((next) =>
    w.repository.transition(id, () => next).then(
      (written) => ({ written, refused: null as CodexResetTransitionRefused | null }),
      (error: unknown) => {
        if (error instanceof CodexResetTransitionRefused) return { written: null, refused: error };
        throw error;
      },
    ));
  await lockWaiters(w, 2);
  await holder.query('COMMIT');
  const outcomes = await Promise.all(racing);

  const landed = outcomes.filter((outcome) => outcome.written !== null);
  const refused = outcomes.filter((outcome) => outcome.refused !== null);
  assert.equal(landed.length, 1, JSON.stringify(outcomes));
  assert.equal(refused.length, 1, JSON.stringify(outcomes));
  assert.equal(refused[0].refused!.violations.includes('consumeOutcome is immutable once recorded'), true, refused[0].refused!.message);
  const [row] = await stored(w, machine.id);
  assert.deepEqual([row.consumeState, row.consumeOutcome], ['CONFIRMED', landed[0].written!.consumeOutcome]);
});

test('(15) two raw updates racing: the guard refuses the second against the first one’s committed row', {
  skip, timeout: 120_000,
}, async (t) => {
  const w = await world(t);
  const owner = await newUser(w.prisma);
  const machine = await eligibleRunner(w, owner);
  assert.equal((await post(w, machine, request())).status, 201);
  const [{ id }] = await stored(w, machine.id);
  await claim(w, machine, id);

  const first = await w.connect();
  const second = await w.connect();
  await first.query('BEGIN');
  await first.query(
    `UPDATE codex_rate_limit_reset_operation
        SET consume_state = 'CONFIRMED', consume_outcome = 'reset', consume_confirmed_at = now(),
            refresh_state = 'PENDING', updated_at = now()
      WHERE id = $1`,
    [id],
  );
  const late = second.query(
    `UPDATE codex_rate_limit_reset_operation
        SET consume_state = 'CONFIRMED', consume_outcome = 'noCredit', consume_confirmed_at = now(),
            refresh_state = 'NOT_REQUIRED', completed_at = now(), updated_at = now()
      WHERE id = $1`,
    [id],
  ).then(() => null, (error: Error & { code?: string }) => error);
  await lockWaiters(w);
  await first.query('COMMIT');
  const error = await late;
  assert.ok(error, 'the second update was written over the first');
  assert.equal(error.code, '23514', error.message);
  assert.match(error.message, /refresh_state may not move from PENDING to NOT_REQUIRED/);
  const [row] = await stored(w, machine.id);
  assert.deepEqual([row.consumeState, row.consumeOutcome, row.refreshState], ['CONFIRMED', 'reset', 'PENDING']);
});
