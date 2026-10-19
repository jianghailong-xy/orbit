import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import { ConflictException, NotFoundException } from '@nestjs/common';
import {
  CreatorType,
  PrismaClient,
  RunStatus,
  RunnerStatus,
  SessionDispatchOrigin,
  SessionRunSource,
  TaskStatus,
} from '@prisma/client';
import { Client } from 'pg';

import { INTEGRATION_JOB_CLAIM } from '../projects/project-integration-job';
import { readInFlightJobs } from '../projects/project-integration-line';
import { ensureLandingSession, openTaskLanding } from '../projects/landing-session';
import { assertCoordinatorPgUrlIsIsolated, verifyCoordinatorPgIdentity } from '../projects/coordinator-pg-test-safety';
import { wikiPlanMaterials } from '../wiki/wiki-plan-job';
import { prismaClientFor } from '../prisma/prisma-client';
import { PrismaService } from '../prisma/prisma.service';
import { QueueService } from '../queue/queue.service';
import { RealtimeService } from '../realtime/realtime.service';
import { ReaperService } from '../realtime/reaper.service';
import { IntegrationJobRelay } from '../runner-api/integration-job-relay';
import { RunnerApiController } from '../runner-api/runner-api.controller';
import { RunnerSessionsController } from '../runner-api/runner-sessions.controller';
import { AttachmentsService } from '../attachments/attachments.service';
import { AutoRetryService } from '../sessions/auto-retry.service';
import { MergeReceiptService } from '../sessions/merge-receipt.service';
import { SessionsService } from '../sessions/sessions.service';
import { SessionTagsService } from '../session-tags/session-tags.service';
import { ShareLinksService } from '../share-links/share-links.service';
import { WatchesService } from '../watches/watches.service';
import { WatchEvaluatorService } from '../watches/watch-evaluator.service';
import { ProvidersService } from '../providers/providers.service';
import { agentProviderSeed, lastProviderByWorkspace } from '../workspaces/workspace-provider';
import { taskRouteReads } from '../tasks/task-route-decision';
import {
  ENGINE_SESSION_DOORS,
  ENGINE_SESSION_FIELD_CASES,
} from './engine-session-cases';

/**
 * The engine-path guard and the kind census, against a real PostgreSQL (contract §2.9 LS1, LS6;
 * errata E4).
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/sessions/engine-session-guard.pg.spec.ts
 *
 * What it holds:
 *   • every door in `ENGINE_SESSION_DOORS` — the 33 user routes and 29 runner routes derived from
 *     the tenant-isolation registries — refuses a LANDING session with 409
 *     SESSION_IS_PLATFORM_DRIVEN, and the six body/query field cases do the same;
 *   • Trash is refused (and the row is untouched);
 *   • the queue does not claim a LANDING row and the reaper does not touch one;
 *   • the flat lists, compact list, search and counts exclude LANDING;
 *   • GET /sessions/:id and the orchestration read (MCP `session_get`) return the landing view
 *     whether the row exists, does not yet exist, or its source session was purged, and another
 *     account gets 404;
 *   • only a claimed subject gets a session row, and the compensation points insert it;
 *   • the workspace seed reads and the wiki plan materials read past a LANDING row.
 *
 * Not destructive: every id is generated per case, so nothing outside its own fixtures is read or
 * written, and `scripts/run-pg-spec.sh` destroys the database it ran against.
 */
const URL = process.env.COORDINATOR_PG_URL;
const skip = !URL;

let safety: Promise<void> | undefined;
function verifyDisposableDatabase(): Promise<void> {
  if (safety) return safety;
  safety = (async () => {
    assertCoordinatorPgUrlIsIsolated(URL);
    const client = new Client({ connectionString: URL, connectionTimeoutMillis: 2_000 });
    await client.connect();
    try {
      await verifyCoordinatorPgIdentity(client);
    } finally {
      await client.end();
    }
  })();
  return safety;
}

const noopRealtime = () =>
  new Proxy({}, { get: () => () => undefined }) as unknown as RealtimeService;

interface Stack {
  db: PrismaClient;
  prisma: PrismaService;
  sessions: SessionsService;
  tags: SessionTagsService;
  shares: ShareLinksService;
  attachments: AttachmentsService;
  watches: WatchesService;
  receipts: MergeReceiptService;
  autoRetry: AutoRetryService;
  api: RunnerApiController;
  runnerSessions: RunnerSessionsController;
  queue: QueueService;
  reaper: ReaperService;
  providers: ProvidersService;
}

async function connect(): Promise<Stack> {
  await verifyDisposableDatabase();
  const db = prismaClientFor(URL!);
  const prisma = db as unknown as PrismaService;
  const realtime = noopRealtime();
  const queue = new QueueService(prisma, realtime);
  const sessions = new SessionsService(prisma, queue, realtime);
  const receipts = new MergeReceiptService(prisma);
  const orchestration = {
    assert: async (_runner: unknown, callingSessionId?: string) => callingSessionId ?? randomUUID(),
  } as never;
  const attempts = {
    assertMayEndSession: async () => undefined,
    chargeSteer: async () => undefined,
  } as never;
  const api = new RunnerApiController(
    prisma,
    queue,
    realtime,
    new Proxy({}, { get: () => async () => undefined }) as never,
    orchestration,
    { expand: async (_ownerId: string, content?: string) => content } as never,
    undefined,
    undefined,
    undefined,
    undefined,
    receipts,
    sessions,
    undefined,
    new IntegrationJobRelay(prisma),
  );
  return {
    db,
    prisma,
    sessions,
    tags: new SessionTagsService(prisma, realtime),
    shares: new ShareLinksService(prisma),
    attachments: new AttachmentsService(prisma),
    watches: new WatchesService(prisma, {
      rollout: { mode: 'on', canaryOwners: new Set<string>(), problems: [] },
    } as never),
    receipts,
    autoRetry: new AutoRetryService(prisma, sessions, realtime),
    api,
    runnerSessions: new RunnerSessionsController(sessions, orchestration, receipts, attempts),
    queue,
    reaper: new ReaperService(prisma, realtime),
    providers: new ProvidersService(prisma, realtime, undefined as never),
  };
}

interface World {
  ownerId: string;
  runnerId: string;
  workspaceId: string;
}

async function world(stack: Stack, label: string): Promise<World> {
  const ownerId = randomUUID();
  const runnerId = randomUUID();
  const workspaceId = randomUUID();
  await stack.db.user.create({
    data: { id: ownerId, email: `${label}-${ownerId}@guard.invalid`, name: label, passwordHash: 'x' },
  });
  await stack.db.runner.create({
    data: {
      id: runnerId,
      ownerId,
      name: `${label}-runner`,
      tokenHash: `hash-${runnerId}`,
      status: RunnerStatus.ONLINE,
      capabilities: [INTEGRATION_JOB_CLAIM],
      capabilitiesReportedAt: new Date(),
      lastHeartbeatAt: new Date(),
    },
  });
  await stack.db.workspace.create({
    data: {
      id: workspaceId,
      ownerId,
      runnerId,
      name: `${label}-workspace`,
      enabled: true,
      repoUrl: `https://git.invalid/orbit/${label}`,
      workDir: `/srv/${label}`,
    },
  });
  return { ownerId, runnerId, workspaceId };
}

/** A LANDING session row exactly as `ensureLandingSession` writes it (LS1's table). */
async function landingRow(stack: Stack, w: World, overrides: Record<string, unknown> = {}): Promise<string> {
  const id = randomUUID();
  await stack.db.session.create({
    data: {
      id,
      ownerId: w.ownerId,
      creatorId: w.ownerId,
      workspaceId: w.workspaceId,
      title: 'Land · a task',
      titleManagedByProject: true,
      prompt: 'Orbit runs this landing. This conversation is a record, not an engine.',
      sessionKind: 'LANDING',
      status: RunStatus.AWAITING_INPUT,
      startsTaskWork: false,
      provider: 'orbit',
      providerBuiltin: true,
      engine: null,
      dispatchOrigin: SessionDispatchOrigin.USER,
      runSource: SessionRunSource.MANUAL,
      ...overrides,
    },
  });
  return id;
}

/** An ordinary conversation of the same owner, for doors that must pass what is not the landing. */
async function conversationRow(stack: Stack, w: World, overrides: Record<string, unknown> = {}): Promise<string> {
  const id = randomUUID();
  await stack.db.session.create({
    data: {
      id,
      ownerId: w.ownerId,
      creatorId: w.ownerId,
      workspaceId: w.workspaceId,
      assignedRunnerId: w.runnerId,
      title: 'a conversation',
      prompt: 'hello',
      sessionKind: 'CONVERSATION',
      status: RunStatus.AWAITING_INPUT,
      provider: 'claude',
      providerBuiltin: true,
      engine: 'claude',
      dispatchOrigin: SessionDispatchOrigin.USER,
      runSource: SessionRunSource.MANUAL,
      ...overrides,
    },
  });
  return id;
}

async function expectPlatformDriven(promise: Promise<unknown>, label: string): Promise<void> {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof ConflictException, `${label}: expected 409, got ${(error as Error)?.constructor?.name}: ${(error as Error)?.message}`);
    const body = error.getResponse() as { code?: string; message?: string };
    assert.equal(body.code, 'SESSION_IS_PLATFORM_DRIVEN', label);
    assert.equal(error.getStatus(), 409, label);
    assert.match(String(body.message), /coordinating conversation/, label);
    return true;
  });
}

const future = () => new Date(Date.now() + 3_600_000).toISOString();

type Drive = (s: Stack, w: World, landing: string) => Promise<unknown>;

/** The user door's per-route drivers, keyed exactly as the route census keys them. */
const USER_DRIVERS: Readonly<Record<string, Drive>> = {
  'PATCH /sessions/:id': (s, w, id) => s.sessions.rename(w.ownerId, id, 'renamed'),
  'DELETE /sessions/:id': (s, w, id) => s.sessions.remove(w.ownerId, id),
  'DELETE /sessions/:id/purge': (s, w, id) => s.sessions.purge(w.ownerId, id),
  'POST /sessions/:id/diff/refresh': (s, w, id) => s.sessions.requestDiffRefresh(w.ownerId, id),
  'POST /sessions/:id/recap': (s, w, id) => s.sessions.refreshRecap(w.ownerId, id),
  'POST /sessions/:id/turns': (s, w, id) =>
    s.sessions.createTurn(w.ownerId, id, { clientTurnId: randomUUID(), content: 'hi' }),
  'POST /sessions/:id/turns/current-work-routing': (s, w, id) =>
    s.sessions.createTurn(w.ownerId, id, { clientTurnId: randomUUID(), content: 'hi' }),
  'DELETE /sessions/:id/turns/:turnId': (s, w, id) =>
    s.sessions.cancelQueuedTurn(w.ownerId, id, randomUUID()),
  'POST /sessions/:id/turns/:turnId/steer': (s, w, id) =>
    s.sessions.steerQueuedTurn(w.ownerId, id, randomUUID()),
  'POST /sessions/:id/resume': (s, w, id) =>
    s.sessions.resume(w.ownerId, id, { clientTurnId: randomUUID(), content: 'hi' }),
  'PATCH /sessions/:id/config': (s, w, id) => s.sessions.updateConfig(w.ownerId, id, { effort: 'low' }),
  'PATCH /sessions/:id/account': (s, w, id) => s.sessions.switchAccount(w.ownerId, id, 'automatic'),
  'POST /sessions/:id/interrupt': (s, w, id) => s.sessions.interrupt(w.ownerId, id),
  'POST /sessions/:id/end': (s, w, id) => s.sessions.end(w.ownerId, id),
  'POST /sessions/:id/merge': (s, w, id) => s.sessions.mergeToMain(w.ownerId, id),
  'POST /sessions/:id/merge-repair': (s, w, id) => s.sessions.startMergeRepair(w.ownerId, id),
  'POST /sessions/:id/merge-receipts': (s, w, id) =>
    s.receipts.record(w.ownerId, id, { result: 'ERROR', sourceSha: 'a'.repeat(40), targetBranch: 'main' }, 'USER'),
  'POST /sessions/:id/commit': (s, w, id) => s.sessions.commitWorktree(w.ownerId, id),
  'POST /sessions/:id/adopt-branch': (s, w, id) => s.sessions.adoptWorktreeBranch(w.ownerId, id),
  'POST /sessions/:id/retry-message': (s, w, id) => s.autoRetry.resendRetryMessage(w.ownerId, id),
  'POST /sessions/:id/auto-retry': (s, w, id) => s.sessions.armAutoRetry(w.ownerId, id, future()),
  'DELETE /sessions/:id/auto-retry': (s, w, id) => s.sessions.cancelAutoRetry(w.ownerId, id),
  'POST /sessions/:id/complete': (s, w, id) => s.sessions.complete(w.ownerId, id),
  'POST /sessions/:id/archive': (s, w, id) => s.sessions.complete(w.ownerId, id),
  'POST /sessions/:id/restore': (s, w, id) => s.sessions.restore(w.ownerId, id),
  'POST /sessions/:id/pin': (s, w, id) => s.sessions.pin(w.ownerId, id),
  'DELETE /sessions/:id/pin': (s, w, id) => s.sessions.unpin(w.ownerId, id),
  'POST /sessions/:id/move': (s, w, id) => s.sessions.move(w.ownerId, id, {}),
  'PUT /sessions/:id/tags': (s, w, id) => s.tags.setForSession(w.ownerId, id, []),
  'POST /sessions/:id/approvals/:approvalId/decision': (s, w, id) =>
    s.sessions.decideApproval(w.ownerId, id, randomUUID(), { behavior: 'deny' }),
  'POST /sessions/:id/share': (s, w, id) => s.shares.put(w.ownerId, 'SESSION', id, {}),
  'PUT /sessions/:id/share': (s, w, id) => s.shares.put(w.ownerId, 'SESSION', id, {}),
  'DELETE /sessions/:id/share': (s, w, id) => s.shares.turnOff(w.ownerId, 'SESSION', id),
};

/** The runner door's per-route drivers, keyed exactly as the route census keys them. */
const RUNNER_DRIVERS: Readonly<Record<string, Drive>> = {
  'POST /runner/sessions/:id/source/pin': (s, w, id) =>
    s.api.pinSessionSource({ id: w.runnerId, ownerId: w.ownerId } as never, id, { baseSha: 'a'.repeat(40) } as never),
  'POST /runner/sessions/:id/takeover-leases': (s, w, id) =>
    s.api.takeoverLeases({ id: w.runnerId, ownerId: w.ownerId } as never, id, { leaseOwner: 'lease' } as never),
  'POST /runner/sessions/:id/activate-leases': (s, w, id) =>
    s.api.activateLeases({ id: w.runnerId, ownerId: w.ownerId } as never, id, { leaseOwner: 'lease', leaseGeneration: '1' } as never),
  'POST /runner/sessions/:id/release-leases': (s, w, id) =>
    s.api.releaseLeases({ id: w.runnerId, ownerId: w.ownerId } as never, id, {} as never),
  'POST /runner/sessions/:id/orchestration-credential': (s, w, id) =>
    s.api.refreshOrchestrationCredential({ id: w.runnerId, ownerId: w.ownerId } as never, id),
  'POST /runner/sessions/:id/attachments': (s, w, id) =>
    s.api.uploadAttachment({ id: w.runnerId, ownerId: w.ownerId } as never, id, undefined),
  'POST /runner/sessions/:id/artifacts/result': (s, w, id) =>
    s.api.artifactResult({ id: w.runnerId, ownerId: w.ownerId } as never, id, { requestId: randomUUID() } as never),
  'POST /runner/sessions/:id/approvals': (s, w, id) =>
    s.api.createApproval({ id: w.runnerId, ownerId: w.ownerId } as never, id, { toolName: 'Bash', input: { command: 'ls' } } as never),
  'POST /runner/sessions/:id/background-wake': (s, w, id) =>
    s.api.backgroundWake({ id: w.runnerId, ownerId: w.ownerId } as never, id, {
      wakeId: 'w', jobId: 'j', trigger: 'exit', kind: 'shell', command: 'make', status: 'completed',
      exitCode: 0, outputPath: '/tmp/x', outputOffset: 0, outputSize: 0, outputExcerpt: '',
    } as never),
  'POST /runner/sessions/:id/scheduled-wakeup': (s, w, id) =>
    s.api.scheduledWakeup({ id: w.runnerId, ownerId: w.ownerId } as never, id, { delaySeconds: 120, reason: 'x' } as never),
  'POST /runner/sessions/:id/naming': (s, w, id) =>
    s.api.sessionNaming({ id: w.runnerId, ownerId: w.ownerId } as never, id, { replaces: 'x', title: 'y' } as never),
  'POST /runner/sessions/:id/cursor-key-check': (s, w, id) =>
    s.providers.recordCursorKeyCheck(w.runnerId, id, { state: 'INVALID', keyFingerprint: '0123456789abcdef' }, w.ownerId),
  'POST /runner/sessions/:id/turns/:turnId/suggestion': (s, w, id) =>
    s.api.turnSuggestion({ id: w.runnerId, ownerId: w.ownerId } as never, id, randomUUID()),
  'POST /runner/sessions/:id/turn-complete': (s, w, id) =>
    s.api.turnComplete({ id: w.runnerId, ownerId: w.ownerId } as never, id, { turnId: randomUUID(), status: 'SUCCEEDED' } as never),
  'POST /runner/sessions/:id/events': (s, w, id) =>
    s.api.events({ id: w.runnerId, ownerId: w.ownerId } as never, id, { events: [] } as never),
  'POST /runner/sessions/:id/finalize': (s, w, id) =>
    s.api.finalize({ id: w.runnerId, ownerId: w.ownerId } as never, id, { status: 'CANCELLED' } as never),
  'POST /runner/sessions/:id/complete': (s, w, id) =>
    s.api.complete({ id: w.runnerId, ownerId: w.ownerId } as never, id, { status: 'CANCELLED' } as never),
  'POST /runner/sessions/:id/import-result': (s, w, id) =>
    s.api.importResult({ id: w.runnerId, ownerId: w.ownerId } as never, id, { ok: true }),
  'POST /runner/sessions/:id/merge-result': (s, w, id) =>
    s.api.mergeResult({ id: w.runnerId, ownerId: w.ownerId } as never, id, { status: 'error', message: 'x' } as never),
  'POST /runner/sessions/:id/commit-result': (s, w, id) =>
    s.api.commitResult({ id: w.runnerId, ownerId: w.ownerId } as never, id, { status: 'nochange' } as never),
  'POST /runner/sessions/:id/diff': (s, w, id) =>
    s.api.diffResult({ id: w.runnerId, ownerId: w.ownerId } as never, id, { worktreeDirty: false } as never),
  'POST /runner/sessions/:id/turns': (s, w, id) =>
    s.runnerSessions.sendMessage(
      { id: w.runnerId, ownerId: w.ownerId } as never, undefined, randomUUID(), undefined, id,
      { message: 'hi' },
    ),
  'POST /runner/sessions/:id/interrupt': (s, w, id) =>
    s.runnerSessions.interruptSession({ id: w.runnerId, ownerId: w.ownerId } as never, undefined, randomUUID(), undefined, id),
  'POST /runner/sessions/:id/merge': (s, w, id) =>
    s.runnerSessions.mergeSession({ id: w.runnerId, ownerId: w.ownerId } as never, undefined, randomUUID(), undefined, id, {}),
  'POST /runner/sessions/:id/merge-receipts': (s, w, id) =>
    s.runnerSessions.recordMergeReceipt({ id: w.runnerId, ownerId: w.ownerId } as never, undefined, id, {
      result: 'MERGED', sourceBranch: 'census', sourceSha: 'a'.repeat(40), targetBranch: 'main', targetShaAfter: 'b'.repeat(40),
    } as never),
  'POST /runner/sessions/:id/end': (s, w, id) =>
    s.runnerSessions.endSession({ id: w.runnerId, ownerId: w.ownerId } as never, undefined, randomUUID(), undefined, id),
  'POST /runner/sessions/:id/complete-session': (s, w, id) =>
    s.runnerSessions.completeSession({ id: w.runnerId, ownerId: w.ownerId } as never, undefined, randomUUID(), undefined, id),
  'DELETE /runner/sessions/:id': (s, w, id) =>
    s.runnerSessions.deleteSession({ id: w.runnerId, ownerId: w.ownerId } as never, undefined, randomUUID(), undefined, id),
  'POST /runner/sessions/:id/archive': (s, w, id) =>
    s.runnerSessions.archiveSessionCompatibility({ id: w.runnerId, ownerId: w.ownerId } as never, undefined, randomUUID(), undefined, id),
};

test('the door tables cover exactly the census routes', () => {
  const declared = [...Object.keys(USER_DRIVERS), ...Object.keys(RUNNER_DRIVERS)].sort();
  assert.deepEqual(declared, Object.keys(ENGINE_SESSION_DOORS).sort());
});

test('every user door refuses a LANDING session with 409 SESSION_IS_PLATFORM_DRIVEN', { skip }, async () => {
  const stack = await connect();
  try {
    for (const [route, drive] of Object.entries(USER_DRIVERS)) {
      const w = await world(stack, `user-${route.replace(/\W+/g, '-')}`);
      const landing = await landingRow(stack, w);
      await expectPlatformDriven(drive(stack, w, landing), route);
      const after = await stack.db.session.findUniqueOrThrow({
        where: { id: landing },
        select: { status: true, title: true, deletedAt: true, completedAt: true, prompt: true },
      });
      assert.deepEqual(after, {
        status: RunStatus.AWAITING_INPUT,
        title: 'Land · a task',
        deletedAt: null,
        completedAt: null,
        prompt: 'Orbit runs this landing. This conversation is a record, not an engine.',
      }, `${route} changed the landing row`);
    }
  } finally {
    await stack.db.$disconnect();
  }
});

test('every runner door refuses a LANDING session with 409 SESSION_IS_PLATFORM_DRIVEN', { skip }, async () => {
  const stack = await connect();
  try {
    for (const [route, drive] of Object.entries(RUNNER_DRIVERS)) {
      const w = await world(stack, `runner-${route.replace(/\W+/g, '-')}`);
      const landing = await landingRow(stack, w);
      await expectPlatformDriven(drive(stack, w, landing), route);
    }
  } finally {
    await stack.db.$disconnect();
  }
});

test('the body and query field cases refuse a LANDING session too', { skip }, async () => {
  const stack = await connect();
  try {
    for (const [key, field] of Object.entries(ENGINE_SESSION_FIELD_CASES)) {
      const w = await world(stack, `field-${key.replace(/\W+/g, '-')}`);
      const landing = await landingRow(stack, w);
      const conversation = await conversationRow(stack, w);
      const taskId = randomUUID();
      await stack.db.task.create({
        data: {
          id: taskId, ownerId: w.ownerId, title: 'a task', creatorType: CreatorType.USER,
          creatorId: w.ownerId, completionCriterion: 'EVIDENCE_JUDGMENT',
        },
      });
      const drive: Record<string, () => Promise<unknown>> = {
        'POST /attachments query sessionId': () =>
          stack.attachments.create(w.ownerId, landing, {
            mimetype: 'text/plain', size: 1, buffer: Buffer.from('x'), originalname: 'x.txt',
          } as never),
        'POST /watches body observerSessionId': () =>
          stack.watches.create(w.ownerId, {
            predicateVersion: 1,
            predicate: { kind: 'ALL', over: 'ALL_TARGETS', leaf: 'TASK_TERMINAL' },
            targets: [{ kind: 'TASK', id: taskId }],
            action: 'RESUME_SESSION',
            observerSessionId: landing,
          } as never),
        'POST /sessions/:id/resume body stopSessionId': () =>
          stack.sessions.resume(w.ownerId, conversation, {
            clientTurnId: randomUUID(), content: 'hi', stopSessionId: landing,
          }),
        'POST /runner/heartbeat body supervisedSessionIds[]': () =>
          stack.api.heartbeat({ id: w.runnerId, ownerId: w.ownerId, version: null } as never, {
            supervisedSessionIds: [landing],
          } as never),
        'POST /runner/heartbeat body sessions[].sessionId': () =>
          stack.api.heartbeat({ id: w.runnerId, ownerId: w.ownerId, version: null } as never, {
            sessions: [{ sessionId: landing, isolationStatus: 'shared-nogit' }],
          } as never),
        'POST /runner/heartbeat body expiredCommitErrors[].sessionId': () =>
          stack.api.heartbeat({ id: w.runnerId, ownerId: w.ownerId, version: null } as never, {
            expiredCommitErrors: [{ sessionId: landing, operationId: randomUUID() }],
          } as never),
      };
      try {
        await expectPlatformDriven(drive[key](), `${key} (${field.guard})`);
      } catch (error) {
        assert.fail(`${key}: ${(error as Error).message}`);
      }
    }
  } finally {
    await stack.db.$disconnect();
  }
});

test('the queue and the reaper do not touch a LANDING row', { skip }, async () => {
  const stack = await connect();
  try {
    const w = await world(stack, 'queue-reaper');
    // LS1 says a landing is never PENDING; forced here only to ask the claim SQL whether its own
    // filter would take one if some future writer ever wrote that status.
    const landing = await landingRow(stack, w, { status: RunStatus.PENDING });
    const conversation = await conversationRow(stack, w, { status: RunStatus.PENDING });

    const claimed = await stack.queue.claimSessionForRunner(
      { id: w.runnerId },
    );
    assert.ok(claimed, 'the queue claimed nothing at all; the fixture is wrong');
    assert.notEqual((claimed as { sessionId: string }).sessionId, landing, 'the queue claimed the LANDING row');
    assert.equal((claimed as { sessionId: string }).sessionId, conversation, 'the queue took the conversation');

    // The reaper: an AWAITING_INPUT landing with no runner would read as a dropped run.
    const parked = await landingRow(stack, w);
    await (stack.reaper as unknown as { sweep(): Promise<void> }).sweep();
    const after = await stack.db.session.findUniqueOrThrow({
      where: { id: parked },
      select: { status: true, error: true, retryAt: true, cancelRequestedAt: true },
    });
    assert.deepEqual(after, {
      status: RunStatus.AWAITING_INPUT, error: null, retryAt: null, cancelRequestedAt: null,
    }, 'the reaper touched the landing row');
  } finally {
    await stack.db.$disconnect();
  }
});

test('the flat lists, compact list, search and counts exclude LANDING', { skip }, async () => {
  const stack = await connect();
  try {
    const w = await world(stack, 'lists');
    const landing = await landingRow(stack, w);
    const conversation = await conversationRow(stack, w);

    const open = await stack.sessions.list(w.ownerId, {});
    assert.deepEqual(open.map((row: { id: string }) => row.id), [conversation], 'the flat Open list showed the landing');
    const compact = await stack.sessions.listForOrchestration(w.ownerId, {});
    assert.deepEqual(compact.map((row: { id: string }) => row.id), [conversation], 'the compact list showed the landing');
    const search = await stack.sessions.search(w.ownerId, 'Land', 20);
    assert.deepEqual(search.hits.map((hit) => hit.id), [], 'search found the landing title');
    const recents = await stack.sessions.search(w.ownerId, '', 20);
    assert.deepEqual(recents.hits.map((hit) => hit.id), [conversation], 'recents showed the landing');
    const counts = await stack.sessions.workspaceSessionCounts(w.ownerId);
    assert.deepEqual(counts, [], 'the counts tallied the landing');
  } finally {
    await stack.db.$disconnect();
  }
});

interface LandingFixture extends World {
  projectId: string;
  codebaseId: string;
  taskId: string;
  landingId: string;
  sourceSessionId: string;
}

/** A project, a task with a work session, and an OPEN TASK landing subject (no attempt yet). */
async function landingFixture(stack: Stack, label: string): Promise<LandingFixture> {
  const w = await world(stack, label);
  const projectId = randomUUID();
  const codebaseId = randomUUID();
  const taskId = randomUUID();
  await stack.db.project.create({
    data: { id: projectId, ownerId: w.ownerId, title: `${label} project`, goal: 'land the work' },
  });
  await stack.db.projectCodebase.create({
    data: {
      id: codebaseId,
      projectId,
      ownerId: w.ownerId,
      slot: 'primary',
      canonicalRepoUrl: `https://git.invalid/orbit/${label}`,
      upstreamRef: 'refs/heads/main',
      integrationRef: 'refs/heads/main',
      refAuthority: 'REMOTE',
      remoteName: 'origin',
    },
  });
  await stack.db.task.create({
    data: {
      id: taskId,
      ownerId: w.ownerId,
      projectId,
      title: `${label} task`,
      creatorType: CreatorType.USER,
      creatorId: w.ownerId,
      completionCriterion: 'EVIDENCE_JUDGMENT',
      status: TaskStatus.DONE,
    },
  });
  const sourceSessionId = randomUUID();
  await stack.db.session.create({
    data: {
      id: sourceSessionId,
      ownerId: w.ownerId,
      creatorId: w.ownerId,
      workspaceId: w.workspaceId,
      assignedRunnerId: w.runnerId,
      taskId,
      title: `${label} work`,
      prompt: 'do the work',
      status: RunStatus.SUCCEEDED,
      provider: 'claude',
      providerBuiltin: true,
      engine: 'claude',
      dispatchOrigin: SessionDispatchOrigin.USER,
      runSource: SessionRunSource.MANUAL,
      startsTaskWork: true,
      // Finished, so the claim's J-T1a "the work has stopped moving" gate lets the job through.
      finishedAt: new Date(),
    },
  });
  const opened = await stack.db.$transaction((tx) =>
    openTaskLanding(tx, { ownerId: w.ownerId, projectId, codebaseId, taskId }),
  );
  return { ...w, projectId, codebaseId, taskId, landingId: opened.id, sourceSessionId };
}

/** One attempt of the subject. `claimed` writes the claim facts every compensation point requires. */
async function attempt(
  stack: Stack,
  f: LandingFixture,
  overrides: Record<string, unknown> = {},
): Promise<string> {
  const id = randomUUID();
  await stack.db.projectIntegrationJob.create({
    data: {
      id,
      projectId: f.projectId,
      ownerId: f.ownerId,
      codebaseId: f.codebaseId,
      kind: 'LAND_TASK',
      generation: 1,
      taskId: f.taskId,
      sessionId: f.sourceSessionId,
      serialKey: `git.invalid/orbit/${id}`,
      targetRef: 'refs/heads/project/x',
      upstreamRef: 'refs/heads/main',
      sourceRef: 'refs/heads/orbit/work',
      state: 'QUEUED',
      landingId: f.landingId,
      idempotencyKey: `guard:${id}`,
      ...overrides,
    },
  });
  return id;
}

test('the landing view answers whether the row exists, does not yet, or lost its source session', { skip }, async () => {
  const stack = await connect();
  try {
    const f = await landingFixture(stack, 'view');
    const jobId = await attempt(stack, f, { claimGeneration: 1n, state: 'RUNNING', phase: 'FETCH', claimedAt: new Date(), heartbeatAt: new Date(), progressProtocol: 'v2' });

    // (a) The row exists — what `ensure` writes after the claim commits.
    const landed = await ensureLandingSession(stack.db, f.landingId, jobId);
    assert.ok(landed?.created);
    const inserted = await stack.sessions.get(f.ownerId, landed!.sessionId) as Record<string, unknown>;
    assert.equal(inserted.sessionKind, 'LANDING');
    const view = inserted.landing as Record<string, unknown>;
    assert.equal(view.subject, 'TASK');
    assert.equal(view.taskId, f.taskId);
    assert.equal(view.phase, 'FETCH');
    const current = view.currentAttempt as Record<string, unknown>;
    assert.equal(current.jobId, jobId);
    assert.equal(current.sourceSessionId, f.sourceSessionId);
    // The same read the runner's GET /runner/sessions/:id (MCP session_get) answers with.
    const orchestrated = await stack.sessions.getForOrchestration(f.ownerId, landed!.sessionId) as Record<string, unknown>;
    assert.equal(orchestrated.sessionKind, 'LANDING');
    assert.deepEqual(orchestrated.landing, view);

    // (b) The row has not been inserted yet: the link reaches the subject's pre-generated id.
    const f2 = await landingFixture(stack, 'view-before-row');
    await attempt(stack, f2);
    const early = await stack.sessions.get(f2.ownerId, await preGeneratedId(stack, f2)) as Record<string, unknown>;
    assert.equal(early.sessionKind, 'LANDING');
    assert.equal((early.landing as Record<string, unknown>).taskId, f2.taskId);
    const earlyCompact = await stack.sessions.getForOrchestration(
      f2.ownerId, await preGeneratedId(stack, f2),
    ) as Record<string, unknown>;
    assert.equal(earlyCompact.sessionKind, 'LANDING');

    // (c) The source session was purged (0424: a history reference, not a foreign key).
    await stack.db.session.delete({ where: { id: f.sourceSessionId } });
    const orphaned = await stack.sessions.get(f.ownerId, landed!.sessionId) as Record<string, unknown>;
    const orphanedAttempt = (orphaned.landing as Record<string, unknown>).currentAttempt as Record<string, unknown>;
    assert.equal(orphanedAttempt.sourceSessionId, null, 'a purged source session must read as NULL');

    // (d) Another account gets 404, for a row that exists and for one that does not.
    const other = await world(stack, 'view-other');
    await assert.rejects(stack.sessions.get(other.ownerId, landed!.sessionId), NotFoundException);
    await assert.rejects(stack.sessions.getForOrchestration(other.ownerId, landed!.sessionId), NotFoundException);
    await assert.rejects(stack.sessions.get(other.ownerId, await preGeneratedId(stack, f2)), NotFoundException);
  } finally {
    await stack.db.$disconnect();
  }
});

async function preGeneratedId(stack: Stack, f: LandingFixture): Promise<string> {
  return (await stack.db.projectLanding.findUniqueOrThrow({
    where: { id: f.landingId }, select: { sessionId: true },
  })).sessionId;
}

test('only a claimed subject gets a session row, and the compensation points insert it', { skip }, async () => {
  const stack = await connect();
  try {
    // A subject no attempt has claimed: `ensure` writes nothing, and dispatch was never offered it.
    const f = await landingFixture(stack, 'ensure-queued');
    const queued = await attempt(stack, f);
    assert.equal(await ensureLandingSession(stack.db, f.landingId, queued), null);
    assert.equal(await stack.db.session.count({ where: { id: await preGeneratedId(stack, f) } }), 0);

    // A progress report on a claimed attempt: the compensation point inserts the row.
    await stack.db.projectIntegrationJob.update({
      where: { id: queued },
      data: {
        state: 'RUNNING', claimGeneration: 1n, claimLeaseOwner: 'lease',
        runnerId: f.runnerId, claimedAt: new Date(), heartbeatAt: new Date(), phase: 'FETCH',
      },
    });
    await stack.api.integrationJobProgress({ id: f.runnerId } as never, queued, {
      claimGeneration: '1', leaseOwner: 'lease', phase: 'FETCH',
    } as never);
    const inserted = await stack.db.session.findUnique({
      where: { id: await preGeneratedId(stack, f) },
      select: { sessionKind: true, provider: true, startsTaskWork: true, status: true },
    });
    assert.deepEqual(inserted, {
      sessionKind: 'LANDING', provider: 'orbit', startsTaskWork: false, status: RunStatus.AWAITING_INPUT,
    });

    // The heartbeat's dispatch: the claim it commits is the compensation point that inserts the row.
    const d = await landingFixture(stack, 'ensure-dispatch');
    const dispatched = await attempt(stack, d);
    const commands = await new IntegrationJobRelay(stack.prisma).dispatch({
      runnerId: d.runnerId,
      leaseOwner: 'lease-dispatch',
      draining: false,
      capabilities: [INTEGRATION_JOB_CLAIM],
    });
    assert.ok(commands.some((command) => command.jobId === dispatched), 'the fixture job was not dispatched');
    assert.deepEqual(
      await stack.db.session.findUnique({
        where: { id: await preGeneratedId(stack, d) },
        select: { sessionKind: true, status: true },
      }),
      { sessionKind: 'LANDING', status: RunStatus.AWAITING_INPUT },
      'the heartbeat claim did not insert the landing row',
    );

    // A result's compensation inserts its own: a row the claim never wrote still appears, terminal.
    const r = await landingFixture(stack, 'ensure-result');
    const resultJob = await attempt(stack, r, {
      claimGeneration: 1n, state: 'RUNNING', claimLeaseOwner: 'lease', runnerId: r.runnerId,
      claimedAt: new Date(), heartbeatAt: new Date(), phase: 'PUSH',
    });
    await stack.api.integrationJobResult({ id: r.runnerId } as never, resultJob, {
      claimGeneration: '1', leaseOwner: 'lease', state: 'LANDED', phase: 'PUSH',
      sourceSha: 'a'.repeat(40), targetShaBefore: 'b'.repeat(40),
      testedSha: 'c'.repeat(40), testedTreeSha: 'd'.repeat(40),
      landedSha: 'c'.repeat(40), landedTreeSha: 'd'.repeat(40), aheadOfUpstream: 1,
    } as never);
    assert.deepEqual(
      await stack.db.session.findUnique({
        where: { id: await preGeneratedId(stack, r) },
        select: { sessionKind: true, status: true },
      }),
      { sessionKind: 'LANDING', status: RunStatus.SUCCEEDED },
      'the result did not insert the landing row',
    );

    // Settled first, then inserted: the row starts terminal (LS1's table).
    const g = await landingFixture(stack, 'ensure-settled');
    const claimed = await attempt(stack, g, { claimGeneration: 1n, state: 'RUNNING', claimedAt: new Date() });
    await stack.db.projectLanding.update({
      where: { id: g.landingId },
      data: { settledAt: new Date(), settledAs: 'LANDED' },
    });
    const settled = await ensureLandingSession(stack.db, g.landingId, claimed);
    assert.ok(settled?.created);
    assert.equal((await stack.db.session.findUniqueOrThrow({
      where: { id: settled!.sessionId }, select: { status: true },
    })).status, RunStatus.SUCCEEDED);
  } finally {
    await stack.db.$disconnect();
  }
});


/** How a door answered: the same string for the same refusal, whatever the id was. */
async function answerOf(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
    return 'resolved';
  } catch (error) {
    const err = error as {
      name?: string;
      message?: string;
      getStatus?: () => number;
      getResponse?: () => unknown;
    };
    const status = typeof err.getStatus === 'function' ? err.getStatus() : '';
    return `${err.name ?? 'Error'}|${status}|${JSON.stringify(err.getResponse?.() ?? err.message ?? '')}`;
  }
}

test("another account's landing id is answered exactly like an id that names nothing", { skip }, async () => {
  const stack = await connect();
  try {
    const a = await world(stack, 'isolation-a');
    const b = await world(stack, 'isolation-b');
    const foreignLanding = await landingRow(stack, b);
    const nothing = randomUUID();
    const runnerA = { id: a.runnerId, ownerId: a.ownerId } as never;

    // The three reads that answered before the ownership check: the id-only guard (source pin),
    // the ownership loader (approvals) and the provider report.
    const doors: Array<[string, (id: string) => Promise<unknown>]> = [
      ['source/pin', (id) => stack.api.pinSessionSource(runnerA, id, { baseSha: 'a'.repeat(40) } as never)],
      ['approvals', (id) => stack.api.createApproval(runnerA, id, { toolName: 'Bash', input: { command: 'ls' } } as never)],
      ['cursor-key-check', (id) =>
        stack.providers.recordCursorKeyCheck(a.runnerId, id, { state: 'INVALID', keyFingerprint: '0123456789abcdef' }, a.ownerId)],
    ];
    for (const [label, door] of doors) {
      const foreign = await answerOf(() => door(foreignLanding));
      const unknown = await answerOf(() => door(nothing));
      assert.equal(foreign, unknown, `${label} answered another account's landing differently from a nonexistent id`);
      assert.ok(!foreign.includes('SESSION_IS_PLATFORM_DRIVEN'), `${label} leaked that the id is a landing`);
    }

    // The heartbeat names the id in its body: no refusal, no cancellation, and the row is untouched.
    const beat = await stack.api.heartbeat(
      { id: a.runnerId, ownerId: a.ownerId, version: null } as never,
      { supervisedSessionIds: [foreignLanding] } as never,
    ) as { cancelSessionIds?: string[] };
    assert.ok(!(beat.cancelSessionIds ?? []).includes(foreignLanding));
    assert.deepEqual(
      await stack.db.session.findUniqueOrThrow({
        where: { id: foreignLanding },
        select: { sessionKind: true, status: true, cancelRequestedAt: true },
      }),
      { sessionKind: 'LANDING', status: RunStatus.AWAITING_INPUT, cancelRequestedAt: null },
    );
  } finally {
    await stack.db.$disconnect();
  }
});

test('a SESSION_TURN_SETTLED watch on an open landing waits for the landing to end', { skip }, async () => {
  const stack = await connect();
  try {
    const w = await world(stack, 'watch-landing');
    const landing = await landingRow(stack, w);
    const settledWatch = (id: string) => ({
      predicateVersion: 1,
      predicate: { kind: 'ALL', over: 'ALL_TARGETS', leaf: 'SESSION_TURN_SETTLED' },
      targets: [{ kind: 'SESSION', id }],
      action: 'NOTIFY_USER',
    });

    // The open container sits at AWAITING_INPUT, which is LS1's "subject still open" — not a turn
    // that settled, so awaiting the landing is awaiting its end.
    const watch = await stack.watches.create(w.ownerId, settledWatch(landing) as never);
    assert.equal(watch.state, 'ACTIVE', 'an open landing read as a settled turn');

    // The control: a conversation parked at AWAITING_INPUT has settled its turn.
    const conversation = await conversationRow(stack, w);
    const immediate = await stack.watches.create(w.ownerId, settledWatch(conversation) as never);
    assert.equal(immediate.state, 'MATCHED', 'a conversation at AWAITING_INPUT is settled');

    // The landing ends: the same watch now matches, and its row is the one that moved.
    await stack.db.session.update({
      where: { id: landing },
      data: { status: RunStatus.SUCCEEDED, completedAt: new Date() },
    });
    const evaluation = await new WatchEvaluatorService(stack.prisma, noopRealtime(), {
      rollout: { mode: 'on', canaryOwners: new Set<string>(), problems: [] },
    } as never).evaluate(watch.id);
    assert.equal(evaluation.outcome, 'MATCHED');
  } finally {
    await stack.db.$disconnect();
  }
});

test('a workspace seed, a task dispatch and an @-mention read past a newest LANDING row', { skip }, async () => {
  const stack = await connect();
  try {
    const w = await world(stack, 'seed');
    await conversationRow(stack, w);
    // Newest in the workspace, and shaped like an ordinary conversation: task and parent both NULL.
    const landing = await landingRow(stack, w);
    await stack.db.$executeRaw`UPDATE "session" SET "created_at" = now() + interval '1 second' WHERE "id" = ${landing}::uuid`;

    // What the broken read would answer: the platform slug, which no engine runs.
    const [raw] = await stack.db.$queryRaw<Array<{ provider: string }>>`
      SELECT provider FROM "session"
       WHERE workspace_id = ${w.workspaceId}::uuid AND task_id IS NULL AND parent_session_id IS NULL
       ORDER BY created_at DESC LIMIT 1`;
    assert.equal(raw.provider, 'orbit', 'the fixture landing is not the newest conversation-shaped row');

    // The seed every one of these doors reads.
    const seed = (await lastProviderByWorkspace(stack.prisma, [w.workspaceId])).get(w.workspaceId);
    assert.equal(seed?.provider, 'claude');
    assert.equal(seed?.engine, 'claude');
    assert.equal((await agentProviderSeed(stack.prisma, w.workspaceId)).provider, 'claude');
    const dispatchSeed = await taskRouteReads(stack.prisma, w.ownerId).seed(w.workspaceId);
    assert.equal(dispatchSeed.provider, 'claude', 'the task dispatcher would route onto the landing');

    // The real door: a new session with no provider named starts on the floor, not on `orbit`.
    const session = await stack.sessions.create(w.ownerId, { prompt: 'hello there', workspaceId: w.workspaceId });
    assert.equal(session.provider, 'claude');
    assert.equal(session.engine, 'claude');
  } finally {
    await stack.db.$disconnect();
  }
});

test('the wiki plan materials do not read a LANDING session', { skip }, async () => {
  const stack = await connect();
  try {
    const w = await world(stack, 'wiki');
    const spaceId = randomUUID();
    await stack.db.wikiSpace.create({
      data: { id: spaceId, ownerId: w.ownerId, slug: `wiki-${spaceId.slice(0, 8)}`, title: 'Wiki' },
    });
    await stack.db.wikiSpaceWorkspace.create({
      data: { spaceId, ownerId: w.ownerId, workspaceId: w.workspaceId },
    });
    const landing = await landingRow(stack, w, { title: 'Land · a secret merge' });
    await stack.db.session.update({
      where: { id: landing },
      data: { createdAt: new Date(Date.now() + 2_000) },
    });
    const conversation = await conversationRow(stack, w);
    await stack.db.session.update({ where: { id: conversation }, data: { title: 'talked about the docs' } });

    const materials = await wikiPlanMaterials(stack.prisma as never, w.ownerId, spaceId);
    const titles = materials.sessions.items.map((item) => item.title);
    assert.deepEqual(titles, ['talked about the docs']);
    assert.equal(materials.sessions.total, 1);
  } finally {
    await stack.db.$disconnect();
  }
});
