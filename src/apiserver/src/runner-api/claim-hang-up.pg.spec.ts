/**
 * A claim whose runner hung up claims nothing.
 *
 * WHAT THIS DRIVES
 * ----------------
 * The 2026-10-03 incident, at the control plane's own HTTP door: a runner re-executed into a
 * self-update with a `GET /runner/sessions/claim` still open, the new process came up, and a task's
 * session queued 4s later was claimed by the call the old process had abandoned — PENDING -> RUNNING,
 * answered to a closed connection. No process took it over, and it read "Starting" until an
 * unrelated failed claim made the new process reconcile, 15 minutes later.
 *
 * A claim answers at once now, but for one that lost a row lock, which asks again for about 5 s
 * (QueueService.claimSessionForRunner): a runner can still stop while it does.
 *
 * The door is the real `RunnerApiController` behind the real `RunnerAuthGuard` and `QueueService`,
 * over a disposable PostgreSQL. The runner is a plain HTTP client that opens a claim and drops its
 * connection, the way a stopping runner's cancelled request does.
 *
 * WHAT IT ASSERTS
 * ---------------
 *   * (1) a session whose row lock its claim lost is still PENDING once its runner hung up and the
 *     lock came free: the abandoned claim had every chance to ask again;
 *   * (2) that session is claimable: a connected claim takes it at once;
 *   * (3) a connected claim that lost the lock asks again and takes the session once the lock is free,
 *     rather than reading its own open connection as a hang-up.
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/runner-api/claim-hang-up.pg.spec.ts
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';

import { type INestApplication, Module, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { type PrismaClient, RunStatus } from '@prisma/client';
import { Client } from 'pg';

import { sha256 } from '../common/crypto.util';
import { publicIdHeaders } from '../common/public-id-headers';
import { PublicIdInterceptor } from '../common/public-id.interceptor';
import { prismaClientFor } from '../prisma/prisma-client';
import { PrismaService } from '../prisma/prisma.service';
import { AttemptBudgetMeterService } from '../projects/attempt-budget-meter.service';
import { assertCoordinatorPgUrlIsIsolated, verifyCoordinatorPgIdentity } from '../projects/coordinator-pg-test-safety';
import { ProjectAcceptanceService } from '../projects/project-acceptance.service';
import { PushService } from '../push/push.service';
import { QueueService } from '../queue/queue.service';
import { RealtimeService } from '../realtime/realtime.service';
import { MergeReceiptService } from '../sessions/merge-receipt.service';
import { SessionsService } from '../sessions/sessions.service';
import { ListEventsService } from '../task-lists/list-events.service';
import { ReferenceExpansionService } from '../tasks/reference-expansion';
import { TasksService } from '../tasks/tasks.service';
import { RunnerApiController } from './runner-api.controller';
import { RunnerAuthGuard } from './runner-auth.guard';
import { RunnerOrchestrationAuthorizer } from './runner-orchestration-authorizer';
import '../test-support/daemon-routes-over-http';

declare global {
  interface BigInt { toJSON(): string; }
}
// `main.ts` installs this before it creates the app; session rows carry BIGINT columns.
BigInt.prototype.toJSON = function toJSON(this: bigint): string {
  return this.toString();
};

const URL = process.env.COORDINATOR_PG_URL;
const skip = !URL;

const RUNNER_TOKEN = `the-runner-that-hung-up:${randomUUID()}`;

/** A collaborator whose every method answers nothing: the broadcasts a claim fires. */
const silent = (): unknown =>
  new Proxy({}, { get: (_target, key) => (key === 'then' ? undefined : () => undefined) });

test('a claim whose runner hung up claims nothing', {
  skip,
  concurrency: 1,
  timeout: 120_000,
}, async (t) => {
  const url = URL!;
  assertCoordinatorPgUrlIsIsolated(url);
  const sql = new Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
  await sql.connect();
  await verifyCoordinatorPgIdentity(sql);
  const prisma: PrismaClient = prismaClientFor(url);

  const queue = new QueueService(prisma as unknown as PrismaService, silent() as never);
  const realtime = silent();
  const sessions = new SessionsService(prisma as unknown as PrismaService, queue as never, realtime as never);
  @Module({
    controllers: [RunnerApiController],
    providers: [
      { provide: PrismaService, useValue: prisma },
      { provide: QueueService, useValue: queue },
      { provide: SessionsService, useValue: sessions },
      { provide: RealtimeService, useValue: realtime },
      { provide: PushService, useValue: silent() },
      { provide: RunnerOrchestrationAuthorizer, useValue: { issue: async () => 'credential' } },
      { provide: ReferenceExpansionService, useValue: { expand: async (_owner: string, content?: string) => content } },
      { provide: ListEventsService, useValue: { appendFor: async (_tx: unknown, _id: string, content?: string) => content } },
      { provide: AttemptBudgetMeterService, useValue: {} },
      { provide: ProjectAcceptanceService, useValue: {} },
      { provide: TasksService, useValue: {} },
      { provide: MergeReceiptService, useValue: {} },
      RunnerAuthGuard,
    ],
  })
  class RunnerDoor {}

  let app: INestApplication | undefined;
  t.after(async () => {
    await app?.close().catch(() => undefined);
    await prisma.$disconnect().catch(() => undefined);
    await sql.end().catch(() => undefined);
  });

  app = await NestFactory.create(RunnerDoor, { logger: false, abortOnError: false });
  app.use(publicIdHeaders);
  app.setGlobalPrefix('api');
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: false }));
  app.useGlobalInterceptors(new PublicIdInterceptor());
  await app.listen(0, '127.0.0.1');
  const doorUrl = await app.getUrl();
  const port = Number(doorUrl.slice(doorUrl.lastIndexOf(':') + 1));

  // ── the fixture: one machine, and the workspace its sessions are queued on ─────────────────────
  const ownerId = randomUUID();
  const machineId = randomUUID();
  const workspaceId = randomUUID();
  await prisma.user.create({
    data: { id: ownerId, email: `claim-hang-up-${ownerId}@runner-door.invalid`, name: 'The account owner', passwordHash: 'x' },
  });
  await prisma.runner.create({
    data: { id: machineId, ownerId, name: 'the machine that re-executed', tokenHash: sha256(RUNNER_TOKEN), maxConcurrent: 4 },
  });
  await prisma.workspace.create({
    data: {
      id: workspaceId,
      ownerId,
      runnerId: machineId,
      name: 'the checkout these sessions run in',
      enabled: true,
      workDir: mkdtempSync(path.join(tmpdir(), 'claim-hang-up-')),
    },
  });

  /** A session waiting for its first claim, announced the way every enqueue announces one. */
  async function queueSession(title: string): Promise<string> {
    const sessionId = randomUUID();
    await prisma.session.create({
      data: {
        id: sessionId,
        ownerId,
        creatorId: ownerId,
        workspaceId,
        assignedRunnerId: machineId,
        title,
        prompt: title,
        provider: 'claude',
        status: RunStatus.PENDING,
        dispatchOrigin: 'USER',
        startsTaskWork: false,
      },
    });
    await prisma.conversationTurn.create({
      data: { id: randomUUID(), sessionId, seq: 1, clientTurnId: randomUUID(), kind: 'message', content: title, status: 'PENDING' },
    });
    queue.notifySessionQueued(machineId);
    return sessionId;
  }

  /** What the database says about a session, read on a connection the door never used. */
  async function row(sessionId: string): Promise<{ status: string; startedAt: Date | null }> {
    const { rows } = await sql.query<{ status: string; startedAt: Date | null }>(
      'SELECT status, started_at AS "startedAt" FROM "session" WHERE id = $1',
      [sessionId],
    );
    return rows[0];
  }

  /** Open one claim as the runner, on its own connection. */
  function openClaim(): { answer: Promise<{ sessionId?: string } | null>; hangUp: () => void } {
    const req = httpRequest({
      host: '127.0.0.1',
      port,
      method: 'GET',
      path: '/api/runner/sessions/claim',
      agent: false,
      headers: { authorization: `Bearer ${RUNNER_TOKEN}` },
    });
    const answer = new Promise<{ sessionId?: string } | null>((resolve, reject) => {
      req.on('response', (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          if (res.statusCode !== 200) {
            reject(new Error(`claim answered ${res.statusCode}: ${Buffer.concat(chunks).toString('utf8')}`));
            return;
          }
          const body = Buffer.concat(chunks).toString('utf8');
          resolve(body === '' ? null : (JSON.parse(body) as { sessionId?: string } | null));
        });
      });
      req.on('error', reject);
    });
    req.end();
    return { answer, hangUp: () => req.destroy() };
  }

  async function within<T>(ms: number, what: string, promise: Promise<T>): Promise<T> {
    return Promise.race([
      promise,
      sleep(ms).then(() => {
        throw new Error(`${what} did not answer within ${ms}ms`);
      }),
    ]);
  }

  /** Hold a session's row on a connection of its own, as an inbox fetch does: a claim loses its lock to it. */
  async function holdRow(sessionId: string): Promise<() => Promise<void>> {
    const holder = new Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
    await holder.connect();
    await holder.query('BEGIN');
    await holder.query('SELECT id FROM "session" WHERE id = $1 FOR UPDATE', [sessionId]);
    return async () => {
      await holder.query('ROLLBACK');
      await holder.end();
    };
  }

  // ── (1) the runner hangs up while its claim asks again; the session must stay queued ────────
  const queuedAfter = await queueSession('its runner re-executed while the claim asked again');
  let release = await holdRow(queuedAfter);
  const abandoned = openClaim();
  abandoned.answer.catch(() => undefined); // the connection this side destroys
  await sleep(300); // it found the row held: it waits between attempts now
  abandoned.hangUp();
  await sleep(300);
  await release();
  await sleep(1_500); // past the longest wait between attempts
  const untouched = await row(queuedAfter);
  assert.equal(
    untouched.status,
    RunStatus.PENDING,
    'a claim whose runner had hung up claimed the session: RUNNING, and answered to nobody',
  );
  assert.equal(untouched.startedAt, null, 'the abandoned claim stamped a start on a session it never handed over');

  // ── (2) the session is claimable: a connected claim takes it at once ───────────────────────
  const connected = await within(5_000, 'a claim with work already queued', openClaim().answer);
  assert.equal(connected?.sessionId, queuedAfter);
  assert.equal((await row(queuedAfter)).status, RunStatus.RUNNING);

  // ── (3) a connected claim that lost the lock asks again and takes the session ──────────────
  const arrived = await queueSession('its row held while a connected runner asked');
  release = await holdRow(arrived);
  const waiting = openClaim();
  await sleep(300);
  assert.equal((await row(arrived)).status, RunStatus.PENDING, 'the claim took a row another transaction held');
  await release();
  const claimed = await within(5_000, 'a connected claim once the lock came free', waiting.answer);
  assert.equal(claimed?.sessionId, arrived, 'the connected claim ended before it could take the session');
  assert.equal((await row(arrived)).status, RunStatus.RUNNING);
});
