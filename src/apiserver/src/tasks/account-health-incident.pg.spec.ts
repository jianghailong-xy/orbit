import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import { ConflictException } from '@nestjs/common';
import { CreatorType, Prisma, PrismaClient, RunnerStatus } from '@prisma/client';
import { RunStatus } from '@orbit/shared';
import { RunFailureKind, RunStatus as SharedRunStatus } from '@orbit/shared';

import { PrismaService } from '../prisma/prisma.service';
import { prismaClientFor } from '../prisma/prisma-client';
import { assertCoordinatorPgUrlIsIsolated } from '../projects/coordinator-pg-test-safety';
import { establishProjectContractForPgTest } from '../projects/project-contract-test-helper';
import { AccountHealthService } from '../providers/account-health.service';
import { QueueService } from '../queue/queue.service';
import { RealtimeService } from '../realtime/realtime.service';
import { RunnerApiController } from '../runner-api/runner-api.controller';
import { SessionsService } from '../sessions/sessions.service';
import { MAX_AUTO_RUN_FAILURES } from './task-retry-policy';
import { TASK_RUN_TRIGGER } from './task-run-identity';
import { TasksService } from './tasks.service';
import { WORD_SELECT, wordOf } from '../test-support/session-word';

/**
 * The incident of docs/routing-account-health-design.md §1, replayed against a real PostgreSQL (§10, phase 1): from
 * 2026-11-22 17:19 every run was routed to the owner's Cursor subscription, Cursor refused each at once with
 * "Add a payment method to continue", and each refusal raised the task's tier and spent its retry budget.
 *
 * Driven through the doors a run really passes: Run Now (`execute`) routes and creates the Session; the runner's claim
 * puts it RUNNING on its runner; and the run ends the way the incident's did, by the runner POSTing its finalize (or its
 * turn-complete) to RunnerApiController with the failure as its engine adapter classified it — kind
 * ACCOUNT_ACTION_REQUIRED, Cursor's words, admission true — or, from a runner older than the kinds, with no failure
 * field at all. Nothing writes account health but the controller's own ingest. What is proven:
 *
 * - run 2 routes to another account, at the tier the task asked for, with the refusal not counted;
 * - from an old runner (no failure field, the bare sentence, no cost) the breaker demotes the account on strike 1,
 *   so run 2 still routes elsewhere;
 * - five refusals on that one account spend none of the auto-run failure budget (five counted would retire the task);
 * - an account that is the only candidate holds the task with the provider's words, and the hold lifts at
 *   blocked_until, when the held task's run takes the account's trial.
 */

const URL = process.env.COORDINATOR_PG_URL;
const skip = !URL;
const RUN = randomUUID().slice(0, 8);
const OPUS = 'claude-opus-5-5';
const SONNET = 'claude-sonnet-5-5';
/** The provider's own words (cursor_events.go cursorTurnFailure), and the session error the runner wrote with them. */
const PAYMENT = 'Add a payment method to continue';
const CURSOR_ERROR = `Cursor said: "${PAYMENT}." The Cursor account needs this before the session can go on.`;

interface Services {
  db: PrismaClient;
  tasks: TasksService;
  /** The runner's door: finalize and turn-complete, with account health wired in as Nest wires it. */
  api: RunnerApiController;
}

function connect(): Services {
  const db = prismaClientFor(URL!);
  const prisma = db as unknown as PrismaService;
  const publishes = new Proxy({}, { get: () => () => undefined }) as unknown as RealtimeService;
  const queue = new QueueService(prisma, publishes);
  const sessions = new SessionsService(prisma, queue, publishes);
  // RunnerApiController's positional constructor (as run-failure-kind.pg.spec.ts builds it): the six it requires, the
  // sessions service at 12, nothing else optional until account health at 34.
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
  return { db, tasks: new TasksService(prisma, sessions, publishes), api };
}

interface Fixture {
  ownerId: string;
  runnerId: string;
  agentId: string;
  projectId: string;
}

/**
 * An owner with smart selection on (Cost), a runner that has Cursor CLI and Claude Code — or, with `cursorOnly`, Cursor
 * alone — and an Agent whose own engine is Cursor: its last conversation ran there, as the owner's did in the incident.
 */
async function fixture(db: PrismaClient, label: string, { cursorOnly = false, started = false } = {}): Promise<Fixture> {
  const f = { ownerId: randomUUID(), runnerId: randomUUID(), agentId: randomUUID(), projectId: randomUUID() };
  await db.user.create({
    data: {
      id: f.ownerId, email: `${label}-${RUN}-${f.ownerId}@health.invalid`, name: label, passwordHash: 'x',
      preferences: { modelRouting: true, optimizeFor: 'cost' },
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
      modelCatalog: cursorOnly ? { cursor: models } : { claude: models, cursor: models },
      runtimeDefaultModels: cursorOnly ? { cursor: OPUS } : { claude: OPUS, cursor: OPUS },
    },
  });
  await db.workspace.create({ data: { id: f.agentId, ownerId: f.ownerId, runnerId: f.runnerId, name: `${label}-agent`, enabled: true } });
  // Started, when a case needs the automatic door: nothing starts a task by itself in a project its owner has not started.
  await db.project.create({
    data: { id: f.projectId, ownerId: f.ownerId, title: label, coordinatorEnabled: false, maxConcurrentTasks: 10, startedAt: started ? new Date() : null },
  });
  if (started) await establishProjectContractForPgTest(db, f.ownerId, f.projectId, label);
  // The Agent's own engine: the one its owner's last conversation on it ran on.
  await db.session.create({
    data: {
      ownerId: f.ownerId, creatorId: f.ownerId, prompt: 'hello', workspaceId: f.agentId, title: 'a conversation on Cursor',
      provider: 'cursor', providerBuiltin: true,
      engine: 'cursor', turnState: null, createdAt: new Date(Date.now() - 3_600_000),
    },
  });
  return f;
}

async function taskIn(db: PrismaClient, f: Fixture, seed: Partial<Prisma.TaskUncheckedCreateInput> = {}) {
  const task = await db.task.create({
    data: {
      ownerId: f.ownerId, projectId: f.projectId, assigneeId: f.agentId, title: 'the incident task',
      creatorType: CreatorType.USER, creatorId: f.ownerId, completionCriterion: 'EVIDENCE_JUDGMENT',
      modelHint: 'L', modelHintReason: 'a routing change', ...seed,
    },
  });
  return task.id;
}

async function runNow(s: Services, f: Fixture, taskId: string): Promise<string> {
  const result = await s.tasks.execute(f.ownerId, taskId, undefined, randomUUID());
  assert.ok(result.sessionId, `Run Now must answer with a Session, got ${JSON.stringify(result)}`);
  return result.sessionId;
}

/** The runner claimed the run: it is RUNNING on the fixture's runner, started a moment ago, with its first turn out. */
async function claimed(s: Services, f: Fixture, sessionId: string): Promise<string> {
  // As the claim does it: the acquisition guards admit the move to RUNNING only in a transaction that declared it reads
  // session engines (session_acquisition_engine_guard) and that the runner supports Cursor, onto a runner that reports
  // it (session_cursor_runner_acquisition_guard).
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

/** What a runner of this release sends when Cursor refuses: the adapter's kind, the provider's words, admission. */
const CLASSIFIED = {
  error: CURSOR_ERROR,
  failure: { kind: RunFailureKind.ACCOUNT_ACTION_REQUIRED, said: PAYMENT },
  admission: true,
};

/**
 * Cursor refuses the claimed run at admission, and the runner reports it as the incident's runner did: by POSTing its
 * finalize, or with `turn` its turn-complete, to the runner API. `old`: a runner older than the kinds, which sends no
 * failure field and no admission flag — only the sentence, at no cost.
 */
async function refusedByCursor(s: Services, f: Fixture, sessionId: string, { old = false, via = 'finalize' as 'finalize' | 'turn' } = {}) {
  const turnId = await claimed(s, f, sessionId);
  const body = old ? { error: PAYMENT } : CLASSIFIED;
  if (via === 'turn') {
    await s.api.turnComplete({ id: f.runnerId }, sessionId, {
      turnId, status: SharedRunStatus.FAILED, subtype: 'error', numTurns: 1, costUsd: 0, ...body,
    } as never);
  } else {
    await s.api.finalize({ id: f.runnerId }, sessionId, { status: SharedRunStatus.FAILED, ...body } as never);
  }
  assert.equal(wordOf((await s.db.session.findUniqueOrThrow({ where: { id: sessionId }, select: WORD_SELECT }))), RunStatus.FAILED);
}

const runOf = (db: PrismaClient, id: string) => db.session.findUniqueOrThrow({
  where: { id }, select: { provider: true, engine: true, model: true, effort: true, accountHealthEffect: true },
});
const decisionOf = (db: PrismaClient, sessionId: string) => db.taskRouteDecision.findFirstOrThrow({ where: { sessionId } });
const liveHealth = (db: PrismaClient, ownerId: string) =>
  db.accountHealth.findMany({ where: { ownerId, clearedAt: null }, orderBy: { createdAt: 'asc' } });
/** The auto-run sweep's failure budget for these tasks (TasksService.autoRunHoldOff): held, and until when. */
const holdOff = (s: Services, taskIds: string[]) =>
  (s.tasks as unknown as { autoRunHoldOff(ids: string[], blind: ReadonlySet<string>): Promise<Map<string, Date | null>> })
    .autoRunHoldOff(taskIds, new Set());

test('the incident replayed: Cursor refuses run 1 with "Add a payment method to continue"; run 2 routes elsewhere, the tier is not raised, the budget is not spent',
  { skip, timeout: 120_000 }, async () => {
    assertCoordinatorPgUrlIsIsolated(URL!);
    const s = connect();
    try {
      const f = await fixture(s.db, 'incident');
      const taskId = await taskIn(s.db, f);

      const run1 = await runNow(s, f, taskId);
      const first = await runOf(s.db, run1);
      assert.deepEqual([first.provider, first.engine, first.model, first.accountHealthEffect], ['cursor', 'cursor', OPUS, null],
        'run 1 starts on the Agent\'s own Cursor sign-in, as in the incident');
      await refusedByCursor(s, f, run1);

      // The account is blocked for an hour on the classified ladder, with the provider's words.
      const [row] = await liveHealth(s.db, f.ownerId);
      assert.equal(row.subjectKey, `runner:${f.runnerId}:cursor:default`);
      assert.deepEqual([row.state, row.kind, row.said, row.trips], ['BLOCKED', 'ACCOUNT_ACTION_REQUIRED', PAYMENT, 1]);
      const hour = row.blockedUntil!.getTime() - row.lastAt.getTime();
      assert.equal(hour, 3_600_000);
      assert.equal((await runOf(s.db, run1)).accountHealthEffect, 'BLOCKED', 'the run records that its failure was the account\'s');

      const run2 = await runNow(s, f, taskId);
      const second = await runOf(s.db, run2);
      assert.deepEqual([second.provider, second.engine], ['claude', 'claude'], 'run 2 goes to the account that can run');
      const decision = await decisionOf(s.db, run2);
      assert.equal(decision.level, 'L', 'the tier the task asked for, not one up');
      const features = decision.features as Record<string, unknown>;
      assert.equal(features.escalatedFrom, null);
      assert.equal(features.priorFailures, 0);
      assert.equal(features.accountFailuresSkipped, 1);
      assert.ok(decision.reasons.includes('Run 1 was refused by its account before it started — not counted'), decision.reasons.join(' | '));
      assert.ok(!decision.reasons.some((r) => r.startsWith('[escalate]')), decision.reasons.join(' | '));
      assert.equal(decision.policyVersion, 4);

      // The retry budget: the refusal is not one of the task's failures.
      assert.equal((await holdOff(s, [taskId])).has(taskId), false);
    } finally {
      await s.db.$disconnect();
    }
  });

test('from a runner older than the kinds, the bare sentence at no cost goes through the breaker: suspect on strike 1, and run 2 still routes elsewhere',
  { skip, timeout: 120_000 }, async () => {
    assertCoordinatorPgUrlIsIsolated(URL!);
    const s = connect();
    try {
      const f = await fixture(s.db, 'old-runner');
      const taskId = await taskIn(s.db, f);
      const run1 = await runNow(s, f, taskId);
      assert.equal((await runOf(s.db, run1)).provider, 'cursor');
      await refusedByCursor(s, f, run1, { old: true });

      const stored = await s.db.session.findUniqueOrThrow({
        where: { id: run1 }, select: { error: true, failureKind: true, admissionFailure: true, costUsd: true, accountHealthEffect: true },
      });
      assert.deepEqual(stored, { error: PAYMENT, failureKind: null, admissionFailure: null, costUsd: 0, accountHealthEffect: 'SUSPECT' },
        'no kind and no flag from the old runner; the server derived the admission and the breaker struck');
      const [row] = await liveHealth(s.db, f.ownerId);
      assert.equal(row.subjectKey, `runner:${f.runnerId}:cursor:default`);
      assert.deepEqual([row.state, row.kind, row.strikes, row.trips, row.blockedUntil], ['SUSPECT', 'UNCLASSIFIED_ADMISSION', 1, 0, null]);

      const run2 = await runNow(s, f, taskId);
      assert.equal((await runOf(s.db, run2)).provider, 'claude', 'the suspect account is not kept for being the Agent\'s own');
      const decision = await decisionOf(s.db, run2);
      assert.equal(decision.level, 'L');
      assert.equal((decision.features as Record<string, unknown>).escalatedFrom, null);
      assert.ok(decision.reasons.includes('Run 1 failed to start at no cost — not counted'), decision.reasons.join(' | '));
      assert.equal((await holdOff(s, [taskId])).has(taskId), false);
    } finally {
      await s.db.$disconnect();
    }
  });

test('five refusals on one account, the incident\'s count, spend none of the retry budget and raise no tier; counted, they would retire the task',
  { skip, timeout: 120_000 }, async () => {
    assertCoordinatorPgUrlIsIsolated(URL!);
    const s = connect();
    try {
      const f = await fixture(s.db, 'five');
      const taskId = await taskIn(s.db, f);
      // The incident's five runs on the one Cursor account, each reported by its runner: the first two by a runner older
      // than the kinds (a finalize with no failure field: the breaker reads them), the last three with Cursor's sentence
      // classified, two by turn-complete and one by finalize.
      const refused: string[] = [];
      for (let i = 0; i < 5; i += 1) {
        const run = await s.db.session.create({
          data: {
            ownerId: f.ownerId, creatorId: f.ownerId, prompt: 'the brief', workspaceId: f.agentId, taskId, startsTaskWork: true,
            title: 'Task: the incident task',
            provider: 'cursor', providerBuiltin: true, engine: 'cursor', model: OPUS, assignedRunnerId: f.runnerId,
            turnState: 'IN_FLIGHT', createdAt: new Date(Date.now() - (10 - i) * 60_000),
            // Refused at once: an older runner's admission is derived from a start this close to the end (§5.2).
            startedAt: new Date(Date.now() - 1_000),
          },
        });
        await refusedByCursor(s, f, run.id, { old: i < 2, via: i === 2 || i === 3 ? 'turn' : 'finalize' });
        refused.push(run.id);
      }
      const effects = await s.db.session.findMany({ where: { id: { in: refused } }, select: { id: true, accountHealthEffect: true } });
      assert.deepEqual(refused.map((id) => effects.find((e) => e.id === id)!.accountHealthEffect),
        ['SUSPECT', 'BLOCKED', 'BLOCKED', 'BLOCKED', 'BLOCKED'],
        'a strike, a breaker trip, then three refusals of the blocked account: health acted on every one');
      assert.equal(MAX_AUTO_RUN_FAILURES, 5);
      assert.equal((await holdOff(s, [taskId])).has(taskId), false, 'not one of the five is spent from the budget');

      const next = await runNow(s, f, taskId);
      assert.equal((await runOf(s.db, next)).provider, 'claude');
      const decision = await decisionOf(s.db, next);
      assert.equal(decision.level, 'L');
      assert.equal((decision.features as Record<string, unknown>).priorFailures, 0);
      assert.ok(decision.reasons.includes('Run 1 failed to start at no cost — not counted'), decision.reasons.join(' | '));
      assert.ok(decision.reasons.includes('Run 5 was refused by its account before it started — not counted'), decision.reasons.join(' | '));

      // The control: the same five as ordinary failures (no kind, nothing health did) retire the task, as they did.
      await s.db.session.updateMany({ where: { id: { in: refused } }, data: { failureKind: null, accountHealthEffect: null, error: 'the engine exited 1' } });
      assert.equal((await holdOff(s, [taskId])).get(taskId), null, 'five counted failures are MAX_AUTO_RUN_FAILURES: left for a person');
    } finally {
      await s.db.$disconnect();
    }
  });

test('a blocked only candidate holds the task with the provider\'s words, and the hold lifts at blocked_until, when its run takes the trial',
  { skip, timeout: 120_000 }, async () => {
    assertCoordinatorPgUrlIsIsolated(URL!);
    const s = connect();
    try {
      const f = await fixture(s.db, 'held', { cursorOnly: true, started: true });
      const taskId = await taskIn(s.db, f);
      const run1 = await runNow(s, f, taskId);
      assert.equal((await runOf(s.db, run1)).provider, 'cursor');
      await refusedByCursor(s, f, run1);
      const [row] = await liveHealth(s.db, f.ownerId);
      const until = row.blockedUntil!;

      // A person's start is refused with the reason and when the account is tried again.
      await assert.rejects(s.tasks.execute(f.ownerId, taskId, undefined, randomUUID()), (error: unknown) => {
        assert.ok(error instanceof ConflictException);
        const body = error.getResponse() as { code: string; message: string; hold: { until: string; accounts: Array<{ provider: string }> } };
        assert.equal(body.code, 'ACCOUNT_NEEDS_ACTION');
        assert.equal(body.hold.until, until.toISOString());
        assert.deepEqual(body.hold.accounts.map((a) => a.provider), ['cursor']);
        assert.match(body.message, /^Waiting for an account: The account needs your action: Cursor CLI said "Add a payment method to continue" \(since .*; tried again at .*\)\. Next try at .*\.$/);
        return true;
      });
      // The automatic start stands down, released: the same moment starts the task once the hold lifts.
      await s.db.task.update({ where: { id: taskId }, data: { autoRunWhenReady: true } });
      const [{ epoch }] = await s.db.$queryRaw<Array<{ epoch: bigint }>>`
        SELECT COALESCE((SELECT epoch FROM task_dispatch_epoch WHERE task_id = ${taskId}::uuid), 0)::bigint AS epoch`;
      const token = TASK_RUN_TRIGGER.dependency(taskId, epoch);
      assert.deepEqual(await s.tasks.execute(f.ownerId, taskId, { observedEpoch: epoch }, token), { ok: false, skipped: 'account-needs-action' });
      // The task read says why.
      const detail = await s.tasks.get(f.ownerId, taskId) as unknown as { accountHold: { kind: string; until: string } | null };
      assert.equal(detail.accountHold?.kind, 'ACCOUNT_NEEDS_ACTION');
      assert.equal(detail.accountHold?.until, until.toISOString());
      assert.equal(await s.db.session.count({ where: { taskId, startsTaskWork: true } }), 1, 'no run was started on the blocked account');

      // At blocked_until the hold lifts by itself: the same automatic moment starts the run, which takes the trial.
      const later = new Date(until.getTime() + 1_000);
      (s.tasks as unknown as { now: () => Date }).now = () => later;
      const answer = await s.tasks.execute(f.ownerId, taskId, { observedEpoch: epoch }, token);
      assert.equal(answer.ok, true, JSON.stringify(answer));
      const trial = answer.sessionId!;
      assert.equal((await runOf(s.db, trial)).provider, 'cursor');
      const [tried] = await liveHealth(s.db, f.ownerId);
      assert.equal(tried.trialSessionId, trial, 'the held task\'s run is the account\'s one trial');
      const reasons = (await decisionOf(s.db, trial)).reasons;
      assert.ok(reasons.some((r) => r.startsWith('Trying cursor again: it last refused a run at ')), reasons.join(' | '));
      assert.equal((await s.tasks.get(f.ownerId, taskId) as unknown as { accountHold: unknown }).accountHold, null);
    } finally {
      await s.db.$disconnect();
    }
  });
