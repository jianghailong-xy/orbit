/**
 * The Codex rate-limit reset relay over real HTTP and a real PostgreSQL: the command a heartbeat hands a
 * runner process, and the receipt a result gets (docs/codex-rate-limit-reset-contract.md §6.2, §6.3,
 * §6.5; runner-api/codex-reset-relay.ts).
 *
 * THE RUNNER FIXTURE
 * ------------------
 * Every case talks to the routes the way a runner does: `POST /api/runner/heartbeat` and
 * `POST /api/runner/codex-rate-limit-reset-result` with a runner token, through the real RunnerAuthGuard,
 * the global pipe, the id interceptors and the exception filters main.ts installs. A "process" is a
 * leaseOwner and the reads it has made: its heartbeats carry its own Codex reset block, stored through
 * the real planUsage compare-and-set, and a capability header of its own. Operations come from the real
 * admission service, so the key a command carries is the one admission generated and stored. Case (13)
 * swaps the TypeScript fixture for this repository's Go runner — its Transport and relay, built with
 * -tags codexresetlive — against these same routes.
 *
 * WHAT EACH CASE IS FOR
 * ---------------------
 *   (1) an old runner — the legacy heartbeat fixture, and one with no leaseOwner — is answered in the
 *       shape it always was and claims nothing, beside a capable process that does claim;
 *   (2) only a process declaring the capability, holding a lease, not draining and of the operation's
 *       own runner is handed the command, and the command is the contract's, with the stored key;
 *   (3) account scope: another account settles an unclaimed operation ACCOUNT_CHANGED, after waiting a
 *       fresh claim out;
 *   (4) a lost command is delivered again, byte for byte, with nothing written;
 *   (5) an apiserver restart: a new server over the same database redelivers and takes the result;
 *   (6) a runner restart: the new process waits out the old claim and takes it over under the same key,
 *       and the old process's results are fenced unless they restate the recorded outcome;
 *   (7) a lost receipt — the answer to a committed result never arrives — and the result sent again is a
 *       DUPLICATE that writes nothing; a refreshed block is stored once;
 *   (8) duplicated, reordered and late results over seeded interleavings: every answer is the
 *       contract's for the row it met, and nothing moves backwards, rewrites the outcome or the key;
 *   (9) the refusals: malformed, unknown, another runner's or owner's, unauthenticated, wrong phase,
 *       conflicting outcome, another account, settled;
 *  (10) draining: nothing is redelivered to a draining process, RELEASED hands its claim back, and the
 *       successor claims it at once;
 *  (11) deadlines settle at any heartbeat of the runner, an old runner's too, and a fresh claim holds
 *       them off;
 *  (12) two processes heartbeating at once claim an operation exactly once;
 *  (13) the Go runner relay against these routes.
 *
 *   bash scripts/test-codex-reset-relay.sh
 *
 * Needs COORDINATOR_PG_URL (scripts/run-pg-spec.sh provides a disposable one); without it every case
 * reports as skipped, and that script counts a skip as red. Not destructive: every case owns freshly
 * generated users, runners and operations.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';

import {
  Module,
  ValidationPipe,
  type CallHandler,
  type ExecutionContext,
  type INestApplication,
  type NestInterceptor,
} from '@nestjs/common';
import { HttpAdapterHost, NestFactory } from '@nestjs/core';
import type { PrismaClient } from '@prisma/client';
import {
  CODEX_RATE_LIMIT_RESET_CAPABILITY_V1,
  CODEX_RATE_LIMIT_RESET_WIRE,
  applyCodexResetResult,
  codexRateLimitResetOf,
  codexResetCommandViolations,
  codexResetOperationStatus,
  codexResetResultResponseViolations,
  type CodexRateLimitResetOperationState,
  type PlanUsage,
  type PlanUsageRateLimitReset,
  type RunnerHeartbeatRequest,
} from '@orbit/shared';
import { Client } from 'pg';
import { delay } from 'rxjs/operators';

import { sha256 } from '../common/crypto.util';
import { PublicIdExceptionFilter } from '../common/public-id.filter';
import { PublicIdInterceptor } from '../common/public-id.interceptor';
import { TransientDbConflictFilter } from '../common/transient-db-conflict.filter';
import { WorkspaceAliasInterceptor } from '../common/workspace-alias.interceptor';
import { prismaClientFor } from '../prisma/prisma-client';
import { PrismaService } from '../prisma/prisma.service';
import { AttemptBudgetMeterService } from '../projects/attempt-budget-meter.service';
import { assertCoordinatorPgUrlIsIsolated, verifyCoordinatorPgIdentity } from '../projects/coordinator-pg-test-safety';
import { ProjectAcceptanceService } from '../projects/project-acceptance.service';
import { PushService } from '../push/push.service';
import { QueueService } from '../queue/queue.service';
import { RealtimeService } from '../realtime/realtime.service';
import { CodexRateLimitResetRepository } from '../runners/codex-rate-limit-reset.repository';
import { CodexRateLimitResetService } from '../runners/codex-rate-limit-reset.service';
import { MergeReceiptService } from '../sessions/merge-receipt.service';
import { ListEventsService } from '../task-lists/list-events.service';
import { ReferenceExpansionService } from '../tasks/reference-expansion';
import { TasksService } from '../tasks/tasks.service';
import { RunnerApiController } from './runner-api.controller';
import { RunnerAuthGuard } from './runner-auth.guard';
import { RunnerOrchestrationAuthorizer } from './runner-orchestration-authorizer';

const URL = process.env.COORDINATOR_PG_URL;
const skip = !URL;

const REPO = path.resolve(__dirname, '../../../..');
const RUNNER_GO = path.join(REPO, 'src/runner-go');
const FIXTURES = JSON.parse(readFileSync(path.join(REPO, 'contracts/codex-rate-limit-reset.fixtures.json'), 'utf8')) as {
  heartbeats: { legacy: RunnerHeartbeatRequest };
  heartbeatResponses: { legacy: Record<string, unknown> };
};

const CAPABILITY = CODEX_RATE_LIMIT_RESET_CAPABILITY_V1;
const FINGERPRINT = 'cxa1_92381c922ad04574cc61964161fd5687';
const OTHER_FINGERPRINT = 'cxa1_0123456789abcdef0123456789abcdef';
const COMMAND_FIELDS = Object.keys(CODEX_RATE_LIMIT_RESET_WIRE.CodexRateLimitResetCommand).sort();
const RECEIPT_FIELDS = Object.keys(CODEX_RATE_LIMIT_RESET_WIRE.CodexRateLimitResetResultResponse).sort();
/** Read by this spec's own interceptor: hold the answer back this long AFTER the handler — and so its
 *  transaction — finished. A runner that gives up in that window has lost the receipt of a result
 *  that was applied. */
const HOLD = 'x-spec-hold-response-ms';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;
interface Sent {
  status: number;
  text: string;
  json: Json;
}
interface Answer extends Sent {
  command: Json | undefined;
}
interface SendOptions {
  token?: string | null;
  body?: unknown;
  headers?: Record<string, string>;
  signal?: AbortSignal;
}
interface World {
  prisma: PrismaClient;
  sql: Client;
  admission: CodexRateLimitResetService;
  origin(): string;
  send(route: string, options?: SendOptions): Promise<Sent>;
  /** Stops this apiserver and starts a new one on the same address over the same database. */
  restart(): Promise<void>;
}
interface Machine {
  id: string;
  ownerId: string;
  token: string;
}
/** One runner process: the lease owner its heartbeats carry, and how many reads it has made. */
interface Proc {
  leaseOwner: string;
  reads: number;
}
type State = CodexRateLimitResetOperationState;

class HoldResponse implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler) {
    const request = context.switchToHttp().getRequest<{ headers: Record<string, string | undefined> }>();
    const ms = Number(request.headers[HOLD] ?? 0);
    return ms > 0 ? next.handle().pipe(delay(ms)) : next.handle();
  }
}

/** The runner routes as main.ts serves them, over `prisma`. Collaborators neither route reaches are
 *  empty; the realtime drains the heartbeat calls answer with nothing. */
async function boot(prisma: PrismaClient, port: number): Promise<INestApplication> {
  const realtime = {
    drainCancellations: async () => [],
    drainArtifactRequests: async () => [],
    publishSessionUpdated: () => undefined,
  };
  @Module({
    controllers: [RunnerApiController],
    providers: [
      RunnerAuthGuard,
      { provide: PrismaService, useValue: prisma },
      { provide: QueueService, useValue: {} },
      { provide: RealtimeService, useValue: realtime },
      { provide: PushService, useValue: {} },
      { provide: RunnerOrchestrationAuthorizer, useValue: {} },
      { provide: ReferenceExpansionService, useValue: {} },
      { provide: ListEventsService, useValue: {} },
      // Optional in the constructor, but Nest resolves every parameter from the module.
      { provide: AttemptBudgetMeterService, useValue: {} },
      { provide: ProjectAcceptanceService, useValue: {} },
      { provide: TasksService, useValue: {} },
      { provide: MergeReceiptService, useValue: {} },
    ],
  })
  class RunnerRoutes {}

  const app = await NestFactory.create(RunnerRoutes, { logger: false, abortOnError: false });
  app.setGlobalPrefix('api');
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: false }));
  app.useGlobalInterceptors(new HoldResponse(), new WorkspaceAliasInterceptor(), new PublicIdInterceptor());
  const adapter = app.get(HttpAdapterHost).httpAdapter;
  app.useGlobalFilters(new TransientDbConflictFilter(new PublicIdExceptionFilter(adapter), adapter));
  await app.listen(port, '127.0.0.1');
  return app;
}

async function world(t: TestContext): Promise<World> {
  const url = URL!;
  assertCoordinatorPgUrlIsIsolated(url);
  const sql = new Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
  await sql.connect();
  await verifyCoordinatorPgIdentity(sql);
  const prisma = prismaClientFor(url);
  const db = prisma as unknown as PrismaService;
  const admission = new CodexRateLimitResetService(db, new CodexRateLimitResetRepository(db));
  let served = prismaClientFor(url);
  let app = await boot(served, 0);
  const port = (app.getHttpServer().address() as AddressInfo).port;
  t.after(async () => {
    await app.close();
    await served.$disconnect().catch(() => undefined);
    await prisma.$disconnect().catch(() => undefined);
    await sql.end().catch(() => undefined);
  });
  return {
    prisma,
    sql,
    admission,
    origin: () => `http://127.0.0.1:${port}`,
    async restart() {
      await app.close();
      await served.$disconnect().catch(() => undefined);
      served = prismaClientFor(url);
      app = await boot(served, port);
    },
    async send(route, { token, body, headers, signal } = {}) {
      const payload = body === undefined ? '' : JSON.stringify(body);
      // A connection per request, never a pooled one: a pooled socket to the server `restart` just
      // closed would fail the first request to the new one for a reason that is the client's own.
      const { status, text } = await new Promise<{ status: number; text: string }>((resolve, reject) => {
        const request = httpRequest(
          `http://127.0.0.1:${port}/api${route}`,
          {
            method: 'POST',
            agent: false,
            signal,
            headers: {
              'content-type': 'application/json',
              'content-length': Buffer.byteLength(payload),
              ...(token ? { authorization: `Bearer ${token}` } : {}),
              ...headers,
            },
          },
          (response) => {
            let received = '';
            response.setEncoding('utf8');
            response.on('data', (chunk: string) => (received += chunk));
            response.on('end', () => resolve({ status: response.statusCode ?? 0, text: received }));
            response.on('error', reject);
          },
        );
        request.on('error', reject);
        request.end(payload);
      });
      let json: Json = null;
      try {
        json = JSON.parse(text);
      } catch {
        json = null;
      }
      return { status, text, json };
    },
  };
}

async function newMachine(w: World, ownerId?: string): Promise<Machine> {
  const owner = ownerId ?? randomUUID();
  if (!ownerId) {
    await w.prisma.user.create({ data: { id: owner, email: `${owner}@codex-reset-relay.test`, name: 'codex reset relay', passwordHash: 'x' } });
  }
  const id = randomUUID();
  const token = `codex-reset-relay-${randomUUID()}`;
  await w.prisma.runner.create({ data: { id, ownerId: owner, name: `codex-reset-relay-${id}`, tokenHash: sha256(token) } });
  return { id, ownerId: owner, token };
}

function newProcess(): Proc {
  return { leaseOwner: randomUUID(), reads: 0 };
}

/** A read `proc` makes now of the account `fingerprint`: supported, identified, two credits. */
function read(proc: Proc, fingerprint = FINGERPRINT): PlanUsageRateLimitReset {
  proc.reads += 1;
  return {
    protocolVersion: 1,
    support: 'SUPPORTED',
    accountFingerprint: fingerprint,
    rateLimitResetCredits: { availableCount: 2, credits: null },
    fetchedAt: new Date().toISOString(),
    generation: proc.leaseOwner,
    sequence: proc.reads,
  };
}

interface Beat {
  /** The process sending it; null for a runner too old to name one (it reports no block either). */
  proc: Proc | null;
  capable?: boolean;
  draining?: boolean;
  /** The account this beat's read found; null reports a Codex snapshot without a block. */
  fingerprint?: string | null;
}

async function heartbeat(w: World, m: Machine, { proc, capable = true, draining, fingerprint = FINGERPRINT }: Beat): Promise<Answer> {
  const codex = { provider: 'codex', ...(proc && fingerprint !== null ? { rateLimitReset: read(proc, fingerprint) } : {}) };
  const sent = await w.send('/runner/heartbeat', {
    token: m.token,
    headers: capable ? { 'x-orbit-runner-capabilities': CAPABILITY } : {},
    body: {
      status: 'ONLINE',
      idleCapacity: 1,
      ...(proc ? { leaseOwner: proc.leaseOwner } : {}),
      ...(draining ? { draining: true } : {}),
      planUsage: { codex },
    },
  });
  assert.equal(sent.status, 201, sent.text);
  return { ...sent, command: sent.json.codexRateLimitResetRequest };
}

/** A result of `kind` for the claim `command` was delivered under. */
function result(command: Json, kind: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    protocolVersion: 1,
    operationId: command.operationId,
    leaseOwner: command.leaseOwner,
    claimGeneration: command.claimGeneration,
    phase: command.phase,
    kind,
    ...extra,
  };
}

function report(w: World, m: Machine, body: unknown, options: Omit<SendOptions, 'token' | 'body'> = {}): Promise<Sent> {
  return w.send('/runner/codex-rate-limit-reset-result', { token: m.token, body, ...options });
}

const iso = (column: string) => `to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;

/** The operation as the table holds it, key included, in the contract's own shape. */
async function operation(w: World, id: string): Promise<State> {
  const { rows } = await w.sql.query<State>(
    `SELECT id::text AS "id", owner_id::text AS "ownerId", runner_id::text AS "runnerId",
            account_fingerprint AS "accountFingerprint", client_request_id::text AS "clientRequestId",
            provider_idempotency_key::text AS "providerIdempotencyKey", consume_state AS "consumeState",
            consume_outcome AS "consumeOutcome", refresh_state AS "refreshState", failure_code AS "failureCode",
            last_error_code AS "lastErrorCode", claim_lease_owner::text AS "claimLeaseOwner",
            claim_generation AS "claimGeneration", ${iso('claimed_at')} AS "claimedAt",
            claims_with_unknown_call AS "claimsWithUnknownCall", ${iso('created_at')} AS "createdAt",
            ${iso('updated_at')} AS "updatedAt", ${iso('consume_confirmed_at')} AS "consumeConfirmedAt",
            ${iso('completed_at')} AS "completedAt"
       FROM codex_rate_limit_reset_operation WHERE id = $1`,
    [id],
  );
  assert.equal(rows.length, 1, `operation ${id} is not stored`);
  return rows[0];
}

/** `proc` reports a read of `m`'s account and the owner confirms a reset against it: the PENDING
 *  operation admission creates, with the provider key admission generated. */
async function confirmed(w: World, m: Machine, proc: Proc, fingerprint = FINGERPRINT): Promise<State> {
  const beat = await heartbeat(w, m, { proc, fingerprint });
  assert.equal(beat.command, undefined, 'a runner with no operation is handed nothing');
  const created = await w.admission.create(m.ownerId, m.id, { clientRequestId: randomUUID(), accountFingerprint: fingerprint });
  assert.equal(created.replayed, false);
  const op = await operation(w, created.operation.id);
  assert.equal(codexResetOperationStatus(op), 'PENDING');
  return op;
}

async function storedBlock(w: World, m: Machine): Promise<PlanUsageRateLimitReset | undefined> {
  const runner = await w.prisma.runner.findUniqueOrThrow({ where: { id: m.id }, select: { planUsage: true } });
  return codexRateLimitResetOf(runner.planUsage as PlanUsage | null);
}

/** Makes `id`'s claim older than claimTakeoverAfterMs. */
async function ageClaim(w: World, id: string): Promise<void> {
  await w.sql.query(`UPDATE codex_rate_limit_reset_operation SET claimed_at = claimed_at - interval '61 seconds' WHERE id = $1`, [id]);
}

function assertCommand(command: Json, op: State, proc: Proc, expected: { phase: 'CONSUME' | 'REFRESH'; claimGeneration: number }): void {
  assert.ok(command, 'the heartbeat carried no command');
  assert.deepEqual(codexResetCommandViolations(command), []);
  const fields = expected.phase === 'CONSUME' ? COMMAND_FIELDS : COMMAND_FIELDS.filter((field) => field !== 'providerIdempotencyKey');
  assert.deepEqual(Object.keys(command).sort(), fields, 'exactly the contract’s command fields');
  assert.deepEqual(
    [command.operationId, command.leaseOwner, command.claimGeneration, command.phase, command.accountFingerprint, command.requestedAt],
    [op.id, proc.leaseOwner, expected.claimGeneration, expected.phase, op.accountFingerprint, op.createdAt],
  );
  if (expected.phase === 'CONSUME') {
    assert.equal(command.providerIdempotencyKey, op.providerIdempotencyKey, 'a CONSUME carries the key admission stored');
  }
}

function assertReceipt(sent: Sent, expected: { disposition: string; status: string; next: string }): void {
  assert.equal(sent.status, 200, sent.text);
  assert.deepEqual(Object.keys(sent.json).sort(), RECEIPT_FIELDS);
  assert.deepEqual(codexResetResultResponseViolations(sent.json), []);
  assert.deepEqual(sent.json, expected);
}

/** §6.3's table: a refusal's status. */
const refusalStatus = (code: string) => (code === 'INVALID_RESULT' ? 400 : code === 'OPERATION_NOT_FOUND' ? 404 : 409);

function assertRefusal(sent: Sent, code: string): void {
  assert.equal(sent.status, refusalStatus(code), sent.text);
  assert.deepEqual(sent.json, { code });
}

async function eventually(what: string, check: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting until ${what}`);
    await sleep(20);
  }
}

test('(1) an old runner is answered as it always was and claims nothing, beside a capable process that does', {
  skip, timeout: 120_000,
}, async (t) => {
  const w = await world(t);
  const m = await newMachine(w);
  const a = newProcess();
  const op = await confirmed(w, m, a);

  // The legacy fixture as an old runner sends it: no capability header, a Codex snapshot without a block.
  const legacy = await w.send('/runner/heartbeat', { token: m.token, body: FIXTURES.heartbeats.legacy });
  assert.equal(legacy.status, 201, legacy.text);
  assert.equal('codexRateLimitResetRequest' in legacy.json, false, 'an old runner’s response has no reset field at all');
  for (const field of Object.keys(FIXTURES.heartbeatResponses.legacy)) {
    assert.ok(field in legacy.json, `the legacy response still carries ${field}`);
  }
  // Older still: no leaseOwner and no plan usage.
  const bare = await w.send('/runner/heartbeat', { token: m.token, body: { status: 'ONLINE', idleCapacity: 1 } });
  assert.equal(bare.status, 201, bare.text);
  assert.equal('codexRateLimitResetRequest' in bare.json, false);
  assert.deepEqual(await operation(w, op.id), op, 'neither heartbeat claimed or wrote the operation');
  assert.equal((await storedBlock(w, m))?.accountFingerprint, FINGERPRINT, 'the legacy snapshot left the stored block alone');

  // Paired: the process reading the account and declaring the capability is handed it.
  const claim = await heartbeat(w, m, { proc: a });
  assertCommand(claim.command, op, a, { phase: 'CONSUME', claimGeneration: 1 });
  const claimed = await operation(w, op.id);
  assert.deepEqual(
    [claimed.consumeState, claimed.claimLeaseOwner, claimed.claimGeneration, claimed.claimsWithUnknownCall],
    ['CLAIMED', a.leaseOwner, 1, 1],
  );
});

test('(2) only a capable, leased, non-draining process of the operation\'s own runner is handed the command', {
  skip, timeout: 120_000,
}, async (t) => {
  const w = await world(t);
  const m = await newMachine(w);
  const sibling = await newMachine(w, m.ownerId);
  const a = newProcess();
  const op = await confirmed(w, m, a);

  const refused: Array<[string, () => Promise<Answer>]> = [
    ['no capability declared', () => heartbeat(w, m, { proc: a, capable: false })],
    ['no leaseOwner', () => heartbeat(w, m, { proc: null })],
    ['draining', () => heartbeat(w, m, { proc: a, draining: true })],
    ['a process of another runner of the same owner, reading the same account', () => heartbeat(w, sibling, { proc: newProcess() })],
  ];
  for (const [why, beat] of refused) {
    const answer = await beat();
    assert.equal(answer.command, undefined, `${why}: handed a command`);
    assert.deepEqual(await operation(w, op.id), op, `${why}: the operation was written`);
  }
  // A runner with no stored reset block at all.
  await w.sql.query('UPDATE runner SET plan_usage = NULL WHERE id = $1', [m.id]);
  assert.equal((await heartbeat(w, m, { proc: a, fingerprint: null })).command, undefined, 'no stored block: handed a command');
  assert.deepEqual(await operation(w, op.id), op, 'no stored block: the operation was written');

  // Paired: the same process, capable, leased, not draining, reading the account.
  const answer = await heartbeat(w, m, { proc: a });
  assertCommand(answer.command, op, a, { phase: 'CONSUME', claimGeneration: 1 });
  assert.equal(answer.text.split(op.providerIdempotencyKey).length - 1, 1, 'the key is in the response once, inside the command');
  const claimed = await operation(w, op.id);
  assert.ok(claimed.claimedAt);
  assert.deepEqual(
    { ...claimed, claimedAt: null, updatedAt: op.updatedAt },
    { ...op, consumeState: 'CLAIMED', claimLeaseOwner: a.leaseOwner, claimGeneration: 1, claimsWithUnknownCall: 1 },
    'the claim is all that was written',
  );
});

test('(3) account scope: another account settles an unclaimed operation, after waiting out a fresh claim', {
  skip, timeout: 120_000,
}, async (t) => {
  const w = await world(t);

  // Unclaimed: nobody can have called the provider, so the operation is NOT_ATTEMPTED.
  const idle = await newMachine(w);
  const reader = newProcess();
  const unclaimed = await confirmed(w, idle, reader);
  assert.equal((await heartbeat(w, idle, { proc: reader, fingerprint: OTHER_FINGERPRINT })).command, undefined);
  const notAttempted = await operation(w, unclaimed.id);
  assert.deepEqual(
    [codexResetOperationStatus(notAttempted), notAttempted.failureCode, notAttempted.claimGeneration, notAttempted.providerIdempotencyKey],
    ['NOT_ATTEMPTED', 'ACCOUNT_CHANGED', 0, unclaimed.providerIdempotencyKey],
  );
  assert.ok(notAttempted.completedAt);

  // Claimed: while the claim is fresh its holder is waited for; after that it may have called, so UNRESOLVED.
  const m = await newMachine(w);
  const a = newProcess();
  const op = await confirmed(w, m, a);
  assertCommand((await heartbeat(w, m, { proc: a })).command, op, a, { phase: 'CONSUME', claimGeneration: 1 });
  const claimed = await operation(w, op.id);
  assert.equal((await heartbeat(w, m, { proc: a, fingerprint: OTHER_FINGERPRINT })).command, undefined,
    'a process now reading another account is handed nothing');
  assert.deepEqual(await operation(w, op.id), claimed, 'a fresh claim holds the operation off settling');
  await ageClaim(w, op.id);
  assert.equal((await heartbeat(w, m, { proc: a, fingerprint: OTHER_FINGERPRINT })).command, undefined);
  const unresolved = await operation(w, op.id);
  assert.deepEqual(
    [codexResetOperationStatus(unresolved), unresolved.failureCode, unresolved.claimGeneration, unresolved.providerIdempotencyKey],
    ['UNRESOLVED', 'ACCOUNT_CHANGED', 1, op.providerIdempotencyKey],
  );
});

test('(4) a lost command is delivered again on the next heartbeat, byte for byte, with nothing written', {
  skip, timeout: 120_000,
}, async (t) => {
  const w = await world(t);
  const m = await newMachine(w);
  const a = newProcess();
  const op = await confirmed(w, m, a);
  const first = await heartbeat(w, m, { proc: a });
  assertCommand(first.command, op, a, { phase: 'CONSUME', claimGeneration: 1 });
  const claimed = await operation(w, op.id);

  // That response never reached the runner. Its next heartbeats are handed the same command.
  for (let beat = 1; beat <= 3; beat++) {
    const again = await heartbeat(w, m, { proc: a });
    assert.equal(JSON.stringify(again.command), JSON.stringify(first.command), `redelivery ${beat} differs from the first`);
    assert.deepEqual(await operation(w, op.id), claimed, `redelivery ${beat} wrote: a new claim or generation`);
  }
  // Paired: the result of that command lands against the claim it names.
  assertReceipt(await report(w, m, result(first.command, 'CONSUME_OUTCOME', { outcome: 'reset' })), {
    disposition: 'APPLIED', status: 'REFRESHING', next: 'REFRESH',
  });
});

test('(5) an apiserver restart loses nothing: the new server redelivers the command and takes its result', {
  skip, timeout: 120_000,
}, async (t) => {
  const w = await world(t);
  const m = await newMachine(w);
  const a = newProcess();
  const op = await confirmed(w, m, a);
  const before = await heartbeat(w, m, { proc: a });
  assertCommand(before.command, op, a, { phase: 'CONSUME', claimGeneration: 1 });

  await w.restart();
  const after = await heartbeat(w, m, { proc: a });
  assert.equal(JSON.stringify(after.command), JSON.stringify(before.command), 'the restarted server hands over the same command');
  const outcome = await report(w, m, result(after.command, 'CONSUME_OUTCOME', { outcome: 'reset', observedAccountFingerprint: FINGERPRINT }));
  assertReceipt(outcome, { disposition: 'APPLIED', status: 'REFRESHING', next: 'REFRESH' });
  assert.equal(outcome.text.includes(op.providerIdempotencyKey), false, 'a receipt never carries the key');

  await w.restart();
  const refresh = await heartbeat(w, m, { proc: a });
  assertCommand(refresh.command, op, a, { phase: 'REFRESH', claimGeneration: 1 });
  assert.equal(refresh.text.includes(op.providerIdempotencyKey), false, 'a REFRESH never carries the key');
  assertReceipt(await report(w, m, result(refresh.command, 'REFRESHED', { rateLimitReset: read(a) })), {
    disposition: 'APPLIED', status: 'SUCCEEDED', next: 'STOP',
  });
  const done = await operation(w, op.id);
  assert.deepEqual([codexResetOperationStatus(done), done.providerIdempotencyKey], ['SUCCEEDED', op.providerIdempotencyKey]);
  assert.equal((await heartbeat(w, m, { proc: a })).command, undefined, 'a settled operation is delivered no more');
});

test('(6) a runner restart: the new process waits out the old claim, takes it over under the same key, and fences the old one', {
  skip, timeout: 120_000,
}, async (t) => {
  const w = await world(t);
  const m = await newMachine(w);
  const a = newProcess();
  const b = newProcess();
  const op = await confirmed(w, m, a);
  const old = await heartbeat(w, m, { proc: a });
  assertCommand(old.command, op, a, { phase: 'CONSUME', claimGeneration: 1 });
  const claimed = await operation(w, op.id);

  // The runner restarted as process b, while a's claim is still fresh.
  assert.equal((await heartbeat(w, m, { proc: b })).command, undefined, 'a fresh claim was taken over');
  assert.deepEqual(await operation(w, op.id), claimed);
  await ageClaim(w, op.id);
  const takeover = await heartbeat(w, m, { proc: b });
  assertCommand(takeover.command, op, b, { phase: 'CONSUME', claimGeneration: 2 });
  assert.equal(takeover.command.providerIdempotencyKey, old.command.providerIdempotencyKey, 'the takeover consumes under the same key');
  const taken = await operation(w, op.id);
  assert.deepEqual([taken.claimLeaseOwner, taken.claimGeneration, taken.claimsWithUnknownCall], [b.leaseOwner, 2, 2]);

  // a is fenced: handed nothing, and a result of its claim that records something new is STALE_CLAIM.
  assert.equal((await heartbeat(w, m, { proc: a })).command, undefined);
  assertRefusal(await report(w, m, result(old.command, 'CONSUME_RETRYING', { code: 'PROVIDER_TIMEOUT' })), 'STALE_CLAIM');
  assertRefusal(await report(w, m, result(old.command, 'CONSUME_OUTCOME', { outcome: 'reset' })), 'STALE_CLAIM');
  assert.deepEqual(await operation(w, op.id), taken, 'fenced results wrote');

  // b's consume answers alreadyRedeemed — a had spent the credit under this key — and lands.
  assertReceipt(await report(w, m, result(takeover.command, 'CONSUME_OUTCOME', { outcome: 'alreadyRedeemed' })), {
    disposition: 'APPLIED', status: 'REFRESHING', next: 'REFRESH',
  });
  const recorded = await operation(w, op.id);
  // a's late report of that same consumed credit restates the recorded fact: a DUPLICATE, STOP for a.
  assertReceipt(await report(w, m, result(old.command, 'CONSUME_OUTCOME', { outcome: 'reset' })), {
    disposition: 'DUPLICATE', status: 'REFRESHING', next: 'STOP',
  });
  assert.deepEqual(await operation(w, op.id), recorded, 'the late restatement wrote');
  assert.deepEqual([recorded.consumeOutcome, recorded.providerIdempotencyKey], ['alreadyRedeemed', op.providerIdempotencyKey]);
  assertCommand((await heartbeat(w, m, { proc: b })).command, op, b, { phase: 'REFRESH', claimGeneration: 2 });
});

test('(7) a lost receipt: the result sent again is a DUPLICATE that writes nothing, and a refreshed block is stored once', {
  skip, timeout: 120_000,
}, async (t) => {
  const w = await world(t);
  const m = await newMachine(w);
  const a = newProcess();
  const op = await confirmed(w, m, a);
  const claim = await heartbeat(w, m, { proc: a });
  const outcome = result(claim.command, 'CONSUME_OUTCOME', { outcome: 'reset', observedAccountFingerprint: FINGERPRINT });

  // The server commits the result and holds its answer back; the runner stops waiting before it comes.
  const abort = new AbortController();
  const lost = report(w, m, outcome, { headers: { [HOLD]: '2000' }, signal: abort.signal });
  await eventually('the result is committed', async () => (await operation(w, op.id)).consumeState === 'CONFIRMED');
  abort.abort();
  await assert.rejects(lost);
  const applied = await operation(w, op.id);
  for (let resend = 1; resend <= 2; resend++) {
    assertReceipt(await report(w, m, outcome), { disposition: 'DUPLICATE', status: 'REFRESHING', next: 'REFRESH' });
    assert.deepEqual(await operation(w, op.id), applied, `resend ${resend} wrote`);
  }

  const refresh = await heartbeat(w, m, { proc: a });
  assertCommand(refresh.command, op, a, { phase: 'REFRESH', claimGeneration: 1 });
  const block = read(a);
  const refreshed = result(refresh.command, 'REFRESHED', { rateLimitReset: block });
  assertReceipt(await report(w, m, refreshed), { disposition: 'APPLIED', status: 'SUCCEEDED', next: 'STOP' });
  const succeeded = await operation(w, op.id);
  const planUsage = (await w.prisma.runner.findUniqueOrThrow({ where: { id: m.id }, select: { planUsage: true } })).planUsage;
  assert.deepEqual(codexRateLimitResetOf(planUsage as PlanUsage), block, 'planUsage holds the refreshed block');
  assertReceipt(await report(w, m, refreshed), { disposition: 'DUPLICATE', status: 'SUCCEEDED', next: 'STOP' });
  assert.deepEqual(await operation(w, op.id), succeeded, 'the resend wrote the operation');
  assert.deepEqual(
    (await w.prisma.runner.findUniqueOrThrow({ where: { id: m.id }, select: { planUsage: true } })).planUsage,
    planUsage,
    'the resend wrote planUsage',
  );
});

/** A small seeded generator, so an interleaving that fails is the same one on the next run. */
function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let x = state;
    x = Math.imul(x ^ (x >>> 15), x | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

test('(8) duplicated, reordered and late results never move an operation backwards, rewrite its outcome or change its key', {
  skip, timeout: 300_000,
}, async (t) => {
  const w = await world(t);
  const rank: Record<string, number> = {
    PENDING: 0, CONSUMING: 1, REFRESHING: 2,
    SUCCEEDED: 3, REFRESH_FAILED: 3, NOTHING_TO_RESET: 3, NO_CREDIT: 3, NOT_ATTEMPTED: 3, UNRESOLVED: 3,
  };
  for (let seed = 1; seed <= 12; seed++) {
    const random = seeded(seed);
    const m = await newMachine(w);
    const a = newProcess();
    const op = await confirmed(w, m, a);
    const consume = (await heartbeat(w, m, { proc: a })).command;
    const refresh = { ...consume, phase: 'REFRESH' };
    const script = [
      result(consume, 'CONSUME_RETRYING', { code: 'PROVIDER_TIMEOUT' }),
      result(consume, 'CONSUME_OUTCOME', { outcome: 'reset' }),
      result(consume, 'CONSUME_OUTCOME', { outcome: 'alreadyRedeemed' }),
      result(refresh, 'REFRESH_FAILED', { code: 'READ_FAILED' }),
      result(refresh, 'REFRESHED', { rateLimitReset: read(a) }),
    ];
    // Every result once, about half of them twice, in the order the seed deals — then the outcome and the
    // refresh once more, so every interleaving can end SUCCEEDED.
    const deck = [...script, ...script.filter(() => random() < 0.5)];
    for (let i = deck.length - 1; i > 0; i--) {
      const j = Math.floor(random() * (i + 1));
      [deck[i], deck[j]] = [deck[j], deck[i]];
    }
    let before = await operation(w, op.id);
    for (const body of [...deck, script[1], script[4]]) {
      const where = `seed ${seed}, ${body.kind} ${body.outcome ?? body.code ?? ''} at ${codexResetOperationStatus(before)}`;
      const expected = applyCodexResetResult(before, m.id, body, new Date());
      const sent = await report(w, m, body);
      const after = await operation(w, op.id);
      if (expected.kind === 'REJECTED') {
        assertRefusal(sent, expected.rejection);
        assert.deepEqual(after, before, `${where}: a refusal wrote`);
      } else {
        assertReceipt(sent, expected.response);
        if (expected.kind === 'DUPLICATE') assert.deepEqual(after, before, `${where}: a duplicate wrote`);
      }
      assert.ok(rank[codexResetOperationStatus(after)!] >= rank[codexResetOperationStatus(before)!], `${where}: moved backwards`);
      if (before.consumeOutcome !== null) assert.equal(after.consumeOutcome, before.consumeOutcome, `${where}: outcome rewritten`);
      if (before.consumeConfirmedAt !== null) assert.equal(after.consumeConfirmedAt, before.consumeConfirmedAt, `${where}: confirmation rewritten`);
      if (before.completedAt !== null) assert.deepEqual(after, before, `${where}: a settled operation changed`);
      assert.deepEqual([after.providerIdempotencyKey, after.claimGeneration], [op.providerIdempotencyKey, 1], `${where}: key or claim changed`);
      before = after;
    }
    assert.equal(codexResetOperationStatus(before), 'SUCCEEDED', `seed ${seed}`);
  }
});

test('(9) a result is refused as the contract says, and a refusal writes nothing', { skip, timeout: 120_000 }, async (t) => {
  const w = await world(t);
  const m = await newMachine(w);
  const sibling = await newMachine(w, m.ownerId);
  const stranger = await newMachine(w);
  const a = newProcess();
  const op = await confirmed(w, m, a);
  const consume = (await heartbeat(w, m, { proc: a })).command;
  const claimed = await operation(w, op.id);
  const retrying = result(consume, 'CONSUME_RETRYING', { code: 'PROVIDER_TIMEOUT' });

  // Not a protocol v1 result: a field v1 does not have, a missing field, nothing at all.
  assertRefusal(await report(w, m, { ...retrying, creditId: 'rlrc_fixture_1' }), 'INVALID_RESULT');
  assertRefusal(await report(w, m, { ...retrying, kind: undefined }), 'INVALID_RESULT');
  assertRefusal(await report(w, m, {}), 'INVALID_RESULT');
  // Not this runner's operation: unknown, a sibling runner of the same owner, another owner's runner.
  assertRefusal(await report(w, m, { ...retrying, operationId: randomUUID() }), 'OPERATION_NOT_FOUND');
  assertRefusal(await report(w, sibling, retrying), 'OPERATION_NOT_FOUND');
  assertRefusal(await report(w, stranger, retrying), 'OPERATION_NOT_FOUND');
  // No runner at all.
  assert.equal((await w.send('/runner/codex-rate-limit-reset-result', { body: retrying })).status, 401);
  assert.equal((await w.send('/runner/codex-rate-limit-reset-result', { token: 'not-a-runner-token', body: retrying })).status, 401);
  assert.deepEqual(await operation(w, op.id), claimed, 'a refusal wrote');

  // Paired: the claim holder's own result is applied.
  assertReceipt(await report(w, m, retrying), { disposition: 'APPLIED', status: 'CONSUMING', next: 'RETRY_CONSUME' });
  assertReceipt(await report(w, m, result(consume, 'CONSUME_OUTCOME', { outcome: 'reset' })), {
    disposition: 'APPLIED', status: 'REFRESHING', next: 'REFRESH',
  });
  const refreshing = await operation(w, op.id);
  const refresh = { ...consume, phase: 'REFRESH' };
  assertRefusal(await report(w, m, retrying), 'PHASE_MISMATCH');
  assertRefusal(await report(w, m, result(consume, 'CONSUME_OUTCOME', { outcome: 'nothingToReset' })), 'OUTCOME_CONFLICT');
  assertRefusal(await report(w, m, result(refresh, 'REFRESHED', { rateLimitReset: read(a, OTHER_FINGERPRINT) })), 'ACCOUNT_MISMATCH');
  assert.deepEqual(await operation(w, op.id), refreshing, 'a refusal wrote');
  assertReceipt(await report(w, m, result(refresh, 'REFRESHED', { rateLimitReset: read(a) })), {
    disposition: 'APPLIED', status: 'SUCCEEDED', next: 'STOP',
  });
  const settled = await operation(w, op.id);
  assertRefusal(await report(w, m, result(refresh, 'REFRESH_FAILED', { code: 'READ_FAILED' })), 'OPERATION_SETTLED');
  assert.deepEqual(await operation(w, op.id), settled, 'a refusal wrote a settled operation');
});

test('(10) draining: a draining process is handed nothing, RELEASED hands its claim back, and the successor claims it at once', {
  skip, timeout: 120_000,
}, async (t) => {
  const w = await world(t);
  const m = await newMachine(w);
  const a = newProcess();
  const b = newProcess();
  const op = await confirmed(w, m, a);
  const consume = (await heartbeat(w, m, { proc: a })).command;
  assertCommand(consume, op, a, { phase: 'CONSUME', claimGeneration: 1 });
  const claimed = await operation(w, op.id);

  assert.equal((await heartbeat(w, m, { proc: a, draining: true })).command, undefined, 'a draining process was redelivered to');
  assert.deepEqual(await operation(w, op.id), claimed);
  assert.equal((await heartbeat(w, m, { proc: b })).command, undefined, 'the successor took a fresh claim');

  // a never called the provider, so it hands the claim back.
  assertReceipt(await report(w, m, result(consume, 'RELEASED', { code: 'RUNNER_DRAINING' })), {
    disposition: 'APPLIED', status: 'CONSUMING', next: 'STOP',
  });
  const released = await operation(w, op.id);
  assert.deepEqual(
    [released.claimLeaseOwner, released.claimGeneration, released.claimsWithUnknownCall, released.lastErrorCode],
    [null, 1, 0, 'RUNNER_DRAINING'],
  );
  const successor = await heartbeat(w, m, { proc: b });
  assertCommand(successor.command, op, b, { phase: 'CONSUME', claimGeneration: 2 });
  const taken = await operation(w, op.id);
  assert.deepEqual([taken.claimLeaseOwner, taken.claimGeneration, taken.claimsWithUnknownCall], [b.leaseOwner, 2, 1]);
  // The release sent again belongs to a claim that is no longer current.
  assertRefusal(await report(w, m, result(consume, 'RELEASED', { code: 'RUNNER_DRAINING' })), 'STALE_CLAIM');
  assert.deepEqual(await operation(w, op.id), taken);
});

test('(11) deadlines settle at any heartbeat of the runner, an old runner\'s too, and a fresh claim holds them off', {
  skip, timeout: 120_000,
}, async (t) => {
  const w = await world(t);
  const m = await newMachine(w);
  const claimer = randomUUID();
  const insert = async (row: {
    consumeState: string; consumeOutcome?: string; refreshState: string; claimed?: number; unknown?: number;
    createdSecondsAgo: number; confirmedSecondsAgo?: number;
  }): Promise<string> => {
    const id = randomUUID();
    await w.sql.query(
      `INSERT INTO codex_rate_limit_reset_operation (id, owner_id, runner_id, account_fingerprint, client_request_id,
         provider_idempotency_key, consume_state, consume_outcome, refresh_state, claim_lease_owner, claim_generation,
         claimed_at, claims_with_unknown_call, created_at, updated_at, consume_confirmed_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, now() - make_interval(secs => $12::double precision), $13,
               now() - make_interval(secs => $14::double precision), now(), now() - make_interval(secs => $15::double precision))`,
      [
        id, m.ownerId, m.id, `cxa1_${randomUUID().replace(/-/g, '')}`, randomUUID(), randomUUID(),
        row.consumeState, row.consumeOutcome ?? null, row.refreshState,
        row.claimed === undefined ? null : claimer, row.claimed === undefined ? 0 : 1, row.claimed ?? null, row.unknown ?? 0,
        row.createdSecondsAgo, row.confirmedSecondsAgo ?? null,
      ],
    );
    return id;
  };
  const neverClaimed = await insert({ consumeState: 'PENDING', refreshState: 'NONE', createdSecondsAgo: 660 });
  const claimedLongAgo = await insert({ consumeState: 'CLAIMED', refreshState: 'NONE', claimed: 120, unknown: 1, createdSecondsAgo: 660 });
  const refreshLate = await insert({
    consumeState: 'CONFIRMED', consumeOutcome: 'reset', refreshState: 'PENDING', claimed: 700, unknown: 1,
    createdSecondsAgo: 720, confirmedSecondsAgo: 660,
  });
  const freshClaim = await insert({ consumeState: 'CLAIMED', refreshState: 'NONE', claimed: 10, unknown: 1, createdSecondsAgo: 660 });
  const notDue = await insert({ consumeState: 'PENDING', refreshState: 'NONE', createdSecondsAgo: 300 });
  const heldOff = await operation(w, freshClaim);
  const waiting = await operation(w, notDue);

  // A heartbeat of a runner too old to name a process or declare anything.
  const old = await w.send('/runner/heartbeat', { token: m.token, body: { status: 'ONLINE', idleCapacity: 1 } });
  assert.equal(old.status, 201, old.text);
  assert.equal('codexRateLimitResetRequest' in old.json, false);
  const outcomes: State[] = [];
  for (const id of [neverClaimed, claimedLongAgo, refreshLate]) outcomes.push(await operation(w, id));
  assert.deepEqual(
    outcomes.map((row) => [codexResetOperationStatus(row), row.failureCode, row.consumeOutcome, row.completedAt !== null]),
    [
      ['NOT_ATTEMPTED', 'CONSUME_EXPIRED', null, true],
      ['UNRESOLVED', 'CONSUME_EXPIRED', null, true],
      ['REFRESH_FAILED', 'REFRESH_EXPIRED', 'reset', true],
    ],
  );
  assert.deepEqual(await operation(w, freshClaim), heldOff, 'a claim younger than the takeover window was expired');
  assert.deepEqual(await operation(w, notDue), waiting, 'an operation inside its deadline was expired');

  await ageClaim(w, freshClaim);
  await w.send('/runner/heartbeat', { token: m.token, body: { status: 'ONLINE', idleCapacity: 1 } });
  const expired = await operation(w, freshClaim);
  assert.deepEqual([codexResetOperationStatus(expired), expired.failureCode], ['UNRESOLVED', 'CONSUME_EXPIRED']);
  assert.deepEqual(await operation(w, notDue), waiting);
});

test('(12) two processes heartbeating at once claim an operation exactly once', { skip, timeout: 180_000 }, async (t) => {
  const w = await world(t);
  for (let round = 1; round <= 6; round++) {
    const m = await newMachine(w);
    const a = newProcess();
    const b = newProcess();
    const op = await confirmed(w, m, a);
    const answers = await Promise.all([heartbeat(w, m, { proc: a }), heartbeat(w, m, { proc: b })]);
    const handed = answers.filter((answer) => answer.command !== undefined);
    assert.equal(handed.length, 1, `round ${round}: ${handed.length} processes were handed the command`);
    const winner = answers[0].command ? a : b;
    assertCommand(handed[0].command, op, winner, { phase: 'CONSUME', claimGeneration: 1 });
    const row = await operation(w, op.id);
    assert.deepEqual([row.claimLeaseOwner, row.claimGeneration, row.claimsWithUnknownCall], [winner.leaseOwner, 1, 1]);
  }
});

function run(command: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv }): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', (chunk) => (output += chunk));
    child.stderr.on('data', (chunk) => (output += chunk));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, output }));
  });
}

/** The Go runner's live relay test binary: as scripts/test-codex-reset-relay.sh built it, or built here. */
async function liveTestBinary(t: TestContext): Promise<string> {
  const prebuilt = process.env.ORBIT_CODEX_RESET_LIVE_TEST_BINARY;
  if (prebuilt) return prebuilt;
  const dir = mkdtempSync(path.join(tmpdir(), 'codex-reset-relay-go-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const binary = path.join(dir, 'runner-go-live.test');
  const built = await run('go', ['test', '-c', '-tags', 'codexresetlive', '-o', binary, '.'], { cwd: RUNNER_GO, env: process.env });
  assert.equal(built.code, 0, built.output);
  return binary;
}

test('(13) the Go runner relay against these routes: its heartbeat, the command, results and receipts over the wire', {
  skip, timeout: 600_000,
}, async (t) => {
  const w = await world(t);
  const m = await newMachine(w);
  // A TypeScript process made the runner eligible and is gone; the Go process is the one that claims.
  const op = await confirmed(w, m, newProcess());
  const binary = await liveTestBinary(t);
  const home = mkdtempSync(path.join(tmpdir(), 'codex-reset-relay-live-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  // No account reaches it: a scratch HOME, CODEX_HOME and ORBIT_HOME, and no OPENAI_* or CODEX_API_KEY.
  const live = await run(binary, ['-test.run', '^TestCodexResetRelayAgainstALiveControlPlane$', '-test.v', '-test.count', '1'], {
    cwd: RUNNER_GO,
    env: {
      PATH: process.env.PATH ?? '',
      HOME: home,
      ORBIT_HOME: path.join(home, 'orbit'),
      CODEX_HOME: path.join(home, 'codex'),
      ORBIT_CODEX_RESET_LIVE_URL: w.origin(),
      ORBIT_CODEX_RESET_LIVE_TOKEN: m.token,
      ORBIT_CODEX_RESET_LIVE_OPERATION: op.id,
      ORBIT_CODEX_RESET_LIVE_FINGERPRINT: FINGERPRINT,
      ORBIT_CODEX_RESET_LIVE_PROVIDER_KEY: op.providerIdempotencyKey,
    },
  });
  assert.equal(live.code, 0, live.output);
  assert.match(live.output, /^--- PASS: TestCodexResetRelayAgainstALiveControlPlane /m, live.output);
  assert.doesNotMatch(live.output, /--- (?:FAIL|SKIP)|no tests to run/, live.output);
  const goProcess = /^CODEX_RESET_LIVE_PROCESS=([0-9a-f-]{36})$/m.exec(live.output)?.[1];
  assert.ok(goProcess, `the Go process did not name its lease owner:\n${live.output}`);

  const done = await operation(w, op.id);
  assert.deepEqual(
    [codexResetOperationStatus(done), done.consumeOutcome, done.claimLeaseOwner, done.claimGeneration, done.providerIdempotencyKey],
    ['SUCCEEDED', 'reset', goProcess, 1, op.providerIdempotencyKey],
  );
  assert.equal((await storedBlock(w, m))?.generation, goProcess, 'planUsage holds the Go process’s own latest read');
});
