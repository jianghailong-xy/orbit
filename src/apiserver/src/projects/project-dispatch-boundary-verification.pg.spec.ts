import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
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
  TaskStatus,
} from '@prisma/client';
import { uuidToBase62 } from '@orbit/shared';
import { Client } from 'pg';
import { PrismaService } from '../prisma/prisma.service';
import { QueueService } from '../queue/queue.service';
import { RealtimeService } from '../realtime/realtime.service';
import { MAX_AUTO_RUN_FAILURES } from '../tasks/task-retry-policy';
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

/**
 * Unit 14: independent verification of the units 12 and 13 dispatch boundary on a real, private
 * PostgreSQL 16 server. This file adds no product behaviour — it only injects faults and counts
 * durable rows. Every scenario asserts how many Sessions exist afterwards, because the one thing
 * a dispatch boundary is for is that a refused decision leaves nothing running.
 *
 * `COORDINATOR_PG_RESTART_COMMAND` (optional) is the command that restarts the disposable server;
 * the durability scenario is only meaningful when the harness can actually bounce it.
 */

const URL = process.env.COORDINATOR_PG_URL;
const RESTART_COMMAND = process.env.COORDINATOR_PG_RESTART_COMMAND;
/** Provider slugs are globally unique and this database outlives a single run. */
const RUN = randomUUID().slice(0, 8);

interface Fixture {
  ownerId: string;
  projectId: string;
  agentId: string;
  runnerId: string;
  taskId: string;
}

interface FixtureOptions {
  policy?: ProjectAutomationPolicy;
  provider?: string;
  model?: string | null;
  runnerStatus?: RunnerStatus;
  capabilitiesReported?: boolean;
  runnerCapabilities?: string[];
  engines?: Prisma.InputJsonValue;
  sessionBudgetPerDay?: number | null;
  maxConcurrentTasks?: number;
  agentMaxConcurrentTasks?: number | null;
  providerFallbacks?: Array<{ provider: string; model?: string }>;
  agentEnabled?: boolean;
  memberRole?: ProjectRole;
  requiredCapabilities?: string[];
  coordinatorEnabled?: boolean;
  owner?: { ownerId: string; runnerId: string; agentId: string };
}

interface Services {
  db: PrismaClient;
  events: ProjectEventsService;
  decisions: ProjectDecisionService;
  reconciler: ProjectReconcileService;
  dispatcher: ProjectTaskDispatcherService;
  notifications: string[];
}

function connectServices(): Services {
  return servicesOn(new PrismaClient({ datasources: { db: { url: URL } } }));
}

function servicesOn(db: PrismaClient): Services {
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
    {
      publishSessionCreated: (id: string) => notifications.push(id),
    } as unknown as RealtimeService,
  );
  return { db, events, decisions, reconciler, dispatcher, notifications };
}

async function fixture(
  db: PrismaClient,
  label: string,
  options: FixtureOptions = {},
): Promise<Fixture> {
  const ownerId = options.owner?.ownerId ?? randomUUID();
  const runnerId = options.owner?.runnerId ?? randomUUID();
  const agentId = options.owner?.agentId ?? randomUUID();
  const projectId = randomUUID();
  const taskId = randomUUID();
  if (!options.owner) {
    await db.user.create({
      data: {
        id: ownerId,
        email: `${label}-${ownerId}@pcc14.invalid`,
        name: label,
        passwordHash: 'x',
      },
    });
    await db.runner.create({
      data: {
        id: runnerId,
        ownerId,
        name: `${label}-runner`,
        tokenHash: 'x',
        status: options.runnerStatus ?? RunnerStatus.ONLINE,
        capabilities: options.runnerCapabilities ?? ['session-orchestration-credential-v1'],
        capabilitiesReportedAt: options.capabilitiesReported === false ? null : new Date(),
        ...(options.engines === undefined ? {} : { engines: options.engines }),
      },
    });
    await db.workspace.create({
      data: {
        id: agentId,
        ownerId,
        runnerId,
        name: `${label}-agent`,
        enabled: options.agentEnabled ?? true,
        canCreateTasks: true,
        canDelegate: true,
        maxConcurrentTasks: options.agentMaxConcurrentTasks ?? null,
        providerFallbacks: (options.providerFallbacks ?? []) as unknown as Prisma.InputJsonValue,
      },
    });
  }
  await db.project.create({
    data: {
      id: projectId,
      ownerId,
      title: label,
      coordinatorEnabled: options.coordinatorEnabled ?? true,
      automationPolicy: options.policy ?? ProjectAutomationPolicy.AUTO,
      maxConcurrentTasks: options.maxConcurrentTasks ?? 3,
      sessionBudgetPerDay: options.sessionBudgetPerDay ?? null,
    },
  });
  // 0112/0113 install an AFTER INSERT trigger that seeds project_runtime. Creating it again here
  // would fail the project_id unique constraint before a single assertion ran.
  assert.equal(await db.projectRuntime.count({ where: { projectId } }), 1,
    'the database seeds exactly one ProjectRuntime per Project');
  await db.projectMember.create({
    data: { projectId, agentId, role: options.memberRole ?? ProjectRole.COORDINATOR },
  });
  await db.task.create({
    data: {
      id: taskId,
      ownerId,
      projectId,
      assigneeId: agentId,
      title: `${label}-task`,
      creatorType: CreatorType.USER,
      creatorId: ownerId,
      provider: options.provider ?? 'codex',
      model: options.model ?? null,
      requiredCapabilities: options.requiredCapabilities ?? [],
    },
  });
  return { ownerId, projectId, agentId, runnerId, taskId };
}

/** A lease is held for a minute, so a second plan for the same Project reuses the live one. */
const heldLeases = new Map<string, ProjectReconcileLease>();

async function leaseFor(
  services: Pick<Services, 'reconciler'>,
  projectId: string,
): Promise<ProjectReconcileLease> {
  const held = heldLeases.get(projectId);
  if (held) return held;
  const lease = await services.reconciler.acquireLease(projectId);
  assert.ok(lease, 'the fixture Project must be leasable');
  heldLeases.set(projectId, lease);
  return lease;
}

async function plan(
  services: Pick<Services, 'db' | 'decisions' | 'reconciler'>,
  target: Fixture,
  options: { attempt?: number; taskId?: string; lease?: ProjectReconcileLease } = {},
): Promise<{ lease: ProjectReconcileLease; command: ProjectTaskDispatchCommand }> {
  const taskId = options.taskId ?? target.taskId;
  const lease = options.lease ?? await leaseFor(services, target.projectId);
  const decisionId = createDecisionId();
  const idempotencyKey = `pc:v1:${target.projectId}:dispatch:${taskId}:${options.attempt ?? 1}`;
  await services.db.$transaction(async (tx) => {
    const captured = await services.decisions.capture(tx, target.projectId);
    const outcome = planProjectDecision(captured.input, {
      decisionId,
      actions: [{
        type: 'DISPATCH_TASK',
        idempotencyKey,
        subject: { type: 'TASK', id: uuidToBase62(taskId) },
      }],
    });
    await services.decisions.persist(tx, captured, outcome, decisionId);
  }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
  return { lease, command: { decisionId, taskId, idempotencyKey } };
}

async function sessionCount(db: PrismaClient, taskId: string): Promise<number> {
  return db.session.count({ where: { taskId } });
}

async function liveSessionCount(db: PrismaClient, taskId: string): Promise<number> {
  return db.session.count({
    where: { taskId, deletedAt: null, status: { in: [RunStatus.PENDING, RunStatus.RUNNING] } },
  });
}

/** A refusal is only useful if it is legible afterwards; assert the row, not just the return. */
async function expectRefusal(
  db: PrismaClient,
  dispatcher: ProjectTaskDispatcherService,
  planned: { lease: ProjectReconcileLease; command: ProjectTaskDispatchCommand },
  expectedReason: string | string[],
  options: { approval?: ProjectTaskDispatchCommand['approval'] } = {},
): Promise<string> {
  const expected = Array.isArray(expectedReason) ? expectedReason : [expectedReason];
  const before = await sessionCount(db, planned.command.taskId);
  const result = await dispatcher.dispatch(
    planned.lease,
    { ...planned.command, ...(options.approval ? { approval: options.approval } : {}) },
  );
  assert.equal(result.sessionId, null, `${expected.join('/')} must not produce a Session`);
  assert.equal(await sessionCount(db, planned.command.taskId), before,
    `${expected.join('/')} must not change the Session count`);
  const action = await db.projectAction.findUniqueOrThrow({ where: { id: result.action.actionId } });
  assert.ok(['REFUSED', 'SUPERSEDED'].includes(action.status),
    `a refused dispatch left the action in ${action.status}`);
  assert.equal(action.resultSessionId, null);
  const detail = action.detail as Record<string, { reasonCode?: string; retryable?: boolean }>;
  const reason = detail.dispatchFailure?.reasonCode;
  assert.ok(reason && expected.includes(reason),
    `expected one of ${expected.join('/')}, got ${String(reason)}`);
  assert.equal(action.reasonCode ?? reason, reason, 'the reason code must also be a column');
  assert.equal(typeof detail.dispatchFailure?.retryable, 'boolean',
    'a dispatch failure must say whether it is retryable');
  return reason!;
}

async function expectSession(
  db: PrismaClient,
  dispatcher: ProjectTaskDispatcherService,
  planned: { lease: ProjectReconcileLease; command: ProjectTaskDispatchCommand },
  options: { approval?: ProjectTaskDispatchCommand['approval'] } = {},
): Promise<string> {
  const result = await dispatcher.dispatch(
    planned.lease,
    { ...planned.command, ...(options.approval ? { approval: options.approval } : {}) },
  );
  assert.equal(result.action.status, 'APPLIED',
    `expected an applied dispatch, got ${JSON.stringify(result.action)}`);
  assert.ok(result.sessionId, 'an allowed dispatch must return its Session');
  assert.equal(await liveSessionCount(db, planned.command.taskId), 1,
    'an allowed dispatch must leave exactly one live claim on the Task');
  return result.sessionId!;
}

async function probeIdentity(): Promise<{ applied: string; count: string }> {
  assertCoordinatorPgUrlIsIsolated(URL);
  const client = new Client({ connectionString: URL, connectionTimeoutMillis: 5_000 });
  await client.connect();
  try {
    await verifyCoordinatorPgIdentity(client);
    const migrations = await client.query<{ applied: string; count: string }>(`
      SELECT count(*) FILTER (WHERE "finished_at" IS NOT NULL)::text AS applied,
             count(*)::text AS count
        FROM "_prisma_migrations"
    `);
    const boundary = await client.query<{ count: string }>(`
      SELECT count(*)::text AS count FROM "_prisma_migrations"
       WHERE "migration_name" IN ('0121_project_authorization_policy',
                                  '0122_project_dispatch_boundary')
         AND "finished_at" IS NOT NULL
    `);
    assert.equal(boundary.rows[0]?.count, '2', 'units 12 and 13 migrations must both be applied');
    return migrations.rows[0];
  } finally {
    await client.end();
  }
}

test('the target server is a disposable private PostgreSQL, never the shared Orbit cluster',
  { skip: !URL, timeout: 60_000 }, async () => {
    const migrations = await probeIdentity();
    assert.ok(Number(migrations.applied) > 0, 'the isolated database must be migrated');

    // A stray connection string in the environment is the realistic way a destructive spec ends
    // up on the shared cluster. Fail before the first fixture rather than after it.
    for (const [name, value] of Object.entries(process.env)) {
      if (typeof value !== 'string' || !/^postgres(ql)?:\/\//.test(value)) continue;
      assert.doesNotMatch(value, /orbit-postgres/i,
        `environment variable ${name} points at the shared Orbit cluster`);
    }
    const url = new global.URL(URL!);
    assert.ok(['127.0.0.1', 'localhost'].includes(url.hostname),
      'the disposable server must be loopback-only');
  });

test('all three strategies decide dispatch the same way end to end on real PostgreSQL',
  { skip: !URL, timeout: 180_000 }, async () => {
    const services = connectServices();
    try {
      const auto = await fixture(services.db, 'strategy-auto',
        { policy: ProjectAutomationPolicy.AUTO });
      const autoSession = await expectSession(services.db, services.dispatcher,
        await plan(services, auto));
      const session = await services.db.session.findUniqueOrThrow({ where: { id: autoSession } });
      assert.equal(session.runSource, SessionRunSource.PROJECT_COORDINATOR);
      assert.equal(session.dispatchOrigin, SessionDispatchOrigin.PROJECT_COORDINATOR);
      assert.equal(session.status, RunStatus.PENDING);
      assert.ok(session.projectActionId, 'the Session must name the action that authorized it');
      assert.ok(session.snapshotFrozenAt, 'the Session must carry its frozen snapshot time');
      const resolution = session.resolution as Record<string, Record<string, unknown>>;
      assert.deepEqual(Object.keys(resolution).sort(), ['v', 'where', 'who', 'with']);
      assert.equal(resolution.who.agentId, auto.agentId);
      assert.equal(resolution.where.runnerId, auto.runnerId);
      assert.equal(resolution.with.provider, 'codex');
      assert.equal(resolution.with.source, 'task-pin');

      const guarded = await fixture(services.db, 'strategy-guarded',
        { policy: ProjectAutomationPolicy.GUARDED_AUTO });
      await expectSession(services.db, services.dispatcher, await plan(services, guarded));

      const manual = await fixture(services.db, 'strategy-manual',
        { policy: ProjectAutomationPolicy.MANUAL });
      await expectRefusal(services.db, services.dispatcher, await plan(services, manual),
        'POLICY_REQUIRES_APPROVAL');

      // The high-risk attempt ceiling is refused under AUTO too, until a person answers.
      const ceiling = await fixture(services.db, 'strategy-max-attempts',
        { policy: ProjectAutomationPolicy.AUTO });
      for (let attempt = 0; attempt < MAX_AUTO_RUN_FAILURES; attempt += 1) {
        await services.db.session.create({
          data: {
            title: `failed ${attempt}`, prompt: 'x', ownerId: ceiling.ownerId,
            creatorId: ceiling.ownerId, taskId: ceiling.taskId, workspaceId: ceiling.agentId,
            assignedRunnerId: ceiling.runnerId, status: RunStatus.FAILED,
            error: 'the runtime crashed', provider: 'codex', providerBuiltin: true,
            usesRuntimeDefaultModel: true, source: 'user',
            dispatchOrigin: SessionDispatchOrigin.USER, runSource: SessionRunSource.MANUAL,
          },
        });
      }
      const planned = await plan(services, ceiling);
      const result = await services.dispatcher.dispatch(planned.lease, planned.command);
      assert.equal(result.sessionId, null);
      const action = await services.db.projectAction.findUniqueOrThrow({
        where: { id: result.action.actionId },
      });
      assert.equal(
        (action.detail as Record<string, { reasonCode?: string }>).dispatchFailure?.reasonCode,
        'MAX_ATTEMPTS_REACHED',
      );
      assert.equal(
        await services.db.session.count({
          where: {
            taskId: ceiling.taskId, status: { in: [RunStatus.PENDING, RunStatus.RUNNING] },
          },
        }),
        0,
        'a max-attempts refusal must not start anything',
      );
    } finally {
      await services.db.$disconnect();
    }
  });

test('an approval authorizes exactly one action key and nothing else',
  { skip: !URL, timeout: 180_000 }, async () => {
    const services = connectServices();
    try {
      const target = await fixture(services.db, 'approval-bound',
        { policy: ProjectAutomationPolicy.MANUAL });

      const wrongKey = await plan(services, target, { attempt: 1 });
      await expectRefusal(services.db, services.dispatcher, wrongKey, 'APPROVAL_TARGET_MISMATCH', {
        approval: { state: 'APPROVED', targetIdempotencyKey: `${wrongKey.command.idempotencyKey}x` },
      });
      const unbound = await plan(services, target, { attempt: 2 });
      await expectRefusal(services.db, services.dispatcher, unbound, 'APPROVAL_TARGET_MISMATCH', {
        approval: { state: 'APPROVED', targetIdempotencyKey: null },
      });
      const denied = await plan(services, target, { attempt: 3 });
      await expectRefusal(services.db, services.dispatcher, denied, 'APPROVAL_DENIED', {
        approval: { state: 'DENIED', targetIdempotencyKey: denied.command.idempotencyKey },
      });
      const expired = await plan(services, target, { attempt: 4 });
      await expectRefusal(services.db, services.dispatcher, expired, 'APPROVAL_EXPIRED', {
        approval: { state: 'EXPIRED', targetIdempotencyKey: expired.command.idempotencyKey },
      });
      const pending = await plan(services, target, { attempt: 5 });
      await expectRefusal(services.db, services.dispatcher, pending, 'APPROVAL_PENDING', {
        approval: { state: 'PENDING', targetIdempotencyKey: pending.command.idempotencyKey },
      });
      assert.equal(await sessionCount(services.db, target.taskId), 0,
        'five unusable approvals must have started nothing');

      const granted = await plan(services, target, { attempt: 6 });
      const sessionId = await expectSession(services.db, services.dispatcher, granted, {
        approval: { state: 'APPROVED', targetIdempotencyKey: granted.command.idempotencyKey },
      });
      const action = await services.db.projectAction.findFirstOrThrow({
        where: { resultSessionId: sessionId },
      });
      const audit = (action.detail as Record<string, { result?: { reasonCode?: string } }>)
        .authorization;
      assert.equal(audit?.result?.reasonCode, 'APPROVAL_GRANTED',
        'the granted approval must be the recorded reason');
    } finally {
      await services.db.$disconnect();
    }
  });

test('coordinator identity, membership and tenant boundaries fail closed',
  { skip: !URL, timeout: 180_000 }, async () => {
    const services = connectServices();
    try {
      const disabled = await fixture(services.db, 'agent-disabled', { agentEnabled: false });
      await expectRefusal(services.db, services.dispatcher, await plan(services, disabled),
        'COORDINATOR_AGENT_DISABLED');

      const plainMember = await fixture(services.db, 'member-role',
        { memberRole: ProjectRole.MEMBER });
      await expectRefusal(services.db, services.dispatcher, await plan(services, plainMember),
        ['COORDINATOR_NOT_ASSIGNED', 'COORDINATOR_NOT_PROJECT_MEMBER']);

      // The coordinator is removed from the team between snapshot and commit.
      const removed = await fixture(services.db, 'member-removed');
      const removedPlan = await plan(services, removed);
      await services.db.projectMember.deleteMany({ where: { projectId: removed.projectId } });
      await expectRefusal(services.db, services.dispatcher, removedPlan,
        ['COORDINATOR_NOT_ASSIGNED', 'COORDINATOR_NOT_PROJECT_MEMBER', 'STALE_SNAPSHOT']);

      // The Agent is soft-deleted after the snapshot.
      const softDeleted = await fixture(services.db, 'agent-soft-deleted');
      const softPlan = await plan(services, softDeleted);
      await services.db.workspace.update({
        where: { id: softDeleted.agentId }, data: { deletedAt: new Date() },
      });
      await expectRefusal(services.db, services.dispatcher, softPlan,
        ['COORDINATOR_AGENT_DISABLED', 'WHO_DISABLED', 'STALE_SNAPSHOT']);
      assert.equal(await sessionCount(services.db, softDeleted.taskId), 0);

      // Cross-tenant: another owner's Task is not reachable through this Project.
      const tenantA = await fixture(services.db, 'tenant-a');
      const tenantB = await fixture(services.db, 'tenant-b');
      await assert.rejects(
        plan(services, { ...tenantA, taskId: tenantB.taskId }),
        /outside its snapshot/,
        'another tenant\'s Task is not even plannable in this Project',
      );
      // And if such an action reached the dispatcher anyway, it is not in the decision.
      const tenantPlan = await plan(services, tenantA);
      await assert.rejects(
        services.dispatcher.dispatch(tenantPlan.lease, {
          ...tenantPlan.command, taskId: tenantB.taskId,
        }),
        /not present in decision/,
      );
      assert.equal(await sessionCount(services.db, tenantB.taskId), 0);
    } finally {
      await services.db.$disconnect();
    }
  });

test('project concurrency, agent concurrency and the 24h budget cannot be raced past',
  { skip: !URL, timeout: 240_000 }, async () => {
    const services = connectServices();
    try {
      // Two Tasks, one slot, both decisions captured before either commits.
      const capped = await fixture(services.db, 'race-project-cap', { maxConcurrentTasks: 1 });
      const sibling = await services.db.task.create({
        data: {
          ownerId: capped.ownerId, projectId: capped.projectId, assigneeId: capped.agentId,
          title: 'race-project-cap-second', creatorType: CreatorType.USER,
          creatorId: capped.ownerId, provider: 'codex',
        },
      });
      const planA = await plan(services, capped);
      const planB = await plan(services, capped, { taskId: sibling.id, lease: planA.lease });
      const raced = await Promise.allSettled([
        services.dispatcher.dispatch(planA.lease, planA.command),
        services.dispatcher.dispatch(planB.lease, planB.command),
      ]);
      const live = await services.db.session.count({
        where: {
          task: { projectId: capped.projectId },
          status: { in: [RunStatus.PENDING, RunStatus.RUNNING] },
          deletedAt: null,
        },
      });
      assert.equal(live, 1,
        `one slot must admit exactly one Session, got ${live} `
        + `(${JSON.stringify(raced.map((entry) => entry.status))})`);

      // The same race against the per-Agent admission cap inside one Project.
      const agentCapped = await fixture(services.db, 'race-agent-cap',
        { maxConcurrentTasks: 5, agentMaxConcurrentTasks: 1 });
      const agentSibling = await services.db.task.create({
        data: {
          ownerId: agentCapped.ownerId, projectId: agentCapped.projectId,
          assigneeId: agentCapped.agentId, title: 'race-agent-cap-second',
          creatorType: CreatorType.USER, creatorId: agentCapped.ownerId, provider: 'codex',
        },
      });
      const agentPlanA = await plan(services, agentCapped);
      const agentPlanB = await plan(services, agentCapped,
        { taskId: agentSibling.id, lease: agentPlanA.lease });
      await Promise.allSettled([
        services.dispatcher.dispatch(agentPlanA.lease, agentPlanA.command),
        services.dispatcher.dispatch(agentPlanB.lease, agentPlanB.command),
      ]);
      const agentLive = await services.db.session.count({
        where: {
          workspaceId: agentCapped.agentId,
          status: { in: [RunStatus.PENDING, RunStatus.RUNNING] },
          deletedAt: null,
        },
      });
      assert.equal(agentLive, 1, `the Agent cap admitted ${agentLive} concurrent Sessions`);

      // The rolling 24h Session budget, raced the same way.
      const budget = await fixture(services.db, 'race-budget', { sessionBudgetPerDay: 1 });
      const budgetSibling = await services.db.task.create({
        data: {
          ownerId: budget.ownerId, projectId: budget.projectId, assigneeId: budget.agentId,
          title: 'race-budget-second', creatorType: CreatorType.USER, creatorId: budget.ownerId,
          provider: 'codex',
        },
      });
      const budgetPlanA = await plan(services, budget);
      const budgetPlanB = await plan(services, budget,
        { taskId: budgetSibling.id, lease: budgetPlanA.lease });
      await Promise.allSettled([
        services.dispatcher.dispatch(budgetPlanA.lease, budgetPlanA.command),
        services.dispatcher.dispatch(budgetPlanB.lease, budgetPlanB.command),
      ]);
      const spent = await services.db.projectAction.count({
        where: {
          projectId: budget.projectId, type: 'DISPATCH_TASK', status: 'APPLIED',
        },
      });
      assert.equal(spent, 1, `a 24h budget of 1 recorded ${spent} applied dispatches`);
      const budgetSessions = await services.db.session.count({
        where: { task: { projectId: budget.projectId }, deletedAt: null },
      });
      assert.equal(budgetSessions, 1, `a budget of 1 produced ${budgetSessions} Sessions`);

      // A spent budget stays spent for the next decision too. Use a third, untouched Task so
      // the refusal cannot be the live-claim one, whichever of the two racers won above.
      const budgetThird = await services.db.task.create({
        data: {
          ownerId: budget.ownerId, projectId: budget.projectId, assigneeId: budget.agentId,
          title: 'race-budget-third', creatorType: CreatorType.USER, creatorId: budget.ownerId,
          provider: 'codex',
        },
      });
      const exhausted = await plan(services, budget, { attempt: 1, taskId: budgetThird.id });
      await expectRefusal(services.db, services.dispatcher, exhausted,
        ['SESSION_BUDGET_EXHAUSTED', 'PROJECT_CONCURRENCY_LIMIT', 'STALE_SNAPSHOT']);
      assert.equal(
        await services.db.session.count({ where: { task: { projectId: budget.projectId } } }),
        1,
      );
    } finally {
      await services.db.$disconnect();
    }
  });

test('the per-Agent admission cap is scoped to one Project, and the scope is pinned',
  { skip: !URL, timeout: 180_000 }, async () => {
    const services = connectServices();
    try {
      // One Agent capped at one concurrent Task, coordinating two Projects of the same owner.
      const first = await fixture(services.db, 'agent-scope-a', { agentMaxConcurrentTasks: 1 });
      const second = await fixture(services.db, 'agent-scope-b', {
        agentMaxConcurrentTasks: 1,
        owner: { ownerId: first.ownerId, runnerId: first.runnerId, agentId: first.agentId },
      });
      await expectSession(services.db, services.dispatcher, await plan(services, first));
      const across = await plan(services, second);
      const result = await services.dispatcher.dispatch(across.lease, across.command);
      const live = await services.db.session.count({
        where: {
          workspaceId: first.agentId,
          status: { in: [RunStatus.PENDING, RunStatus.RUNNING] },
          deletedAt: null,
        },
      });
      const reasonCode = result.action.status === 'APPLIED'
        ? 'APPLIED'
        : (await services.db.projectAction.findUniqueOrThrow({
            where: { id: result.action.actionId },
          })).reasonCode;

      // Pinning the observed contract. `workspace.max_concurrent_tasks` is documented in the
      // schema as an admission cap for "this Agent's Project tasks", and the authorization
      // adapter counts it inside the Project being reconciled — so two Projects admit one Task
      // each, and no cross-Project lock is taken. Asserted rather than assumed: a future change
      // to a fleet-wide meaning has to come here and change it deliberately.
      assert.equal(live, 2,
        `expected the per-Project scope, got ${live} live Sessions (${String(reasonCode)})`);
      assert.equal(
        await services.db.session.count({
          where: {
            task: { projectId: second.projectId },
            status: { in: [RunStatus.PENDING, RunStatus.RUNNING] },
            deletedAt: null,
          },
        }),
        1,
        'each Project still admits at most its own capped Task',
      );
    } finally {
      await services.db.$disconnect();
    }
  });

test('retry backoff, attributability and the attempt ceiling are read from durable history',
  { skip: !URL, timeout: 180_000 }, async () => {
    const services = connectServices();
    const failedSession = async (target: Fixture, error: string | null, createdAt?: Date) =>
      services.db.session.create({
        data: {
          title: 'failed', prompt: 'x', ownerId: target.ownerId, creatorId: target.ownerId,
          taskId: target.taskId, workspaceId: target.agentId, assignedRunnerId: target.runnerId,
          status: RunStatus.FAILED, error, provider: 'codex', providerBuiltin: true,
          usesRuntimeDefaultModel: true, source: 'user',
          ...(createdAt ? { createdAt } : {}),
          dispatchOrigin: SessionDispatchOrigin.USER, runSource: SessionRunSource.MANUAL,
        },
      });
    try {
      const backoff = await fixture(services.db, 'retry-backoff');
      await failedSession(backoff, 'boom');
      const backoffPlan = await plan(services, backoff);
      await expectRefusal(services.db, services.dispatcher, backoffPlan, 'RETRY_BACKOFF_ACTIVE');
      const refused = await services.db.projectAction.findFirstOrThrow({
        where: { idempotencyKey: backoffPlan.command.idempotencyKey },
      });
      assert.ok(
        (refused.detail as Record<string, { retryAt?: string | null }>).dispatchFailure?.retryAt,
        'a backoff refusal must carry the time it becomes retryable',
      );

      // A usage-limit failure is not the Task's fault and must not consume an attempt.
      const quota = await fixture(services.db, 'retry-quota');
      await failedSession(quota, "You've hit your usage limit. Try again later.");
      await expectSession(services.db, services.dispatcher, await plan(services, quota));

      // An old failure whose backoff has expired dispatches again.
      const expired = await fixture(services.db, 'retry-expired');
      await failedSession(expired, 'boom', new Date(Date.now() - 24 * 60 * 60_000));
      await expectSession(services.db, services.dispatcher, await plan(services, expired));

      // A failure with no error text at all is unattributable: escalate, never auto-retry.
      const unknown = await fixture(services.db, 'retry-unknown');
      await failedSession(unknown, null, new Date(Date.now() - 24 * 60 * 60_000));
      await expectRefusal(services.db, services.dispatcher, await plan(services, unknown),
        'UNKNOWN_FAILURE');
    } finally {
      await services.db.$disconnect();
    }
  });

test('an unavailable Provider is reported, never silently resolved to another one',
  { skip: !URL, timeout: 180_000 }, async () => {
    const services = connectServices();
    try {
      // No fallbacks configured: the pin is simply unavailable.
      const empty = await fixture(services.db, 'provider-empty', { provider: `not-configured-${RUN}` });
      await expectRefusal(services.db, services.dispatcher, await plan(services, empty),
        'PROVIDER_UNAVAILABLE');
      assert.equal(await sessionCount(services.db, empty.taskId), 0);

      // A disabled owner Provider is unavailable even though the fleet runs four builtins.
      const disabled = await fixture(services.db, 'provider-disabled', { provider: `house-${RUN}` });
      await services.db.modelProvider.create({
        data: {
          ownerId: disabled.ownerId, slug: `house-${RUN}`, label: 'House', baseUrl: 'https://house.invalid',
          apiKeyEnc: 'x:y:z', runtime: 'claude',
          enabled: false, models: ['house-1'] as unknown as Prisma.InputJsonValue,
          defaultModel: 'house-1',
        },
      });
      const disabledPlan = await plan(services, disabled);
      await expectRefusal(services.db, services.dispatcher, disabledPlan, 'PROVIDER_UNAVAILABLE');
      const refusal = await services.db.projectAction.findFirstOrThrow({
        where: { idempotencyKey: disabledPlan.command.idempotencyKey },
      });
      const audit = (refusal.detail as Record<string, {
        request?: { provider?: { explicitFallbacks?: unknown[] } };
        result?: { providerResolution?: { selectedProvider: string | null } };
      }>).authorization;
      assert.deepEqual(audit?.request?.provider?.explicitFallbacks, [],
        'an Agent with no declared fallback must be audited as having none');
      assert.equal(audit?.result?.providerResolution?.selectedProvider, null);

      // Fallbacks that are themselves unavailable stay a refusal — no fleet-wide search.
      const exhausted = await fixture(services.db, 'provider-exhausted', {
        provider: `gone-a-${RUN}`,
        providerFallbacks: [{ provider: 'gone-b' }, { provider: 'gone-c' }],
      });
      await expectRefusal(services.db, services.dispatcher, await plan(services, exhausted),
        'PROVIDER_UNAVAILABLE');
      assert.equal(await sessionCount(services.db, exhausted.taskId), 0);
    } finally {
      await services.db.$disconnect();
    }
  });

test('an explicit Agent fallback is ordered, policy-gated and fully audited',
  { skip: !URL, timeout: 180_000 }, async () => {
    const services = connectServices();
    try {
      const target = await fixture(services.db, 'fallback-auto', {
        policy: ProjectAutomationPolicy.AUTO,
        provider: `house-fallback-${RUN}`,
        providerFallbacks: [{ provider: 'still-gone' }, { provider: 'codex' }, { provider: 'kimi' }],
      });
      await services.db.modelProvider.create({
        data: {
          ownerId: target.ownerId, slug: `house-fallback-${RUN}`, label: 'House fallback',
          baseUrl: 'https://house-fallback.invalid', apiKeyEnc: 'x:y:z', runtime: 'claude',
          enabled: false, models: [] as unknown as Prisma.InputJsonValue,
        },
      });
      const sessionId = await expectSession(services.db, services.dispatcher,
        await plan(services, target));
      const session = await services.db.session.findUniqueOrThrow({ where: { id: sessionId } });
      assert.equal(session.provider, 'codex', 'the first available declared fallback wins');
      const resolution = session.resolution as Record<string, Record<string, unknown>>;
      assert.equal(resolution.with.source, 'explicit-agent-fallback');
      assert.deepEqual(resolution.with.pinned, { provider: `house-fallback-${RUN}`, model: null });
      assert.deepEqual(resolution.with.fallbackHops,
        [{ from: `house-fallback-${RUN}`, to: 'codex', reason: 'PROVIDER_UNAVAILABLE' }]);
      const action = await services.db.projectAction.findFirstOrThrow({
        where: { resultSessionId: sessionId },
      });
      const audit = (action.detail as Record<string, {
        result?: { policyRow?: string; providerResolution?: { candidatesConsidered: string[] } };
      }>).authorization;
      assert.equal(audit?.result?.policyRow, 'DISPATCH_PROVIDER_FALLBACK');
      assert.deepEqual(audit?.result?.providerResolution?.candidatesConsidered,
        [`house-fallback-${RUN}`, 'still-gone', 'codex'],
        'the audit must show the order that was tried, including what failed');

      // The same fallback under GUARDED_AUTO is a high-risk row that needs a person.
      const guarded = await fixture(services.db, 'fallback-guarded', {
        policy: ProjectAutomationPolicy.GUARDED_AUTO,
        provider: `house2-${RUN}`,
        providerFallbacks: [{ provider: 'codex' }],
      });
      await services.db.modelProvider.create({
        data: {
          ownerId: guarded.ownerId, slug: `house2-${RUN}`, label: 'House2', baseUrl: 'https://house2.invalid',
          apiKeyEnc: 'x:y:z', runtime: 'claude',
          enabled: false, models: [] as unknown as Prisma.InputJsonValue,
        },
      });
      await expectRefusal(services.db, services.dispatcher, await plan(services, guarded),
        'POLICY_REQUIRES_APPROVAL');
      assert.equal(await sessionCount(services.db, guarded.taskId), 0);
    } finally {
      await services.db.$disconnect();
    }
  });

test('Runner and Provider facts are re-read at commit and never become a substitution',
  { skip: !URL, timeout: 180_000 }, async () => {
    const services = connectServices();
    try {
      const offline = await fixture(services.db, 'runner-offline',
        { runnerStatus: RunnerStatus.OFFLINE });
      await expectRefusal(services.db, services.dispatcher, await plan(services, offline),
        'RUNNER_UNAVAILABLE');

      // Online at snapshot time, gone by commit time.
      const flipped = await fixture(services.db, 'runner-flipped');
      const flippedPlan = await plan(services, flipped);
      await services.db.runner.update({
        where: { id: flipped.runnerId }, data: { status: RunnerStatus.OFFLINE },
      });
      await expectRefusal(services.db, services.dispatcher, flippedPlan,
        ['RUNNER_UNAVAILABLE', 'STALE_SNAPSHOT']);
      assert.equal(await sessionCount(services.db, flipped.taskId), 0);

      // The Agent is switched off after the snapshot.
      const revoked = await fixture(services.db, 'agent-revoked');
      const revokedPlan = await plan(services, revoked);
      await services.db.workspace.update({
        where: { id: revoked.agentId }, data: { enabled: false },
      });
      await expectRefusal(services.db, services.dispatcher, revokedPlan,
        ['COORDINATOR_AGENT_DISABLED', 'WHO_DISABLED', 'RUNNER_UNAVAILABLE', 'STALE_SNAPSHOT']);

      // A runner signed out of the required runtime is a structured refusal, not a reroute to
      // whatever runtime it can still run.
      const signedOut = await fixture(services.db, 'runtime-signed-out', {
        provider: 'codex',
        engines: [{ engine: 'codex', installed: true, auth: 'no' }] as Prisma.InputJsonValue,
      });
      const signedOutPlan = await plan(services, signedOut);
      const signedOutReason = await expectRefusal(services.db, services.dispatcher, signedOutPlan,
        ['RUNTIME_REQUIREMENT_UNMET', 'RUNNER_UNAVAILABLE']);
      const signedOutAction = await services.db.projectAction.findFirstOrThrow({
        where: { idempotencyKey: signedOutPlan.command.idempotencyKey },
      });
      assert.equal(signedOutAction.refusalCode, 'NO_MATCHING_RUNNER',
        `refusal ${signedOutReason} must surface as a runner-matching failure`);
      assert.equal(await sessionCount(services.db, signedOut.taskId), 0);

      // A capability the Task requires and the runner never reported.
      const missing = await fixture(services.db, 'capability-missing',
        { requiredCapabilities: ['gpu-h100'] });
      await expectRefusal(services.db, services.dispatcher, await plan(services, missing),
        'RUNTIME_REQUIREMENT_UNMET');

      // An old runner that never reported capabilities cannot prove a non-empty requirement.
      const unreported = await fixture(services.db, 'capability-unreported', {
        capabilitiesReported: false, requiredCapabilities: ['gpu-h100'],
      });
      await expectRefusal(services.db, services.dispatcher, await plan(services, unreported),
        'RUNTIME_REQUIREMENT_UNMET');
    } finally {
      await services.db.$disconnect();
    }
  });

test('one authorized action starts at most one Session under every duplication mode',
  { skip: !URL, timeout: 240_000 }, async () => {
    const services = connectServices();
    const secondInstance = servicesOn(services.db);
    try {
      // Two service instances, one action, at the same time.
      const target = await fixture(services.db, 'exactly-once');
      const planned = await plan(services, target);
      const [first, second] = await Promise.all([
        services.dispatcher.dispatch(planned.lease, planned.command),
        secondInstance.dispatcher.dispatch(planned.lease, planned.command),
      ]);
      assert.equal(await sessionCount(services.db, target.taskId), 1);
      assert.equal(first.sessionId, second.sessionId);
      assert.ok(first.sessionId);

      // A duplicate delivery of the same command afterwards.
      const replay = await services.dispatcher.dispatch(planned.lease, planned.command);
      assert.equal(replay.action.status, 'ALREADY_APPLIED');
      assert.equal(replay.sessionId, first.sessionId);

      // A rebuilt process: fresh objects, same durable state.
      const rebuilt = servicesOn(services.db);
      const afterRebuild = await rebuilt.dispatcher.dispatch(planned.lease, planned.command);
      assert.equal(afterRebuild.sessionId, first.sessionId);
      assert.equal(await sessionCount(services.db, target.taskId), 1);
      assert.equal(
        await services.db.projectAction.count({
          where: { idempotencyKey: planned.command.idempotencyKey },
        }),
        1,
        'four deliveries of one action key must leave exactly one action row',
      );

      // Out of order: a decision planned earlier, delivered after a newer one already ran.
      const ordered = await fixture(services.db, 'out-of-order');
      const older = await plan(services, ordered, { attempt: 1 });
      const newer = await plan(services, ordered, { attempt: 2, lease: older.lease });
      await expectSession(services.db, services.dispatcher, newer);
      await expectRefusal(services.db, services.dispatcher, older,
        ['STALE_SNAPSHOT', 'TASK_ALREADY_RUNNING']);
      assert.equal(await sessionCount(services.db, ordered.taskId), 1);
    } finally {
      await services.db.$disconnect();
    }
  });

test('a failure at the transaction boundary leaves nothing behind and replays to one Session',
  { skip: !URL, timeout: 180_000 }, async () => {
    const services = connectServices();
    try {
      const target = await fixture(services.db, 'commit-fault');
      const planned = await plan(services, target);
      // Fault injection: the Session row is written and the transaction then dies. Everything
      // that dispatch wrote — action row, attempt counter, Session — must go with it.
      await services.db.$executeRawUnsafe(`
        CREATE OR REPLACE FUNCTION "pcc14_commit_fault"() RETURNS trigger AS $fn$
        BEGIN
          RAISE EXCEPTION 'PCC14_INJECTED_COMMIT_FAULT';
        END;
        $fn$ LANGUAGE plpgsql;
      `);
      await services.db.$executeRawUnsafe(`
        CREATE TRIGGER "pcc14_commit_fault" AFTER INSERT ON "session"
          FOR EACH ROW WHEN (NEW."dispatch_origin" = 'PROJECT_COORDINATOR')
          EXECUTE FUNCTION "pcc14_commit_fault"()
      `);
      try {
        await assert.rejects(
          services.dispatcher.dispatch(planned.lease, planned.command),
          /PCC14_INJECTED_COMMIT_FAULT/,
        );
        assert.equal(await sessionCount(services.db, target.taskId), 0);
        assert.equal(
          await services.db.projectAction.count({
            where: { idempotencyKey: planned.command.idempotencyKey },
          }),
          0,
          'a rolled-back dispatch must not leave a claimed action behind',
        );
        assert.equal(
          (await services.db.task.findUniqueOrThrow({ where: { id: target.taskId } }))
            .dispatchAttempt,
          0n,
          'an aborted transaction must not consume an attempt',
        );
      } finally {
        await services.db.$executeRawUnsafe(
          'DROP TRIGGER IF EXISTS "pcc14_commit_fault" ON "session"');
        await services.db.$executeRawUnsafe('DROP FUNCTION IF EXISTS "pcc14_commit_fault"()');
      }
      // The very same command, replayed once the fault is gone, produces exactly one Session.
      await expectSession(services.db, services.dispatcher, planned);
      assert.equal(
        (await services.db.task.findUniqueOrThrow({ where: { id: target.taskId } }))
          .dispatchAttempt,
        1n,
      );
    } finally {
      await services.db.$disconnect();
    }
  });

test('a killed backend mid-dispatch commits nothing and the retry still starts one Session',
  { skip: !URL, timeout: 180_000 }, async () => {
    const services = connectServices();
    const admin = new Client({ connectionString: URL, connectionTimeoutMillis: 5_000 });
    await admin.connect();
    try {
      const target = await fixture(services.db, 'backend-killed');
      const planned = await plan(services, target);
      // Fault injection at the transaction boundary: hold the dispatch inside its transaction,
      // then terminate the backend running it. A connection loss is not a commit.
      await services.db.$executeRawUnsafe(`
        CREATE OR REPLACE FUNCTION "pcc14_backend_kill"() RETURNS trigger AS $fn$
        BEGIN
          PERFORM pg_sleep(2);
          RETURN NEW;
        END;
        $fn$ LANGUAGE plpgsql;
      `);
      await services.db.$executeRawUnsafe(`
        CREATE TRIGGER "pcc14_backend_kill" BEFORE INSERT ON "session"
          FOR EACH ROW WHEN (NEW."dispatch_origin" = 'PROJECT_COORDINATOR')
          EXECUTE FUNCTION "pcc14_backend_kill"()
      `);
      try {
        const dispatching = services.dispatcher.dispatch(planned.lease, planned.command)
          .then(() => 'resolved' as const, () => 'rejected' as const);
        await new Promise((resolve) => { setTimeout(resolve, 1_000); });
        const killed = await admin.query<{ pid: number }>(`
          SELECT pg_terminate_backend(pid) AS terminated, pid
            FROM pg_stat_activity
           WHERE datname = current_database() AND state = 'active'
             AND query ILIKE '%INSERT INTO "session"%' AND pid <> pg_backend_pid()
        `);
        assert.ok(killed.rowCount && killed.rowCount > 0,
          'the fault harness must actually find and kill the dispatching backend');
        assert.equal(await dispatching, 'rejected', 'a killed backend must not report success');
      } finally {
        await services.db.$executeRawUnsafe(
          'DROP TRIGGER IF EXISTS "pcc14_backend_kill" ON "session"');
        await services.db.$executeRawUnsafe('DROP FUNCTION IF EXISTS "pcc14_backend_kill"()');
      }
      assert.equal(await sessionCount(services.db, target.taskId), 0,
        'a terminated backend must leave no Session');
      assert.equal(
        await services.db.projectAction.count({
          where: { idempotencyKey: planned.command.idempotencyKey },
        }),
        0,
        'a terminated backend must leave no claimed action',
      );
      await expectSession(services.db, services.dispatcher, planned);
    } finally {
      await admin.end();
      await services.db.$disconnect();
    }
  });

test('a real server restart does not duplicate or lose an applied dispatch',
  { skip: !URL || !RESTART_COMMAND, timeout: 300_000 }, async () => {
    const services = connectServices();
    let sessionId: string;
    let target: Fixture;
    let planned: { lease: ProjectReconcileLease; command: ProjectTaskDispatchCommand };
    try {
      target = await fixture(services.db, 'server-restart');
      planned = await plan(services, target);
      sessionId = await expectSession(services.db, services.dispatcher, planned);
    } finally {
      await services.db.$disconnect();
    }

    execSync(RESTART_COMMAND!, { stdio: 'pipe' });

    const revived = connectServices();
    try {
      let ready = false;
      for (let attempt = 0; attempt < 60 && !ready; attempt += 1) {
        try {
          await revived.db.$queryRawUnsafe('SELECT 1');
          ready = true;
        } catch {
          await new Promise((resolve) => { setTimeout(resolve, 1_000); });
        }
      }
      assert.ok(ready, 'the disposable server must come back');
      await probeIdentity();

      assert.equal(await sessionCount(revived.db, target.taskId), 1,
        'the committed Session must survive the restart');
      const afterRestart = await revived.dispatcher.dispatch(planned.lease, planned.command);
      assert.equal(afterRestart.action.status, 'ALREADY_APPLIED');
      assert.equal(afterRestart.sessionId, sessionId);
      assert.equal(await sessionCount(revived.db, target.taskId), 1);

      // A brand-new decision for the same Task after the restart still cannot double-run it.
      const retried = await plan(revived, target, { attempt: 2 });
      await expectRefusal(revived.db, revived.dispatcher, retried,
        ['TASK_ALREADY_RUNNING', 'STALE_SNAPSHOT']);
      assert.equal(await sessionCount(revived.db, target.taskId), 1);
    } finally {
      await revived.db.$disconnect();
    }
  });

test('a stale snapshot, a lost fence or a changed dependency starts nothing and re-reconciles',
  { skip: !URL, timeout: 240_000 }, async () => {
    const services = connectServices();
    try {
      // Stale: the Task changed after the snapshot was frozen.
      const stale = await fixture(services.db, 'stale-task');
      const stalePlan = await plan(services, stale);
      await services.db.task.update({
        where: { id: stale.taskId }, data: { title: 'edited after the snapshot' },
      });
      const result = await services.dispatcher.dispatch(stalePlan.lease, stalePlan.command);
      assert.equal(result.sessionId, null);
      assert.equal(result.action.status, 'REFUSED');
      assert.equal(await sessionCount(services.db, stale.taskId), 0);
      const staleEvents = await services.db.projectEvent.findMany({
        where: { projectId: stale.projectId, kind: 'coordinator.snapshot_stale' },
      });
      assert.equal(staleEvents.length, 1, 'a stale refusal must enqueue exactly one reconcile');
      assert.equal(staleEvents[0].consumedAt, null, 'the reconcile signal must still be pending');
      const runtime = await services.db.projectRuntime.findUniqueOrThrow({
        where: { projectId: stale.projectId },
      });
      assert.ok(runtime.nextWakeAt, 'a stale refusal must schedule a wake');
      assert.match(runtime.nextWakeReason ?? '', /stale/i);

      // A dependency added after the snapshot.
      const dependency = await fixture(services.db, 'stale-dependency');
      const dependencyPlan = await plan(services, dependency);
      const late = await services.db.task.create({
        data: {
          ownerId: dependency.ownerId, projectId: dependency.projectId,
          assigneeId: dependency.agentId, title: 'late prerequisite',
          creatorType: CreatorType.USER, creatorId: dependency.ownerId,
        },
      });
      await services.db.taskDependency.create({
        data: { taskId: dependency.taskId, dependsOnTaskId: late.id },
      });
      await expectRefusal(services.db, services.dispatcher, dependencyPlan,
        ['STALE_SNAPSHOT', 'TASK_DEPENDENCIES_INCOMPLETE']);
      assert.equal(await sessionCount(services.db, dependency.taskId), 0);

      // A prerequisite present from the start simply defers.
      const blocked = await fixture(services.db, 'dependency-blocked');
      const blocker = await services.db.task.create({
        data: {
          ownerId: blocked.ownerId, projectId: blocked.projectId, assigneeId: blocked.agentId,
          title: 'open prerequisite', creatorType: CreatorType.USER, creatorId: blocked.ownerId,
        },
      });
      await services.db.taskDependency.create({
        data: { taskId: blocked.taskId, dependsOnTaskId: blocker.id },
      });
      await expectRefusal(services.db, services.dispatcher, await plan(services, blocked),
        'TASK_DEPENDENCIES_INCOMPLETE');

      // Task state moved on after the snapshot.
      const moved = await fixture(services.db, 'stale-task-status');
      const movedPlan = await plan(services, moved);
      await services.db.task.update({
        where: { id: moved.taskId }, data: { status: TaskStatus.DONE },
      });
      await expectRefusal(services.db, services.dispatcher, movedPlan,
        ['STALE_SNAPSHOT', 'TASK_NOT_OPEN']);

      // Fencing: another reconciler takes the lease; the old holder must not commit anything.
      const fenced = await fixture(services.db, 'fenced');
      const fencedPlan = await plan(services, fenced);
      await services.db.projectRuntime.update({
        where: { projectId: fenced.projectId },
        data: {
          leaseHeartbeatAt: new Date(Date.now() - 120_000),
          leaseExpiresAt: new Date(Date.now() - 60_000),
        },
      });
      const usurper = servicesOn(services.db);
      const newLease = await usurper.reconciler.acquireLease(fenced.projectId);
      assert.ok(newLease && newLease.fencingToken > fencedPlan.lease.fencingToken);
      await assert.rejects(
        services.dispatcher.dispatch(fencedPlan.lease, fencedPlan.command), /lease lost/i,
      );
      assert.equal(await sessionCount(services.db, fenced.taskId), 0);
      assert.equal(
        await services.db.projectAction.count({
          where: { idempotencyKey: fencedPlan.command.idempotencyKey },
        }),
        0,
        'a fenced-out holder must not even claim the action',
      );

      // Switching the Coordinator off is the same kind of revocation.
      const switchedOff = await fixture(services.db, 'coordinator-off');
      const offPlan = await plan(services, switchedOff);
      await services.db.project.update({
        where: { id: switchedOff.projectId }, data: { coordinatorEnabled: false },
      });
      await assert.rejects(
        services.dispatcher.dispatch(offPlan.lease, offPlan.command), /lease lost/i,
      );
      assert.equal(await sessionCount(services.db, switchedOff.taskId), 0);
    } finally {
      await services.db.$disconnect();
    }
  });

test('a tampered Decision, Action or Session lineage cannot produce a Session',
  { skip: !URL, timeout: 240_000 }, async () => {
    const services = connectServices();
    try {
      const target = await fixture(services.db, 'tamper');
      const planned = await plan(services, target);

      // The audit row itself is append-only.
      await assert.rejects(
        services.db.$executeRawUnsafe(
          `UPDATE "project_decision" SET "reason" = 'edited' WHERE "id" = $1::uuid`,
          planned.command.decisionId,
        ),
        /PROJECT_DECISION_IMMUTABLE/,
      );

      // A forged decision whose stored input no longer hashes to its recorded hash.
      const original = await services.db.projectDecision.findUniqueOrThrow({
        where: { id: planned.command.decisionId },
      });
      const forgedId = randomUUID();
      const forgedInput = JSON.parse(JSON.stringify(original.decisionInput)) as
        Record<string, unknown>;
      forgedInput.readAt = new Date(Date.parse(String(forgedInput.readAt)) + 1_000).toISOString();
      await services.db.$executeRawUnsafe(
        `INSERT INTO "project_decision" ("id", "project_id", "input_version",
           "decision_input_hash", "decision_input", "outcome", "decided_by",
           "coordinator_agent_id", "coordinator_session_id", "fencing_token", "reason")
         VALUES ($1::uuid, $2::uuid, $3, $4, $5::jsonb, $6::jsonb, $7, $8::uuid, $9::uuid,
                 $10, $11)`,
        forgedId, target.projectId, original.inputVersion, original.decisionInputHash,
        JSON.stringify(forgedInput), JSON.stringify(original.outcome), original.decidedBy,
        original.coordinatorAgentId, original.coordinatorSessionId,
        Number(original.fencingToken), 'forged',
      );
      await assert.rejects(
        services.dispatcher.dispatch(planned.lease, { ...planned.command, decisionId: forgedId }),
        /invalid input hash|invalid outcome lineage/,
      );
      assert.equal(await sessionCount(services.db, target.taskId), 0);

      // An action key no decision ever planned.
      await assert.rejects(
        services.dispatcher.dispatch(planned.lease, {
          ...planned.command, idempotencyKey: `${planned.command.idempotencyKey}:invented`,
        }),
        /not present in decision/,
      );
      // A subject swapped for another Task under a planned key.
      const sibling = await services.db.task.create({
        data: {
          ownerId: target.ownerId, projectId: target.projectId, assigneeId: target.agentId,
          title: 'lineage sibling', creatorType: CreatorType.USER, creatorId: target.ownerId,
        },
      });
      await assert.rejects(
        services.dispatcher.dispatch(planned.lease, { ...planned.command, taskId: sibling.id }),
        /not present in decision/,
      );
      assert.equal(await sessionCount(services.db, target.taskId), 0);
      assert.equal(await sessionCount(services.db, sibling.id), 0);

      // An idempotency key naming another Project is rejected on its shape alone: the key
      // embeds the Project UUID, so a foreign key cannot even be planned.
      const other = await fixture(services.db, 'tamper-other');
      const otherPlan = await plan(services, other);
      await expectSession(services.db, services.dispatcher, otherPlan);
      const collision = await fixture(services.db, 'tamper-collision');
      const collisionLease = await leaseFor(services, collision.projectId);
      await assert.rejects(
        services.dispatcher.dispatch(collisionLease, {
          decisionId: otherPlan.command.decisionId,
          taskId: collision.taskId,
          idempotencyKey: otherPlan.command.idempotencyKey,
        }),
        /idempotency key must use pc:v1:<project UUID>/,
      );

      // And a well-formed key that some other Project already claimed is refused at the ledger.
      const collisionPlan = await plan(services, collision);
      await services.db.$executeRawUnsafe(
        `INSERT INTO "project_action" ("id", "project_id", "idempotency_key", "type", "status",
           "subject_type", "subject_id", "fencing_token", "detail", "updated_at")
         VALUES (gen_random_uuid(), $1::uuid, $2, 'DISPATCH_TASK', 'REFUSED', 'TASK', $3::uuid,
                 1, '{}'::jsonb, CURRENT_TIMESTAMP)`,
        other.projectId, collisionPlan.command.idempotencyKey, other.taskId,
      );
      await assert.rejects(
        services.dispatcher.dispatch(collisionLease, collisionPlan.command),
        /belongs to another Project/,
      );
      assert.equal(await sessionCount(services.db, collision.taskId), 0);

      // A committed Coordinator Session's frozen execution snapshot is immutable.
      const applied = await services.db.session.findFirstOrThrow({
        where: { taskId: other.taskId },
      });
      await assert.rejects(
        services.db.$executeRawUnsafe(
          `UPDATE "session" SET "provider" = 'claude' WHERE "id" = $1::uuid`, applied.id),
        /EXECUTION_SNAPSHOT_FROZEN|EXECUTION_RESULT_CHANGED/,
      );
      await assert.rejects(
        services.db.$executeRawUnsafe(
          `UPDATE "session" SET "resolution" = '{"v":1}'::jsonb WHERE "id" = $1::uuid`, applied.id),
        /EXECUTION_SNAPSHOT_FROZEN|EXECUTION_RESULT_CHANGED/,
      );

      // An applied dispatch action is terminal.
      await assert.rejects(
        services.db.$executeRawUnsafe(
          `UPDATE "project_action" SET "status" = 'REFUSED' WHERE "id" = $1::uuid`,
          applied.projectActionId),
        /ACTION_APPLIED_IMMUTABLE|ACTION_TRANSITION_ILLEGAL/,
      );

      // A Session cannot be minted against a refused action. Produce one honestly first: the
      // Task gains an unmet prerequisite, so the next decision for it is refused.
      const prerequisite = await services.db.task.create({
        data: {
          ownerId: target.ownerId, projectId: target.projectId, assigneeId: target.agentId,
          title: 'tamper prerequisite', creatorType: CreatorType.USER, creatorId: target.ownerId,
        },
      });
      await services.db.taskDependency.create({
        data: { taskId: target.taskId, dependsOnTaskId: prerequisite.id },
      });
      await expectRefusal(services.db, services.dispatcher,
        await plan(services, target, { attempt: 2 }),
        ['TASK_DEPENDENCIES_INCOMPLETE', 'STALE_SNAPSHOT']);
      const refusedAction = await services.db.projectAction.findFirstOrThrow({
        where: { projectId: target.projectId, status: 'REFUSED', subjectId: target.taskId },
      });
      await assert.rejects(
        services.db.$executeRawUnsafe(
          `INSERT INTO "session" ("id", "title", "prompt", "status", "provider",
             "provider_builtin", "uses_runtime_default_model", "source", "creator_id", "owner_id",
             "task_id", "workspace_id", "assigned_runner_id", "project_action_id",
             "dispatch_origin", "run_source", "updated_at")
           VALUES (gen_random_uuid(), 'forged', 'forged', 'PENDING', 'codex', true, true, 'user',
             $1::uuid, $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid,
             'PROJECT_COORDINATOR', 'PROJECT_COORDINATOR', CURRENT_TIMESTAMP)`,
          target.ownerId, target.taskId, target.agentId, target.runnerId, refusedAction.id),
        /EXECUTION_CONTEXT_INVALID|DISPATCH_ATTRIBUTION_VIOLATION|DISPATCH_RESULT_LINK_VIOLATION/,
      );
      assert.equal(await sessionCount(services.db, target.taskId), 0);
    } finally {
      await services.db.$disconnect();
    }
  });

test('the legacy sweep stands down for Coordinator Tasks and is otherwise unchanged',
  { skip: !URL, timeout: 180_000 }, async () => {
    const services = connectServices();
    try {
      const coordinated = await fixture(services.db, 'legacy-coordinated');
      assert.equal(
        (await services.db.task.findUniqueOrThrow({ where: { id: coordinated.taskId } }))
          .dispatchAuthority,
        'COORDINATOR',
        'the database derives authority from the Project, not from a service write',
      );

      // Turning the Coordinator off hands the Task back to the legacy sweep, and back again.
      await services.db.project.update({
        where: { id: coordinated.projectId }, data: { coordinatorEnabled: false },
      });
      assert.equal(
        (await services.db.task.findUniqueOrThrow({ where: { id: coordinated.taskId } }))
          .dispatchAuthority,
        'LEGACY',
      );
      await services.db.project.update({
        where: { id: coordinated.projectId }, data: { coordinatorEnabled: true },
      });
      assert.equal(
        (await services.db.task.findUniqueOrThrow({ where: { id: coordinated.taskId } }))
          .dispatchAuthority,
        'COORDINATOR',
      );

      // A Task outside any Project stays LEGACY, which is what the sweep selects on.
      const legacyTask = await services.db.task.create({
        data: {
          ownerId: coordinated.ownerId, assigneeId: coordinated.agentId, title: 'legacy task',
          creatorType: CreatorType.USER, creatorId: coordinated.ownerId, autoRunWhenReady: true,
        },
      });
      const sweepable = await services.db.$queryRawUnsafe<Array<{ id: string }>>(`
        SELECT t."id" FROM "task" t
         WHERE t."owner_id" = $1::uuid
           AND t."status" = 'OPEN'::task_status
           AND t."dispatch_authority" = 'LEGACY'::task_dispatch_authority
           AND t."auto_run_when_ready" = true
      `, coordinated.ownerId);
      assert.deepEqual(sweepable.map((row) => row.id), [legacyTask.id],
        'only the legacy Task is visible to the auto-run sweep predicate');

      // The database refuses a legacy-sweep Session on a Coordinator-authority Task.
      await assert.rejects(
        services.db.session.create({
          data: {
            title: 'sweep bypass', prompt: 'x', ownerId: coordinated.ownerId,
            creatorId: coordinated.ownerId, taskId: coordinated.taskId,
            workspaceId: coordinated.agentId, assignedRunnerId: coordinated.runnerId,
            status: RunStatus.PENDING, provider: 'codex', providerBuiltin: true,
            usesRuntimeDefaultModel: true, source: 'user',
            dispatchOrigin: SessionDispatchOrigin.LEGACY_SWEEP,
            runSource: SessionRunSource.TASK_LIST_AUTO,
          },
        }),
        /DISPATCH_AUTHORITY_VIOLATION/,
      );
      assert.equal(await sessionCount(services.db, coordinated.taskId), 0);

      // A person pressing 开始执行 on the same Task is still allowed, attributed as manual.
      const manual = await services.db.session.create({
        data: {
          title: 'manual run', prompt: 'x', ownerId: coordinated.ownerId,
          creatorId: coordinated.ownerId, taskId: coordinated.taskId,
          workspaceId: coordinated.agentId, assignedRunnerId: coordinated.runnerId,
          status: RunStatus.PENDING, provider: 'codex', providerBuiltin: true,
          usesRuntimeDefaultModel: true, source: 'user',
          dispatchOrigin: SessionDispatchOrigin.USER, runSource: SessionRunSource.MANUAL,
        },
      });
      assert.equal(manual.runSource, SessionRunSource.MANUAL);
      assert.equal(manual.projectActionId, null);

      // The legacy Task-List path is untouched for a Task the Coordinator does not own.
      const legacySession = await services.db.session.create({
        data: {
          title: 'task list auto', prompt: 'x', ownerId: coordinated.ownerId,
          creatorId: coordinated.ownerId, taskId: legacyTask.id,
          workspaceId: coordinated.agentId, assignedRunnerId: coordinated.runnerId,
          status: RunStatus.PENDING, provider: 'codex', providerBuiltin: true,
          usesRuntimeDefaultModel: true, source: 'user',
          dispatchOrigin: SessionDispatchOrigin.LEGACY_SWEEP,
          runSource: SessionRunSource.TASK_LIST_AUTO,
        },
      });
      assert.equal(legacySession.runSource, SessionRunSource.TASK_LIST_AUTO);

      // The single live claim per Task is shared by every entry point.
      await assert.rejects(
        services.db.session.create({
          data: {
            title: 'second manual run', prompt: 'x', ownerId: coordinated.ownerId,
            creatorId: coordinated.ownerId, taskId: coordinated.taskId,
            workspaceId: coordinated.agentId, assignedRunnerId: coordinated.runnerId,
            status: RunStatus.PENDING, provider: 'codex', providerBuiltin: true,
            usesRuntimeDefaultModel: true, source: 'user',
            dispatchOrigin: SessionDispatchOrigin.USER, runSource: SessionRunSource.MANUAL,
          },
        }),
        /session_task_execution_claim_idx|Unique constraint/,
      );

      // A Coordinator dispatch onto a Task the manual path already claimed is refused, not queued.
      await expectRefusal(services.db, services.dispatcher, await plan(services, coordinated),
        ['TASK_ALREADY_RUNNING', 'STALE_SNAPSHOT']);
      assert.equal(await sessionCount(services.db, coordinated.taskId), 1);
    } finally {
      await services.db.$disconnect();
    }
  });
