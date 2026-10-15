/**
 * Deleting a task that has LANDED, on real PostgreSQL, through the services a caller reaches.
 *
 * WHAT WAS BROKEN
 * ---------------
 * `project_integration_job.task_id` was a foreign key `ON DELETE SET NULL` (0281), and 0281 gave the
 * table a BEFORE UPDATE trigger that refuses any UPDATE of a row that is no longer QUEUED or RUNNING
 * (`project_integration_job_terminal_guard`, J4). Deleting a task makes the foreign key write
 * `task_id = NULL` on every job of that task — an UPDATE of a finished row — so the guard refuses it,
 * the whole DELETE rolls back, and the caller gets a 500 with a `P0001
 * PROJECT_INTEGRATION_JOB_TERMINAL` in it. The walkthrough project that found this
 * (34f83iYKYg4WCPvCJ0R6h) has two landed tasks that cannot be deleted, and its project cannot be
 * deleted until they are.
 *
 * The guard's own reason to exist is that a finished job is the audit of what the platform pushed,
 * and the task-id trace it carries is part of that audit. So the fix is not to let the guard through:
 * the foreign key is dropped and `task_id` stays — a history reference with no foreign key, exactly
 * as `project_integration_job.retry_of_job_id` already is (0344) and as
 * `docs/project-integration-line-contract.md` §2.1 revision 12 requires for `task_id` and
 * `session_id`. Deleting a task now leaves the job rows alone: state, shas, receipts and the id of
 * the task they were about all survive it.
 *
 * THE CASES
 * ---------
 *  (a) A finished landing (`LANDED`, with a receipt and matching trees): the delete goes through, the
 *      task is gone, and its job row still says everything it said — including which task it was.
 *  (b) A failed landing (`CHECK_FAILED`, with its error code and conflicting paths): the same, so the
 *      fix is not written around one terminal state.
 *  (c) The project path: delete the tasks, then the project (which is how the walkthrough project was
 *      stuck — `ProjectsService.remove` deletes empty projects only, and its integration jobs go with
 *      the project by 0281's own `project_integration_job_project_fkey`). No 500 at either step.
 *  (d) A landing still in flight: the delete does not touch its row either, and the row keeps its
 *      task id — the mechanism has one behaviour for every state, rather than one for terminal rows
 *      and a different one for live ones. Whether a queued landing of a deleted task should be
 *      cancelled instead is a separate question about the queue (`docs/landing-session-design.md`
 *      §9 item 5), not about the delete.
 *  (e) The control: an ordinary rewrite of a finished row is STILL refused by the guard. Dropping the
 *      foreign key must not be mistaken for relaxing J4 — without this case a fix that deleted the
 *      trigger too would pass (a)–(d).
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/tasks/task-delete-integration-job.pg.spec.ts
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { CreatorType, PrismaClient, RunStatus, TaskStatus } from '@prisma/client';
import { Client } from 'pg';
import type { PrismaService } from '../prisma/prisma.service';
import { prismaClientFor } from '../prisma/prisma-client';
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from '../projects/coordinator-pg-test-safety';
import { establishProjectContractForPgTest } from '../projects/project-contract-test-helper';
import { ProjectsService } from '../projects/projects.service';
import { TasksService } from './tasks.service';

const URL = process.env.COORDINATOR_PG_URL;

const cancelled: string[] = [];

/**
 * The two services, built the way the rest of this tree builds them: the real classes over the real
 * client, with the two collaborators `TasksService.remove` talks to stubbed. Nothing here reaches a
 * runner — `sessions.cancel` records instead, which is also how case (c) knows the delete did not
 * decide to end a run that had already finished.
 */
function services(db: PrismaClient): { tasks: TasksService; projects: ProjectsService } {
  const realtime = { publishTaskChanged: () => {}, publishForUser: () => {} };
  const sessions = {
    create: () => { throw new Error('no fixture in this spec should start a run'); },
    cancel: async (_ownerId: string, sessionId: string) => { cancelled.push(sessionId); },
  };
  return {
    tasks: new TasksService(db as unknown as PrismaService, sessions as never, realtime as never),
    projects: new ProjectsService(db as unknown as PrismaService),
  };
}

interface World {
  ownerId: string;
  projectId: string;
  codebaseId: string;
}

async function world(db: PrismaClient, label: string): Promise<World> {
  const ownerId = randomUUID();
  const projectId = randomUUID();
  await db.user.create({
    data: { id: ownerId, email: `${label}-${ownerId}@taskdelete.invalid`, name: label, passwordHash: 'x' },
  });
  await db.project.create({ data: { id: projectId, ownerId, title: label } });
  await db.projectRuntime.upsert({
    where: { projectId }, create: { projectId }, update: {},
  });
  await establishProjectContractForPgTest(db, ownerId, projectId, label);
  const codebase = await db.projectCodebase.create({
    data: {
      projectId,
      ownerId,
      canonicalRepoUrl: `ssh://git@example.invalid/${label}`,
      upstreamRef: 'refs/heads/main',
      integrationRef: `refs/heads/project/${projectId}`,
      integrationRefSource: 'EXPLICIT',
      refAuthority: 'REMOTE',
    },
  });
  return { ownerId, projectId, codebaseId: codebase.id };
}

/** One finished (or in-flight) task of the project, with the work session that ran it. */
async function landedTask(
  db: PrismaClient,
  w: World,
  title: string,
): Promise<{ taskId: string; sessionId: string }> {
  const taskId = randomUUID();
  await db.task.create({
    data: {
      id: taskId,
      ownerId: w.ownerId,
      projectId: w.projectId,
      title,
      creatorType: CreatorType.USER,
      completionCriterion: 'EVIDENCE_JUDGMENT',
      creatorId: w.ownerId,
      status: TaskStatus.DONE,
    },
  });
  const session = await db.session.create({
    data: {
      ownerId: w.ownerId, creatorId: w.ownerId, title, prompt: 'p',
      taskId, startsTaskWork: true, status: RunStatus.SUCCEEDED,
    },
  });
  return { taskId, sessionId: session.id };
}

/**
 * One integration job of that task, written as the queue writes one. `state` says how it ended;
 * `LANDED` supplies the matching trees J2 requires of a row that says it landed a tree.
 */
async function job(
  db: PrismaClient,
  w: World,
  spec: {
    taskId: string;
    sessionId: string;
    state: string;
    receiptIds?: string[];
    errorCode?: string;
    conflicts?: string[];
  },
): Promise<string> {
  const id = randomUUID();
  const receipts = spec.receiptIds ?? [];
  await db.projectIntegrationJob.create({
    data: {
      id,
      projectId: w.projectId,
      ownerId: w.ownerId,
      codebaseId: w.codebaseId,
      kind: 'LAND_TASK',
      taskId: spec.taskId,
      sessionId: spec.sessionId,
      state: spec.state,
      serialKey: `${w.projectId}:refs/heads/project/${w.projectId}`,
      targetRef: `refs/heads/project/${w.projectId}`,
      upstreamRef: 'refs/heads/main',
      sourceRef: `refs/heads/orbit/${spec.taskId}`,
      sourceSha: 'f'.repeat(40),
      targetShaBefore: 'e'.repeat(40),
      upstreamSha: 'd'.repeat(40),
      ...(spec.state === 'LANDED'
        ? { landedSha: 'b'.repeat(40), testedTreeSha: 'a'.repeat(40), landedTreeSha: 'a'.repeat(40) }
        : {}),
      ...(spec.errorCode ? { errorCode: spec.errorCode } : {}),
      conflicts: spec.conflicts ?? [],
      receiptIds: receipts,
      idempotencyKey: `ij:v1:LAND_TASK:${spec.taskId}:1`,
      startedAt: new Date(),
      finishedAt: spec.state === 'QUEUED' || spec.state === 'RUNNING' ? null : new Date(),
    },
  });
  return id;
}

/** The job row as it stands, so every case can say what the delete did or did not touch. */
function jobRow(db: PrismaClient, id: string) {
  return db.projectIntegrationJob.findUniqueOrThrow({ where: { id } });
}

async function emptyWorld(client: Client): Promise<void> {
  await verifyCoordinatorPgIdentity(client);
  cancelled.length = 0;
  await client.query(`SET lock_timeout = '10s'`);
  await client.query(`
    TRUNCATE "project_runtime", "project_acceptance_criterion_definition",
             "project_integration_job", "project_codebase", "task_dependency", "task",
             "session", "workspace", "runner", "project", "user"
    RESTART IDENTITY CASCADE
  `);
}

test('a task whose landing finished can be deleted, and its job keeps every fact including the task id', async () => {
  const url = URL;
  assert.ok(url, 'COORDINATOR_PG_URL is required');
  await assertCoordinatorPgUrlIsIsolated(url);
  const db = prismaClientFor(url);
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    await emptyWorld(client);
    const w = await world(db, 'landed-delete');
    const { taskId, sessionId } = await landedTask(db, w, 'walkthrough fixture');
    const receiptId = randomUUID();
    const jobId = await job(db, w, { taskId, sessionId, state: 'LANDED', receiptIds: [receiptId] });
    const before = await jobRow(db, jobId);

    const { tasks } = services(db);

    // THE REPRODUCTION. Before the fix this call rejected with the guard's P0001
    // (PROJECT_INTEGRATION_JOB_TERMINAL) raised by the foreign key's own `task_id = NULL` UPDATE, and
    // the whole DELETE rolled back. It resolves now.
    await tasks.remove(w.ownerId, taskId);

    assert.equal(await db.task.count({ where: { id: taskId } }), 0, 'the task is gone');
    assert.deepEqual(cancelled, [], 'a finished run is detached, not ended');

    const after = await jobRow(db, jobId);
    assert.equal(after.state, 'LANDED', 'the job still says it landed');
    assert.equal(after.taskId, taskId, 'the job still names the task it was about');
    assert.equal(after.sessionId, sessionId, 'the job still names the session it was queued for');
    assert.deepEqual(after.receiptIds, [receiptId], 'the receipt association survives');
    assert.equal(after.landedSha, before.landedSha);
    assert.equal(after.testedTreeSha, before.testedTreeSha);
    assert.equal(after.landedTreeSha, before.landedTreeSha);
    assert.equal(after.sourceRef, before.sourceRef);
    assert.equal(after.sourceSha, before.sourceSha);
    assert.equal(after.updatedAt.getTime(), before.updatedAt.getTime(),
      'no write of the row happened at all: the delete did not touch it');
  } finally {
    await db.$disconnect();
    await client.end();
  }
});

test('a task whose landing FAILED can be deleted too, with its error and conflicts left on the row', async () => {
  const url = URL;
  assert.ok(url, 'COORDINATOR_PG_URL is required');
  await assertCoordinatorPgUrlIsIsolated(url);
  const db = prismaClientFor(url);
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    await emptyWorld(client);
    const w = await world(db, 'failed-delete');
    const { taskId, sessionId } = await landedTask(db, w, 'a landing that stopped');
    const jobId = await job(db, w, {
      taskId, sessionId, state: 'CHECK_FAILED', errorCode: 'CHECK_FAILED', conflicts: ['src/a.ts'],
    });

    const { tasks } = services(db);
    await tasks.remove(w.ownerId, taskId);

    const after = await jobRow(db, jobId);
    assert.equal(after.taskId, taskId);
    assert.equal(after.state, 'CHECK_FAILED');
    assert.equal(after.errorCode, 'CHECK_FAILED', 'why it stopped is still on the row');
    assert.deepEqual(after.conflicts, ['src/a.ts'], 'what it conflicted on is still on the row');
  } finally {
    await db.$disconnect();
    await client.end();
  }
});

test('the project can be deleted once its landed tasks are gone: the walkthrough project\'s path, with no 500', async () => {
  const url = URL;
  assert.ok(url, 'COORDINATOR_PG_URL is required');
  await assertCoordinatorPgUrlIsIsolated(url);
  const db = prismaClientFor(url);
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    await emptyWorld(client);
    const w = await world(db, 'project-delete');
    const first = await landedTask(db, w, 'walkthrough fixture 1');
    const second = await landedTask(db, w, 'walkthrough fixture 2');
    const jobIds = [
      await job(db, w, { taskId: first.taskId, sessionId: first.sessionId, state: 'LANDED', receiptIds: [randomUUID()] }),
      await job(db, w, { taskId: second.taskId, sessionId: second.sessionId, state: 'ALREADY_LANDED' }),
    ];

    const { tasks, projects } = services(db);
    // Step one of the chain: the two tasks. Each one is the 500 this task fixes.
    await tasks.remove(w.ownerId, first.taskId);
    await tasks.remove(w.ownerId, second.taskId);
    // Step two: an empty project, which is the only kind `remove` deletes. 0281's project foreign key
    // takes the jobs with it — that is the project's own audit going with the project.
    await projects.remove(w.ownerId, w.projectId);

    assert.equal(await db.project.count({ where: { id: w.projectId } }), 0, 'the project is gone');
    assert.equal(
      await db.projectIntegrationJob.count({ where: { id: { in: jobIds } } }), 0,
      'its integration jobs go with it, by the project foreign key rather than by the task one',
    );
  } finally {
    await db.$disconnect();
    await client.end();
  }
});

test('a landing still in flight is left alone as well: one behaviour for every state', async () => {
  const url = URL;
  assert.ok(url, 'COORDINATOR_PG_URL is required');
  await assertCoordinatorPgUrlIsIsolated(url);
  const db = prismaClientFor(url);
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    await emptyWorld(client);
    const w = await world(db, 'queued-delete');
    const { taskId, sessionId } = await landedTask(db, w, 'still queued');
    const jobId = await job(db, w, { taskId, sessionId, state: 'QUEUED' });

    const { tasks } = services(db);
    await tasks.remove(w.ownerId, taskId);

    const after = await jobRow(db, jobId);
    assert.equal(after.state, 'QUEUED', 'the queue is not the delete\'s to rewrite');
    assert.equal(after.taskId, taskId, 'and the task it is landing for is still named');
  } finally {
    await db.$disconnect();
    await client.end();
  }
});

test('the guard itself is untouched: rewriting a finished job row is still refused (J4)', async () => {
  const url = URL;
  assert.ok(url, 'COORDINATOR_PG_URL is required');
  await assertCoordinatorPgUrlIsIsolated(url);
  const db = prismaClientFor(url);
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    await emptyWorld(client);
    const w = await world(db, 'guard-control');
    const { taskId, sessionId } = await landedTask(db, w, 'do not rewrite me');
    const jobId = await job(db, w, { taskId, sessionId, state: 'LANDED', receiptIds: [randomUUID()] });

    // The control for every case above: the fix must not have been "delete the trigger".
    await assert.rejects(
      db.projectIntegrationJob.update({ where: { id: jobId }, data: { state: 'CANCELLED' } }),
      (error: unknown) => {
        assert.match(String((error as Error).message), /PROJECT_INTEGRATION_JOB_TERMINAL/u,
          'a finished row is refused with the guard\'s own word');
        return true;
      },
    );
    assert.equal((await jobRow(db, jobId)).state, 'LANDED', 'and the row is where it was');
  } finally {
    await db.$disconnect();
    await client.end();
  }
});
