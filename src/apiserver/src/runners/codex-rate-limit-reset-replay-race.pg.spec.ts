/**
 * A POST that races its own retry is that retry's replay, even when the retry commits between the two
 * reads admission makes (docs/codex-rate-limit-reset-contract.md §5, §6.1 steps 2–3).
 *
 * THE INTERLEAVING
 * ----------------
 * `CodexRateLimitResetService.create()` reads, in one READ COMMITTED transaction, the request id and then
 * the runner and account's operation in flight. Each statement sees what had committed when it started,
 * so a concurrent POST of the same request can commit in between: the first read misses it and the second
 * finds it in flight. Refused there, the loser answered 409 OPERATION_IN_FLIGHT naming the operation its
 * own request had created — what the cross-layer E2E saw as 201 / 409 / 200 for three POSTs of one
 * confirmation (scripts/test-codex-reset-e2e.sh, S05).
 *
 * Nothing here sleeps, and nothing is left to a race. Every POST goes through one repository with a seam
 * after the request-id read, before the in-flight read and after the insert. `interleave` arms each for
 * one call and walks two POSTs through them in this order, which every case reads back:
 *
 *   1. the winner inserts its operation and is held there, its transaction open;
 *   2. the loser reads the request id and misses it;
 *   3. the winner is released and answers — its transaction has committed;
 *   4. the loser reads the operation in flight.
 *
 * WHAT EACH CASE IS FOR
 * ---------------------
 *   (1) the same request: the loser is the winner's 200 replay, and the table holds one row with the
 *       provider key the winner created.
 *   (2) the same walk for another request id: the loser is 409 OPERATION_IN_FLIGHT naming the winner. The
 *       pair of (1): the replay belongs to the request that owns the operation, not to whoever finds one.
 *   (3) the same request id on another runner whose slot is taken: 409 REQUEST_ID_REUSED naming the
 *       winner, which is what step 2 answers once the winner has committed — not the other runner's
 *       operation in flight.
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/runners/codex-rate-limit-reset-replay-race.pg.spec.ts
 *
 * Not destructive: every case owns freshly generated users, runners and operations.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test, type TestContext } from 'node:test';

import { Module, ValidationPipe } from '@nestjs/common';
import { HttpAdapterHost, NestFactory, Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import type { Prisma, PrismaClient } from '@prisma/client';
import {
  CODEX_RATE_LIMIT_RESET_CAPABILITY_V1,
  uuidToBase62,
  type CodexRateLimitResetOperationState,
  type PlanUsageRateLimitReset,
} from '@orbit/shared';
import { Client } from 'pg';

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
import { CodexRateLimitResetController } from './codex-rate-limit-reset.controller';
import { CodexRateLimitResetRepository } from './codex-rate-limit-reset.repository';
import { CodexRateLimitResetService } from './codex-rate-limit-reset.service';

const URL = process.env.COORDINATOR_PG_URL;
const skip = !URL;

const FINGERPRINT = 'cxa1_92381c922ad04574cc61964161fd5687';
/** The order `interleave` forces, as every case reads it back. */
const WALK = [
  'winner inserted',
  'loser read the request id: missed',
  'winner answered 201',
  'loser reads the operation in flight',
];

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;
interface Sent {
  status: number;
  text: string;
  json: Json;
}
interface Machine {
  id: string;
  ownerId: string;
}
interface World {
  prisma: PrismaClient;
  sql: Client;
  repository: SeamedRepository;
  post(machine: Machine, body: unknown): Promise<Sent>;
}
type Stored = { id: string; clientRequestId: string; key: string };
type Reader = PrismaService | Prisma.TransactionClient;

/** The repository, with a seam beside each statement the interleaving is made of. A seam is armed for
 *  the next call through it, and that call disarms it. */
class SeamedRepository extends CodexRateLimitResetRepository {
  afterRequestRead: ((found: boolean) => void) | null = null;
  beforeActiveRead: (() => Promise<void>) | null = null;
  afterInsert: (() => Promise<void>) | null = null;

  override async byClientRequest(db: Reader, ownerId: string, clientRequestId: string) {
    const found = await super.byClientRequest(db, ownerId, clientRequestId);
    const seam = this.afterRequestRead;
    this.afterRequestRead = null;
    seam?.(found !== null);
    return found;
  }

  override async activeFor(db: Reader, runnerId: string, accountFingerprint: string) {
    const seam = this.beforeActiveRead;
    this.beforeActiveRead = null;
    await seam?.();
    return super.activeFor(db, runnerId, accountFingerprint);
  }

  override async insertIfAbsent(tx: Prisma.TransactionClient, operation: CodexRateLimitResetOperationState) {
    const inserted = await super.insertIfAbsent(tx, operation);
    const seam = this.afterInsert;
    this.afterInsert = null;
    await seam?.();
    return inserted;
  }
}

/** The reset routes as main.ts serves them — pipes, both id exits, the conflict boundary — over one
 *  database, every POST through one SeamedRepository. */
async function world(t: TestContext): Promise<World> {
  const url = URL!;
  assertCoordinatorPgUrlIsIsolated(url);
  const sql = new Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
  await sql.connect();
  await verifyCoordinatorPgIdentity(sql);
  const prisma = prismaClientFor(url);
  const db = prisma as unknown as PrismaService;
  const repository = new SeamedRepository(db);

  @Module({
    controllers: [CodexRateLimitResetController],
    providers: [
      { provide: CodexRateLimitResetService, useValue: new CodexRateLimitResetService(db, repository) },
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
  app.useGlobalInterceptors(new PublicIdInterceptor());
  const adapter = app.get(HttpAdapterHost).httpAdapter;
  app.useGlobalFilters(new TransientDbConflictFilter(new PublicIdExceptionFilter(adapter), adapter));
  await app.listen(0, '127.0.0.1');
  const base = `${await app.getUrl()}/api`;
  t.after(async () => {
    await app.close();
    await prisma.$disconnect().catch(() => undefined);
    await sql.end().catch(() => undefined);
  });

  return {
    prisma,
    sql,
    repository,
    async post(machine, body) {
      const response = await fetch(`${base}/runners/${machine.id}/codex-rate-limit-reset`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${machine.ownerId}` },
        body: JSON.stringify(body),
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

/** A runner every admission check passes on: online, capable, leased, not draining, a fresh block. */
async function eligibleRunner(w: World, ownerId: string): Promise<Machine> {
  const id = randomUUID();
  const leaseOwner = randomUUID();
  const reset: PlanUsageRateLimitReset = {
    protocolVersion: 1,
    support: 'SUPPORTED',
    accountFingerprint: FINGERPRINT,
    rateLimitResetCredits: { availableCount: 2, credits: null },
    fetchedAt: new Date(Date.now() - 60_000).toISOString(),
    generation: leaseOwner,
    sequence: 1,
  };
  await w.prisma.runner.create({
    data: {
      id,
      ownerId,
      name: `codex-reset-${id}`,
      tokenHash: randomUUID(),
      status: 'ONLINE',
      lastHeartbeatAt: new Date(),
      capabilities: [CODEX_RATE_LIMIT_RESET_CAPABILITY_V1],
      heartbeatLeaseOwner: leaseOwner,
      heartbeatDraining: false,
      planUsage: JSON.parse(JSON.stringify({ codex: { provider: 'codex', rateLimitReset: reset } })),
    },
  });
  return { id, ownerId };
}

function request(clientRequestId: string = randomUUID()): Record<string, unknown> {
  return { clientRequestId, accountFingerprint: FINGERPRINT };
}

/** Every operation of one runner as the table holds it, provider key included. */
async function stored(w: World, runnerId: string): Promise<Stored[]> {
  const { rows } = await w.sql.query<Stored>(
    `SELECT id::text AS "id", client_request_id::text AS "clientRequestId", provider_idempotency_key::text AS "key"
       FROM codex_rate_limit_reset_operation WHERE runner_id = $1 ORDER BY created_at, id`,
    [runnerId],
  );
  return rows;
}

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

/** Rejects once `sent` answers: a POST that answers before it reaches its seam never took the walk. */
async function answeredEarly(who: string, sent: Promise<Sent>): Promise<never> {
  const answer = await sent;
  throw new Error(`${who} answered ${answer.status} ${answer.text} before it reached its seam`);
}

/**
 * Two POSTs walked through WALK: the winner held after its insert with its transaction open, the loser's
 * request-id read made while it is held, the winner released and answered, and only then the loser's
 * in-flight read. `whileLoserWaits` runs between the last two. Every seam is released on the way out, so
 * a case that fails part-way leaves no transaction open behind it.
 */
async function interleave(
  w: World,
  winner: () => Promise<Sent>,
  loser: () => Promise<Sent>,
  whileLoserWaits: () => Promise<void> = async () => undefined,
): Promise<{ won: Sent; lost: Sent; walk: string[] }> {
  const walk: string[] = [];
  const inserted = deferred();
  const releaseWinner = deferred();
  const loserRead = deferred();
  const releaseLoser = deferred();
  try {
    w.repository.afterInsert = async () => {
      walk.push('winner inserted');
      inserted.resolve();
      await releaseWinner.promise;
    };
    const winning = winner();
    await Promise.race([inserted.promise, answeredEarly('the winner', winning)]);

    w.repository.afterRequestRead = (found) => {
      walk.push(`loser read the request id: ${found ? 'found' : 'missed'}`);
      loserRead.resolve();
    };
    w.repository.beforeActiveRead = async () => {
      await releaseLoser.promise;
      walk.push('loser reads the operation in flight');
    };
    const losing = loser();
    await Promise.race([loserRead.promise, answeredEarly('the loser', losing)]);

    releaseWinner.resolve();
    const won = await winning;
    walk.push(`winner answered ${won.status}`);
    await whileLoserWaits();

    releaseLoser.resolve();
    const lost = await losing;
    return { won, lost, walk };
  } finally {
    w.repository.afterInsert = null;
    w.repository.afterRequestRead = null;
    w.repository.beforeActiveRead = null;
    releaseWinner.resolve();
    releaseLoser.resolve();
  }
}

test('(1) the winner commits between the loser’s request-id read and its in-flight read: the loser is the winner’s 200 replay, one row, one provider key', {
  skip, timeout: 120_000,
}, async (t) => {
  const w = await world(t);
  const owner = await newUser(w.prisma);
  const machine = await eligibleRunner(w, owner);
  const body = request();

  let committed: Stored[] = [];
  const { won, lost, walk } = await interleave(w, () => w.post(machine, body), () => w.post(machine, body), async () => {
    committed = await stored(w, machine.id);
  });
  assert.deepEqual(walk, WALK);
  assert.equal(won.status, 201, won.text);
  assert.equal(committed.length, 1, 'the winner committed its operation before the loser read what is in flight');
  const [operation] = committed;
  assert.equal(won.json.operation.id, uuidToBase62(operation.id));

  assert.equal(lost.status, 200, `the loser answered ${lost.status} ${lost.text}; its request's operation is ${operation.id}`);
  assert.equal(lost.json.replayed, true);
  assert.deepEqual(lost.json.operation, won.json.operation, 'the replay is the operation the winner created');
  assert.deepEqual(await stored(w, machine.id), committed, 'still one row, with the provider key it was created with');
});

test('(2) the same walk for another request id: the loser finds the winner in flight, 409 OPERATION_IN_FLIGHT naming it', {
  skip, timeout: 120_000,
}, async (t) => {
  const w = await world(t);
  const owner = await newUser(w.prisma);
  const machine = await eligibleRunner(w, owner);

  const { won, lost, walk } = await interleave(w, () => w.post(machine, request()), () => w.post(machine, request()));
  assert.deepEqual(walk, WALK);
  assert.equal(won.status, 201, won.text);
  const rows = await stored(w, machine.id);
  assert.equal(rows.length, 1);
  assert.equal(won.json.operation.id, uuidToBase62(rows[0].id));
  assert.equal(lost.status, 409, lost.text);
  assert.deepEqual(lost.json, { code: 'OPERATION_IN_FLIGHT', operationId: rows[0].id });
});

test('(3) the same request id on another runner whose slot is taken: 409 REQUEST_ID_REUSED naming the winner, not the operation in flight there', {
  skip, timeout: 120_000,
}, async (t) => {
  const w = await world(t);
  const owner = await newUser(w.prisma);
  const first = await eligibleRunner(w, owner);
  const second = await eligibleRunner(w, owner);
  const taken = await w.post(second, request());
  assert.equal(taken.status, 201, taken.text);
  const occupying = await stored(w, second.id);

  const body = request();
  const { won, lost, walk } = await interleave(w, () => w.post(first, body), () => w.post(second, body));
  assert.deepEqual(walk, WALK);
  assert.equal(won.status, 201, won.text);
  const rows = await stored(w, first.id);
  assert.equal(rows.length, 1);
  assert.equal(lost.status, 409, lost.text);
  assert.deepEqual(lost.json, { code: 'REQUEST_ID_REUSED', operationId: rows[0].id });
  assert.deepEqual(await stored(w, second.id), occupying, 'the second runner holds only the operation that took its slot');
});
