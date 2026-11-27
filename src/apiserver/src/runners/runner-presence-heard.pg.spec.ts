/**
 * A link Welcome counts as presence, capped five minutes past the runner's last heartbeat (migration 1750,
 * docs/runner-link-design.md §15.16; runners/runner-presence.ts), against a real PostgreSQL that
 * `scripts/run-pg-spec.sh` migrates from empty.
 *
 * The runner door is built as main.ts builds it — RunnerApiController, the welcome and merged-events controllers, the
 * real RunnerAuthGuard and the gateway's internal listener — and reached the way the link gateway reaches it: the
 * gateway's secret and the runner's link token. What it is held to:
 *
 *   (1) a link Welcome writes `last_heard_at` for the calling process on its LINK row, sent again or for a renewal
 *       too; an event batch sent alone, the merged event call, an RPC, a heartbeat and an HTTPS call do not; another
 *       process's Welcome, an HTTPS runner's row and a runner with no row are left as they are, and no row is created;
 *  (1b) a runner whose events and calls flow on one stable connection with no beat reads offline 90 s after its last
 *       beat or Welcome, whichever is later, as it did before last_heard_at existed;
 *   (2) a runner that keeps reconnecting with no heartbeat landing is online until its last heartbeat + 5 min, and
 *       offline by 5 min + 90 s, by the JS reading and the SQL one alike; beats alone call it offline after 90 s;
 *   (3) every switched reader — the hand-written selects among them — agrees with runnerOfflineSql for the same row:
 *       `orbit status` (GET /api/runner/me), the agent-fix rule (attention-fix.ts), the SubAgent workspace choice
 *       (subagent-remote.ts), the wiki repository readiness (wiki-repo-ops.ts), the owner's secret grants
 *       (owner-secrets.service.ts) and the fleet gauges, and the readings runnerPresentAt/runnerPresenceSql give the
 *       same instant; while the kept managed-runner readers (managedRunnerStatus, freshInstanceReport, over a row read
 *       with RUNNER_BEATS as the manager reads it) and the Codex reset's rule still read the beat alone;
 *   (4) both lost_at writers use the later of the beat and the heard: the link beat keeps no loss for a runner heard
 *       through its beat gap and keeps the heard instant otherwise, and the welcome keeps GREATEST(beat, heard), treats
 *       a process heard moments ago with a fresh token as a renewal, and writes last_heard_at on a renewal, on a
 *       welcome sent again, and not for another process;
 *   (5) cellLosses does not count a runner that sent a Welcome within 45 s as silent, though its beat is past the line,
 *       and does count one whose events flow but whose beat and Welcome are past it;
 *   (6) the reaper, sweeping this database, keeps the run of a runner that sent a Welcome a second ago whose last beat
 *       is 5.5 min old, and reaps the run of one whose beat is 11 min old however recent its Welcome (the cap), and of
 *       one whose beat is 5.5 min old on a stable connection its events still flow on (today's schedule);
 *   (7) orbit_runner_reconcile_stale counts a present link runner whose last full reconcile is overdue, and not one
 *       whose reconcile is owed (NULL), one reconciled lately, one on HTTPS or one offline.
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/runners/runner-presence-heard.pg.spec.ts
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
import { Prisma, type PrismaClient, SessionDispatchOrigin } from '@prisma/client';
import { MANAGED_RUNNER_SLEEP_CAPABILITY, RunStatus } from '@orbit/shared';
import { Client } from 'pg';

import { sha256 } from '../common/crypto.util';
import { publicIdHeaders } from '../common/public-id-headers';
import { PublicIdExceptionFilter } from '../common/public-id.filter';
import { PublicIdInterceptor } from '../common/public-id.interceptor';
import { RunnerLinkErrorFilter } from '../common/runner-link-error.filter';
import { TransientDbConflictFilter } from '../common/transient-db-conflict.filter';
import { freshInstanceReport } from '../managed-runners/managed-runner-sleep';
import { managedRunnerStatus } from '../managed-runners/managed-runner-status';
import { readFleetGauges, RECONCILE_STALE_AFTER_MS } from '../metrics/fleet-metrics';
import { OwnerSecretsService } from '../owner-requests/owner-secrets.service';
import { prismaClientFor } from '../prisma/prisma-client';
import { PrismaService } from '../prisma/prisma.service';
import { AttemptBudgetMeterService } from '../projects/attempt-budget-meter.service';
import { assertCoordinatorPgUrlIsIsolated, verifyCoordinatorPgIdentity } from '../projects/coordinator-pg-test-safety';
import { ProjectAcceptanceService } from '../projects/project-acceptance.service';
import { ProjectFuseService } from '../projects/project-fuse.service';
import { PushService } from '../push/push.service';
import { QueueService } from '../queue/queue.service';
import { RealtimeService } from '../realtime/realtime.service';
import { ReaperService, RUNNER_REAP_AFTER_MS } from '../realtime/reaper.service';
import { RunnerApiController } from '../runner-api/runner-api.controller';
import { RunnerAuthGuard } from '../runner-api/runner-auth.guard';
import { listenForRunnerLinkCalls } from '../runner-api/runner-link-call';
import { RunnerLinkEventsController, RunnerLinkGatewayCallGuard } from '../runner-api/runner-link-events.controller';
import { readRunnerLink, RUNNER_LINK, runnerLinkCredential, signRunnerLinkToken, type RunnerLinkState } from '../runner-api/runner-link-token';
import { RunnerLinkWelcomeController } from '../runner-api/runner-link-welcome.controller';
import { RunnerOrchestrationAuthorizer } from '../runner-api/runner-orchestration-authorizer';
import { chooseSubagentWorkspace } from '../runner-api/subagent-remote';
import { MergeReceiptService } from '../sessions/merge-receipt.service';
import { SessionsService } from '../sessions/sessions.service';
import { ListEventsService } from '../task-lists/list-events.service';
import { ReferenceExpansionService } from '../tasks/reference-expansion';
import { TasksService } from '../tasks/tasks.service';
import { readWikiRepoReadiness } from '../wiki-worker/wiki-repo-ops';
import { AGENT_FIX_RUNNER_SELECT, agentFixesOf } from './attention-fix';
import {
  RUNNER_BEATS,
  RUNNER_HEARD_CAP_MS,
  RUNNER_OFFLINE_AFTER_MS,
  RunnerPresenceService,
  runnerBeatIsOnline,
  runnerIsOnline,
  runnerLastBeatAt,
  runnerOfflineSql,
  runnerPresenceSql,
  runnerPresentAt,
} from './runner-presence';
import '../test-support/daemon-routes-over-http';
import { withWord, WORD_SELECT } from '../test-support/session-word';

declare global {
  interface BigInt { toJSON(): string; }
}
BigInt.prototype.toJSON = function toJSON(this: bigint): string {
  return this.toString();
};

const PG_URL = process.env.COORDINATOR_PG_URL;
const GATEWAY_TOKEN = `the-link-gateway-secret:${randomUUID()}`;
const SECOND = 1_000;
const MINUTE = 60_000;

interface Answer {
  status: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  body: any;
}

/** One request on a connection of its own. */
function send(port: number, method: string, pathname: string, headers: Record<string, string>, body?: unknown): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    const req = httpRequest(
      {
        host: '127.0.0.1', port, method, path: pathname, agent: false,
        headers: { ...(payload ? { 'content-type': 'application/json', 'content-length': String(payload.length) } : {}), ...headers },
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

/** The runner door as main.ts builds it, with the gateway's internal listener beside it. */
async function bootDoor(db: PrismaClient, link: RunnerLinkState, realtime: RealtimeService) {
  const queue = new QueueService(db as unknown as PrismaService, realtime);
  const sessions = new SessionsService(db as unknown as PrismaService, queue, realtime);
  const push = { scheduleBadgeSync: () => undefined, notifySessionSettled: async () => undefined, notifyEngineSignedOut: async () => undefined };
  @Module({
    controllers: [RunnerApiController, RunnerLinkWelcomeController, RunnerLinkEventsController],
    providers: [
      { provide: PrismaService, useValue: db },
      { provide: QueueService, useValue: queue },
      { provide: SessionsService, useValue: sessions },
      { provide: RealtimeService, useValue: realtime },
      { provide: PushService, useValue: push },
      { provide: RunnerOrchestrationAuthorizer, useValue: { issue: async () => 'credential' } },
      { provide: ReferenceExpansionService, useValue: { expand: async (_owner: string, content?: string) => content } },
      { provide: ListEventsService, useValue: { appendFor: async (_tx: unknown, _id: string, content?: string) => content } },
      { provide: AttemptBudgetMeterService, useValue: { meterQuietly: async () => undefined } },
      { provide: ProjectAcceptanceService, useValue: {} },
      { provide: ProjectFuseService, useValue: { afterCoordinatorSpend: async () => undefined } },
      { provide: TasksService, useValue: {} },
      { provide: MergeReceiptService, useValue: {} },
      { provide: RUNNER_LINK, useValue: link },
      RunnerAuthGuard,
      RunnerLinkGatewayCallGuard,
    ],
  })
  class RunnerDoor {}

  const app: INestApplication = await NestFactory.create(RunnerDoor, { logger: false, abortOnError: false });
  app.use(publicIdHeaders);
  app.setGlobalPrefix('api');
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: false }));
  app.useGlobalInterceptors(new PublicIdInterceptor());
  const httpAdapter = app.get(HttpAdapterHost).httpAdapter;
  app.useGlobalFilters(
    new TransientDbConflictFilter(new RunnerLinkErrorFilter(new PublicIdExceptionFilter(httpAdapter), httpAdapter), httpAdapter),
  );
  await app.listen(0, '127.0.0.1');
  const doorUrl = await app.getUrl();
  const problems: string[] = [];
  const linkServer = await listenForRunnerLinkCalls(
    app,
    { port: '0', host: '127.0.0.1' },
    { log: () => undefined, error: (message: string) => problems.push(message) },
  );
  assert.ok(linkServer, `the internal listener did not open: ${problems.join('; ')}`);
  return {
    httpsPort: Number(doorUrl.slice(doorUrl.lastIndexOf(':') + 1)),
    linkPort: (linkServer.address() as AddressInfo).port,
    close: async () => {
      linkServer.closeAllConnections();
      await new Promise<void>((resolve) => linkServer.close(() => resolve()));
      await app.close();
    },
  };
}

test('a link Welcome counts as presence, capped five minutes past the last heartbeat; events and RPCs do not', {
  skip: !PG_URL,
  concurrency: 1,
  timeout: 600_000,
}, async (t) => {
  const url = PG_URL!;
  assertCoordinatorPgUrlIsIsolated(url);
  process.env.DATABASE_URL = url;
  const sql = new Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
  await sql.connect();
  await verifyCoordinatorPgIdentity(sql);
  const db: PrismaClient = prismaClientFor(url);
  const prisma = db as unknown as PrismaService;

  const { privateKey } = generateKeyPairSync('ed25519');
  const link = readRunnerLink({
    signingKey: Buffer.from(privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), 'utf8').toString('base64'),
    linkUrl: 'wss://link.runner-heard.invalid',
    gatewayToken: GATEWAY_TOKEN,
  });
  assert.ok(link.config, `the test link did not configure: ${link.problems.join('; ')}`);
  const config = link.config;
  const realtime = new RealtimeService(prisma, { scheduleBadgeSync: () => undefined, notifySessionSettled: async () => undefined } as unknown as PushService);
  const door = await bootDoor(db, link, realtime);
  t.after(async () => {
    await door.close().catch(() => undefined);
    realtime.onModuleDestroy();
    await db.$disconnect().catch(() => undefined);
    await sql.end().catch(() => undefined);
  });

  assert.equal(await db.runner.count(), 0, 'the cell starts empty: every runner the readings below count is this run\'s');
  const ownerId = randomUUID();
  await db.user.create({ data: { id: ownerId, email: `runner-heard-${ownerId}@runner-door.invalid`, name: 'heard', passwordHash: 'x' } });

  interface Machine {
    name: string;
    id: string;
    runnerToken: string;
    credential: string;
    /** The runner process: Hello.process_id, the heartbeat's leaseOwner, the link token's. */
    process: string;
    token: string;
    workspaceId: string;
  }
  const mint = (m: Pick<Machine, 'id' | 'credential'>, process: string, at = new Date(Date.now() - 20 * MINUTE)) =>
    signRunnerLinkToken(config, { runnerId: m.id, ownerId, cellId: 'cell-1', leaseOwner: process, credential: m.credential }, at).token;
  let made = 0;
  async function machine(label: string, data: Partial<Prisma.RunnerUncheckedCreateInput> = {}): Promise<Machine> {
    made += 1;
    const id = randomUUID();
    const runnerToken = `${label}:${randomUUID()}`;
    const credential = runnerLinkCredential(sha256(runnerToken));
    // Its own record of beats an hour old: what it is heard by is its presence row.
    await db.runner.create({
      data: {
        id, ownerId, name: `${label}-${made}`, tokenHash: sha256(runnerToken), status: 'ONLINE', maxConcurrent: 4,
        lastHeartbeatAt: new Date(Date.now() - 60 * MINUTE), ...data,
      },
    });
    const workspaceId = randomUUID();
    await db.workspace.create({
      data: { id: workspaceId, ownerId, runnerId: id, name: `${label}-${made}`, enabled: true, workDir: `/work/${label}-${made}`, workDirIsGit: true, subagentsEnabled: true },
    });
    const process = randomUUID();
    const m = { name: `${label}-${made}`, id, runnerToken, credential, process, token: '', workspaceId };
    m.token = mint(m, process);
    return m;
  }
  const viaLink = (token: string, extra: Record<string, string> = {}) => ({
    authorization: `Bearer ${GATEWAY_TOKEN}`,
    'x-orbit-runner-link-token': token,
    'x-orbit-link-gateway-id': 'gw-a',
    ...extra,
  });
  async function linkBeat(m: Machine, token = m.token) {
    const answer = await send(door.linkPort, 'POST', '/api/runner/heartbeat', viaLink(token),
      { status: 'ONLINE', idleCapacity: 1, leaseOwner: m.process, supervisedSessionIds: [] });
    assert.equal(answer.status, 201, `${m.name}'s link heartbeat: ${JSON.stringify(answer.body)}`);
  }
  async function rpc(m: Machine, token = m.token) {
    const answer = await send(door.linkPort, 'GET', '/api/runner/me', viaLink(token, { 'x-orbit-link-request-id': `rpc-${randomUUID()}` }));
    assert.equal(answer.status, 200, `${m.name}'s RPC: ${JSON.stringify(answer.body)}`);
    return answer.body as { online: boolean; lastHeartbeatAt: string | null };
  }
  async function welcome(m: Machine, token = m.token) {
    const answer = await send(door.linkPort, 'POST', '/api/runner/link/welcome', viaLink(token), { sessionIds: [] });
    assert.equal(answer.status, 200, `${m.name}'s welcome: ${JSON.stringify(answer.body)}`);
  }
  /** `orbit status` over HTTPS, with the runner's own token: the same handler, and no heard. */
  async function status(m: Machine) {
    const answer = await send(door.httpsPort, 'GET', '/api/runner/me', { authorization: `Bearer ${m.runnerToken}` });
    assert.equal(answer.status, 200, `${m.name}'s status: ${JSON.stringify(answer.body)}`);
    return answer.body as { online: boolean; lastHeartbeatAt: string | null };
  }
  /** A session the machine's process runs, its inbox leased to that process. */
  async function liveSession(m: Machine): Promise<{ sessionId: string; turnId: string }> {
    const sessionId = randomUUID();
    const turnId = randomUUID();
    const generation = randomUUID();
    await db.session.create({
      data: {
        id: sessionId, ownerId, creatorId: ownerId, workspaceId: m.workspaceId, assignedRunnerId: m.id, title: 'heard', prompt: 'heard',
        provider: 'claude', providerBuiltin: true, turnState: 'IN_FLIGHT', dispatchOrigin: 'USER', startsTaskWork: false,
        startedAt: new Date(), inboxLeaseOwner: m.process, inboxLeaseGeneration: generation,
      },
    });
    await db.inboxLeaseGeneration.create({ data: { generation, sessionId, leaseOwner: m.process } });
    await db.conversationTurn.create({
      data: { id: turnId, sessionId, seq: 1, clientTurnId: randomUUID(), kind: 'message', content: 'the words', status: 'IN_FLIGHT' },
    });
    return { sessionId, turnId };
  }
  const event = (seq: number, turnId: string) => ({ seq, type: 'assistant_text', ts: new Date().toISOString(), turnId, payload: { text: `event ${seq}` } });

  const row = (m: Machine) => db.runnerPresence.findUnique({ where: { runnerId: m.id } });
  const heardOf = async (m: Machine) => (await row(m))?.lastHeardAt?.getTime() ?? null;
  const dbNow = async () => (await db.$queryRaw<Array<{ now: Date }>>`SELECT (now() AT TIME ZONE 'UTC')::timestamp(3) AS now`)[0]!.now.getTime();
  /** Set the presence row's instants, each `ago` ms before Postgres' now (null: NULL; undefined: as it is). */
  async function place(m: Machine, at: { beat?: number; heard?: number | null; lost?: number | null; reconciled?: number | null; linkState?: string }) {
    const instant = (ago: number | null | undefined, column: string) => ago === undefined
      ? Prisma.raw(`"${column}"`)
      : ago === null ? Prisma.sql`NULL` : Prisma.sql`(now() AT TIME ZONE 'UTC') - (${ago} * interval '1 millisecond')`;
    await db.$executeRaw`
      UPDATE "runner_presence" SET "last_beat_at" = ${instant(at.beat, 'last_beat_at')}, "last_heard_at" = ${instant(at.heard, 'last_heard_at')},
             "lost_at" = ${instant(at.lost, 'lost_at')}, "reconciled_at" = ${instant(at.reconciled, 'reconciled_at')},
             "link_state" = COALESCE(${at.linkState ?? null}::text, "link_state")
       WHERE "runner_id" = ${m.id}::uuid`;
  }
  /** A presence row for this machine's process over the link, as its first link beat writes one. */
  async function linked(label: string, at: Parameters<typeof place>[1] = {}) {
    const m = await machine(label);
    await linkBeat(m);
    // That first beat also rewrote the runner's own record (an hour old, so due): set it back, so what each case reads
    // is the presence row it places.
    await db.runner.update({ where: { id: m.id }, data: { lastHeartbeatAt: new Date(Date.now() - 60 * MINUTE) } });
    await place(m, at);
    return m;
  }

  await t.test('(1) a Welcome writes last_heard_at on the calling process\'s LINK row only, renewals included, never a new row; nothing else does', async () => {
    const a = await linked('heard');
    assert.equal(await heardOf(a), null, 'a link beat is no heard write');
    const OLD = 10 * MINUTE;

    // The Welcome: on Postgres' clock.
    const before = await dbNow();
    await welcome(a);
    const heard = await heardOf(a);
    assert.ok(heard !== null && heard >= before - SECOND && heard <= (await dbNow()) + SECOND, `a Welcome is heard now: ${heard} vs ${before}`);
    // Sent again at once: written again, nothing throttles it.
    await place(a, { heard: OLD });
    await welcome(a);
    assert.ok((await heardOf(a))! > Date.now() - MINUTE, 'a Welcome sent again is heard');
    // A renewal: a token minted now, by the process heard moments ago.
    await place(a, { heard: 5 * SECOND, lost: null });
    const renewing = await dbNow();
    await welcome(a, mint(a, a.process, new Date()));
    const renewed = (await row(a))!;
    assert.ok(renewed.lastHeardAt!.getTime() >= renewing - SECOND, 'a renewal is heard');
    assert.equal(renewed.lostAt, null, 'and keeps no loss');

    // Nothing else the link carries writes it: an event batch sent alone, the merged event call, an RPC, a heartbeat,
    // nor an HTTPS call of the same handler.
    await place(a, { heard: OLD });
    const placed = await heardOf(a);
    const s = await liveSession(a);
    const alone = await send(door.linkPort, 'POST', `/api/runner/sessions/${s.sessionId}/events`, viaLink(a.token),
      { leaseOwner: a.process, events: [event(1, s.turnId)] });
    assert.ok(alone.status >= 200 && alone.status < 300, `the batch: ${alone.status} ${JSON.stringify(alone.body)}`);
    assert.equal(await heardOf(a), placed, 'an event batch is not heard');
    const merged = await send(door.linkPort, 'POST', '/api/runner/link/events', { authorization: `Bearer ${GATEWAY_TOKEN}` }, {
      connections: [{ linkToken: a.token, headers: {} }],
      batches: [{ connection: 0, sessionId: s.sessionId, events: [event(2, s.turnId)] }],
    });
    assert.equal(merged.status, 200, JSON.stringify(merged.body));
    assert.equal(await db.runEvent.count({ where: { sessionId: s.sessionId } }) >= 2, true, 'both batches were stored');
    assert.equal(await heardOf(a), placed, 'a merged event call is not heard');
    await rpc(a);
    assert.equal(await heardOf(a), placed, 'an RPC is not heard');
    await linkBeat(a);
    assert.equal(await heardOf(a), placed, 'a heartbeat leaves last_heard_at as it is');
    await status(a);
    assert.equal(await heardOf(a), placed, 'an HTTPS call is not the link');

    // Another process of the same runner: its Welcome refreshes nothing of this one's presence.
    await welcome(a, mint(a, randomUUID()));
    assert.equal(await heardOf(a), placed, 'another process never refreshes this one\'s presence');

    // An HTTPS runner's row is not the link's.
    const https = await machine('https');
    const beat = await send(door.httpsPort, 'POST', '/api/runner/heartbeat', { authorization: `Bearer ${https.runnerToken}` },
      { status: 'ONLINE', idleCapacity: 1, leaseOwner: https.process });
    assert.equal(beat.status, 201, JSON.stringify(beat.body));
    assert.equal((await row(https))?.linkState, 'HTTP');
    await welcome(https);
    assert.equal(await heardOf(https), null, 'an HTTP row is not written');

    // A runner with no presence row: nothing is made.
    const rowless = await machine('rowless');
    await welcome(rowless);
    await rpc(rowless);
    assert.equal(await row(rowless), null, 'no row is created');
  });

  await t.test('(1b) events flowing on one stable connection with no beat: offline 90 s after the last beat or Welcome, as today', async () => {
    const m = await linked('stable');
    const s = await liveSession(m);
    let seq = 0;
    /** The engine still writing events and the runner asking things, on the connection it has had all along. */
    const talk = async () => {
      seq += 1;
      const batch = await send(door.linkPort, 'POST', `/api/runner/sessions/${s.sessionId}/events`, viaLink(m.token),
        { leaseOwner: m.process, events: [event(seq, s.turnId)] });
      assert.ok(batch.status >= 200 && batch.status < 300, `batch ${seq}: ${batch.status} ${JSON.stringify(batch.body)}`);
      await rpc(m);
    };
    for (const [beatAgo, welcomeAgo, online, label] of [
      [80 * SECOND, 20 * MINUTE, true, 'beat 80 s ago'],
      [100 * SECOND, 20 * MINUTE, false, 'beat 100 s ago, connected 20 min ago'],
      [100 * SECOND, 60 * SECOND, true, 'beat 100 s ago, Welcome 60 s ago'],
      [100 * SECOND, 95 * SECOND, false, 'beat 100 s ago, Welcome 95 s ago'],
    ] as const) {
      await place(m, { beat: beatAgo, heard: welcomeAgo });
      const heardBefore = await heardOf(m);
      await talk();
      assert.equal(await heardOf(m), heardBefore, `${label}: its events and calls leave last_heard_at as it was`);
      const { runner, bySql } = await readings(m);
      assert.equal(bySql.online, online, `${label}: runnerOfflineSql`);
      assert.equal(runnerIsOnline(runner, bySql.now.getTime()), online, `${label}: runnerIsOnline`);
      assert.equal((await status(m)).online, online, `${label}: orbit status`);
    }
  });

  /** A runner as each reader reads it: by Prisma with RUNNER_BEATS, and by SQL on Postgres' clock. */
  async function readings(m: Machine) {
    const runner = await db.runner.findUniqueOrThrow({ where: { id: m.id }, select: { status: true, ...RUNNER_BEATS } });
    const [bySql] = await db.$queryRaw<Array<{ online: boolean; present: Date | null; now: Date }>>(Prisma.sql`
      SELECT NOT ${runnerOfflineSql('r')} AS online, ${runnerPresenceSql('r')} AS present, (now() AT TIME ZONE 'UTC')::timestamp(3) AS now
        FROM "runner" r WHERE r."id" = ${m.id}::uuid`);
    return { runner, bySql: bySql! };
  }

  await t.test('(2) reconnecting with no heartbeat landing: online until the last beat + 5 min, offline by 5 min + 90 s', async () => {
    assert.equal(RUNNER_HEARD_CAP_MS, 5 * MINUTE);
    const m = await linked('cap');
    for (const [beatAgo, online] of [
      [20 * SECOND, true],
      [2 * MINUTE, true],
      [4 * MINUTE, true],
      [5 * MINUTE, true],
      [5 * MINUTE + 60 * SECOND, true],
      [5 * MINUTE + RUNNER_OFFLINE_AFTER_MS - 5 * SECOND, true],
      [5 * MINUTE + RUNNER_OFFLINE_AFTER_MS + 5 * SECOND, false],
      [10 * MINUTE, false],
    ] as const) {
      // Heard a second ago, as a runner whose calls keep arriving is.
      await place(m, { beat: beatAgo, heard: SECOND });
      const { runner, bySql } = await readings(m);
      const label = `last beat ${beatAgo / 1000} s ago, heard 1 s ago`;
      assert.equal(runnerIsOnline(runner, bySql.now.getTime()), online, `JS: ${label}`);
      assert.equal(bySql.online, online, `SQL: ${label}`);
      assert.equal(runnerBeatIsOnline(runner, bySql.now.getTime()), beatAgo <= RUNNER_OFFLINE_AFTER_MS, `beats alone: ${label}`);
      const expected = bySql.now.getTime() - Math.min(beatAgo, Math.max(SECOND, beatAgo - RUNNER_HEARD_CAP_MS));
      assert.ok(Math.abs(runnerPresentAt(runner)!.getTime() - expected) <= 5, `present at: ${label}`);
      assert.equal(bySql.present?.getTime(), runnerPresentAt(runner)?.getTime(), `SQL and JS give one instant: ${label}`);
    }
    // Never heard: its beat alone, not five minutes past it.
    await place(m, { beat: 2 * MINUTE, heard: null });
    const { runner, bySql } = await readings(m);
    assert.equal(bySql.online, false);
    assert.equal(runnerIsOnline(runner, bySql.now.getTime()), false);
    assert.equal(bySql.present?.getTime(), runnerLastBeatAt(runner)?.getTime());
  });

  await t.test('(3) every switched reader agrees with runnerOfflineSql row by row; the kept managed-runner readers read the beat alone', async () => {
    const cases: Array<{ label: string; beat: number; heard: number | null; status?: 'OFFLINE' }> = [
      { label: 'beating', beat: 20 * SECOND, heard: null },
      { label: 'heard only, beat 3 min ago', beat: 3 * MINUTE, heard: 2 * SECOND },
      { label: 'heard only, beat 6 min ago', beat: 6 * MINUTE, heard: 2 * SECOND },
      { label: 'heard, beat past the cap', beat: 10 * MINUTE, heard: 2 * SECOND },
      { label: 'silent', beat: 3 * MINUTE, heard: null },
      { label: 'heard long ago', beat: 3 * MINUTE, heard: 2 * MINUTE },
      { label: 'signed off, heard', beat: 3 * MINUTE, heard: 2 * SECOND, status: 'OFFLINE' },
    ];
    const machines: Machine[] = [];
    for (const c of cases) {
      const m = await linked(`reader-${c.label.replace(/[^a-z0-9]+/g, '-')}`, { beat: c.beat, heard: c.heard });
      if (c.status) await db.runner.update({ where: { id: m.id }, data: { status: c.status } });
      machines.push(m);
    }
    // The owner's secret grants, one per machine (owner-secrets.service.ts listGrants).
    const askedBy = randomUUID();
    await db.session.create({
      data: {
        id: askedBy, ownerId, creatorId: ownerId, workspaceId: machines[0]!.workspaceId, assignedRunnerId: machines[0]!.id, title: 'asks',
        prompt: 'asks', provider: 'claude', providerBuiltin: true, turnState: null, dispatchOrigin: 'USER', startsTaskWork: false,
      },
    });
    const grants = new Map<string, string>();
    for (const m of machines) {
      const requestId = randomUUID();
      await db.ownerRequest.create({
        data: {
          id: requestId, ownerId, askedBySessionId: askedBy, kind: 'SECRET', title: `key for ${m.name}`, why: 'presence', state: 'DONE',
          resolvedAt: new Date(), secretSpec: { name: 'KEY', runnerId: m.id, envVar: 'KEY' },
        },
      });
      const grantId = randomUUID();
      await db.ownerRequestSecret.create({
        data: {
          id: grantId, ownerId, requestId, runnerId: m.id, sessionId: askedBy, name: 'KEY', exposure: 'ENV', state: 'REMOVING',
          expiresAt: new Date(Date.now() + 24 * 3_600_000), endReason: 'REVOKED',
        },
      });
      grants.set(grantId, m.id);
    }
    const listed = await new OwnerSecretsService(prisma).listGrants(ownerId, false);
    const fixRows = await db.runner.findMany({ where: { id: { in: machines.map((m) => m.id) } }, select: AGENT_FIX_RUNNER_SELECT });
    const fixes = await agentFixesOf(db, ownerId, fixRows);

    let expectedOnline = 0;
    for (const [i, m] of machines.entries()) {
      const c = cases[i]!;
      const { runner, bySql } = await readings(m);
      const nowMs = bySql.now.getTime();
      const online = bySql.online;
      if (online) expectedOnline += 1;
      const label = c.label;
      // The JS reading, as every Prisma reader asks it.
      assert.equal(runnerIsOnline(runner, nowMs), online, `runnerIsOnline: ${label}`);
      assert.equal(runnerPresentAt(runner)?.getTime(), bySql.present?.getTime(), `runnerPresentAt = runnerPresenceSql: ${label}`);
      // `orbit status` (runner-api.controller.ts, its hand-written presence read), over HTTPS so no call is heard.
      const me = await status(m);
      assert.equal(me.online, online, `orbit status: ${label}`);
      assert.equal(Date.parse(me.lastHeartbeatAt!), bySql.present?.getTime(), `orbit status shows when it was present: ${label}`);
      // The agent-fix rule (attention-fix.ts, AGENT_FIX_RUNNER_SELECT).
      assert.equal(fixes.get(m.id)?.blocked?.code === 'offline', !online, `agent fix: ${label}`);
      // The SubAgent workspace choice (subagent-remote.ts, CANDIDATE_SELECT).
      const choice = await chooseSubagentWorkspace(db, { ownerId, parentWorkspaceId: null, workspace: m.name })
        .then((pick) => pick.kind, (error: { response?: { code?: string } }) => error.response?.code ?? String(error));
      assert.equal(choice, online ? 'remote' : 'SUBAGENT_WORKSPACE_OFFLINE', `SubAgent choice: ${label}`);
      // The wiki repository's readiness (wiki-repo-ops.ts), which has never read the runner's status: by presence alone.
      const wiki = await readWikiRepoReadiness(prisma, { ownerId, spaceId: randomUUID(), workspaceId: m.workspaceId, now: new Date(nowMs) });
      const presentWithin = !!bySql.present && nowMs - bySql.present.getTime() < RUNNER_OFFLINE_AFTER_MS;
      assert.equal(wiki.runner?.online, c.status === 'OFFLINE' ? presentWithin : online, `wiki readiness: ${label}`);
      // The owner's secret grants (owner-secrets.service.ts, runnerPresenceSql).
      const grant = listed.grants.find((g) => grants.get(g.id) === m.id)!;
      assert.equal(grant.runner.online, online, `secret grants: ${label}`);
      assert.equal(new Date(grant.runner.lastHeartbeatAt!).getTime(), bySql.present?.getTime(), `secret grants' last seen: ${label}`);
    }
    assert.equal(expectedOnline, 3, 'beating, and heard with its beat 3 and 6 min old: online; the rest offline');
    // The fleet gauges count every runner of the database, all of them this run's, by the same rule.
    const [all] = await db.$queryRaw<Array<{ online: number }>>(Prisma.sql`
      SELECT count(*) FILTER (WHERE NOT ${runnerOfflineSql('r')})::int AS online FROM "runner" r`);
    const gauges = await readFleetGauges(db);
    assert.equal(gauges.runners.online + gauges.runners.draining, all!.online, 'orbit_runners online + draining = not runnerOfflineSql');

    // Kept: what the managed-runner manager reads of a runner it supervises is its beat, not its heard.
    const heardOnly = machines[1]!;
    const beats = await db.runner.findUniqueOrThrow({
      where: { id: heardOnly.id },
      select: { status: true, version: true, capabilities: true, managedWorkload: true, ...RUNNER_BEATS },
    });
    const now = new Date();
    assert.equal(runnerIsOnline(beats, now.getTime()), true, 'it is present');
    assert.equal(runnerLastBeatAt(beats)?.getTime(), beats.presence?.lastBeatAt.getTime(), 'runnerLastBeatAt is the beat');
    assert.ok(now.getTime() - runnerLastBeatAt(beats)!.getTime() > 2 * MINUTE);
    // freshInstanceReport (managed-runner-manager.ts:1099, managed-runner.service.ts:383): a report is believed only
    // as fresh as the beat that carried it.
    const report = { generation: 1, podUid: 'pod', receivedAt: now.toISOString(), draining: false, activeTurns: 0, backgroundJobs: 0, operations: 0, unflushedEvents: 0, idleSeconds: 60 };
    const sleeper = { capabilities: [MANAGED_RUNNER_SLEEP_CAPABILITY], managedWorkload: report };
    assert.equal(freshInstanceReport(sleeper, runnerLastBeatAt(beats), { generation: 1, podUid: 'pod' }, now, 90_000), null,
      'heard is no fresh telemetry');
    assert.notEqual(freshInstanceReport(sleeper, runnerPresentAt(beats), { generation: 1, podUid: 'pod' }, now, 90_000), null,
      'the same report, believed were it read by presence: the beat is the only difference');
    // managedRunnerStatus (managed-runner-status.ts:168): usable and last heartbeat by the beat.
    const mappingId = randomUUID();
    const mapping = await db.managedRunner.create({
      data: {
        id: mappingId, ownerId, runnerId: heardOnly.id, clusterKey: 'heard-spec', namespace: 'orbit', pvcName: `mr-data-${heardOnly.id}`,
        desiredState: 'RUNNING', managementState: 'READY',
      },
    });
    const managed = managedRunnerStatus({ enabled: true, available: true, mapping, runner: beats as never, now, heartbeatFreshMs: 90_000 });
    assert.equal(managed.lastHeartbeatAt, beats.presence!.lastBeatAt.toISOString(), 'its status shows the beat');
    assert.equal(managed.usable, false, 'and is not usable on a heard alone');
    await db.managedRunner.delete({ where: { id: mappingId } });
    // The Codex reset's admission (codex-rate-limit-reset.service.ts) is handed out in a heartbeat's answer: beats only.
    assert.equal(runnerBeatIsOnline(beats, now.getTime()), false, 'the Codex reset reads it offline');
  });

  await t.test('(4) both lost_at writers use the later of the beat and the heard; the welcome writes heard on a renewal', async () => {
    // The link beat. Heard 5 s ago through a 60 s beat gap: nothing lost.
    const beatGap = await linked('lost-beat', { beat: 60 * SECOND, heard: 5 * SECOND, lost: null });
    await linkBeat(beatGap);
    assert.equal((await row(beatGap))?.lostAt, null, 'a runner heard through its beat gap lost nothing');
    // Heard 50 s ago, its beat 60 s ago: lost at the heard, the later of the two.
    await place(beatGap, { beat: 60 * SECOND, heard: 50 * SECOND, lost: null });
    const heard50 = await heardOf(beatGap);
    await linkBeat(beatGap);
    assert.equal((await row(beatGap))?.lostAt?.getTime(), heard50, 'kept at GREATEST(beat, heard)');
    // Never heard: at the beat, as before.
    await place(beatGap, { beat: 60 * SECOND, heard: null, lost: null });
    const beat60 = (await row(beatGap))!.lastBeatAt.getTime();
    await linkBeat(beatGap);
    assert.equal((await row(beatGap))?.lostAt?.getTime(), beat60);

    // The welcome. A reconnection after a drop, with the token it holds: kept at GREATEST(beat, heard), heard now.
    const w = await linked('lost-welcome', { beat: 60 * SECOND, heard: 5 * SECOND, lost: null });
    const heard5 = await heardOf(w);
    const before = await dbNow();
    await welcome(w);
    const reconnected = (await row(w))!;
    assert.equal(reconnected.lostAt?.getTime(), heard5, 'the reconnection keeps the last instant it was heard');
    assert.ok(reconnected.lastHeardAt!.getTime() >= before - SECOND, 'and the welcome is heard now');
    // Sent again (lost_at unchanged before, which the old statement wrote nothing for): heard is written again.
    await place(w, { heard: 30 * SECOND });
    const sentAgain = await dbNow();
    await welcome(w);
    assert.ok((await row(w))!.lastHeardAt!.getTime() >= sentAgain - SECOND, 'a welcome sent again is heard');
    // A renewal: the process heard 5 s ago — its beat 60 s ago, which alone would not pass — opens a connection with
    // a token minted now. No loss is kept, and the welcome is heard.
    await place(w, { beat: 60 * SECOND, heard: 5 * SECOND, lost: null });
    const renewing = await dbNow();
    await welcome(w, mint(w, w.process, new Date()));
    const renewed = (await row(w))!;
    assert.equal(renewed.lostAt, null, 'a renewal keeps no loss: the process was heard within 45 s');
    assert.ok(renewed.lastHeardAt!.getTime() >= renewing - SECOND, 'and writes last_heard_at');
    // Another process connecting: its predecessor's loss is kept, and nothing of the new one is heard.
    await place(w, { beat: 60 * SECOND, heard: 5 * SECOND, lost: null });
    const heardBefore = await heardOf(w);
    await welcome(w, mint(w, randomUUID(), new Date()));
    const taken = (await row(w))!;
    assert.equal(taken.lostAt?.getTime(), heardBefore, 'a new process: the old one\'s loss is kept');
    assert.equal(taken.lastHeardAt?.getTime(), heardBefore, 'and the new one is not heard by it');
  });

  // The readings below count the whole cell: only their own runners stay in it.
  async function emptyCell() {
    await db.ownerRequestSecret.deleteMany({ where: { ownerId } });
    await db.ownerRequest.deleteMany({ where: { ownerId } });
    await db.session.deleteMany({ where: { ownerId } });
    await db.runner.deleteMany({ where: { ownerId } });
    assert.equal(await db.runner.count(), 0);
  }

  await t.test('(5) cellLosses does not count a runner that sent a Welcome within 45 s as silent', async () => {
    await emptyCell();
    const presence = new RunnerPresenceService(prisma);
    const reconnected = await linked('cell-welcome', { beat: 60 * SECOND, heard: null });
    await welcome(reconnected);
    const talking = await linked('cell-talking', { beat: 60 * SECOND, heard: null });
    const s = await liveSession(talking);
    await send(door.linkPort, 'POST', `/api/runner/sessions/${s.sessionId}/events`, viaLink(talking.token),
      { leaseOwner: talking.process, events: [event(1, s.turnId)] });
    const cell = await presence.cellLosses(10 * MINUTE);
    assert.equal(cell.heard, 2, 'both heard from within the window');
    assert.equal(cell.silent, 1, 'only the one whose last beat and Welcome are 60 s old is past the 45 s line, its events notwithstanding');
  });

  await t.test('(6) the reaper keeps the run of a runner heard 30 s ago and reaps one past the cap', async () => {
    await emptyCell();
    const presence = new RunnerPresenceService(prisma);
    const reaperRealtime = {
      requestCancel: () => undefined, publish: () => undefined, publishTaskChanged: () => undefined, publishQueuedTurnsChanged: () => undefined,
    } as never;
    const run = async (m: Machine) => {
      const id = randomUUID();
      await db.session.create({
        data: {
          id, ownerId, creatorId: ownerId, workspaceId: m.workspaceId, assignedRunnerId: m.id, title: `run on ${m.name}`, prompt: 'work',
          provider: 'claude', providerBuiltin: true, turnState: 'IN_FLIGHT', runtimeSessionId: randomUUID(),
          startedAt: new Date(Date.now() - 30 * MINUTE), runClaimedAt: new Date(Date.now() - 30 * MINUTE), dispatchOrigin: SessionDispatchOrigin.USER,
        },
      });
      return id;
    };
    // A quiet cell around them, beating on time, so no mass disconnection holds anything.
    for (let i = 0; i < 12; i += 1) await linked(`reap-beating-${i}`, { beat: 5 * SECOND });
    // Its last beat 5.5 min ago, past RUNNER_REAP_AFTER_MS, but heard: present 30 s ago (the cap), not silent past 45 s.
    const heard = await linked('reap-heard', { beat: 5 * MINUTE + 30 * SECOND, heard: SECOND });
    // Its last beat 11 min ago: present 6 min ago however lately it was heard.
    const capped = await linked('reap-capped', { beat: 11 * MINUTE, heard: SECOND });
    // Its last beat 5.5 min ago on the one connection it has had for 20 min, its engine still writing events: reaped on
    // today's schedule, its events notwithstanding.
    const stable = await linked('reap-stable', { beat: 5 * MINUTE + 30 * SECOND, heard: 20 * MINUTE });
    const talking = await liveSession(stable);
    for (const seq of [1, 2]) {
      const batch = await send(door.linkPort, 'POST', `/api/runner/sessions/${talking.sessionId}/events`, viaLink(stable.token),
        { leaseOwner: stable.process, events: [event(seq, talking.turnId)] });
      assert.ok(batch.status >= 200 && batch.status < 300, `stable runner's batch ${seq}: ${batch.status}`);
    }
    const kept = await run(heard);
    const reaped = await run(capped);
    const reapedStable = await run(stable);
    assert.ok(5 * MINUTE + 30 * SECOND > RUNNER_REAP_AFTER_MS);
    await (new ReaperService(prisma, reaperRealtime, undefined, presence) as unknown as { sweep(): Promise<void> }).sweep();
    const stateOf = async (id: string) => withWord(await db.session.findUniqueOrThrow({ where: { id }, select: { ...WORD_SELECT, error: true } }));
    assert.deepEqual(await stateOf(kept), { status: RunStatus.RUNNING, error: null }, 'heard: its run is not reaped');
    assert.deepEqual(await stateOf(reaped), { status: RunStatus.FAILED, error: 'runner offline' }, 'past the cap: reaped');
    assert.deepEqual(await stateOf(reapedStable), { status: RunStatus.FAILED, error: 'runner offline' },
      'events on a stable connection keep nothing: reaped 5 min after its last beat, as today');
  });

  await t.test('(7) orbit_runner_reconcile_stale counts a present link runner whose reconcile is overdue, and never a NULL', async () => {
    await emptyCell();
    const overdue = RECONCILE_STALE_AFTER_MS + MINUTE;
    await linked('stale', { beat: 5 * SECOND, reconciled: overdue });
    await linked('owed', { beat: 5 * SECOND, reconciled: null });
    await linked('fresh', { beat: 5 * SECOND, reconciled: 2 * MINUTE });
    await linked('stale-offline', { beat: 10 * MINUTE, reconciled: overdue });
    await linked('stale-https', { beat: 5 * SECOND, reconciled: overdue, linkState: 'HTTP' });
    const gauges = await readFleetGauges(db);
    assert.equal(gauges.reconcileStale, 1, 'only the present link runner reconciled more than 5 min + a missed beat ago');
    assert.equal(gauges.runners.online, 4);
    assert.equal(gauges.runners.silent, 1);
  });
});
