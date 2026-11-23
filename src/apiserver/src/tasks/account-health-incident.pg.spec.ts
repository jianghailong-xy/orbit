import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import { ConflictException } from '@nestjs/common';
import { CreatorType, Prisma, PrismaClient, RunStatus, RunnerStatus } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import { prismaClientFor } from '../prisma/prisma-client';
import { assertCoordinatorPgUrlIsIsolated } from '../projects/coordinator-pg-test-safety';
import { establishProjectContractForPgTest } from '../projects/project-contract-test-helper';
import { AccountHealthService } from '../providers/account-health.service';
import { QueueService } from '../queue/queue.service';
import { RealtimeService } from '../realtime/realtime.service';
import { SessionsService } from '../sessions/sessions.service';
import { MAX_AUTO_RUN_FAILURES } from './task-retry-policy';
import { TASK_RUN_TRIGGER } from './task-run-identity';
import { TasksService } from './tasks.service';

/**
 * The incident of docs/routing-account-health-design.md §1, replayed against a real PostgreSQL (§10, phase 1): from
 * 2026-11-22 17:19 every run was routed to the owner's Cursor subscription, Cursor refused each at once with
 * "Add a payment method to continue", and each refusal raised the task's tier and spent its retry budget.
 *
 * Driven through the doors a run really passes: Run Now (`execute`) routes and creates the Session; the run ends as
 * the runner's finalize leaves it (FAILED, its kind, the provider's words, admission); and AccountHealthService
 * .afterRunEnd is the call the finalize and turn-complete ingest make once that release has committed. What is proven:
 *
 * - run 2 routes to another account, at the tier the task asked for, with the refusal not counted;
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
  health: AccountHealthService;
}

function connect(): Services {
  const db = prismaClientFor(URL!);
  const prisma = db as unknown as PrismaService;
  const publishes = new Proxy({}, { get: () => () => undefined }) as unknown as RealtimeService;
  const sessions = new SessionsService(prisma, { notifySessionQueued: () => undefined } as unknown as QueueService, publishes);
  return { db, tasks: new TasksService(prisma, sessions, publishes), health: new AccountHealthService(prisma) };
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
      engine: 'cursor', status: RunStatus.AWAITING_INPUT, createdAt: new Date(Date.now() - 3_600_000),
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

/** The run ends as the runner's finalize leaves a run Cursor refused at admission, and the ingest hands it to health. */
async function refusedByCursor(s: Services, sessionId: string, { classified = true } = {}) {
  await s.db.session.update({
    where: { id: sessionId },
    data: {
      status: RunStatus.FAILED, finishedAt: new Date(), error: CURSOR_ERROR,
      // A runner of this release classifies the sentence; an older one sends no kind and no admission flag.
      ...(classified ? { failureKind: 'ACCOUNT_ACTION_REQUIRED', failureSaid: PAYMENT, admissionFailure: true } : {}),
    },
  });
  await s.health.afterRunEnd(sessionId, { failed: true });
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
      await refusedByCursor(s, run1);

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
      assert.equal(decision.policyVersion, 3);

      // The retry budget: the refusal is not one of the task's failures.
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
      // The incident's five runs on the one Cursor account, each released FAILED as the runner left it: the first two
      // from a runner older than the kinds (no kind, no admission flag: the breaker reads them), the last three with
      // Cursor's sentence classified. Each handed to health as the ingest hands it.
      const refused: string[] = [];
      for (let i = 0; i < 5; i += 1) {
        const run = await s.db.session.create({
          data: {
            ownerId: f.ownerId, creatorId: f.ownerId, prompt: 'the brief', workspaceId: f.agentId, taskId, startsTaskWork: true,
            title: 'Task: the incident task',
            provider: 'cursor', providerBuiltin: true, engine: 'cursor', model: OPUS, assignedRunnerId: f.runnerId,
            status: RunStatus.RUNNING, createdAt: new Date(Date.now() - (10 - i) * 60_000),
            // Refused at once: an older runner's admission is derived from a start this close to the end (§5.2).
            startedAt: new Date(Date.now() - 1_000),
          },
        });
        await refusedByCursor(s, run.id, { classified: i >= 2 });
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
      await refusedByCursor(s, run1);
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
