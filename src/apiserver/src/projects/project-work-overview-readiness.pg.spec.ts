import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import {
  CreatorType,
  PrismaClient,
  RunnerStatus,
  RunStatus,
  SessionDispatchOrigin,
  TaskCompletionCriterion,
  TaskCompletionPolicy,
  TaskStatus,
  TaskVerdict,
} from '@prisma/client';
import { Client } from 'pg';
import { prismaClientFor } from '../prisma/prisma-client';
import { PrismaService } from '../prisma/prisma.service';
import { manualRunnableTaskSql } from '../tasks/manual-runnable-task-sql';
import { TasksService } from '../tasks/tasks.service';
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from './coordinator-pg-test-safety';
import { readProjectListRollups } from './project-list-rollup';
import { readProjectTaskWorkStates } from './project-task-work-state';
import { ProjectsService } from './projects.service';

const URL = process.env.WORK_OVERVIEW_PG_URL;

interface World {
  ownerId: string;
  runnerId: string;
  workspaceId: string;
  projectId: string;
  ids: Record<string, string>;
}

async function makeWorld(db: PrismaClient): Promise<World> {
  const ownerId = randomUUID();
  const runnerId = randomUUID();
  const workspaceId = randomUUID();
  const projectId = randomUUID();
  await db.user.create({
    data: {
      id: ownerId,
      email: `work-overview-${ownerId}@fixture.invalid`,
      name: 'Work overview fixture',
      passwordHash: 'x',
    },
  });
  await db.runner.create({
    data: {
      id: runnerId,
      ownerId,
      name: 'Work overview runner',
      tokenHash: `hash-${runnerId}`,
      status: RunnerStatus.ONLINE,
      capabilities: [],
      capabilitiesReportedAt: new Date(),
    },
  });
  await db.workspace.create({
    data: {
      id: workspaceId,
      ownerId,
      runnerId,
      name: 'Work overview workspace',
      enabled: true,
    },
  });
  await db.project.create({
    data: { id: projectId, ownerId, title: 'Canonical Work overview matrix' },
  });

  const ids: Record<string, string> = {};
  const task = async (
    name: string,
    over: {
      status?: TaskStatus;
      completionCriterion?: TaskCompletionCriterion;
      completionPolicy?: TaskCompletionPolicy;
      verifiesTaskId?: string;
      parentTaskId?: string;
      autoRunWhenReady?: boolean;
      assigned?: boolean;
    } = {},
  ) => {
    const id = randomUUID();
    ids[name] = id;
    await db.task.create({
      data: {
        id,
        ownerId,
        projectId,
        title: name,
        creatorType: CreatorType.USER,
        creatorId: ownerId,
        assigneeId: over.assigned === false ? null : workspaceId,
        status: over.status ?? TaskStatus.OPEN,
        completionCriterion: over.completionCriterion ?? TaskCompletionCriterion.EVIDENCE_JUDGMENT,
        completionPolicy: over.completionPolicy ?? TaskCompletionPolicy.MANUAL,
        verifiesTaskId: over.verifiesTaskId,
        parentTaskId: over.parentTaskId,
        autoRunWhenReady: over.autoRunWhenReady ?? false,
      },
    });
    return id;
  };

  await task('manual-ready');
  await task('automatic-ready', { autoRunWhenReady: true });

  const allChildrenParent = await task('all-children-parent', {
    completionPolicy: TaskCompletionPolicy.ALL_CHILDREN_DONE,
  });
  await task('all-children-child', { parentTaskId: allChildrenParent });

  await task('subject-missing', {
    completionCriterion: TaskCompletionCriterion.VERIFICATION,
    completionPolicy: TaskCompletionPolicy.VERIFICATION_PASSED,
  });

  const subjectOpen = await task('subject-open', {
    completionCriterion: TaskCompletionCriterion.VERIFICATION,
    completionPolicy: TaskCompletionPolicy.VERIFICATION_PASSED,
  });
  await task('verifier-open', {
    completionCriterion: TaskCompletionCriterion.VERIFICATION,
    verifiesTaskId: subjectOpen,
    autoRunWhenReady: true,
  });

  const subjectBlocked = await task('subject-blocked', {
    completionCriterion: TaskCompletionCriterion.VERIFICATION,
    completionPolicy: TaskCompletionPolicy.VERIFICATION_PASSED,
  });
  const verifierBlocker = await task('verifier-blocker');
  const verifierBlocked = await task('verifier-blocked', {
    completionCriterion: TaskCompletionCriterion.VERIFICATION,
    verifiesTaskId: subjectBlocked,
    autoRunWhenReady: true,
  });
  await db.taskDependency.create({
    data: { taskId: verifierBlocked, dependsOnTaskId: verifierBlocker },
  });

  const subjectRunning = await task('subject-running', {
    completionCriterion: TaskCompletionCriterion.VERIFICATION,
    completionPolicy: TaskCompletionPolicy.VERIFICATION_PASSED,
  });
  const verifierRunning = await task('verifier-running', {
    completionCriterion: TaskCompletionCriterion.VERIFICATION,
    verifiesTaskId: subjectRunning,
    autoRunWhenReady: true,
  });
  await db.session.create({
    data: {
      ownerId,
      creatorId: ownerId,
      assignedRunnerId: runnerId,
      workspaceId,
      taskId: verifierRunning,
      title: 'running verifier',
      prompt: 'verify independently',
      status: RunStatus.RUNNING,
      dispatchOrigin: SessionDispatchOrigin.USER,
      startsTaskWork: true,
    },
  });

  const subjectFailed = await task('subject-failed', {
    completionCriterion: TaskCompletionCriterion.VERIFICATION,
    completionPolicy: TaskCompletionPolicy.VERIFICATION_PASSED,
  });
  const verifierFailed = await task('verifier-failed', {
    completionCriterion: TaskCompletionCriterion.VERIFICATION,
    verifiesTaskId: subjectFailed,
  });
  await db.task.update({ where: { id: verifierFailed }, data: { verdict: TaskVerdict.FAIL } });

  const subjectPassed = await task('subject-passed', {
    completionCriterion: TaskCompletionCriterion.VERIFICATION,
    completionPolicy: TaskCompletionPolicy.VERIFICATION_PASSED,
  });
  const verifierPassed = await task('verifier-passed', {
    completionCriterion: TaskCompletionCriterion.VERIFICATION,
    verifiesTaskId: subjectPassed,
  });
  await db.session.create({
    data: {
      ownerId,
      creatorId: ownerId,
      assignedRunnerId: runnerId,
      workspaceId,
      taskId: verifierPassed,
      title: 'settled verifier',
      prompt: 'verify independently',
      status: RunStatus.SUCCEEDED,
      dispatchOrigin: SessionDispatchOrigin.USER,
      endReason: 'task_done',
      completedAt: new Date(),
      startsTaskWork: true,
    },
  });
  // No ledger row behind it: nothing has written `project_action` since the control loop went, and
  // a settled PASS is canonical on the check's own facts.
  await db.task.update({ where: { id: verifierPassed }, data: { verdict: TaskVerdict.PASS } });
  await db.task.update({ where: { id: subjectPassed }, data: { status: TaskStatus.DONE } });

  const successor = await task('failed-successor');
  const failedHistory = await task('failed-superseded-history', { status: TaskStatus.FAILED });
  await db.$executeRawUnsafe(
    `UPDATE "task" SET "superseded_by_task_id" = $2::uuid,
       "terminal_reason" = 'SUPERSEDED', "superseded_at" = now(), "updated_at" = now()
     WHERE "id" = $1::uuid`,
    failedHistory,
    successor,
  );
  await task('cancelled-history', { status: TaskStatus.CANCELLED });

  // A gate row carrying the pair the write doors now refuse: `EVIDENCE_JUDGMENT` cannot declare
  // `VERIFICATION_PASSED` (task-completion-criterion.ts), and rows written before that rule can hold
  // it. `completion_policy` is what says nothing here will ever run; the criterion says who would
  // have settled a row with work. The lane has always read this as a subject; the detail read used
  // to ask the criterion as well, and answered nothing about it.
  await task('legacy-gate', {
    completionCriterion: TaskCompletionCriterion.EVIDENCE_JUDGMENT,
    completionPolicy: TaskCompletionPolicy.VERIFICATION_PASSED,
  });

  return { ownerId, runnerId, workspaceId, projectId, ids };
}

test('Work overview readiness is canonical, exhaustive, and verification-aware',
  { skip: !URL, timeout: 300_000 }, async (t) => {
    assertCoordinatorPgUrlIsIsolated(URL);
    const identity = new Client({ connectionString: URL, connectionTimeoutMillis: 2_000 });
    await identity.connect();
    await verifyCoordinatorPgIdentity(identity);
    const db = prismaClientFor(URL);
    const prisma = db as unknown as PrismaService;
    const projects = new ProjectsService(prisma);
    // Only its detail read is used, which neither starts a session nor publishes.
    const tasks = new TasksService(prisma, {} as never, {
      publishTaskChanged() {},
      publishForUser() {},
    } as never);

    try {
      const world = await makeWorld(db);
      const states = await readProjectTaskWorkStates(
        prisma,
        world.ownerId,
        world.projectId,
      );
      const state = (name: string) => states.get(world.ids[name]);

      await t.test('ordinary manual and automatic leaves remain READY', () => {
        assert.deepEqual(state('manual-ready'), { workState: 'READY', verificationState: null });
        assert.deepEqual(state('automatic-ready'), { workState: 'READY', verificationState: null });
      });

      await t.test('ALL_CHILDREN_DONE parent is completion-owned while its child is runnable', () => {
        assert.equal(state('all-children-parent')?.workState, 'BLOCKED');
        assert.equal(state('all-children-child')?.workState, 'READY');
      });

      await t.test('missing verifier is explicit and never READY', () => {
        assert.deepEqual(state('subject-missing'), {
          workState: 'AWAITING_VERIFICATION',
          verificationState: 'MISSING',
        });
      });

      await t.test('OPEN verifier is a pending verification, not subject work', () => {
        assert.deepEqual(state('subject-open'), {
          workState: 'AWAITING_VERIFICATION',
          verificationState: 'PENDING',
        });
        assert.equal(state('verifier-open')?.workState, 'READY');
      });

      await t.test('blocked verifier is distinguished from an ordinary pending verifier', () => {
        assert.deepEqual(state('subject-blocked'), {
          workState: 'AWAITING_VERIFICATION',
          verificationState: 'BLOCKED',
        });
        assert.equal(state('verifier-blocked')?.workState, 'BLOCKED');
      });

      await t.test('running verifier is reported from its live task-work session', () => {
        assert.deepEqual(state('subject-running'), {
          workState: 'AWAITING_VERIFICATION',
          verificationState: 'RUNNING',
        });
        assert.equal(state('verifier-running')?.workState, 'RUNNING');
      });

      await t.test('FAIL is actionable verification failure and remains outside READY', () => {
        assert.deepEqual(state('subject-failed'), {
          workState: 'AWAITING_VERIFICATION',
          verificationState: 'FAILED',
        });
        assert.equal(state('verifier-failed')?.workState, 'DONE');
      });

      await t.test('only a canonical settled PASS completes the subject', () => {
        assert.deepEqual(state('subject-passed'), {
          workState: 'DONE',
          verificationState: 'PASSED',
        });
      });

      await t.test('the task detail reports the verifier state of every task from this same read', async () => {
        // The detail panel's button reads `verificationState` off GET /tasks/:id; the project page
        // and its graph read `states`. Every state above is in this world, and so are non-subjects.
        // `legacy-gate` is what makes the comparison discriminating rather than a null-vs-null walk:
        // it is a subject by policy, and this read answers about it only if it asks the same columns.
        const detail = (name: string) => tasks.get(world.ownerId, world.ids[name]);
        for (const name of Object.keys(world.ids)) {
          assert.equal((await detail(name)).verificationState, state(name)?.verificationState, name);
        }
        // Not a comparison that could pass on nulls alone.
        assert.equal((await detail('subject-missing')).verificationState, 'MISSING');
        assert.equal((await detail('subject-passed')).verificationState, 'PASSED');
        assert.equal((await detail('legacy-gate')).verificationState, 'MISSING');
        assert.equal((await detail('manual-ready')).verificationState, null);
      });

      await t.test('the task detail names the check that settles a row, and only that check', async () => {
        // The panel shows the check under the row it checks, so the detail carries the check itself
        // — the newest live one, read through the same selector dependency release and the lanes
        // use, never a second ordering of the same rows.
        const detail = (name: string) => tasks.get(world.ownerId, world.ids[name]);
        assert.deepEqual((await detail('subject-open')).verifier, {
          id: world.ids['verifier-open'],
          title: 'verifier-open',
          status: 'OPEN',
          verdict: null,
        });
        // A conclusion rides along, which is what the card reads to say PASS or FAIL — and the
        // check's own task status is DONE either way: a check that concluded has finished.
        assert.deepEqual((await detail('subject-failed')).verifier, {
          id: world.ids['verifier-failed'],
          title: 'verifier-failed',
          status: 'DONE',
          verdict: 'FAIL',
        });
        assert.equal((await detail('subject-passed')).verifier?.verdict, 'PASS');
        // A row nothing checks has no card to draw — including a check nobody checks.
        assert.equal((await detail('manual-ready')).verifier, null);
        assert.equal((await detail('verifier-open')).verifier, null);
        assert.equal((await detail('legacy-gate')).verifier, null);
      });

      await t.test('FAILED to SUPERSEDED history remains an explicit failed denominator item', () => {
        assert.equal(state('failed-superseded-history')?.workState, 'FAILED');
        assert.equal(state('failed-successor')?.workState, 'READY');
      });

      await t.test('manual execute SQL refuses every verification subject', async () => {
        const rows = await db.$queryRawUnsafe<Array<{ title: string; runnable: boolean }>>(
          `SELECT t."title", (${manualRunnableTaskSql('t')}) AS runnable
             FROM "task" t
            WHERE t."project_id" = $1::uuid
              AND t."completion_criterion" = 'VERIFICATION'
              AND t."completion_policy" = 'VERIFICATION_PASSED'
              AND t."verifies_task_id" IS NULL
            ORDER BY t."title"`,
          world.projectId,
        );
        assert.ok(rows.length >= 6);
        assert.ok(rows.every((row) => row.runnable === false), JSON.stringify(rows));
      });

      await t.test('Run queue contains executable work but no verification subject or aggregate parent', async () => {
        const ready = await projects.panoramaReady(world.ownerId, world.projectId, { limit: '50' });
        const ids = new Set(ready.items.map((item) => item.taskId));
        assert.ok(ids.has(world.ids['manual-ready']));
        assert.ok(ids.has(world.ids['automatic-ready']));
        assert.ok(!ids.has(world.ids['subject-open']));
        assert.ok(!ids.has(world.ids['subject-missing']));
        assert.ok(!ids.has(world.ids['all-children-parent']));
      });

      await t.test('panorama and project-list rollup share one exhaustive count', async () => {
        const panorama = await projects.panorama(world.ownerId, world.projectId);
        const list = (await readProjectListRollups(prisma, world.ownerId)).get(world.projectId);
        assert.ok(list);
        assert.deepEqual(list.buckets, panorama.buckets);
        assert.equal(list.taskCount, panorama.shape.taskCount);
        assert.equal(panorama.buckets.failed, 1);
        const sum = Object.values(panorama.buckets).reduce((total, value) => total + value, 0);
        assert.equal(sum, panorama.shape.taskCount);
        assert.equal(sum, await db.task.count({ where: { projectId: world.projectId } }));
      });

      await t.test('task cards carry canonical state and automation mode', async () => {
        const page = await projects.taskPage(world.ownerId, world.projectId, { limit: '100' });
        const byTitle = new Map(page.items.map((item) => [item.title, item]));
        assert.equal(byTitle.get('subject-failed')?.workState, 'AWAITING_VERIFICATION');
        assert.equal(byTitle.get('subject-failed')?.verificationState, 'FAILED');
        assert.equal(byTitle.get('subject-missing')?.verificationState, 'MISSING');
        assert.equal(byTitle.get('manual-ready')?.workState, 'READY');
        assert.equal(byTitle.get('manual-ready')?.autoRunWhenReady, false);
        assert.equal(byTitle.get('automatic-ready')?.workState, 'READY');
        assert.equal(byTitle.get('automatic-ready')?.autoRunWhenReady, true);
      });

      await t.test('topology marks consume canonical state rather than indegree', async () => {
        const graph = await projects.dependencyGraph(world.ownerId, world.projectId);
        const marks = new Map(graph.marks
          .filter((mark) => mark.kind === 'TASK')
          .map((mark) => [mark.title, mark]));
        const missing = marks.get('subject-missing');
        assert.equal(missing?.workState, 'AWAITING_VERIFICATION');
        assert.equal(missing?.verificationState, 'MISSING');
        assert.equal(marks.get('manual-ready')?.workState, 'READY');
        assert.equal(marks.get('failed-superseded-history')?.workState, 'FAILED');
      });
    } finally {
      await db.$disconnect();
      await identity.end();
    }
  });
