/**
 * Codex earned rate-limit reset on an added account (docs/codex-rate-limit-reset-contract.md §12; migration
 * 1669), end to end over the real routes and a real PostgreSQL: the user's create route
 * (`POST /runners/:id/codex-rate-limit-reset`) and the runner's heartbeat and result routes.
 *
 *   (1) a workspace whose chosen Codex account is an added slot creates its reset — not ACCOUNT_OVERRIDE —
 *       for that slot, which the row stores; the heartbeat hands the runner a v2 CONSUME and then REFRESH
 *       naming that slot, and the refreshed block lands on that slot alone. Beside it: a confirmation of
 *       Default's account from the same workspace is ACCOUNT_MISMATCH (the slot's block decides), an env
 *       credential is still ACCOUNT_OVERRIDE, a v1-only runner cannot take the added slot, and Default's own
 *       reset waits its turn behind the added slot's (one command per heartbeat) and is then sent naming
 *       `default`.
 *   (2) the slot column is immutable and holds `default` or an 8-hex id only, whatever writes it.
 *   (3) `GET …/codex-rate-limit-reset?accountFingerprint=` answers one account's active and latest operation;
 *       without the filter, the runner's.
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/runners/codex-reset-added-account.pg.spec.ts
 *
 * Not destructive: every case owns freshly generated users, runners, workspaces and operations.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test, type TestContext } from 'node:test';

import { Module, ValidationPipe } from '@nestjs/common';
import { HttpAdapterHost, NestFactory, Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import type { PrismaClient } from '@prisma/client';
import {
  CODEX_RATE_LIMIT_RESET_CAPABILITY_V1,
  CODEX_RATE_LIMIT_RESET_CAPABILITY_V2,
  base62ToUuid,
  codexRateLimitResetOf,
  codexResetCommandViolations,
  uuidToBase62,
  type PlanUsage,
  type PlanUsageRateLimitReset,
} from '@orbit/shared';
import { Client } from 'pg';

import { JwtAuthGuard } from '../auth/jwt-auth.guard';
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
import { RunnerApiController } from '../runner-api/runner-api.controller';
import { RunnerAuthGuard } from '../runner-api/runner-auth.guard';
import { RunnerOrchestrationAuthorizer } from '../runner-api/runner-orchestration-authorizer';
import { MergeReceiptService } from '../sessions/merge-receipt.service';
import { ListEventsService } from '../task-lists/list-events.service';
import { ReferenceExpansionService } from '../tasks/reference-expansion';
import { TasksService } from '../tasks/tasks.service';
import { CodexRateLimitResetController } from './codex-rate-limit-reset.controller';
import { CodexRateLimitResetRepository } from './codex-rate-limit-reset.repository';
import { CodexRateLimitResetService } from './codex-rate-limit-reset.service';
import '../test-support/daemon-routes-over-http';

const URL = process.env.COORDINATOR_PG_URL;
const skip = !URL;

/** Work: an account the runner added, by its slot id, and the ChatGPT account signed in there. */
const WORK = '3fa91c2e';
const WORK_FINGERPRINT = 'cxa1_ba0f094a2ee93e11858a0c7e88850745';
/** The ChatGPT account signed in to Default. */
const DEFAULT_FINGERPRINT = 'cxa1_92381c922ad04574cc61964161fd5687';
const V1 = CODEX_RATE_LIMIT_RESET_CAPABILITY_V1;
const V2 = `${CODEX_RATE_LIMIT_RESET_CAPABILITY_V1},${CODEX_RATE_LIMIT_RESET_CAPABILITY_V2}`;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;
interface Sent {
  status: number;
  text: string;
  json: Json;
}
interface World {
  prisma: PrismaClient;
  sql: Client;
  /** A user route: the bearer token is the user id. A runner route: the bearer token is the runner's. */
  send(path: string, token: string, body: unknown, headers?: Record<string, string>): Promise<Sent>;
  /** A user route's read. */
  get(path: string, token: string): Promise<Sent>;
}
interface Machine {
  id: string;
  ownerId: string;
  token: string;
  leaseOwner: string;
  reads: number;
}

/** The user's create route and the runner routes, as main.ts serves them, over one database. */
async function world(t: TestContext): Promise<World> {
  const url = URL!;
  assertCoordinatorPgUrlIsIsolated(url);
  const sql = new Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
  await sql.connect();
  await verifyCoordinatorPgIdentity(sql);
  const prisma = prismaClientFor(url);
  const db = prisma as unknown as PrismaService;
  const realtime = {
    drainCancellations: async () => [],
    drainArtifactRequests: async () => [],
    publishSessionUpdated: () => undefined,
    markRunnerChanged: () => undefined,
  };

  @Module({
    controllers: [CodexRateLimitResetController, RunnerApiController],
    providers: [
      { provide: CodexRateLimitResetService, useValue: new CodexRateLimitResetService(db, new CodexRateLimitResetRepository(db)) },
      JwtAuthGuard,
      Reflector,
      { provide: JwtService, useValue: { verifyAsync: async (token: string) => ({ sub: token }) } },
      RunnerAuthGuard,
      { provide: PrismaService, useValue: prisma },
      { provide: QueueService, useValue: {} },
      { provide: RealtimeService, useValue: realtime },
      { provide: PushService, useValue: {} },
      { provide: RunnerOrchestrationAuthorizer, useValue: {} },
      { provide: ReferenceExpansionService, useValue: {} },
      { provide: ListEventsService, useValue: {} },
      { provide: AttemptBudgetMeterService, useValue: {} },
      { provide: ProjectAcceptanceService, useValue: {} },
      { provide: TasksService, useValue: {} },
      { provide: MergeReceiptService, useValue: {} },
    ],
  })
  class Routes {}

  const app = await NestFactory.create(Routes, { logger: false, abortOnError: false });
  app.setGlobalPrefix('api');
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: false }));
  app.useGlobalInterceptors(new WorkspaceAliasInterceptor(), new PublicIdInterceptor());
  const adapter = app.get(HttpAdapterHost).httpAdapter;
  app.useGlobalFilters(new TransientDbConflictFilter(new PublicIdExceptionFilter(adapter), adapter));
  await app.listen(0, '127.0.0.1');
  const base = `${await app.getUrl()}/api`;
  t.after(async () => {
    await app.close();
    await prisma.$disconnect().catch(() => undefined);
    await sql.end().catch(() => undefined);
  });
  const answer = async (response: Response): Promise<Sent> => {
    const text = await response.text();
    let json: Json = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
    return { status: response.status, text, json };
  };
  return {
    prisma,
    sql,
    async send(route, token, body, headers = {}) {
      return answer(await fetch(`${base}${route}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, ...headers },
        body: JSON.stringify(body),
      }));
    },
    async get(route, token) {
      return answer(await fetch(`${base}${route}`, { headers: { authorization: `Bearer ${token}` } }));
    },
  };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** An id as the table holds it, whichever spelling a response used (PublicIdInterceptor re-spells user routes). */
const uuidOf = (id: string): string => (UUID.test(id) ? id : base62ToUuid(id));

async function newMachine(w: World): Promise<Machine> {
  const ownerId = randomUUID();
  await w.prisma.user.create({ data: { id: ownerId, email: `${ownerId}@codex-reset-added.test`, name: 'codex reset added', passwordHash: 'x' } });
  const id = randomUUID();
  const token = `codex-reset-added-${randomUUID()}`;
  await w.prisma.runner.create({ data: { id, ownerId, name: `codex-reset-added-${id}`, tokenHash: sha256(token) } });
  return { id, ownerId, token, leaseOwner: randomUUID(), reads: 0 };
}

/** A read this runner process makes now of the account `fingerprint`: supported, identified, two credits. */
function read(m: Machine, fingerprint: string, credits = 2): PlanUsageRateLimitReset {
  m.reads += 1;
  return {
    protocolVersion: 1,
    support: 'SUPPORTED',
    accountFingerprint: fingerprint,
    rateLimitResetCredits: { availableCount: credits, credits: null },
    fetchedAt: new Date().toISOString(),
    generation: m.leaseOwner,
    sequence: m.reads,
  };
}

const window = (utilization: number) => ({ utilization, resetsAt: '2099-01-01T08:00:00Z', label: '5h limit', windowDurationMins: 300 });

/** A heartbeat of `m`'s process reporting Default and Work, each with a fresh block of its own account. */
async function heartbeat(w: World, m: Machine, capabilities = V2): Promise<Json | undefined> {
  const sent = await w.send('/runner/heartbeat', m.token, {
    status: 'ONLINE',
    idleCapacity: 1,
    leaseOwner: m.leaseOwner,
    planUsage: {
      codex: {
        provider: 'codex',
        primary: window(100),
        rateLimitReset: read(m, DEFAULT_FINGERPRINT),
        accounts: { [WORK]: { provider: 'codex', primary: window(100), rateLimitReset: read(m, WORK_FINGERPRINT) } },
      },
    },
  }, { 'x-orbit-runner-capabilities': capabilities });
  assert.equal(sent.status, 201, sent.text);
  return sent.json.codexRateLimitResetRequest;
}

function confirm(w: World, m: Machine, body: Record<string, unknown>): Promise<Sent> {
  return w.send(`/runners/${m.id}/codex-rate-limit-reset`, m.ownerId, { clientRequestId: randomUUID(), ...body });
}

function report(w: World, m: Machine, command: Json, kind: string, extra: Record<string, unknown>): Promise<Sent> {
  return w.send('/runner/codex-rate-limit-reset-result', m.token, {
    protocolVersion: command.protocolVersion,
    operationId: command.operationId,
    leaseOwner: command.leaseOwner,
    claimGeneration: command.claimGeneration,
    phase: command.phase,
    kind,
    ...extra,
  });
}

async function row(w: World, id: string): Promise<{ slot: string; key: string; consumeState: string; refreshState: string }> {
  const { rows } = await w.sql.query(
    `SELECT account_slot AS slot, provider_idempotency_key::text AS key, consume_state AS "consumeState", refresh_state AS "refreshState"
       FROM codex_rate_limit_reset_operation WHERE id = $1`,
    [id],
  );
  assert.equal(rows.length, 1, `operation ${id} is not stored`);
  return rows[0];
}

async function planUsageOf(w: World, m: Machine): Promise<PlanUsage> {
  return (await w.prisma.runner.findUniqueOrThrow({ where: { id: m.id }, select: { planUsage: true } })).planUsage as PlanUsage;
}

test('(1) a workspace on an added account creates its reset for that slot, and the runner is sent commands naming it', {
  skip, timeout: 120_000,
}, async (t) => {
  const w = await world(t);
  const m = await newMachine(w);
  const workspace = await w.prisma.workspace.create({
    data: { name: `codex-reset-added-${randomUUID()}`, ownerId: m.ownerId, runnerId: m.id, codexAccount: WORK },
  });
  // The workspace's sessions ran the built-in Codex, so neither its provider nor its env is an override.
  await w.prisma.session.create({
    data: {
      ownerId: m.ownerId, creatorId: m.ownerId, title: 'codex reset on Work', prompt: 'codex reset on Work',
      provider: 'codex', providerBuiltin: true, workspaceId: workspace.id, startsTaskWork: false,
    },
  });
  const fromWorkspace = { workspaceId: uuidToBase62(workspace.id) };

  // A runner declaring reset v1 only cannot reset in an added slot: refused for the capability, not the account.
  assert.equal(await heartbeat(w, m, V1), undefined);
  const v1 = await confirm(w, m, { accountFingerprint: WORK_FINGERPRINT, ...fromWorkspace });
  assert.equal(v1.status, 409, v1.text);
  assert.deepEqual(v1.json, { code: 'CAPABILITY_MISSING' });

  assert.equal(await heartbeat(w, m), undefined, 'a runner with no operation is handed nothing');
  // From the Work workspace, Default's account is not the one its reset is for: Work's block decides.
  const wrongAccount = await confirm(w, m, { accountFingerprint: DEFAULT_FINGERPRINT, ...fromWorkspace });
  assert.equal(wrongAccount.status, 409, wrongAccount.text);
  assert.deepEqual(wrongAccount.json, { code: 'ACCOUNT_MISMATCH' });

  // The confirmation from the Work workspace, of Work's account: created, for Work's slot.
  const created = await confirm(w, m, { accountFingerprint: WORK_FINGERPRINT, ...fromWorkspace });
  assert.equal(created.status, 201, `a workspace on an added account is no ACCOUNT_OVERRIDE: ${created.text}`);
  assert.equal(created.json.replayed, false);
  assert.equal(created.json.operation.accountSlot, WORK, 'the view names the added slot');
  assert.equal(created.json.operation.accountFingerprint, WORK_FINGERPRINT);
  const opId = uuidOf(created.json.operation.id);
  const stored = await row(w, opId);
  assert.equal(stored.slot, WORK, 'the row stores the slot');
  // One operation per account in flight: a second for Work is refused, one for Default's account is not.
  const again = await confirm(w, m, { accountFingerprint: WORK_FINGERPRINT, ...fromWorkspace });
  assert.equal(again.status, 409, again.text);
  assert.equal(again.json.code, 'OPERATION_IN_FLIGHT');
  assert.equal(uuidOf(again.json.operationId), opId);
  const forDefault = await confirm(w, m, { accountFingerprint: DEFAULT_FINGERPRINT });
  assert.equal(forDefault.status, 201, `Default's own reset from the runner page: ${forDefault.text}`);
  assert.equal('accountSlot' in forDefault.json.operation, false, "Default's view is v1's, byte for byte");
  const defaultOpId = uuidOf(forDefault.json.operation.id);
  assert.equal((await row(w, defaultOpId)).slot, 'default');

  // An env with credentials of its own is still an override, on an added account too.
  await w.prisma.workspace.update({ where: { id: workspace.id }, data: { env: { OPENAI_API_KEY: 'sk-spec' } } });
  const overridden = await confirm(w, m, { accountFingerprint: WORK_FINGERPRINT, ...fromWorkspace });
  assert.equal(overridden.status, 409, overridden.text);
  assert.deepEqual(overridden.json, { code: 'ACCOUNT_OVERRIDE' });

  // The heartbeat hands the runner Work's operation first (the older one): a v2 CONSUME naming the slot.
  const consume = await heartbeat(w, m);
  assert.ok(consume, 'the heartbeat carried no command');
  assert.deepEqual(codexResetCommandViolations(consume), []);
  assert.deepEqual(
    [consume.protocolVersion, consume.accountSlot, consume.accountFingerprint, consume.phase, uuidOf(consume.operationId), consume.providerIdempotencyKey],
    [2, WORK, WORK_FINGERPRINT, 'CONSUME', opId, stored.key],
  );
  // One command per heartbeat: Default's operation is not claimed while Work's is being delivered.
  assert.equal((await row(w, defaultOpId)).consumeState, 'PENDING');
  const { rows: [unclaimed] } = await w.sql.query('SELECT claim_generation FROM codex_rate_limit_reset_operation WHERE id = $1', [defaultOpId]);
  assert.equal(unclaimed.claim_generation, 0);

  const consumed = await report(w, m, consume, 'CONSUME_OUTCOME', { outcome: 'reset', observedAccountFingerprint: WORK_FINGERPRINT });
  assert.equal(consumed.status, 200, consumed.text);
  assert.deepEqual(consumed.json, { disposition: 'APPLIED', status: 'REFRESHING', next: 'REFRESH' });

  const refresh = await heartbeat(w, m);
  assert.deepEqual(codexResetCommandViolations(refresh), []);
  assert.deepEqual([refresh.protocolVersion, refresh.accountSlot, refresh.phase, uuidOf(refresh.operationId)], [2, WORK, 'REFRESH', opId]);
  const defaultBefore = codexRateLimitResetOf(await planUsageOf(w, m));
  const refreshedBlock = read(m, WORK_FINGERPRINT, 1);
  const refreshed = await report(w, m, refresh, 'REFRESHED', { rateLimitReset: refreshedBlock });
  assert.equal(refreshed.status, 200, refreshed.text);
  assert.deepEqual(refreshed.json, { disposition: 'APPLIED', status: 'SUCCEEDED', next: 'STOP' });
  const after = await planUsageOf(w, m);
  assert.deepEqual(codexRateLimitResetOf(after, WORK), refreshedBlock, "the refreshed block is Work's");
  assert.deepEqual(codexRateLimitResetOf(after), defaultBefore, "Default's block is untouched");
  assert.deepEqual([(await row(w, opId)).consumeState, (await row(w, opId)).refreshState], ['CONFIRMED', 'SUCCEEDED']);

  // Work's operation settled, so Default's is sent next: a v2 command that names `default`.
  const next = await heartbeat(w, m);
  assert.deepEqual(codexResetCommandViolations(next), []);
  assert.deepEqual(
    [next.protocolVersion, next.accountSlot, next.accountFingerprint, uuidOf(next.operationId)],
    [2, 'default', DEFAULT_FINGERPRINT, defaultOpId],
  );
});

test('(2) the slot column is immutable and holds Default or an 8-hex slot id only, whatever writes it', {
  skip, timeout: 120_000,
}, async (t) => {
  const w = await world(t);
  const m = await newMachine(w);
  await heartbeat(w, m);
  const created = await confirm(w, m, { accountFingerprint: WORK_FINGERPRINT, accountSlot: WORK });
  assert.equal(created.status, 201, created.text);
  const id = uuidOf(created.json.operation.id);
  await assert.rejects(
    w.sql.query(`UPDATE codex_rate_limit_reset_operation SET account_slot = 'default' WHERE id = $1`, [id]),
    /account_slot.*immutable/,
  );
  assert.equal((await row(w, id)).slot, WORK);
  for (const slot of ['Work', '3FA91C2E', '../x', '']) {
    await assert.rejects(
      w.sql.query(
        `INSERT INTO codex_rate_limit_reset_operation (id, owner_id, runner_id, account_fingerprint, account_slot,
           client_request_id, provider_idempotency_key, consume_state, refresh_state, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'PENDING', 'NONE', now(), now())`,
        [randomUUID(), m.ownerId, m.id, DEFAULT_FINGERPRINT, slot, randomUUID(), randomUUID()],
      ),
      /account_slot_check/,
      slot,
    );
  }
  // A retry naming another slot is the request id reused; one naming none replays.
  const clientRequestId = randomUUID();
  const first = await confirm(w, m, { clientRequestId, accountFingerprint: DEFAULT_FINGERPRINT });
  assert.equal(first.status, 201, first.text);
  const reused = await confirm(w, m, { clientRequestId, accountFingerprint: DEFAULT_FINGERPRINT, accountSlot: WORK });
  assert.equal(reused.status, 409, reused.text);
  assert.equal(reused.json.code, 'REQUEST_ID_REUSED');
  const replayed = await confirm(w, m, { clientRequestId, accountFingerprint: DEFAULT_FINGERPRINT });
  assert.equal(replayed.status, 200, replayed.text);
  assert.equal(replayed.json.replayed, true);
});

test('(3) the operations read answers for one account at a time when it is asked for one', {
  skip, timeout: 120_000,
}, async (t) => {
  const w = await world(t);
  const m = await newMachine(w);
  await heartbeat(w, m);
  const list = (query = '', token = m.ownerId) => w.get(`/runners/${m.id}/codex-rate-limit-reset${query}`, token);
  const of = (fingerprint: string) => list(`?accountFingerprint=${fingerprint}`);
  /** The account and operation each of `active` and `latest` names. */
  const named = (sent: Sent) => {
    assert.equal(sent.status, 200, sent.text);
    return [sent.json.active, sent.json.latest].map((op: Json) => op && [op.accountFingerprint, uuidOf(op.id)]);
  };

  const work = await confirm(w, m, { accountFingerprint: WORK_FINGERPRINT, accountSlot: WORK });
  assert.equal(work.status, 201, work.text);
  const workOp = [WORK_FINGERPRINT, uuidOf(work.json.operation.id)];
  // Default has nothing yet: Work's operation, in flight, is not Default's.
  assert.deepEqual(named(await of(DEFAULT_FINGERPRINT)), [null, null]);
  assert.deepEqual(named(await of(WORK_FINGERPRINT)), [workOp, workOp]);

  const own = await confirm(w, m, { accountFingerprint: DEFAULT_FINGERPRINT });
  assert.equal(own.status, 201, own.text);
  const defaultOp = [DEFAULT_FINGERPRINT, uuidOf(own.json.operation.id)];
  assert.deepEqual(named(await of(DEFAULT_FINGERPRINT)), [defaultOp, defaultOp]);
  assert.deepEqual(named(await of(WORK_FINGERPRINT)), [workOp, workOp], "a newer operation of Default does not hide Work's");
  // Without the filter it is the runner's newest, whichever account — what older clients read.
  assert.deepEqual(named(await list()), [defaultOp, defaultOp]);

  for (const query of ['?accountFingerprint=', '?accountFingerprint=default', `?accountFingerprint=${WORK_FINGERPRINT}&accountFingerprint=${DEFAULT_FINGERPRINT}`]) {
    const refused = await list(query);
    assert.equal(refused.status, 400, `${query}: ${refused.text}`);
  }
  // Another user's runner stays unfound, filtered or not.
  const stranger = await newMachine(w);
  assert.equal((await list(`?accountFingerprint=${WORK_FINGERPRINT}`, stranger.ownerId)).status, 404);
});

