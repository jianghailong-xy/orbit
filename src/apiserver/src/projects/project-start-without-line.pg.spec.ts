/**
 * §12.15 P-M2 (`docs/project-integration-line-contract.md`, revision 42): a project can start with
 * no line and no repository.
 *
 *   (1) `project_request_start` without `line` is accepted for a project whose coordination
 *       workspace names no repository — no START_REPOSITORY_UNKNOWN — and the plan, which holds
 *       work that LOOKS codeless and does not declare it, produces no codeless warning;
 *   (2) the start door starts it with no line in the body: no INTEGRATION_REPOSITORY_UNKNOWN, the
 *       project has started, its request is answered, the settings record names no line, and no
 *       `project_codebase` row exists afterwards;
 *   (3) the first DONE with a commit of its own then starts the line by the default rule (L2, L3):
 *       the binding is made from the repository the task's work ran in, the line starts on the
 *       project's own branch, and the task is queued;
 *   (4) a request that carries a line is unchanged: a project branch with no repository is still
 *       refused, and so is the start door's.
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/projects/project-start-without-line.pg.spec.ts
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import { HttpException } from '@nestjs/common';
import {
  RunnerStatus,
  SessionDispatchOrigin,
  TaskStatus,
} from '@prisma/client';
import { RunStatus } from '@orbit/shared';
import type { PrismaClient } from '@prisma/client';
import { type ProjectStartRequestFiled } from '@orbit/shared';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
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
import { RequestProjectStartDto, StartProjectDto } from './dto';
import { ProjectAcceptanceService } from './project-acceptance.service';
import { ProjectOpenItemService } from './project-open-item.service';
import { ProjectsService } from './projects.service';

const URL = process.env.COORDINATOR_PG_URL;
const skip = !URL;
const sha = (nibble: string) => nibble.repeat(40);
const CRITERION = 'the work lands once a task commits';
const TOUCHED = [{ path: 'src/thing.ts', status: 'M', additions: 1, deletions: 0 }];

for (const withRepo of [false, true]) test(`a project starts with no line${withRepo ? ' (its coordination workspace names a repository)' : ' and no repository'}, and its line starts at the first commit`, {
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
  const repoUrl = `https://git.invalid/orbit/no-line-${projectId.slice(0, 8)}.git`;
  await prisma.user.create({
    data: { id: ownerId, email: `no-line-${ownerId}@project-start.invalid`, name: 'owner', passwordHash: 'x' },
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
    data: { id: coordinationWorkspaceId, ownerId, runnerId, name: 'coordination', enabled: true, repoUrl: withRepo ? repoUrl : null },
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

  const bindings = async () => Number((await sql.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM "project_codebase" WHERE "project_id" = $1::uuid`, [projectId],
  )).rows[0].n);
  const refused = async (action: () => Promise<unknown>) => {
    try {
      await action();
    } catch (error) {
      assert.ok(error instanceof HttpException, String(error));
      return error.getResponse() as { code?: string; findings?: Array<{ code: string }> };
    }
    return assert.fail('the call was expected to be refused and was not');
  };
  const runner = { id: runnerId, ownerId } as never;
  const ask = (body: Record<string, unknown>) =>
    door.requestStart(runner, coordinatorSessionId, projectId, body as never) as Promise<ProjectStartRequestFiled>;

  // The two doors' bodies are validated before the services see them: a body with no line passes.
  assert.deepEqual(await validate(plainToInstance(RequestProjectStartDto, {
    maxConcurrentTasks: 2, why: 'ready',
  }), { whitelist: true }), [], 'the request body validates with no line');
  assert.deepEqual(await validate(plainToInstance(StartProjectDto, {
    criteriaDigest: 'a'.repeat(64), automatic: true, maxConcurrentTasks: 2, mergeCheckCommand: null,
  }), { whitelist: true }), [], 'the start body validates with no line');

  // (4, first half) a request that carries a line is unchanged: no repository, no project branch.
  if (!withRepo) {
    const withLine = await refused(() => ask({
      line: 'PROJECT_BRANCH', maxConcurrentTasks: 2, why: 'a branch, with no repository to hold it',
    }));
    assert.equal(withLine.code, 'START_REQUEST_NOT_READY');
    assert.ok(withLine.findings?.some((finding) => finding.code === 'START_REPOSITORY_UNKNOWN'));
  }

  // (1) no line: accepted, and no codeless warning.
  const filed = await ask({ maxConcurrentTasks: 2, why: 'the plan is ready; the line starts at the first commit' });
  assert.equal(filed.state, 'OPEN');
  assert.deepEqual(filed.warnings.map((warning) => warning.code), [],
    'no START_CRITERION_CODELESS_UNDECLARED, and nothing else to warn about');
  const [stored] = (await sql.query<{ id: string; payload: { settings: Record<string, unknown> } }>(
    `SELECT "id", "payload" FROM "project_open_item"
      WHERE "project_id" = $1::uuid AND "kind" = 'START_REQUEST' AND "state" = 'OPEN'`, [projectId],
  )).rows;
  assert.ok(stored, 'the request is filed');
  assert.equal('line' in stored.payload.settings, false, 'it carries no line');
  assert.equal(await bindings(), 0, 'filing a request writes no binding');

  // (4, second half) the start door with a line is unchanged.
  const digest = (await acceptance.standardSetConfirmation(ownerId, projectId)).currentVersion.digest;
  const body = { criteriaDigest: digest, automatic: true, maxConcurrentTasks: 2, mergeCheckCommand: null };
  if (!withRepo) {
    const startWithLine = await refused(() => acceptance.startProject(ownerId, projectId, {
      ...body, line: 'PROJECT_BRANCH',
    } as never));
    assert.equal(startWithLine.code, 'INTEGRATION_REPOSITORY_UNKNOWN');
  }

  // (2) no line: the door starts it.
  const started = await acceptance.startProject(ownerId, projectId, { ...body, requestId: stored.id } as never);
  assert.equal('line' in started.settings, false, 'the record names no line');
  assert.equal(started.lineLocked, false);
  const [project] = (await sql.query<{ started_at: string | null }>(
    `SELECT "started_at"::text AS "started_at" FROM "project" WHERE "id" = $1::uuid`, [projectId],
  )).rows;
  assert.ok(project.started_at, 'the project has started');
  assert.equal(await bindings(), 0, 'no project_codebase row exists after the start');
  const [answered] = (await sql.query<{ state: string; resolution: string }>(
    `SELECT "state", "resolution" FROM "project_open_item" WHERE "id" = $1::uuid`, [stored.id],
  )).rows;
  assert.deepEqual(answered, { state: 'RESOLVED', resolution: 'APPROVED' });

  // (3) the first DONE with a commit of its own starts the line by the default rule.
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
  const [line] = (await sql.query<{
    integration_ref: string; upstream_ref: string; integration_started_at: string | null;
  }>(
    `SELECT "integration_ref", "upstream_ref", "integration_started_at"::text AS "integration_started_at"
       FROM "project_codebase" WHERE "project_id" = $1::uuid`, [projectId],
  )).rows;
  assert.ok(line?.integration_started_at, 'the first commit started the line');
  assert.notEqual(line.integration_ref, line.upstream_ref,
    'a task with a dependent: the default rule gives the project its own branch');
  const jobs = (await sql.query<{ kind: string; task_id: string }>(
    `SELECT "kind", "task_id" FROM "project_integration_job" WHERE "project_id" = $1::uuid`, [projectId],
  )).rows;
  assert.deepEqual(jobs.map((job) => [job.kind, job.task_id]), [['LAND_TASK', first]]);
});
