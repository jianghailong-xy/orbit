import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import {
  CreatorType,
  Prisma,
  PrismaClient,
  ProjectAutomationPolicy,
  ProjectRole,
  RunStatus,
  RunnerStatus,
  SessionDispatchOrigin,
  SessionRunSource,
} from '@prisma/client';
import { uuidToBase62 } from '@orbit/shared';
import { Client } from 'pg';
import { PrismaService } from '../prisma/prisma.service';
import { QueueService } from '../queue/queue.service';
import { RealtimeService } from '../realtime/realtime.service';
import { ProjectAuthorizationService } from './project-authorization.service';
import {
  createDecisionId,
  planProjectDecision,
  ProjectDecisionService,
} from './project-decision.service';
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from './coordinator-pg-test-safety';
import { ProjectEventsService } from './project-events.service';
import { ProjectReconcileLease, ProjectReconcileService } from './project-reconcile.service';
import {
  ProjectTaskDispatchCommand,
  ProjectTaskDispatcherService,
} from './project-task-dispatcher.service';
import { prismaClientFor } from '../prisma/prisma-client';

const URL = process.env.COORDINATOR_PG_URL;

interface Fixture {
  ownerId: string;
  projectId: string;
  workspaceId: string;
  runnerId: string;
  taskId: string;
}

async function fixture(
  db: PrismaClient,
  label: string,
  options: {
    policy?: ProjectAutomationPolicy;
    provider?: string;
    runnerStatus?: RunnerStatus;
    sessionBudgetPerDay?: number | null;
    maxConcurrentTasks?: number;
  } = {},
): Promise<Fixture> {
  const ownerId = randomUUID();
  const runnerId = randomUUID();
  const workspaceId = randomUUID();
  const projectId = randomUUID();
  const taskId = randomUUID();
  await db.user.create({
    data: { id: ownerId, email: `${label}-${ownerId}@pcc13.invalid`, name: label, passwordHash: 'x' },
  });
  await db.runner.create({
    data: {
      id: runnerId,
      ownerId,
      name: `${label}-runner`,
      tokenHash: 'x',
      status: options.runnerStatus ?? RunnerStatus.ONLINE,
      capabilities: ['session-orchestration-credential-v1'],
      capabilitiesReportedAt: new Date(),
    },
  });
  await db.workspace.create({
    data: {
      id: workspaceId,
      ownerId,
      runnerId,
      name: `${label}-agent`,
      enabled: true,
      canCreateTasks: true,
      canDelegate: true,
    },
  });
  await db.project.create({
    data: {
      id: projectId,
      ownerId,
      title: label,
      coordinatorEnabled: true,
      automationPolicy: options.policy ?? ProjectAutomationPolicy.AUTO,
      maxConcurrentTasks: options.maxConcurrentTasks ?? 3,
      sessionBudgetPerDay: options.sessionBudgetPerDay,
    },
  });
  await db.projectRuntime.upsert({
    where: { projectId },
    create: { projectId },
    update: {},
  });
  await db.projectMember.create({
    data: { projectId, agentId: workspaceId, role: ProjectRole.COORDINATOR },
  });
  await db.task.create({
    data: {
      id: taskId,
      ownerId,
      projectId,
      assigneeId: workspaceId,
      title: `${label}-task`,
      creatorType: CreatorType.USER,
      creatorId: ownerId,
      provider: options.provider ?? 'codex',
    },
  });
  return { ownerId, projectId, workspaceId, runnerId, taskId };
}

async function plannedDispatch(
  db: PrismaClient,
  decisions: ProjectDecisionService,
  reconciler: ProjectReconcileService,
  target: Fixture,
): Promise<{ lease: ProjectReconcileLease; command: ProjectTaskDispatchCommand }> {
  const lease = await reconciler.acquireLease(target.projectId);
  assert.ok(lease);
  const decisionId = createDecisionId();
  const idempotencyKey = `pc:v1:${target.projectId}:dispatch:${target.taskId}:1`;
  await db.$transaction(async (tx) => {
    const captured = await decisions.capture(tx, target.projectId);
    const outcome = planProjectDecision(captured.input, {
      decisionId,
      actions: [{
        type: 'DISPATCH_TASK',
        idempotencyKey,
        subject: { type: 'TASK', id: uuidToBase62(target.taskId) },
      }],
    });
    await decisions.persist(tx, captured, outcome, decisionId);
  }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
  return { lease, command: { decisionId, taskId: target.taskId, idempotencyKey } };
}

async function assertNoSessionAndStructuredFailure(
  db: PrismaClient,
  dispatcher: ProjectTaskDispatcherService,
  planned: Awaited<ReturnType<typeof plannedDispatch>>,
  expectedReason: string,
): Promise<void> {
  const result = await dispatcher.dispatch(planned.lease, planned.command);
  assert.equal(result.sessionId, null);
  assert.equal(await db.session.count({ where: { taskId: planned.command.taskId } }), 0);
  const action = await db.projectAction.findUniqueOrThrow({ where: { id: result.action.actionId } });
  assert.equal(action.status, 'REFUSED');
  const detail = action.detail as Record<string, { reasonCode?: string }>;
  assert.equal(detail.dispatchFailure?.reasonCode, expectedReason);
  assert.equal(action.reasonCode ?? detail.dispatchFailure?.reasonCode, expectedReason);
}

test('Project dispatcher is exactly-once, fail-closed and legacy-compatible on PostgreSQL',
  { skip: !URL, timeout: 60_000 }, async () => {
    assertCoordinatorPgUrlIsIsolated(URL);
    const identity = new Client({ connectionString: URL, connectionTimeoutMillis: 2_000 });
    await identity.connect();
    await verifyCoordinatorPgIdentity(identity);
    const migrated = await identity.query<{ count: string }>(`
      SELECT count(*)::text AS count FROM "_prisma_migrations"
       WHERE "migration_name" = '0122_project_dispatch_boundary' AND "finished_at" IS NOT NULL
    `);
    assert.equal(migrated.rows[0]?.count, '1', 'the isolated database must have migration 0122');
    await identity.end();

    const db = prismaClientFor(URL);
    const prisma = db as unknown as PrismaService;
    const events = new ProjectEventsService(prisma);
    const decisions = new ProjectDecisionService(prisma);
    const reconciler = new ProjectReconcileService(prisma, events, decisions);
    const notifications: string[] = [];
    const dispatcher = new ProjectTaskDispatcherService(
      prisma,
      reconciler,
      new ProjectAuthorizationService(),
      { notifySessionQueued: () => notifications.push('queue') } as unknown as QueueService,
      { publishSessionCreated: (id: string) => notifications.push(id) } as unknown as RealtimeService,
    );
    try {
      const concurrent = await fixture(db, 'concurrent');
      const planned = await plannedDispatch(db, decisions, reconciler, concurrent);
      const [first, second] = await Promise.all([
        dispatcher.dispatch(planned.lease, planned.command),
        dispatcher.dispatch(planned.lease, planned.command),
      ]);
      const restartedDispatcher = new ProjectTaskDispatcherService(
        prisma,
        new ProjectReconcileService(prisma, events, decisions),
        new ProjectAuthorizationService(),
        { notifySessionQueued: () => notifications.push('queue') } as unknown as QueueService,
        { publishSessionCreated: (id: string) => notifications.push(id) } as unknown as RealtimeService,
      );
      const replay = await restartedDispatcher.dispatch(planned.lease, planned.command);
      assert.equal(await db.session.count({ where: { taskId: concurrent.taskId } }), 1);
      assert.equal(first.sessionId, second.sessionId);
      assert.equal(second.sessionId, replay.sessionId);
      const session = await db.session.findFirstOrThrow({ where: { taskId: concurrent.taskId } });
      assert.equal(session.runSource, SessionRunSource.PROJECT_COORDINATOR);
      assert.equal(session.dispatchOrigin, SessionDispatchOrigin.PROJECT_COORDINATOR);
      assert.ok(session.projectActionId && session.resolution && session.snapshotFrozenAt);
      const resolution = session.resolution as Record<string, unknown>;
      assert.deepEqual(Object.keys(resolution).sort(), ['v', 'where', 'who', 'with']);
      assert.equal((resolution.who as Record<string, unknown>).agentId, concurrent.workspaceId);
      assert.equal((resolution.where as Record<string, unknown>).runnerId, concurrent.runnerId);
      const applied = await db.projectAction.findUniqueOrThrow({ where: { id: session.projectActionId } });
      assert.equal(applied.resultSessionId, session.id);
      assert.ok(applied.executionContextDigest && applied.executionResultDigest);

      const unauthorized = await fixture(db, 'unauthorized', { policy: ProjectAutomationPolicy.MANUAL });
      await assertNoSessionAndStructuredFailure(
        db, dispatcher, await plannedDispatch(db, decisions, reconciler, unauthorized),
        'POLICY_REQUIRES_APPROVAL',
      );

      const stale = await fixture(db, 'stale');
      const stalePlan = await plannedDispatch(db, decisions, reconciler, stale);
      await db.task.update({ where: { id: stale.taskId }, data: { title: 'snapshot changed' } });
      await assertNoSessionAndStructuredFailure(db, dispatcher, stalePlan, 'STALE_SNAPSHOT');

      const dependency = await fixture(db, 'dependency');
      const prerequisite = await db.task.create({
        data: {
          ownerId: dependency.ownerId,
          projectId: dependency.projectId,
          assigneeId: dependency.workspaceId,
          title: 'unfinished prerequisite',
          creatorType: CreatorType.USER,
          creatorId: dependency.ownerId,
        },
      });
      await db.taskDependency.create({
        data: { taskId: dependency.taskId, dependsOnTaskId: prerequisite.id },
      });
      await assertNoSessionAndStructuredFailure(
        db, dispatcher, await plannedDispatch(db, decisions, reconciler, dependency),
        'TASK_DEPENDENCIES_INCOMPLETE',
      );

      const budget = await fixture(db, 'budget', { sessionBudgetPerDay: 0 });
      await assertNoSessionAndStructuredFailure(
        db, dispatcher, await plannedDispatch(db, decisions, reconciler, budget),
        'SESSION_BUDGET_EXHAUSTED',
      );

      const capacity = await fixture(db, 'capacity', { maxConcurrentTasks: 1 });
      const occupyingTask = await db.task.create({
        data: {
          ownerId: capacity.ownerId,
          projectId: capacity.projectId,
          assigneeId: capacity.workspaceId,
          title: 'occupying',
          creatorType: CreatorType.USER,
          creatorId: capacity.ownerId,
        },
      });
      await db.session.create({
        data: {
          title: 'manual capacity claim',
          prompt: 'manual',
          ownerId: capacity.ownerId,
          creatorId: capacity.ownerId,
          taskId: occupyingTask.id,
          workspaceId: capacity.workspaceId,
          assignedRunnerId: capacity.runnerId,
          status: RunStatus.PENDING,
          provider: 'codex',
          providerBuiltin: true,
          usesRuntimeDefaultModel: true,
          source: 'user',
          dispatchOrigin: SessionDispatchOrigin.USER,
          runSource: SessionRunSource.MANUAL,
        },
      });
      await assertNoSessionAndStructuredFailure(
        db, dispatcher, await plannedDispatch(db, decisions, reconciler, capacity),
        'PROJECT_CONCURRENCY_LIMIT',
      );

      const noRunner = await fixture(db, 'no-runner', { runnerStatus: RunnerStatus.OFFLINE });
      await assertNoSessionAndStructuredFailure(
        db, dispatcher, await plannedDispatch(db, decisions, reconciler, noRunner),
        'RUNNER_UNAVAILABLE',
      );

      const noProvider = await fixture(db, 'no-provider', { provider: 'not-configured' });
      await assertNoSessionAndStructuredFailure(
        db, dispatcher, await plannedDispatch(db, decisions, reconciler, noProvider),
        'PROVIDER_UNAVAILABLE',
      );

      const legacy = await fixture(db, 'legacy');
      await db.project.update({
        where: { id: legacy.projectId }, data: { coordinatorEnabled: false },
      });
      const legacyTask = await db.task.create({
        data: {
          ownerId: legacy.ownerId,
          assigneeId: legacy.workspaceId,
          title: 'legacy task-list run',
          creatorType: CreatorType.USER,
          creatorId: legacy.ownerId,
        },
      });
      const legacySession = await db.session.create({
        data: {
          title: 'legacy', prompt: 'legacy', ownerId: legacy.ownerId, creatorId: legacy.ownerId,
          taskId: legacyTask.id, workspaceId: legacy.workspaceId,
          assignedRunnerId: legacy.runnerId, status: RunStatus.PENDING,
          provider: 'codex', providerBuiltin: true, usesRuntimeDefaultModel: true, source: 'user',
          dispatchOrigin: SessionDispatchOrigin.LEGACY_SWEEP,
          runSource: SessionRunSource.TASK_LIST_AUTO,
        },
      });
      assert.equal(legacySession.runSource, SessionRunSource.TASK_LIST_AUTO);
      const manualTask = await db.task.create({
        data: {
          ownerId: concurrent.ownerId,
          projectId: concurrent.projectId,
          assigneeId: concurrent.workspaceId,
          title: 'manual remains compatible',
          creatorType: CreatorType.USER,
          creatorId: concurrent.ownerId,
        },
      });
      await assert.rejects(
        db.session.create({
          data: {
            title: 'legacy bypass rejected', prompt: 'legacy bypass rejected',
            ownerId: concurrent.ownerId, creatorId: concurrent.ownerId,
            taskId: manualTask.id, workspaceId: concurrent.workspaceId,
            assignedRunnerId: concurrent.runnerId, status: RunStatus.PENDING,
            provider: 'codex', providerBuiltin: true, usesRuntimeDefaultModel: true,
            source: 'user', dispatchOrigin: SessionDispatchOrigin.LEGACY_SWEEP,
            runSource: SessionRunSource.TASK_LIST_AUTO,
          },
        }),
        /DISPATCH_AUTHORITY_VIOLATION: task .* is Coordinator-authority/,
      );
      const manual = await db.session.create({
        data: {
          title: 'manual', prompt: 'manual', ownerId: concurrent.ownerId,
          creatorId: concurrent.ownerId, taskId: manualTask.id,
          workspaceId: concurrent.workspaceId, assignedRunnerId: concurrent.runnerId,
          status: RunStatus.PENDING, provider: 'codex', providerBuiltin: true,
          usesRuntimeDefaultModel: true, source: 'user',
          dispatchOrigin: SessionDispatchOrigin.USER, runSource: SessionRunSource.MANUAL,
        },
      });
      assert.equal(manual.runSource, SessionRunSource.MANUAL);
    } finally {
      await db.$disconnect();
    }
  });
