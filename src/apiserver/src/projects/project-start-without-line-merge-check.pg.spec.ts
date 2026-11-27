/**
 * Board docs/mocks/landing-measured ruling D8 (owner, 2026-11-20): a start with no line keeps the
 * merge check the owner sets on the start card.
 *
 * P-M2 (`project-start-without-line.pg.spec.ts`) writes nothing about the line or the landing check
 * at such a start and needs no repository, and until this the merge check went with them. The
 * check now lives in the start's own record (`project_standard_set_confirmation.started_with`)
 * until the line starts, and the binding the first committing DONE makes starts from it:
 *
 *   (1) a start request with no line and a merge check, answered at the start door with
 *       `mergeCheckCommand` (and, in one case, `mergeCheckTimeoutSeconds`), starts the project: no
 *       INTEGRATION_REPOSITORY_UNKNOWN, no `project_codebase` row, the request answered;
 *   (2) the check reads back on the started project from the confirmation read
 *       (`GET /projects/:id/acceptance/confirmation` → `confirmation.startedWith.settings`);
 *   (3) the first DONE with a commit of its own starts the line, and the binding carries that
 *       check and its budget — null when none was sent;
 *   (4) a project already bound before the start (an owner who set its main branch first) has the
 *       check written on that binding at the start, with its line still undecided, and keeps it
 *       through the first committing DONE.
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/projects/project-start-without-line-merge-check.pg.spec.ts
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import {
  RunnerStatus,
  SessionDispatchOrigin,
  TaskStatus,
} from '@prisma/client';
import { RunStatus } from '@orbit/shared';
import type { PrismaClient } from '@prisma/client';
import { type ProjectStartRequestFiled } from '@orbit/shared';
import { Client } from 'pg';

import { prismaClientFor } from '../prisma/prisma-client';
import type { PrismaService } from '../prisma/prisma.service';
import type { PushService } from '../push/push.service';
import type { QueueService } from '../queue/queue.service';
import type { RealtimeService } from '../realtime/realtime.service';
import { RunnerApiController } from '../runner-api/runner-api.controller';
import { RunnerProjectsController } from '../runner-api/runner-projects.controller';
import { SessionsService } from '../sessions/sessions.service';
import { TaskOwnerConfirmationService } from '../tasks/task-owner-confirmation.service';
import { TasksService } from '../tasks/tasks.service';
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from './coordinator-pg-test-safety';
import { ProjectAcceptanceService } from './project-acceptance.service';
import { ProjectOpenItemService } from './project-open-item.service';
import { ProjectsService } from './projects.service';

const URL = process.env.COORDINATOR_PG_URL;
const skip = !URL;
const sha = (nibble: string) => nibble.repeat(40);
const CRITERION = 'the work lands once a task commits';
const CHECK = 'npm test';
const TOUCHED = [{ path: 'src/thing.ts', status: 'M', additions: 1, deletions: 0 }];

const CASES = [
  { name: 'no repository, a check with a budget', withRepo: false, prebound: false, budget: 900 as number | undefined },
  { name: 'a repository, a check with no budget', withRepo: true, prebound: false, budget: undefined },
  { name: 'a binding made before the start', withRepo: true, prebound: true, budget: 600 },
];

for (const c of CASES) test(`a start with no line keeps its merge check until the line starts (${c.name})`, {
  skip, concurrency: 1, timeout: 300_000,
}, async (t) => {
  const url = URL!;
  assertCoordinatorPgUrlIsIsolated(url);
  const sql = new Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
  await sql.connect();
  await verifyCoordinatorPgIdentity(sql);
  const prisma: PrismaClient = prismaClientFor(url);
  t.after(async () => {
    await prisma.$disconnect().catch(() => undefined);
    await sql.end().catch(() => undefined);
  });

  const db = prisma as unknown as PrismaService;
  const realtime = new Proxy({}, { get: () => () => undefined }) as unknown as RealtimeService;
  const queue = { notifySessionQueued: () => undefined } as unknown as QueueService;
  const push = new Proxy({}, { get: () => () => Promise.resolve() }) as unknown as PushService;
  const sessions = new SessionsService(db, queue, realtime);
  const acceptance = new ProjectAcceptanceService(db, sessions);
  const projects = new ProjectsService(db, acceptance, sessions);
  const openItems = new ProjectOpenItemService(db, sessions, push);
  const tasks = new TasksService(db, sessions, realtime, undefined, undefined, undefined, openItems);
  const confirmations = new TaskOwnerConfirmationService(db, sessions, tasks, realtime);
  const door = new RunnerProjectsController(
    projects,
    acceptance,
    {} as never,
    { assert: async () => assert.fail('a start request spends no orchestration credential') } as never,
    openItems,
  );
  const runnerApi = new RunnerApiController(
    db, queue, realtime, {} as never, {} as never,
    { expand: async (_ownerId: string, content?: string) => content } as never,
    { appendFor: async (_tx: unknown, _sessionId: string, content?: string) => content } as never,
  );
  void runnerApi;

  const ownerId = randomUUID();
  const runnerId = randomUUID();
  const coordinationWorkspaceId = randomUUID();
  const workWorkspaceId = randomUUID();
  const coordinatorSessionId = randomUUID();
  const projectId = randomUUID();
  const repoUrl = `https://git.invalid/orbit/no-line-check-${projectId.slice(0, 8)}.git`;
  await prisma.user.create({
    data: { id: ownerId, email: `no-line-check-${ownerId}@project-start.invalid`, name: 'owner', passwordHash: 'x' },
  });
  await prisma.runner.create({
    data: {
      id: runnerId, ownerId, name: 'no-line-runner', tokenHash: `hash-${runnerId}`,
      status: RunnerStatus.ONLINE, capabilities: [], capabilitiesReportedAt: new Date(),
      lastHeartbeatAt: new Date(),
    },
  });
  // The coordination workspace names no repository; the workspace the work runs in does.
  await prisma.workspace.create({
    data: { id: coordinationWorkspaceId, ownerId, runnerId, name: 'coordination', enabled: true, repoUrl: c.withRepo ? repoUrl : null },
  });
  await prisma.workspace.create({
    data: {
      id: workWorkspaceId, ownerId, runnerId, name: 'work', enabled: true, repoUrl, workDir: '/srv/no-line',
    },
  });
  await prisma.session.create({
    data: {
      id: coordinatorSessionId, ownerId, creatorId: ownerId, workspaceId: coordinationWorkspaceId,
      assignedRunnerId: runnerId, title: 'coordinator', prompt: 'coordinator', provider: 'claude',
      turnState: null, dispatchOrigin: SessionDispatchOrigin.USER,
      titleManagedByProject: true, numTurns: 1, startedAt: new Date(),
      runtimeSessionId: `runtime-${coordinatorSessionId}`,
    },
  });
  await prisma.conversationTurn.create({
    data: {
      sessionId: coordinatorSessionId, seq: 1,
      clientTurnId: SessionsService.initialTurnClientId(coordinatorSessionId),
      kind: 'message', content: 'coordinator', status: 'ANSWERED',
    },
  });
  await prisma.project.create({
    data: {
      id: projectId, ownerId, title: 'no line', coordinatorWorkspaceId: coordinationWorkspaceId,
      coordinatorSessionId,
    },
  });
  await prisma.projectRuntime.upsert({ where: { projectId }, create: { projectId }, update: {} });
  await projects.update(ownerId, projectId, {
    acceptanceCriteriaItems: [{ text: CRITERION, verificationMethod: 'VERIFICATION' }],
  } as never);
  const [{ id: criterionId }] = (await sql.query<{ id: string }>(
    `SELECT "id" FROM "project_acceptance_criterion_definition" WHERE "project_id" = $1::uuid`, [projectId],
  )).rows;
  // OWNER_CONFIRMED work that is not declared codeless: the shape the removed warning was about.
  const task = async (title: string, status: TaskStatus) => (await prisma.task.create({
    data: {
      ownerId, creatorType: 'USER', creatorId: ownerId, title, projectId, assigneeId: workWorkspaceId,
      completionCriterion: 'OWNER_CONFIRMED', status, autoRunWhenReady: true,
      criterionDefinitionId: criterionId, criterionRevision: 1,
    },
    select: { id: true },
  })).id;
  const first = await task('first', TaskStatus.IN_PROGRESS);
  const second = await task('second', TaskStatus.OPEN);
  await prisma.taskDependency.create({ data: { taskId: second, dependsOnTaskId: first } });

  const binding = async () => (await sql.query<{
    merge_check_command: string | null;
    merge_check_timeout_seconds: number | null;
    integration_ref_source: string;
    integration_started_at: string | null;
  }>(
    `SELECT "merge_check_command", "merge_check_timeout_seconds", "integration_ref_source"::text,
            "integration_started_at"::text AS "integration_started_at"
       FROM "project_codebase" WHERE "project_id" = $1::uuid`, [projectId],
  )).rows;
  const runner = { id: runnerId, ownerId } as never;

  if (c.prebound) {
    await projects.configureIntegration(ownerId, projectId, { upstreamRef: 'refs/heads/main' } as never);
    const [made] = await binding();
    assert.equal(made?.merge_check_command, null, 'CONTROL: the binding made before the start has no check');
  }

  // (1) the request names no line; the card answers it with a merge check.
  const filed = await door.requestStart(runner, coordinatorSessionId, projectId, {
    maxConcurrentTasks: 2, mergeCheckCommand: CHECK, why: 'the plan is ready; the line starts at the first commit',
  } as never) as ProjectStartRequestFiled;
  assert.equal(filed.state, 'OPEN');
  const [stored] = (await sql.query<{ id: string; payload: { settings: Record<string, unknown> } }>(
    `SELECT "id", "payload" FROM "project_open_item"
      WHERE "project_id" = $1::uuid AND "kind" = 'START_REQUEST' AND "state" = 'OPEN'`, [projectId],
  )).rows;
  assert.ok(stored, 'the request is filed');
  assert.equal('line' in stored.payload.settings, false, 'it carries no line');

  const digest = (await acceptance.standardSetConfirmation(ownerId, projectId)).currentVersion.digest;
  const started = await acceptance.startProject(ownerId, projectId, {
    criteriaDigest: digest, automatic: true, maxConcurrentTasks: 2, requestId: stored.id,
    mergeCheckCommand: `  ${CHECK} `,
    ...(c.budget !== undefined ? { mergeCheckTimeoutSeconds: c.budget } : {}),
  } as never);
  assert.equal('line' in started.settings, false, 'the record names no line');
  assert.equal(started.lineLocked, false);
  assert.equal(started.settings.mergeCheckCommand, CHECK, 'the start records the check, trimmed');
  assert.equal(started.settings.mergeCheckTimeoutSeconds, c.budget ?? null);
  assert.equal(started.differsFromRequest.includes('mergeCheckCommand'), false,
    'the check is the one the request proposed');
  const [project] = (await sql.query<{ started_at: string | null }>(
    `SELECT "started_at"::text AS "started_at" FROM "project" WHERE "id" = $1::uuid`, [projectId],
  )).rows;
  assert.ok(project.started_at, 'the project has started');
  const [answered] = (await sql.query<{ state: string; resolution: string }>(
    `SELECT "state", "resolution" FROM "project_open_item" WHERE "id" = $1::uuid`, [stored.id],
  )).rows;
  assert.deepEqual(answered, { state: 'RESOLVED', resolution: 'APPROVED' });
  if (c.prebound) {
    const [held] = await binding();
    assert.deepEqual(held, {
      merge_check_command: CHECK, merge_check_timeout_seconds: c.budget ?? null,
      integration_ref_source: 'DEFAULT_RULE', integration_started_at: null,
    }, 'the existing binding takes the check, and its line is still nobody\'s choice');
  } else {
    assert.deepEqual(await binding(), [], 'no project_codebase row exists after the start');
  }

  // (2) the check reads back on the started project, line or no line.
  const read = await acceptance.standardSetConfirmation(ownerId, projectId);
  const startedWith = read.confirmation?.startedWith;
  assert.ok(startedWith, 'the confirmation read carries the start record');
  assert.equal('line' in startedWith.settings, false);
  assert.equal(startedWith.settings.mergeCheckCommand, CHECK);
  assert.equal(startedWith.settings.mergeCheckTimeoutSeconds, c.budget ?? null);

  // (3) the first DONE with a commit of its own starts the line, carrying that check.
  const sessionId = randomUUID();
  await prisma.session.create({
    data: {
      id: sessionId, ownerId, creatorId: ownerId, taskId: first, workspaceId: workWorkspaceId,
      assignedRunnerId: runnerId, title: 'work', prompt: 'work', provider: 'claude',
      turnState: null, dispatchOrigin: SessionDispatchOrigin.USER, startsTaskWork: true,
      isolationStatus: 'worktree', branch: 'orbit/first', branchSha: sha('c'), baseSha: sha('b'),
      changedFiles: TOUCHED, numTurns: 1, startedAt: new Date(Date.now() - 600_000),
      createdAt: new Date(Date.now() - 600_000), finishedAt: new Date(Date.now() - 60_000),
    },
  });
  const receipt = await confirmations.decide(
    ownerId, first, { door: 'USER', userId: ownerId }, { decision: 'CONFIRM' } as never,
  );
  assert.equal(receipt.completed, true, 'CONTROL: the confirmation wrote DONE');
  const [line] = await binding();
  assert.ok(line?.integration_started_at, 'the first commit started the line');
  assert.equal(line.merge_check_command, CHECK, 'the line carries the check the owner chose at the start');
  assert.equal(line.merge_check_timeout_seconds, c.budget ?? null, 'and the budget sent with it');
  const view = await projects.integration(ownerId, projectId);
  assert.equal(view.mergeCheckCommand, CHECK, 'the integration read shows it once the line has started');
  const jobs = (await sql.query<{ kind: string; task_id: string }>(
    `SELECT "kind", "task_id" FROM "project_integration_job" WHERE "project_id" = $1::uuid`, [projectId],
  )).rows;
  assert.deepEqual(jobs.map((job) => [job.kind, job.task_id]), [['LAND_TASK', first]]);
});
