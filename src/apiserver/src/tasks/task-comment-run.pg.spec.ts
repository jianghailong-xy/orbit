/**
 * Which run wrote a task comment (migration 0416), against real PostgreSQL.
 *
 * `addComment` keeps the session an agent commented from when the owner has it, and that session's
 * attempt only when the attempt is one of the commented task's. The attempts here are the rows
 * `SessionAttemptService.open` commits through the ledger, and the columns are read back through the
 * task detail every client reads — neither of which a fake client can stand in for.
 *
 * Destructive: it truncates. Run it against a throwaway database:
 *
 *   scripts/run-pg-spec.sh src/apiserver/src/tasks/task-comment-run.pg.spec.ts
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import {
  CreatorType,
  PrismaClient,
  RunStatus,
  RunnerStatus,
  SessionDispatchOrigin,
  TaskStatus,
} from '@prisma/client';
import { Client } from 'pg';
import { ConvergenceLedgerService } from '../projects/convergence-ledger.service';
import { EMPTY_PROGRESS_VECTOR, scopeHash } from '../projects/convergence-progress';
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from '../projects/coordinator-pg-test-safety';
import { SessionAttemptService } from '../projects/session-attempt.service';
import { prismaClientFor } from '../prisma/prisma-client';
import type { PrismaService } from '../prisma/prisma.service';
import type { RealtimeService } from '../realtime/realtime.service';
import { TasksService } from './tasks.service';

const URL = process.env.COORDINATOR_PG_URL;
const suite = URL ? test : test.skip;

function tasksService(db: PrismaClient): TasksService {
  return new TasksService(
    db as unknown as PrismaService,
    { create: () => { throw new Error('this fixture never dispatches'); } } as never,
    {
      publishForUser: () => undefined,
      publishTaskChanged: () => undefined,
    } as unknown as RealtimeService,
  );
}

async function user(db: PrismaClient, label: string): Promise<string> {
  const id = randomUUID();
  await db.user.create({
    data: { id, email: `${label}-${id}@comment-run.invalid`, name: label, passwordHash: 'x' },
  });
  return id;
}

async function session(db: PrismaClient, ownerId: string, taskId: string | null): Promise<string> {
  const id = randomUUID();
  await db.session.create({
    data: {
      id,
      ownerId,
      creatorId: ownerId,
      taskId,
      title: taskId ? 'a run of a task' : 'a session with no task',
      prompt: 'do the work',
      status: RunStatus.RUNNING,
      dispatchOrigin: SessionDispatchOrigin.USER,
      startedAt: new Date(),
    },
  });
  return id;
}

/** Open the one attempt this session is, through the ledger, as `[K3]` §4 requires. */
async function openAttempt(
  db: PrismaClient,
  ownerId: string,
  taskId: string,
  sessionId: string,
): Promise<string> {
  const prisma = db as unknown as PrismaService;
  const attempts = new SessionAttemptService(prisma, new ConvergenceLedgerService(prisma));
  const task = await db.task.findUniqueOrThrow({
    where: { id: taskId },
    select: { title: true, description: true, acceptanceCriteria: true },
  });
  const { attempt } = await attempts.open(ownerId, taskId, {
    attemptKey: `dispatch:${sessionId}`,
    sessionId,
    hypothesis: 'try the obvious thing',
    progressVector: { ...EMPTY_PROGRESS_VECTOR, scopeHash: scopeHash(task) },
    observedAt: new Date(),
  });
  return attempt.id;
}

suite('a comment names the run it came from, and the attempt only when it is this task\'s', async (t) => {
  assertCoordinatorPgUrlIsIsolated(URL);
  const sql = new Client({ connectionString: URL });
  await sql.connect();
  const db = prismaClientFor(URL!);
  t.after(async () => {
    await db.$disconnect();
    await sql.end();
  });
  await verifyCoordinatorPgIdentity(sql);
  await sql.query(`
    TRUNCATE "task", "session", "project", "workspace", "runner", "user"
    RESTART IDENTITY CASCADE
  `);

  const ownerId = await user(db, 'owner');
  const runnerId = randomUUID();
  const workspaceId = randomUUID();
  await db.runner.create({
    data: { id: runnerId, ownerId, name: 'comment-run-runner', tokenHash: `x-${runnerId}`, status: RunnerStatus.ONLINE },
  });
  await db.workspace.create({
    data: { id: workspaceId, ownerId, runnerId, name: 'comment-run-workspace', enabled: true },
  });
  const projectId = randomUUID();
  await db.project.create({ data: { id: projectId, ownerId, title: 'comments that name their run' } });
  const [taskId, otherTaskId] = [randomUUID(), randomUUID()];
  for (const [id, title] of [[taskId, 'the commented task'], [otherTaskId, 'another task']]) {
    await db.task.create({
      data: {
        id,
        ownerId,
        projectId,
        title,
        creatorType: CreatorType.USER,
        completionCriterion: 'EVIDENCE_JUDGMENT',
        creatorId: ownerId,
        assigneeId: workspaceId,
        status: TaskStatus.IN_PROGRESS,
      },
    });
  }
  const ownRun = await session(db, ownerId, taskId);
  const otherRun = await session(db, ownerId, otherTaskId);
  const plainSession = await session(db, ownerId, null);
  const ownAttempt = await openAttempt(db, ownerId, taskId, ownRun);
  const otherAttempt = await openAttempt(db, ownerId, otherTaskId, otherRun);
  const foreignSession = await session(db, await user(db, 'stranger'), null);

  const tasks = tasksService(db);
  const agent = { type: CreatorType.AGENT, id: workspaceId };
  const say = (body: string, sessionId?: string) =>
    tasks.addComment(ownerId, taskId, { body }, agent, sessionId);
  const run = (comment: { sessionId: string | null; attemptId: string | null }) =>
    ({ sessionId: comment.sessionId, attemptId: comment.attemptId });

  // The task's own run: its session, and the attempt that session is.
  assert.deepEqual(run(await say('from this task\'s run', ownRun)), { sessionId: ownRun, attemptId: ownAttempt });
  // A run of another task: its session, never that task's attempt.
  assert.notEqual(otherAttempt, ownAttempt);
  assert.deepEqual(run(await say('from another task\'s run', otherRun)), { sessionId: otherRun, attemptId: null });
  // A session that runs no task is still the session the comment came from.
  assert.deepEqual(run(await say('from a session with no task', plainSession)), { sessionId: plainSession, attemptId: null });
  // Another account's session, or a header the middleware could not decode, is dropped, not refused.
  assert.deepEqual(run(await say('naming a stranger\'s session', foreignSession)), { sessionId: null, attemptId: null });
  assert.deepEqual(run(await say('naming no id at all', 'not-an-id')), { sessionId: null, attemptId: null });
  // The app's door has no session.
  assert.deepEqual(run(await tasks.addComment(ownerId, taskId, { body: 'from the app' })), { sessionId: null, attemptId: null });

  // The detail every client reads carries both, comment by comment. Keyed by body: two comments
  // written inside one millisecond share a `createdAt`, and their order is not what this is about.
  const detail = await tasks.get(ownerId, taskId);
  assert.deepEqual(Object.fromEntries(detail.comments.map((comment) => [comment.body, run(comment)])), {
    'from this task\'s run': { sessionId: ownRun, attemptId: ownAttempt },
    'from another task\'s run': { sessionId: otherRun, attemptId: null },
    'from a session with no task': { sessionId: plainSession, attemptId: null },
    'naming a stranger\'s session': { sessionId: null, attemptId: null },
    'naming no id at all': { sessionId: null, attemptId: null },
    'from the app': { sessionId: null, attemptId: null },
  });
});
