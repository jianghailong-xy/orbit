import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import { ForbiddenException } from '@nestjs/common';
import {
  CreatorType,
  PrismaClient,
  ProjectAcceptanceVerdict,
  RunnerStatus,
  SessionDispatchOrigin,
  TaskStatus,
  TaskVerdict,
} from '@prisma/client';
import { Client } from 'pg';

import { prismaClientFor } from '../prisma/prisma-client';
import { PrismaService } from '../prisma/prisma.service';
import { QueueService } from '../queue/queue.service';
import { RealtimeService } from '../realtime/realtime.service';
import { SessionsService } from '../sessions/sessions.service';
import { TasksService } from '../tasks/tasks.service';
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from './coordinator-pg-test-safety';
import { CoordinatorJudgmentService } from './coordinator-judgment.service';
import { CoordinatorConvergenceService } from './coordinator-convergence.service';
import { CoordinatorWakeService } from './coordinator-wake.service';
import { ProjectAcceptanceService } from './project-acceptance.service';
import { ProjectTasksSettledProducer } from './project-tasks-settled.producer';
import { ProjectsService } from './projects.service';

/**
 * Unit T7 over the real write path and a real PostgreSQL ledger.
 *
 *   COORDINATOR_PG_URL=postgresql://... \
 *   COORDINATOR_PG_EXPECTED_DATABASE=pcc... \
 *   COORDINATOR_PG_EXPECTED_USER=pcc... \
 *   COORDINATOR_PG_EXPECTED_SYSTEM_IDENTIFIER=... \
 *   node --test build/projects/project-tasks-settled.pg.spec.js
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

interface Stack {
  db: PrismaClient;
  tasks: TasksService;
  producer: ProjectTasksSettledProducer;
  acceptance: ProjectAcceptanceService;
  projects: ProjectsService;
}

async function connect(): Promise<Stack> {
  await verifyDisposableDatabase();
  const db = prismaClientFor(URL!);
  const prisma = db as unknown as PrismaService;
  const realtime = new Proxy({}, { get: () => () => undefined }) as unknown as RealtimeService;
  const queue = { notifySessionQueued: () => undefined } as unknown as QueueService;
  const sessions = new SessionsService(prisma, queue, realtime);
  const acceptance = new ProjectAcceptanceService(prisma);
  const judgments = new CoordinatorJudgmentService(
    prisma,
    new CoordinatorWakeService(prisma),
    sessions,
  );
  const producer = new ProjectTasksSettledProducer(
    prisma,
    judgments,
    new CoordinatorConvergenceService(prisma),
  );
  return {
    db,
    producer,
    acceptance,
    projects: new ProjectsService(prisma, acceptance, sessions),
    tasks: new TasksService(prisma, sessions, realtime, undefined, producer),
  };
}

interface Fixture {
  ownerId: string;
  workspaceId: string;
  projectId: string;
  taskIds: string[];
}

async function fixture(stack: Stack, label: string, taskCount: number): Promise<Fixture> {
  const ownerId = randomUUID();
  const runnerId = randomUUID();
  const workspaceId = randomUUID();
  const projectId = randomUUID();
  await stack.db.user.create({
    data: {
      id: ownerId,
      email: `${label}-${ownerId}@settled.invalid`,
      name: label,
      passwordHash: 'x',
    },
  });
  await stack.db.runner.create({
    data: {
      id: runnerId,
      ownerId,
      name: `${label}-runner`,
      tokenHash: `hash-${runnerId}`,
      status: RunnerStatus.ONLINE,
      capabilities: [],
      capabilitiesReportedAt: new Date(),
    },
  });
  await stack.db.workspace.create({
    data: { id: workspaceId, ownerId, runnerId, name: `${label}-workspace`, enabled: true },
  });
  await stack.db.project.create({
    data: {
      id: projectId,
      ownerId,
      title: `${label} 验收项目`,
      acceptanceCriteria: 'main 上的路由行为符合设计\n全量服务测试通过',
      coordinatorEnabled: true,
      coordinatorWorkspaceId: workspaceId,
    },
  });
  const taskIds = Array.from({ length: taskCount }, () => randomUUID());
  await stack.db.task.createMany({
    data: taskIds.map((id, index) => ({
      id,
      ownerId,
      projectId,
      assigneeId: workspaceId,
      title: `${label} task ${index + 1}`,
      creatorType: CreatorType.USER,
      creatorId: ownerId,
      status: TaskStatus.IN_PROGRESS,
    })),
  });
  return { ownerId, workspaceId, projectId, taskIds };
}

async function judgmentSessions(stack: Stack, target: Fixture) {
  return stack.db.session.findMany({
    where: {
      ownerId: target.ownerId,
      dispatchOrigin: SessionDispatchOrigin.PROJECT_COORDINATOR,
      deletedAt: null,
    },
    select: { id: true, prompt: true },
  });
}

/**
 * Settle the complete, dynamically growing task set. A project criterion makes a normal DONE file
 * a verification task; that check is real project work and PROJECT_TASKS_SETTLED must wait for it.
 */
async function settleEveryProjectTask(stack: Stack, target: Fixture): Promise<void> {
  for (let round = 0; round < 10; round += 1) {
    const unfinished = await stack.db.task.findMany({
      where: {
        projectId: target.projectId,
        status: { notIn: [TaskStatus.DONE, TaskStatus.CANCELLED] },
      },
      select: { id: true, verifiesTaskId: true },
      orderBy: { createdAt: 'asc' },
    });
    if (unfinished.length === 0) return;
    for (const task of unfinished) {
      await stack.tasks.update(
        target.ownerId,
        task.id,
        {
          status: TaskStatus.DONE,
          ...(task.verifiesTaskId ? { verdict: TaskVerdict.PASS } : {}),
        } as never,
      );
    }
  }
  assert.fail('verification tasks did not settle within ten derivation rounds');
}

test('last terminal task wakes once, then the judgment opens and fills one acceptance run',
  { skip, timeout: 180_000 }, async () => {
    const stack = await connect();
    try {
      const target = await fixture(stack, 't7-close', 2);

      await stack.tasks.update(
        target.ownerId,
        target.taskIds[0],
        { status: TaskStatus.DONE } as never,
      );
      assert.equal(
        await stack.db.projectCoordinatorWake.count({ where: { projectId: target.projectId } }),
        0,
        'one unfinished sibling means there is no settled fact yet',
      );

      await settleEveryProjectTask(stack, target);
      await stack.producer.afterCommit([target.projectId]);
      await stack.producer.afterCommit([target.projectId]);

      const sessions = await judgmentSessions(stack, target);
      assert.equal(sessions.length, 1, 'redelivery of the committed fact must still wake once');
      assert.equal(
        await stack.db.projectCoordinatorWake.count({ where: { projectId: target.projectId } }),
        1,
      );

      // The judgment protocol's stale-safe order: evidence first, then freeze it in the run.
      await stack.acceptance.recordMergeEvidence(target.ownerId, target.projectId, {
        requirementId: 'main',
        targetBranch: 'main',
        contentHash: 'a'.repeat(64),
        source: 'T7_PG_SPEC',
        detail: { observation: 'main content checked before acceptance run' },
      });
      const run = await stack.acceptance.openRun(target.ownerId, target.projectId, {
        decidedBy: 'COORDINATOR_AGENT',
        coordinatorSessionId: sessions[0].id,
      });
      assert.equal(run.coordinatorSessionId, sessions[0].id);
      assert.equal(run.criteria.length, 2, 'one frozen checklist row per stated criterion');

      const concluded = await stack.acceptance.finalizeRun(
        target.ownerId,
        target.projectId,
        run.id,
        run.criteria.map((criterion) => ({
          ordinal: criterion.ordinal,
          verdict: ProjectAcceptanceVerdict.INCONCLUSIVE,
          summary: 'T7 judgment exercised the full per-criterion write path',
          evidence: { checkedFrom: 'main', result: 'requires human PASS boundary' },
        })),
        sessions[0].id,
      );
      assert.equal(concluded.verdict, ProjectAcceptanceVerdict.INCONCLUSIVE);
      assert.ok(concluded.criteria.every((criterion) => criterion.verdict !== null));

      const overview = await stack.acceptance.overview(target.ownerId, target.projectId);
      assert.equal(overview.runs.length, 1);
      assert.equal(overview.runsEmptyReason, null);
      assert.equal(overview.runs[0].criteria.length, overview.criteria.length);
      assert.ok(overview.runs[0].criteria.every((criterion) => criterion.verdict !== null));
      assert.equal(overview.status, 'OPEN', 'T7 never settles project.status itself');
      assert.equal(overview.doneGate.allowed, false, 'the existing gate still decides independently');

      await assert.rejects(
        stack.projects.update(
          target.ownerId,
          target.projectId,
          { status: 'DONE' } as never,
          sessions[0].id,
        ),
        (error: unknown) => {
          if (!(error instanceof ForbiddenException)) return false;
          return (error.getResponse() as { code?: string }).code === 'PROJECT_DONE_HUMAN_ONLY';
        },
        'the judgment must meet T6’s existing status=DONE boundary before the done gate',
      );
      assert.equal(
        (await stack.db.project.findUniqueOrThrow({ where: { id: target.projectId } })).status,
        'OPEN',
      );
    } finally {
      await stack.db.$disconnect();
    }
  });

test('empty merge evidence makes the judgment open merge work and stores no PASS',
  { skip, timeout: 180_000 }, async () => {
    const stack = await connect();
    try {
      const target = await fixture(stack, 't7-no-evidence', 1);
      await settleEveryProjectTask(stack, target);

      const [session] = await judgmentSessions(stack, target);
      assert.ok(session, 'the terminal write must open its judgment session');
      assert.match(session.prompt ?? '', /mergeEvidence 为空/);
      assert.match(session.prompt ?? '', /不得开 acceptance run，更不得写 PASS/);

      const before = await stack.acceptance.overview(target.ownerId, target.projectId);
      assert.equal(before.mergeEvidenceEmptyReason, 'NO_MERGE_EVIDENCE');
      assert.equal(before.runsEmptyReason, 'ACCEPTANCE_NOT_ATTEMPTED');
      const criterionKey = before.criteria[0].criterionKey;

      // Execute the branch the one-shot judgment is instructed to take: file merge/evidence work,
      // tied to a stated criterion, and stop. Its eventual terminal write will derive a NEW task-set
      // version and wake acceptance again after the work records main evidence.
      const mergeTask = await stack.tasks.create(
        target.ownerId,
        {
          title: '合并到 main 并录入 merge evidence',
          description: '先把实现落到 main，再记录内容证据；不要提前开 acceptance run。',
          projectId: target.projectId,
          assigneeId: target.workspaceId,
          criterionKey,
        },
        { type: CreatorType.AGENT, id: target.workspaceId },
        session.id,
      );
      assert.equal(mergeTask.status, TaskStatus.OPEN);
      assert.equal(mergeTask.projectId, target.projectId);

      assert.equal(
        await stack.db.projectAcceptanceRun.count({ where: { projectId: target.projectId } }),
        0,
        'no evidence means no digest may be frozen yet',
      );
      assert.equal(
        await stack.db.projectAcceptanceCriterion.count({
          where: { projectId: target.projectId, verdict: ProjectAcceptanceVerdict.PASS },
        }),
        0,
        'the missing-main branch cannot persist PASS',
      );
    } finally {
      await stack.db.$disconnect();
    }
  });

test('the T7 PostgreSQL target is explicitly disposable', { skip }, () => {
  assertCoordinatorPgUrlIsIsolated(URL);
});
