/**
 * Link-token renewals in lockstep are not a mass disconnection; a real simultaneous loss still is
 * (docs/runner-link-design.md §10, §15; runner-presence.ts#recordRunnerLinkOpened, realtime/reaper.service.ts).
 *
 * WHY
 * ---
 * A runner renews its link connection make-before-break 55 minutes after its token was minted: the new connection is
 * opened with a fresh token and welcomed (POST /runner/link/welcome) while the old one still beats, and the gateway
 * then closes the old one as superseded. After a fleet-wide restart every runner's token is minted within a minute, so
 * their renewals stay in lockstep. Each welcome used to copy the runner's last beat into `runner_presence.lost_at`, and
 * the reaper read three or four runners "losing contact" in the same second as a mass disconnection (production,
 * 2026-11-08 05:26Z and 06:21Z), holding the silence of a runner that really went quiet beside them.
 *
 * WHAT THIS DRIVES
 * ----------------
 * The real welcome and link heartbeat routes behind the real RunnerAuthGuard, reached the way the link gateway reaches
 * them (the internal listener, the gateway's secret, the runner's link token), over a disposable PostgreSQL, and the
 * real ReaperService sweeping that database. Ten runners, each with a process, a link connection and a running session.
 * Time is moved by shifting this run's beats back (`warp`): every runner still connected beats again after the shift,
 * on time, as one beating every 30 s would have.
 *
 * WHAT IT ASSERTS
 * ---------------
 *   (1) Three runners renew in the same minute: each new connection is welcomed with a token minted moments ago, the old
 *       one beats once more and is then superseded, and the new one beats. A fourth runner goes quiet in that minute on
 *       its own. Seven minutes later a sweep writes no `runner_mass_disconnect`, the renewing runners keep no loss, and
 *       the quiet runner's session is reaped `runner offline` — its silence is not held.
 *   (2) A link gateway node dies: three of the runners left reconnect within seconds through another node with the
 *       tokens they hold (minted twenty minutes earlier), and a fourth on that node never comes back. Six minutes later a
 *       sweep writes a `runner_mass_disconnect` spanning their losses, and the session of the runner still silent —
 *       past RUNNER_REAP_AFTER_MS — is held, not reaped.
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/runner-api/runner-link-renewal.pg.spec.ts
 *
 * Needs COORDINATOR_PG_URL (the script provides a disposable one). Not destructive: every row is this run's.
 */
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';

import { type INestApplication, Module, ValidationPipe } from '@nestjs/common';
import { HttpAdapterHost, NestFactory } from '@nestjs/core';
import { json } from 'express';
import { type PrismaClient, RunStatus, SessionDispatchOrigin } from '@prisma/client';
import { Client } from 'pg';

import { sha256 } from '../common/crypto.util';
import { publicIdHeaders } from '../common/public-id-headers';
import { PublicIdExceptionFilter } from '../common/public-id.filter';
import { PublicIdInterceptor } from '../common/public-id.interceptor';
import { RunnerLinkErrorFilter } from '../common/runner-link-error.filter';
import { TransientDbConflictFilter } from '../common/transient-db-conflict.filter';
import { prismaClientFor } from '../prisma/prisma-client';
import { PrismaService } from '../prisma/prisma.service';
import { AttemptBudgetMeterService } from '../projects/attempt-budget-meter.service';
import { assertCoordinatorPgUrlIsIsolated, verifyCoordinatorPgIdentity } from '../projects/coordinator-pg-test-safety';
import { ProjectAcceptanceService } from '../projects/project-acceptance.service';
import { PushService } from '../push/push.service';
import { QueueService } from '../queue/queue.service';
import { RealtimeService } from '../realtime/realtime.service';
import { MASS_DISCONNECT_HOLD_MS, ReaperService, RUNNER_REAP_AFTER_MS } from '../realtime/reaper.service';
import { RunnerPresenceService } from '../runners/runner-presence';
import { MergeReceiptService } from '../sessions/merge-receipt.service';
import { SessionsService } from '../sessions/sessions.service';
import { ListEventsService } from '../task-lists/list-events.service';
import { ReferenceExpansionService } from '../tasks/reference-expansion';
import { TasksService } from '../tasks/tasks.service';
import { RunnerApiController } from './runner-api.controller';
import { RunnerAuthGuard } from './runner-auth.guard';
import { listenForRunnerLinkCalls } from './runner-link-call';
import { readRunnerLink, RUNNER_LINK, runnerLinkCredential, signRunnerLinkToken, type RunnerLinkState } from './runner-link-token';
import { RunnerLinkWelcomeController } from './runner-link-welcome.controller';
import { RunnerOrchestrationAuthorizer } from './runner-orchestration-authorizer';
import '../test-support/daemon-routes-over-http';

declare global {
  interface BigInt { toJSON(): string; }
}
BigInt.prototype.toJSON = function toJSON(this: bigint): string {
  return this.toString();
};

const PG_URL = process.env.COORDINATOR_PG_URL;
const GATEWAY_TOKEN = `the-link-gateway-secret:${randomUUID()}`;
const MINUTE = 60_000;

/** One request on a connection of its own. */
function send(port: number, pathname: string, headers: Record<string, string>, body: unknown): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const payload = Buffer.from(JSON.stringify(body));
    const req = httpRequest(
      {
        host: '127.0.0.1', port, method: 'POST', path: pathname, agent: false,
        headers: { 'content-type': 'application/json', 'content-length': String(payload.length), ...headers },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('error', reject);
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let parsed: unknown = text;
          try {
            parsed = text === '' ? null : JSON.parse(text);
          } catch {
            /* kept as text */
          }
          resolve({ status: res.statusCode ?? 0, body: parsed });
        });
      },
    );
    req.on('error', reject);
    req.end(payload);
  });
}

/** The runner door as main.ts builds it, with the gateway's internal listener beside it (runner-link-welcome.pg.spec.ts). */
async function bootDoor(db: PrismaClient, link: RunnerLinkState, realtime: RealtimeService) {
  const queue = new QueueService(db as unknown as PrismaService, realtime);
  const sessions = new SessionsService(db as unknown as PrismaService, queue, realtime);
  @Module({
    controllers: [RunnerApiController, RunnerLinkWelcomeController],
    providers: [
      { provide: PrismaService, useValue: db },
      { provide: QueueService, useValue: queue },
      { provide: SessionsService, useValue: sessions },
      { provide: RealtimeService, useValue: realtime },
      { provide: PushService, useValue: { scheduleBadgeSync: () => undefined, notifyEngineSignedOut: async () => undefined } },
      { provide: RunnerOrchestrationAuthorizer, useValue: { issue: async () => 'credential' } },
      { provide: ReferenceExpansionService, useValue: { expand: async (_owner: string, content?: string) => content } },
      { provide: ListEventsService, useValue: { appendFor: async (_tx: unknown, _id: string, content?: string) => content } },
      { provide: AttemptBudgetMeterService, useValue: { meterQuietly: async () => undefined } },
      { provide: ProjectAcceptanceService, useValue: {} },
      { provide: TasksService, useValue: {} },
      { provide: MergeReceiptService, useValue: {} },
      { provide: RUNNER_LINK, useValue: link },
      RunnerAuthGuard,
    ],
  })
  class RunnerDoor {}

  const app: INestApplication = await NestFactory.create(RunnerDoor, { logger: false, abortOnError: false, bodyParser: false });
  app.use(json({ limit: '10mb' }));
  app.use(publicIdHeaders);
  app.setGlobalPrefix('api');
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: false }));
  app.useGlobalInterceptors(new PublicIdInterceptor());
  const httpAdapter = app.get(HttpAdapterHost).httpAdapter;
  app.useGlobalFilters(
    new TransientDbConflictFilter(new RunnerLinkErrorFilter(new PublicIdExceptionFilter(httpAdapter), httpAdapter), httpAdapter),
  );
  await app.listen(0, '127.0.0.1');
  const problems: string[] = [];
  const linkServer = await listenForRunnerLinkCalls(
    app,
    { port: '0', host: '127.0.0.1' },
    { log: () => undefined, error: (message: string) => problems.push(message) },
  );
  assert.ok(linkServer, `the internal listener did not open: ${problems.join('; ')}`);
  return {
    linkPort: (linkServer.address() as AddressInfo).port,
    close: async () => {
      linkServer.closeAllConnections();
      await new Promise<void>((resolve) => linkServer.close(() => resolve()));
      await app.close();
    },
  };
}

test('lockstep link-token renewals are no mass disconnection; a real simultaneous loss still is', {
  skip: !PG_URL,
  concurrency: 1,
  timeout: 300_000,
}, async (t) => {
  const url = PG_URL!;
  assertCoordinatorPgUrlIsIsolated(url);
  process.env.DATABASE_URL = url;
  const sql = new Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
  await sql.connect();
  await verifyCoordinatorPgIdentity(sql);
  const db: PrismaClient = prismaClientFor(url);

  const { privateKey } = generateKeyPairSync('ed25519');
  const link = readRunnerLink({
    signingKey: Buffer.from(privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), 'utf8').toString('base64'),
    linkUrl: 'wss://link.runner-renewal.invalid',
    gatewayToken: GATEWAY_TOKEN,
  });
  assert.ok(link.config, `the test link did not configure: ${link.problems.join('; ')}`);
  const config = link.config;
  const push = { scheduleBadgeSync: () => undefined, notifySessionSettled: async () => undefined };
  const realtime = new RealtimeService(db as unknown as PrismaService, push as unknown as PushService);
  const door = await bootDoor(db, link, realtime);
  t.after(async () => {
    await door.close().catch(() => undefined);
    realtime.onModuleDestroy();
    await db.$disconnect().catch(() => undefined);
    await sql.end().catch(() => undefined);
  });

  // This test's database is its own, so the cell the reaper reads is exactly these runners.
  assert.equal(await db.runner.count(), 0, 'the cell starts empty');
  const ownerId = randomUUID();
  await db.user.create({ data: { id: ownerId, email: `runner-link-renewal-${ownerId}@runner-door.invalid`, name: 'renewal', passwordHash: 'x' } });

  interface Machine {
    name: string;
    id: string;
    credential: string;
    /** The runner process: Hello.process_id, the heartbeat's leaseOwner, the link token's. */
    process: string;
    /** The token its current connection was opened with. */
    token: string;
    sessionId: string;
  }
  const mint = (m: Pick<Machine, 'id' | 'credential' | 'process'>, at: Date) =>
    signRunnerLinkToken(config, { runnerId: m.id, ownerId, cellId: 'cell-1', leaseOwner: m.process, credential: m.credential }, at).token;
  const viaLink = (token: string, gateway: string) => ({
    authorization: `Bearer ${GATEWAY_TOKEN}`,
    'x-orbit-runner-link-token': token,
    'x-orbit-link-gateway-id': gateway,
  });

  const machines: Machine[] = [];
  const started = Date.now();
  for (let i = 0; i < 10; i += 1) {
    const id = randomUUID();
    const runnerToken = `runner-${i}:${randomUUID()}`;
    const credential = runnerLinkCredential(sha256(runnerToken));
    const process = randomUUID();
    // Its own record of beats an hour old: what it is heard by is its presence row.
    await db.runner.create({
      data: { id, ownerId, name: `renewal-${i}`, tokenHash: sha256(runnerToken), status: 'ONLINE', maxConcurrent: 4, lastHeartbeatAt: new Date(started - 60 * MINUTE) },
    });
    const workspaceId = randomUUID();
    await db.workspace.create({ data: { id: workspaceId, ownerId, runnerId: id, name: `renewal-${i}`, enabled: true } });
    const sessionId = randomUUID();
    await db.session.create({
      data: {
        id: sessionId, ownerId, creatorId: ownerId, workspaceId, assignedRunnerId: id, title: `run on renewal-${i}`, prompt: 'work',
        provider: 'claude', providerBuiltin: true, status: RunStatus.RUNNING, runtimeSessionId: randomUUID(),
        startedAt: new Date(started - 30 * MINUTE), runClaimedAt: new Date(started - 30 * MINUTE), dispatchOrigin: SessionDispatchOrigin.USER,
      },
    });
    // Connected for twenty minutes, with a token minted when it connected.
    const m = { name: `renewal-${i}`, id, credential, process, token: '', sessionId };
    m.token = mint(m, new Date(started - 20 * MINUTE));
    machines.push(m);
  }
  const ids = machines.map((m) => m.id);

  /** One link heartbeat of this machine's process over the connection opened with `token`. */
  async function beat(m: Machine, token = m.token, gateway = 'gw-a') {
    const answer = await send(door.linkPort, '/api/runner/heartbeat', viaLink(token, gateway),
      { status: 'ONLINE', idleCapacity: 1, leaseOwner: m.process, supervisedSessionIds: [] });
    assert.equal(answer.status, 201, `${m.name}'s heartbeat: ${JSON.stringify(answer.body)}`);
  }
  /** The gateway opening a connection for this machine's process with `token`: the welcome, before Welcome. */
  async function welcome(m: Machine, token: string, gateway: string) {
    const answer = await send(door.linkPort, '/api/runner/link/welcome', viaLink(token, gateway), { sessionIds: [m.sessionId] });
    assert.equal(answer.status, 200, `${m.name}'s welcome: ${JSON.stringify(answer.body)}`);
  }
  /** `ms` pass: every beat of this run's runners moves that far into the past. */
  async function warp(ms: number) {
    await sql.query(
      `UPDATE "runner_presence" SET "last_beat_at" = "last_beat_at" - ($2 * interval '1 millisecond'),
                                    "lost_at" = "lost_at" - ($2 * interval '1 millisecond')
        WHERE "runner_id" = ANY($1::uuid[])`, [ids, ms]);
    await sql.query(
      `UPDATE "runner" SET "last_heartbeat_at" = "last_heartbeat_at" - ($2 * interval '1 millisecond') WHERE "id" = ANY($1::uuid[])`,
      [ids, ms]);
    await sql.query(
      `UPDATE "runner_mass_disconnect" SET "lost_from" = "lost_from" - ($1 * interval '1 millisecond'),
                                           "lost_to" = "lost_to" - ($1 * interval '1 millisecond')`, [ms]);
  }
  /** The runners still connected beat again, on time: the beat that comes 30 s after the last one a shift moved back. */
  async function stillBeating(connected: Machine[]) {
    await sql.query(`UPDATE "runner_presence" SET "last_beat_at" = (now() AT TIME ZONE 'UTC') WHERE "runner_id" = ANY($1::uuid[])`,
      [connected.map((m) => m.id)]);
  }
  const presence = new RunnerPresenceService(db as unknown as PrismaService);
  const reaperRealtime = {
    requestCancel: () => undefined, publish: () => undefined, publishTaskChanged: () => undefined, publishQueuedTurnsChanged: () => undefined,
  } as never;
  /** One sweep of a reaper just built: past any startup grace, carrying nothing from another sweep. */
  const sweep = () => (new ReaperService(db as unknown as PrismaService, reaperRealtime, undefined, presence) as unknown as {
    sweep(): Promise<void>;
  }).sweep();
  const stateOf = (m: Machine) => db.session.findUniqueOrThrow({ where: { id: m.sessionId }, select: { status: true, error: true } });
  const lostAt = async (m: Machine) => (await db.runnerPresence.findUniqueOrThrow({ where: { runnerId: m.id } })).lostAt;
  const running = { status: RunStatus.RUNNING, error: null };
  const offline = { status: RunStatus.FAILED, error: 'runner offline' };

  // Every runner connected and beating.
  for (const m of machines) await beat(m);
  const gone: Machine[] = [];
  const connected = () => machines.filter((m) => !gone.includes(m));

  await t.test('(1) three runners renewing in one minute write no mass disconnection and hold no reaping', async () => {
    const renewing = machines.slice(0, 3);
    const quiet = machines[3]!;
    for (const m of connected()) await beat(m);
    // The quiet runner's last beat is in this minute too; it beats no more.
    gone.push(quiet);
    for (const m of renewing) {
      // Make before break: the new connection, opened with a token minted now, is welcomed while the old one is up ...
      const fresh = mint(m, new Date());
      await welcome(m, fresh, 'gw-b');
      // ... the old one beats once more before the gateway closes it as superseded ...
      await beat(m, m.token, 'gw-a');
      // ... and the new one carries the beats from then on.
      m.token = fresh;
      await beat(m, fresh, 'gw-b');
    }
    const renewalLosses = await Promise.all(renewing.map(lostAt));

    // Seven minutes on: the quiet runner is past RUNNER_REAP_AFTER_MS, well inside MASS_DISCONNECT_HOLD_MS.
    const later = 7 * MINUTE;
    assert.ok(later > RUNNER_REAP_AFTER_MS + 30_000 && later < MASS_DISCONNECT_HOLD_MS);
    await warp(later);
    await stillBeating(connected());
    await sweep();
    // One comparison, so a failure shows every part of it at once.
    assert.deepEqual({
      lostAtOfRenewingRunners: renewalLosses,
      massDisconnects: await db.runnerMassDisconnect.findMany({ select: { runners: true, heard: true } }),
      sessionOfQuietRunner: await stateOf(quiet),
      sessionsOfRenewingRunners: await Promise.all(renewing.map(stateOf)),
    }, {
      lostAtOfRenewingRunners: [null, null, null],
      massDisconnects: [],
      sessionOfQuietRunner: offline,
      sessionsOfRenewingRunners: [running, running, running],
    }, 'a renewal is no loss of contact, no runner_mass_disconnect is written, and the quiet runner is reaped on time');
  });

  await t.test('(2) a gateway node dying — three runners back within seconds, one not — is still a mass disconnection', async () => {
    const back = machines.slice(4, 7);
    const lost = machines[7]!;
    for (const m of connected()) await beat(m);
    gone.push(lost);
    // gw-a dies. Its runners reconnect through gw-c at once, with the tokens they hold (minted twenty minutes before
    // their connections were opened); the last one never comes back.
    for (const m of back) {
      await welcome(m, m.token, 'gw-c');
      await beat(m, m.token, 'gw-c');
    }
    for (const m of back) assert.notEqual(await lostAt(m), null, `${m.name}'s reconnection is kept as a loss`);

    // Six minutes on: the runner that did not come back is past RUNNER_REAP_AFTER_MS.
    const later = 6 * MINUTE;
    await warp(later);
    await stillBeating(connected());
    const lostBeat = (await db.runnerPresence.findUniqueOrThrow({ where: { runnerId: lost.id } })).lastBeatAt.getTime();
    assert.ok(Date.now() - lostBeat > RUNNER_REAP_AFTER_MS, 'the lost runner is past the reaper line');
    await sweep();
    // (1) wrote none on today's code; on the code before, the one it wrote spans its own minute, six minutes before.
    const rows = (await db.runnerMassDisconnect.findMany()).filter((r) => r.lostTo.getTime() >= lostBeat - MINUTE);
    assert.equal(rows.length, 1, `one mass disconnection is written: ${JSON.stringify(rows)}`);
    const [row] = rows;
    assert.ok(row!.runners >= 4, `the three back and the one lost: ${JSON.stringify(row)}`);
    assert.ok(row!.runners / row!.heard >= 0.2, `a fifth or more of the cell: ${JSON.stringify(row)}`);
    assert.ok(row!.lostFrom.getTime() <= lostBeat && lostBeat <= row!.lostTo.getTime(), 'it spans the lost runner\'s last beat');
    assert.deepEqual(await stateOf(lost), running, 'the lost runner\'s session is held by the mass disconnection');
    for (const m of back) assert.deepEqual(await stateOf(m), running, `${m.name} keeps its session`);
  });
});
