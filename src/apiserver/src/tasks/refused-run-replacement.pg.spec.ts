import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import { ConflictException } from '@nestjs/common';
import { CreatorType, Prisma, PrismaClient, RunnerStatus } from '@prisma/client';
import { RunStatus } from '@orbit/shared';
import { RunFailureKind, RunStatus as SharedRunStatus, SESSION_RELEASE_V1 } from '@orbit/shared';

import { PrismaService } from '../prisma/prisma.service';
import { prismaClientFor } from '../prisma/prisma-client';
import { assertCoordinatorPgUrlIsIsolated } from '../projects/coordinator-pg-test-safety';
import { establishProjectContractForPgTest } from '../projects/project-contract-test-helper';
import { AccountHealthService } from '../providers/account-health.service';
import { QueueService } from '../queue/queue.service';
import { RealtimeService } from '../realtime/realtime.service';
import { RunnerApiController } from '../runner-api/runner-api.controller';
import { SessionsService } from '../sessions/sessions.service';
import { TasksService } from './tasks.service';
import { WORD_SELECT, wordOf } from '../test-support/session-word';

/**
 * Phase 2 of docs/routing-account-health-design.md §10, against a real PostgreSQL: the replacement of §7.3 and the pin
 * of §7.5. Runs end the way a runner ends them, by POSTing finalize or turn-complete to RunnerApiController with the
 * failure as the engine adapter classified it; account health is written by the controller's own ingest, and the
 * replacement is TasksService.replaceRefusedRun, which the controller calls after it. What is proven:
 *
 * - a task that does not auto-run gets one replacement after a refusal, recorded on its timeline, and the same refusal
 *   reported twice is still one replacement;
 * - at most three replacements an hour; a refused trial's replacement is not counted;
 * - with relaxBlockedPins off a pinned task holds with the pin named, and its replacement stands down;
 * - with it on the replacement runs elsewhere and says so, and the task returns to its pin once a trial succeeds.
 */

const URL = process.env.COORDINATOR_PG_URL;
const skip = !URL;
const RUN = randomUUID().slice(0, 8);
const OPUS = 'claude-opus-5-5';
const SONNET = 'claude-sonnet-5-5';
const PAYMENT = 'Add a payment method to continue';
const CURSOR_ERROR = `Cursor said: "${PAYMENT}." The Cursor account needs this before the session can go on.`;

interface Services {
  db: PrismaClient;
  tasks: TasksService;
  api: RunnerApiController;
}

function connect(): Services {
  const db = prismaClientFor(URL!);
  const prisma = db as unknown as PrismaService;
  const publishes = new Proxy({}, { get: () => () => undefined }) as unknown as RealtimeService;
  const queue = new QueueService(prisma, publishes);
  const sessions = new SessionsService(prisma, queue, publishes);
  const tasks = new TasksService(prisma, sessions, publishes);
  // As account-health-incident.pg.spec.ts builds it. TasksService is left out of the controller on purpose: the spec
  // calls replaceRefusedRun itself, after the ingest, instead of racing the controller's fire-and-forget call.
  const optional: unknown[] = Array.from({ length: 27 }, () => undefined);
  optional[0] = { appendFor: async (_tx: unknown, _sessionId: string, content?: string) => content };
  optional[5] = sessions;
  const Controller = RunnerApiController as unknown as new (...args: unknown[]) => RunnerApiController;
  const api = new Controller(
    prisma,
    queue,
    publishes,
    new Proxy({}, { get: () => async () => undefined }) as never,
    { assert: async (_runner: unknown, callingSessionId?: string) => callingSessionId ?? randomUUID() } as never,
    { expand: async (_ownerId: string, content?: string) => content } as never,
    ...optional,
    new AccountHealthService(prisma),
  );
  return { db, tasks, api };
}

interface Fixture {
  ownerId: string;
  runnerId: string;
  agentId: string;
  projectId: string;
}

/** An owner with smart selection on (Cost), a runner with Cursor CLI and Claude Code, and an Agent whose own engine is Cursor. */
async function fixture(
  db: PrismaClient,
  label: string,
  preferences: Record<string, unknown> = {},
  { started = true } = {},
): Promise<Fixture> {
  const f = { ownerId: randomUUID(), runnerId: randomUUID(), agentId: randomUUID(), projectId: randomUUID() };
  await db.user.create({
    data: {
      id: f.ownerId, email: `${label}-${RUN}-${f.ownerId}@replace.invalid`, name: label, passwordHash: 'x',
      preferences: { modelRouting: true, optimizeFor: 'cost', ...preferences },
    },
  });
  const models = [
    { value: OPUS, label: 'Opus 5.5', priority: 0, permissionModes: ['default', 'auto'] },
    { value: SONNET, label: 'Sonnet 5.5', priority: 2, permissionModes: ['default', 'auto'] },
  ];
  await db.runner.create({
    data: {
      id: f.runnerId, ownerId: f.ownerId, name: `${label}-runner`, tokenHash: `hash-${f.runnerId}`,
      status: RunnerStatus.ONLINE, capabilities: ['provider:cursor'], capabilitiesReportedAt: new Date(), maxConcurrent: 10,
      modelCatalog: { claude: models, cursor: models }, runtimeDefaultModels: { claude: OPUS, cursor: OPUS },
    },
  });
  await db.workspace.create({ data: { id: f.agentId, ownerId: f.ownerId, runnerId: f.runnerId, name: `${label}-agent`, enabled: true } });
  await db.project.create({
    data: { id: f.projectId, ownerId: f.ownerId, title: label, coordinatorEnabled: false, maxConcurrentTasks: 10, startedAt: started ? new Date() : null },
  });
  if (started) await establishProjectContractForPgTest(db, f.ownerId, f.projectId, label);
  await db.session.create({
    data: {
      ownerId: f.ownerId, creatorId: f.ownerId, prompt: 'hello', workspaceId: f.agentId, title: 'a conversation on Cursor',
      provider: 'cursor', providerBuiltin: true, engine: 'cursor', turnState: null,
      createdAt: new Date(Date.now() - 3_600_000),
    },
  });
  return f;
}

async function taskIn(db: PrismaClient, f: Fixture, seed: Partial<Prisma.TaskUncheckedCreateInput> = {}) {
  const task = await db.task.create({
    data: {
      ownerId: f.ownerId, projectId: f.projectId, assigneeId: f.agentId, title: 'the replaced task',
      creatorType: CreatorType.USER, creatorId: f.ownerId, completionCriterion: 'EVIDENCE_JUDGMENT',
      modelHint: 'L', modelHintReason: 'a routing change', autoRunWhenReady: false, ...seed,
    },
  });
  return task.id;
}

async function runNow(s: Services, f: Fixture, taskId: string): Promise<string> {
  const result = await s.tasks.execute(f.ownerId, taskId, undefined, randomUUID());
  assert.ok(result.sessionId, `Run Now must answer with a Session, got ${JSON.stringify(result)}`);
  return result.sessionId;
}

/** The runner claimed the run: RUNNING on the fixture's runner, with its first turn out. */
async function claimed(s: Services, f: Fixture, sessionId: string): Promise<string> {
  await s.db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('orbit.claim_reads_session_engine', '1', true)`;
    await tx.$executeRaw`SELECT set_config('orbit.runner_supports_cursor', '1', true)`;
    await tx.session.update({
      where: { id: sessionId },
      data: { turnState: 'IN_FLIGHT', assignedRunnerId: f.runnerId, startedAt: new Date(), engineTurnActive: true, runtimeSessionId: randomUUID() },
    });
  });
  await s.db.conversationTurn.deleteMany({ where: { sessionId } });
  const turn = await s.db.conversationTurn.create({
    data: {
      sessionId, seq: 1, clientTurnId: `turn-1-${randomUUID()}`, kind: 'message', content: 'the brief', status: 'IN_FLIGHT',
      deliveredAt: new Date(), leaseDeadlineAt: new Date(Date.now() + 300_000), leaseGeneration: randomUUID(),
    },
    select: { id: true },
  });
  return turn.id;
}

/** The provider refuses the claimed run at admission, classified, and the runner finalizes it. */
async function refused(s: Services, f: Fixture, sessionId: string, failure: { kind: RunFailureKind; said?: string } = {
  kind: RunFailureKind.ACCOUNT_ACTION_REQUIRED, said: PAYMENT,
}) {
  await claimed(s, f, sessionId);
  await s.api.finalize({ id: f.runnerId }, sessionId, { status: SharedRunStatus.FAILED, error: CURSOR_ERROR, failure, admission: true } as never);
  assert.equal(wordOf((await s.db.session.findUniqueOrThrow({ where: { id: sessionId }, select: WORD_SELECT }))), RunStatus.FAILED);
}

/** The claimed run does its work: the turn completes, which is the account working (§6.3). */
async function admitted(s: Services, f: Fixture, sessionId: string) {
  const turnId = await claimed(s, f, sessionId);
  await s.api.turnComplete({ id: f.runnerId }, sessionId, {
    turnId, status: SharedRunStatus.SUCCEEDED, subtype: 'success', numTurns: 1, costUsd: 0.2, result: 'done',
  } as never);
  // And the run ends, so the next start is a fresh, routed run rather than a turn handed to this one.
  await s.db.session.update({ where: { id: sessionId }, data: { turnState: null, finishedAt: new Date() } });
}

const runOf = (db: PrismaClient, id: string) => db.session.findUniqueOrThrow({
  where: { id }, select: { provider: true, engine: true, taskId: true, accountHealthEffect: true },
});
const runsOf = (db: PrismaClient, taskId: string) =>
  db.session.findMany({ where: { taskId, startsTaskWork: true }, orderBy: { createdAt: 'asc' }, select: { id: true, provider: true } });

test('a task that does not auto-run gets one replacement after a refusal, on another account, recorded on the task',
  { skip, timeout: 120_000 }, async () => {
    assertCoordinatorPgUrlIsIsolated(URL!);
    const s = connect();
    try {
      // A project its owner has not started: the person's Run Now is not held back by it, nor is its replacement.
      const f = await fixture(s.db, 'one', {}, { started: false });
      const taskId = await taskIn(s.db, f);
      const run1 = await runNow(s, f, taskId);
      assert.equal((await runOf(s.db, run1)).provider, 'cursor');
      await refused(s, f, run1);
      assert.equal((await runOf(s.db, run1)).accountHealthEffect, 'BLOCKED');

      const answer = await s.tasks.replaceRefusedRun(run1);
      assert.equal(answer?.ok, true, JSON.stringify(answer));
      const replacement = answer!.sessionId!;
      assert.equal((await runOf(s.db, replacement)).provider, 'claude', 'the fresh dispatch reads the health the refusal wrote');
      const decision = await s.db.taskRouteDecision.findFirstOrThrow({ where: { sessionId: replacement } });
      assert.ok(decision.reasons.includes('Run 1 was refused by its account before it started — not counted'), decision.reasons.join(' | '));
      assert.equal(decision.level, 'L');
      // Beside the finalize's own record of the failed run, the replacement's.
      const replacedNote = { taskId, body: { startsWith: '**Replaced run 1, which its account refused (recorded by Orbit)**' } };
      assert.equal(await s.db.taskComment.count({ where: replacedNote }), 1);

      // The same refusal reported again (a failed turn, then the finalize) is the same request: one replacement.
      const again = await s.tasks.replaceRefusedRun(run1);
      assert.equal(again?.sessionId, replacement);
      assert.equal((await runsOf(s.db, taskId)).length, 2);
      assert.equal(await s.db.taskComment.count({ where: replacedNote }), 1, 'recorded once');
      // An ordinary failure is not replaced.
      await s.db.session.update({ where: { id: replacement }, data: { turnState: null, finishedAt: new Date(), error: 'tests failed' } });
      assert.equal(await s.tasks.replaceRefusedRun(replacement), null);
    } finally {
      await s.db.$disconnect();
    }
  });

test('under the release protocol the failed turn holds the task, and its release is what is replaced; the block stands',
  { skip, timeout: 120_000 }, async () => {
    assertCoordinatorPgUrlIsIsolated(URL!);
    const s = connect();
    try {
      const f = await fixture(s.db, 'release');
      const taskId = await taskIn(s.db, f);
      const run1 = await runNow(s, f, taskId);
      const turnId = await claimed(s, f, run1);
      // SESSION_RELEASE_V1: the failed turn's report releases nothing; the runner's release report follows.
      await s.api.turnComplete({ id: f.runnerId }, run1, {
        turnId, status: SharedRunStatus.FAILED, subtype: 'error', numTurns: 1, costUsd: 0, error: CURSOR_ERROR,
        failure: { kind: RunFailureKind.ACCOUNT_ACTION_REQUIRED, said: PAYMENT }, admission: true,
      } as never, SESSION_RELEASE_V1);
      const held = await s.db.session.findUniqueOrThrow({ where: { id: run1 }, select: { finishedAt: true, failureKind: true, accountHealthEffect: true } });
      assert.equal(held.finishedAt, null, 'held until its release');
      assert.equal(held.failureKind, RunFailureKind.ACCOUNT_ACTION_REQUIRED);
      assert.equal(held.accountHealthEffect, 'BLOCKED', 'the turn report told account health');
      assert.equal(await s.tasks.replaceRefusedRun(run1), null, 'not while the run still holds the task');

      await s.api.release({ id: f.runnerId }, run1, {} as never, SESSION_RELEASE_V1);
      const released = await s.db.session.findUniqueOrThrow({ where: { id: run1 }, select: { ...WORD_SELECT, finishedAt: true, failureKind: true } });
      assert.equal(wordOf(released), RunStatus.FAILED);
      assert.ok(released.finishedAt);
      assert.equal(released.failureKind, RunFailureKind.ACCOUNT_ACTION_REQUIRED, 'the release keeps the turn report\'s classification');
      const [row] = await s.db.accountHealth.findMany({ where: { ownerId: f.ownerId, clearedAt: null } });
      assert.equal(row?.state, 'BLOCKED', 'the release is read as the failure it is, not as the account working');

      const answer = await s.tasks.replaceRefusedRun(run1);
      assert.equal(answer?.ok, true, JSON.stringify(answer));
      assert.equal((await runOf(s.db, answer!.sessionId!)).provider, 'claude');
    } finally {
      await s.db.$disconnect();
    }
  });

test('at most three replacements an hour; a refused trial\'s replacement is not counted',
  { skip, timeout: 180_000 }, async () => {
    assertCoordinatorPgUrlIsIsolated(URL!);
    const s = connect();
    try {
      const f = await fixture(s.db, 'bound');
      const taskId = await taskIn(s.db, f);
      // Each refusal is the account's, at admission, health having acted on it: what the ingest writes. Written here
      // directly so every replacement can run (on Claude) and be refused in turn without blocking every account.
      const refuse = (id: string, effect: 'BLOCKED' | 'TRIAL') => s.db.session.update({
        where: { id },
        data: {
          // Released by a failure, as every failure release records it: its last turn failed (common/session-release.ts).
          turnState: null, finishedAt: new Date(), lastTurnOutcome: 'FAILED', error: CURSOR_ERROR,
          failureKind: RunFailureKind.ACCOUNT_ACTION_REQUIRED, failureSaid: PAYMENT, admissionFailure: true, accountHealthEffect: effect,
        },
      });
      let last = await runNow(s, f, taskId);
      for (let i = 0; i < 3; i += 1) {
        await refuse(last, 'BLOCKED');
        const answer = await s.tasks.replaceRefusedRun(last);
        assert.equal(answer?.ok, true, `replacement ${i + 1}: ${JSON.stringify(answer)}`);
        last = answer!.sessionId!;
      }
      await refuse(last, 'BLOCKED');
      assert.equal(await s.tasks.replaceRefusedRun(last), null, 'a fourth in the hour is not started');
      assert.equal((await runsOf(s.db, taskId)).length, 4);
      // A refused trial: the task did not choose to be the test, so its replacement is outside the bound.
      await s.db.session.update({ where: { id: last }, data: { accountHealthEffect: 'TRIAL' } });
      const trial = await s.tasks.replaceRefusedRun(last);
      assert.equal(trial?.ok, true, JSON.stringify(trial));
      assert.equal((await runsOf(s.db, taskId)).length, 5);
      // An hour on, the window has room again.
      await refuse(trial!.sessionId!, 'BLOCKED');
      (s.tasks as unknown as { now: () => Date }).now = () => new Date(Date.now() + 61 * 60_000);
      const later = await s.tasks.replaceRefusedRun(trial!.sessionId!);
      assert.equal(later?.ok, true, JSON.stringify(later));
    } finally {
      await s.db.$disconnect();
    }
  });

test('with relaxBlockedPins off a task pinned to the refused provider holds with the pin named; its replacement stands down',
  { skip, timeout: 120_000 }, async () => {
    assertCoordinatorPgUrlIsIsolated(URL!);
    const s = connect();
    try {
      const f = await fixture(s.db, 'pinned-off');
      const taskId = await taskIn(s.db, f, { provider: 'cursor' });
      const run1 = await runNow(s, f, taskId);
      assert.equal((await runOf(s.db, run1)).provider, 'cursor');
      await refused(s, f, run1);

      assert.deepEqual(await s.tasks.replaceRefusedRun(run1), { ok: false, skipped: 'account-needs-action' });
      assert.equal((await runsOf(s.db, taskId)).length, 1, 'no run is started on another provider');
      await assert.rejects(s.tasks.execute(f.ownerId, taskId, undefined, randomUUID()), (error: unknown) => {
        assert.ok(error instanceof ConflictException);
        const body = error.getResponse() as { code: string; message: string; hold: { setting?: string } };
        assert.equal(body.code, 'ACCOUNT_NEEDS_ACTION');
        assert.match(body.message, /^Pinned to cursor, which can't run now \(The account needs your action: Cursor CLI said "Add a payment method to continue"/);
        assert.equal(body.hold.setting, 'orbit-settings:relaxBlockedPins');
        return true;
      });
    } finally {
      await s.db.$disconnect();
    }
  });

test('with relaxBlockedPins on the replacement runs elsewhere and says so, and the task returns to its pin after a successful trial',
  { skip, timeout: 180_000 }, async () => {
    assertCoordinatorPgUrlIsIsolated(URL!);
    const s = connect();
    try {
      const f = await fixture(s.db, 'pinned-on', { relaxBlockedPins: true });
      const taskId = await taskIn(s.db, f, { provider: 'cursor' });
      const run1 = await runNow(s, f, taskId);
      assert.equal((await runOf(s.db, run1)).provider, 'cursor');
      await refused(s, f, run1);

      const answer = await s.tasks.replaceRefusedRun(run1);
      assert.equal(answer?.ok, true, JSON.stringify(answer));
      const relaxed = answer!.sessionId!;
      assert.equal((await runOf(s.db, relaxed)).provider, 'claude', 'no other Cursor credential: engine and provider dropped');
      const decision = await s.db.taskRouteDecision.findFirstOrThrow({ where: { sessionId: relaxed } });
      assert.equal(decision.level, 'L', 'the tier is kept');
      assert.ok(decision.reasons.some((r) => r.startsWith('Pinned to cursor on cursor, where no account can run now (The account needs your action')
        && r.endsWith(`runs on ${OPUS} on claude instead, at tier L`)), decision.reasons.join(' | '));
      assert.equal((await s.db.task.findUniqueOrThrow({ where: { id: taskId }, select: { provider: true } })).provider, 'cursor',
        'the pin on the task is not changed');
      await admitted(s, f, relaxed);

      // Once the block runs out the pinned account's trial is due: the next run goes back to the pin and takes it.
      const [row] = await s.db.accountHealth.findMany({ where: { ownerId: f.ownerId, clearedAt: null } });
      const after = new Date(row.blockedUntil!.getTime() + 1_000);
      (s.tasks as unknown as { now: () => Date }).now = () => after;
      const trial = await runNow(s, f, taskId);
      assert.equal((await runOf(s.db, trial)).provider, 'cursor');
      assert.equal((await s.db.accountHealth.findUniqueOrThrow({ where: { id: row.id } })).trialSessionId, trial);
      await admitted(s, f, trial);
      const cleared = await s.db.accountHealth.findUniqueOrThrow({ where: { id: row.id } });
      assert.equal(cleared.clearedBy, 'SUCCESS', 'the trial succeeded: the account is healthy');

      const back = await runNow(s, f, taskId);
      assert.equal((await runOf(s.db, back)).provider, 'cursor', 'the task is back on its pin');
      const reasons = (await s.db.taskRouteDecision.findFirstOrThrow({ where: { sessionId: back } })).reasons;
      assert.ok(!reasons.some((r) => r.startsWith('Pinned to cursor')), reasons.join(' | '));
    } finally {
      await s.db.$disconnect();
    }
  });
